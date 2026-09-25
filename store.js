import { cleanAbstract, cleanNote, cleanTag, cleanTags, cleanHighlight, cleanHighlights, planBrowserImport, tweetId, validIcon, HIGHLIGHTS_PER_BOOKMARK } from './bookmarks.js';
import { cleanPageText } from './page-text.js';
import { cleanCard } from './sites.js';

// The bookmarks permission is used only to read the browser's bookmarks when the
// user imports them. The library lives in extension-local storage and never
// changes the browser's own bookmarks.
export const STORAGE_KEY = 'markedLibraryV1';
// What web pages and the address bar need at a glance: each bookmark's address,
// title, and highlights, without the previews the library holds. It is
// rewritten with every change, so nothing reads the whole library on each page.
export const INDEX_KEY = 'markedIndexV1';
// Each bookmark's page text has a key of its own, apart from the library, so a
// change to the library never rewrites every page's text.
export const TEXT_PREFIX = 'markedText:';
export const textKey = id => `${TEXT_PREFIX}${id}`;
const bookmarkIds = node => node.url ? [node.id] : (node.children || []).flatMap(bookmarkIds);
const LOCK = 'marked-library-write';
// The tag list lives beside the tree; libraries saved before tags start with these.
export const DEFAULT_TAGS = ['Technology', 'AI', 'History', 'Fiction'];
const TAG_LIST_LIMIT = 100;
const tagList = library => Array.isArray(library.tags) ? cleanTags(library.tags, TAG_LIST_LIMIT) : [...DEFAULT_TAGS];
function remember(library, tags) {
  if (tags?.length) library.tags = cleanTags([...tagList(library), ...tags], TAG_LIST_LIMIT);
}

export function indexLibrary(root) {
  const pages = [];
  (function walk(node) {
    if (node.url) {
      const highlights = (node.highlights || []).map(({ id, text, note, color }) => ({ id, text, ...(note && { note }), ...(color && { color }) }));
      pages.push({ id: node.id, url: node.url, title: node.title || '', dateAdded: node.dateAdded || 0, ...(highlights.length && { highlights }), ...(node.card && { card: true }) });
    }
    node.children?.forEach(walk);
  })(root);
  return { version: 1, pages };
}
const withIndex = library => ({ [STORAGE_KEY]: library, [INDEX_KEY]: indexLibrary(library.root) });

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
      // A new library starts empty. Marked asks before importing the browser's
      // bookmarks (importBrowser) instead of copying them unasked.
      const now = Date.now();
      const library = { version: 1, createdAt: now, root: { id: 'root', title: '', type: 'folder', dateAdded: now, children: [] } };
      await api.storage.local.set(withIndex(library));
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
  // Changes the library under the lock; then, still under it, after(result)
  // brings the page texts in line.
  async function mutate(action, after) {
    await initialize();
    return locks.request(LOCK, async () => {
      const library = await read();
      const result = action(library.root, library);
      await api.storage.local.set(withIndex(library));
      return after ? after(result) : result;
    });
  }
  async function locked(action) {
    await initialize();
    return locks.request(LOCK, action);
  }
  async function takeTexts(ids) {
    if (!ids.length) return {};
    const saved = await api.storage.local.get(ids.map(textKey));
    const keys = Object.keys(saved);
    if (keys.length) await api.storage.local.remove(keys);
    return Object.fromEntries(keys.map(key => [key.slice(TEXT_PREFIX.length), saved[key]]));
  }
  function add(root, details, parent = destination(root, details.parentId)) {
    const type = details.type || (details.url ? 'bookmark' : 'folder');
    // Restored backups keep their original dates; everything else is new.
    const dateAdded = Number.isFinite(details.dateAdded) && details.dateAdded > 0 ? details.dateAdded : Date.now();
    const node = { id: crypto.randomUUID(), parentId: parent.id, title: details.title || '', type, dateAdded, ...(type === 'folder' ? { children: [] } : {}), ...(details.url ? { url: details.url } : {}) };
    if (typeof details.preview === 'string' && details.preview.startsWith('data:image/jpeg;base64,') && details.preview.length < 500000) node.preview = details.preview;
    if (validIcon(details.icon)) node.icon = details.icon;
    const card = type === 'bookmark' && cleanCard(details.card);
    if (card) node.card = card;
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
  // Moves a node into parentId, before the child beforeId or at the end.
  function move(root, id, parentId, beforeId = null) {
    const node = editable(root, id);
    const parent = destination(root, parentId);
    if (find(node, parentId)) throw new Error('A folder cannot be moved into itself or a descendant.');
    const old = destination(root, node.parentId);
    old.children = old.children.filter(child => child.id !== id);
    node.parentId = parentId;
    const at = beforeId ? parent.children.findIndex(child => child.id === beforeId) : -1;
    if (at >= 0) parent.children.splice(at, 0, node); else parent.children.push(node);
  }
  return {
    async getTree() { return [(await initialize()).root]; },
    // Libraries saved before the index existed get one the first time it's read.
    async getIndex() {
      const index = (await api.storage.local.get(INDEX_KEY))[INDEX_KEY];
      if (index?.version === 1) return index;
      await initialize();
      return locks.request(LOCK, async () => {
        const index = indexLibrary((await read()).root);
        await api.storage.local.set({ [INDEX_KEY]: index });
        return index;
      });
    },
    async getTags() { return tagList(await initialize()); },
    create(details) {
      return mutate((root, library) => {
        const node = add(root, details);
        remember(library, node.tags);
        return node;
      });
    },
    update(id, changes, parentId) {
      let moved = false;
      return mutate((root, library) => {
        const node = editable(root, id);
        if (parentId && node.parentId !== parentId) move(root, id, parentId);
        node.title = changes.title;
        // A new address is a different page: its preview, icon, card, and text go.
        if (changes.url !== undefined && changes.url !== node.url) {
          node.url = changes.url;
          delete node.preview;
          delete node.icon;
          delete node.card;
          moved = true;
        }
        if (changes.card !== undefined && node.url) {
          const card = cleanCard(changes.card);
          if (card) node.card = card; else delete node.card;
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
      }, async () => { if (moved) await api.storage.local.remove(textKey(id)); });
    },
    // Moves ids, in order, into parentId before beforeId (or at the end), and
    // returns where each was, for placeMany to put them back.
    moveMany(ids, parentId, beforeId = null) {
      return mutate(root => {
        const places = ids.map(id => {
          const parent = destination(root, editable(root, id).parentId);
          return { id, parentId: parent.id, index: parent.children.findIndex(child => child.id === id) };
        });
        // Moving next to one of the items being moved: anchor on the next item that stays.
        let anchor = beforeId;
        if (anchor && ids.includes(anchor)) {
          const siblings = destination(root, parentId).children;
          anchor = siblings.slice(siblings.findIndex(child => child.id === anchor)).find(child => !ids.includes(child.id))?.id ?? null;
        }
        ids.forEach(id => move(root, id, parentId, anchor));
        return places;
      });
    },
    // Puts nodes back where moveMany found them.
    placeMany(places) {
      return mutate(root => {
        for (const { id, parentId, index } of [...places].sort((a, b) => a.index - b.index)) {
          const node = find(root, id), parent = find(root, parentId);
          if (!node || !Array.isArray(parent?.children) || find(node, parentId)) continue;
          const old = find(root, node.parentId);
          if (old?.children) old.children = old.children.filter(child => child.id !== id);
          node.parentId = parentId;
          parent.children.splice(Math.min(index, parent.children.length), 0, node);
        }
      });
    },
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
      }, async records => {
        // The page texts go too, into the records, so Undo can bring them back.
        const texts = await takeTexts(records.flatMap(({ node }) => bookmarkIds(node)));
        for (const record of records) {
          const own = bookmarkIds(record.node).filter(id => texts[id]);
          if (own.length) record.texts = Object.fromEntries(own.map(id => [id, texts[id]]));
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
      }, async () => {
        const texts = Object.assign({}, ...records.map(record => record.texts || {}));
        const entries = Object.entries(texts).map(([id, text]) => [textKey(id), text]);
        if (entries.length) await api.storage.local.set(Object.fromEntries(entries));
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
    // Changes a highlight's note or color.
    updateHighlight(id, highlightId, changes) {
      return mutate(root => {
        const node = editable(root, id);
        const index = (node.highlights || []).findIndex(highlight => highlight.id === highlightId);
        if (index < 0) throw new Error('This highlight no longer exists. Refresh and try again.');
        node.highlights[index] = cleanHighlight({ ...node.highlights[index], ...changes });
        return node.highlights[index];
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
    // Restored backups bring their page texts, kept under the new bookmarks.
    importTree(nodes, parentId, title) {
      const texts = {};
      // New items share one date, so sorting by date keeps them in their order.
      const now = Date.now();
      return mutate((root, library) => {
        const container = add(root, { parentId, title, type: 'folder', dateAdded: now });
        function append(list, parentId) {
          for (const node of list) {
            const created = add(root, { ...node, dateAdded: Number.isFinite(node.dateAdded) && node.dateAdded > 0 ? node.dateAdded : now, parentId, type: node.type === 'separator' ? 'separator' : node.url ? 'bookmark' : 'folder' });
            remember(library, created.tags);
            const text = created.url && cleanPageText(node.text);
            if (text?.text) texts[textKey(created.id)] = text;
            if (node.children) append(node.children, created.id);
          }
        }
        append(nodes, container.id);
        return container;
      }, async container => {
        if (Object.keys(texts).length) await api.storage.local.set(texts);
        return container;
      });
    },
    // Folds each group of bookmarks for one page into its oldest bookmark, which
    // keeps every tag, note, and highlight. Returns how many copies were removed.
    mergeDuplicates(groups) {
      const merged = [];
      return mutate(root => {
        let removed = 0;
        for (const ids of groups) {
          const nodes = ids.map(id => find(root, id)).filter(node => node?.url);
          if (nodes.length < 2) continue;
          nodes.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0));
          const [keep, ...copies] = nodes;
          const tags = cleanTags(nodes.flatMap(node => node.tags || []));
          if (tags.length) keep.tags = tags;
          const notes = [...new Set(nodes.map(node => node.note).filter(Boolean))];
          if (notes.length) keep.note = cleanNote(notes.join('\n\n'));
          const seen = new Set();
          const highlights = nodes.flatMap(node => node.highlights || []).filter(highlight => !seen.has(highlight.text) && seen.add(highlight.text));
          if (highlights.length) keep.highlights = highlights.slice(0, HIGHLIGHTS_PER_BOOKMARK);
          for (const field of ['abstract', 'preview', 'icon', 'card']) {
            const found = keep[field] || copies.find(node => node[field])?.[field];
            if (found) keep[field] = found;
          }
          for (const copy of copies) {
            const parent = find(root, copy.parentId);
            if (parent?.children) parent.children = parent.children.filter(child => child.id !== copy.id);
            removed++;
          }
          merged.push({ keep: keep.id, copies: copies.map(copy => copy.id) });
        }
        return removed;
      }, async removed => {
        if (!merged.length) return removed;
        // The kept bookmark takes a copy's page text if it has none of its own.
        const texts = await takeTexts(merged.flatMap(group => group.copies));
        const saved = await api.storage.local.get(merged.map(group => textKey(group.keep)));
        const adopted = {};
        for (const { keep, copies } of merged) {
          const found = copies.map(id => texts[id]).find(text => text?.text);
          if (found && !saved[textKey(keep)]?.text) adopted[textKey(keep)] = found;
        }
        if (Object.keys(adopted).length) await api.storage.local.set(adopted);
        return removed;
      });
    },
    // Posts from X, newest first, into the folder named title at the top of the
    // library (made if needed). Posts already anywhere in Marked are skipped.
    // Returns how many were added and already known, and the folder.
    importTweets(tweets, title = 'X bookmarks') {
      return mutate(root => {
        const known = new Set();
        (function walk(node) {
          const id = node.url && tweetId(node.url);
          if (id) known.add(id);
          node.children?.forEach(walk);
        })(root);
        const folder = root.children.find(child => Array.isArray(child.children) && !child.url && child.title === title) || add(root, { parentId: root.id, title, type: 'folder' });
        let added = 0, skipped = 0;
        for (const tweet of tweets) {
          const id = tweetId(tweet.url);
          if (!id || known.has(id)) { skipped++; continue; }
          known.add(id);
          add(root, { title: tweet.title, url: tweet.url, abstract: tweet.abstract, dateAdded: tweet.dateAdded, type: 'bookmark' }, folder);
          added++;
        }
        return { added, known: skipped, folderId: folder.id };
      });
    },
    // Sets the cards of several bookmarks at once: { id: card }.
    setCards(cards) {
      return mutate(root => {
        let count = 0;
        for (const [id, value] of Object.entries(cards)) {
          const node = find(root, id), card = cleanCard(value);
          if (!node?.url || !card) continue;
          node.card = card;
          count++;
        }
        return count;
      });
    },
    // Page texts by bookmark id, for those of ids that have one.
    async getTexts(ids) {
      if (!ids.length) return {};
      const saved = await api.storage.local.get(ids.map(textKey));
      return Object.fromEntries(ids.filter(id => saved[textKey(id)]).map(id => [id, saved[textKey(id)]]));
    },
    // Keeps a page's text with its bookmark and returns it as saved. Unless
    // replace, a text already saved stays; a failure never replaces a text.
    // Null if nothing changed.
    setText(id, value, { replace = true } = {}) {
      const text = cleanPageText(value);
      if (!text) return Promise.resolve(null);
      return locked(async () => {
        if (!find((await read()).root, id)?.url) return null;
        const old = (await api.storage.local.get(textKey(id)))[textKey(id)];
        if (old?.text && (!replace || !text.text)) return null;
        await api.storage.local.set({ [textKey(id)]: text });
        return text;
      });
    },
    // Deletes every page text, including any left behind by a bookmark.
    clearTexts() {
      return locked(async () => {
        const keys = Object.keys(await api.storage.local.get(null)).filter(key => key.startsWith(TEXT_PREFIX));
        if (keys.length) await api.storage.local.remove(keys);
        return keys.length;
      });
    },
    // Copies the browser's bookmarks that the library doesn't have yet, keeping
    // their folders: each goes into the folder with the same id or name, or a
    // new one. Returns how many bookmarks were added.
    async importBrowser() {
      const [browserRoot] = await api.bookmarks.getTree();
      return mutate(root => {
        const { nodes, count } = planBrowserImport(browserRoot, root);
        (function merge(list, parent) {
          for (const node of list) {
            if (node.url) { add(root, node, parent); continue; }
            const name = node.title.toLowerCase();
            const folder = parent.children.find(child => Array.isArray(child.children) && !child.url && (child.id === node.id || (child.title || '').toLowerCase() === name))
              || add(root, { title: node.title, type: 'folder', dateAdded: node.dateAdded }, parent);
            merge(node.children, folder);
          }
        })(nodes, root);
        return count;
      });
    }
  };
}
