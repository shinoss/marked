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

test('page capture needs only activeTab and scripting, not access to every site', () => {
  assert.ok(manifest.permissions.includes('activeTab'));
  assert.ok(manifest.permissions.includes('scripting'));
  assert.equal(manifest.host_permissions, undefined);
});
