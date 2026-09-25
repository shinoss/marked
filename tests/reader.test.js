import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { fixture } from './storage-fixture.js';

const html = await readFile(new URL('../reader.html', import.meta.url), 'utf8');
const text = [
  'Attention is the currency of a working life.',
  'Why it matters',
  'Deciding what deserves your attention is a skill.',
  '• Protect the mornings',
  '• Batch the messages',
  'A saved link is a promise to your future self.',
  'Notes say why.'
].join('\n\n');
const library = (extra = {}) => ({ id: 'root', children: [{ id: 'reading', parentId: 'root', title: 'Reading', type: 'folder', children: [
  { id: 'essay', parentId: 'reading', title: 'On attention', url: 'https://example.com/essay', type: 'bookmark', highlights: [
    { id: 'h1', text: 'a working life.', color: 'green', note: 'Mine', createdAt: 1 },
    { id: 'h2', text: 'your future self. Notes say', createdAt: 2 }
  ], ...extra },
  { id: 'bare', parentId: 'reading', title: 'No text yet', url: 'https://b.test/article', type: 'bookmark' }
] }] });

// Opens reader.html in a window, with the library and texts given.
async function open(search, { stored = {}, name = search, root = library() } = {}) {
  const dom = new JSDOM(html, { url: `https://extension.local/reader.html${search}` });
  const { window } = dom;
  globalThis.document = window.document;
  globalThis.DOMParser = window.DOMParser;
  const scrolled = [];
  window.scrollTo = options => { scrolled.push(options.top); };
  const mock = fixture(root);
  await mock.api.storage.local.set({ 'markedText:essay': { text, words: 40, capturedAt: Date.UTC(2026, 8, 1, 12), via: 'page', kinds: 'p h2 p li li q p', byline: 'Ada Writer' }, ...stored });
  mock.api.tabs = { getCurrent: async () => ({ id: 7 }) };
  const listeners = [];
  mock.api.runtime = { onMessage: { addListener: listener => listeners.push(listener) } };
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  const { ready } = await import(`../reader.js?${name}`);
  await ready;
  await new Promise(resolve => setTimeout(resolve, 10));
  const $ = id => window.document.getElementById(id);
  const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
  const select = (node, start, end) => {
    const range = window.document.createRange();
    range.setStart(node, start); range.setEnd(node, end);
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    window.document.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }));
  };
  return { dom, window, $, mock, scrolled, listeners, settle, select, stored: async () => mock.api.storage.local.get() };
}

test('the reader lays out the saved text, marks highlights in their colors and the words searched for', async () => {
  const page = await open('?id=essay&q=currency', { name: 'layout' });
  const { $, window } = page;
  assert.equal(window.document.title, 'On attention · Marked');
  assert.equal($('reader-title').textContent, 'On attention');
  assert.equal($('reader-meta').textContent, `example.com · Ada Writer · 1 min read · saved ${new Date(Date.UTC(2026, 8, 1, 12)).toLocaleDateString([], { dateStyle: 'medium' })}`);
  assert.equal($('reader-original').href, 'https://example.com/essay');
  const body = $('reader-body');
  assert.deepEqual([...body.children].map(block => block.localName), ['p', 'h2', 'p', 'ul', 'blockquote', 'p'], 'headings, lists, and quotations keep their shape');
  assert.deepEqual([...body.querySelectorAll('li')].map(item => item.textContent), ['Protect the mornings', 'Batch the messages'], 'bullets become the list’s own');
  assert.deepEqual([...body.querySelectorAll('mark.term')].map(mark => mark.textContent), ['currency']);
  const marks = [...body.querySelectorAll('mark.passage')].map(mark => [mark.textContent, mark.className, mark.dataset.highlight]);
  assert.deepEqual(marks, [
    ['a working life.', 'passage hl-green', 'h1'],
    ['your future self.', 'passage hl-yellow', 'h2'],
    ['Notes say', 'passage hl-yellow', 'h2']
  ], 'a highlight across two paragraphs is marked in both');
  assert.deepEqual(page.scrolled.length, 1, 'it scrolls to the word searched for');
  page.dom.window.close();
});

test('reading options change the type and are remembered; the theme can be sepia', async () => {
  const page = await open('?id=essay', { name: 'options' });
  const { $, window } = page;
  const root = window.document.documentElement;
  assert.deepEqual([root.dataset.font, root.dataset.width, root.style.getPropertyValue('--reader-size')], ['serif', 'medium', '19px']);
  window.document.querySelector('[data-option="font"][data-value="sans"]').click();
  $('reader-larger').click(); $('reader-larger').click();
  window.document.querySelector('[data-option="width"][data-value="wide"]').click();
  window.document.querySelector('[data-option="theme"][data-value="sepia"]').click();
  assert.deepEqual([root.dataset.font, root.dataset.width, root.style.getPropertyValue('--reader-size'), root.dataset.readerTheme, root.dataset.theme], ['sans', 'wide', '22px', 'sepia', 'light']);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('markedReader')), { font: 'sans', size: 22, width: 'wide', theme: 'sepia' });
  assert.equal(window.document.querySelector('[data-option="theme"][data-value="sepia"]').getAttribute('aria-checked'), 'true');
  window.document.querySelector('[data-option="theme"][data-value="dark"]').click();
  assert.deepEqual([root.dataset.readerTheme, root.dataset.theme], [undefined, 'dark']);
  page.dom.window.close();
});

test('selecting text offers colors; a highlight can change color, get a note, or go', async () => {
  const page = await open('?id=essay', { name: 'highlight' });
  const { $, window } = page;
  const saved = async () => (await page.stored()).markedLibraryV1.root.children[0].children[0].highlights;
  const paragraph = $('reader-body').querySelector('[data-index="2"]');
  page.select(paragraph.firstChild, 0, 'Deciding what deserves'.length);
  await page.settle();
  assert.equal($('reader-tools').hidden, false, 'the tools appear beside the selection');
  $('reader-tools').querySelector('.swatch.hl-blue').click();
  await page.settle();
  assert.deepEqual((await saved()).map(({ text, color }) => [text, color ?? 'yellow']), [['a working life.', 'green'], ['your future self. Notes say', 'yellow'], ['Deciding what deserves', 'blue']]);
  assert.equal($('reader-tools').hidden, true);
  const mark = [...$('reader-body').querySelectorAll('mark.passage')].find(item => item.textContent === 'Deciding what deserves');
  assert.equal(mark.className, 'passage hl-blue', 'marked at once');

  mark.click();
  assert.equal($('reader-tools').hidden, false);
  $('reader-tools').querySelector('.swatch.hl-pink').click();
  await page.settle();
  assert.equal((await saved())[2].color, 'pink');
  [...$('reader-body').querySelectorAll('mark.passage')].find(item => item.textContent === 'Deciding what deserves').click();
  [...$('reader-tools').querySelectorAll('button')].find(button => button.textContent === 'Note').click();
  $('reader-tools').querySelector('textarea').value = 'Worth practicing.';
  [...$('reader-tools').querySelectorAll('button')].find(button => button.textContent === 'Save').click();
  await page.settle();
  assert.equal((await saved())[2].note, 'Worth practicing.');
  [...$('reader-body').querySelectorAll('mark.passage')].find(item => item.textContent === 'Deciding what deserves').click();
  assert.match($('reader-tools').textContent, /Worth practicing\./, 'the note shows');
  [...$('reader-tools').querySelectorAll('button')].find(button => button.textContent === 'Delete').click();
  await page.settle();
  assert.equal((await saved()).length, 2);
  [...$('toast').querySelectorAll('button')].find(button => button.textContent === 'Undo').click();
  await page.settle();
  assert.equal((await saved())[2].text, 'Deciding what deserves', 'Undo brings it back');

  // H highlights the selection in the color last used; so does Alt+Shift+H, through the background.
  page.select($('reader-body').querySelector('h2').firstChild, 0, 3);
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'h', bubbles: true }));
  await page.settle();
  assert.deepEqual((await saved()).at(-1).text, 'Why');
  page.select($('reader-body').querySelector('li').firstChild, 0, 7);
  page.listeners[0]({ type: 'marked:reader-highlight', tabId: 8 });
  await page.settle();
  assert.equal((await saved()).length, 4, 'a message for another tab is ignored');
  page.listeners[0]({ type: 'marked:reader-highlight', tabId: 7 });
  await page.settle();
  assert.equal((await saved()).at(-1).text, 'Protect');
  page.dom.window.close();
});

test('the reader remembers how far along it is, and picks up there', async () => {
  const page = await open('?id=essay', { name: 'progress' });
  const { window } = page;
  Object.defineProperty(window.document.documentElement, 'scrollHeight', { value: 3000, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: 1000, configurable: true });
  Object.defineProperty(window, 'scrollY', { value: 1000, configurable: true, writable: true });
  window.dispatchEvent(new window.Event('scroll'));
  await page.settle(700);
  assert.equal((await page.stored()).markedReadingV1.essay.p, 0.5);
  page.dom.window.close();

  const again = await open('?id=essay', { name: 'progress-again', stored: { markedReadingV1: { essay: { p: 0.5, i: 3, at: 5 } } } });
  assert.equal(again.$('toast').querySelector('span').textContent, 'Picking up where you left off.');
  assert.equal(again.scrolled.length, 1);
  [...again.$('toast').querySelectorAll('button')].find(button => button.textContent === 'Start over').click();
  assert.equal(again.scrolled.at(-1), 0);
  again.dom.window.close();
});

test('without its text, the reader downloads it; a bookmark that is gone says so', async () => {
  globalThis.Readability = Readability;
  const page = await open('?id=bare', { name: 'download' });
  const { $ } = page;
  assert.equal($('reader-empty').hidden, false);
  assert.equal($('reader-empty-text').textContent, 'Marked doesn’t have this page’s text yet.');
  page.mock.api.permissions = { request: async () => true, contains: async () => true };
  globalThis.fetch = async () => new Response('<body><article><p>Downloaded words, enough of them to count as an article in the reader.</p></article></body>', { headers: { 'content-type': 'text/html' } });
  $('reader-download').click();
  await page.settle(50);
  assert.equal($('reader-body').textContent, 'Downloaded words, enough of them to count as an article in the reader.');
  assert.equal((await page.stored())['markedText:bare'].via, 'download');
  delete globalThis.fetch;
  page.dom.window.close();

  const gone = await open('?id=missing', { name: 'gone' });
  assert.equal(gone.$('reader-title').textContent, 'Not in Marked');
  assert.equal(gone.$('reader-empty-text').textContent, 'This bookmark is no longer in Marked.');
  gone.dom.window.close();
});

test('at the end, the reader lists related bookmarks from the stored index', async () => {
  const { buildIndex, compactIndex, documentTerms } = await import('../related.js');
  const root = library();
  root.children[0].children.push({ id: 'focus', parentId: 'reading', title: 'Deep work and attention', url: 'https://focus.test/', type: 'bookmark' });
  const index = buildIndex([
    { id: 'essay', terms: documentTerms({ title: 'On attention', text }) },
    { id: 'focus', terms: documentTerms({ title: 'Deep work and attention', text: 'Protect your attention and your mornings.' }) },
    { id: 'bare', terms: documentTerms({ title: 'No text yet' }) }
  ]);
  const page = await open('?id=essay', { name: 'related', root, stored: { markedRelatedV1: compactIndex(index) } });
  const { $ } = page;
  assert.equal($('reader-related').hidden, false);
  const [item] = $('reader-related-list').children;
  assert.equal(item.querySelector('.related-title').textContent, 'Deep work and attention');
  assert.equal(item.querySelector('.related-title').href, 'https://focus.test/', 'a page without saved text opens on its site');
  assert.match(item.querySelector('.related-meta').textContent, /^focus\.test · shares /);
  page.dom.window.close();
});
