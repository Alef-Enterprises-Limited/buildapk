import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Gradle can create a new process group. Track descendants by PID + start time
// so cancellation also reaches those daemons, without killing a reused PID.
function descendants(rootPid) {
  const known = new Map();
  function scan() {
    if (process.platform !== 'linux' || !rootPid) return [];
    const processes = new Map();
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const raw = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
        processes.set(Number(name), { parent: Number(fields[1]), start: fields[19], state: fields[0] });
      } catch { /* Process exited while being inspected. */ }
    }
    if (!known.size && processes.has(rootPid)) known.set(rootPid, processes.get(rootPid).start);
    let changed;
    do {
      changed = false;
      for (const [pid, info] of processes) {
        const parent = processes.get(info.parent);
        if (!known.has(pid) && parent && known.get(info.parent) === parent.start) {
          known.set(pid, info.start); changed = true;
        }
      }
    } while (changed);
    return [...known].filter(([pid, start]) => processes.get(pid)?.start === start && processes.get(pid).state !== 'Z').map(([pid]) => pid);
  }
  return scan;
}

// Retain only enough tail to redact secrets split across arbitrary stream chunks.
export function redactor(secrets, emit) {
  const values = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  const width = Math.max(1, ...values.map(s => s.length));
  let pending = '';
  function flush(final) {
    let out = '', i = 0;
    while (i < pending.length && (final || pending.length - i >= width)) {
      const secret = values.find(s => pending.startsWith(s, i));
      if (secret) { out += '[REDACTED]'; i += secret.length; }
      else { const point = String.fromCodePoint(pending.codePointAt(i)); out += point; i += point.length; }
    }
    pending = pending.slice(i);
    if (out) emit(out);
  }
  return { write: text => { pending += text; flush(false); }, end: () => flush(true) };
}

export function sanitize(text, secrets = []) {
  let out = '';
  const filter = redactor(secrets, part => { out += part; });
  filter.write(String(text)); filter.end();
  return out;
}

export function logger(file, secrets = [], terminal = process.stdout) {
  const emit = text => { if (file) appendFileSync(file, text); terminal.write(text); };
  return {
    message: text => emit(sanitize(text, secrets) + '\n'),
    stream: () => redactor(secrets, emit),
  };
}

export function run(command, args, { cwd, env = process.env, signal, log = logger(), capture = false } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timer, spawnError, captureOverflow = false;
    const scan = descendants(child.pid);
    scan();
    const monitor = process.platform === 'linux' ? setInterval(scan, 250) : undefined;
    const kill = sig => {
      if (!child.pid) return;
      const tracked = scan();
      for (const pid of tracked.reverse()) {
        if (pid === child.pid) continue;
        try { process.kill(pid, sig); } catch (error) { if (error.code !== 'ESRCH') spawnError ??= error; }
      }
      if (process.platform === 'linux' && !tracked.includes(child.pid)) return;
      try { process.platform === 'win32' ? child.kill(sig) : process.kill(-child.pid, sig); }
      catch (error) { if (error.code !== 'ESRCH') spawnError ??= error; }
    };
    const abort = () => {
      kill('SIGTERM');
      timer = setTimeout(() => kill('SIGKILL'), 3000);
    };
    const streams = [child.stdout, child.stderr].map((stream, index) => {
      const decoder = new StringDecoder('utf8'), filter = log.stream();
      stream.on('data', bytes => {
        const text = decoder.write(bytes);
        try { filter.write(text); }
        catch (error) { spawnError ??= error; kill('SIGKILL'); }
        if (capture && (capture !== 'stdout' || index === 0)) {
          if (output.length + text.length <= 1024 * 1024) output += text;
          else { captureOverflow = true; kill('SIGKILL'); }
        }
      });
      return () => { filter.write(decoder.end()); filter.end(); };
    });
    child.on('error', error => { spawnError = error; });
    child.on('close', async (code, childSignal) => {
      clearTimeout(timer);
      clearInterval(monitor);
      signal?.removeEventListener('abort', abort);
      kill('SIGKILL'); // Clean up members of the job's process group, including Gradle daemons.
      for (let attempt = 0; attempt < 100 && scan().length; attempt++) await delay(20);
      if (scan().length) spawnError ??= new Error('Child-process cleanup did not complete within two seconds.');
      try { streams.forEach(finish => finish()); } catch (error) { spawnError ??= error; }
      if (signal?.aborted) return reject(signal.reason);
      if (spawnError) return reject(spawnError);
      if (captureOverflow) return reject(new Error('Tool response exceeded the 1 MiB capture limit.'));
      if (code !== 0) return reject(Object.assign(new Error(`${command} failed (exit ${code ?? childSignal}); see build.log.`), { exitCode: code, childSignal }));
      resolve(output);
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
