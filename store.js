// The bookmarks permission is used only to seed the library on first upgrade.
// All subsequent reads and writes use extension-local storage, never Firefox.
export const STORAGE_KEY = 'markedLibraryV1';
const LOCK = 'marked-library-write';

export function createLibraryStore(api, locks = navigator.locks) {
  async function read() {
    const saved = (await api.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (saved !== undefined) {
      if (saved.version !== 1 || !saved.root?.children) throw new Error('Cannot read the saved Marked library. Export a backup before changing extension data.');
      return saved;
    }
    return null;
  }
  async function initialize() {
    return locks.request(LOCK, async () => {
      const saved = await read();
      if (saved) return saved;
      // Persist successfully before showing the snapshot. A failed snapshot/save
      // never falls back to editing Firefox or replaces an existing library.
      const [root] = await api.bookmarks.getTree();
      const library = { version: 1, capturedAt: Date.now(), root };
      await api.storage.local.set({ [STORAGE_KEY]: library });
      return library;
    });
  }
  function find(root, id) {
    if (root.id === id) return root;
    for (const child of root.children || []) {
      const result = find(child, id);
      if (result) return result;
    }
  }
  function requireNode(root, id) {
    const node = find(root, id);
    if (!node) throw new Error('This item no longer exists. Refresh and try again.');
    return node;
  }
  function destination(root, id) {
    const node = requireNode(root, id);
    if (!Array.isArray(node.children)) throw new Error('Choose a destination folder.');
    return node;
  }
  function editable(root, id) {
    const node = requireNode(root, id);
    if (node.id === root.id) throw new Error('The library root cannot be changed.');
    return node;
  }
  async function mutate(action) {
    await initialize();
    return locks.request(LOCK, async () => {
      const library = await read();
      const result = action(library.root);
      await api.storage.local.set({ [STORAGE_KEY]: library });
      return result;
    });
  }
  function add(root, details) {
    const parent = destination(root, details.parentId);
    const type = details.type || (details.url ? 'bookmark' : 'folder');
    const node = { id: crypto.randomUUID(), parentId: parent.id, title: details.title || '', type, dateAdded: Date.now(), ...(type === 'folder' ? { children: [] } : {}), ...(details.url ? { url: details.url } : {}) };
    if (typeof details.preview === 'string' && details.preview.startsWith('data:image/jpeg;base64,') && details.preview.length < 500000) node.preview = details.preview;
    parent.children.push(node);
    return node;
  }
  function move(root, id, parentId) {
    const node = editable(root, id);
    const parent = destination(root, parentId);
    if (find(node, parentId)) throw new Error('A folder cannot be moved into itself or a descendant.');
    const old = destination(root, node.parentId);
    old.children = old.children.filter(child => child.id !== id);
    node.parentId = parentId;
    parent.children.push(node);
  }
  return {
    async getTree() { return [(await initialize()).root]; },
    create(details) { return mutate(root => add(root, details)); },
    update(id, changes, parentId) {
      return mutate(root => {
        const node = editable(root, id);
        if (parentId && node.parentId !== parentId) move(root, id, parentId);
        node.title = changes.title;
        if (changes.url !== undefined && changes.url !== node.url) {
          node.url = changes.url;
          delete node.preview;
        }
        if (changes.preview === null) delete node.preview;
      });
    },
    moveMany(ids, parentId) { return mutate(root => ids.forEach(id => move(root, id, parentId))); },
    removeMany(ids) {
      return mutate(root => {
        const selected = new Set(ids);
        const records = [...selected].map(id => {
          const node = editable(root, id);
          const parent = destination(root, node.parentId);
          return { node, parentId: parent.id, index: parent.children.findIndex(child => child.id === id) };
        }).filter(({ node }) => {
          let parent = find(root, node.parentId);
          while (parent) {
            if (selected.has(parent.id)) return false;
            parent = find(root, parent.parentId);
          }
          return true;
        });
        for (const { node, parentId } of records) {
          const parent = destination(root, parentId);
          parent.children = parent.children.filter(child => child.id !== node.id);
        }
        return records;
      });
    },
    restoreMany(records) {
      return mutate(root => {
        function check(node) {
          if (find(root, node.id)) throw new Error('An item from this deletion has already been restored.');
          node.children?.forEach(check);
        }
        records.forEach(({ node }) => check(node));
        for (const record of [...records].sort((a, b) => a.index - b.index)) {
          const originalParent = find(root, record.parentId);
          const parent = originalParent?.children ? originalParent : root;
          const node = structuredClone(record.node);
          node.parentId = parent.id;
          parent.children.splice(Math.min(record.index, parent.children.length), 0, node);
        }
      });
    },
    importTree(nodes, parentId, title) {
      return mutate(root => {
        const container = add(root, { parentId, title, type: 'folder' });
        function append(list, parentId) {
          for (const node of list) {
            const created = add(root, { ...node, parentId, type: node.type === 'separator' ? 'separator' : node.url ? 'bookmark' : 'folder' });
            if (node.children) append(node.children, created.id);
          }
        }
        append(nodes, container.id);
        return container;
      });
    }
  };
}
