import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { selectMode, copySource, selectApk, validateProject, disjointPaths, exists } from '../src/project.mjs';
import { redactor, run, logger } from '../src/runtime.mjs';
import { build, toolchain, childEnvironment } from '../src/build.mjs';

const quiet = new Writable({ write(chunk, encoding, done) { done(); } });
async function sandbox(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'buildapk-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('mode selection preserves native projects and rejects destructive or unsupported choices', () => {
  assert.equal(selectMode('auto', true, true), 'native');
  assert.equal(selectMode('auto', false, true), 'expo');
  assert.equal(selectMode('native', true, false), 'native');
  assert.throws(() => selectMode('expo', true, true), /customizations/);
  assert.throws(() => selectMode('native', false, true), /complete android/);
  assert.throws(() => selectMode('auto', false, false), /without android/);
  assert.throws(() => selectMode('unknown', true, true), /Mode/);
});

test('working copy preserves source/assets/lockfile while excluding secrets and stale artifacts', async t => {
  const root = await sandbox(t), source = path.join(root, 'source with spaces'), work = path.join(root, 'work');
  const keep = ['package-lock.json', 'App.js', 'assets/picture.png', 'android/gradlew', 'android/gradle/wrapper/gradle-wrapper.jar', 'src/build/index.js'];
  const drop = ['.env', '.env.production', 'secrets/password', 'release.jks', '.npmrc', 'old.apk', 'node_modules/lib/index.js', 'android/app/build/outputs/apk/stale.apk', 'android/local.properties', '.git/config'];
  for (const file of [...keep, ...drop]) { await mkdir(path.dirname(path.join(source, file)), { recursive: true }); await writeFile(path.join(source, file), file); }
  await copySource(source, work);
  for (const file of keep) assert.equal(await readFile(path.join(work, file), 'utf8'), file);
  for (const file of drop) assert.equal(await exists(path.join(work, file)), false, file);
  await writeFile(path.join(work, 'App.js'), 'changed');
  assert.equal(await readFile(path.join(source, 'App.js'), 'utf8'), 'App.js');
  assert.equal(await readFile(path.join(source, 'package-lock.json'), 'utf8'), 'package-lock.json');
});

test('APK selection rejects missing and ambiguous output, including split APKs', async t => {
  const root = await sandbox(t);
  await assert.rejects(selectApk(root), /found 0/);
  await writeFile(path.join(root, 'app-release.apk'), 'apk');
  assert.equal(await selectApk(root), path.join(root, 'app-release.apk'));
  await mkdir(path.join(root, 'split'));
  await writeFile(path.join(root, 'split', 'arm64.apk'), 'apk');
  await assert.rejects(selectApk(root), /found 2/);
});

test('redaction handles secrets across every possible chunk boundary', () => {
  const input = 'prefix secret-one / another-password suffix';
  for (let split = 0; split <= input.length; split++) {
    let output = '';
    const filter = redactor(['secret-one', 'another-password'], s => { output += s; });
    filter.write(input.slice(0, split)); filter.write(input.slice(split)); filter.end();
    assert.equal(output, 'prefix [REDACTED] / [REDACTED] suffix');
  }
});

test('child failure propagates exit code, argument arrays handle spaces, logs redact passwords', async t => {
  const root = await sandbox(t), file = path.join(root, 'build.log');
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write(process.argv[1]); process.exit(23)', 'a secret value'], {
    log: logger(file, ['secret'], quiet), cwd: root,
  }), error => error.exitCode === 23);
  assert.equal(await readFile(file, 'utf8'), 'a [REDACTED] value');
});

test('cancellation stops an active subprocess and propagates its reason', async () => {
  const controller = new AbortController();
  const running = run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { signal: controller.signal, log: logger(null, [], quiet) });
  setTimeout(() => controller.abort(new Error('cancelled by test')), 100);
  await assert.rejects(running, /cancelled by test/);
});

test('structured stdout capture is not corrupted by simultaneous stderr diagnostics', async () => {
  const output = await run(process.execPath, ['-e', 'process.stdout.write("certificate"); process.stderr.write("warning");'], {
    capture: 'stdout', log: logger(null, [], quiet),
  });
  assert.equal(output, 'certificate');
});

test('log-storage failure stops the child and rejects instead of leaving it running', async () => {
  const log = { stream: () => ({ write() { throw new Error('disk full'); }, end() {} }) };
  await assert.rejects(run(process.execPath, ['-e', 'process.stdout.write("progress"); setInterval(()=>{},1000);'], { log }), /disk full/);
});

test('Linux cancellation kills a descendant that starts its own process group', { skip: process.platform !== 'linux' }, async t => {
  const root = await sandbox(t), pidFile = path.join(root, 'daemon.pid');
  const daemon = `require('node:fs').writeFileSync(process.argv[1], String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)},process.argv[1]],{detached:true,stdio:'ignore'}).unref(); setInterval(()=>{},1000);`;
  const controller = new AbortController();
  const running = run(process.execPath, ['-e', parent, pidFile], { signal: controller.signal, log: logger(null, [], quiet) });
  for (let i = 0; i < 100 && !await exists(pidFile); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await exists(pidFile), true, 'detached descendant started');
  const pid = Number(await readFile(pidFile, 'utf8'));
  controller.abort(new Error('stop detached daemon'));
  await assert.rejects(running, /stop detached daemon/);
  // A killed child may briefly be a zombie awaiting reaping by the container init.
  const procStat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  assert.ok(!procStat || procStat.slice(procStat.lastIndexOf(')') + 2).startsWith('Z'), 'daemon must no longer be running');
});

test('project validation rejects competing lockfiles, workspaces, and wrong baselines', async t => {
  const root = await sandbox(t);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { expo: toolchain.expo, react: toolchain.react, 'react-native': toolchain.reactNative } }));
  await writeFile(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/expo': { version: toolchain.expo }, 'node_modules/react': { version: toolchain.react }, 'node_modules/react-native': { version: toolchain.reactNative } } }));
  assert.equal((await validateProject(root, 'auto', toolchain)).mode, 'expo');
  await writeFile(path.join(root, 'yarn.lock'), '');
  await assert.rejects(validateProject(root, 'auto', toolchain), /single npm/);
  await rm(path.join(root, 'yarn.lock'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['apps/*'] }));
  await assert.rejects(validateProject(root, 'auto', toolchain), /single npm/);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  await assert.rejects(validateProject(root, 'auto', toolchain), /Unsupported baseline/);
});

test('missing signing inputs create separate failed results and no success artifact', async t => {
  const root = await sandbox(t), options = { env: {}, terminal: quiet };
  for (const key of ['source', 'output', 'cache', 'work']) { options[key] = path.join(root, key); await mkdir(options[key]); }
  const first = await build(options), second = await build(options);
  assert.equal(first.status, 'failed'); assert.equal(first.error.stage, 'validate');
  assert.match(first.error.message, /BUILDAPK_KEYSTORE_PATH/);
  assert.notEqual(first.buildId, second.buildId);
  for (const result of [first, second]) {
    assert.equal(JSON.parse(await readFile(path.join(options.output, result.buildId, 'result.json'))).status, 'failed');
    assert.equal(await exists(path.join(options.output, result.buildId, 'app-release.apk')), false);
    assert.deepEqual((await readdir(path.join(options.output, result.buildId))).sort(), ['build.log', 'result.json']);
  }
});

test('overlapping paths are rejected and child environments omit builder signing configuration', async t => {
  const root = await sandbox(t), nested = path.join(root, 'nested'); await mkdir(nested);
  await assert.rejects(disjointPaths([root, nested]), /non-nested/);
  const env = childEnvironment({ BUILDAPK_KEY_ALIAS: 'release', EXPO_PUBLIC_NAME: 'hello' }, '/cache');
  assert.equal(env.BUILDAPK_KEY_ALIAS, undefined); assert.equal(env.EXPO_PUBLIC_NAME, 'hello');
});

test('an output nested inside source is rejected without changing source', async t => {
  const root = await sandbox(t), source = path.join(root, 'source');
  const output = path.join(source, 'output'), cache = path.join(root, 'cache'), work = path.join(root, 'work');
  for (const dir of [output, cache, work]) await mkdir(dir, { recursive: true });
  const result = await build({ source, output, cache, work, env: {}, terminal: quiet });
  assert.equal(result.status, 'failed'); assert.match(result.error.message, /non-nested/);
  assert.deepEqual(await readdir(output), []);
});

test('pre-cancelled builds produce cancelled metadata without starting tools', async t => {
  const root = await sandbox(t), controller = new AbortController(), options = { signal: controller.signal, env: {}, terminal: quiet };
  for (const key of ['source', 'output', 'cache', 'work']) { options[key] = path.join(root, key); await mkdir(options[key]); }
  controller.abort(new Error('cancelled before starting'));
  const result = await build(options);
  assert.equal(result.status, 'cancelled'); assert.equal(result.error.message, 'cancelled before starting');
  assert.deepEqual(await readdir(options.work), []);
});
