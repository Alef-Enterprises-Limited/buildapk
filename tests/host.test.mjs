import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireLock, launch, readProfiles, identityAt, outsideSource, protectHome, root } from '../src/host.mjs';
import { Docker, mount } from '../src/host-docker.mjs';
import { logger } from '../src/runtime.mjs';

const silent = logger(null, [], { write() {} });
const fixture = path.join(root, 'fixtures', 'expo-minimal');
async function sandbox(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'buildapk-launcher-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'app with spaces'), home = path.join(temporary, 'private storage');
  await mkdir(source); await mkdir(home);
  for (const name of ['package.json', 'package-lock.json']) await writeFile(path.join(source, name), await readFile(path.join(fixture, name)));
  return { temporary, source, home };
}
const unquote = value => value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value;
function mounts(args) {
  return args.flatMap((value, index) => value === '--mount' ? [Object.fromEntries(args[index + 1].match(/(?:"(?:[^"]|"")*"|[^,])+/g).map(unquote).map(field => {
    const split = field.indexOf('='); return split < 0 ? [field, true] : [field.slice(0, split), field.slice(split + 1)];
  }))] : []);
}
class FakeDocker {
  cache = 'test-cache'; work = 'test-work'; calls = []; builds = 0;
  async check() { this.calls.push('check'); }
  async prepare() { this.calls.push('prepare'); }
  async close() { this.calls.push('close'); }
  async initializeCache() {}
  async container(args, command, options = {}) {
    this.calls.push({ args, command, options });
    const directories = mounts(args);
    if (command.includes('-genkeypair')) {
      await writeFile(path.join(directories.find(m => m.target === '/secrets').source, 'release.jks'), randomUUID());
    }
    if (command[0] === 'build') {
      this.builds++;
      const output = directories.find(m => m.target === '/output').source;
      const directory = path.join(output, 'job-1'); await mkdir(directory);
      await writeFile(path.join(directory, 'result.json'), JSON.stringify({ status: 'succeeded', artifact: { path: 'app-release.apk' } }));
      await writeFile(path.join(directory, 'app-release.apk'), 'test artifact');
    }
  }
}
function options(source, home, docker, answers = []) {
  return { args: [], cwd: source, env: { BUILDAPK_HOME: home }, docker, log: silent, interactive: true,
    ask: async () => { assert.ok(answers.length, 'unexpected repeated setup prompt'); return answers.shift(); } };
}

test('first build saves signing outside source; repeat build requires no prompts and keeps identity', async t => {
  const { source, home } = await sandbox(t), docker = new FakeDocker();
  const before = await readFile(path.join(source, 'package-lock.json'), 'utf8');
  const first = await launch(options(source, home, docker, ['1']));
  const second = await launch(options(source, home, docker));
  assert.equal(first.profile.identityId, second.profile.identityId);
  assert.notEqual(first.apk, second.apk);
  assert.equal(docker.calls.filter(c => c.command?.includes('-genkeypair')).length, 1);
  assert.equal(await readFile(path.join(source, 'package-lock.json'), 'utf8'), before);
  assert.deepEqual((await readdir(source)).sort(), ['package-lock.json', 'package.json']);
  assert.ok(!(await readdir(home)).includes('work'));
  const build = docker.calls.find(c => c.command?.[0] === 'build');
  assert.equal(mounts(build.args).find(m => m.target === '/input').readonly, true);
  assert.equal(mounts(build.args).find(m => m.target === '/secrets').readonly, true);
});

test('separate projects have separate identities; setup can reuse an identity after relocation', async t => {
  const { source, home, temporary } = await sandbox(t), docker = new FakeDocker();
  const first = await launch(options(source, home, docker, ['1']));
  const secondSource = path.join(temporary, 'second'); await mkdir(secondSource);
  for (const name of ['package.json', 'package-lock.json']) await writeFile(path.join(secondSource, name), await readFile(path.join(source, name)));
  const second = await launch(options(secondSource, home, docker, ['1']));
  assert.notEqual(first.profile.identityId, second.profile.identityId);
  const identities = await readdir(path.join(home, 'identities'));
  await launch({ ...options(secondSource, home, docker, ['3', String(identities.indexOf(first.profile.identityId) + 1)]), args: ['setup'] });
  const reused = await launch(options(secondSource, home, docker));
  assert.equal(first.profile.identityId, reused.profile.identityId);
});

test('import copies existing key and requests hidden passwords without putting them in command arguments', async t => {
  const { source, home, temporary } = await sandbox(t), docker = new FakeDocker();
  const original = path.join(temporary, 'existing key.jks'); await writeFile(original, 'existing private identity');
  const secretFlags = [], answers = ['2', original, 'my-alias', 'password-one', 'password-two'];
  const result = await launch({ ...options(source, home, docker), ask: async (_text, settings) => { secretFlags.push(settings.secret); return answers.shift(); } });
  const identity = await identityAt(home, result.profile.identityId);
  assert.equal(identity.alias, 'my-alias');
  assert.equal(await readFile(path.join(identity.directory, 'release.jks'), 'utf8'), 'existing private identity');
  assert.deepEqual(secretFlags.slice(-2), [true, true]);
  const commands = JSON.stringify(docker.calls.map(c => ({ args: c.args, command: c.command })));
  assert.ok(!commands.includes('password-one') && !commands.includes('password-two'));
});

test('missing saved key fails without replacing identity; failed imports are not committed', async t => {
  const { source, home } = await sandbox(t), docker = new FakeDocker();
  const result = await launch(options(source, home, docker, ['1']));
  const file = path.join(home, 'identities', result.profile.identityId, 'release.jks'); await rm(file);
  await assert.rejects(launch(options(source, home, docker)), /No replacement key was generated/);
  assert.equal((await readdir(path.join(home, 'identities'))).length, 1);
  const original = docker.container.bind(docker);
  docker.container = async (args, command, settings) => { if (command.includes('-certreq')) throw new Error('bad key'); return original(args, command, settings); };
  await assert.rejects(launch({ ...options(source, home, docker, ['1']), args: ['setup'] }), /Signing verification failed/);
  assert.equal((await readdir(path.join(home, 'identities'))).length, 1);
  assert.equal(Object.values((await readProfiles(home)).projects)[0].identityId, result.profile.identityId);
});

test('noninteractive first build gives setup instructions before starting Docker', async t => {
  const { source, home } = await sandbox(t), docker = new FakeDocker();
  await assert.rejects(launch({ ...options(source, home, docker), interactive: false }), /buildapk setup/);
  assert.ok(!docker.calls.includes('prepare'));
});

test('web apps and unsupported versions fail before Docker or dependency changes', async t => {
  const { source, home } = await sandbox(t), docker = new FakeDocker();
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { react: '19.1.0' } }));
  await assert.rejects(launch(options(source, home, docker)), /Cannot build this project/);
  assert.equal(docker.calls.length, 0);
  await writeFile(path.join(source, 'package.json'), await readFile(path.join(fixture, 'package.json')));
  const lock = JSON.parse(await readFile(path.join(source, 'package-lock.json'))); lock.packages['node_modules/react-native'].version = '0.80.0';
  await writeFile(path.join(source, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(launch(options(source, home, docker)), /react-native must resolve to 0.81.5/);
});

test('host storage inside app source is rejected', () => {
  assert.throws(() => outsideSource(path.resolve('app'), path.resolve('app', 'keys')), /outside/);
  assert.doesNotThrow(() => outsideSource(path.resolve('app'), path.resolve('app-other')));
});

test('launcher lock rejects overlap and recovers a dead owner', async t => {
  const { home } = await sandbox(t);
  const release = await acquireLock(home);
  await assert.rejects(acquireLock(home), /Another BuildAPK/);
  await release();
  await writeFile(path.join(home, 'launcher.lock'), JSON.stringify({ pid: 2147483647, token: 'dead' }));
  await (await acquireLock(home))();
});

test('Docker unavailable and Windows-container mode give actionable errors', async () => {
  await assert.rejects(new Docker({ execute: async () => { throw new Error('ENOENT'); } }).check(), /Install\/start Docker/);
  await assert.rejects(new Docker({ execute: async () => 'windows' }).check(), /Linux containers/);
});

test('missing image builds once; existing image is pinned without rebuilding', async () => {
  for (const imagePresent of [false, true]) {
    const calls = [];
    const docker = new Docker({ root: 'repository path', log: silent, execute: async (_command, args) => {
      calls.push(args); return args[1] === 'ls' ? (imagePresent ? 'sha256:test' : '') : args[1] === 'inspect' ? 'sha256:test' : '';
    } });
    await docker.prepare(); await docker.close();
    assert.equal(calls.filter(args => args[0] === 'build').length, imagePresent ? 0 : 1);
    assert.ok(calls.some(args => args[0] === 'tag' && args[1] === 'sha256:test'));
  }
});

test('container cancellation stops and removes the owned container before returning', async () => {
  const controller = new AbortController(), calls = []; let rejectStart;
  const docker = new Docker({ signal: controller.signal, execute: async (_command, args) => {
    calls.push(args);
    if (args[0] === 'start') return new Promise((_resolve, reject) => { rejectStart = reject; controller.abort(new Error('cancelled')); });
    if (args[0] === 'stop') rejectStart?.(new Error('stopped'));
    return '';
  } });
  docker.image = 'test';
  await assert.rejects(docker.container([], ['build']), /stopped|cancelled/);
  assert.ok(calls.some(args => args[0] === 'stop' && args[2] === '15'));
  assert.ok(calls.some(args => args[0] === 'rm'));
  assert.equal(docker.names.size, 0);
});

test('Docker mount arguments preserve spaces and CSV-special characters', () => {
  const source = path.resolve('folder with spaces, and "quotes"');
  assert.equal(mounts(mount(source, '/input', true))[0].source, source);
});

test('failed builds report their stage and log location and release the launcher lock', async t => {
  const { source, home } = await sandbox(t), docker = new FakeDocker();
  const messages = [], log = logger(null, [], { write(text) { messages.push(text); } });
  const original = docker.container.bind(docker);
  docker.container = async (args, command, settings) => {
    await original(args, command, settings);
    if (command[0] === 'build') {
      const output = mounts(args).find(m => m.target === '/output').source;
      await writeFile(path.join(output, 'job-1', 'result.json'), JSON.stringify({ status: 'failed', error: { stage: 'compile', message: 'compiler failed' } }));
      throw new Error('exit 1');
    }
  };
  await assert.rejects(launch({ ...options(source, home, docker, ['1']), log }), /failed at compile: compiler failed/);
  assert.match(messages.join(''), /Build log: .*build.log/);
  await (await acquireLock(home))();
});

test('protecting storage refuses unrelated folders before changing permissions', async t => {
  const { home } = await sandbox(t);
  await writeFile(path.join(home, 'important.txt'), 'unrelated data');
  await assert.rejects(protectHome(home), /dedicated BuildAPK folder/);
  assert.equal(await readFile(path.join(home, 'important.txt'), 'utf8'), 'unrelated data');
});

test('crash recovery only selects containers and temporary volumes labelled for this storage home', async () => {
  const calls = [];
  const docker = new Docker({ home: 'test-home', log: silent, execute: async (_command, args) => {
    calls.push(args);
    if (args[0] === 'ps') return 'owned-container';
    if (args[0] === 'volume' && args[1] === 'ls') return 'owned-work-volume';
    return '';
  } });
  await docker.recover();
  assert.match(calls[0].at(-1), /^label=buildapk.launcher.home=[a-f0-9]{64}$/);
  assert.deepEqual(calls.filter(args => args[0] === 'stop').map(args => args.at(-1)), ['owned-container']);
  assert.deepEqual(calls.filter(args => args[0] === 'volume' && args[1] === 'rm').map(args => args.at(-1)), ['owned-work-volume']);
});
