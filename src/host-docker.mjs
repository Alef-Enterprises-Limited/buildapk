import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { logger, run } from './runtime.mjs';

export const quiet = logger(null, [], { write() {} });

export function mount(source, target, readonly = false, type = 'bind') {
  // Docker parses --mount as CSV, independently of the host shell.
  const field = value => `"${value.replaceAll('"', '""')}"`;
  return ['--mount', [`type=${type}`, field(`source=${source}`), field(`target=${target}`), ...(readonly ? ['readonly'] : [])].join(',')];
}

export class Docker {
  constructor({ signal, log = logger(), root, home, execute = run } = {}) {
    Object.assign(this, { signal, log, root, execute });
    this.names = new Set();
    this.scope = home ? createHash('sha256').update(home).digest('hex') : undefined;
    this.image = undefined;
    this.work = `buildapk-launcher-work-${randomUUID()}`;
    this.workCreated = false;
    this.user = process.platform === 'win32' ? '10001:10001' : `${process.getuid()}:${process.getgid()}`;
    this.cache = `buildapk-launcher-cache-${process.platform === 'win32' ? 'desktop' : process.getuid()}`;
  }

  command(args, options = {}) {
    return this.execute('docker', args, { log: this.log, ...options });
  }

  async check() {
    let info;
    try { info = await this.command(['info', '--format', '{{.OSType}}'], { capture: 'stdout', log: quiet, signal: this.signal }); }
    catch { this.signal?.throwIfAborted(); throw new Error('Docker is unavailable. Install/start Docker Desktop (Linux containers), then run buildapk again.'); }
    if (info.trim() !== 'linux') throw new Error('Switch Docker to Linux containers before building Android apps.');
  }

  async prepare() {
    const images = await this.command(['image', 'ls', '--quiet', '--no-trunc', 'buildapk:local'], { capture: 'stdout', log: quiet, signal: this.signal });
    if (!images.trim()) {
      this.log.message('Building the local engine image for the first time. This can take several minutes.');
      await this.command(['build', '--platform', 'linux/amd64', '-t', 'buildapk:local', this.root], { signal: this.signal });
    }
    const id = (await this.command(['image', 'inspect', 'buildapk:local', '--format', '{{.Id}}'], { capture: 'stdout', log: quiet, signal: this.signal })).trim();
    // A private temporary tag protects this image if another process rebuilds the local tag.
    this.image = `buildapk-launcher-image:${randomUUID()}`;
    await this.command(['tag', id, this.image], { log: quiet });
  }

  async recover() {
    if (!this.scope) return;
    // Called while holding this storage home's lock. Only our own orphaned containers match.
    const ids = (await this.command(['ps', '-aq', '--filter', `label=buildapk.launcher.home=${this.scope}`], { log: quiet, capture: 'stdout', signal: this.signal })).trim().split(/\s+/).filter(Boolean);
    for (const id of ids) {
      this.log.message('Stopping a container left by an interrupted BuildAPK launcher. Its saved results will be retained.');
      await this.command(['stop', '--time', '15', id], { log: quiet, signal: this.signal });
      await this.command(['rm', '-f', id], { log: quiet, signal: this.signal });
    }
    const volumes = (await this.command(['volume', 'ls', '-q', '--filter', `label=buildapk.launcher.home=${this.scope}`], { log: quiet, capture: 'stdout', signal: this.signal })).trim().split(/\s+/).filter(Boolean);
    for (const name of volumes) await this.command(['volume', 'rm', name], { log: quiet, signal: this.signal });
  }

  async container(args, command, { entrypoint, user = this.user, log = this.log, capture = false } = {}) {
    this.signal?.throwIfAborted();
    const name = `buildapk-launcher-${randomUUID()}`;
    this.names.add(name);
    let done = false, stopping;
    const stop = () => {
      stopping ??= (async () => {
        // Retry if cancellation raced Docker's transition from created to running.
        while (!done) {
          await this.command(['stop', '--time', '15', name], { log: quiet }).catch(() => {});
          if (!done) await delay(100);
        }
      })();
    };
    try {
      await this.command(['create', '--name', name, '--platform', 'linux/amd64', '--user', user,
        '-e', 'HOME=/tmp', ...(this.scope ? ['--label', `buildapk.launcher.home=${this.scope}`] : []),
        ...(entrypoint ? ['--entrypoint', entrypoint] : []), ...args, this.image, ...command], { log: quiet });
      this.signal?.throwIfAborted();
      this.signal?.addEventListener('abort', stop, { once: true });
      const output = await this.command(['start', '--attach', name], { log, capture });
      this.signal?.throwIfAborted();
      return output;
    } finally {
      done = true;
      this.signal?.removeEventListener('abort', stop);
      await stopping;
      // Also covers daemon/client errors, so a detached build cannot outlive the launcher.
      await this.command(['stop', '--time', '15', name], { log: quiet }).catch(() => {});
      try { await this.command(['rm', '-f', name], { log: quiet }); this.names.delete(name); }
      catch { this.log.message(`Docker could not remove ${name}; cleanup will be retried.`); }
    }
  }

  async initializeCache() {
    await this.command(['volume', 'create', ...(this.scope ? ['--label', `buildapk.launcher.home=${this.scope}`] : []), this.work], { log: quiet, signal: this.signal });
    this.workCreated = true;
    await this.container([...mount(this.cache, '/cache', false, 'volume'), ...mount(this.work, '/work', false, 'volume')], [this.user, '/cache', '/work'], { entrypoint: 'chown', user: '0', log: quiet });
  }

  async close() {
    for (const name of this.names) {
      await this.command(['stop', '--time', '15', name], { log: quiet }).catch(() => {});
      try { await this.command(['rm', '-f', name], { log: quiet }); this.names.delete(name); }
      catch { this.log.message(`Cleanup incomplete: ${name}. Restart Docker and rerun buildapk to recover it.`); }
    }
    if (this.image) await this.command(['image', 'rm', this.image], { log: quiet }).catch(() => {});
    if (this.workCreated) await this.command(['volume', 'rm', this.work], { log: quiet }).catch(() => {
      this.log.message(`Temporary work volume could not be removed: ${this.work}. The next launcher invocation will retry recovery.`);
    });
  }
}
