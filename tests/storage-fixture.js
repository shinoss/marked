export function fixture(root) {
  let data = {};
  let reads = 0;
  let failWrites = false;
  let queue = Promise.resolve();
  const locks = { request: (_name, action) => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  } };
  const api = {
    bookmarks: { getTree: async () => { reads++; return structuredClone([root]); } },
    storage: {
      local: {
        get: async () => structuredClone(data),
        set: async value => { if (failWrites) throw new Error('Storage failure'); Object.assign(data, structuredClone(value)); }
      },
      onChanged: { addListener() {} }
    }
  };
  return { api, locks, reads: () => reads, failWrites: value => { failWrites = value; } };
}
