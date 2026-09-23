import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';

export async function prompt(question, { secret = false, signal } = {}) {
  signal?.throwIfAborted();
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Signing setup needs an interactive terminal. Run buildapk setup from your app folder first.');
  if (!secret) {
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    reader.on('SIGINT', () => process.emit('SIGINT'));
    try { return (await reader.question(question, { signal })).trim(); }
    finally { reader.close(); }
  }
  process.stdout.write(question);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '', finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      process.stdin.off('keypress', keypress);
      signal?.removeEventListener('abort', abort);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(signal.reason);
    const keypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') { process.emit('SIGINT'); return finish(new Error('Signing setup cancelled.')); }
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (!key.ctrl && !key.meta && text && !/[\x00-\x1f\x7f]/.test(text)) value += text;
    };
    process.stdin.on('keypress', keypress);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
