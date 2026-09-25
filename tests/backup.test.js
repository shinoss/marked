import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { exportBackup, parseBackup } from '../backup.js';
import { createLibraryStore, STORAGE_KEY } from '../store.js';
import { fixture } from './storage-fixture.js';

const preview = 'data:image/jpeg;base64,/9j/AAAA';
const library = () => ({ id: 'root', children: [
  { id: 'f', parentId: 'root', title: 'Reading', dateAdded: 1000, children: [
    { id: 'a', parentId: 'f', title: 'Article', url: 'https://example.com/a', dateAdded: 2000, preview, abstract: 'What the article is about.', note: 'Cite this.', tags: ['History'] },
    { id: 's', parentId: 'f', type: 'separator', dateAdded: 3000 },
    { id: 'x', parentId: 'f', title: 'Unsafe', url: 'javascript:alert(1)', dateAdded: 4000 }
  ] }
] });

test('backup round-trips hierarchy, dates, previews, and abstracts but drops unsafe URLs', () => {
  const data = JSON.parse(exportBackup(library()));
  assert.equal(data.format, 'marked');
  const { nodes, skipped } = parseBackup(data);
  assert.equal(skipped, 1);
  assert.deepEqual(nodes, [{ title: 'Reading', dateAdded: 1000, children: [
    { title: 'Article', dateAdded: 2000, url: 'https://example.com/a', preview, abstract: 'What the article is about.', note: 'Cite this.', tags: ['History'] },
    { title: 'Untitled', dateAdded: 3000, type: 'separator' }
  ] }]);
});

test('rejects other formats and drops previews that are not JPEG data', () => {
  assert.throws(() => parseBackup({ format: 'other', version: 1, children: [] }), /Unsupported/);
  assert.throws(() => parseBackup({ format: 'marked', version: 2, children: [] }), /Unsupported/);
  const { nodes } = parseBackup({ format: 'marked', version: 1, children: [{ title: 'A', url: 'https://example.com/', preview: 'data:image/svg+xml;base64,PHN2Zz4=', abstract: { text: 'not a string' }, note: ['no'], tags: 'History' }] });
  assert.equal(nodes[0].preview, undefined);
  assert.equal(nodes[0].abstract, undefined);
  assert.equal(nodes[0].note, undefined);
  assert.equal(nodes[0].tags, undefined);
});

test('restored items keep their original dates; other new items are dated now', async () => {
  const mock = fixture({ id: 'root', children: [] });
  const store = createLibraryStore(mock.api, mock.locks);
  const before = Date.now();
  await store.importTree(parseBackup(JSON.parse(exportBackup(library()))).nodes, 'root', 'Imported');
  const [{ children: [container] }] = await store.getTree();
  assert.ok(container.dateAdded >= before);
  const [folder] = container.children;
  assert.equal(folder.dateAdded, 1000);
  assert.deepEqual(folder.children.map(n => [n.type, n.dateAdded]), [['bookmark', 2000], ['separator', 3000]]);
  assert.equal(folder.children[0].preview, preview);
  assert.equal(folder.children[0].abstract, 'What the article is about.');
});

test('Backup button downloads a Marked file that Import restores with dates and previews', async t => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
  const $ = id => document.getElementById(id);
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new dom.window.Event('close')); };
  const mock = fixture(library());
  globalThis.browser = mock.api;
  Object.defineProperty(globalThis.navigator, 'locks', { value: mock.locks, configurable: true });
  // Mock timers so the download and toast timers do not keep the test alive.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
  await import('../manager.js');
  await flush();

  let blob, filename;
  t.mock.method(URL, 'createObjectURL', value => { blob = value; return 'blob:backup'; });
  t.mock.method(URL, 'revokeObjectURL', () => {});
  dom.window.HTMLAnchorElement.prototype.click = function () { filename = this.download; };
  $('backup').click();
  assert.match(filename, /^marked-backup-\d{4}-\d{2}-\d{2}\.json$/);

  const file = new File([await blob.text()], filename, { type: 'application/json' });
  Object.defineProperty($('import-file'), 'files', { value: [file], configurable: true });
  $('import-file').dispatchEvent(new dom.window.Event('change'));
  await flush();
  assert.match($('confirm-message').textContent, /Add 3 items.*1 unsupported items will be skipped/);
  $('confirm-dialog').returnValue = 'accept';
  $('confirm-dialog').close();
  await flush();

  const saved = (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY].root;
  const imported = saved.children.find(node => node.title.startsWith('Imported'));
  const [article] = imported.children[0].children;
  assert.equal(article.dateAdded, 2000);
  assert.equal(article.preview, preview);
  assert.equal(library().children[0].children.length, 3, 'browser bookmarks are unchanged');
  t.mock.timers.runAll();
  dom.window.close();
});
