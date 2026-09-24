import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForWorker } from '../ai-loader.js';

test('waits for worker readiness rather than sending commands during module imports', async () => {
  const worker = new EventTarget();
  let ready = false;
  const pending = waitForWorker(worker).then(() => { ready = true; });
  worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'other' } }));
  await Promise.resolve();
  assert.equal(ready, false);
  worker.dispatchEvent(new MessageEvent('message', { data: { kind: 'marked-ready' } }));
  await pending;
  assert.equal(ready, true);
});
test('worker startup fails with a useful timeout or error instead of hanging', async () => {
  await assert.rejects(waitForWorker(new EventTarget(), 5), /did not start/);
  const worker = new EventTarget();
  const pending = waitForWorker(worker);
  const error = new Event('error');
  error.message = 'WASM blocked';
  worker.dispatchEvent(error);
  await assert.rejects(pending, /WASM blocked/);
});
