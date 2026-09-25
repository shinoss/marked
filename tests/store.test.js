import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore, DEFAULT_TAGS } from '../store.js';
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

test('stores local previews, preserves them through undo, and clears stale previews', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const preview = 'data:image/jpeg;base64,dGVzdA==';
  const node = await store.create({ parentId: 'home', title: 'Preview', url: 'https://example.test/', preview });
  assert.equal(node.preview, preview);
  await store.update(node.id, { title: 'Renamed', url: node.url });
  const deleted = await store.removeMany([node.id]);
  assert.equal(deleted[0].node.preview, preview);
  await store.restoreMany(deleted);
  await store.update(node.id, { title: 'Changed URL', url: 'https://different.test/' });
  const [root] = await store.getTree();
  assert.equal(root.children[0].children.find(n => n.id === node.id).preview, undefined);
  const unsafe = await store.create({ parentId: 'home', title: 'No remote preview', url: node.url, preview: 'https://remote.test/image.jpg' });
  assert.equal(unsafe.preview, undefined);
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
