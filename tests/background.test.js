import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

let onClick, onAction, onMessage, onTabUpdated, onTabRemoved, onStorageChanged, onOmniboxInput, onOmniboxEnter, onCommand, onInstalled, onPermissionAdded, onPermissionRemoved;
const menus = [], opened = [], focused = [], badges = [], defaults = [];
let tabs = [];
globalThis.browser = {
  contextMenus: {
    removeAll: async () => {},
    create: details => { menus.push(details); },
    onClicked: { addListener: listener => { onClick = listener; } }
  },
  runtime: { getURL: path => `moz-extension://marked/${path}`, onMessage: { addListener: listener => { onMessage = listener; } }, onInstalled: { addListener: listener => { onInstalled = listener; } } },
  // Access to the pages you visit is granted unless a test takes it back.
  permissions: { contains: async () => true, onAdded: { addListener: listener => { onPermissionAdded = listener; } }, onRemoved: { addListener: listener => { onPermissionRemoved = listener; } } },
  storage: { session: { get: async () => ({}) }, onChanged: { addListener: listener => { onStorageChanged = listener; } } },
  tabs: {
    create: async details => { opened.push(details); },
    query: async () => tabs,
    update: async (id, details) => { focused.push(typeof id === 'object' ? { tab: 'current', ...id } : { tab: id, ...details }); },
    onUpdated: { addListener: listener => { onTabUpdated = listener; } },
    onRemoved: { addListener: listener => { onTabRemoved = listener; } }
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
// Session storage, which outlasts a sleeping worker but not the browser.
function useSession() {
  const session = {};
  browser.storage.session.get = async key => key == null ? structuredClone(session) : Object.fromEntries([].concat(key).filter(name => name in session).map(name => [name, structuredClone(session[name])]));
  browser.storage.session.set = async value => { Object.assign(session, structuredClone(value)); };
  browser.storage.session.remove = async keys => { for (const key of [].concat(keys)) delete session[key]; };
  return session;
}
// Marked's panel on a page: panel.html, in the frame save-panel.js puts there.
const panelSender = (tab, kind = 'save') => ({ tab: typeof tab === 'object' ? tab : { id: tab }, url: `moz-extension://marked/panel.html#${kind}`, frameId: 1 });
// A page that shows Marked's panels. Injected functions answer from results,
// by name. save-panel.js answers marked:show-panel (kept in shown) once the
// panel in its frame has asked what to show (kept in panels); other messages
// to the page are kept in told.
function usePage(results = {}) {
  const page = { injected: [], shown: [], panels: [], told: [] };
  browser.scripting = { executeScript: async details => { page.injected.push(details.func?.name ?? details.files.join()); return [{ result: results[details.func?.name] ?? null }]; } };
  browser.tabs.sendMessage = async (tabId, message, options) => {
    if (message.type === 'marked:show-panel') {
      page.shown.push({ tabId, ...message });
      page.panels.push({ tabId, kind: message.kind, ...await askPanel({ type: 'marked:panel-data', kind: message.kind }, tabId, message.kind) });
      return true;
    }
    page.told.push([tabId, message, options]);
  };
  return page;
}
const ask = (message, tab) => new Promise(resolve => { assert.equal(onMessage(message, { tab }, resolve), true); });
const askPanel = (message, tab, kind) => new Promise(resolve => { assert.equal(onMessage(message, panelSender(tab, kind), resolve), true); });
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
const rootOf = async mock => (await mock.api.storage.local.get()).markedLibraryV1.root;

test('Add to Marked shows Marked’s panel on the page, for the page and not the clicked link', async () => {
  assert.equal(menus[0].title, 'Add to Marked');
  const mock = await useLibrary([{ title: 'Reading', type: 'folder' }]);
  const [reading] = (await rootOf(mock)).children;
  const session = useSession();
  const url = 'https://example.com/?a=1&b=2';
  const page = usePage({ readPageAbstract: { url, text: '  A post about   world models. ' } });
  opened.length = 0;
  await onClick({ menuItemId: 'add-to-marked', pageUrl: 'https://example.com/', linkUrl: 'https://other.test/' }, { id: 4, url, title: 'AI & world models' });
  assert.equal(opened.length, 0, 'the user stays on the page');
  assert.deepEqual(page.shown, [{ tabId: 4, type: 'marked:show-panel', kind: 'save' }], 'the page is told only to show the panel');
  const [panel] = page.panels;
  assert.deepEqual({ ...panel, token: typeof panel.token }, {
    tabId: 4, kind: 'save', token: 'string', edit: false, url, title: 'AI & world models',
    folders: [{ id: 'root', label: 'Library (top level)' }, { id: reading.id, label: '　Reading' }], folder: 'root',
    tags: ['Technology', 'AI', 'History', 'Fiction', 'Science', 'Business', 'Politics', 'Sports', 'Entertainment', 'Health', 'Culture'], chosen: ['AI'], note: '', abstract: 'A post about world models.', highlight: '', preview: false
  }, 'the tags its title suggests are chosen, as in the editor');
  assert.deepEqual(Object.keys(session), ['save:4']);
  await onClick({ menuItemId: 'other' }, {});
  assert.equal(page.panels.length, 1);
});

test('Save in the panel keeps what the user chose, with the page’s icon and text, which never go to the page', async () => {
  const mock = await useLibrary([{ title: 'Reading', type: 'folder' }]);
  const [reading] = (await rootOf(mock)).children;
  const session = useSession();
  const url = 'https://example.com/essay';
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  const page = usePage({ readPageAbstract: { url, text: 'An essay.' }, readPageIcon: icon, readPageText: { url, text: 'Every word of the essay.' } });
  const tab = { id: 4, url, title: 'The essay' };
  await onClick({ menuItemId: 'add-to-marked' }, tab);
  await flush();
  assert.deepEqual(page.injected, ['readPageAbstract', 'readPageIcon', 'save-panel.js', 'vendor/readability.js,vendor/readability-readerable.js', 'readPageText'], 'the text is read once the panel shows');
  const [{ token, ...panel }] = page.panels;
  assert.ok(!('text' in panel) && !('icon' in panel));
  assert.deepEqual([session['save:4'].icon, session['save:4'].text.text], [icon, 'Every word of the essay.'], 'they wait in Marked');
  // A script in the page, which shares its process, can't save through the panel.
  assert.equal(onMessage({ type: 'marked:save-page', token, title: 'Not mine', parentId: 'root' }, { tab, url }, () => {}), undefined);
  assert.equal(onMessage({ type: 'marked:panel-data', kind: 'save' }, { tab, url }, () => {}), undefined, 'nor read what it shows');
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token: 'old', title: 'X', parentId: 'root' }, tab), { error: 'This panel is out of date. Save the page again.' });
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token, title: '  ', parentId: 'root' }, tab), { error: 'Enter a name.' });
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token, title: ' My essay ', parentId: reading.id, note: ' Why ', tags: ['AI', 'Essays', 'ai'], abstract: ' Edited. ', preview: true }, tab), { ok: true });
  const saved = await mock.api.storage.local.get();
  const [bookmark] = saved.markedLibraryV1.root.children[0].children;
  assert.deepEqual([bookmark.title, bookmark.url, bookmark.note, bookmark.tags, bookmark.abstract, bookmark.icon], ['My essay', url, 'Why', ['AI', 'Essays'], 'Edited.', icon]);
  assert.deepEqual([saved[`markedText:${bookmark.id}`].text, saved[`markedText:${bookmark.id}`].via], ['Every word of the essay.', 'page']);
  assert.equal(saved[`markedPreview:${bookmark.id}`], undefined, 'there was no preview of a tab in the background to keep');
  assert.deepEqual(Object.keys(session), [], 'Marked forgets the page once it’s saved');
  assert.ok(saved.markedSaveGuideDone, 'and puts away its guide to saving a page, as the user knows how');
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token, title: 'Again', parentId: 'root' }, tab), { error: 'This panel is out of date. Save the page again.' }, 'and saves it once');
  // The next page starts in the folder the last one went into.
  assert.equal(saved.markedSaveFolder, reading.id);
  await onClick({ menuItemId: 'add-to-marked' }, { id: 5, url: 'https://example.com/next', title: 'Next' });
  assert.equal(page.panels.at(-1).folder, reading.id);
});

test('the preview never goes to the page, and is kept only if Save preview stays ticked', async () => {
  const mock = await useLibrary([]);
  const session = useSession();
  const preview = 'data:image/jpeg;base64,/9j/4AAQ';
  const tab = id => ({ id, url: `https://example.com/${id}` });
  session['save:6'] = { url: 'https://example.com/6', title: 'Kept', preview, token: 'six' };
  session['save:7'] = { url: 'https://example.com/7', title: 'Skipped', preview, token: 'seven' };
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token: 'six', title: 'Kept', parentId: 'root', preview: true }, tab(6)), { ok: true });
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token: 'seven', title: 'Skipped', parentId: 'root', preview: false }, tab(7)), { ok: true });
  const saved = await mock.api.storage.local.get();
  const [kept, skipped] = saved.markedLibraryV1.root.children;
  assert.equal(saved[`markedPreview:${kept.id}`], preview);
  assert.equal(saved[`markedPreview:${skipped.id}`], undefined);

  // Asked again while its panel shows, Marked keeps the preview it took before the panel appeared.
  const page = usePage();
  session['save:8'] = { url: 'https://example.com/8', title: 'Open', preview, token: 'eight' };
  await onClick({ menuItemId: 'add-to-marked' }, { id: 8, url: 'https://example.com/8', title: 'Open', active: true, windowId: 1 });
  assert.equal(page.panels[0].preview, true);
  assert.equal(session['save:8'].preview, preview);
});

test('Cancel in the panel, or closing the tab, forgets what Marked read from the page', async () => {
  await useLibrary([]);
  const session = useSession();
  const page = usePage();
  await onClick({ menuItemId: 'add-to-marked' }, { id: 8, url: 'https://example.com/a', title: 'A' });
  const [{ token }] = page.panels;
  onMessage({ type: 'marked:cancel-save', token: 'another' }, panelSender(8), () => {});
  onMessage({ type: 'marked:cancel-save', token }, { tab: { id: 8 }, url: 'https://example.com/a' }, () => {});
  await flush();
  assert.deepEqual(Object.keys(session), ['save:8'], 'only its own panel cancels it');
  onMessage({ type: 'marked:cancel-save', token }, panelSender(8), () => {});
  await flush();
  assert.deepEqual(Object.keys(session), []);
  await onClick({ menuItemId: 'add-to-marked' }, { id: 9, url: 'https://example.com/b', title: 'B' });
  session['highlight:9'] = { token: 'nine', url: 'https://example.com/b', title: 'B', text: 'A passage' };
  assert.deepEqual(Object.keys(session), ['save:9', 'highlight:9']);
  onTabRemoved(9);
  await flush();
  assert.deepEqual(Object.keys(session), []);
});

test('Add to Marked on a saved page edits its bookmark in the panel instead of adding a second copy', async () => {
  const mock = await useLibrary([{ title: 'Reading', type: 'folder' }, { title: 'Essay', url: 'https://example.com/essay', note: 'Old note', tags: ['History'], abstract: 'About it.' }]);
  const [reading, essay] = (await rootOf(mock)).children;
  useSession();
  const page = usePage();
  opened.length = 0;
  const tab = { id: 4, url: 'https://example.com/essay#part-2', title: 'Essay' };
  await onClick({ menuItemId: 'add-to-marked' }, tab);
  const [{ token, ...panel }] = page.panels;
  assert.deepEqual({ edit: panel.edit, url: panel.url, title: panel.title, folder: panel.folder, chosen: panel.chosen, note: panel.note, abstract: panel.abstract, preview: panel.preview },
    { edit: true, url: 'https://example.com/essay', title: 'Essay', folder: 'root', chosen: ['History'], note: 'Old note', abstract: 'About it.', preview: false });
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token, title: 'The essay', parentId: reading.id, note: 'New note', tags: ['History', 'Essays'], abstract: 'About it.' }, tab), { ok: true });
  const root = await rootOf(mock);
  assert.equal(root.children.length, 1, 'moved into Reading, not copied');
  const [moved] = root.children[0].children;
  assert.deepEqual([moved.id, moved.title, moved.note, moved.tags], [essay.id, 'The essay', 'New note', ['History', 'Essays']]);
  assert.equal(opened.length, 0);
});

test('where the panel can’t show, as on the browser’s own pages, Add to Marked opens the editor with what it read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await useLibrary([]);
  const session = useSession();
  opened.length = 0;
  browser.scripting = { executeScript: async details => {
    if (details.files?.includes('save-panel.js')) throw new Error('Cannot access contents of the page.');
    return [{ result: details.func?.name === 'readPageAbstract' ? { url: 'https://example.com/post', text: 'A post about world models.' } : null }];
  } };
  await onClick({ menuItemId: 'add-to-marked', pageUrl: 'https://example.com/', linkUrl: 'https://other.test/' }, { id: 4, url: 'https://example.com/post', title: 'A & B' });
  const request = new URL(opened[0].url);
  assert.equal(request.searchParams.get('add'), 'https://example.com/post');
  assert.equal(request.searchParams.get('title'), 'A & B');
  const key = request.searchParams.get('capture');
  assert.match(key, /^capture-/);
  assert.deepEqual({ ...session[key], createdAt: 0 }, { url: 'https://example.com/post', abstract: 'A post about world models.', createdAt: 0 });
  assert.equal(session['save:4'], undefined, 'nothing waits for a panel that never showed');
  browser.scripting.executeScript = async () => { throw new Error('Cannot access this page'); };
  await onClick({ menuItemId: 'add-to-marked' }, { id: 4, url: 'https://example.com/post', title: 'Post' });
  assert.equal(opened.length, 2, 'the editor still opens without anything read');
  assert.equal(new URL(opened[1].url).searchParams.get('capture'), null);
});

test('the panel shows the page’s abstract only while the tab still shows that page', async () => {
  await useLibrary([]);
  useSession();
  const page = usePage({ readPageAbstract: { url: 'https://example.com/next', text: 'A different page' } });
  await onClick({ menuItemId: 'add-to-marked' }, { id: 4, url: 'https://example.com/post', title: 'Post' });
  assert.equal(page.panels[0].abstract, '');
});

test('Marked keeps the page’s own icon for its bookmark, and skips anything that isn’t a small image', async () => {
  await useLibrary([]);
  const session = useSession();
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  usePage({ readPageIcon: icon });
  await onClick({ menuItemId: 'add-to-marked' }, { id: 4, url: 'https://example.com/icon', title: 'Icon' });
  usePage({ readPageIcon: 'data:text/html;base64,PGI+' });
  await onClick({ menuItemId: 'add-to-marked' }, { id: 5, url: 'https://example.com/other', title: 'Other' });
  await flush();
  assert.equal(session['save:4'].icon, icon);
  assert.equal(session['save:5'].icon, undefined, 'anything but a small image is ignored');
});

test('the Marked button saves the page you’re on; where there’s no web page, it opens Marked', async () => {
  await useLibrary([{ title: 'Saved', url: 'https://example.com/saved' }]);
  useSession();
  const page = usePage();
  opened.length = 0;
  await onAction({ id: 4, url: 'https://example.com/essay', title: 'The essay' });
  await onAction({ id: 5, url: 'https://example.com/saved', title: 'Saved' });
  assert.deepEqual(page.panels.map(panel => [panel.tabId, panel.kind, panel.edit]), [[4, 'save', false], [5, 'save', true]], 'the save panel, or the edit panel on a saved page');
  assert.equal(opened.length, 0, 'the user stays on the page');
  // A new tab or one of the browser's pages: Marked, brought forward if it's open.
  focused.length = 0;
  tabs = [{ id: 1, windowId: 5, url: 'https://example.com/' }, { id: 7, windowId: 3, url: 'moz-extension://marked/manager.html' }];
  await onAction({ id: 2, windowId: 5, url: 'chrome://newtab/' });
  assert.deepEqual(focused, [{ tab: 7, active: true }, { window: 3, focused: true }]);
  assert.equal(opened.length, 0);
  tabs = [];
  await onAction({ id: 7, url: 'moz-extension://marked/manager.html' });
  await onAction({ id: 8 });
  assert.deepEqual(opened, [{ url: 'moz-extension://marked/manager.html' }, { url: 'moz-extension://marked/manager.html' }], 'Marked’s own pages, or a tab it can’t see, open it too');
  // The button's own right-click menu opens Marked.
  const item = menus.find(menu => menu.id === 'open-marked');
  assert.deepEqual([item.title, item.contexts], ['Open Marked', ['action']]);
  opened.length = 0;
  await onClick({ menuItemId: 'open-marked' }, {});
  assert.deepEqual(opened, [{ url: 'moz-extension://marked/manager.html' }]);
  // So does the panel's Open Marked, and only the panel's.
  opened.length = 0;
  onMessage({ type: 'marked:open-marked' }, { tab: { id: 4 }, url: 'https://example.com/essay' }, () => {});
  onMessage({ type: 'marked:open-marked' }, panelSender(4), () => {});
  await flush();
  assert.deepEqual(opened, [{ url: 'moz-extension://marked/manager.html' }]);
});

test('installing Marked opens it, to show how to save a page; an update doesn’t', async () => {
  opened.length = 0;
  tabs = [];
  onInstalled({ reason: 'update' });
  await flush();
  assert.deepEqual(opened, []);
  onInstalled({ reason: 'install' });
  await flush();
  assert.deepEqual(opened, [{ url: 'moz-extension://marked/manager.html' }]);
});

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const jack = { url: 'https://x.com/jack/status/20', author: 'jack', handle: 'jack', text: ' just setting up\nmy  twttr ' };
const saveTweet = tab => onClick({ menuItemId: 'save-tweet-to-marked', pageUrl: 'https://x.com/home' }, tab);

test('Save tweet to Marked is offered only where its content script runs', () => {
  const item = menus.find(menu => menu.id === 'save-tweet-to-marked');
  assert.equal(item.title, 'Save tweet to Marked');
  assert.deepEqual(item.contexts, ['page', 'link', 'image', 'video', 'selection']);
  // The same sites the tweet page script is registered for (see the page scripts test).
  assert.deepEqual(item.documentUrlPatterns, ['https://x.com/*', 'https://twitter.com/*']);
});

// The page's tweet-capture.js answers with the tweet under the pointer.
function useTweet(tweet) {
  const page = usePage(), panel = browser.tabs.sendMessage;
  page.sent = [];
  browser.tabs.sendMessage = async (...args) => { page.sent.push(args); return args[1].type === 'marked:tweet-under-pointer' ? tweet : panel(...args); };
  return page;
}

test('Save tweet to Marked shows the panel for the tweet under the pointer, and saves the tweet', async () => {
  const mock = await useLibrary([]);
  const session = useSession();
  const page = useTweet({ ...jack, thread: ['just setting up my twttr', 'and more'] });
  opened.length = 0;
  const tab = { id: 9, url: 'https://x.com/home', title: 'Home / X' };
  await saveTweet(tab);
  assert.deepEqual(page.sent[0], [9, { type: 'marked:tweet-under-pointer' }, { frameId: 0 }]);
  assert.equal(opened.length, 0);
  const [panel] = page.panels;
  assert.deepEqual([panel.url, panel.title, panel.abstract, panel.preview], ['https://x.com/jack/status/20', 'jack (@jack) on X: “just setting up my twttr”', 'just setting up my twttr', false]);
  assert.equal(session['save:9'].text.text, '1/2\n\njust setting up my twttr\n\n2/2\n\nand more', 'the thread waits in Marked');
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token: panel.token, title: panel.title, parentId: 'root', abstract: panel.abstract }, tab), { ok: true });
  const [bookmark] = (await rootOf(mock)).children;
  assert.equal(bookmark.url, 'https://x.com/jack/status/20', 'the tweet, not the page it was on');
});

test('tweet titles clip long text and fall back when the name or text is missing', async () => {
  await useLibrary([]);
  useSession();
  const open = async reply => {
    const page = useTweet({ url: 'https://x.com/ada/status/1', ...reply });
    await saveTweet({ id: 9 });
    return page.panels[0];
  };
  // 100 characters end inside the 17th word, so the title ends after the 16th.
  const words = Array(16).fill('words').join(' ');
  assert.equal((await open({ author: 'Ada', handle: 'ada', text: 'words '.repeat(30) })).title, `Ada (@ada) on X: “${words}…”`);
  assert.equal((await open({ author: 'Ada', handle: 'ada', text: '👍🏽'.repeat(150) })).title, `Ada (@ada) on X: “${'👍🏽'.repeat(100)}…”`);
  assert.equal((await open({ handle: 'ada', text: 'Hi' })).title, '@ada on X: “Hi”');
  const untitled = await open({ author: 'Ada', handle: 'ada', text: '' });
  assert.equal(untitled.title, 'Ada (@ada) on X');
  assert.equal(untitled.abstract, '', 'nothing to fill in without text');
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
  browser.permissions = { ...browser.permissions, request: details => { requested.push(details); return Promise.resolve(true); } };
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

// A library where the page has two bookmarks, the newer in a folder.
async function useArticle() {
  const { fixture } = await import('./storage-fixture.js');
  const mock = fixture({ id: 'root', children: [] });
  await mock.api.storage.local.set({ markedLibraryV1: { version: 1, root: { id: 'root', children: [
    { id: 'old', parentId: 'root', title: 'Old copy', url: 'https://example.com/article', dateAdded: 1 },
    { id: 'folder', parentId: 'root', title: 'Folder', children: [{ id: 'new', parentId: 'folder', title: 'The essay', url: 'https://example.com/article#intro', dateAdded: 2 }] }
  ] } } });
  browser.storage.local = mock.api.storage.local;
  Object.defineProperty(navigator, 'locks', { value: mock.locks, configurable: true });
  return mock;
}
const highlightsOf = async (mock, id) => {
  const find = node => node.id === id ? node : node.children?.map(find).find(Boolean);
  return (find((await mock.api.storage.local.get()).markedLibraryV1.root).highlights || []).map(({ text, note, color }) => ({ text, note, color }));
};

test('a highlight on a saved page opens Marked’s note panel beside the passage, and only the panel saves it', async () => {
  const mock = await useArticle();
  const session = useSession();
  const page = usePage();
  opened.length = 0;
  const tab = { id: 3, url: 'https://example.com/article#part-2', title: 'Article' };
  const anchor = { top: 100, bottom: 120, right: 480 };
  assert.deepEqual(await ask({ type: 'marked:highlight', text: '  A  passage ', anchor: { ...anchor, left: 7, note: 'extra' } }, tab), { opened: true });
  assert.deepEqual(page.shown, [{ tabId: 3, type: 'marked:show-panel', kind: 'highlight', anchor }], 'beside the passage');
  const [panel] = page.panels;
  assert.deepEqual({ ...panel, token: typeof panel.token }, { tabId: 3, kind: 'highlight', token: 'string', title: 'The essay', text: 'A passage' }, 'the newest bookmark of the page, ignoring #fragments');
  assert.equal(opened.length, 0, 'the note is added on the page');
  // A script in the page can't save a highlight, or choose its passage.
  assert.equal(onMessage({ type: 'marked:save-highlight', token: panel.token, note: 'Mine' }, { tab, url: tab.url }, () => {}), undefined);
  assert.deepEqual(await askPanel({ type: 'marked:save-highlight', token: 'old', note: 'Why' }, tab, 'highlight'), { error: 'This panel is out of date. Highlight the passage again.' });
  assert.deepEqual(await askPanel({ type: 'marked:save-highlight', token: panel.token, text: 'Another passage', note: ' Why ', color: 'purple' }, tab, 'highlight'), { ok: true });
  assert.deepEqual(await highlightsOf(mock, 'new'), [{ text: 'A passage', note: 'Why', color: 'purple' }]);
  assert.deepEqual(page.told, [[3, { type: 'marked:highlight-saved', highlight: { text: 'A passage', note: 'Why', color: 'purple' } }, { frameId: 0 }]], 'the page marks it at once');
  assert.deepEqual(Object.keys(session), [], 'and Marked forgets the passage');
  // Saved from a page that's no longer in Marked.
  session['highlight:4'] = { token: 'four', url: 'https://other.test/', title: 'Gone', text: 'X' };
  assert.deepEqual(await askPanel({ type: 'marked:save-highlight', token: 'four' }, { id: 4 }, 'highlight'), { error: 'This page is no longer in Marked.' });
  // Cancel forgets the passage, for its own panel only.
  onMessage({ type: 'marked:cancel-highlight', token: 'another' }, panelSender(4, 'highlight'), () => {});
  onMessage({ type: 'marked:cancel-highlight', token: 'four' }, { tab: { id: 4 }, url: 'https://other.test/' }, () => {});
  await flush();
  assert.deepEqual(Object.keys(session), ['highlight:4']);
  onMessage({ type: 'marked:cancel-highlight', token: 'four' }, panelSender(4, 'highlight'), () => {});
  await flush();
  assert.deepEqual(Object.keys(session), []);
});

test('where the note panel can’t show, the highlight is kept without a note', async () => {
  const mock = await useArticle();
  const session = useSession();
  const page = usePage();
  const show = browser.tabs.sendMessage;
  // The panel's frame never loaded, so save-panel.js answers that it didn't show.
  browser.tabs.sendMessage = async (tabId, message, options) => message.type === 'marked:show-panel' ? false : show(tabId, message, options);
  const tab = { id: 3, url: 'https://example.com/article', title: 'Article' };
  assert.deepEqual(await ask({ type: 'marked:highlight', text: 'Kept anyway', anchor: { top: 1, bottom: 2, right: 3 } }, tab), { highlighted: true });
  assert.deepEqual(await highlightsOf(mock, 'new'), [{ text: 'Kept anyway', note: undefined, color: undefined }]);
  assert.deepEqual(page.told, [[3, { type: 'marked:highlight-saved', highlight: { text: 'Kept anyway', note: '', color: undefined } }, { frameId: 0 }]]);
  assert.deepEqual(Object.keys(session), []);
  // Nor where Marked can't add to the page at all.
  browser.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page.'); };
  assert.deepEqual(await ask({ type: 'marked:highlight', text: 'Kept too' }, tab), { highlighted: true });
  assert.equal((await highlightsOf(mock, 'new')).length, 2);
});

test('where the panel’s frame never loads, Add to Marked opens the editor with what it read', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await useLibrary([]);
  const session = useSession();
  usePage({ readPageAbstract: { url: 'https://example.com/post', text: 'A post.' } });
  browser.tabs.sendMessage = async () => false;
  opened.length = 0;
  await onClick({ menuItemId: 'add-to-marked' }, { id: 4, url: 'https://example.com/post', title: 'Post' });
  const request = new URL(opened[0].url);
  assert.equal(request.searchParams.get('add'), 'https://example.com/post');
  assert.equal(session[request.searchParams.get('capture')].abstract, 'A post.');
  assert.equal(session['save:4'], undefined, 'nothing waits for a panel that never showed');
});

test('a highlight on a new page shows the save panel with the passage, as Add to Marked does, and the page marks it once saved', async () => {
  const mock = await useLibrary([]);
  useSession();
  const url = 'https://example.org/new';
  const page = usePage({ readPageAbstract: { url, text: 'Page description.' }, readPageText: { url, text: 'The whole page.' } });
  opened.length = 0;
  const tab = { id: 4, url, title: 'New page' };
  assert.deepEqual(await ask({ type: 'marked:highlight', text: 'Quoted  words' }, tab), { opened: true });
  const [panel] = page.panels;
  assert.deepEqual([panel.url, panel.title, panel.highlight, panel.abstract], [url, 'New page', 'Quoted words', 'Page description.']);
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token: panel.token, title: 'New page', parentId: 'root', highlight: { color: 'green', note: ' Why ' } }, tab), { ok: true });
  const saved = await mock.api.storage.local.get();
  const [bookmark] = saved.markedLibraryV1.root.children;
  assert.deepEqual(bookmark.highlights.map(({ text, note, color }) => ({ text, note, color })), [{ text: 'Quoted words', note: 'Why', color: 'green' }]);
  assert.equal(saved[`markedText:${bookmark.id}`].text, 'The whole page.', 'with the page’s text');
  assert.deepEqual(page.told, [[4, { type: 'marked:highlight-saved', highlight: { text: 'Quoted words', note: 'Why', color: 'green' } }, { frameId: 0 }]]);
  assert.equal(await ask({ type: 'marked:highlight', text: '   ' }, tab), null);
  assert.equal(onMessage({ type: 'other' }, { tab: { id: 4 } }, () => {}), undefined);
  assert.equal(opened.length, 0, 'nothing opens in another tab');
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

test('the keyboard shortcut adds the page, or edits its bookmark when it is already saved', async () => {
  await useLibrary([{ title: 'Saved', url: 'https://example.com/saved' }]);
  useSession();
  const page = usePage();
  opened.length = 0;
  await onCommand('add-to-marked', { id: 5, url: 'https://example.com/saved#intro', title: 'Saved' });
  await onCommand('add-to-marked', { id: 6, url: 'https://example.com/new', title: 'New' });
  await onCommand('other', { id: 6, url: 'https://example.com/new' });
  await flush();
  assert.deepEqual(page.panels.map(panel => [panel.tabId, panel.edit, panel.url]).sort(), [[5, true, 'https://example.com/saved'], [6, false, 'https://example.com/new']], 'a saved page edits its bookmark, not a second copy');
  assert.equal(opened.length, 0);
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

test('Add to Marked on a saved page without its text keeps the text, and edits the bookmark in the panel', async () => {
  const mock = await useLibrary([{ title: 'Saved', url: 'https://example.com/saved' }]);
  const [saved] = (await rootOf(mock)).children;
  useSession();
  const page = usePage({ readPageText: { url: 'https://example.com/saved', text: 'The saved page.' } });
  await onClick({ menuItemId: 'add-to-marked' }, { id: 5, url: 'https://example.com/saved', title: 'Saved' });
  await flush();
  assert.equal(page.panels[0].edit, true);
  assert.equal((await mock.api.storage.local.get())[`markedText:${saved.id}`].text, 'The saved page.');
});

test('where the panel can’t show, Add to Marked on a saved page opens its bookmark in Marked', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mock = await useLibrary([{ title: 'Saved', url: 'https://example.com/saved' }]);
  const [saved] = (await rootOf(mock)).children;
  useSession();
  browser.scripting = { executeScript: async () => { throw new Error('Cannot access contents of the page.'); } };
  opened.length = 0;
  await onClick({ menuItemId: 'add-to-marked' }, { id: 5, url: 'https://example.com/saved', title: 'Saved' });
  assert.equal(new URL(opened[0].url).searchParams.get('edit'), saved.id);
});

test('Alt+Shift+H asks the page to highlight its selection, adding the highlighter where it is missing', async () => {
  const sent = [], injected = [];
  let present = false;
  browser.tabs.sendMessage = async (tabId, message, options) => { sent.push([tabId, message.type, options.frameId]); if (!present) throw new Error('Could not establish connection.'); return true; };
  browser.scripting = { executeScript: async details => { injected.push(details.files); present = true; return []; } };
  await onCommand('highlight-selection', { id: 9, url: 'https://example.com/' });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [[9, 'marked:highlight-selection', 0], [9, 'marked:highlight-selection', 0]]);
  assert.deepEqual(injected, [['highlighter.js']], 'a tab opened before Marked gets the highlighter first');
  // A page with Marked's panel script but no highlighter: that script leaves the message unanswered.
  sent.length = 0; injected.length = 0; present = false;
  browser.tabs.sendMessage = async (tabId, message, options) => { sent.push([tabId, message.type, options.frameId]); return present || undefined; };
  await onCommand('highlight-selection', { id: 9, url: 'https://example.com/' });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([sent.length, injected], [2, [['highlighter.js']]], 'the highlighter is added there too');
  const told = [];
  browser.runtime.sendMessage = async message => { told.push(message); };
  await onCommand('highlight-selection', { id: 5, url: 'moz-extension://marked/reader.html?id=essay' });
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(told, [{ type: 'marked:reader-highlight', tabId: 5 }], 'Marked’s reader highlights in its own page');
  assert.deepEqual(manifest.commands['highlight-selection'].suggested_key, { default: 'Alt+Shift+H' });
});

test('Add to Marked on a post reads its site’s API for a card and its thread', async () => {
  const mock = await useLibrary([]);
  useSession();
  const url = 'https://news.ycombinator.com/item?id=100';
  const page = usePage({ readPageText: { url, text: 'The page as shown.' } });
  const answers = {
    'https://hacker-news.firebaseio.com/v0/item/100.json': { id: 100, type: 'story', by: 'pg', title: 'Show HN: Marked', score: 5, descendants: 1, time: 1, kids: [101] },
    'https://hacker-news.firebaseio.com/v0/item/101.json': { id: 101, by: 'dang', text: 'Nice.' }
  };
  const fetched = [];
  globalThis.fetch = async url => { fetched.push(url); return new Response(JSON.stringify(answers[url] ?? null)); };
  const tab = { id: 4, url, title: 'Show HN: Marked | Hacker News' };
  await onClick({ menuItemId: 'add-to-marked' }, tab);
  assert.deepEqual(await askPanel({ type: 'marked:save-page', token: page.panels[0].token, title: 'Show HN: Marked', parentId: 'root' }, tab), { ok: true });
  const saved = await mock.api.storage.local.get();
  const [bookmark] = saved.markedLibraryV1.root.children;
  assert.deepEqual([bookmark.card.site, bookmark.card.title, bookmark.card.stats], ['hn', 'Show HN: Marked', { score: 5, comments: 1 }]);
  assert.equal(saved[`markedText:${bookmark.id}`].text, 'Top comments\n\ndang\n\nNice.', 'the discussion, not the page as shown');
  assert.deepEqual(fetched, Object.keys(answers));
  delete globalThis.fetch;
});

test('importing from X opens its bookmarks page, collects there, and saves only that tab’s posts', async () => {
  const mock = await useLibrary([]);
  const session = {};
  browser.storage.session.get = async key => ({ [key]: session[key] });
  browser.storage.session.set = async value => Object.assign(session, value);
  const created = [], sent = [];
  browser.tabs.create = async details => { created.push(details); return { id: 42 }; };
  browser.tabs.sendMessage = async (tabId, message) => { sent.push([tabId, message.type]); return true; };
  const manager = { id: 9, url: 'moz-extension://marked/manager.html' };
  const reply = message => new Promise(resolve => { onMessage(message, { tab: manager, url: manager.url }, resolve); });
  assert.deepEqual(await reply({ type: 'marked:import-x' }), { ok: true });
  assert.deepEqual(created, [{ url: 'https://x.com/i/bookmarks', active: true }]);
  onTabUpdated(42, { status: 'complete' }, { id: 42, url: 'https://x.com/i/bookmarks' });
  onTabUpdated(42, { status: 'complete' }, { id: 42, url: 'https://x.com/i/bookmarks' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, [[42, 'marked:collect-bookmarks']], 'once the page loads, and once only');
  const tweets = [{ url: 'https://x.com/ada/status/3', author: 'Ada', handle: 'ada', text: 'Newest', order: 0 }, { url: 'https://x.com/ada/status/2', author: 'Ada', handle: 'ada', text: 'Older', order: 1 }, { url: 'javascript:alert(1)', order: 2 }];
  assert.deepEqual(await ask({ type: 'marked:x-bookmarks', tweets }, { id: 42, url: 'https://x.com/i/bookmarks' }), { added: 2, tagged: 0, known: 0 });
  assert.deepEqual(await ask({ type: 'marked:x-bookmarks', tweets }, { id: 7, url: 'https://x.com/i/bookmarks' }), { error: 'Start the import from Marked’s Import menu.' }, 'no other tab');
  const folder = (await mock.api.storage.local.get()).markedLibraryV1.root.children.find(node => node.title === 'X bookmarks');
  assert.deepEqual(folder.children.map(node => node.title), ['Ada (@ada) on X: “Newest”', 'Ada (@ada) on X: “Older”']);
  assert.ok(folder.children[0].dateAdded > folder.children[1].dateAdded, 'X’s order, newest first');
  onMessage({ type: 'marked:open-x-bookmarks' }, { tab: { id: 42 } }, () => {});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(new URL(created.at(-1).url).searchParams.get('folder'), folder.id, 'Open in Marked shows the folder');
});

// X's page is asked to collect once per page load in the import's tab, never
// for Firefox's about:blank; it may ask to be reloaded twice; and an import
// that stops short leaves the next one to catch up past what it saved.
test('the X import asks each page of its tab once, reloads it twice at most, and catches up after one that stopped short', async () => {
  const mock = await useLibrary([]);
  const session = {};
  browser.storage.session.get = async key => ({ [key]: session[key] });
  browser.storage.session.set = async value => Object.assign(session, value);
  const sent = [], reloaded = [];
  let status = 'loading';
  browser.tabs.create = async () => ({ id: 42 });
  browser.tabs.get = async id => ({ id, status, url: 'https://x.com/i/bookmarks' });
  browser.tabs.reload = async id => { reloaded.push(id); };
  browser.tabs.sendMessage = async (tabId, message) => { sent.push(message); return true; };
  const manager = { id: 9, url: 'moz-extension://marked/manager.html' };
  const start = () => new Promise(resolve => { onMessage({ type: 'marked:import-x' }, { tab: manager, url: manager.url }, resolve); });
  const x = { id: 42, url: 'https://x.com/i/bookmarks' };
  const load = async () => { onTabUpdated(42, { status: 'loading' }, x); onTabUpdated(42, { status: 'complete' }, x); await flush(); };
  const collect = catchUp => ({ type: 'marked:collect-bookmarks', pace: 900, catchUp });
  try {
    await start();
    onTabUpdated(42, { status: 'complete' }, { id: 42, url: 'about:blank' });
    await flush();
    assert.deepEqual(sent, [], 'not Firefox’s about:blank');
    await load();
    assert.deepEqual(sent, [collect(true)], 'no import has reached the end yet');
    assert.deepEqual(await ask({ type: 'marked:x-bookmarks', tweets: [{ url: 'https://x.com/ada/status/1', author: 'Ada', handle: 'ada', text: 'One', order: 0 }] }, x), { added: 1, tagged: 0, known: 0 });
    assert.equal((await mock.api.storage.local.get()).markedXImportComplete, false, 'there may be a gap below it');

    // X shows nothing: reloaded, and the new page is asked again, past what was saved.
    assert.equal(await ask({ type: 'marked:x-reload' }, x), true);
    await flush();
    assert.deepEqual(reloaded, [42]);
    await load();
    assert.deepEqual(sent, [collect(true), collect(true)]);
    assert.equal(await ask({ type: 'marked:x-reload' }, x), true);
    assert.equal(await ask({ type: 'marked:x-reload' }, x), false, 'twice at most');
    assert.equal(await ask({ type: 'marked:x-reload' }, { id: 7, url: x.url }), false, 'only its own tab');

    // It reaches the end: the tab is left alone, and the next import stops at saved posts.
    onMessage({ type: 'marked:x-import-end', complete: true }, { tab: x }, () => {});
    await flush();
    assert.equal((await mock.api.storage.local.get()).markedXImportComplete, true);
    await load();
    assert.equal(sent.length, 2, 'not once it ended');
    await start();
    await load();
    assert.deepEqual(sent.at(-1), collect(false));

    // Stopped short this time: the next one catches up. X may load before the job is stored.
    onMessage({ type: 'marked:x-import-end', complete: false }, { tab: x }, () => {});
    await ask({ type: 'marked:x-bookmarks', tweets: [] }, x);
    status = 'complete';
    await start();
    await flush();
    assert.deepEqual(sent.at(-1), collect(false), 'nothing new was saved, so nothing was missed');
  } finally {
    delete browser.tabs.get;
    delete browser.tabs.reload;
  }
});

// An import the user chose to tag: Jev, with their own TypeSafe key, gives each
// new post the tags from the user's tag list that fit it best.
async function useTaggedImport(library, settings = { apiKey: 'sk-test' }) {
  const mock = await useLibrary(library);
  if (settings) await mock.api.storage.local.set({ markedJev: settings });
  const session = {};
  browser.storage.session.get = async key => ({ [key]: session[key] });
  browser.storage.session.set = async value => Object.assign(session, value);
  browser.tabs.create = async () => ({ id: 42 });
  browser.tabs.sendMessage = async () => true;
  const manager = { id: 9, url: 'moz-extension://marked/manager.html' };
  assert.deepEqual(await new Promise(resolve => { onMessage({ type: 'marked:import-x', tag: true }, { tab: manager, url: manager.url }, resolve); }), { ok: true });
  return mock;
}
const xPost = (id, text) => ({ url: `https://x.com/ada/status/${id}`, author: 'Ada', handle: 'ada', text, order: 10 - id });
const saveX = tweets => ask({ type: 'marked:x-bookmarks', tweets }, { id: 42, url: 'https://x.com/i/bookmarks' });
// TypeSafe, saying a tag fits a post when the post names it.
function useJev({ status = 200 } = {}) {
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, authorization: init.headers.Authorization });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'No.' } }), { status });
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const [, tag, post] = question.instructions.match(/“(.+)” fit the post in `posts\[(\d+)\]`/);
      return [id, { type: 'noul', noul: new RegExp(`\\b${tag}\\b`, 'i').test(JSON.stringify(body.state.posts[post])) ? 0.9 : 0.1 }];
    }));
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 120, output_tokens: 0 } }));
  };
  return requests;
}
const xFolder = async mock => (await mock.api.storage.local.get()).markedLibraryV1.root.children.find(node => node.title === 'X bookmarks');
const tagsOf = async mock => (await mock.api.storage.local.get()).markedLibraryV1.tags;

test('a tagged X import gives each new post the user’s tags that fit it, with their key; nothing else of the library goes', async () => {
  const mock = await useTaggedImport([{ title: 'Known', url: 'https://x.com/ada/status/9', tags: ['Cooking'] }]);
  const requests = useJev();
  assert.deepEqual(await saveX([xPost(3, 'Match day: Sports with AI cameras'), xPost(2, 'Something else entirely'), xPost(9, 'Saved before')]), { added: 2, tagged: 1, known: 1 });
  assert.equal(requests.length, 1, 'one request for the batch');
  assert.deepEqual([requests[0].url, requests[0].authorization, requests[0].body.model], ['https://api.typesafe.ai/v1/systemone', 'Bearer sk-test', 'jev-latest']);
  assert.deepEqual(requests[0].body.state.posts, [{ author: 'Ada @ada', text: 'Match day: Sports with AI cameras' }, { author: 'Ada @ada', text: 'Something else entirely' }], 'the new posts, and nothing else from the library');
  assert.equal(Object.keys(requests[0].body.questions).length, 2 * 12, 'every post, every tag');
  assert.equal(requests[0].body.questions.p1t7.instructions, 'Does the tag “Sports” fit the post in `posts[1]`?');
  assert.equal(requests[0].body.questions.p0t11.instructions, 'Does the tag “Cooking” fit the post in `posts[0]`?', 'the user’s own tags too');
  assert.deepEqual((await xFolder(mock)).children.map(node => [node.url, node.tags]), [['https://x.com/ada/status/3', ['AI', 'Sports']], ['https://x.com/ada/status/2', undefined]], 'all in X bookmarks');
  assert.deepEqual(await tagsOf(mock), ['Technology', 'AI', 'History', 'Fiction', 'Science', 'Business', 'Politics', 'Sports', 'Entertainment', 'Health', 'Culture', 'Cooking'], 'the user’s list, as it was');
  await flush();
  assert.equal((await mock.api.storage.local.get()).markedJevUsage.calls, 1, 'what it costs is counted with the searches');
  delete globalThis.fetch;
});

test('a tagged X import picks from Marked’s default tags, and puts them back in a list the user emptied', async () => {
  const mock = await useTaggedImport([]);
  const requests = useJev();
  assert.deepEqual(await saveX([xPost(5, 'Science: a new telescope'), xPost(4, 'Cats being cats')]), { added: 2, tagged: 1, known: 0 });
  assert.equal(Object.keys(requests[0].body.questions).length, 2 * 11, 'the default tags');
  assert.deepEqual((await xFolder(mock)).children.map(node => node.tags), [['Science'], undefined]);

  // Jev needs tags to choose from, so an emptied list gets the defaults back.
  const { createLibraryStore } = await import('../store.js');
  const store = createLibraryStore(mock.api, mock.locks);
  for (const tag of await store.getTags()) await store.removeTag(tag);
  assert.deepEqual(await saveX([xPost(6, 'Health: sleep and the heart')]), { added: 1, tagged: 1, known: 0 });
  assert.deepEqual(await tagsOf(mock), ['Technology', 'AI', 'History', 'Fiction', 'Science', 'Business', 'Politics', 'Sports', 'Entertainment', 'Health', 'Culture']);
  delete globalThis.fetch;
});

// What a post quotes, shows, or links to often says more than its own words.
test('a tagged X import gives Jev the post each one quotes, its image descriptions and its link preview, and saves none of them', async () => {
  const mock = await useTaggedImport([]);
  const requests = useJev();
  const huge = { ...xPost(7, 'This is huge'), quote: { author: 'NASA Webb @NASAWebb', text: 'A new image of the Crab   Nebula' }, images: ['Gold hexagonal mirrors', 7], link: 'science.nasa.gov Webb maps the Crab Nebula' };
  const lunch = { ...xPost(8, 'Lunch'), quote: 'not a post', images: 'not a list', link: { not: 'text' } };
  assert.deepEqual(await saveX([huge, lunch]), { added: 2, tagged: 1, known: 0 });
  assert.deepEqual(requests[0].body.state.posts, [
    { author: 'Ada @ada', text: 'This is huge', quoted_post: { author: 'NASA Webb @NASAWebb', text: 'A new image of the Crab Nebula' }, image_descriptions: ['Gold hexagonal mirrors'], link_preview: 'science.nasa.gov Webb maps the Crab Nebula' },
    { author: 'Ada @ada', text: 'Lunch' }
  ], 'what each post has, as text');
  assert.match(requests[0].body.state.about, /quoted_post.*image_descriptions.*link_preview.*part of what the post is about/);
  const [saved] = (await xFolder(mock)).children;
  assert.deepEqual([saved.abstract, saved.tags], ['This is huge', ['Science']], 'tagged by what it links to');
  assert.ok(!JSON.stringify(await mock.api.storage.local.get()).includes('Nebula'), 'the bookmark keeps only the post');
  delete globalThis.fetch;
});

test('without a key, a rejected key, or Firefox’s consent, a tagged X import still saves every post, and says why it didn’t tag', async () => {
  let requests = useJev();
  await useTaggedImport([], null);
  assert.deepEqual(await saveX([xPost(1, 'Sports news')]), { added: 1, tagged: 0, known: 0, tagError: 'Add your TypeSafe API key in Marked’s Settings to tag posts.' });
  assert.equal(requests.length, 0);

  await useTaggedImport([], { apiKey: 'sk-bad' });
  requests = useJev({ status: 401 });
  assert.deepEqual(await saveX([xPost(2, 'Sports news')]), { added: 1, tagged: 0, known: 0, tagError: 'TypeSafe rejected the API key. Check it in Settings.' });
  assert.deepEqual(await saveX([xPost(4, 'More sports news')]), { added: 1, tagged: 0, known: 0 }, 'the rest of the import isn’t tagged');
  assert.equal(requests.length, 1, 'nor sent again');

  const mock = await useTaggedImport([]);
  requests = useJev();
  const permissions = browser.permissions;
  browser.permissions = { ...permissions, getAll: async () => ({ origins: [], permissions: [], data_collection: ['searchTerms'] }) };
  try {
    assert.match((await saveX([xPost(3, 'Sports news')])).tagError, /^Firefox isn’t letting Marked send posts to TypeSafe/);
    assert.equal(requests.length, 0, 'withdrawn in Firefox’s settings, nothing goes to TypeSafe');
    assert.equal((await xFolder(mock)).children.length, 1);
  } finally { browser.permissions = permissions; }
  delete globalThis.fetch;
});

// Previews, in Settings, stand in for TypeSafe: a tagged import needs no key,
// and each request it would send goes to the console instead, every batch.
test('with previews on, a tagged X import needs no key and sends nothing; the console shows every request it would send', async () => {
  const mock = await useTaggedImport([], { apiKey: '', preview: true });
  const requests = useJev();
  const log = console.log;
  const logged = [];
  console.log = (...args) => { logged.push(args); };
  try {
    assert.deepEqual(await saveX([xPost(6, 'Science news'), xPost(5, 'Sports news')]), { added: 2, tagged: 0, known: 0 });
    assert.deepEqual(await saveX([xPost(4, 'Health news')]), { added: 1, tagged: 0, known: 0 }, 'the rest of the import is previewed too');
    assert.deepEqual(await saveX([xPost(6, 'Science news')]), { added: 0, tagged: 0, known: 1 }, 'posts already saved wouldn’t be sent');
  } finally { console.log = log; }
  assert.equal(requests.length, 0, 'nothing goes to TypeSafe');
  assert.equal(logged.length, 2, 'one request for each batch');
  const { estimateJevTokens, jevCost, formatCost } = await import('../jev.js');
  for (const [label, { body }] of logged) {
    const tokens = estimateJevTokens(body);
    assert.equal(label, `Jev request (preview, not sent): POST https://api.typesafe.ai/v1/systemone · about ${formatCost(jevCost(tokens))} (≈${tokens.toLocaleString()} input tokens; output is free)`, 'with what it would cost');
  }
  const [{ headers, body }] = logged[0].slice(1);
  assert.deepEqual(headers, { Authorization: 'Bearer <your API key>', 'Content-Type': 'application/json' });
  assert.deepEqual(body.state.posts, [{ author: 'Ada @ada', text: 'Science news' }, { author: 'Ada @ada', text: 'Sports news' }], 'each post’s author and text, as they would be sent');
  assert.equal(Object.keys(body.questions).length, 2 * 11, 'with the default tags');
  assert.deepEqual(logged[1][1].body.state.posts, [{ author: 'Ada @ada', text: 'Health news' }]);
  assert.equal(await tagsOf(mock), undefined, 'which the tag list already has');
  assert.deepEqual((await xFolder(mock)).children.map(node => node.tags), [undefined, undefined, undefined], 'every post is saved, with no tags');
  await flush();
  assert.equal((await mock.api.storage.local.get()).markedJevUsage, undefined, 'and nothing is counted');
  delete globalThis.fetch;
});

test('the Marked button counts saved bookmarks related to an unsaved page, and opens them', async () => {
  const { buildIndex, compactIndex, documentTerms } = await import('../related.js');
  const mock = await useLibrary([{ title: 'Saved essay', url: 'https://example.com/essay' }]);
  const index = buildIndex([
    { id: 'attention', terms: documentTerms({ title: 'Attention (machine learning)', tags: ['AI'], text: 'Attention lets a transformer weigh tokens.' }) },
    { id: 'transformer', terms: documentTerms({ title: 'Transformer architecture', tags: ['AI'], text: 'Transformers use attention over tokens.' }) },
    { id: 'pasta', terms: documentTerms({ title: 'Weeknight pasta', text: 'Boil water.' }) }
  ]);
  await mock.api.storage.local.set({ markedRelatedV1: compactIndex(index) });
  onStorageChanged({ markedRelatedV1: {} }, 'local');
  const session = {};
  browser.storage.session.get = async key => ({ [key]: session[key] });
  browser.storage.session.set = async value => Object.assign(session, value);
  browser.storage.session.remove = async key => { delete session[key]; };
  const titles = [];
  browser.action.setTitle = async details => { titles.push(details); };
  badges.length = 0;
  const tab = { id: 11, url: 'https://blog.test/how-attention-works' };
  const topics = { title: 'How attention works in transformers', description: 'Tokens, attention, and transformer models.', headings: ['Attention'] };
  await ask({ type: 'marked:page-highlights', topics }, tab);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(badges.at(-1), { tabId: 11, text: '2' });
  assert.equal(titles.at(-1).title, 'Save to Marked (2 saved bookmarks relate to this page)');
  // The button saves the page; its panel shows the related bookmarks, a click away.
  const page = usePage();
  const created = [];
  browser.tabs.create = async details => { created.push(details); return { id: 12 }; };
  await onAction(tab);
  assert.equal(page.panels[0].related, 2);
  onMessage({ type: 'marked:open-related' }, { tab, url: tab.url }, () => {});
  await flush();
  assert.deepEqual(created, [], 'not for a script in the page');
  onMessage({ type: 'marked:open-related' }, panelSender(tab), () => {});
  await flush();
  const key = new URL(created[0].url).searchParams.get('related');
  assert.deepEqual([session[key].url, session[key].title], ['https://blog.test/how-attention-works', 'How attention works in transformers'], 'Marked opens on the page’s related bookmarks');

  await mock.api.storage.local.set({ markedBrowsing: { related: false } });
  await ask({ type: 'marked:page-highlights', topics }, { id: 13, url: 'https://blog.test/other' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(badges.at(-1), { tabId: 13, text: '' }, 'Settings can turn the count off');
  await ask({ type: 'marked:page-highlights', topics }, { id: 14, url: 'https://example.com/essay' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(badges.filter(badge => badge.tabId === 14).length, 0, 'a saved page keeps its check');
});

// Access to the pages you visit is asked for in Marked's own page, not at
// install, so nothing runs in web pages until the user allows it.
test('the page scripts run only once access to the pages you visit is granted, and stop when it is taken back', async () => {
  let granted = false;
  const registered = new Map(), injected = [];
  browser.permissions.contains = async () => granted;
  browser.scripting = {
    getRegisteredContentScripts: async () => [...registered.values()],
    registerContentScripts: async scripts => {
      for (const script of scripts) {
        if (registered.has(script.id)) throw new Error(`Duplicate script ID '${script.id}'`);
        registered.set(script.id, script);
      }
    },
    unregisterContentScripts: async ({ ids }) => { for (const id of ids) registered.delete(id); },
    executeScript: async details => { injected.push([details.target.tabId, ...details.files]); return []; }
  };
  const open = [{ id: 1, url: 'https://example.com/' }, { id: 2, url: 'https://x.com/home' }, { id: 3, url: 'moz-extension://marked/manager.html' }];
  const query = browser.tabs.query;
  browser.tabs.query = async ({ url } = {}) => url ? open.filter(tab => url.some(pattern => tab.url.startsWith(pattern.replace('*/*', '').replace(/\*$/, '')))) : [];
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  onInstalled({ reason: 'install' });
  await settle();
  assert.equal(registered.size, 0, 'nothing runs in pages before access is granted');

  granted = true;
  onPermissionAdded({ origins: ['<all_urls>'] });
  await settle();
  assert.deepEqual([...registered.values()].map(script => [script.id, script.matches, script.js, script.runAt, script.allFrames]), [
    ['marked-highlighter', ['http://*/*', 'https://*/*'], ['highlighter.js'], 'document_idle', false],
    ['marked-tweet-capture', ['https://x.com/*', 'https://twitter.com/*'], ['tweet-capture.js'], 'document_idle', false]
  ]);
  assert.deepEqual(injected, [[1, 'highlighter.js'], [2, 'highlighter.js'], [2, 'tweet-capture.js']], 'pages already open get them without a reload');
  onPermissionAdded({ origins: ['<all_urls>'] });
  onInstalled({ reason: 'update' });
  await settle();
  assert.equal(registered.size, 2, 'registered once, however often it syncs');

  granted = false;
  onPermissionRemoved({ origins: ['<all_urls>'] });
  await settle();
  assert.equal(registered.size, 0, 'taken back, they stop');
  browser.tabs.query = query;
  browser.permissions.contains = async () => true;
});

test('revisiting a saved post never asks its site for a card: what Marked sees while you browse stays on the device', async () => {
  const mock = await useLibrary([{ title: 'Show HN: Marked', url: 'https://news.ycombinator.com/item?id=100' }]);
  const fetched = [], injected = [];
  globalThis.fetch = async url => { fetched.push(url); return new Response('null'); };
  browser.scripting = { executeScript: async details => { injected.push(details); return []; } };
  await onTabUpdated(7, { status: 'complete' }, { id: 7, url: 'https://news.ycombinator.com/item?id=100', title: 'Show HN: Marked' });
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fetched, []);
  assert.deepEqual(injected, [], 'nor is its page read');
  delete globalThis.fetch;
  void mock;
});

test('taking access back tells open pages to stand down, forgets their related counts, and clears every badge', async () => {
  await useLibrary([{ title: 'Saved', url: 'https://example.com/saved' }]);
  let granted = true;
  browser.permissions.contains = async () => granted;
  browser.scripting = { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => [] };
  const told = [];
  browser.tabs.sendMessage = async (tabId, message) => { told.push([tabId, message.type, message.allowed]); return true; };
  const query = browser.tabs.query;
  const open = [{ id: 21, url: 'https://example.com/saved' }, { id: 22, url: 'https://other.test/' }];
  browser.tabs.query = async () => open;
  const session = { 'related:22': { key: 'https://other.test/', count: 2 }, 'capture-1': {} };
  browser.storage.session.get = async () => ({ ...session });
  browser.storage.session.remove = async keys => { for (const key of [].concat(keys)) delete session[key]; };
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  badges.length = 0;
  await onTabUpdated(21, { status: 'complete' }, open[0]);
  await settle();
  assert.deepEqual(badges.filter(badge => badge.tabId === 21).at(-1), { tabId: 21, text: '✓' });

  granted = false; badges.length = 0;
  onPermissionRemoved({ origins: ['<all_urls>'] });
  await settle();
  assert.deepEqual(told.sort(), [[21, 'marked:page-access', false], [22, 'marked:page-access', false]], 'pages already open drop their marks');
  assert.deepEqual(badges.sort((a, b) => a.tabId - b.tabId), [{ tabId: 21, text: '' }, { tabId: 22, text: '' }], 'no ✓, though Marked can still see the address');
  assert.deepEqual(Object.keys(session), ['capture-1'], 'related counts are forgotten');
  await onTabUpdated(21, { status: 'complete' }, open[0]);
  await settle();
  assert.deepEqual(badges.filter(badge => badge.tabId === 21).at(-1), { tabId: 21, text: '' }, 'and it stays off');

  told.length = 0; granted = true;
  onPermissionAdded({ origins: ['<all_urls>'] });
  await settle();
  assert.deepEqual(told.sort(), [[21, 'marked:page-access', true], [22, 'marked:page-access', true]], 'given again, they come back');
  browser.tabs.query = query;
  browser.permissions.contains = async () => true;
});
