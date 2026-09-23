// Full host-launcher verification; disposable signing identities never enter the repo/image.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, copyFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { launch, root, identityAt } from '../src/host.mjs';
import { Docker, mount, quiet } from '../src/host-docker.mjs';
import { copySource } from '../src/project.mjs';
import { hash } from '../src/build.mjs';
import { run } from '../src/runtime.mjs';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'buildapk-launcher-smoke-'));
const home = path.join(temporary, 'private storage'), source = path.join(temporary, 'Expo app with spaces');
const native = path.join(temporary, 'native app with spaces');
const reportDirectory = path.join(root, 'output', `launcher-smoke-${randomUUID()}`);
await mkdir(reportDirectory, { recursive: true });
await copySource(path.join(root, 'fixtures', 'expo-minimal'), source);
const controller = new AbortController();
const cancel = () => controller.abort(new Error('Launcher smoke check cancelled.'));
process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
const timer = setTimeout(cancel, 7200000);
const docker = new Docker({ signal: controller.signal, root });
const results = {};
async function preserve(label, result, apk) {
  const directory = path.join(reportDirectory, label); await mkdir(directory);
  assert.equal(await hash(apk), result.artifact.sha256);
  assert.equal(result.status, 'succeeded');
  await copyFile(apk, path.join(directory, 'app-release.apk'));
  for (const file of ['result.json', 'build.log']) await copyFile(path.join(path.dirname(apk), file), path.join(directory, file));
  results[label] = result;
}
const askOnce = answers => async () => { assert.ok(answers.length, 'Unexpected prompt'); return answers.shift(); };
try {
  const initialLock = await hash(path.join(source, 'package-lock.json'));
  const first = await launch({ args: [], cwd: source, env: { BUILDAPK_HOME: home }, signal: controller.signal,
    interactive: true, ask: askOnce(['1']) });
  await preserve('expo-first', first.result, first.apk);
  // Exercise the actual executable without a TTY: the saved profile must be enough.
  await run(process.execPath, [path.join(root, 'src', 'host-cli.mjs')], {
    cwd: source, env: { ...process.env, BUILDAPK_HOME: home }, signal: controller.signal,
  });
  const parent = path.join(home, 'builds', first.profile.id);
  const repeatLaunch = (await readdir(parent)).find(id => id !== path.basename(path.dirname(path.dirname(first.apk))));
  const repeatParent = path.join(parent, repeatLaunch);
  const job = (await readdir(repeatParent))[0];
  const repeat = JSON.parse(await readFile(path.join(repeatParent, job, 'result.json')));
  await preserve('expo-repeat', repeat, path.join(repeatParent, job, 'app-release.apk'));
  assert.equal(repeat.signingCertificateSha256, first.result.signingCertificateSha256);
  assert.equal(await hash(path.join(source, 'package-lock.json')), initialLock);

  await docker.check(); await docker.prepare(); await docker.initializeCache();
  await mkdir(native);
  await docker.container([...mount(source, '/input', true), ...mount(native, '/native'), ...mount(docker.work, '/work', false, 'volume'),
    ...mount(docker.cache, '/cache', false, 'volume')], ['--input-type=module', '-e', `
    const {copySource}=await import('/opt/buildapk/src/project.mjs');
    const {run}=await import('/opt/buildapk/src/runtime.mjs');
    const {childEnvironment}=await import('/opt/buildapk/src/build.mjs');
    await copySource('/input','/work/project');
    const options={cwd:'/work/project',env:childEnvironment(process.env,'/cache')};
    await run('npm',['ci','--include=dev','--no-audit','--no-fund'],options);
    await run('node',['node_modules/expo/bin/cli','prebuild','--platform','android','--no-install','--template','/opt/buildapk/expo-template.tgz'],options);
    await copySource('/work/project','/native');
  `], { entrypoint: 'node' });
  const nativeBefore = await hash(path.join(native, 'android', 'app', 'build.gradle'));
  const identity = await identityAt(home, first.profile.identityId);
  const nativeBuild = await launch({ args: [], cwd: native, env: { BUILDAPK_HOME: home }, signal: controller.signal,
    interactive: true, ask: askOnce(['2', path.join(identity.directory, 'release.jks'), identity.alias, ...identity.passwords]) });
  await preserve('native-import', nativeBuild.result, nativeBuild.apk);
  assert.equal(nativeBuild.result.mode, 'native');
  assert.equal(nativeBuild.result.signingCertificateSha256, first.result.signingCertificateSha256);
  assert.equal(await hash(path.join(native, 'android', 'app', 'build.gradle')), nativeBefore);
  for (const label of Object.keys(results)) {
    const log = await readFile(path.join(reportDirectory, label, 'build.log'), 'utf8');
    for (const password of identity.passwords) assert.ok(!log.includes(password));
  }

  // Cancel a real engine during dependency installation; wait for metadata and cleanup.
  const abort = new AbortController();
  const previous = await readdir(parent);
  let cancelling = false;
  const monitor = setInterval(async () => {
    if (cancelling) return;
    try {
      const next = (await readdir(parent)).find(id => !previous.includes(id));
      if (!next) return;
      const jobId = (await readdir(path.join(parent, next)))[0];
      if (!jobId) return;
      const metadata = JSON.parse(await readFile(path.join(parent, next, jobId, 'result.json')));
      if (metadata.stage === 'dependencies') { cancelling = true; abort.abort(new Error('Intentional smoke cancellation')); }
    } catch { /* Result files can appear between polls. */ }
  }, 100);
  const abortTimer = setTimeout(() => abort.abort(new Error('Cancellation check timed out')), 120000);
  try {
    await assert.rejects(launch({ args: [], cwd: source, env: { BUILDAPK_HOME: home }, signal: abort.signal, interactive: false }));
    assert.ok(cancelling, 'cancellation reached dependency installation');
    const cancelledRun = (await readdir(parent)).find(id => !previous.includes(id));
    const jobId = (await readdir(path.join(parent, cancelledRun)))[0];
    const metadata = JSON.parse(await readFile(path.join(parent, cancelledRun, jobId, 'result.json')));
    assert.equal(metadata.status, 'cancelled');
    assert.equal(metadata.artifact, null);
    results.cancelled = metadata;
    const directory = path.join(reportDirectory, 'cancelled'); await mkdir(directory);
    for (const file of ['result.json', 'build.log']) await copyFile(path.join(parent, cancelledRun, jobId, file), path.join(directory, file));
  } finally { clearInterval(monitor); clearTimeout(abortTimer); }
  assert.ok(!(await readdir(home)).includes('work'));
  const remaining = await docker.command(['ps', '-aq', '--filter', 'name=buildapk-launcher-'], { capture: 'stdout', log: quiet });
  assert.equal(remaining.trim(), '', 'launcher containers must be removed');
  await writeFile(path.join(reportDirectory, 'verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ...results }, null, 2) + '\n');
  console.log(`Launcher smoke checks passed. Report and APKs: ${reportDirectory}`);
} finally {
  clearTimeout(timer); process.off('SIGINT', cancel); process.off('SIGTERM', cancel);
  await docker.close();
  // Only this mkdtemp-created, task-owned directory contains disposable test secrets.
  assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await rm(temporary, { recursive: true, force: true });
}
