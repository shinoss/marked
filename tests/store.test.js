import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLibraryStore } from '../store.js';
import { fixture } from './storage-fixture.js';
const tree = () => ({ id: 'root', children: [{ id: 'home', parentId: 'root', title: 'Home', children: [{ id: 'a', parentId: 'home', title: 'Original', url: 'https://example.com' }, { id: 'folder', parentId: 'home', title: 'Folder', children: [] }] }] });

test('snapshots once, persists edits across instances, and never changes Firefox', async () => {
  const firefox = tree(); const original = structuredClone(firefox);
  const mock = fixture(firefox); const store = createLibraryStore(mock.api, mock.locks);
  assert.deepEqual((await store.getTree())[0], original);
  await store.update('a', { title: 'Independent' });
  await store.moveMany(['a'], 'folder');
  firefox.children[0].title = 'Changed in Firefox';
  const reopened = createLibraryStore(mock.api, mock.locks);
  const [saved] = await reopened.getTree();
  assert.equal(saved.children[0].title, 'Home');
  assert.equal(saved.children[0].children[0].children[0].title, 'Independent');
  await reopened.removeMany(['folder']);
  assert.deepEqual(firefox.children[0].children, original.children[0].children);
  assert.equal(mock.reads(), 1);
});
test('serializes concurrent initialization and writes from separate tabs', async () => {
  const mock = fixture(tree());
  const a = createLibraryStore(mock.api, mock.locks), b = createLibraryStore(mock.api, mock.locks);
  await Promise.all([a.getTree(), b.getTree()]);
  await Promise.all([a.create({ parentId: 'home', title: 'One', url: 'https://one.test' }), b.create({ parentId: 'home', title: 'Two', url: 'https://two.test' })]);
  assert.equal((await a.getTree())[0].children[0].children.length, 4);
  assert.equal(mock.reads(), 1);
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

test('imports an entire hierarchy atomically into local storage', async () => {
  const mock = fixture(tree()); const store = createLibraryStore(mock.api, mock.locks);
  const nodes = [{ title: 'Nested', children: [{ title: 'Site', url: 'https://example.org/' }] }];
  await store.getTree(); mock.failWrites(true);
  await assert.rejects(store.importTree(nodes, 'home', 'Import'), /Storage failure/);
  mock.failWrites(false);
  assert.equal((await store.getTree())[0].children[0].children.length, 2);
  const imported = await store.importTree(nodes, 'home', 'Import');
  assert.equal(imported.children[0].children[0].title, 'Site');
  assert.equal(mock.reads(), 1);
});
