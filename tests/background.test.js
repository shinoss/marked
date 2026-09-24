import { test } from 'node:test';
import assert from 'node:assert/strict';

let menu, onClick, onAction;
const opened = [], focused = [];
let tabs = [];
globalThis.browser = {
  contextMenus: {
    removeAll: async () => {},
    create: details => { menu = details; },
    onClicked: { addListener: listener => { onClick = listener; } }
  },
  runtime: { getURL: path => `moz-extension://marked/${path}` },
  storage: { session: { get: async () => ({}) } },
  tabs: {
    create: async details => { opened.push(details); },
    query: async () => tabs,
    update: async (id, details) => { focused.push({ tab: id, ...details }); }
  },
  windows: { update: async (id, details) => { focused.push({ window: id, ...details }); } },
  action: { onClicked: { addListener: listener => { onAction = listener; } } }
};
await import('../background.js');

test('context menu opens a prefilled editor for the page, not the clicked link', async () => {
  assert.equal(menu.title, 'Add to Marked');
  await onClick({ menuItemId: 'add-to-marked', pageUrl: 'https://example.com/', linkUrl: 'https://other.test/' }, { url: 'https://example.com/?a=1&b=2', title: 'A & B' });
  const request = new URL(opened[0].url);
  assert.equal(request.searchParams.get('add'), 'https://example.com/?a=1&b=2');
  assert.equal(request.searchParams.get('title'), 'A & B');
  await onClick({ menuItemId: 'other' }, {});
  assert.equal(opened.length, 1);
});

test('toolbar button focuses an open manager tab instead of opening another', async () => {
  opened.length = 0;
  tabs = [{ id: 1, windowId: 5, url: 'https://example.com/' }, { id: 7, windowId: 3, url: 'moz-extension://marked/manager.html' }];
  await onAction();
  assert.deepEqual(focused, [{ tab: 7, active: true }, { window: 3, focused: true }]);
  assert.equal(opened.length, 0);
  tabs = [];
  await onAction();
  assert.deepEqual(opened, [{ url: 'moz-extension://marked/manager.html' }]);
});

test('saves the page abstract with the capture only while the tab still shows that page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  opened.length = 0;
  const saved = {};
  browser.storage.session.set = async value => Object.assign(saved, value);
  browser.storage.session.remove = async () => {};
  let injected;
  browser.scripting = { executeScript: async details => { injected = details; return [{ result: { url: 'https://example.com/post', text: '  A post about   world models. ' } }]; } };
  const tab = { id: 4, url: 'https://example.com/post', title: 'Post' };
  await onClick({ menuItemId: 'add-to-marked' }, tab);
  assert.deepEqual(injected.target, { tabId: 4 });
  assert.equal(injected.func.name, 'readPageAbstract');
  const key = new URL(opened[0].url).searchParams.get('capture');
  assert.match(key, /^capture-/);
  assert.deepEqual({ ...saved[key], createdAt: 0 }, { url: 'https://example.com/post', abstract: 'A post about world models.', createdAt: 0 });
  browser.scripting.executeScript = async () => [{ result: { url: 'https://example.com/next', text: 'A different page' } }];
  await onClick({ menuItemId: 'add-to-marked' }, tab);
  browser.scripting.executeScript = async () => { throw new Error('Cannot access this page'); };
  await onClick({ menuItemId: 'add-to-marked' }, tab);
  assert.equal(opened.length, 3, 'the editor still opens without an abstract');
  assert.equal(new URL(opened[1].url).searchParams.get('capture'), null);
  assert.equal(new URL(opened[2].url).searchParams.get('capture'), null);
});
