import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const exists = path => access(new URL(`../${path}`, import.meta.url));

test('one manifest runs in both Chrome and Firefox', async () => {
  // Chrome 121+ ignores background.scripts; Firefox 121+ ignores service_worker.
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  assert.equal(manifest.background.type, 'module');
  await exists(manifest.background.service_worker);
  // Chrome only knows contextMenus; Firefox accepts it as an alias of menus.
  assert.ok(manifest.permissions.includes('contextMenus'));
  assert.ok(!manifest.permissions.includes('menus'));
  // Promise-based contextMenus.removeAll requires Chrome 123.
  assert.ok(Number(manifest.minimum_chrome_version) >= 123);
  assert.equal(manifest.browser_specific_settings.gecko.id, 'marked@local.extension');
});

test('extension and toolbar icons are PNG files, which Chrome requires', async () => {
  const icons = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  assert.ok(icons.length);
  for (const icon of icons) {
    assert.match(icon, /\.png$/);
    await exists(icon);
  }
});

// The highlighter saves pages from a click in the page, not in Marked's own UI, so
// activeTab does not apply; capturing a preview then needs <all_urls>.
test('page capture uses scripting with activeTab or, for the highlighter, <all_urls>', () => {
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.deepEqual(manifest.host_permissions, ['<all_urls>']);
});

test('the tweet content script runs only in the top frame of x.com and twitter.com', async () => {
  const script = manifest.content_scripts.find(entry => entry.js.includes('tweet-capture.js'));
  assert.deepEqual(script.matches, ['https://x.com/*', 'https://twitter.com/*']);
  assert.deepEqual(script.js, ['tweet-capture.js']);
  assert.equal(script.run_at, 'document_idle');
  assert.equal(script.all_frames, false);
  await exists(script.js[0]);
});

test('the highlighter runs in the top frame of every web page', async () => {
  const script = manifest.content_scripts.find(entry => entry.js.includes('highlighter.js'));
  assert.deepEqual(script.matches, ['http://*/*', 'https://*/*']);
  assert.equal(script.all_frames, false);
  await exists('highlighter.js');
});

test('mk searches Marked from the address bar, and Alt+Shift+M adds the page, with no new permissions', () => {
  assert.deepEqual(manifest.omnibox, { keyword: 'mk' });
  assert.equal(manifest.commands['add-to-marked'].suggested_key.default, 'Alt+Shift+M');
  assert.deepEqual(manifest.permissions, ['bookmarks', 'storage', 'unlimitedStorage', 'contextMenus', 'activeTab', 'scripting']);
});

// Marked's pages download bookmarked pages to read their text, so they may
// connect to any site; scripts and images still come only from Marked itself.
test('Marked’s pages may download web pages, but load scripts and images only from the extension', async () => {
  const policy = Object.fromEntries(manifest.content_security_policy.extension_pages.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(policy['connect-src'], ["'self'", 'https:', 'http:']);
  assert.deepEqual(policy['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(policy['img-src'], ["'self'", 'data:']);
  assert.deepEqual(policy['object-src'], ["'none'"]);
});
