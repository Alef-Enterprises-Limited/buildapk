import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, writeFile, rename, rm, stat, chmod, copyFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { json, validateProject, validateNative, copySource, selectApk, disjointPaths } from './project.mjs';
import { logger, run, sanitize } from './runtime.mjs';

const engineRoot = fileURLToPath(new URL('../', import.meta.url));
export const toolchain = await json(path.join(engineRoot, 'toolchain.json'));
export const version = (await json(path.join(engineRoot, 'package.json'))).version;
export const defaults = { source: '/input', output: '/output', cache: '/cache', work: '/work', mode: 'auto' };

function configure(options) {
  const settings = { ...defaults, ...options };
  for (const key of ['source', 'output', 'cache', 'work']) settings[key] = path.resolve(settings[key]);
  return settings;
}

export async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function writable(directory) {
  await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  const probe = await mkdtemp(path.join(directory, '.buildapk-check-'));
  await rm(probe, { recursive: true });
}

function integer(value, fallback, name, min = 1, max = 86400) {
  const text = value ?? String(fallback);
  if (!/^\d+$/.test(text) || Number(text) < min || Number(text) > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return Number(text);
}

export function childEnvironment(env, cache) {
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('BUILDAPK_'))),
    CI: '1', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', NODE_ENV: 'production',
    npm_config_cache: path.join(cache, 'npm'), GRADLE_USER_HOME: path.join(cache, 'gradle'),
  };
}

async function signingInputs(env, secrets) {
  const keys = ['BUILDAPK_KEYSTORE_PATH', 'BUILDAPK_KEY_ALIAS', 'BUILDAPK_STORE_PASSWORD_FILE', 'BUILDAPK_KEY_PASSWORD_FILE'];
  for (const key of keys) if (!env[key]) throw new Error(`Missing ${key}. Supply release signing material through a read-only /secrets mount.`);
  for (const key of keys.filter(k => k !== 'BUILDAPK_KEY_ALIAS')) {
    const info = await stat(env[key]);
    if (!info.isFile()) throw new Error(`${key} must name a readable regular file.`);
    await access(env[key], constants.R_OK);
  }
  for (const key of keys.filter(k => k.endsWith('_PASSWORD_FILE'))) {
    if ((await stat(env[key])).size > 4096) throw new Error(`${key} is too large.`);
    const password = (await readFile(env[key], 'utf8')).replace(/\r?\n$/, '');
    if (!password || /[\r\n\0]/.test(password)) throw new Error(`${key} must contain one nonempty password line.`);
    secrets.push(password);
  }
  return {
    store: await realpath(env.BUILDAPK_KEYSTORE_PATH), alias: env.BUILDAPK_KEY_ALIAS,
    storePassword: await realpath(env.BUILDAPK_STORE_PASSWORD_FILE), keyPassword: await realpath(env.BUILDAPK_KEY_PASSWORD_FILE),
  };
}

async function checkTools(exec, env) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('App builds require the linux/amd64 builder container.');
  const checks = [['node', ['--version'], `v${toolchain.node}`], ['npm', ['--version'], toolchain.npm], ['java', ['-version'], toolchain.java], ['javac', ['-version'], toolchain.java], ['apksigner', ['version']], ['cmake', ['--version'], toolchain.cmake], ['git', ['--version']], ['unzip', ['-v']]];
  for (const [command, args, expected] of checks) {
    const output = await exec(command, args, { capture: true });
    if (expected && !output.includes(expected)) throw new Error(`Incompatible ${command}; expected ${expected}. Rebuild the pinned image.`);
  }
  const sdk = env.ANDROID_HOME;
  if (!sdk) throw new Error('ANDROID_HOME is missing. Use the builder image.');
  for (const relative of [`platforms/android-${toolchain.androidPlatform}/android.jar`, `build-tools/${toolchain.buildTools}/zipalign`, `build-tools/${toolchain.buildTools}/aapt`, `ndk/${toolchain.ndk}/source.properties`, `cmake/${toolchain.cmake}/bin/cmake`, 'cmdline-tools/19.0/bin/sdkmanager']) await access(path.join(sdk, relative), constants.R_OK);
  const installed = {};
  for (const [directory, expected] of [[`platforms/android-${toolchain.androidPlatform}`, toolchain.androidPlatformRevision], [`build-tools/${toolchain.buildTools}`, toolchain.buildTools], [`build-tools/${toolchain.libraryBuildTools}`, toolchain.libraryBuildTools], ['platform-tools', toolchain.platformTools], [`ndk/${toolchain.ndk}`, toolchain.ndk], [`cmake/${toolchain.cmake}`, toolchain.cmake], ['cmdline-tools/19.0', '19.0']]) {
    const properties = await readFile(path.join(sdk, directory, 'source.properties'), 'utf8');
    const revision = /^Pkg.Revision\s*=\s*(.+)$/m.exec(properties)?.[1].trim();
    if (!revision || (expected && revision !== expected)) throw new Error(`Unexpected installed SDK revision for ${directory}: ${revision}.`);
    installed[directory] = revision;
  }
  return installed;
}

export async function doctor(options = {}) {
  const settings = configure(options), env = options.env ?? process.env;
  const log = logger(), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Doctor timed out after 60 seconds.')), 60000);
  try {
    log.message(`BuildAPK ${version}: ${toolchain.id}`);
    const installed = await checkTools((cmd, args, extra) => run(cmd, args, { env, log, signal: controller.signal, ...extra }), env);
    for (const [component, revision] of Object.entries(installed)) log.message(`${component}: installed revision ${revision}`);
    if (settings.mounts) {
      await access(settings.source, constants.R_OK | constants.X_OK);
      for (const directory of [settings.output, settings.cache, settings.work]) await writable(directory);
      await disjointPaths([settings.source, settings.output, settings.cache, settings.work]);
      await signingInputs(env, []);
      log.message('Build mounts and signing files are accessible.');
    } else log.message('Toolchain checks passed. Use doctor --mounts with build mounts to check permissions and signing inputs.');
    return true;
  } finally { clearTimeout(timer); }
}

// Direct, HTTP-independent entry point. Resolves with terminal metadata; caller checks status.
export async function build(options = {}) {
  const settings = configure(options), env = options.env ?? process.env;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options.signal.reason instanceof Error ? options.signal.reason : new Error(String(options.signal.reason ?? 'Build cancelled.')));
  options.signal?.addEventListener('abort', forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();
  const started = Date.now(), buildId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const result = { schemaVersion: 1, buildId, engineVersion: version, status: 'running', stage: 'validate', startedAt: new Date(started).toISOString(), finishedAt: null, durationMs: null, mode: settings.mode, toolchain, artifact: null, signingCertificateSha256: null, error: null };
  let job, working, timer, log = logger(null, [], options.terminal ?? process.stdout), failed = false;
  const secrets = [];
  const save = async () => {
    if (!job) return;
    const file = path.join(job, 'result.json');
    await writeFile(`${file}.tmp`, JSON.stringify(result, null, 2) + '\n');
    await rename(`${file}.tmp`, file);
  };
  const stage = async name => {
    controller.signal.throwIfAborted(); result.stage = name;
    log.message(`[${buildId}] ${name}`); await save();
  };
  try {
    // Create metadata before source/signing validation so ordinary failures remain inspectable.
    await disjointPaths([settings.source, settings.output, settings.cache, settings.work]);
    await writable(settings.output);
    job = path.join(settings.output, buildId);
    await mkdir(job);
    await writeFile(path.join(job, 'build.log'), '');
    log = logger(path.join(job, 'build.log'), secrets, options.terminal ?? process.stdout);
    await save();
    controller.signal.throwIfAborted();
    const timeout = integer(env.BUILDAPK_TIMEOUT_SECONDS, 3600, 'BUILDAPK_TIMEOUT_SECONDS');
    const workers = integer(env.BUILDAPK_GRADLE_WORKERS, 2, 'BUILDAPK_GRADLE_WORKERS', 1, 32);
    const heap = integer(env.BUILDAPK_GRADLE_HEAP_MB, 2048, 'BUILDAPK_GRADLE_HEAP_MB', 256, 65536);
    timer = setTimeout(() => controller.abort(new Error(`Build exceeded ${timeout} seconds.`)), timeout * 1000);
    // Install the redactor before any child process runs, including keystore validation.
    const signing = await signingInputs(env, secrets);
    const sourcePath = await realpath(settings.source);
    for (const file of [signing.store, signing.storePassword, signing.keyPassword]) {
      const relative = path.relative(sourcePath, await realpath(file));
      if (!relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) throw new Error('Signing material must be outside project source; mount it separately under /secrets.');
    }
    for (const directory of [settings.cache, settings.work]) await writable(directory);
    await disjointPaths([settings.source, settings.output, settings.cache, settings.work]);
    const project = await validateProject(settings.source, settings.mode, toolchain);
    result.mode = project.mode;
    const childEnv = { ...childEnvironment(env, settings.cache), CMAKE_BUILD_PARALLEL_LEVEL: String(workers) };
    const exec = (cmd, args, extra = {}) => run(cmd, args, { cwd: working, env: childEnv, signal: controller.signal, log, ...extra });
    const installed = await checkTools(exec, env);
    log.message(`Installed Android components: ${JSON.stringify(installed)}`);
    const certificate = await exec('keytool', ['-exportcert', '-rfc', '-keystore', signing.store, '-alias', signing.alias, '-storepass:file', signing.storePassword], { capture: 'stdout' });
    const expectedFingerprint = new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase();

    await stage('copy');
    working = await mkdtemp(path.join(settings.work, 'buildapk-'));
    await copySource(settings.source, working, controller.signal);
    const lockHash = await hash(path.join(working, 'package-lock.json'));
    await stage('dependencies');
    await exec('npm', ['ci', '--include=dev', '--no-audit', '--no-fund']);
    // npm ci validates the whole graph; explicitly check installed baseline packages too.
    for (const [name, expected] of Object.entries({ react: toolchain.react, 'react-native': toolchain.reactNative, ...(project.manifest.dependencies?.expo || project.manifest.devDependencies?.expo ? { expo: toolchain.expo } : {}) })) {
      if ((await json(path.join(working, 'node_modules', name, 'package.json'))).version !== expected) throw new Error(`Installed ${name} differs from the pinned baseline.`);
    }
    await stage('native');
    if (project.mode === 'expo') {
      const before = await json(path.join(working, 'package.json'));
      await exec('node', [path.join(working, 'node_modules/expo/bin/cli'), 'prebuild', '--platform', 'android', '--no-install', '--template', path.join(engineRoot, 'expo-template.tgz')]);
      const after = await json(path.join(working, 'package.json'));
      for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const normalized = object => JSON.stringify(Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b)));
        if (normalized(before[key]) !== normalized(after[key])) throw new Error('Expo prebuild changed dependency requirements. Prebuild and reconcile/relock your source project before submitting it.');
      }
    }
    if (await hash(path.join(working, 'package-lock.json')) !== lockHash) throw new Error('Build tooling changed package-lock.json. Reconcile and relock the source project.');
    await validateNative(working);
    const wrapper = path.join(working, 'android', 'gradlew');
    await writeFile(wrapper, (await readFile(wrapper, 'utf8')).replaceAll('\r\n', '\n'));
    await chmod(wrapper, 0o755);
    const wrapperProperties = await readFile(path.join(working, 'android/gradle/wrapper/gradle-wrapper.properties'), 'utf8');
    if (!wrapperProperties.includes(`gradle-${toolchain.gradle}-bin.zip`)) throw new Error(`Only the pinned Gradle ${toolchain.gradle} wrapper is supported.`);
    await stage('compile');
    await exec(wrapper, [':app:assembleRelease', '--no-daemon', '--build-cache', '--console=plain', `--max-workers=${workers}`, `-Dorg.gradle.jvmargs=-Xmx${heap}m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8`, '-Dorg.gradle.parallel=false', '-Pkotlin.compiler.execution.strategy=in-process', '--init-script', path.join(engineRoot, 'scripts/release.gradle')], { cwd: path.join(working, 'android') });
    const apk = await selectApk(path.join(working, 'android/app/build/outputs/apk'));
    await stage('sign');
    const aligned = path.join(working, 'aligned.apk'), signed = path.join(working, 'signed.apk');
    await exec('zipalign', ['-P', '16', '-f', '4', apk, aligned]);
    await exec('apksigner', ['sign', '--ks', signing.store, '--ks-key-alias', signing.alias, '--ks-pass', `file:${signing.storePassword}`, '--key-pass', `file:${signing.keyPassword}`, '--out', signed, aligned]);
    await stage('verify');
    const verification = await exec('apksigner', ['verify', '--verbose', '--print-certs', signed], { capture: 'stdout' });
    const fingerprints = [...verification.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([\da-f]+)$/gim)].map(m => m[1].toLowerCase());
    if (fingerprints.length !== 1 || fingerprints[0] !== expectedFingerprint) throw new Error('Final APK signing certificate does not match the requested keystore identity.');
    await exec('zipalign', ['-c', '-P', '16', '4', signed]);
    const badging = await exec('aapt', ['dump', 'badging', signed], { capture: 'stdout' });
    if (/application-debuggable/.test(badging)) throw new Error('Refusing to publish a debuggable APK.');
    // Verify this baseline's bundled JS, without buffering the APK contents.
    await exec('unzip', ['-t', signed, 'assets/index.android.bundle']);
    const abis = /native-code:\s*(.*)/.exec(badging)?.[1].match(/'([^']+)'/g)?.map(s => s.slice(1, -1)) ?? [];
    result.artifact = { path: 'app-release.apk', bytes: (await stat(signed)).size, sha256: await hash(signed), abis };
    result.signingCertificateSha256 = expectedFingerprint;
    await stage('publish');
    const temp = path.join(job, '.app-release.apk.tmp');
    await copyFile(signed, temp);
    controller.signal.throwIfAborted();
    await rename(temp, path.join(job, 'app-release.apk'));
  } catch (error) {
    failed = true;
    result.status = controller.signal.aborted ? 'cancelled' : 'failed';
    result.error = { stage: result.stage, message: sanitize(error.message, secrets), childExitCode: error.exitCode ?? null };
    result.artifact = null; result.signingCertificateSha256 = null;
    log.message(result.error.message);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', forwardAbort);
    try { if (working) await rm(working, { recursive: true, force: true }); }
    catch (error) {
      failed = true; result.status = 'failed'; result.artifact = null; result.signingCertificateSha256 = null;
      result.error = { stage: 'cleanup', message: sanitize(`Working directory cleanup failed: ${error.message}`, secrets), childExitCode: null };
      log.message(result.error.message);
    }
    if (failed && job) {
      await rm(path.join(job, 'app-release.apk'), { force: true });
      await rm(path.join(job, '.app-release.apk.tmp'), { force: true });
    }
    if (!failed) { result.status = 'succeeded'; result.stage = 'complete'; }
    result.finishedAt = new Date().toISOString(); result.durationMs = Date.now() - started;
    await save();
  }
  log.message(`Build ${buildId}: ${result.status}${job ? ` (${job})` : ''}`);
  return result;
}
