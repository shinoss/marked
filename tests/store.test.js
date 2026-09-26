import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, DEFAULT_TAGS, STORAGE_KEY, INDEX_KEY, PREVIEW_PREFIX, previewKey } from '../store.js';
import { exportBackup, parseBackup } from '../backup.js';
import { fixture } from './storage-fixture.js';
const tree = () => ({ id: 'root', children: [{ id: 'home', parentId: 'root', title: 'Home', children: [{ id: 'a', parentId: 'home', title: 'Original', url: 'https://example.com' }, { id: 'folder', parentId: 'home', title: 'Folder', children: [] }] }] });

test('starts empty, imports the browser’s bookmarks only when asked, and never changes Firefox', async () => {
  const firefox = tree(); const original = structuredClone(firefox);
  const mock = fixture(null, firefox); const store = createLibraryStore(mock.api, mock.locks);
  assert.deepEqual((await store.getTree())[0].children, []);
  assert.equal(mock.reads(), 0, 'nothing is read from the browser unasked');
  assert.equal(await store.importBrowser(), 1);
  const [imported] = await store.getTree();
  assert.equal(imported.children[0].title, 'Home');
  assert.deepEqual(imported.children[0].children.map(node => [node.title, node.url]), [['Original', 'https://example.com/']], 'empty folders are left out');
  const id = imported.children[0].children[0].id;
  await store.update(id, { title: 'Independent' });
  firefox.children[0].title = 'Changed in Firefox';
  const reopened = createLibraryStore(mock.api, mock.locks);
  const [saved] = await reopened.getTree();
  assert.equal(saved.children[0].title, 'Home');
  assert.equal(saved.children[0].children[0].title, 'Independent');
  assert.equal(await reopened.importBrowser(), 0, 'a second import adds nothing');
  firefox.children[0].title = 'Home';
  assert.deepEqual(firefox, original);
});
test('merges the browser’s bookmarks into matching folders, skipping ones already saved', async () => {
  const library = { id: 'root________', children: [
    { id: 'toolbar_____', parentId: 'root________', title: 'Bookmarks Toolbar', children: [{ id: 'kept', parentId: 'toolbar_____', title: 'Already here', url: 'https://kept.test/' }] },
    { id: 'mine', parentId: 'root________', title: 'Reading', children: [] },
    { id: 'other', parentId: 'root________', title: 'Other bookmarks', children: [] }
  ] };
  const firefox = { id: 'root________', children: [
    { id: 'toolbar_____', title: 'Bookmarks Toolbar', type: 'folder', children: [
      { id: 'b1', title: 'Already here', url: 'https://kept.test/', type: 'bookmark' },
      { id: 'b2', title: 'New on the toolbar', url: 'https://new.test/', type: 'bookmark', dateAdded: 1700000000000 },
      { id: 's1', type: 'separator' },
      { id: 'f1', title: 'Work', type: 'folder', children: [{ id: 'b3', title: 'Docs', url: 'https://docs.test/', type: 'bookmark' }, { id: 'q', title: 'Most Visited', url: 'place:sort=8', type: 'bookmark' }] },
      { id: 'f2', title: 'Empty', type: 'folder', children: [] }
    ] },
    { id: 'unfiled_____', title: 'Other Bookmarks', type: 'folder', children: [{ id: 'b4', title: '', url: 'https://untitled.test/', type: 'bookmark' }] }
  ] };
  const mock = fixture(library, firefox); const store = createLibraryStore(mock.api, mock.locks);
  assert.equal(await store.importBrowser(), 3);
  const [root] = await store.getTree();
  assert.deepEqual(root.children.map(node => node.title), ['Bookmarks Toolbar', 'Reading', 'Other bookmarks'], 'folders match by id or by name');
  const [kept, added, work] = root.children[0].children;
  assert.deepEqual([kept.id, added.title, added.dateAdded, work.title], ['kept', 'New on the toolbar', 1700000000000, 'Work']);
  assert.deepEqual(work.children.map(node => [node.title, node.url, node.parentId]), [['Docs', 'https://docs.test/', work.id]]);
  assert.equal(root.children[2].children[0].title, 'https://untitled.test/');
  assert.equal(await store.importBrowser(), 0);
});
test('serializes concurrent initialization and writes from separate tabs', async () => {
  const mock = fixture(null);
  const a = createLibraryStore(mock.api, mock.locks), b = createLibraryStore(mock.api, mock.locks);
  const [[root]] = await Promise.all([a.getTree(), b.getTree()]);
  await Promise.all([a.create({ parentId: root.id, title: 'One', url: 'https://one.test' }), b.create({ parentId: root.id, title: 'Two', url: 'https://two.test' })]);
  assert.equal((await b.getTree())[0].children.length, 2);
});
test('rejects cycles and failed writes without modifying persisted data', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const before = await store.getTree();
  await assert.rejects(store.moveMany(['folder'], 'folder'), /descendant/);
  mock.failWrites(true);
  await assert.rejects(store.removeMany(['a']), /Storage failure/);
  mock.failWrites(false);
  assert.deepEqual(await store.getTree(), before);
});
test('allows editing and deleting top-level folders, then adding to an empty library', async () => {
  const firefox = tree();
  const mock = fixture(firefox); const store = createLibraryStore(mock.api, mock.locks);
  await store.update('home', { title: 'Renamed' });
  assert.equal((await store.getTree())[0].children[0].title, 'Renamed');
  await store.removeMany(['home']);
  assert.deepEqual((await store.getTree())[0].children, []);
  await store.create({ parentId: 'root', title: 'New folder', type: 'folder' });
  assert.equal((await store.getTree())[0].children[0].title, 'New folder');
  await assert.rejects(store.removeMany(['root']), /root cannot be changed/);
  assert.equal(firefox.children[0].title, 'Home');
});

test('undo restores nested folders and ordering without reverting other edits', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  await store.moveMany(['a'], 'folder');
  const deleted = await store.removeMany(['folder', 'a']);
  assert.equal(deleted.length, 1);
  await store.create({ parentId: 'home', title: 'Later addition', type: 'folder' });
  await store.restoreMany(deleted);
  const children = (await store.getTree())[0].children[0].children;
  assert.equal(children[0].id, 'folder');
  assert.equal(children[0].children[0].id, 'a');
  assert.equal(children[1].title, 'Later addition');
  await assert.rejects(store.restoreMany(deleted), /already been restored/);
});

test('undo restores to library root when original parent was deleted', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const deleted = await store.removeMany(['a']);
  await store.removeMany(['home']);
  await store.restoreMany(deleted);
  const restored = (await store.getTree())[0].children[0];
  assert.equal(restored.id, 'a');
  assert.equal(restored.parentId, 'root');
});

test('undo preserves original order for multiple deleted siblings', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const before = await store.getTree();
  const deleted = await store.removeMany(['folder', 'a']);
  await store.restoreMany(deleted);
  assert.deepEqual(await store.getTree(), before);
});

test('stores local previews apart from the library, preserves them through undo, and clears stale previews', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const preview = 'data:image/jpeg;base64,dGVzdA==';
  const saved = async () => Object.fromEntries(Object.entries(await mock.api.storage.local.get()).filter(([key]) => key.startsWith(PREVIEW_PREFIX)));
  const node = await store.create({ parentId: 'home', title: 'Preview', url: 'https://example.test/', preview });
  assert.deepEqual(await store.getPreviews([node.id, 'a']), { [node.id]: preview });
  assert.ok(!JSON.stringify((await mock.api.storage.local.get()).markedLibraryV1).includes('base64'), 'the library itself doesn’t hold the preview');
  await store.update(node.id, { title: 'Renamed', url: node.url, preview });
  assert.deepEqual(await saved(), { [previewKey(node.id)]: preview }, 'an edit keeps it');
  const deleted = await store.removeMany([node.id]);
  assert.deepEqual(deleted[0].previews, { [node.id]: preview });
  assert.deepEqual(await saved(), {}, 'deleting a bookmark deletes its preview');
  await store.restoreMany(deleted);
  assert.deepEqual(await store.getPreviews([node.id]), { [node.id]: preview }, 'Undo brings it back');
  await store.update(node.id, { title: 'Changed URL', url: 'https://different.test/' });
  assert.deepEqual(await saved(), {}, 'a new address is a different page');
  const kept = await store.create({ parentId: 'home', title: 'Kept', url: 'https://kept.test/', preview });
  await store.update(kept.id, { title: 'Kept', url: kept.url, preview: null });
  assert.deepEqual(await saved(), {}, 'and the editor can drop one');
  const unsafe = await store.create({ parentId: 'home', title: 'No remote preview', url: node.url, preview: 'https://remote.test/image.jpg' });
  assert.deepEqual(await store.getPreviews([unsafe.id]), {});
});

test('libraries saved with previews inside move them to keys of their own, once, even if the move is cut short', async () => {
  const preview = id => `data:image/jpeg;base64,${btoa(id)}`;
  const library = tree();
  library.children[0].children.push({ id: 'b', parentId: 'home', title: 'B', url: 'https://b.test/', preview: preview('b') }, { id: 'c', parentId: 'home', title: 'C', url: 'https://c.test/', preview: 'https://remote.test/image.jpg' });
  library.children[0].children[1].children.push({ id: 'd', parentId: 'folder', title: 'D', url: 'https://d.test/', preview: preview('d'), tags: ['AI'] });
  const mock = fixture(library);
  const writes = [];
  const set = mock.api.storage.local.set;
  let cut = true;
  mock.api.storage.local.set = async value => {
    writes.push(Object.keys(value));
    if (cut && STORAGE_KEY in value) throw new Error('Interrupted');
    return set(value);
  };
  const store = createLibraryStore(mock.api, mock.locks);
  await assert.rejects(store.getTree(), /Interrupted/);
  assert.deepEqual(writes, [[previewKey('d'), previewKey('b')], [STORAGE_KEY]], 'the previews are written before the library without them');
  assert.ok(JSON.stringify((await mock.api.storage.local.get()).markedLibraryV1).includes(preview('d')), 'until then the library keeps them');
  cut = false; writes.length = 0;
  const [root] = await store.getTree();
  assert.deepEqual(writes, [[previewKey('d'), previewKey('b')], [STORAGE_KEY]], 'the next read makes the move again');
  assert.ok(!JSON.stringify(root).includes('preview'));
  assert.ok(!JSON.stringify((await mock.api.storage.local.get()).markedLibraryV1).includes('preview'));
  assert.deepEqual(await store.getPreviews(['a', 'b', 'c', 'd']), { b: preview('b'), d: preview('d') }, 'a preview that isn’t JPEG data is dropped');
  writes.length = 0;
  await Promise.all([store.getTree(), store.getTags(), createLibraryStore(mock.api, mock.locks).getTree()]);
  assert.deepEqual(writes, [], 'a moved library is only read');
  assert.equal(root.children[0].children.find(node => node.id === 'folder').children[0].tags[0], 'AI', 'the rest of each bookmark stays');
});

test('previews follow their bookmark through merges and backups, and edits write neither previews nor an unchanged index', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const two = 'data:image/jpeg;base64,dHdv', three = 'data:image/jpeg;base64,dGhyZWU=';
  const first = await store.create({ parentId: 'home', title: 'First', url: 'https://page.test/', dateAdded: 1 });
  const second = await store.create({ parentId: 'home', title: 'Second', url: 'https://page.test/#top', dateAdded: 2, preview: two });
  const third = await store.create({ parentId: 'folder', title: 'Third', url: 'https://www.page.test/', dateAdded: 3, preview: three });
  const writes = [];
  const set = mock.api.storage.local.set;
  mock.api.storage.local.set = async value => { writes.push(Object.keys(value)); return set(value); };
  await store.update(first.id, { title: 'First', url: first.url, tags: ['AI'] });
  await store.moveMany([first.id], 'folder');
  assert.deepEqual(writes, [[STORAGE_KEY], [STORAGE_KEY]], 'a tag or a move rewrites neither the previews nor the index');
  await store.update(first.id, { title: 'Renamed', url: first.url });
  assert.deepEqual(writes.at(-1), [STORAGE_KEY, INDEX_KEY], 'a new title is in the index');
  mock.api.storage.local.set = set;

  assert.equal(await store.mergeDuplicates([[third.id, second.id, first.id]]), 2);
  assert.deepEqual(await store.getPreviews([first.id, second.id, third.id]), { [first.id]: two }, 'the kept bookmark takes the oldest copy’s preview');
  const keys = Object.keys(await mock.api.storage.local.get()).filter(key => key.startsWith(PREVIEW_PREFIX));
  assert.deepEqual(keys, [previewKey(first.id)], 'and the copies’ go');

  const [root] = await store.getTree();
  const backup = exportBackup(root, {}, await store.getPreviews([first.id, 'a']));
  const restored = await store.importTree(parseBackup(JSON.parse(backup)).nodes, 'root', 'Restored');
  const copy = restored.children[0].children[1].children[0];
  assert.equal(copy.title, 'Renamed');
  assert.deepEqual(await store.getPreviews([copy.id]), { [copy.id]: two }, 'a restored backup keeps the preview under the new bookmark');
  assert.ok(!JSON.stringify((await mock.api.storage.local.get()).markedLibraryV1).includes('base64'));
});

test('stores cleaned abstracts on bookmarks and lets edits change or clear them', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const saved = async id => (await store.getTree())[0].children[0].children.find(n => n.id === id);
  const node = await store.create({ parentId: 'home', title: 'Paper', url: 'https://example.test/', abstract: '  World   models\n in imagination ' });
  assert.equal(node.abstract, 'World models in imagination');
  const folder = await store.create({ parentId: 'home', title: 'Folder', type: 'folder', abstract: 'Folders have none' });
  assert.equal(folder.abstract, undefined);
  await store.update(node.id, { title: 'Renamed' });
  assert.equal((await saved(node.id)).abstract, 'World models in imagination');
  await store.update(node.id, { title: 'Paper', url: node.url, abstract: 'x'.repeat(5000) });
  assert.equal((await saved(node.id)).abstract.length, 2000);
  await store.update(node.id, { title: 'Paper', url: node.url, abstract: '   ' });
  assert.equal('abstract' in await saved(node.id), false);
});

test('keeps a tag list, saves tags and notes on bookmarks, and removes tags everywhere', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const saved = async id => (await store.getTree())[0].children[0].children.find(n => n.id === id);
  assert.deepEqual(await store.getTags(), DEFAULT_TAGS);
  const node = await store.create({ parentId: 'home', title: 'Paper', url: 'https://example.test/', tags: ['ai', 'Robotics', 'robotics'], note: '  For the  reading group ' });
  assert.deepEqual(node.tags, ['ai', 'Robotics']);
  assert.equal(node.note, 'For the reading group');
  assert.deepEqual(await store.getTags(), [...DEFAULT_TAGS, 'Robotics'], 'new tags join the list; case-only duplicates do not');
  const folder = await store.create({ parentId: 'home', title: 'Folder', type: 'folder', tags: ['AI'], note: 'Folders have none' });
  assert.equal(folder.tags, undefined); assert.equal(folder.note, undefined);
  await store.update(node.id, { title: 'Renamed' });
  assert.deepEqual((await saved(node.id)).tags, ['ai', 'Robotics']);
  await store.update(node.id, { title: 'Paper', url: node.url, tags: [], note: '' });
  assert.equal('tags' in await saved(node.id), false);
  assert.equal('note' in await saved(node.id), false);
  await store.update(node.id, { title: 'Paper', url: node.url, tags: ['History', 'AI'] });
  assert.equal(await store.removeTag('ai'), 1);
  assert.deepEqual((await saved(node.id)).tags, ['History']);
  assert.deepEqual(await store.getTags(), ['Technology', 'History', 'Fiction', 'Robotics']);
  assert.equal(await store.addTag('  Cooking '), 'Cooking');
  await assert.rejects(store.addTag('cooking'), /already a tag/);
  await assert.rejects(store.addTag('   '), /Enter a tag name/);
  assert.ok((await store.getTags()).includes('Cooking'));
  const imported = await store.importTree([{ title: 'Novel', url: 'https://novel.test/', tags: ['Fiction', 'Poetry'] }], 'home', 'Imported');
  assert.deepEqual(imported.children[0].tags, ['Fiction', 'Poetry']);
  assert.ok((await store.getTags()).includes('Poetry'));
});

test('adds and removes highlights on bookmarks only, keeping them cleaned', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const created = await store.create({ parentId: 'home', title: 'Essay', url: 'https://essay.test/', highlights: [{ text: '  First   passage ', note: ' Why ' }, { text: '   ' }] });
  assert.equal(created.highlights.length, 1);
  assert.equal(created.highlights[0].text, 'First passage');
  assert.equal(created.highlights[0].note, 'Why');
  const added = await store.addHighlight(created.id, { text: 'Second passage' });
  assert.equal(added.note, undefined);
  assert.ok(added.id && added.createdAt);
  await assert.rejects(store.addHighlight(created.id, { text: '  ' }), /Select some text/);
  await assert.rejects(store.addHighlight('folder', { text: 'On a folder' }), /Only bookmarks/);
  await store.removeHighlight(created.id, created.highlights[0].id);
  const saved = (await store.getTree())[0].children[0].children.find(node => node.id === created.id);
  assert.deepEqual(saved.highlights.map(h => h.text), ['Second passage']);
  await store.removeHighlight(created.id, added.id);
  assert.equal('highlights' in (await store.getTree())[0].children[0].children.find(node => node.id === created.id), false);
});

test('imports an entire hierarchy atomically into local storage', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const nodes = [{ title: 'Nested', children: [{ title: 'Site', url: 'https://example.org/' }] }];
  await store.getTree(); mock.failWrites(true);
  await assert.rejects(store.importTree(nodes, 'home', 'Import'), /Storage failure/);
  mock.failWrites(false);
  assert.equal((await store.getTree())[0].children[0].children.length, 2);
  const imported = await store.importTree(nodes, 'home', 'Import');
  assert.equal(imported.children[0].children[0].title, 'Site');
  assert.equal(mock.reads(), 0, 'file imports never read the browser’s bookmarks');
});

test('keeps a small index of pages and their highlights, without previews, and builds one for older libraries', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  assert.deepEqual((await store.getIndex()).pages.map(page => [page.id, page.url, page.title]), [['a', 'https://example.com', 'Original']], 'a library saved before the index gets one');
  assert.ok((await mock.api.storage.local.get()).markedIndexV1);
  const created = await store.create({ parentId: 'home', title: 'New', url: 'https://new.test/', preview: 'data:image/jpeg;base64,AAAA', dateAdded: 5 });
  await store.addHighlight(created.id, { text: 'A passage', note: 'Why' });
  const index = (await mock.api.storage.local.get()).markedIndexV1;
  const page = index.pages.find(entry => entry.id === created.id);
  assert.deepEqual({ ...page, highlights: page.highlights.map(({ text, note }) => ({ text, note })) }, { id: created.id, url: 'https://new.test/', title: 'New', dateAdded: 5, highlights: [{ text: 'A passage', note: 'Why' }] });
  assert.ok(!JSON.stringify(index).includes('base64'), 'previews stay out of the index');
  await store.removeMany([created.id]);
  assert.deepEqual((await store.getIndex()).pages.map(entry => entry.id), ['a']);
});

test('merges copies of a page into the oldest, keeping every tag, note, and highlight; icons live with their address', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const icon = 'data:image/png;base64,iVBORw0KGgo=';
  const first = await store.create({ parentId: 'home', title: 'First', url: 'https://page.test/', dateAdded: 10, tags: ['AI'], note: 'Why I saved it.', highlights: [{ text: 'One' }] });
  const second = await store.create({ parentId: 'folder', title: 'Second', url: 'https://www.page.test/#top', dateAdded: 20, tags: ['AI', 'Essays'], note: 'Another reason.', highlights: [{ text: 'One' }, { text: 'Two', note: 'Mine' }], icon, abstract: 'About the page.' });
  assert.equal(await store.mergeDuplicates([[second.id, first.id]]), 1);
  const [root] = await store.getTree();
  const home = root.children[0];
  const kept = home.children.find(node => node.id === first.id);
  assert.deepEqual({ title: kept.title, tags: kept.tags, note: kept.note, highlights: kept.highlights.map(h => h.text), icon: kept.icon, abstract: kept.abstract },
    { title: 'First', tags: ['AI', 'Essays'], note: 'Why I saved it.\n\nAnother reason.', highlights: ['One', 'Two'], icon, abstract: 'About the page.' });
  assert.equal(home.children.find(node => node.id === 'folder').children.length, 0, 'the newer copy is gone');
  await store.update(first.id, { title: 'First', url: 'https://elsewhere.test/' });
  assert.equal('icon' in (await store.getTree())[0].children[0].children.find(node => node.id === first.id), false, 'a new address drops the old site’s icon');
  assert.equal(await store.mergeDuplicates([[first.id]]), 0);
});

test('page texts live apart from the library, follow their bookmarks through Undo and merges, and go when the address changes', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const saved = async () => Object.fromEntries(Object.entries(await mock.api.storage.local.get()).filter(([key]) => key.startsWith('markedText:')));
  const text = { text: 'The whole essay.', words: 3, via: 'page' };
  assert.equal((await store.setText('a', text)).text, 'The whole essay.');
  assert.equal(await store.setText('gone', text), null, 'only for bookmarks in the library');
  assert.equal(await store.setText('folder', text), null, 'and never for folders');
  assert.ok(!JSON.stringify((await mock.api.storage.local.get()).markedLibraryV1).includes('whole essay'), 'the library itself doesn’t hold the text');
  assert.deepEqual(Object.keys(await store.getTexts(['a', 'folder'])), ['a']);
  assert.equal(await store.setText('a', { text: 'A later copy.' }, { replace: false }), null, 'a saved text stays unless replaced');
  assert.equal(await store.setText('a', { error: 'The site answered 404.' }), null, 'a failure never replaces a text');

  const deleted = await store.removeMany(['home']);
  assert.deepEqual(await saved(), {}, 'deleting a folder deletes the texts of the bookmarks in it');
  await store.restoreMany(deleted);
  assert.equal((await store.getTexts(['a'])).a.text, 'The whole essay.', 'Undo brings them back');

  await store.update('a', { title: 'Renamed', url: 'https://example.com' });
  assert.ok((await store.getTexts(['a'])).a, 'a new title keeps the text');
  await store.update('a', { title: 'Moved', url: 'https://elsewhere.test/' });
  assert.deepEqual(await store.getTexts(['a']), {}, 'a new address is a different page');

  const first = await store.create({ parentId: 'home', title: 'First', url: 'https://page.test/', dateAdded: 1 });
  const second = await store.create({ parentId: 'home', title: 'Second', url: 'https://page.test/#top', dateAdded: 2 });
  await store.setText(second.id, text);
  await store.mergeDuplicates([[first.id, second.id]]);
  assert.deepEqual(Object.keys(await saved()), [`markedText:${first.id}`], 'the kept bookmark takes its copy’s text');

  assert.equal(await store.clearTexts(), 1);
  assert.deepEqual(await saved(), {});
});

test('a restored backup keeps each bookmark’s page text under its new bookmark', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const container = await store.importTree([{ title: 'Essay', url: 'https://essay.test/', text: { text: 'Kept words.', via: 'backup', capturedAt: 7 } }, { title: 'No text', url: 'https://plain.test/', text: { text: '   ' } }], 'home', 'Restored');
  const [essay, plain] = container.children;
  const texts = await store.getTexts([essay.id, plain.id]);
  assert.deepEqual(Object.keys(texts), [essay.id]);
  assert.deepEqual(texts[essay.id], { capturedAt: 7, via: 'backup', text: 'Kept words.', words: 2 });
  assert.equal(essay.text, undefined, 'the text isn’t part of the bookmark');
});

test('moves go before a chosen sibling, keep their order, and can be put back', async () => {
  const mock = fixture({ id: 'root', children: [{ id: 'home', parentId: 'root', title: 'Home', children: [
    { id: 'a', parentId: 'home', title: 'A', url: 'https://a.test/' },
    { id: 'b', parentId: 'home', title: 'B', url: 'https://b.test/' },
    { id: 'c', parentId: 'home', title: 'C', url: 'https://c.test/' },
    { id: 'f', parentId: 'home', title: 'F', children: [] }
  ] }] });
  const store = createLibraryStore(mock.api, mock.locks);
  const order = async () => { const [root] = await store.getTree(); const home = root.children[0]; return [home.children.map(n => n.id).join(''), home.children.find(n => n.id === 'f').children.map(n => n.id).join('')]; };
  await store.moveMany(['c'], 'home', 'a');
  assert.deepEqual(await order(), ['cabf', '']);
  await store.moveMany(['a', 'b'], 'home', 'c');
  assert.deepEqual(await order(), ['abcf', ''], 'several items keep their order');
  await store.moveMany(['a', 'b'], 'home', 'b');
  assert.deepEqual(await order(), ['abcf', ''], 'next to itself is no move');
  const places = await store.moveMany(['b', 'c'], 'f');
  assert.deepEqual(await order(), ['af', 'bc']);
  assert.deepEqual(places, [{ id: 'b', parentId: 'home', index: 1 }, { id: 'c', parentId: 'home', index: 2 }]);
  await store.placeMany(places);
  assert.deepEqual(await order(), ['abcf', ''], 'and back where they were');
});

test('a highlight’s color and note can change later, and pages learn its color from the index', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const saved = await store.addHighlight('a', { text: 'A passage', color: 'blue' });
  const changed = await store.updateHighlight('a', saved.id, { color: 'pink', note: ' Why ' });
  assert.deepEqual([changed.id, changed.text, changed.color, changed.note, changed.createdAt], [saved.id, 'A passage', 'pink', 'Why', saved.createdAt]);
  assert.deepEqual((await store.getIndex()).pages[0].highlights, [{ id: saved.id, text: 'A passage', note: 'Why', color: 'pink' }]);
  await store.updateHighlight('a', saved.id, { color: 'yellow' });
  assert.equal('color' in (await store.getIndex()).pages[0].highlights[0], false);
  await assert.rejects(store.updateHighlight('a', 'missing', { color: 'green' }), /no longer exists/);
});

test('a post’s card is kept, checked, and merged with its bookmark, and goes with its address', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const card = { site: 'hn', kind: 'story', title: 'Show HN', stats: { score: 3 }, bogus: 'dropped' };
  const node = await store.create({ parentId: 'home', title: 'Story', url: 'https://news.ycombinator.com/item?id=1', card });
  assert.deepEqual({ ...node.card, fetchedAt: 0 }, { site: 'hn', kind: 'story', title: 'Show HN', stats: { score: 3 }, fetchedAt: 0 });
  assert.equal((await store.getIndex()).pages.find(page => page.id === node.id).card, true, 'the index says it has one');
  assert.equal(await store.setCards({ a: { site: 'github', kind: 'repo', title: 'o/r' }, missing: card, home: card }), 1, 'only bookmarks take cards');
  const copy = await store.create({ parentId: 'home', title: 'Copy', url: 'https://news.ycombinator.com/item?id=1&x', dateAdded: 1 });
  await store.mergeDuplicates([[copy.id, node.id]]);
  const find = async id => (await store.getTree())[0].children[0].children.find(child => child.id === id);
  assert.equal((await find(copy.id)).card.title, 'Show HN', 'the kept bookmark takes the card');
  await store.update(copy.id, { title: 'Moved', url: 'https://elsewhere.test/' });
  assert.equal((await find(copy.id)).card, undefined);
});

test('posts from X go into one folder, newest first, skipping ones already anywhere in Marked', async () => {
  const mock = fixture({ id: 'root', children: [{ id: 'old', parentId: 'root', title: 'Saved before', url: 'https://x.com/jack/status/20', type: 'bookmark' }] });
  const store = createLibraryStore(mock.api, mock.locks);
  const post = (id, dateAdded) => ({ url: `https://x.com/ada/status/${id}`, title: `Post ${id}`, abstract: `Text ${id}`, dateAdded });
  const first = await store.importTweets([post(3, 300), post(2, 299), { url: 'https://twitter.com/jack/status/20', title: 'Known' }, { url: 'https://example.com/', title: 'Not a post' }]);
  assert.deepEqual({ added: first.added, known: first.known }, { added: 2, known: 2 });
  const second = await store.importTweets([post(2, 1), post(1, 298)]);
  assert.deepEqual({ added: second.added, known: second.known, same: second.folderId === first.folderId }, { added: 1, known: 1, same: true }, 'the same folder, and nothing twice');
  const [root] = await store.getTree();
  const folder = root.children.find(node => node.title === 'X bookmarks');
  assert.deepEqual(folder.children.map(node => [node.title, node.dateAdded, node.abstract]), [['Post 3', 300, 'Text 3'], ['Post 2', 299, 'Text 2'], ['Post 1', 298, 'Text 1']]);
});
