import { STORAGE_KEY } from '../store.js';

// root: the saved Marked library, or null before Marked's first run.
// browserTree: the browser's own bookmarks, as bookmarks.getTree() returns them.
export function fixture(root, browserTree = root || { id: 'root________', children: [] }) {
  let data = root ? { [STORAGE_KEY]: { version: 1, createdAt: 0, root: structuredClone(root) } } : {};
  let reads = 0;
  let failWrites = false;
  let queue = Promise.resolve();
  const locks = { request: (_name, action) => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  } };
  const api = {
    bookmarks: { getTree: async () => { reads++; return structuredClone([browserTree]); } },
    storage: {
      local: {
        // Like the browser's: one key, a list of keys, or everything (null or nothing).
        get: async keys => {
          if (keys == null) return structuredClone(data);
          const wanted = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
          return structuredClone(Object.fromEntries(wanted.filter(key => key in data).map(key => [key, data[key]])));
        },
        set: async value => { if (failWrites) throw new Error('Storage failure'); Object.assign(data, structuredClone(value)); },
        remove: async keys => { if (failWrites) throw new Error('Storage failure'); for (const key of [].concat(keys)) delete data[key]; }
      },
      onChanged: { addListener() {} }
    }
  };
  return { api, locks, reads: () => reads, failWrites: value => { failWrites = value; } };
}
