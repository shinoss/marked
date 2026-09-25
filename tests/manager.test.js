import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { fixture } from './storage-fixture.js';
import { STORAGE_KEY } from '../store.js';
import { estimateJevTokens, jevCost, formatCost } from '../jev.js';

test('manager renders, searches, creates, and moves bookmarks through the API', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  const $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const root = { id: 'root________', children: [{ id: 'toolbar_____', parentId: 'root________', title: 'Bookmarks Toolbar', children: [] }, { id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks', children: [{ id: 'a', parentId: 'unfiled_____', title: '<img onerror=alert(1)>', url: 'https://example.com/', type: 'bookmark' }, { id: 'folder', parentId: 'unfiled_____', title: 'Reading', children: [] }] }] };
  const mock = fixture(root);
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  await import('../manager.js');
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  await settle();
  assert.equal($('items').children.length, 1);
  assert.equal($('items').querySelector('img'), null, 'bookmark names are rendered as text');
  $('gallery-view').click();
  assert.equal(document.querySelector('.table-wrap').classList.contains('gallery'), true);
  assert.equal($('gallery-view').getAttribute('aria-pressed'), 'true');
  assert.equal($('items').querySelector('.card-preview').textContent, 'No preview');
  $('list-view').click();
  assert.equal(document.querySelector('.table-wrap').classList.contains('gallery'), false);
  $('search').value = 'Reading'; $('search').dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal($('items').children.length, 1);
  assert.equal($('items').querySelector('.item-title').textContent, 'Reading');
  $('all-bookmarks').click(); $('new-bookmark').click();
  $('edit-name').value = 'New bookmark'; $('edit-url').value = 'https://mozilla.org/';
  $('editor-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('editor-form').querySelector('[type=submit]') }));
  await settle();
  assert.equal($('items').children.length, 2);
  $('select-all').click(); $('move-selected').click(); $('move-parent').value = 'folder';
  $('move-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('move-form').querySelector('[type=submit]') }));
  await settle();
  const saved = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY].root;
  assert.equal(saved.children[1].children.find(n => n.id === 'folder').children.length, 2);
  assert.equal(root.children[1].children.length, 2, 'Firefox collection is unchanged');
  assert.equal(root.children[1].children[1].children.length, 0);
  assert.equal(mock.reads(), 1, 'the browser’s bookmarks are read once, to look for ones to import');
  // The status toast expires after six seconds; leave the document alive
  // until the module's pending timer has completed.
  await new Promise(resolve => setTimeout(resolve, 6100));
  dom.window.close();
});

test('Add to Marked suggests tags and saves the abstract, note, and tags; X posts embed only in the gallery', async () => {
  const pageURL = 'https://example.com/post';
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: `https://extension.local/manager.html?add=${encodeURIComponent(pageURL)}&title=${encodeURIComponent('Machine learning notes')}&capture=capture-1` });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  const $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const mock = fixture({ id: 'root________', children: [{ id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks', children: [] }] });
  const session = { 'capture-1': { url: pageURL, abstract: 'Agents that learn by imagining outcomes.', highlight: '  A key   passage. ', createdAt: Date.now() } };
  mock.api.storage.session = { get: async key => ({ [key]: session[key] }), remove: async key => { delete session[key]; } };
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  await import('../manager.js?add');
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  const submit = () => $('editor-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('editor-form').querySelector('[type=submit]') }));
  const chips = () => [...document.querySelectorAll('#edit-tags .tag-option')];
  const pressed = () => chips().filter(chip => chip.getAttribute('aria-pressed') === 'true').map(chip => chip.textContent);
  await settle();
  assert.ok($('editor').open);
  assert.equal($('edit-abstract').value, 'Agents that learn by imagining outcomes.');
  assert.deepEqual(session, {}, 'the capture is consumed');
  assert.deepEqual(pressed(), ['AI'], 'tags are suggested from the title');
  assert.match($('tags-hint').textContent, /Suggested .*AI/);
  chips().find(chip => chip.textContent === 'Technology').click();
  $('new-tag').value = 'Robotics';
  const enter = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  $('new-tag').dispatchEvent(enter);
  assert.equal(enter.defaultPrevented, true, 'Enter adds the tag instead of submitting');
  assert.deepEqual(pressed(), ['Technology', 'AI', 'Robotics']);
  assert.equal($('highlight-field').hidden, false, 'a highlight from the page is shown in the editor');
  assert.equal($('edit-highlight').textContent, 'A key passage.');
  $('edit-highlight-note').value = 'Why it matters';
  $('edit-note').value = '  Read before the meetup ';
  $('edit-abstract').value += ' Edited.';
  submit(); await settle();
  const saved = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY].root.children.find(node => node.url === pageURL);
  assert.equal(saved.abstract, 'Agents that learn by imagining outcomes. Edited.');
  assert.equal(saved.note, 'Read before the meetup');
  assert.deepEqual(saved.tags, ['AI', 'Technology', 'Robotics']);
  assert.deepEqual(saved.highlights.map(({ text, note }) => ({ text, note })), [{ text: 'A key passage.', note: 'Why it matters' }]);
  const row = $('items').querySelector('tr');
  assert.deepEqual([...row.querySelectorAll('.tag')].map(tag => tag.textContent), ['AI', 'Technology', 'Robotics']);
  assert.equal(row.querySelector('.item-note').textContent, 'Read before the meetup');
  row.querySelector('.note-chip').click();
  assert.ok($('note-dialog').open, 'the Note marker opens the full note');
  assert.deepEqual([$('note-title').textContent, $('note-site').textContent], [saved.title, new URL(pageURL).hostname.replace(/^www\./, '')], 'the bookmark heads the note');
  assert.equal($('note-text').textContent, 'Read before the meetup');
  $('note-edit').click();
  assert.ok($('editor').open && !$('note-dialog').open);
  assert.equal($('edit-note').value, 'Read before the meetup');
  $('editor').close();
  const robotics = [...document.querySelectorAll('#tag-list .folder-link')].find(link => link.title === 'Robotics');
  assert.equal(robotics.querySelector('.count').textContent, '1');
  robotics.click();
  assert.equal($('page-title').textContent, 'Robotics');
  assert.equal($('items').children.length, 1);
  $('sidebar-add-tag').click();
  assert.ok($('tag-dialog').open);
  $('tag-name').value = 'Cooking';
  $('tag-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('tag-form').querySelector('[type=submit]') }));
  await settle();
  assert.ok(!$('tag-dialog').open);
  assert.ok([...document.querySelectorAll('#tag-list .folder-link')].some(link => link.title === 'Cooking'), 'the new tag is listed');
  $('all-bookmarks').click();
  $('search').value = 'meetup'; $('search').dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal($('items').children.length, 1, 'search matches notes');
  $('search').value = ''; $('search').dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 150));
  $('new-bookmark').click();
  $('edit-name').value = 'Post on X'; $('edit-url').value = 'https://x.com/jack/status/20';
  submit(); await settle();
  assert.equal(document.querySelectorAll('iframe').length, 0, 'the list view does not contact X');
  $('gallery-view').click();
  const frames = [...document.querySelectorAll('iframe.tweet-embed')];
  assert.equal(frames.length, 1);
  assert.equal(frames[0].src, 'https://platform.twitter.com/embed/Tweet.html?id=20&dnt=true');
  $('list-view').click();
  await new Promise(resolve => setTimeout(resolve, 6100));
  dom.window.close();
});

test('a highlights label opens the list of highlights, where each can be deleted', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  const $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const highlights = [{ id: 'h1', text: 'First passage', note: 'Why', createdAt: Date.now() }, { id: 'h2', text: 'Second passage', createdAt: Date.now() }];
  const mock = fixture({ id: 'root________', children: [{ id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks', children: [
    { id: 'a', parentId: 'unfiled_____', title: 'Essay', url: 'https://example.com/', type: 'bookmark', highlights }
  ] }] });
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  await import('../manager.js?highlights');
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  await settle();
  const chip = () => document.querySelector('#items .highlight-chip');
  assert.equal(chip().textContent, '2 highlights');
  chip().click();
  assert.ok($('highlights-dialog').open);
  assert.deepEqual([...$('highlights-list').querySelectorAll('.quote')].map(quote => quote.textContent), ['First passage', 'Second passage']);
  assert.equal($('highlights-list').querySelector('.highlight-note').textContent, 'Why');
  $('highlights-list').querySelector('.item-action').click(); await settle();
  assert.equal(chip().textContent, '1 highlight');
  assert.deepEqual([...$('highlights-list').querySelectorAll('.quote')].map(quote => quote.textContent), ['Second passage']);
  $('highlights-list').querySelector('.item-action').click(); await settle();
  assert.equal(chip(), null);
  assert.ok(!$('highlights-dialog').open, 'the list closes when its last highlight is deleted');
  $('search').value = 'second'; $('search').dispatchEvent(new dom.window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal($('items').children.length, 0, 'deleted highlights are no longer searchable');
  dom.window.close();
});

test('semantic search: add a key, ask Jev only when Semantic is chosen, reuse repeats, keep a running cost, and preview without a key', async t => {
  const log = t.mock.method(console, 'log', () => {}); // Jev requests are logged; keep the output quiet.
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  const $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const mock = fixture({ id: 'root________', children: [{ id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks', children: [
    { id: 'pasta', parentId: 'unfiled_____', title: 'Weeknight pasta', url: 'https://food.test/pasta', type: 'bookmark' },
    { id: 'essay', parentId: 'unfiled_____', title: 'On attention', url: 'https://example.com/essays/attention?session=secret', type: 'bookmark', abstract: 'Deciding what deserves your attention.' }
  ] }] });
  const permissions = [];
  mock.api.permissions = { request: async request => { permissions.push(request); return true; } };
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  // A stand-in for api.typesafe.ai that favours bookmarks about attention.
  const requests = [];
  let status = 200;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, auth: init.headers.Authorization });
    if (status !== 200) return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status });
    if (body.questions.check) return new Response(JSON.stringify({ answers: { check: { type: 'noul', noul: 0.8 } }, usage: { input_tokens: 40, output_tokens: 5 } }));
    const lines = body.state.split('\n').map(line => line.split('| '));
    const probabilities = Object.fromEntries(lines.map(([id, text]) => [id, text.includes('attention') ? 0.9 : 0.1 / (lines.length - 1)]));
    return new Response(JSON.stringify({ answers: { where: { type: 'choice', probabilities }, exists: { type: 'noul', noul: 0.93 } }, usage: { input_tokens: 2000, output_tokens: 30 } }));
  };
  await import('../manager.js?semantic');
  const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
  const type = async query => { $('search').value = query; $('search').dispatchEvent(new dom.window.Event('input')); await settle(550); };
  const search = async query => { await type(query); $('semantic-toggle').click(); await settle(50); };
  const pressed = () => $('semantic-toggle').getAttribute('aria-pressed');
  const titles = () => [...$('items').querySelectorAll('.item-title')].map(link => link.textContent);
  await settle();

  assert.equal($('semantic-toggle').getAttribute('aria-pressed'), 'false');
  $('semantic-toggle').click();
  assert.ok($('settings-dialog').open, 'Semantic without a key asks for one');
  assert.match($('settings-status').textContent, /Add your TypeSafe API key/);
  $('jev-key').value = '  sk-test  ';
  $('settings-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('settings-form').querySelector('[type=submit]') }));
  await settle(50);
  assert.ok(!$('settings-dialog').open);
  assert.deepEqual(permissions, [{ origins: ['https://api.typesafe.ai/*'] }]);
  assert.equal(requests[0].auth, 'Bearer sk-test', 'the key is checked before it is saved');
  assert.deepEqual((await browser.storage.local.get()).markedJev, { apiKey: 'sk-test', notes: true, highlights: true, preview: false });
  assert.equal(pressed(), 'false');

  await type('protecting my focus');
  assert.equal(requests.length, 1, 'typing alone never asks Jev');
  $('semantic-toggle').click(); await settle(50);
  assert.equal(requests.length, 2, 'choosing Semantic asks once');
  assert.equal(pressed(), 'true');
  assert.equal(requests[1].body.state, 'B000| Weeknight pasta\nB001| On attention; Deciding what deserves your attention.', 'no address, folder, or tags');
  assert.deepEqual(titles(), ['On attention'], 'found by meaning with no keyword in common');
  assert.equal($('semantic-status').textContent, 'Ranked by meaning with Jev. This search $0.000084 · $0.000086 in total.', 'the key check counts toward the total');

  await type('protecting my focus at work');
  assert.equal(requests.length, 2, 'editing the query asks nothing');
  assert.ok(pressed() === 'false' && $('semantic-status').hidden, 'and keyword matches return');
  await search('protecting my focus');
  assert.equal(requests.length, 2, 'a repeated search is answered from the cache');
  assert.match($('semantic-status').textContent, /Repeated search, no charge/);
  $('semantic-toggle').click(); await settle(50);
  assert.ok(pressed() === 'false' && $('semantic-status').hidden, 'choosing Semantic again goes back to keyword matches');
  assert.deepEqual(titles(), []);
  await search('ab');
  assert.equal(requests.length, 2, 'too short to ask');
  assert.equal($('toast').textContent, 'Type what you’re looking for, then choose Semantic.');

  status = 401;
  await search('pasta');
  assert.match($('semantic-status').textContent, /didn't run: TypeSafe rejected the API key.*Showing keyword matches\./);
  assert.deepEqual(titles(), ['Weeknight pasta'], 'keyword matches still show');

  $('settings').click();
  assert.match($('jev-usage').textContent, /^2 requests · 2,040 input tokens · \$0\.000086 since /);
  $('jev-reset').click(); await settle();
  assert.equal($('jev-usage').textContent, 'No requests yet.');
  $('jev-remove').click(); await settle();
  assert.equal($('semantic-toggle').getAttribute('aria-pressed'), 'false');
  assert.equal((await browser.storage.local.get()).markedJev.apiKey, '');

  // Preview needs no key: each search logs the request Jev would get and sends nothing.
  $('settings').click(); await settle();
  assert.match($('jev-estimate').textContent, /^Each search of your 2 bookmarks costs about \$0\.0000\d+ \(≈\d{3} input tokens; output is free\)\.$/);
  $('jev-preview').checked = true;
  $('settings-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('settings-form').querySelector('[type=submit]') }));
  await settle(50);
  assert.ok(!$('settings-dialog').open);
  const sent = requests.length;
  log.mock.resetCalls();
  await search('attention');
  assert.equal(requests.length, sent, 'nothing is sent');
  const [label, { headers, body }] = log.mock.calls.at(-1).arguments;
  assert.equal(label, 'Jev request (preview, not sent): POST https://api.typesafe.ai/v1/systemone');
  assert.equal(headers.Authorization, 'Bearer <your API key>');
  assert.equal(body.state, 'B000| Weeknight pasta\nB001| On attention; Deciding what deserves your attention.');
  const tokens = estimateJevTokens(body);
  assert.equal($('semantic-status').textContent, `Preview only: nothing was sent to TypeSafe. This search would cost about ${formatCost(jevCost(tokens))} (≈${tokens} input tokens; output is free). The request is in the browser console. Showing keyword matches.`);
  assert.deepEqual(titles(), ['On attention'], 'keyword matches show');
  delete globalThis.fetch;
  dom.window.close();
});

test('first run: asks once to import the browser’s bookmarks, keeping their folders; Settings imports later ones', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  const $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const firefox = { id: 'root________', children: [
    { id: 'toolbar_____', parentId: 'root________', title: 'Bookmarks Toolbar', type: 'folder', children: [{ id: 't1', title: 'MDN', url: 'https://developer.mozilla.org/', type: 'bookmark', dateAdded: 1600000000000 }] },
    { id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks', type: 'folder', children: [
      { id: 'f1', title: 'Recipes', type: 'folder', children: [{ id: 'r1', title: 'Pasta', url: 'https://food.test/pasta', type: 'bookmark' }] },
      { id: 'q1', title: 'Most Visited', url: 'place:sort=8&maxResults=10', type: 'bookmark' }
    ] }
  ] };
  const mock = fixture(null, firefox);
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  await import('../manager.js?first-run');
  const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
  await settle();
  const saved = async () => (await browser.storage.local.get())[STORAGE_KEY].root;

  assert.equal($('items').children.length, 0, 'the library starts empty');
  assert.ok($('browser-import-dialog').open, 'the first visit asks');
  assert.equal($('browser-import-title').textContent, 'Import bookmarks from your browser?');
  assert.equal($('browser-import-text').textContent, 'Marked found 2 bookmarks in your browser. Import them, keeping their folders? Nothing changes in your browser.');
  assert.equal($('browser-import-accept').textContent, 'Import 2 bookmarks');
  $('browser-import-accept').click(); await settle();
  assert.ok(!$('browser-import-dialog').open);
  const root = await saved();
  assert.deepEqual(root.children.map(folder => folder.title), ['Bookmarks Toolbar', 'Other Bookmarks']);
  assert.deepEqual(root.children[0].children.map(node => [node.title, node.url, node.dateAdded]), [['MDN', 'https://developer.mozilla.org/', 1600000000000]]);
  assert.deepEqual(root.children[1].children.map(node => node.title), ['Recipes'], 'unsupported addresses are left out');
  assert.equal(root.children[1].children[0].children[0].title, 'Pasta');
  assert.equal($('toast').textContent, 'Imported 2 bookmarks from your browser.');
  assert.equal($('items').children.length, 2, 'the imported folders show');
  const sidebar = () => [...$('folder-tree').querySelectorAll('.folder-row')].map(row => [row.querySelector('.folder-name').textContent, row.querySelector('.count').textContent]);
  assert.deepEqual(sidebar(), [['Bookmarks Toolbar', '1'], ['Other Bookmarks', '1']], 'a folder counts the bookmarks in its subfolders');
  assert.ok((await browser.storage.local.get()).markedBrowserImportAsked, 'answered, so Marked won’t ask on its own again');

  // Later, Settings imports only what's new, and says when nothing is.
  firefox.children[1].children[0].children.push({ id: 'r2', title: 'Soup', url: 'https://food.test/soup', type: 'bookmark' });
  $('settings').click(); $('browser-import-open').click(); await settle();
  assert.ok(!$('settings-dialog').open && $('browser-import-dialog').open);
  assert.equal($('browser-import-text').textContent, 'Marked found 1 bookmark in your browser that isn’t in Marked yet. Import it, keeping its folder? Nothing changes in your browser.');
  $('browser-import-dialog').close(); await settle();
  assert.equal($('toast').textContent, 'You can import them later from Settings.');
  $('settings').click(); $('browser-import-open').click(); await settle();
  $('browser-import-accept').click(); await settle();
  assert.deepEqual((await saved()).children[1].children[0].children.map(node => node.title), ['Pasta', 'Soup'], 'into the folder it already has');
  assert.deepEqual(sidebar(), [['Bookmarks Toolbar', '1'], ['Other Bookmarks', '2']]);
  $('settings').click(); $('browser-import-open').click(); await settle();
  assert.ok(!$('browser-import-dialog').open);
  assert.equal($('toast').textContent, 'Every bookmark in your browser is already in Marked.');
  dom.window.close();
});
