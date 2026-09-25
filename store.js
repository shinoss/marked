import { cleanAbstract, cleanNote, cleanTag, cleanTags, cleanHighlight, cleanHighlights, HIGHLIGHTS_PER_BOOKMARK } from './bookmarks.js';

// The bookmarks permission is used only to seed the library on first upgrade.
// All subsequent reads and writes use extension-local storage, never the
// browser's own bookmarks.
export const STORAGE_KEY = 'markedLibraryV1';
const LOCK = 'marked-library-write';
// The tag list lives beside the tree; libraries saved before tags start with these.
export const DEFAULT_TAGS = ['Technology', 'AI', 'History', 'Fiction'];
const TAG_LIST_LIMIT = 100;
const tagList = library => Array.isArray(library.tags) ? cleanTags(library.tags, TAG_LIST_LIMIT) : [...DEFAULT_TAGS];
function remember(library, tags) {
  if (tags?.length) library.tags = cleanTags([...tagList(library), ...tags], TAG_LIST_LIMIT);
}

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
      // never falls back to editing browser bookmarks or replaces an existing library.
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
      const result = action(library.root, library);
      await api.storage.local.set({ [STORAGE_KEY]: library });
      return result;
    });
  }
  function add(root, details) {
    const parent = destination(root, details.parentId);
    const type = details.type || (details.url ? 'bookmark' : 'folder');
    // Restored backups keep their original dates; everything else is new.
    const dateAdded = Number.isFinite(details.dateAdded) && details.dateAdded > 0 ? details.dateAdded : Date.now();
    const node = { id: crypto.randomUUID(), parentId: parent.id, title: details.title || '', type, dateAdded, ...(type === 'folder' ? { children: [] } : {}), ...(details.url ? { url: details.url } : {}) };
    if (typeof details.preview === 'string' && details.preview.startsWith('data:image/jpeg;base64,') && details.preview.length < 500000) node.preview = details.preview;
    if (type === 'bookmark') {
      const abstract = cleanAbstract(details.abstract), note = cleanNote(details.note), tags = cleanTags(details.tags), highlights = cleanHighlights(details.highlights);
      if (abstract) node.abstract = abstract;
      if (note) node.note = note;
      if (tags.length) node.tags = tags;
      if (highlights.length) node.highlights = highlights;
    }
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
    async getTags() { return tagList(await initialize()); },
    create(details) {
      return mutate((root, library) => {
        const node = add(root, details);
        remember(library, node.tags);
        return node;
      });
    },
    update(id, changes, parentId) {
      return mutate((root, library) => {
        const node = editable(root, id);
        if (parentId && node.parentId !== parentId) move(root, id, parentId);
        node.title = changes.title;
        if (changes.url !== undefined && changes.url !== node.url) {
          node.url = changes.url;
          delete node.preview;
        }
        if (changes.preview === null) delete node.preview;
        if (changes.abstract !== undefined && node.url) {
          const abstract = cleanAbstract(changes.abstract);
          if (abstract) node.abstract = abstract; else delete node.abstract;
        }
        if (changes.note !== undefined && node.url) {
          const note = cleanNote(changes.note);
          if (note) node.note = note; else delete node.note;
        }
        if (changes.tags !== undefined && node.url) {
          const tags = cleanTags(changes.tags);
          if (tags.length) node.tags = tags; else delete node.tags;
          remember(library, tags);
        }
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
    addHighlight(id, highlight) {
      return mutate(root => {
        const node = editable(root, id);
        if (!node.url) throw new Error('Only bookmarks can have highlights.');
        const cleaned = cleanHighlight(highlight);
        if (!cleaned) throw new Error('Select some text to highlight.');
        if ((node.highlights?.length || 0) >= HIGHLIGHTS_PER_BOOKMARK) throw new Error(`A bookmark keeps up to ${HIGHLIGHTS_PER_BOOKMARK} highlights. Delete one first.`);
        node.highlights = [...(node.highlights || []), cleaned];
        return cleaned;
      });
    },
    removeHighlight(id, highlightId) {
      return mutate(root => {
        const node = editable(root, id);
        const kept = (node.highlights || []).filter(highlight => highlight.id !== highlightId);
        if (kept.length) node.highlights = kept; else delete node.highlights;
      });
    },
    addTag(name) {
      return mutate((root, library) => {
        const tag = cleanTag(name), tags = tagList(library);
        if (!tag) throw new Error('Enter a tag name.');
        if (tags.some(existing => existing.toLowerCase() === tag.toLowerCase())) throw new Error(`“${tag}” is already a tag.`);
        if (tags.length >= TAG_LIST_LIMIT) throw new Error(`Marked keeps up to ${TAG_LIST_LIMIT} tags. Remove one first.`);
        remember(library, [tag]);
        return tag;
      });
    },
    // Removes a tag from the tag list and from every bookmark; returns how many had it.
    removeTag(name) {
      return mutate((root, library) => {
        const key = cleanTag(name).toLowerCase();
        library.tags = tagList(library).filter(tag => tag.toLowerCase() !== key);
        let count = 0;
        (function walk(node) {
          const kept = node.tags?.filter(tag => tag.toLowerCase() !== key);
          if (kept && kept.length !== node.tags.length) {
            count++;
            if (kept.length) node.tags = kept; else delete node.tags;
          }
          node.children?.forEach(walk);
        })(root);
        return count;
      });
    },
    importTree(nodes, parentId, title) {
      return mutate((root, library) => {
        const container = add(root, { parentId, title, type: 'folder' });
        function append(list, parentId) {
          for (const node of list) {
            const created = add(root, { ...node, parentId, type: node.type === 'separator' ? 'separator' : node.url ? 'bookmark' : 'folder' });
            remember(library, created.tags);
            if (node.children) append(node.children, created.id);
          }
        }
        append(nodes, container.id);
        return container;
      });
    }
  };
}
