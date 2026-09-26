import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { fixture } from './storage-fixture.js';
import { STORAGE_KEY } from '../store.js';
import { estimateJevTokens, jevCost, formatCost } from '../jev.js';
import { Readability } from '@mozilla/readability';

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
  const card = $('items').querySelector('.card-preview');
  assert.deepEqual([card.textContent, card.classList.contains('letter-preview')], ['E', true], 'a card without a screenshot shows the site’s letter');
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
  const session = { 'capture-1': { url: pageURL, abstract: 'Agents that learn by imagining outcomes.', highlight: '  A key   passage. ', text: { text: 'The whole post, word for word.', words: 6 }, createdAt: Date.now() } };
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
  $('edit-highlight-colors').querySelector('.hl-green').click();
  assert.ok($('edit-highlight').classList.contains('hl-green'), 'the passage shows the color chosen for it');
  $('edit-highlight-note').value = 'Why it matters';
  $('edit-note').value = '  Read before the meetup ';
  $('edit-abstract').value += ' Edited.';
  submit(); await settle();
  const saved = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY].root.children.find(node => node.url === pageURL);
  assert.equal(saved.abstract, 'Agents that learn by imagining outcomes. Edited.');
  assert.equal(saved.note, 'Read before the meetup');
  assert.deepEqual(saved.tags, ['AI', 'Technology', 'Robotics']);
  assert.deepEqual(saved.highlights.map(({ text, note, color }) => ({ text, note, color })), [{ text: 'A key passage.', note: 'Why it matters', color: 'green' }]);
  const { capturedAt, ...text } = (await browser.storage.local.get())[`markedText:${saved.id}`];
  assert.deepEqual(text, { via: 'page', text: 'The whole post, word for word.', words: 6 }, 'the page’s text is kept with it');
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
    { id: 'essay', parentId: 'unfiled_____', title: 'On attention', url: 'https://example.com/essays/attention?session=secret', type: 'bookmark', abstract: 'Deciding what deserves your attention.', note: 'Reread before the weekly review.', highlights: [{ id: 'h1', text: 'Deciding is the hard part.' }] }
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
  assert.ok(!$('settings-semantic').hidden && $('settings-tab-semantic').getAttribute('aria-selected') === 'true', 'in the Semantic search section');
  assert.match($('settings-status').textContent, /Add your TypeSafe API key/);
  $('jev-key').value = '  sk-test  ';
  $('settings-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('settings-form').querySelector('[type=submit]') }));
  await settle(50);
  assert.ok(!$('settings-dialog').open);
  assert.deepEqual(permissions, [{ origins: ['https://api.typesafe.ai/*'] }]);
  assert.equal(requests[0].auth, 'Bearer sk-test', 'the key is checked before it is saved');
  assert.deepEqual((await browser.storage.local.get()).markedJev, { apiKey: 'sk-test', notes: false, highlights: false, preview: false }, 'notes and highlights stay home until turned on');
  assert.ok(!$('jev-notes').checked && !$('jev-highlights').checked);
  assert.equal(pressed(), 'false');

  await type('protecting my focus');
  assert.equal(requests.length, 1, 'typing alone never asks Jev');
  $('semantic-toggle').click(); await settle(50);
  assert.equal(requests.length, 2, 'choosing Semantic asks once');
  assert.equal(pressed(), 'true');
  assert.equal(requests[1].body.state, 'B000| Weeknight pasta\nB001| On attention; Deciding what deserves your attention.', 'no address, folder, or tags, and no note or highlight until they are turned on');
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
  assert.ok($('settings-dialog').open && $('settings-status').textContent === 'Key removed.', 'Settings stay open');

  // Preview needs no key: each search logs the request Jev would get and sends nothing.
  assert.match($('jev-estimate').textContent, /^Each search of your 2 bookmarks costs about \$0\.0000\d+ \(≈\d{3} input tokens; output is free\)\.$/);
  $('jev-preview').click(); await settle(50);
  assert.equal((await browser.storage.local.get()).markedJev.preview, true, 'options apply as soon as they change');
  $('settings-dialog').close();
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

test('links from the address bar search, a saved page opens its bookmark, and tabs save to a folder and reopen', async () => {
  const library = () => ({ id: 'root', children: [{ id: 'reading', parentId: 'root', title: 'Reading', type: 'folder', children: [
    { id: 'essay', parentId: 'reading', title: 'On attention', url: 'https://example.com/essay', type: 'bookmark' },
    { id: 'pasta', parentId: 'reading', title: 'Weeknight pasta', url: 'https://food.test/pasta', type: 'bookmark' }
  ] }] });
  async function open(search, name) {
    const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: `https://extension.local/manager.html${search}` });
    globalThis.document = dom.window.document;
    globalThis.DOMParser = dom.window.DOMParser;
    dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
    const mock = fixture(library());
    globalThis.browser = mock.api;
    Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
    await import(`../manager.js?${name}`);
    await new Promise(resolve => setTimeout(resolve, 30));
    return { dom, mock, $: id => document.getElementById(id) };
  }
  const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));

  let { dom, $ } = await open('?q=pasta', 'omnibox');
  assert.equal($('search').value, 'pasta');
  assert.deepEqual([...$('items').querySelectorAll('.item-title')].map(link => link.textContent), ['Weeknight pasta']);
  assert.equal(dom.window.location.search, '', 'a refresh doesn’t repeat it');
  dom.window.close();

  ({ dom, $ } = await open('?folder=reading', 'folder'));
  assert.equal($('page-title').textContent, 'Reading', 'a link can open a folder, as an import’s does');
  dom.window.close();

  ({ dom, $ } = await open('?edit=essay', 'edit'));
  assert.ok($('editor').open);
  assert.equal($('editor-title').textContent, 'Edit bookmark');
  assert.equal($('edit-name').value, 'On attention');
  dom.window.close();

  let mock;
  ({ dom, $, mock } = await open('', 'tabs'));
  assert.equal($('open-all').hidden, true, 'never offered for the whole library');
  const created = [], removed = [], requested = [];
  mock.api.permissions = { request: async request => { requested.push(request); return true; } };
  const shown = { 2: 'https://a.test/', 5: 'https://b.test/path' };
  mock.api.scripting = { executeScript: async ({ target, func }) => [{ result: func ? { url: shown[target.tabId], text: `The text of tab ${target.tabId}.` } : undefined }] };
  mock.api.tabs = {
    getCurrent: async () => ({ id: 1 }),
    query: async () => [
      { id: 1, url: 'moz-extension://marked/manager.html', title: 'Marked' },
      { id: 2, url: 'https://a.test/', title: 'Page A' },
      { id: 3, url: 'https://a.test/', title: 'Page A again' },
      { id: 4, url: 'about:config', title: 'Settings' },
      { id: 5, url: 'https://b.test/path', title: '' }
    ],
    remove: async ids => { removed.push(...ids); },
    create: async details => { created.push(details); }
  };
  $('save-tabs').click(); await settle();
  assert.deepEqual(requested, [{ origins: ['<all_urls>'] }], 'Firefox needs site access to read tab addresses');
  assert.ok($('tabs-dialog').open);
  assert.equal($('tabs-text').textContent, 'Save the 2 pages open in this window to a new folder in Library?', 'web pages only, once each, never Marked itself');
  $('tabs-close').checked = true;
  $('tabs-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('tabs-save') }));
  await settle(150);
  const folder = (await mock.api.storage.local.get()).markedLibraryV1.root.children.at(-1);
  assert.match(folder.title, /^Tabs · /);
  assert.deepEqual(folder.children.map(node => [node.title, node.url]), [['Page A', 'https://a.test/'], ['https://b.test/path', 'https://b.test/path']]);
  assert.deepEqual(removed, [2, 5], 'closed after saving, as asked');
  const stored = await mock.api.storage.local.get();
  assert.deepEqual(folder.children.map(node => [stored[`markedText:${node.id}`].text, stored[`markedText:${node.id}`].via]), [['The text of tab 2.', 'tabs'], ['The text of tab 5.', 'tabs']], 'each page’s text, read from its tab before it closed');
  assert.equal($('page-title').textContent, folder.title, 'the new folder opens');
  assert.equal($('open-all').hidden, false);
  $('open-all').click(); await settle();
  assert.deepEqual(created, [{ url: 'https://a.test/', active: false }, { url: 'https://b.test/path', active: false }]);
  dom.window.close();
});

async function openManager(library, name, stored = {}, setup) {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const mock = fixture(library);
  mock.api.storage.local.set({ markedBrowserImportAsked: 1, ...stored });
  setup?.(mock.api);
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  await import(`../manager.js?${name}`);
  await new Promise(resolve => setTimeout(resolve, 30));
  const $ = id => document.getElementById(id);
  const key = (init, target = document) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const type = text => { $('palette-input').value = text; $('palette-input').dispatchEvent(new dom.window.Event('input')); };
  const labels = () => [...document.querySelectorAll('#palette-list .palette-label')].map(label => label.textContent);
  return { dom, mock, $, key, type, labels, settle: (ms = 30) => new Promise(resolve => setTimeout(resolve, ms)) };
}

test('an empty library welcomes you; the palette jumps anywhere; themes and shortcuts', async () => {
  let { dom, $ } = await openManager({ id: 'root', children: [] }, 'welcome');
  assert.equal($('welcome').hidden, false);
  assert.equal(document.querySelector('#empty h2').textContent, 'Welcome to Marked');
  assert.equal($('welcome-tips').children.length, 4);
  $('welcome-add').click();
  assert.ok($('editor').open, 'Add a bookmark opens the editor');
  dom.window.close();

  const opened = [];
  const page = await openManager({ id: 'root', children: [{ id: 'reading', parentId: 'root', title: 'Reading', type: 'folder', children: [
    { id: 'pasta', parentId: 'reading', title: 'Weeknight pasta', url: 'https://food.test/pasta', type: 'bookmark', dateAdded: 2 },
    { id: 'essay', parentId: 'reading', title: 'On attention', url: 'https://example.com/essay', type: 'bookmark', dateAdded: 1 }
  ] }] }, 'palette');
  ({ dom, $ } = page);
  page.mock.api.tabs = { create: async details => { opened.push(details); } };
  assert.equal($('welcome').hidden, true);

  page.key({ key: 'k', metaKey: true });
  assert.ok($('palette').open, '⌘K opens the palette');
  assert.deepEqual(page.labels().slice(0, 2), ['Weeknight pasta', 'On attention'], 'newest bookmarks first, then commands');
  assert.ok(page.labels().includes('Save open tabs'));
  page.type('past');
  assert.equal(page.labels()[0], 'Weeknight pasta');
  page.key({ key: 'Enter' }, $('palette-input'));
  await page.settle();
  assert.ok(!$('palette').open);
  assert.deepEqual(opened, [{ url: 'https://food.test/pasta' }], 'Enter opens the bookmark');

  page.key({ key: 'k', ctrlKey: true });
  page.type('read');
  assert.equal(page.labels()[0], 'Reading');
  page.key({ key: 'Enter' }, $('palette-input'));
  assert.equal($('page-title').textContent, 'Reading', 'a folder opens');

  page.key({ key: 'k', metaKey: true });
  page.type('dark');
  assert.equal(page.labels()[0], 'Use the dark theme');
  page.key({ key: 'Enter' }, $('palette-input'));
  assert.equal(document.documentElement.dataset.theme, 'dark');
  assert.equal(dom.window.localStorage.getItem('markedTheme'), 'dark');
  page.key({ key: 'k', metaKey: true });
  page.type('zzqx');
  assert.equal($('palette-list').textContent, 'Nothing matches. Try other words.');
  page.key({ key: 'k', metaKey: true });
  assert.ok(!$('palette').open, '⌘K again closes it');

  $('settings').click();
  const panels = () => [...document.querySelectorAll('.settings-panels [role="tabpanel"]')].filter(panel => !panel.hidden).map(panel => panel.id);
  assert.deepEqual(panels(), ['settings-appearance'], 'Settings opens on its first section');
  page.key({ key: 'ArrowDown' }, $('settings-tab-appearance'));
  assert.deepEqual(panels(), ['settings-browser'], 'the arrow keys move through the sections');
  assert.equal(document.activeElement, $('settings-tab-browser'));
  page.key({ key: 'ArrowUp' }, $('settings-tab-browser'));
  assert.deepEqual(panels(), ['settings-appearance']);
  document.querySelector('[data-theme-choice="system"]').click();
  assert.equal(document.documentElement.dataset.theme, undefined, 'System follows the computer');
  assert.equal(document.querySelector('[data-theme-choice="system"]').getAttribute('aria-checked'), 'true');
  $('settings-dialog').close();

  // A real browser returns focus to the page when a dialog closes.
  document.activeElement.blur();
  page.key({ key: '?' });
  assert.ok($('shortcuts-dialog').open);
  assert.equal($('shortcuts-list').querySelectorAll('dt').length, 9);
  dom.window.localStorage.clear();
  dom.window.close();
});

test('duplicates merge into one bookmark; Rediscover picks old ones; notes export as Markdown', async t => {
  const old = Date.now() - 30 * 864e5;
  const page = await openManager({ id: 'root', children: [{ id: 'reading', parentId: 'root', title: 'Reading', type: 'folder', children: [
    { id: 'a', parentId: 'reading', title: 'On attention', url: 'https://example.com/post', type: 'bookmark', dateAdded: old, note: 'Why I saved it.', tags: ['Essays'] },
    { id: 'b', parentId: 'reading', title: 'On attention, again', url: 'https://www.example.com/post/#top', type: 'bookmark', dateAdded: old + 1000, highlights: [{ id: 'h', text: 'A passage.', createdAt: 1 }] },
    { id: 'c', parentId: 'reading', title: 'Weeknight pasta', url: 'https://food.test/pasta', type: 'bookmark', dateAdded: Date.now() }
  ] }] }, 'duplicates');
  const { dom, $ } = page;
  const titles = () => [...$('items').querySelectorAll('.item-title')].map(link => link.textContent);
  assert.equal($('duplicates-nav').hidden, false);
  assert.equal($('duplicates-count').textContent, '1');
  $('duplicates-nav').click();
  assert.equal($('page-title').textContent, 'Duplicates');
  assert.deepEqual(titles(), ['On attention', 'On attention, again'], 'oldest first');
  assert.equal($('items').querySelector('.merge-chip').textContent, 'Merge 2 copies');
  $('merge-all').click(); await page.settle();
  $('confirm-dialog').returnValue = 'accept'; $('confirm-dialog').close(); await page.settle(60);
  const saved = (await browser.storage.local.get()).markedLibraryV1.root.children[0].children;
  assert.deepEqual(saved.map(node => node.id), ['a', 'c']);
  assert.deepEqual([saved[0].note, saved[0].highlights.map(h => h.text)], ['Why I saved it.', ['A passage.']]);
  assert.equal($('toast').textContent, 'Merged 1 copy.');
  assert.equal(document.querySelector('#empty h2').textContent, 'No duplicates');

  $('rediscover-nav').click();
  assert.equal($('page-title').textContent, 'Rediscover');
  assert.ok($('rediscover-nav').classList.contains('active'));
  assert.deepEqual(titles(), ['On attention'], 'only bookmarks saved more than two weeks ago');
  assert.equal($('shuffle').hidden, false);

  let exported;
  t.mock.method(URL, 'createObjectURL', blob => { exported = blob; return 'blob:marked'; });
  $('export-markdown').click();
  const markdown = await exported.text();
  assert.match(markdown, /^# Notes and highlights from Marked/);
  assert.match(markdown, /## \[On attention\]\(https:\/\/example\.com\/post\)\n\n\*Reading · #Essays\*\n\nWhy I saved it\.\n\n> A passage\./);
  assert.ok(!markdown.includes('pasta'), 'only bookmarks with notes or highlights');
  dom.window.close();
});

const essay = 'Attention is the currency of a working life.\n\nMost of it is spent before we notice, on things that ask loudly.\n\nA saved link is a promise to your future self.';
test('search finds words in the text saved from pages, shows where, and opens the text there', async () => {
  const page = await openManager({ id: 'root', children: [{ id: 'reading', parentId: 'root', title: 'Reading', type: 'folder', children: [
    { id: 'essay', parentId: 'reading', title: 'On attention', url: 'https://example.com/essay', type: 'bookmark', dateAdded: 3, highlights: [{ id: 'h', text: 'A saved link is a promise to your future self.', createdAt: 1 }] },
    { id: 'loud', parentId: 'reading', title: 'Things that ask loudly', url: 'https://loud.test/', type: 'bookmark', dateAdded: 1 },
    { id: 'pasta', parentId: 'reading', title: 'Weeknight pasta', url: 'https://food.test/pasta', type: 'bookmark', dateAdded: 2 }
  ] }] }, 'page-text', { 'markedText:essay': { text: essay, words: 800, capturedAt: Date.UTC(2026, 8, 1, 12), via: 'page', byline: 'Ada Writer' } });
  const { dom, $ } = page;
  const titles = () => [...$('items').querySelectorAll('.item-title')].map(link => link.textContent);
  const search = async query => { $('search').value = query; $('search').dispatchEvent(new dom.window.Event('input')); await page.settle(150); };
  const read = $('items').querySelector('.item-read');
  assert.equal(read.textContent, '3 min read', 'a bookmark with its page’s text shows how long it is');
  assert.equal($('items').querySelectorAll('.item-read').length, 1);

  await search('loudly');
  assert.deepEqual(titles(), ['Things that ask loudly', 'On attention'], 'matches in a bookmark’s own details come first');
  const passage = $('items').querySelector('.item-passage');
  assert.equal(passage.textContent, 'Most of it is spent before we notice, on things that ask loudly.', 'with the passage from the page');
  assert.deepEqual([...passage.querySelectorAll('mark.term')].map(mark => mark.textContent), ['loudly']);
  await search('"working life" attention');
  assert.deepEqual(titles(), ['On attention'], 'every word or quoted phrase, from the details and the page together');
  await search('currency pasta');
  assert.deepEqual(titles(), [], 'but all of them in one bookmark');

  await search('currency');
  assert.equal($('items').querySelector('.item-passage').href, 'https://extension.local/reader.html?id=essay&q=currency', 'the passage opens the reader at the match');
  await search('');
  assert.equal($('items').querySelector('.item-read').href, 'https://extension.local/reader.html?id=essay', 'the reading time opens the reader');
  assert.equal($('continue-nav').hidden, true, 'nothing started yet');
  page.dom.window.close();

  // Part-read in the reader: minutes left, and a place in Continue reading.
  const later = await openManager({ id: 'root', children: [{ id: 'essay', parentId: 'root', title: 'On attention', url: 'https://example.com/essay', type: 'bookmark' }, { id: 'done', parentId: 'root', title: 'Finished', url: 'https://done.test/', type: 'bookmark' }] }, 'page-text-reading', {
    'markedText:essay': { text: essay, words: 800, capturedAt: 1 }, 'markedText:done': { text: essay, words: 100, capturedAt: 1 },
    markedReadingV1: { essay: { p: 0.4, i: 1, at: 5 }, done: { p: 1, i: 2, at: 6 } }
  });
  const reads = () => [...later.$('items').querySelectorAll('.item-read')].map(link => [link.textContent, link.className]);
  assert.deepEqual(reads(), [['2 min left', 'item-read reading'], ['Read', 'item-read read']]);
  assert.equal(later.$('continue-count').textContent, '1');
  later.$('continue-nav').click();
  assert.equal(later.$('page-title').textContent, 'Continue reading');
  assert.deepEqual([...later.$('items').querySelectorAll('.item-title')].map(link => link.textContent), ['On attention']);
  later.dom.window.close();
});

test('Settings shows how much page text is kept, downloads it for older bookmarks, and deletes it', async () => {
  globalThis.Readability = Readability;
  const page = await openManager({ id: 'root', children: [
    { id: 'a', parentId: 'root', title: 'Has text', url: 'https://a.test/', type: 'bookmark' },
    { id: 'b', parentId: 'root', title: 'Article', url: 'https://b.test/article', type: 'bookmark' },
    { id: 'c', parentId: 'root', title: 'Gone', url: 'https://c.test/gone', type: 'bookmark' },
    { id: 'x', parentId: 'root', title: 'Post', url: 'https://x.com/jack/status/20', type: 'bookmark' },
    { id: 'f', parentId: 'root', title: 'Notes', url: 'file:///notes.txt', type: 'bookmark' }
  ] }, 'text-settings', { 'markedText:a': { text: 'Already here.', words: 2, capturedAt: 1 } });
  const { dom, $ } = page;
  const requested = [], fetched = [];
  page.mock.api.permissions = { request: async request => { requested.push(request); return true; } };
  globalThis.fetch = async (url, init) => {
    fetched.push([url, init.credentials]);
    return url.includes('gone') ? new Response('', { status: 404 }) : new Response(`<body><article><h1>Article</h1><p>${essay.replace(/\n\n/g, '</p><p>')}</p></article></body>`, { headers: { 'content-type': 'text/html' } });
  };
  $('settings').click(); $('settings-tab-text').click();
  assert.equal($('settings-text').hidden, false);
  assert.equal($('text-keep').checked, true, 'on unless turned off');
  assert.equal($('text-stats').textContent, '1 of 5 bookmarks · about 1 KB');
  assert.match($('text-missing').textContent, /^2 bookmarks don’t have their text yet\. Marked can download each page from its site\./, 'X posts and files aren’t downloaded');
  assert.equal($('text-download').textContent, 'Download text for 2 bookmarks');

  $('text-download').click(); await page.settle(150);
  assert.deepEqual(requested, [{ origins: ['<all_urls>'] }]);
  assert.deepEqual(fetched.sort(), [['https://b.test/article', 'omit'], ['https://c.test/gone', 'omit']], 'without cookies');
  assert.equal($('text-status').textContent, 'Saved the text of 1 page; 1 couldn’t be read.');
  const stored = await browser.storage.local.get();
  assert.equal(stored['markedText:b'].via, 'download');
  assert.ok(stored['markedText:b'].text.includes('Attention is the currency of a working life.'));
  assert.equal(stored['markedText:c'].error, 'The site answered 404.');
  assert.equal($('text-stats').textContent, '2 of 5 bookmarks · about 1 KB');
  assert.match($('text-missing').textContent, /^1 bookmark doesn’t have its text yet, including 1 that couldn’t be read last time\./);
  assert.equal($('text-progress').hidden, true);

  $('text-keep').click(); await page.settle();
  assert.deepEqual((await browser.storage.local.get()).markedPageText, { keep: false });
  $('text-clear').click(); await page.settle();
  $('confirm-dialog').returnValue = 'accept'; $('confirm-dialog').close(); await page.settle();
  assert.deepEqual(Object.keys(await browser.storage.local.get()).filter(key => key.startsWith('markedText:')), []);
  assert.equal($('text-stats').textContent, '0 of 5 bookmarks');
  assert.equal($('text-status').textContent, 'Deleted the text of 3 pages.');
  delete globalThis.fetch;
  dom.window.close();
});

test('bookmarks drag into folders, arrange by hand in saved order, and move with Alt+arrows', async () => {
  const page = await openManager({ id: 'root', children: [{ id: 'reading', parentId: 'root', title: 'Reading', type: 'folder', children: [
    { id: 'a', parentId: 'reading', title: 'A', url: 'https://a.test/', type: 'bookmark' },
    { id: 'b', parentId: 'reading', title: 'B', url: 'https://b.test/', type: 'bookmark' },
    { id: 'c', parentId: 'reading', title: 'C', url: 'https://c.test/', type: 'bookmark' },
    { id: 'later', parentId: 'reading', title: 'Later', type: 'folder', children: [] }
  ] }] }, 'drag');
  const { dom, $ } = page;
  const saved = async () => { const reading = (await browser.storage.local.get()).markedLibraryV1.root.children[0]; return [reading.children.map(n => n.id).join(''), reading.children.find(n => n.id === 'later').children.map(n => n.id).join('')]; };
  const row = id => [...$('items').rows].find(r => r.dataset.id === id);
  const transfer = () => ({ data: {}, types: [], setData(type, value) { this.data[type] = value; this.types.push(type); }, setDragImage() {} });
  const fire = (target, type, init = {}, dataTransfer = page.transfer) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer });
    target.dispatchEvent(event);
    return event;
  };
  // A row is 40px tall: its top quarter means before, its middle means into a folder.
  const at = (id, fraction) => { const r = row(id); r.getBoundingClientRect = () => ({ top: 0, left: 0, height: 40, width: 400 }); return { clientY: 40 * fraction }; };
  const dragTo = async (from, to, fraction) => {
    page.transfer = transfer();
    fire(row(from), 'dragstart');
    const over = fire(row(to), 'dragover', at(to, fraction));
    const allowed = over.defaultPrevented;
    if (allowed) fire(row(to), 'drop', at(to, fraction));
    fire(document, 'dragend');
    await page.settle();
    return allowed;
  };
  $('folder-tree').querySelector('.folder-link').click();
  $('sort').value = 'default'; $('sort').dispatchEvent(new dom.window.Event('change'));

  page.transfer = transfer();
  fire(row('c'), 'dragstart');
  assert.deepEqual([page.transfer.data['text/uri-list'], page.transfer.data['application/x-marked-items']], ['https://c.test/', 'c'], 'a bookmark drags as its address, too');
  fire(document, 'dragend');
  assert.equal(await dragTo('c', 'a', 0.1), true);
  assert.deepEqual(await saved(), ['cab' + 'later', ''], 'dropped before A');
  assert.equal(await dragTo('c', 'b', 0.9), true);
  assert.deepEqual(await saved(), ['abc' + 'later', ''], 'and after B');
  assert.equal(await dragTo('b', 'later', 0.5), true);
  assert.deepEqual(await saved(), ['aclater', 'b'], 'into a folder');
  assert.equal($('toast').querySelector('span').textContent, 'Moved “B” to “Later”.');
  [...$('toast').querySelectorAll('button')].find(button => button.textContent === 'Undo').click(); await page.settle();
  assert.deepEqual(await saved(), ['abclater', ''], 'Undo puts it back');
  assert.equal($('toast').textContent, 'Moved back.');

  // Onto a folder in the sidebar, with the selection.
  const sidebar = id => [...$('folder-tree').querySelectorAll('.folder-row')].find(r => r.dataset.id === id);
  row('a').querySelector('input').click(); row('c').querySelector('input').click();
  page.transfer = transfer();
  fire(row('a'), 'dragstart');
  assert.equal(page.transfer.data['application/x-marked-items'], 'a,c', 'a selected row carries the selection');
  assert.equal(fire(sidebar('later'), 'dragover').defaultPrevented, true);
  assert.ok(sidebar('later').classList.contains('drop-into'));
  fire(sidebar('later'), 'drop'); fire(document, 'dragend');
  await page.settle();
  assert.deepEqual(await saved(), ['blater', 'ac']);
  assert.equal($('toast').querySelector('span').textContent, 'Moved 2 items to “Later”.');

  // Only saved order can be arranged; a folder can't go inside itself.
  $('sort').value = 'title'; $('sort').dispatchEvent(new dom.window.Event('change'));
  assert.equal(await dragTo('b', 'later', 0.1), true, 'near a folder’s edge still means into it');
  assert.deepEqual(await saved(), ['later', 'acb']);
  sidebar('later').querySelector('.folder-link').click();
  $('sort').value = 'default'; $('sort').dispatchEvent(new dom.window.Event('change'));
  page.transfer = transfer();
  fire(sidebar('later'), 'dragstart');
  assert.equal(fire(sidebar('later'), 'dragover').defaultPrevented, false, 'not into itself');
  assert.equal(fire($('breadcrumbs').querySelector('[data-id="reading"]'), 'dragover').defaultPrevented, true, 'but into the folder around it, from the breadcrumbs');
  fire(document, 'dragend');

  // Alt+arrows move the focused row.
  row('c').querySelector('input').focus();
  row('c').querySelector('input').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true, cancelable: true }));
  await page.settle();
  assert.deepEqual(await saved(), ['later', 'cab']);
  assert.equal(document.activeElement, row('c').querySelector('input'), 'focus stays on the moved row');
  dom.window.close();
});

test('Highlights lists every highlight, newest first, by color, site, time, and search; each can change color or go', async () => {
  const day = 864e5, now = Date.now();
  const page = await openManager({ id: 'root', children: [{ id: 'reading', parentId: 'root', title: 'Reading', type: 'folder', children: [
    { id: 'essay', parentId: 'reading', title: 'On attention', url: 'https://example.com/essay', type: 'bookmark', highlights: [
      { id: 'h1', text: 'Attention is a budget.', note: 'Core idea', createdAt: now - 2 * day },
      { id: 'h2', text: 'A saved link is a promise to your future self, and most of those promises are never kept.', color: 'green', createdAt: now - 40 * day }
    ] },
    { id: 'wiki', parentId: 'reading', title: 'Transformer', url: 'https://en.wikipedia.org/wiki/Transformer', type: 'bookmark', highlights: [
      { id: 'h3', text: 'Self-attention relates positions.', color: 'blue', createdAt: now - day }
    ] },
    { id: 'plain', parentId: 'reading', title: 'Plain', url: 'https://plain.test/', type: 'bookmark' }
  ] }] }, 'highlights-view');
  const { dom, $ } = page;
  const quotes = () => [...$('highlight-list').querySelectorAll('.quote')].map(quote => quote.textContent.slice(0, 22));
  const chips = () => [...$('highlight-colors').children].filter(chip => !chip.hidden).map(chip => chip.getAttribute('aria-label') || chip.textContent);
  const chip = label => [...$('highlight-colors').children].find(item => (item.getAttribute('aria-label') || item.textContent).startsWith(label));
  const change = (id, value) => { $(id).value = value; $(id).dispatchEvent(new dom.window.Event('change')); };
  assert.equal($('highlights-count').textContent, '3');
  $('highlights-nav').click();
  assert.equal($('page-title').textContent, 'Highlights');
  assert.ok(document.querySelector('.table-wrap').hidden && !$('highlight-list').hidden);
  assert.deepEqual(quotes(), ['Self-attention relates', 'Attention is a budget.', 'A saved link is a prom'], 'newest first');
  assert.equal($('highlight-count').textContent, '3 highlights');
  assert.deepEqual(chips(), ['Every color', 'Yellow: 1', 'Green: 1', 'Blue: 1'], 'colors in use, with counts');

  chip('Green').click();
  assert.deepEqual(quotes(), ['A saved link is a prom']);
  chip('Every').click();
  change('highlight-site', 'en.wikipedia.org');
  assert.deepEqual(quotes(), ['Self-attention relates']);
  change('highlight-site', '');
  change('highlight-since', 'month');
  assert.deepEqual(quotes(), ['Self-attention relates', 'Attention is a budget.'], 'past month');
  change('highlight-since', '');
  $('search').value = 'core idea'; $('search').dispatchEvent(new dom.window.Event('input'));
  await page.settle(150);
  assert.equal($('page-title').textContent, 'Highlights', 'the search box searches highlights here');
  assert.deepEqual(quotes(), ['Attention is a budget.'], 'notes count');
  $('search').value = 'zzz'; $('search').dispatchEvent(new dom.window.Event('input'));
  await page.settle(150);
  assert.equal(document.querySelector('#empty h2').textContent, 'No highlights match');
  $('search').value = ''; $('search').dispatchEvent(new dom.window.Event('input'));
  await page.settle(150);

  const [first, , last] = $('highlight-list').children;
  assert.deepEqual([first.querySelector('.highlight-page').textContent, first.querySelector('.highlight-page').href], ['Transformer', 'https://en.wikipedia.org/wiki/Transformer']);
  assert.equal(first.querySelector('.highlight-open').href, 'https://en.wikipedia.org/wiki/Transformer#:~:text=Self%2Dattention%20relates%20positions.', 'the passage opens on its page');
  assert.equal(last.querySelector('.highlight-open').href, 'https://example.com/essay#:~:text=A%20saved%20link%20is%20a,those%20promises%20are%20never%20kept.', 'a long one by its first and last words');
  first.querySelector('.swatch.hl-pink').click(); await page.settle();
  const stored = async () => (await browser.storage.local.get()).markedLibraryV1.root.children[0].children;
  assert.equal((await stored())[1].highlights[0].color, 'pink');
  assert.deepEqual(chips(), ['Every color', 'Yellow: 1', 'Green: 1', 'Pink: 1']);
  $('highlight-list').children[0].querySelector('.item-action').click(); await page.settle();
  assert.equal((await stored())[1].highlights, undefined);
  assert.deepEqual(quotes(), ['Attention is a budget.', 'A saved link is a prom']);
  [...$('toast').querySelectorAll('button')].find(button => button.textContent === 'Undo').click(); await page.settle();
  assert.equal((await stored())[1].highlights[0].text, 'Self-attention relates positions.', 'Undo brings it back');
  assert.equal($('toast').textContent, 'Highlight restored.');
  $('all-bookmarks').click();
  assert.ok(!document.querySelector('.table-wrap').hidden && $('highlight-list').hidden);
  assert.equal($('search').placeholder, 'Search all bookmarks…');
  dom.window.close();
});

test('posts show as cards in the gallery and as stats in the list; downloads and new bookmarks read their sites', async () => {
  const card = { site: 'github', kind: 'issue', title: 'Why Rust?', community: 'rust-lang/rust', number: 12, handle: 'ferris', state: 'open', text: 'Memory safety.', stats: { comments: 1234 }, fetchedAt: 1 };
  const page = await openManager({ id: 'root', children: [
    { id: 'post', parentId: 'root', title: 'Why Rust? · Issue #12', url: 'https://github.com/rust-lang/rust/issues/12', type: 'bookmark', card, dateAdded: 2 },
    { id: 'story', parentId: 'root', title: 'Show HN', url: 'https://news.ycombinator.com/item?id=100', type: 'bookmark', dateAdded: 1 }
  ] }, 'cards', { 'markedText:post': { text: 'Memory safety.', words: 2, capturedAt: 1 } });
  const { dom, $ } = page;
  const row = id => [...$('items').rows].find(r => r.dataset.id === id);
  assert.equal(row('post').querySelector('.item-stats').textContent, 'Open · 1.2K comments');
  $('gallery-view').click();
  const shown = row('post').querySelector('.site-card');
  assert.deepEqual(['where', 'who', 'title', 'state', 'text', 'stats'].map(part => shown.querySelector(`.site-card-${part}`).textContent), ['rust-lang/rust #12', 'ferris', 'Why Rust?', 'Open', 'Memory safety.', '1.2K comments']);
  assert.ok(shown.closest('.card-preview').classList.contains('card-site'), 'in place of a picture');
  $('list-view').click();

  const answers = {
    'https://hacker-news.firebaseio.com/v0/item/100.json': { id: 100, type: 'story', by: 'pg', title: 'Show HN: Marked', score: 5, descendants: 1, time: 1, kids: [101] },
    'https://hacker-news.firebaseio.com/v0/item/101.json': { id: 101, by: 'dang', text: 'Nice.' },
    'https://api.github.com/repos/lucidrains/dreamer4': { full_name: 'lucidrains/dreamer4', description: 'Dreamer 4', stargazers_count: 7, language: 'Python' }
  };
  const fetched = [];
  globalThis.fetch = async url => { fetched.push(url); return answers[url] ? new Response(JSON.stringify(answers[url])) : new Response('', { status: 404 }); };
  page.mock.api.permissions = { request: async () => true };
  $('settings').click(); $('settings-tab-text').click();
  assert.equal($('text-download').textContent, 'Download text for 1 bookmark', 'the story has no text or card yet');
  $('text-download').click(); await page.settle(100);
  assert.equal($('text-status').textContent, 'Saved the text of 1 page.');
  assert.ok(fetched.every(url => url.startsWith('https://hacker-news.firebaseio.com/')), 'through Hacker News’s API');
  $('settings-dialog').close();
  assert.equal(row('story').querySelector('.item-stats').textContent, '5 points · 1 comment');
  assert.equal(row('story').querySelector('.item-read').textContent, '1 min read');

  $('new-bookmark').click();
  $('edit-name').value = 'dreamer4'; $('edit-url').value = 'https://github.com/lucidrains/dreamer4';
  $('editor-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('editor-form').querySelector('[type=submit]') }));
  await page.settle(100);
  const saved = (await browser.storage.local.get()).markedLibraryV1.root.children.find(node => node.url === 'https://github.com/lucidrains/dreamer4');
  assert.deepEqual([saved.card.site, saved.card.title, saved.card.stats], ['github', 'lucidrains/dreamer4', { stars: 7 }], 'a post added by hand gets its card');
  delete globalThis.fetch;
  dom.window.close();
});

test('Import offers a bookmarks file, the browser’s bookmarks, or X’s', async () => {
  const page = await openManager({ id: 'root', children: [] }, 'import-menu');
  const { dom, $ } = page;
  const requested = [], sent = [];
  page.mock.api.permissions = { request: async request => { requested.push(request); return true; } };
  page.mock.api.runtime = { sendMessage: async message => { sent.push(message); return { ok: true }; } };
  let picked = false;
  $('import-file').click = () => { picked = true; };
  $('import-file-open').click();
  assert.ok(picked, 'a file to import');
  $('import-x').click(); await page.settle();
  assert.deepEqual(requested, [{ origins: ['https://x.com/*', 'https://twitter.com/*'] }], 'Firefox asks for access to X first');
  assert.deepEqual(sent, [{ type: 'marked:import-x' }]);
  assert.match($('toast').textContent, /^Collecting your bookmarks on X\./);
  dom.window.close();
});

test('More like this shows the bookmarks that share a bookmark’s telling words, and why; the Marked button can ask about a page', async () => {
  const library = { id: 'root', children: [
    { id: 'transformer', parentId: 'root', title: 'Transformer (deep learning architecture)', url: 'https://t.test/', type: 'bookmark', tags: ['AI'], dateAdded: 3 },
    { id: 'attention', parentId: 'root', title: 'Attention (machine learning)', url: 'https://a.test/', type: 'bookmark', tags: ['AI'], note: 'Read before the transformer one.', dateAdded: 2 },
    { id: 'pasta', parentId: 'root', title: 'Weeknight pasta', url: 'https://p.test/', type: 'bookmark', tags: ['Cooking'], dateAdded: 1 }
  ] };
  const page = await openManager(library, 'related', { 'markedText:transformer': { text: 'A transformer relates tokens with multi-head attention.', words: 7, capturedAt: 1 } });
  const { dom, $ } = page;
  const row = id => [...$('items').rows].find(item => item.dataset.id === id);
  const titles = () => [...$('items').querySelectorAll('.item-title')].map(link => link.textContent);
  assert.equal(row('transformer').querySelector('.row-actions button').getAttribute('aria-label'), 'More like Transformer (deep learning architecture)');
  row('transformer').querySelector('.row-actions button').click();
  assert.equal($('page-title').textContent, 'Like “Transformer (deep learning architecture)”');
  assert.deepEqual(titles(), ['Attention (machine learning)'], 'not the pasta');
  assert.match($('items').querySelector('.item-reason').textContent, /^Shares \w+, \w+ and \w+$/);
  await page.settle(1700);
  const stored = (await browser.storage.local.get()).markedRelatedV1;
  assert.equal(stored.n, 3, 'a small copy is stored for the reader and the Marked button');
  dom.window.close();

  // The Marked button, on a page about attention, asks for its related bookmarks.
  const asked = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html?related=capture-page' });
  globalThis.document = asked.window.document;
  asked.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  asked.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new asked.window.Event('close')); };
  const mock = fixture(library);
  await mock.api.storage.local.set({ markedBrowserImportAsked: 1 });
  const session = { 'capture-page': { url: 'https://blog.test/attention', title: 'How attention works', abstract: 'Attention in machine learning', createdAt: Date.now() } };
  mock.api.storage.session = { get: async key => ({ [key]: session[key] }), remove: async key => { delete session[key]; } };
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  await import('../manager.js?related-page');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(asked.window.document.getElementById('page-title').textContent, 'Like “How attention works”');
  assert.equal([...asked.window.document.querySelectorAll('#items .item-title')][0].textContent, 'Attention (machine learning)');
  asked.window.close();
});

test('long lists build their rows as they near the window; Select all still takes every one, and renders keep unchanged rows', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  const $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  // jsdom has no IntersectionObserver; this one says the list's end is near when nearEnd() is called.
  const watched = new Set();
  let notify;
  dom.window.IntersectionObserver = class { constructor(callback) { notify = callback; } observe(target) { watched.add(target); } unobserve(target) { watched.delete(target); } };
  const nearEnd = () => notify([...watched].map(target => ({ target, isIntersecting: true })));
  const children = Array.from({ length: 100 }, (_, i) => ({ id: `b${i}`, parentId: 'unfiled_____', title: `Page ${i}${i % 10 === 0 ? ' python' : ''}`, url: `https://example.com/${i}`, type: 'bookmark', dateAdded: 1000 - i, ...(i === 1 && { tags: ['Kept'] }) }));
  const mock = fixture({ id: 'root________', children: [{ id: 'unfiled_____', parentId: 'root________', title: 'Other Bookmarks', children }] });
  await mock.api.storage.local.set({ markedBrowserImportAsked: 1 });
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  await import('../manager.js?rows');
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));
  const search = async query => { $('search').value = query; $('search').dispatchEvent(new dom.window.Event('input')); await new Promise(resolve => setTimeout(resolve, 150)); };
  const rows = () => [...$('items').rows];
  const selected = () => rows().every(row => row.querySelector('input').checked && row.classList.contains('selected'));
  await settle();
  assert.equal(rows().length, 40, 'only the first rows are built');
  assert.equal($('list-label').textContent, '100 items');
  $('select-all').click();
  assert.equal($('selection-count').textContent, '100 selected', 'Select all takes every bookmark shown, built or not');
  assert.ok(selected());
  nearEnd();
  assert.equal(rows().length, 80, 'more rows are built as the end nears');
  assert.ok(selected(), 'selected, like the rest');
  nearEnd(); nearEnd();
  assert.deepEqual([rows().length, rows().at(-1).dataset.id], [100, 'b99']);
  assert.equal($('select-all').checked, true);
  const first = rows()[0];
  $('clear-selection').click();
  assert.equal(rows()[0], first, 'a render keeps a row that hasn’t changed');
  assert.equal(first.querySelector('input').checked, false);
  rows()[1].querySelector('.tag').click();
  assert.equal($('page-title').textContent, 'Kept', 'a row’s buttons still work');
  $('all-bookmarks').click();
  const fourth = rows()[3];
  rows()[2].querySelector('[aria-label="Edit Page 2"]').click();
  assert.equal($('edit-name').value, 'Page 2');
  $('edit-name').value = 'Renamed';
  $('editor-form').dispatchEvent(new dom.window.SubmitEvent('submit', { cancelable: true, submitter: $('editor-form').querySelector('[type=submit]') }));
  await settle();
  assert.equal(rows()[2].querySelector('.item-title').textContent, 'Renamed');
  assert.equal(rows()[3], fourth, 'and after the library is read again');
  rows()[3].querySelector('[aria-label="Edit Page 3"]').click();
  assert.equal($('edit-name').value, 'Page 3', 'a kept row edits its bookmark as it is now');
  $('editor').close();
  // Typing more of the same words narrows the last results; anything else searches afresh.
  const titles = () => rows().map(row => row.querySelector('.item-title').textContent);
  await search('pyt');
  assert.equal($('list-label').textContent, '10 items');
  await search('python 5');
  assert.deepEqual(titles(), ['Page 50 python']);
  await search('pytho');
  assert.equal($('list-label').textContent, '10 items');
  await search('"page 9"');
  assert.deepEqual(titles(), ['Page 9', ...Array.from({ length: 10 }, (_, i) => `Page ${90 + i}${i ? '' : ' python'}`)]);
  dom.window.close();
});

// Access to the pages you visit isn't asked for at install. Marked asks in its
// own page, says why and that what it reads stays on the device, and the
// browser's prompt follows only from a click.
test('Marked asks for access to the pages you visit in its own words, remembers Not now, and keeps a switch in Settings', async () => {
  let granted = false;
  const requested = [], removed = [], listeners = {};
  const permissions = api => {
    api.permissions = {
      contains: async () => granted,
      request: async request => { requested.push(request); granted = true; listeners.added?.(request); return true; },
      remove: async request => { removed.push(request); granted = false; listeners.removed?.(request); return true; },
      onAdded: { addListener: listener => { listeners.added = listener; } },
      onRemoved: { addListener: listener => { listeners.removed = listener; } }
    };
  };
  const empty = { id: 'root', children: [] };
  let { dom, $, mock, settle } = await openManager(empty, 'site-access', {}, permissions);
  assert.equal($('site-access').hidden, false, 'asked on first use, not at install');
  assert.match($('site-access').textContent, /Let Marked read the pages you visit\?/);
  assert.match($('site-access').textContent, /never leaves your device/);
  assert.deepEqual(requested, [], 'no prompt until a click');
  $('site-access-later').click(); await settle();
  assert.ok($('site-access').hidden);
  assert.ok((await mock.api.storage.local.get()).markedSiteAccessAsked, 'Not now is remembered');
  assert.equal($('toast').textContent, 'You can allow it later in Settings → Browsing.');

  assert.equal($('site-access-state').textContent, 'Not allowed');
  $('site-access-toggle').click(); await settle();
  assert.deepEqual(requested, [{ origins: ['<all_urls>'] }]);
  assert.deepEqual([$('site-access-state').textContent, $('site-access-toggle').textContent], ['Allowed on all websites', 'Turn off']);
  $('site-access-toggle').click(); await settle();
  assert.deepEqual(removed, [{ origins: ['<all_urls>'] }], 'and it can be taken back');
  assert.deepEqual([$('site-access-state').textContent, $('site-access-toggle').textContent], ['Not allowed', 'Allow']);
  dom.window.close();

  granted = true;
  ({ dom, $ } = await openManager(empty, 'site-access-granted', {}, permissions));
  assert.ok($('site-access').hidden, 'nothing to ask once it is allowed');
  dom.window.close();

  granted = false; requested.length = 0;
  ({ dom, $, settle } = await openManager(empty, 'site-access-allow', {}, permissions));
  $('allow-sites').click(); await settle();
  assert.deepEqual(requested, [{ origins: ['<all_urls>'] }]);
  assert.ok($('site-access').hidden);
  assert.equal($('toast').textContent, 'Marked can now read the pages you visit. What it reads never leaves your device.');
  dom.window.close();
});
