import { constants } from 'node:fs';
import { access, readdir, readFile, lstat, mkdir, copyFile, chmod, realpath } from 'node:fs/promises';
import path from 'node:path';

export async function exists(file) {
  try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
export const json = async file => JSON.parse(await readFile(file, 'utf8'));

export function selectMode(requested, hasAndroid, hasExpo) {
  if (!['auto', 'native', 'expo'].includes(requested)) throw new Error('Mode must be auto, native, or expo.');
  if (requested === 'expo' && hasAndroid) throw new Error('Expo mode requires no android/ directory. Use native mode to preserve native customizations.');
  if (requested === 'native' && !hasAndroid) throw new Error('Native mode requires a complete android/ project.');
  if (hasAndroid) return 'native';
  if (!hasExpo) throw new Error('React Native without android/ is unsupported. Supply the native project or a supported Expo app.');
  return 'expo';
}

export async function validateProject(source, mode, baseline) {
  const manifest = await json(path.join(source, 'package.json'));
  const lock = await json(path.join(source, 'package-lock.json')).catch(() => { throw new Error('A valid package-lock.json is required. Run npm install in the source project and commit its lockfile.'); });
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) throw new Error('Use an npm lockfileVersion 2 or 3 lockfile.');
  const names = await readdir(source);
  if (manifest.workspaces || (manifest.packageManager && !manifest.packageManager.startsWith('npm@')) || names.some(n => ['yarn.lock', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'bun.lock', 'bun.lockb', 'lerna.json', 'npm-shrinkwrap.json'].includes(n))) {
    throw new Error('Only a single npm project is supported; remove competing lockfiles or export a standalone npm project without workspaces.');
  }
  if (Object.values(lock.packages).some(p => p.link || /^(file:|link:|workspace:)/.test(p.resolved ?? ''))) throw new Error('Local linked dependencies and monorepos are unsupported; use registry dependencies.');
  const dependencies = { ...manifest.devDependencies, ...manifest.dependencies };
  for (const [name, version] of Object.entries({ react: baseline.react, 'react-native': baseline.reactNative, ...(dependencies.expo ? { expo: baseline.expo } : {}) })) {
    if (!dependencies[name] || lock.packages[`node_modules/${name}`]?.version !== version) throw new Error(`Unsupported baseline: ${name} must resolve to ${version} in package-lock.json.`);
  }
  const selected = selectMode(mode, await exists(path.join(source, 'android')), Boolean(dependencies.expo));
  if (selected === 'native') await validateNative(source);
  return { manifest, mode: selected };
}

export async function validateNative(source) {
  for (const file of ['android/gradlew', 'android/gradle/wrapper/gradle-wrapper.jar', 'android/gradle/wrapper/gradle-wrapper.properties', 'android/app/src/main/AndroidManifest.xml']) {
    await access(path.join(source, file), constants.R_OK).catch(() => { throw new Error(`Incomplete Android project: missing ${file}.`); });
  }
  for (const choices of [['android/settings.gradle', 'android/settings.gradle.kts'], ['android/app/build.gradle', 'android/app/build.gradle.kts']]) {
    if (!(await Promise.all(choices.map(f => exists(path.join(source, f))))).some(Boolean)) throw new Error(`Incomplete Android project: expected ${choices.join(' or ')}.`);
  }
}

export function excluded(relative, directory) {
  const parts = relative.split(/[\\/]/), name = parts.at(-1);
  if (parts.some(p => ['.git', 'node_modules', '.gradle', '.expo', '.cxx', '.kotlin', '.idea', '.vscode', 'secrets', '.cache', '.ssh'].includes(p))) return true;
  if (['.env', '.npmrc', 'local.properties', '.DS_Store', 'Thumbs.db', 'id_rsa', 'id_ed25519'].includes(name) || name.startsWith('.env.')) return true;
  if (/\.(apk|aab|jks|keystore|pem|key|p12|pfx|p8|log)$/i.test(name)) return true;
  if (parts.length === 1 && ['output', 'outputs', 'cache', 'work', 'coverage', 'dist'].includes(name)) return true;
  return directory && parts[0] === 'android' && name === 'build';
}

export async function copySource(source, target, signal, prefix = '') {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    signal?.throwIfAborted();
    const relative = path.join(prefix, entry.name);
    if (excluded(relative, entry.isDirectory())) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Source symlinks are unsupported: ${relative}. Export a standalone project with regular files.`);
    if (entry.isDirectory()) await copySource(from, to, signal, relative);
    else if (entry.isFile()) { await copyFile(from, to); await chmod(to, (await lstat(from)).mode & 0o777); }
    else throw new Error(`Unsupported source file: ${relative}`);
  }
}

export async function selectApk(root) {
  const found = [];
  async function visit(dir) {
    if (!await exists(dir)) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name.endsWith('.apk')) found.push(file);
    }
  }
  await visit(root);
  if (found.length !== 1) throw new Error(`Expected exactly one release APK, found ${found.length}. Product flavors and ABI splits are unsupported.`);
  return found[0];
}

export async function disjointPaths(paths) {
  const resolved = await Promise.all(paths.map(p => realpath(p)));
  for (let i = 0; i < resolved.length; i++) for (let j = i + 1; j < resolved.length; j++) {
    const relative = path.relative(resolved[i], resolved[j]);
    const reverse = path.relative(resolved[j], resolved[i]);
    const inside = r => r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r));
    if (inside(relative) || inside(reverse)) throw new Error('Source, output, cache, and work must be separate, non-nested directories.');
  }
}
