import { test } from 'node:test';
import assert from 'node:assert/strict';

test('uses the chrome namespace as browser when browser is missing (older Chrome)', async () => {
  const chrome = { runtime: { id: 'chrome' } };
  delete globalThis.browser;
  globalThis.chrome = chrome;
  await import('../browser-api.js?chrome');
  assert.equal(globalThis.browser, chrome);
});

test('keeps a native browser namespace (Firefox, newer Chrome)', async () => {
  const native = { runtime: { id: 'native' } };
  globalThis.browser = native;
  globalThis.chrome = { runtime: { id: 'chrome' } };
  await import('../browser-api.js?native');
  assert.equal(globalThis.browser, native);
});
