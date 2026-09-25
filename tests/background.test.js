import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

let onClick, onAction, onMessage, onTabUpdated, onStorageChanged, onOmniboxInput, onOmniboxEnter, onCommand;
const menus = [], opened = [], focused = [], badges = [], defaults = [];
let tabs = [];
globalThis.browser = {
  contextMenus: {
    removeAll: async () => {},
    create: details => { menus.push(details); },
    onClicked: { addListener: listener => { onClick = listener; } }
  },
  runtime: { getURL: path => `moz-extension://marked/${path}`, onMessage: { addListener: listener => { onMessage = listener; } } },
  storage: { session: { get: async () => ({}) }, onChanged: { addListener: listener => { onStorageChanged = listener; } } },
  tabs: {
    create: async details => { opened.push(details); },
    query: async () => tabs,
    update: async (id, details) => { focused.push(typeof id === 'object' ? { tab: 'current', ...id } : { tab: id, ...details }); },
    onUpdated: { addListener: listener => { onTabUpdated = listener; } }
  },
  windows: { update: async (id, details) => { focused.push({ window: id, ...details }); } },
  action: {
    onClicked: { addListener: listener => { onAction = listener; } },
    setBadgeBackgroundColor: async () => {},
    setBadgeText: async details => { badges.push(details); },
    setTitle: async () => {}
  },
  omnibox: {
    setDefaultSuggestion: details => { defaults.push(details.description); },
    onInputChanged: { addListener: listener => { onOmniboxInput = listener; } },
    onInputEntered: { addListener: listener => { onOmniboxEnter = listener; } }
  },
  commands: { onCommand: { addListener: listener => { onCommand = listener; } } }
};
await import('../background.js');
// A saved library, with its index, as the store writes it.
async function useLibrary(children) {
  const { fixture } = await import('./storage-fixture.js');
  const { createLibraryStore } = await import('../store.js');
  const mock = fixture({ id: 'root', children: [] });
  browser.storage.local = mock.api.storage.local;
  Object.defineProperty(navigator, 'locks', { value: mock.locks, configurable: true });
  const store = createLibraryStore(mock.api, mock.locks);
  for (const node of children) await store.create({ parentId: 'root', ...node });
  return mock;
}

test('context menu opens a prefilled editor for the page, not the clicked link', async () => {
  assert.equal(menus[0].title, 'Add to Marked');
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
  const injected = [];
  browser.scripting = { executeScript: async details => { injected.push(details); return [{ result: details.func?.name === 'readPageAbstract' ? { url: 'https://example.com/post', text: '  A post about   world models. ' } : null }]; } };
  const tab = { id: 4, url: 'https://example.com/post', title: 'Post' };
  await onClick({ menuItemId: 'add-to-marked' }, tab);
  assert.deepEqual(injected.map(details => [details.target.tabId, details.func?.name ?? details.files.join()]), [[4, 'readPageAbstract'], [4, 'readPageIcon'], [4, 'vendor/readability.js,vendor/readability-readerable.js'], [4, 'readPageText']], 'the page reads its abstract, its icon, and its text');
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

test('the capture carries the page’s own icon, and skips anything that isn’t a small image', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  opened.length = 0;
  const saved = {};
  browser.storage.session.set = async value => Object.assign(saved, value);
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  let reported = icon;
  browser.scripting = { executeScript: async details => [{ result: details.func.name === 'readPageIcon' ? reported : null }] };
  await onClick({ menuItemId: 'add-to-marked' }, { id: 4, url: 'https://example.com/icon', title: 'Icon' });
  assert.equal(saved[new URL(opened[0].url).searchParams.get('capture')].icon, icon);
  reported = 'data:text/html;base64,PGI+';
  await onClick({ menuItemId: 'add-to-marked' }, { id: 4, url: 'https://example.com/other', title: 'Other' });
  assert.equal(new URL(opened[1].url).searchParams.get('capture'), null, 'anything but a small image is ignored, so nothing is handed over');
});

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const jack = { url: 'https://x.com/jack/status/20', author: 'jack', handle: 'jack', text: ' just setting up\nmy  twttr ' };
const saveTweet = tab => onClick({ menuItemId: 'save-tweet-to-marked', pageUrl: 'https://x.com/home' }, tab);

test('Save tweet to Marked is offered only where its content script runs', () => {
  const item = menus.find(menu => menu.id === 'save-tweet-to-marked');
  assert.equal(item.title, 'Save tweet to Marked');
  assert.deepEqual(item.contexts, ['page', 'link', 'image', 'video', 'selection']);
  assert.deepEqual(item.documentUrlPatterns, manifest.content_scripts[0].matches);
});

test('Save tweet to Marked opens the editor with the tweet under the pointer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  opened.length = 0;
  const saved = {}, sent = [];
  browser.storage.session.set = async value => Object.assign(saved, value);
  browser.storage.session.remove = async () => {};
  browser.tabs.sendMessage = async (...args) => { sent.push(args); return jack; };
  await saveTweet({ id: 9, url: 'https://x.com/home', title: 'Home / X' });
  assert.deepEqual(sent, [[9, { type: 'marked:tweet-under-pointer' }, { frameId: 0 }]]);
  const request = new URL(opened[0].url);
  assert.equal(request.searchParams.get('add'), 'https://x.com/jack/status/20');
  assert.equal(request.searchParams.get('title'), 'jack (@jack) on X: “just setting up my twttr”');
  const key = request.searchParams.get('capture');
  assert.deepEqual({ ...saved[key], createdAt: 0 }, { url: 'https://x.com/jack/status/20', abstract: 'just setting up my twttr', createdAt: 0 });
});

test('tweet titles clip long text and fall back when the name or text is missing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  browser.storage.session.set = async () => {};
  const open = async reply => {
    opened.length = 0;
    browser.tabs.sendMessage = async () => ({ url: 'https://x.com/ada/status/1', ...reply });
    await saveTweet({ id: 9 });
    return new URL(opened[0].url).searchParams;
  };
  // 100 characters end inside the 17th word, so the title ends after the 16th.
  const words = Array(16).fill('words').join(' ');
  assert.equal((await open({ author: 'Ada', handle: 'ada', text: 'words '.repeat(30) })).get('title'), `Ada (@ada) on X: “${words}…”`);
  assert.equal((await open({ author: 'Ada', handle: 'ada', text: '👍🏽'.repeat(150) })).get('title'), `Ada (@ada) on X: “${'👍🏽'.repeat(100)}…”`);
  assert.equal((await open({ handle: 'ada', text: 'Hi' })).get('title'), '@ada on X: “Hi”');
  const untitled = await open({ author: 'Ada', handle: 'ada', text: '' });
  assert.equal(untitled.get('title'), 'Ada (@ada) on X');
  assert.equal(untitled.get('capture'), null, 'nothing to hand over without text');
});

test('Save tweet to Marked opens nothing when no tweet was under the pointer', async () => {
  opened.length = 0;
  let injected;
  browser.scripting = { executeScript: async details => { injected = details; } };
  browser.tabs.sendMessage = async () => null;
  await saveTweet({ id: 9 });
  // The reply comes from the page's process, so its URL is checked as well.
  browser.tabs.sendMessage = async () => ({ ...jack, url: 'https://example.com/jack/status/20' });
  await saveTweet({ id: 9 });
  assert.equal(opened.length, 0);
  assert.equal(injected, undefined, 'the content script shows its own notice');
});

test('without its content script, Save tweet to Marked adds it and asks for another right-click', async t => {
  t.mock.method(console, 'warn', () => {});
  opened.length = 0;
  const injected = [];
  browser.scripting = { executeScript: async details => { injected.push(details); return []; } };
  browser.tabs.sendMessage = async () => { throw new Error('Could not establish connection. Receiving end does not exist.'); };
  await saveTweet({ id: 9 });
  assert.equal(opened.length, 0);
  assert.deepEqual(injected.map(details => details.target), [{ tabId: 9 }, { tabId: 9 }]);
  assert.deepEqual(injected[0].files, ['tweet-capture.js'], 'the content script is added for the next right-click');
  // executeScript serializes func, so it must work on its own in the page.
  const { window } = new JSDOM('<body></body>', { runScripts: 'outside-only' });
  const attachShadow = window.Element.prototype.attachShadow;
  let shadow;
  window.Element.prototype.attachShadow = function (init) { return shadow = attachShadow.call(this, init); };
  window.setTimeout = () => {};
  window.eval(`(${injected[1].func})(...${JSON.stringify(injected[1].args)})`);
  assert.match(shadow.querySelector('[role="status"]').textContent, /^Marked is ready on this page now\. Right-click the tweet again/);
});

test('in Firefox, Save tweet to Marked asks for access to X while the click counts as user input', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested = [];
  browser.permissions = { request: details => { requested.push(details); return Promise.resolve(true); } };
  browser.storage.session.set = async () => {};
  browser.tabs.sendMessage = async () => jack;
  await saveTweet({ id: 9 });
  assert.deepEqual(requested, [], 'Chrome grants content-script sites at install');
  browser.runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
  try {
    // The request must start synchronously in the click handler, before any await.
    const pending = saveTweet({ id: 9 });
    assert.deepEqual(requested, [{ origins: ['https://x.com/*', 'https://twitter.com/*'] }]);
    await pending;
  } finally { delete browser.runtime.getBrowserInfo; }
});

const ask = (message, tab) => new Promise(resolve => { assert.equal(onMessage(message, { tab }, resolve), true); });

test('a highlight on a saved page is answered with its title, and the page saves it to that bookmark', async t => {
  const { fixture } = await import('./storage-fixture.js');
  const mock = fixture({ id: 'root', children: [] });
  await mock.api.storage.local.set({ markedLibraryV1: { version: 1, root: { id: 'root', children: [
    { id: 'old', parentId: 'root', title: 'Old copy', url: 'https://example.com/article', dateAdded: 1 },
    { id: 'folder', parentId: 'root', title: 'Folder', children: [{ id: 'new', parentId: 'folder', title: 'The essay', url: 'https://example.com/article#intro', dateAdded: 2 }] }
  ] } } });
  browser.storage.local = mock.api.storage.local;
  Object.defineProperty(navigator, 'locks', { value: mock.locks, configurable: true });
  opened.length = 0;
  const tab = { id: 3, url: 'https://example.com/article#part-2', title: 'Article' };
  assert.deepEqual(await ask({ type: 'marked:highlight', text: '  A  passage ' }, tab), { saved: 'The essay' }, 'the newest bookmark of the page, ignoring #fragments');
  assert.equal(opened.length, 0, 'the page shows its own panel');
  assert.deepEqual(await ask({ type: 'marked:save-highlight', text: ' A  passage ', note: ' Why ' }, tab), { ok: true });
  const root = (await mock.api.storage.local.get()).markedLibraryV1.root;
  const [highlight] = root.children[1].children[0].highlights;
  assert.deepEqual({ text: highlight.text, note: highlight.note }, { text: 'A passage', note: 'Why' });
  assert.deepEqual(await ask({ type: 'marked:save-highlight', text: 'X' }, { id: 4, url: 'https://other.test/' }), { error: 'This page is no longer in Marked.' });
});

test('a highlight on a new page opens the editor with the passage, as Add to Marked does', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const saved = {};
  opened.length = 0;
  browser.storage.session.set = async value => Object.assign(saved, value);
  await useLibrary([]);
  browser.scripting = { executeScript: async details => [{ result: { url: 'https://example.org/new', text: details.func?.name === 'readPageText' ? 'The whole page.' : 'Page description.' } }] };
  assert.deepEqual(await ask({ type: 'marked:highlight', text: 'Quoted words' }, { id: 4, url: 'https://example.org/new', title: 'New page' }), { opened: true });
  const request = new URL(opened[0].url);
  assert.equal(request.searchParams.get('add'), 'https://example.org/new');
  assert.equal(request.searchParams.get('title'), 'New page');
  const { text, ...capture } = saved[request.searchParams.get('capture')];
  assert.deepEqual({ ...capture, createdAt: 0 }, { url: 'https://example.org/new', highlight: 'Quoted words', abstract: 'Page description.', createdAt: 0 });
  assert.deepEqual([text.text, text.words], ['The whole page.', 3], 'with the page’s text');
  assert.equal(await ask({ type: 'marked:highlight', text: '   ' }, { id: 4, url: 'https://example.org/new' }), null);
  assert.equal(onMessage({ type: 'other' }, { tab: { id: 4 } }, () => {}), undefined);
  assert.equal(opened.length, 1, 'empty selections and other messages open nothing');
});

test('the toolbar button shows a check on saved pages and updates when the library changes', async () => {
  await useLibrary([{ title: 'The essay', url: 'https://example.com/essay' }]);
  badges.length = 0;
  onTabUpdated(1, { url: 'https://example.com/essay#part-2' }, { id: 1, url: 'https://example.com/essay#part-2' });
  onTabUpdated(2, { status: 'complete' }, { id: 2, url: 'https://other.test/' });
  onTabUpdated(3, { title: 'Renamed' }, { id: 3, url: 'https://example.com/essay' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(badges.sort((a, b) => a.tabId - b.tabId), [{ tabId: 1, text: '✓' }, { tabId: 2, text: '' }], 'only address and load changes count');
  badges.length = 0;
  tabs = [{ id: 1, url: 'https://example.com/essay' }, { id: 4, url: 'about:blank' }];
  onStorageChanged({ markedIndexV1: {} }, 'local');
  onStorageChanged({ markedView: {} }, 'local');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(badges.sort((a, b) => a.tabId - b.tabId), [{ tabId: 1, text: '✓' }, { tabId: 4, text: '' }]);
  tabs = [];
});

test('a page asks for its saved highlights and gets only its own', async () => {
  await useLibrary([{ title: 'The essay', url: 'https://example.com/essay', highlights: [{ text: 'A passage', note: 'Why' }, { text: 'Another' }] }, { title: 'Plain', url: 'https://plain.test/' }]);
  const reply = await ask({ type: 'marked:page-highlights' }, { id: 1, url: 'https://example.com/essay#top' });
  assert.deepEqual(reply.highlights.map(({ text, note }) => ({ text, note })), [{ text: 'A passage', note: 'Why' }, { text: 'Another', note: undefined }]);
  assert.equal(await ask({ type: 'marked:page-highlights' }, { id: 2, url: 'https://plain.test/' }), null);
  assert.equal(await ask({ type: 'marked:page-highlights' }, { id: 3, url: 'https://unsaved.test/' }), null);
});

test('typing mk in the address bar suggests saved pages; Enter opens one or searches Marked', async () => {
  await useLibrary([
    { title: 'Deep work <notes> & ideas', url: 'https://www.example.com/deep', dateAdded: 1000 },
    { title: 'Shallow work', url: 'https://work.test/', dateAdded: 2000 },
    { title: 'Recipes', url: 'https://food.test/work-lunch', dateAdded: 3000 }
  ]);
  const suggestions = await new Promise(resolve => onOmniboxInput(' work ', resolve));
  assert.deepEqual(suggestions, [
    { content: 'https://work.test/', description: 'Shallow work <dim>work.test</dim>' },
    { content: 'https://www.example.com/deep', description: 'Deep work &lt;notes&gt; &amp; ideas <dim>example.com</dim>' },
    { content: 'https://food.test/work-lunch', description: 'Recipes <dim>food.test</dim>' }
  ], 'title matches first, newest first, then address matches; Chrome markup is escaped');
  assert.equal(defaults.at(-1), 'Search Marked for “work”');
  opened.length = 0; focused.length = 0;
  onOmniboxEnter('https://work.test/', 'currentTab');
  onOmniboxEnter('deep ideas', 'newForegroundTab');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(focused, [{ tab: 'current', url: 'https://work.test/' }]);
  assert.deepEqual(opened, [{ url: 'moz-extension://marked/manager.html?q=deep+ideas', active: true }]);
});

test('the keyboard shortcut adds the page, or edits its bookmark when it is already saved', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = await useLibrary([{ title: 'Saved', url: 'https://example.com/saved' }]);
  const [saved] = (await mock.api.storage.local.get()).markedLibraryV1.root.children;
  browser.storage.session.set = async () => {};
  browser.scripting = { executeScript: async () => [] };
  opened.length = 0;
  await onCommand('add-to-marked', { id: 5, url: 'https://example.com/saved#intro', title: 'Saved' });
  await onCommand('add-to-marked', { id: 6, url: 'https://example.com/new', title: 'New' });
  await onCommand('other', { id: 6, url: 'https://example.com/new' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opened.length, 2);
  assert.equal(new URL(opened[0].url).searchParams.get('edit'), saved.id, 'a saved page opens its bookmark, not a second copy');
  assert.equal(new URL(opened[1].url).searchParams.get('add'), 'https://example.com/new');
});

test('a saved page gets its text when it next loads, once; never X posts or when turned off', async () => {
  const mock = await useLibrary([{ title: 'Essay', url: 'https://example.com/essay' }, { title: 'Post', url: 'https://x.com/jack/status/20' }]);
  const [essay] = (await mock.api.storage.local.get()).markedLibraryV1.root.children;
  const injected = [];
  browser.scripting = { executeScript: async details => { injected.push(details.files?.[0] ?? [details.func.name, details.args[1]]); return [{ result: details.func ? { url: 'https://example.com/essay#notes', text: 'Every word of the essay.' } : undefined }]; } };
  const loaded = async tab => { onTabUpdated(tab.id, { status: 'complete' }, tab); await new Promise(resolve => setTimeout(resolve, 30)); };
  const text = async () => (await mock.api.storage.local.get())[`markedText:${essay.id}`];
  await mock.api.storage.local.set({ markedPageText: { keep: false } });
  await loaded({ id: 1, url: 'https://example.com/essay#notes' });
  assert.equal(await text(), undefined, 'Settings can turn it off');
  await mock.api.storage.local.set({ markedPageText: { keep: true } });
  await loaded({ id: 1, url: 'https://example.com/essay#notes' });
  assert.deepEqual([(await text()).text, (await text()).via], ['Every word of the essay.', 'visit']);
  assert.deepEqual(injected.at(-1), ['readPageText', { articlesOnly: true }], 'only an article is kept by itself');
  injected.length = 0;
  await loaded({ id: 1, url: 'https://example.com/essay' });
  await loaded({ id: 2, url: 'https://x.com/jack/status/20' });
  await loaded({ id: 3, url: 'https://unsaved.test/' });
  assert.deepEqual(injected, [], 'once a page has its text, and never for X posts or unsaved pages');
});

test('Add to Marked on a saved page without its text keeps the text, then opens the bookmark', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = await useLibrary([{ title: 'Saved', url: 'https://example.com/saved' }]);
  const [saved] = (await mock.api.storage.local.get()).markedLibraryV1.root.children;
  browser.scripting = { executeScript: async details => [{ result: details.func?.name === 'readPageText' ? { url: 'https://example.com/saved', text: 'The saved page.' } : undefined }] };
  opened.length = 0;
  await onClick({ menuItemId: 'add-to-marked' }, { id: 5, url: 'https://example.com/saved', title: 'Saved' });
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(new URL(opened[0].url).searchParams.get('edit'), saved.id);
  assert.equal((await mock.api.storage.local.get())[`markedText:${saved.id}`].text, 'The saved page.');
});
