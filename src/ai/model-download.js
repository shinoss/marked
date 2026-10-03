import '../lib/browser-api.js';
import { MODEL_ORIGINS, MODEL_URL } from './config.js';

// Marked downloads the chat model itself, rather than leaving it to WebLLM, so
// that it takes one click, ever. What arrives is kept as it comes: a download
// cut short by a refresh, a reload of Marked, a closed tab or a dropped
// connection carries on from its last byte with a Range request, in whichever
// Marked tab is open. Finished files go where WebLLM 0.2.85 looks for them,
// so it then loads the model without fetching anything.

// Set while a download is wanted: from the click until it's finished, paused or removed.
export const MODEL_DOWNLOAD_KEY = 'markedModelDownload';
// Held by the one Marked tab downloading; the others queue for it.
const LOCK = 'marked-model-download';
// Progress, for the chat in other Marked tabs.
const CHANNEL = 'marked-model-download';
// WebLLM's cache (cacheBackend 'indexeddb'): a database per scope at version 1,
// each with an object store "urls" of { url, data }. JSON files are kept parsed,
// everything else as an ArrayBuffer.
const CONFIG_DB = 'webllm/config', MODEL_DB = 'webllm/model', WASM_DB = 'webllm/wasm';
// Marked's own: the pieces of weight shards still downloading.
const PIECES_DB = 'marked-model-pieces';
const fileURL = name => new URL(name, MODEL_URL).href;
const CONFIG = fileURL('mlc-chat-config.json'), TENSORS = fileURL('tensor-cache.json');
const fileName = url => url.slice(url.lastIndexOf('/') + 1);

const PARALLEL = 4;
// A shard's bytes are kept every 8 MB, and at least every 3 seconds.
const PIECE_BYTES = 8 * 2 ** 20, PIECE_MS = 3000;
// Failures in a row, without a byte arriving, before a download gives up for now.
const RETRIES = 6;

const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const committed = transaction => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = transaction.onabort = () => reject(transaction.error || new DOMException('The transaction was aborted.', 'AbortError'));
});
const databases = new Map();
function database(name) {
  if (!databases.has(name)) {
    const opened = new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      // The same store WebLLM makes, whichever of the two opens it first.
      request.onupgradeneeded = () => {
        if (name === PIECES_DB) request.result.createObjectStore('pieces', { keyPath: ['url', 'start', 'end'] });
        else if (!request.result.objectStoreNames.contains('urls')) request.result.createObjectStore('urls', { keyPath: 'url' });
      };
      request.onsuccess = () => {
        const db = request.result;
        // Opened again when next needed, if another page upgrades it or the
        // browser closes it (site data cleared).
        db.onversionchange = () => { db.close(); databases.delete(name); };
        db.onclose = () => databases.delete(name);
        resolve(db);
      };
      request.onerror = () => reject(request.error);
    });
    databases.set(name, opened);
    opened.catch(() => databases.delete(name));
  }
  return databases.get(name);
}
// Every piece of one file: keys are [url, start, end], a URL sorts before any
// longer key that starts with it, and an array after any number.
const piecesOf = url => IDBKeyRange.bound([url], [url, []]);
async function write(name, store, change) {
  const transaction = (await database(name)).transaction(store, 'readwrite');
  change(transaction.objectStore(store));
  await committed(transaction);
}
const read = async (name, store, query) => result(query((await database(name)).transaction(store).objectStore(store)));

// IndexedDB, behind a few calls that tests stand in for.
export const modelStorage = {
  keys: async name => new Set(await read(name, 'urls', store => store.getAllKeys())),
  get: async (name, url) => (await read(name, 'urls', store => store.get(url)))?.data,
  put: (name, url, data) => write(name, 'urls', store => store.put({ url, data })),
  // [url, start, end] of every piece kept.
  pieceKeys: () => read(PIECES_DB, 'pieces', store => store.getAllKeys()),
  pieces: url => read(PIECES_DB, 'pieces', store => store.getAll(piecesOf(url))),
  putPiece: (url, start, data) => write(PIECES_DB, 'pieces', store => store.put({ url, start, end: start + data.byteLength, data })),
  dropPieces: url => write(PIECES_DB, 'pieces', store => store.delete(piecesOf(url))),
  async clear() {
    for (const name of [CONFIG_DB, MODEL_DB, WASM_DB]) await write(name, 'urls', store => store.clear());
    await write(PIECES_DB, 'pieces', store => store.clear());
  }
};

const parseJSON = buffer => JSON.parse(new TextDecoder().decode(buffer));
// The weight shards that tensor-cache.json lists, where WebLLM looks for each.
const shardsOf = tensors => tensors.records.map(record => ({ url: new URL(record.dataPath, MODEL_URL).href, size: record.nbytes }));
// The tokenizer WebLLM loads: tokenizer.json when the model has one.
const tokenizerOf = config => fileURL(parseJSON(config).tokenizer_files?.includes('tokenizer.json') ? 'tokenizer.json' : 'tokenizer.model');
// How much of each file its pieces hold, counting from its first byte.
function heldInPieces(keys) {
  const ranges = new Map();
  for (const [url, start, end] of keys) {
    if (!ranges.has(url)) ranges.set(url, []);
    ranges.get(url).push([start, end]);
  }
  const held = new Map();
  for (const [url, list] of ranges) {
    let at = 0;
    for (const [start, end] of list.sort((a, b) => a[0] - b[0])) if (start === at) at = end;
    held.set(url, at);
  }
  return held;
}

// Errors worth another try: dropped connections, and Hugging Face being busy.
const fatal = message => Object.assign(new Error(message), { fatal: true });
const retryable = error => error?.name !== 'AbortError' && error?.name !== 'QuotaExceededError' && !error?.fatal;
function check(response, url) {
  if (response.ok) return;
  const message = `Hugging Face answered ${response.status} for ${fileName(url)}.`;
  if (response.status === 408 || response.status === 429 || response.status >= 500) throw new Error(message);
  throw fatal(message);
}
const delay = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
  signal.addEventListener('abort', stop, { once: true });
});
// While the browser is offline, wait for it to come back rather than fail.
const online = signal => new Promise((resolve, reject) => {
  const back = () => { signal.removeEventListener('abort', stop); resolve(); };
  const stop = () => { globalThis.removeEventListener('online', back); reject(signal.reason); };
  globalThis.addEventListener('online', back, { once: true });
  signal.addEventListener('abort', stop, { once: true });
});

// Fetches one weight shard of a known size, keeping what arrives in pieces, and
// asking only for what's missing when an earlier attempt left some behind.
async function fetchShard({ url, size }, { storage, fetch, signal, arrived }) {
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const piece of (await storage.pieces(url)).sort((a, b) => a.start - b.start)) {
    if (piece.start !== at || piece.end > size) break;
    bytes.set(new Uint8Array(piece.data), at);
    at = piece.end;
  }
  if (at === size) return bytes.buffer;
  const restart = async () => { await storage.dropPieces(url); at = 0; arrived(url, 0); };
  const response = await fetch(url, { signal, cache: 'no-store', headers: at ? { Range: `bytes=${at}-` } : {} });
  if (response.status === 416) { await restart(); throw new Error(`Hugging Face couldn't resume ${fileName(url)}.`); }
  check(response, url);
  const wrongSize = () => fatal(`${fileName(url)} on Hugging Face isn't the size the model lists.`);
  if (response.status === 206) {
    const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('Content-Range') || '');
    if (!range || Number(range[1]) !== at) { await restart(); throw new Error(`Hugging Face sent the wrong part of ${fileName(url)}.`); }
    if (Number(range[2]) !== size) throw wrongSize();
  } else {
    const length = response.headers.get('Content-Length');
    if (length !== null && !response.headers.get('Content-Encoding') && Number(length) !== size) throw wrongSize();
    // The whole file again, from its start.
    if (at) await restart();
  }
  let kept = at, keptAt = Date.now();
  const keep = async () => {
    if (at > kept) await storage.putPiece(url, kept, bytes.slice(kept, at).buffer);
    kept = at; keptAt = Date.now();
  };
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (at + value.byteLength > size) { await restart(); throw wrongSize(); }
      bytes.set(value, at);
      at += value.byteLength;
      arrived(url, at, value.byteLength);
      if (at - kept >= PIECE_BYTES || Date.now() - keptAt >= PIECE_MS) await keep();
    }
  } catch (error) {
    reader.cancel().catch(() => {});
    // Whatever arrived before the connection dropped is good: keep it.
    if (retryable(error) || error?.name === 'AbortError') await keep().catch(() => {});
    throw error;
  }
  if (at < size) { await keep(); throw new Error(`The download of ${fileName(url)} ended early.`); }
  return bytes.buffer;
}

async function fetchWhole(url, { fetch, signal, arrived }) {
  const response = await fetch(url, { signal, cache: 'no-store' });
  check(response, url);
  const data = await response.arrayBuffer();
  arrived(url, 0, data.byteLength);
  return data;
}

// Downloads every file of the model that isn't stored yet. report() hears
// { done, total, rate }: bytes of the weight shards in hand, of their total,
// and bytes a second over the last few seconds. offline() hears when it waits
// for the browser to be back online.
export async function downloadModel({ signal, report = () => {}, offline = () => {}, storage = modelStorage, fetch = globalThis.fetch.bind(globalThis), wait = delay }) {
  // Bytes in hand of each shard, and bytes received over the network so far.
  const held = new Map();
  let shards = [], received = 0, reportedAt = 0;
  const samples = [];
  function progress(force) {
    const now = Date.now();
    if (!force && now - reportedAt < 400) return;
    reportedAt = now;
    samples.push([now, received]);
    while (samples.length > 2 && now - samples[0][0] > 15000) samples.shift();
    const [since, before] = samples[0];
    report({
      done: shards.reduce((sum, shard) => sum + Math.min(shard.size, held.get(shard.url) || 0), 0),
      total: shards.reduce((sum, shard) => sum + shard.size, 0) || null,
      rate: now - since >= 5000 ? (received - before) * 1000 / (now - since) : null
    });
  }
  // Tries again after a dropped connection, waiting longer each time, and
  // gives up after RETRIES failures in a row that brought nothing new.
  async function retrying(task, signal) {
    for (let failures = 0; ;) {
      let progressed = false;
      const arrived = (url, at, count = 0) => {
        if (held.has(url)) held.set(url, at);
        if (count) { progressed = true; received += count; }
        progress(false);
      };
      try { return await task(arrived); } catch (error) {
        if (signal.aborted || !retryable(error)) throw error;
        failures = progressed ? 1 : failures + 1;
        if (failures > RETRIES) throw error;
        if (navigator.onLine === false) { offline(); await online(signal); }
        await wait(Math.min(30000, 1000 * 2 ** (failures - 1)), signal);
      }
    }
  }
  // The configuration and the shard list first: they say what else there is.
  const [stored, config] = await Promise.all([storage.keys(MODEL_DB), storage.keys(CONFIG_DB)]);
  let configData = config.has(CONFIG) ? await storage.get(CONFIG_DB, CONFIG) : null;
  if (!configData) {
    configData = await retrying(arrived => fetchWhole(CONFIG, { fetch, signal, arrived }), signal);
    parseJSON(configData);
    await storage.put(CONFIG_DB, CONFIG, configData);
  }
  let tensors = stored.has(TENSORS) ? await storage.get(MODEL_DB, TENSORS) : null;
  if (!tensors) {
    tensors = parseJSON(await retrying(arrived => fetchWhole(TENSORS, { fetch, signal, arrived }), signal));
    await storage.put(MODEL_DB, TENSORS, tensors);
  }
  shards = shardsOf(tensors);
  const tokenizer = tokenizerOf(configData);
  // What earlier attempts left, less pieces of files finished since, or no
  // longer part of the model.
  const inPieces = heldInPieces(await storage.pieceKeys());
  const listed = new Set(shards.map(shard => shard.url));
  for (const url of inPieces.keys()) if (stored.has(url) || !listed.has(url)) { await storage.dropPieces(url); inPieces.delete(url); }
  for (const shard of shards) held.set(shard.url, stored.has(shard.url) ? shard.size : inPieces.get(shard.url) || 0);
  progress(true);
  // One failure stops the others, which keep what they have as they stop.
  const inner = new AbortController();
  const stop = () => inner.abort(signal.reason);
  signal.addEventListener('abort', stop, { once: true });
  const options = { storage, fetch, signal: inner.signal };
  // The tokenizer, then shards already started, then the rest in order.
  const missing = shards.filter(shard => !stored.has(shard.url)).sort((a, b) => Number(inPieces.has(b.url)) - Number(inPieces.has(a.url)));
  const queue = [
    ...stored.has(tokenizer) ? [] : [async () => storage.put(MODEL_DB, tokenizer, await retrying(arrived => fetchWhole(tokenizer, { ...options, arrived }), inner.signal))],
    ...missing.map(shard => async () => {
      await storage.put(MODEL_DB, shard.url, await retrying(arrived => fetchShard(shard, { ...options, arrived }), inner.signal));
      await storage.dropPieces(shard.url);
      held.set(shard.url, shard.size);
      progress(true);
    })
  ];
  try {
    const results = await Promise.allSettled(Array.from({ length: PARALLEL }, async () => {
      try { for (let next; (next = queue.shift());) await next(); } catch (error) { inner.abort(); throw error; }
    }));
    const failures = results.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason);
    if (failures.length) throw failures.find(error => error?.name !== 'AbortError') || failures[0];
  } finally { signal.removeEventListener('abort', stop); }
}

// What's on this device: whether the model is complete; bytes of its shards in
// hand (finished, or in pieces) and their total; whether a download is wanted;
// whether a Marked tab is downloading right now, and if so whether it's this one.
export async function modelStatus({ storage = modelStorage } = {}) {
  const [stored, config, pieceKeys, saved, locks] = await Promise.all([
    storage.keys(MODEL_DB), storage.keys(CONFIG_DB), storage.pieceKeys(),
    browser.storage.local.get(MODEL_DOWNLOAD_KEY), navigator.locks?.query?.().catch(() => null)
  ]);
  const tensors = stored.has(TENSORS) ? await storage.get(MODEL_DB, TENSORS) : null;
  const configData = config.has(CONFIG) ? await storage.get(CONFIG_DB, CONFIG) : null;
  const shards = tensors ? shardsOf(tensors) : [];
  const inPieces = heldInPieces(pieceKeys);
  return {
    complete: !!tensors && !!configData && stored.has(tokenizerOf(configData)) && shards.every(shard => stored.has(shard.url)),
    done: shards.reduce((sum, shard) => sum + (stored.has(shard.url) ? shard.size : Math.min(shard.size, inPieces.get(shard.url) || 0)), 0),
    total: shards.reduce((sum, shard) => sum + shard.size, 0) || null,
    wanted: !!saved[MODEL_DOWNLOAD_KEY],
    downloading: !!locks?.held?.some(lock => lock.name === LOCK),
    here: downloadingHere
  };
}

// This tab's part: its listeners, and the download when it runs here.
const listeners = new Set();
let listening = false, channel = null, current = null, downloadingHere = false;
function tell(event, everywhere = true) {
  for (const listener of listeners) {
    try { listener(event); } catch (error) { console.error(error); }
  }
  if (everywhere) channel?.postMessage(event);
}
// Asked for, paused, finished or removed in another Marked tab.
function listen() {
  if (listening) return;
  listening = true;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[MODEL_DOWNLOAD_KEY]) return;
    if (changes[MODEL_DOWNLOAD_KEY].newValue) resumeDownload(); else current?.abort.abort();
  });
}
function connect() {
  listen();
  if (channel) return;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = ({ data }) => tell({ ...data, elsewhere: true }, false);
}
// Events: progress { done, total, rate }; waiting (offline); complete; removed;
// stopped { reason: paused, permission or error; message }. They carry
// elsewhere: true when they come from another Marked tab.
export function watchDownload(listener) {
  connect();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Carries on a download that's wanted: in this tab if no other Marked tab has
// it, or else once that tab closes. Does nothing when none is wanted.
export function resumeDownload() {
  listen();
  if (current && !current.abort.signal.aborted) return current.promise;
  // Paused a moment ago and asked for again: once the paused one has stopped.
  if (current) return current.promise.then(resumeDownload);
  const abort = new AbortController();
  const promise = (async () => {
    if (!(await browser.storage.local.get(MODEL_DOWNLOAD_KEY))[MODEL_DOWNLOAD_KEY]) return;
    connect();
    // Taken back in the browser's settings since: only a click can ask again.
    if (!await browser.permissions.contains({ origins: MODEL_ORIGINS })) { tell({ type: 'stopped', reason: 'permission' }); return; }
    let holding = false;
    try {
      await navigator.locks.request(LOCK, { signal: abort.signal }, async () => {
        holding = true;
        // Finished, paused or removed while this tab waited its turn.
        if (!(await browser.storage.local.get(MODEL_DOWNLOAD_KEY))[MODEL_DOWNLOAD_KEY]) return;
        downloadingHere = true;
        try {
          await downloadModel({ signal: abort.signal, report: progress => tell({ type: 'progress', ...progress }), offline: () => tell({ type: 'waiting' }) });
        } finally { downloadingHere = false; }
        await browser.storage.local.remove(MODEL_DOWNLOAD_KEY);
        tell({ type: 'complete' });
      });
    } catch (error) {
      // Stopped while queued behind another tab, which says what happened.
      if (!holding) return;
      tell(abort.signal.aborted ? { type: 'stopped', reason: 'paused' } : { type: 'stopped', reason: 'error', message: error?.message || String(error) });
    }
  })().catch(error => console.error('Could not resume the model download', error))
    .finally(() => { if (current?.abort === abort) current = null; });
  current = { promise, abort };
  return promise;
}

// After the click that asks for it, the download carries on by itself.
export async function startDownload() {
  await browser.storage.local.set({ [MODEL_DOWNLOAD_KEY]: { since: Date.now() } });
  return resumeDownload();
}

// Stops the download in whichever Marked tab has it, keeping what's downloaded.
export async function pauseDownload() {
  await browser.storage.local.remove(MODEL_DOWNLOAD_KEY);
  current?.abort.abort();
}

// Deletes the model, and what's downloaded of it, from this device.
export async function removeModel() {
  connect();
  await pauseDownload();
  // Once the tab downloading has let go.
  await navigator.locks.request(LOCK, () => modelStorage.clear());
  tell({ type: 'removed' });
}
