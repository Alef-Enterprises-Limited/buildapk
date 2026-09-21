#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { build, doctor, version } from './build.mjs';

const help = `BuildAPK ${version}
Usage:
  buildapk --help | --version
  buildapk doctor [--mounts] [--source PATH --output PATH --cache PATH --work PATH]
  buildapk build [--source /input --output /output --cache /cache --work /work --mode auto]

Modes: auto, native, expo. Source must be a standalone npm project with package-lock.json.
Signing: BUILDAPK_KEYSTORE_PATH, BUILDAPK_KEY_ALIAS,
         BUILDAPK_STORE_PASSWORD_FILE, BUILDAPK_KEY_PASSWORD_FILE.
Limits: BUILDAPK_TIMEOUT_SECONDS=3600, BUILDAPK_GRADLE_WORKERS=2,
        BUILDAPK_GRADLE_HEAP_MB=2048. See README for mount setup.
`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    help: { type: 'boolean' }, version: { type: 'boolean' }, mounts: { type: 'boolean' },
    source: { type: 'string' }, output: { type: 'string' }, cache: { type: 'string' }, work: { type: 'string' }, mode: { type: 'string' },
  } });
  if (values.help) console.log(help);
  else if (values.version) console.log(version);
  else if (positionals.length !== 1 || !['doctor', 'build'].includes(positionals[0])) throw new Error('Specify doctor or build. Use --help for usage.');
  else if (positionals[0] === 'doctor') await doctor(values);
  else {
    if (values.mounts) throw new Error('--mounts applies only to doctor.');
    const controller = new AbortController();
    const stop = signal => controller.abort(new Error(`Build cancelled by ${signal}.`));
    const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
    try {
      const result = await build({ ...values, signal: controller.signal });
      process.exitCode = result.status === 'succeeded' ? 0 : result.status === 'cancelled' ? 130 : 1;
    } finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); }
  }
} catch (error) { console.error(`BuildAPK: ${error.message}`); process.exitCode = 1; }
