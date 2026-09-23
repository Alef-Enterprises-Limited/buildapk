#!/usr/bin/env node
import { launch } from './host.mjs';

const controller = new AbortController();
const cancel = () => controller.abort(new Error('BuildAPK cancelled.'));
process.on('SIGINT', cancel);
process.on('SIGTERM', cancel);
try {
  await launch({ signal: controller.signal });
} catch (error) {
  console.error(`BuildAPK: ${error.message}`);
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  process.off('SIGINT', cancel);
  process.off('SIGTERM', cancel);
}
