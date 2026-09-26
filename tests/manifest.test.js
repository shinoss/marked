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

// Firefox shows required data types at install. Gallery posts load from X
// (each saved post's ID) without asking. Hacker News and GitHub cards come from
// the sites' APIs only when a page is saved or its text downloaded, never while
// browsing. Semantic search, which sends the query and each bookmark's title,
// abstract, and (if allowed) notes and highlights to TypeSafe, is opt-in, so
// its types are optional.
test('Firefox is told what data leaves the device', () => {
  const data = manifest.browser_specific_settings.gecko.data_collection_permissions;
  assert.deepEqual(data, { required: ['bookmarksInfo'], optional: ['searchTerms', 'websiteContent'] });
  assert.ok(!data.required.includes('none'));
  assert.ok(data.optional.every(type => !data.required.includes(type)));
  // Built-in data consent needs Firefox 140; Marked needs 142 anyway.
  assert.ok(Number.parseFloat(manifest.browser_specific_settings.gecko.strict_min_version) >= 140);
});

test('extension and toolbar icons are PNG files, which Chrome requires', async () => {
  const icons = [...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)];
  assert.ok(icons.length);
  for (const icon of icons) {
    assert.match(icon, /\.png$/);
    await exists(icon);
  }
});

// Nothing asks for the pages you visit at install: access to all sites is
// optional, asked for in Marked's own page, and the page scripts are registered
// only once it's granted (background.js). Until then, activeTab lets the
// button, the menu, and the shortcuts read the tab they were used on. The
// highlighter saves pages from a click in the page, where activeTab does not
// apply; capturing a preview there uses the granted <all_urls>.
test('access to the pages you visit is optional, and nothing runs in pages until it is granted', async () => {
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);
  // Declared content scripts would ask for their sites at install.
  assert.equal(manifest.content_scripts, undefined);
  await exists('highlighter.js');
  await exists('tweet-capture.js');
});

test('mk searches Marked from the address bar, and Alt+Shift+M adds the page, with no new permissions', () => {
  assert.deepEqual(manifest.omnibox, { keyword: 'mk' });
  assert.equal(manifest.commands['add-to-marked'].suggested_key.default, 'Alt+Shift+M');
  assert.deepEqual(manifest.permissions, ['bookmarks', 'storage', 'unlimitedStorage', 'contextMenus', 'activeTab', 'scripting']);
});

// Marked's pages download bookmarked pages to read their text, so they may
// connect to any site, over https only; scripts and images still come only from Marked itself.
test('Marked’s pages may download web pages over https, but load scripts and images only from the extension', async () => {
  const policy = Object.fromEntries(manifest.content_security_policy.extension_pages.split(';').map(part => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(policy['connect-src'], ["'self'", 'https:']);
  assert.deepEqual(policy['script-src'], ["'self'", "'wasm-unsafe-eval'"]);
  assert.deepEqual(policy['img-src'], ["'self'", 'data:']);
  assert.deepEqual(policy['object-src'], ["'none'"]);
});
