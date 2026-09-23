import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toolchain, version } from './build.mjs';
import { exists, validateProject } from './project.mjs';
import { logger, run } from './runtime.mjs';
import { Docker, mount, quiet } from './host-docker.mjs';
import { prompt } from './host-prompt.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
const help = `BuildAPK ${version} — local React Native Android builds
Usage: buildapk [build | setup | doctor | --help | --version]

Run from your app folder. The first build asks about signing once.
setup   Create/import a signing identity, or reuse one after moving a project.
doctor  Check Docker, the engine, and this project's saved setup when present.

Requires Node.js 22.13+ and Docker with Linux containers.
BUILDAPK_HOME optionally relocates profiles, signing keys, and APK outputs.
Supports the documented npm / React Native ${toolchain.reactNative} / Expo ${toolchain.expo} baseline.
`;
const idPattern = /^[0-9a-f]{8}-[0-9a-f-]{27}$/;
const checkedId = id => { if (!idPattern.test(id ?? '')) throw new Error('Invalid saved profile identifier. Restore a valid profiles.json backup.'); return id; };

export function homeDirectory(env = process.env) {
  return path.resolve(env.BUILDAPK_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'BuildAPK')
    : path.join(os.homedir(), '.local', 'share', 'buildapk')));
}

export function outsideSource(source, home) {
  const relative = path.relative(source, home);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('BUILDAPK_HOME must be outside the app source folder so signing keys and outputs are not copied into builds.');
  }
}

export async function protectHome(home) {
  if (path.parse(home).root === home || home === os.homedir()) throw new Error('Use a dedicated BuildAPK storage folder, not a drive root or your user home.');
  const allowed = /^(profiles\.json(?:\.[0-9a-f-]+\.tmp)?|launcher\.lock|identities|builds|work)$/;
  const contents = await readdir(home).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  if (contents.some(name => !allowed.test(name))) throw new Error('BUILDAPK_HOME must be a dedicated BuildAPK folder. Choose an empty folder or your existing BuildAPK storage.');
  await mkdir(home, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const account = await run('whoami', ['/user', '/fo', 'csv', '/nh'], { capture: 'stdout', log: quiet });
    const sid = account.match(/S-\d-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('Cannot determine the Windows account to protect signing storage.');
    await run('icacls', [home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { log: quiet });
  } else await chmod(home, 0o700);
}

export async function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

// Exclusive creation rejects concurrent launchers. A crashed owner's lock is recoverable.
export async function acquireLock(home) {
  const file = path.join(home, 'launcher.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
      finally { await handle.close(); }
      return async () => {
        const current = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
        if (current.token === token) await rm(file, { force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner;
      try { owner = JSON.parse(await readFile(file, 'utf8')); }
      catch {
        const info = await stat(file).catch(() => null);
        if (!info) continue;
        if (Date.now() - info.mtimeMs < 30000) throw new Error('Another BuildAPK launcher is starting. Try again shortly.');
      }
      if (owner?.pid && Number.isInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probe) { if (probe.code === 'ESRCH') { await rm(file, { force: true }); continue; } }
        throw new Error('Another BuildAPK launcher is active. Wait for it to finish or cancel it before starting another build.');
      }
      await rm(file, { force: true });
    }
  }
  throw new Error('Unable to acquire the BuildAPK launcher lock. Try again.');
}

export async function readProfiles(home) {
  let text;
  try { text = await readFile(path.join(home, 'profiles.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 1, projects: {} }; throw error; }
  const data = JSON.parse(text);
  if (data.schemaVersion !== 1 || !data.projects || typeof data.projects !== 'object' || Array.isArray(data.projects)) throw new Error('Unsupported or corrupt profiles.json. Restore your saved profile backup.');
  for (const profile of Object.values(data.projects)) { checkedId(profile.id); checkedId(profile.identityId); }
  return data;
}

export async function identityAt(home, id) {
  const directory = path.join(home, 'identities', checkedId(id));
  try {
    const metadata = JSON.parse(await readFile(path.join(directory, 'identity.json'), 'utf8'));
    if (typeof metadata.alias !== 'string' || !metadata.alias) throw new Error('Missing alias');
    for (const name of ['release.jks', 'store-password', 'key-password']) await access(path.join(directory, name), constants.R_OK);
    const passwords = await Promise.all(['store-password', 'key-password'].map(async name => {
      const file = path.join(directory, name);
      if ((await stat(file)).size > 4096) throw new Error('Password file too large');
      const value = (await readFile(file, 'utf8')).replace(/\r?\n$/, '');
      if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid password file');
      return value;
    }));
    return { ...metadata, id, directory, passwords };
  } catch { throw new Error(`Saved signing material is missing or invalid: ${directory}. Restore it from backup or run buildapk setup to explicitly select an identity. No replacement key was generated.`); }
}

export async function verifyIdentity(docker, identity) {
  // certreq needs the private key, so this checks both passwords as well as the alias.
  await docker.container(mount(identity.directory, '/secrets', true), ['-certreq', '-keystore', '/secrets/release.jks',
    '-alias', identity.alias, '-storepass:file', '/secrets/store-password', '-keypass:file', '/secrets/key-password',
    '-file', '/tmp/buildapk-check.csr'], { entrypoint: 'keytool', log: quiet });
}

export async function createIdentity({ home, name, docker, ask = prompt, signal, log = logger() }) {
  const available = [];
  for (const entry of await readdir(path.join(home, 'identities')).catch(error => { if (error.code === 'ENOENT') return []; throw error; })) {
    if (idPattern.test(entry)) {
      try { const identity = await identityAt(home, entry); available.push(identity); }
      catch { /* Incomplete identities are never silently selected. */ }
    }
  }
  log.message('Signing setup: 1) Create a persistent key for a new app  2) Import an existing signing key' + (available.length ? '  3) Reuse a saved identity' : ''));
  const choice = await ask('Choose signing option: ', { signal });
  if (choice === '3' && available.length) {
    available.forEach((identity, index) => log.message(`${index + 1}) ${identity.name} (${identity.id})`));
    const selected = await ask('Identity number: ', { signal });
    if (!/^[1-9]\d*$/.test(selected) || !available[Number(selected) - 1]) throw new Error('Choose an identity number shown in the list.');
    const identity = available[Number(selected) - 1];
    await verifyIdentity(docker, identity);
    return identity;
  }
  if (!['1', '2'].includes(choice)) throw new Error('Choose a signing option shown in the list.');
  const id = randomUUID(), directory = path.join(home, 'identities', id);
  let alias = 'release', storePassword, keyPassword, keystore;
  if (choice === '2') {
    keystore = await realpath(path.resolve(await ask('Existing keystore path: ', { signal })));
    alias = await ask('Key alias: ', { signal });
    storePassword = await ask('Keystore password (hidden): ', { signal, secret: true });
    keyPassword = await ask('Key password (hidden; Enter uses keystore password): ', { signal, secret: true }) || storePassword;
  } else storePassword = keyPassword = randomBytes(32).toString('hex');
  if (!alias || [storePassword, keyPassword].some(value => !value || /[\r\n\0]/.test(value) || Buffer.byteLength(value) > 4095)) throw new Error('Alias and single-line passwords are required (maximum 4095 password bytes).');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let saved = false;
  try {
    await writeFile(path.join(directory, 'store-password'), storePassword + '\n', { mode: 0o600 });
    await writeFile(path.join(directory, 'key-password'), keyPassword + '\n', { mode: 0o600 });
    if (keystore) { await copyFile(keystore, path.join(directory, 'release.jks')); await chmod(path.join(directory, 'release.jks'), 0o600); }
    else await docker.container(mount(directory, '/secrets'), ['-genkeypair', '-keystore', '/secrets/release.jks', '-storetype', 'JKS',
      '-alias', alias, '-storepass:file', '/secrets/store-password', '-keypass:file', '/secrets/key-password',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=BuildAPK app signing'], { entrypoint: 'keytool', log: quiet });
    await chmod(path.join(directory, 'release.jks'), 0o600);
    const identity = { id, name, alias, createdAt: new Date().toISOString(), directory, passwords: [storePassword, keyPassword] };
    await verifyIdentity(docker, identity).catch(error => { signal?.throwIfAborted(); throw new Error(`Signing verification failed. Check the keystore, alias, and passwords. ${error.message}`); });
    await atomicJson(path.join(directory, 'identity.json'), { id, name, alias, createdAt: identity.createdAt });
    saved = true;
    log.message(`Signing identity saved. Back up this entire folder securely: ${directory}`);
    return identity;
  } finally { if (!saved) await rm(directory, { recursive: true, force: true }); }
}

export async function launch({ args = process.argv.slice(2), cwd = process.cwd(), env = process.env,
  signal, ask = prompt, interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  log = logger(), docker: injectedDocker } = {}) {
  const command = args[0] ?? 'build';
  if (args.length > 1 || !['build', 'setup', 'doctor', '--help', '--version'].includes(command)) throw new Error('Use buildapk [build | setup | doctor | --help | --version].');
  if (command === '--help') { log.message(help); return; }
  if (command === '--version') { log.message(version); return; }
  const source = await realpath(cwd);
  let project;
  if (command !== 'doctor' || await exists(path.join(source, 'package.json'))) {
    try {
      if (!await exists(path.join(source, 'package.json'))) throw new Error('Open a React Native app folder containing package.json.');
      const manifest = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
      if (!manifest.dependencies?.['react-native'] && !manifest.devDependencies?.['react-native']) {
        if (command !== 'doctor') throw new Error('This is not a React Native app. Web-only React and standalone Java/Kotlin Android apps are not supported.');
        log.message('No React Native app detected here; checking the engine only.');
      } else project = await validateProject(source, 'auto', toolchain);
    }
    catch (error) { throw new Error(`Cannot build this project: ${error.message} Supported: standalone npm React Native ${toolchain.reactNative}, React ${toolchain.react}, and Expo ${toolchain.expo} when used. App dependencies were not changed.`); }
  }
  let home = homeDirectory(env);
  if (await exists(home)) home = await realpath(home);
  outsideSource(source, home);
  await protectHome(home);
  home = await realpath(home);
  outsideSource(source, home);
  const release = await acquireLock(home);
  const docker = injectedDocker ?? new Docker({ signal, log, root, home });
  try {
    const profiles = await readProfiles(home);
    const canonical = process.platform === 'win32' ? source.toLowerCase() : source;
    let profile = Object.hasOwn(profiles.projects, canonical) ? profiles.projects[canonical] : undefined;
    if (command !== 'doctor' && (command === 'setup' || !profile) && !interactive) {
      throw new Error('No interactive signing setup is available. Open a terminal in this app folder and run buildapk setup first.');
    }
    let identity = command !== 'setup' && profile ? await identityAt(home, profile.identityId) : undefined;
    await docker.check();
    await docker.recover?.();
    await docker.prepare();
    if (command === 'doctor') {
      const report = await docker.container([], ['doctor'], { log: quiet, capture: 'stdout' });
      log.message((report ?? '').trim().replace(' Use doctor --mounts with build mounts to check permissions and signing inputs.', ''));
      if (identity) { await verifyIdentity(docker, identity); log.message(`Saved signing identity verified: ${identity.name}`); }
      else if (project) log.message('No saved signing identity yet. Run buildapk to set it up and build.');
      log.message(`BuildAPK storage: ${home}`);
      return;
    }
    if (!identity) {
      if (profile) log.message('Changing signing identity changes which installed apps this APK can update. Existing keys will be retained.');
      identity = await createIdentity({ home, name: project.manifest.name || path.basename(source), docker, ask, signal, log });
      profile = { id: profile?.id ?? randomUUID(), identityId: identity.id, name: project.manifest.name || path.basename(source) };
      profiles.projects[canonical] = profile;
      await atomicJson(path.join(home, 'profiles.json'), profiles);
    }
    if (command === 'setup') { log.message('Setup saved. Run buildapk from this app folder to build.'); return; }
    await verifyIdentity(docker, identity);
    await docker.initializeCache();
    const output = path.join(home, 'builds', profile.id, randomUUID());
    await mkdir(output, { recursive: true, mode: 0o700 });
    log.message(`Building ${profile.name} (${project.mode}). Results: ${output}`);
    const mounts = [...mount(source, '/input', true), ...mount(output, '/output'), ...mount(docker.work, '/work', false, 'volume'),
      ...mount(identity.directory, '/secrets', true), ...mount(docker.cache, '/cache', false, 'volume')];
    const signing = ['-e', 'BUILDAPK_KEYSTORE_PATH=/secrets/release.jks', '-e', `BUILDAPK_KEY_ALIAS=${identity.alias}`,
      '-e', 'BUILDAPK_STORE_PASSWORD_FILE=/secrets/store-password', '-e', 'BUILDAPK_KEY_PASSWORD_FILE=/secrets/key-password'];
    const forwarded = Object.keys(env).filter(key => key.startsWith('EXPO_PUBLIC_') || ['BUILDAPK_TIMEOUT_SECONDS', 'BUILDAPK_GRADLE_WORKERS', 'BUILDAPK_GRADLE_HEAP_MB'].includes(key));
    const variables = forwarded.flatMap(key => ['-e', `${key}=${env[key]}`]);
    let buildError;
    try { await docker.container([...mounts, ...signing, ...variables], ['build'], { log: logger(null, identity.passwords) }); }
    catch (error) { buildError = error; }
    const jobs = (await readdir(output, { withFileTypes: true })).filter(entry => entry.isDirectory());
    let result;
    if (jobs.length === 1) result = JSON.parse(await readFile(path.join(output, jobs[0].name, 'result.json'), 'utf8').catch(() => 'null'));
    if (result) log.message(`Build log: ${path.join(output, jobs[0].name, 'build.log')}`);
    if (buildError || result?.status !== 'succeeded') {
      throw new Error(result?.error ? `${result.status} at ${result.error.stage}: ${result.error.message}` : `${buildError?.message ?? 'Build produced no successful result.'} Results: ${output}`);
    }
    if (result.artifact?.path !== 'app-release.apk') throw new Error('Unexpected artifact path in build result.');
    const apk = path.join(output, jobs[0].name, result.artifact.path);
    await access(apk, constants.R_OK);
    log.message(`APK ready: ${apk}`);
    return { result, apk, home, profile };
  } finally {
    try { await docker.close(); }
    finally { await release(); }
  }
}
