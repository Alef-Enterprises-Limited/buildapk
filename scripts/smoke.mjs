// Cross-platform host driver. All Android tooling and app compilation run in containers.
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { run, logger } from '../src/runtime.mjs';
import { hash } from '../src/build.mjs';
import { excluded } from '../src/project.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const requestedImage = process.env.BUILDAPK_TEST_IMAGE ?? 'buildapk:local';
let image = requestedImage;
const id = randomUUID(), name = `buildapk-smoke-${id}`;
const imageTag = `buildapk-smoke-image:${id}`;
let imageId;
const fixture = path.join(root, 'fixtures/expo-minimal');
const output = path.join(root, 'output', `smoke-${id}`);
const secrets = await mkdtemp(path.join(os.tmpdir(), 'buildapk-signing-'));
const nativeVolume = `${name}-native`, cacheVolume = 'buildapk-smoke-cache';
const controller = new AbortController();
const stop = () => controller.abort(new Error('Smoke test interrupted.'));
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const timer = setTimeout(() => controller.abort(new Error('Smoke test exceeded two hours.')), 7200000);
const password = randomBytes(32).toString('hex');
const log = logger(null, [password]);
const docker = (args, options = {}) => run('docker', args, { log, signal: controller.signal, ...options });
const base = ['run', '--rm', '--name', name, '--platform', 'linux/amd64'];
const bind = (source, target, ro = false) => ['--mount', `type=bind,source=${source},target=${target}${ro ? ',readonly' : ''}`];
const volume = (source, target) => ['--mount', `type=volume,source=${source},target=${target}`];
const outputMount = bind(output, '/output'), cacheMount = volume(cacheVolume, '/cache');
const secretMount = bind(secrets, '/secrets', true);
const signingEnv = ['-e', 'BUILDAPK_KEYSTORE_PATH=/secrets/release.jks', '-e', 'BUILDAPK_KEY_ALIAS=release', '-e', 'BUILDAPK_STORE_PASSWORD_FILE=/secrets/store-password', '-e', 'BUILDAPK_KEY_PASSWORD_FILE=/secrets/key-password'];

async function snapshot(directory, prefix = '') {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (excluded(relative, entry.isDirectory())) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await snapshot(file, relative));
    else entries.push([relative, await hash(file)]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}

async function newResult(previous) {
  const entries = (await readdir(output, { withFileTypes: true })).filter(e => e.isDirectory() && !previous.includes(e.name));
  assert.equal(entries.length, 1, 'one output directory per invocation');
  const result = JSON.parse(await readFile(path.join(output, entries[0].name, 'result.json'), 'utf8'));
  if (result.status === 'succeeded') {
    assert.equal(result.artifact.sha256, await hash(path.join(output, result.buildId, result.artifact.path)));
    assert.deepEqual(result.artifact.abis, ['arm64-v8a']);
    assert.match(result.signingCertificateSha256, /^[a-f0-9]{64}$/);
  }
  const buildLog = await readFile(path.join(output, result.buildId, 'build.log'), 'utf8');
  assert.ok(!buildLog.includes(password), 'signing passwords must not be logged');
  return result;
}

try {
  // Keep all checks on the same image even if a local build moves the tag.
  imageId = (await docker(['image', 'inspect', requestedImage, '--format', '{{.Id}}'], { capture: 'stdout' })).trim();
  await docker(['tag', imageId, imageTag]);
  image = imageTag; // The extra tag also protects the image from local garbage collection.
  await mkdir(output, { recursive: true });
  await writeFile(path.join(secrets, 'store-password'), password + '\n', { mode: 0o600 });
  await writeFile(path.join(secrets, 'key-password'), password + '\n', { mode: 0o600 });
  await docker([...base, '--user', '0', ...outputMount, ...cacheMount, ...volume(nativeVolume, '/native'), ...bind(secrets, '/secrets'), '--entrypoint', 'sh', image, '-c', 'chown -R 10001:10001 /output /cache /native /secrets']);
  await docker([...base, ...bind(secrets, '/secrets'), '--entrypoint', 'keytool', image,
    '-genkeypair', '-keystore', '/secrets/release.jks', '-storetype', 'JKS', '-alias', 'release',
    '-storepass:file', '/secrets/store-password', '-keypass:file', '/secrets/key-password',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=BuildAPK disposable smoke test']);
  const mounts = [...bind(fixture, '/input', true), ...outputMount, ...cacheMount, ...secretMount];
  await docker([...base, ...mounts, ...signingEnv, image, 'doctor', '--mounts']);
  const before = await snapshot(fixture);
  let previous = await readdir(output);
  await docker([...base, ...mounts, ...signingEnv, image, 'build']);
  const expo = await newResult(previous);
  assert.equal(expo.status, 'succeeded'); assert.equal(expo.mode, 'expo');
  assert.deepEqual(await snapshot(fixture), before, 'source and lockfile must remain unchanged');

  previous = await readdir(output);
  await assert.rejects(docker([...base, ...mounts, image, 'build']), error => error.exitCode === 1);
  const failure = await newResult(previous);
  assert.equal(failure.status, 'failed'); assert.equal(failure.error.stage, 'validate');
  assert.match(failure.error.message, /BUILDAPK_KEYSTORE_PATH/);

  // Generate a controlled native input in a transient container, outside image layers.
  const prepareNative = `
    const {copySource} = await import('/opt/buildapk/src/project.mjs');
    const {run} = await import('/opt/buildapk/src/runtime.mjs');
    const {childEnvironment} = await import('/opt/buildapk/src/build.mjs');
    await copySource('/input','/work/project');
    const options={cwd:'/work/project',env:childEnvironment(process.env,'/cache')};
    await run('npm',['ci','--include=dev','--no-audit','--no-fund'],options);
    await run('node',['node_modules/expo/bin/cli','prebuild','--platform','android','--no-install','--template','/opt/buildapk/expo-template.tgz'],options);
    await copySource('/work/project','/native');
  `;
  await docker([...base, ...bind(fixture, '/input', true), ...cacheMount, ...volume(nativeVolume, '/native'), '--entrypoint', 'node', image, '--input-type=module', '-e', prepareNative]);
  const nativeHashCode = `const {hash}=await import('/opt/buildapk/src/build.mjs');console.log(await hash('/input/android/app/build.gradle'));`;
  const nativeMount = ['--mount', `type=volume,source=${nativeVolume},target=/input,readonly`];
  const nativeBefore = await docker([...base, ...nativeMount, '--entrypoint', 'node', image, '--input-type=module', '-e', nativeHashCode], { capture: true });
  previous = await readdir(output);
  await docker([...base, ...nativeMount, ...outputMount, ...cacheMount, ...secretMount, ...signingEnv, image, 'build', '--mode', 'native']);
  const native = await newResult(previous);
  assert.equal(native.status, 'succeeded'); assert.equal(native.mode, 'native');
  const nativeAfter = await docker([...base, ...nativeMount, '--entrypoint', 'node', image, '--input-type=module', '-e', nativeHashCode], { capture: true });
  assert.equal(nativeAfter, nativeBefore);
  assert.equal(native.signingCertificateSha256, expo.signingCertificateSha256);
  const size = (await docker(['image', 'inspect', image, '--format', '{{.Size}}'], { capture: true })).trim();
  const report = { requestedImage, image: imageId, imageBytes: Number(size), checkedAt: new Date().toISOString(), expo, native, missingSigning: failure, deviceLaunch: 'pending: install on a physical arm64 Android device with Metro stopped' };
  await writeFile(path.join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Smoke checks passed. Report and APKs: ${output}`);
} finally {
  clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop);
  const remaining = await run('docker', ['ps', '-aq', '--filter', `name=^/${name}$`], { capture: 'stdout', log: logger(null, [], { write() {} }) }).catch(() => '');
  if (remaining.trim()) await run('docker', ['rm', '-f', name], { log }).catch(() => {});
  await run('docker', ['volume', 'rm', nativeVolume], { log }).catch(() => {});
  // This exact task-owned directory is created by mkdtemp above; preserve all build outputs.
  // Root container cleanup handles files generated under UID 10001 on POSIX hosts.
  await run('docker', ['run', '--rm', '--user', '0', ...bind(secrets, '/secrets'), '-e', `HOST_UID=${process.getuid?.() ?? 0}`, '-e', `HOST_GID=${process.getgid?.() ?? 0}`, '--entrypoint', 'sh', image, '-c', 'rm -f /secrets/release.jks /secrets/store-password /secrets/key-password && chown "$HOST_UID:$HOST_GID" /secrets'], { log }).catch(() => {});
  await rm(secrets, { recursive: true, force: true });
  if (imageId) await run('docker', ['image', 'rm', imageTag], { log }).catch(() => {});
}
