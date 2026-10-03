import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_URL } from '../src/ai/config.js';
import { downloadModel, modelStatus, MODEL_DOWNLOAD_KEY } from '../src/ai/model-download.js';
import { memory, fakeModel, huggingFace } from './model-fixture.js';

const url = name => MODEL_URL + name;
const shardNames = files => [...files.keys()].filter(name => name.startsWith('params_shard_'));
const run = (options = {}) => downloadModel({ signal: new AbortController().signal, wait: async () => {}, ...options });
// Requests for one file: their Range headers, and the bytes all of them were sent.
function requests(log, name) {
  const mine = log.filter(request => request.name === name);
  return { ranges: mine.map(request => request.range), sent: mine.reduce((sum, request) => sum + request.sent, 0) };
}
// The configuration, shard list and tokenizer, already downloaded.
async function started(files) {
  const storage = memory();
  await storage.put('webllm/config', url('mlc-chat-config.json'), files.get('mlc-chat-config.json').slice().buffer);
  await storage.put('webllm/model', url('tensor-cache.json'), JSON.parse(new TextDecoder().decode(files.get('tensor-cache.json'))));
  await storage.put('webllm/model', url('tokenizer.json'), files.get('tokenizer.json').slice().buffer);
  return storage;
}
const shard = (storage, name) => new Uint8Array(storage.dbs['webllm/model'].get(url(name)));
async function until(condition, ms = 5000) {
  for (const end = Date.now() + ms; !condition();) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('every file lands where WebLLM 0.2.85 reads it from, and a shard cut off partway carries on from its last byte', async () => {
  const files = fakeModel();
  let dropped = false;
  const hf = huggingFace(files, name => name === 'params_shard_1.bin' && !dropped ? (dropped = true, { cutAfter: 30_000 }) : null);
  const storage = memory();
  const reports = [];
  await run({ storage, fetch: hf.fetch, report: progress => reports.push(progress) });
  const config = storage.dbs['webllm/config'].get(url('mlc-chat-config.json'));
  assert.ok(config instanceof ArrayBuffer, 'WebLLM decodes the configuration from an ArrayBuffer');
  assert.equal(JSON.parse(new TextDecoder().decode(config)).tokenizer_files[0], 'tokenizer.json');
  assert.equal(storage.dbs['webllm/model'].get(url('tensor-cache.json')).records.length, 3, 'tensor-cache.json is kept parsed, as WebLLM keeps JSON');
  assert.ok(storage.dbs['webllm/model'].get(url('tokenizer.json')) instanceof ArrayBuffer);
  for (const name of shardNames(files)) assert.deepEqual(shard(storage, name), files.get(name), name);
  assert.deepEqual(requests(hf.log, 'params_shard_1.bin'), { ranges: [null, 'bytes=30000-'], sent: 60_000 }, 'no byte is fetched twice');
  assert.deepEqual(await storage.pieceKeys(), [], 'pieces go once their shard is stored');
  assert.deepEqual([reports[0].done, reports.at(-1).done, reports.at(-1).total], [0, 240_000, 240_000]);
});

test('a download stopped partway (a refresh, a closed tab, a reload) resumes in the next run without fetching anything twice', async () => {
  const files = fakeModel([200_000, 50_000, 50_000]);
  const storage = memory();
  const stop = new AbortController();
  const first = huggingFace(files, name => name === 'params_shard_0.bin' ? { hangAfter: 120_000 } : null);
  const stopped = run({ storage, fetch: first.fetch, signal: stop.signal });
  await until(() => requests(first.log, 'params_shard_0.bin').sent === 120_000 && storage.dbs['webllm/model'].has(url('params_shard_2.bin')));
  stop.abort();
  await assert.rejects(stopped, { name: 'AbortError' });
  assert.deepEqual(await storage.pieceKeys(), [[url('params_shard_0.bin'), 0, 120_000]], 'what arrived is kept as it stops');

  const second = huggingFace(files);
  const reports = [];
  await run({ storage, fetch: second.fetch, report: progress => reports.push(progress) });
  assert.deepEqual(second.log.map(request => [request.name, request.range]), [['params_shard_0.bin', 'bytes=120000-']], 'only the rest of the unfinished shard');
  assert.equal(reports[0].done, 220_000, 'progress starts from what is already on the device');
  assert.deepEqual(shard(storage, 'params_shard_0.bin'), files.get('params_shard_0.bin'));
  assert.equal(requests(first.log, 'params_shard_0.bin').sent + requests(second.log, 'params_shard_0.bin').sent, 200_000);
});

test('a server that ignores Range sends the shard again from the start, and the wrong part is asked for again', async () => {
  const files = fakeModel([100_000]);
  const halfway = async () => {
    const storage = await started(files);
    await storage.putPiece(url('params_shard_0.bin'), 0, files.get('params_shard_0.bin').slice(0, 30_000).buffer);
    return storage;
  };
  let storage = await halfway();
  const ignoring = huggingFace(files, () => ({ ignoreRange: true }));
  await run({ storage, fetch: ignoring.fetch });
  assert.deepEqual(requests(ignoring.log, 'params_shard_0.bin'), { ranges: ['bytes=30000-'], sent: 100_000 });
  assert.deepEqual(shard(storage, 'params_shard_0.bin'), files.get('params_shard_0.bin'));
  assert.deepEqual(await storage.pieceKeys(), []);

  storage = await halfway();
  let misplaced = false;
  const wrongPart = huggingFace(files, (name, request) => request.range && !misplaced ? (misplaced = true, { start: 0 }) : null);
  await run({ storage, fetch: wrongPart.fetch });
  assert.deepEqual(requests(wrongPart.log, 'params_shard_0.bin').ranges, ['bytes=30000-', null], 'pieces that may not fit are dropped, and the shard starts over');
  assert.deepEqual(shard(storage, 'params_shard_0.bin'), files.get('params_shard_0.bin'));
});

test('dropped connections and a busy server are retried, waiting longer each time; other errors stop the download', async () => {
  const files = fakeModel([50_000, 50_000]);
  let busy = 2;
  const waits = [];
  const unavailable = huggingFace(files, name => name === 'params_shard_1.bin' && busy-- > 0 ? { status: 503 } : null);
  await run({ storage: memory(), fetch: unavailable.fetch, wait: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [1000, 2000]);

  // Each drop brought bytes, so none counts toward giving up.
  let drops = 0;
  const flaky = huggingFace(files, name => name === 'params_shard_1.bin' && drops++ < 4 ? { cutAfter: 10_000 } : null);
  const flakyWaits = [];
  const storage = memory();
  await run({ storage, fetch: flaky.fetch, wait: async ms => { flakyWaits.push(ms); } });
  assert.deepEqual(flakyWaits, [1000, 1000, 1000, 1000]);
  assert.deepEqual(requests(flaky.log, 'params_shard_1.bin'), { ranges: [null, 'bytes=10000-', 'bytes=20000-', 'bytes=30000-', 'bytes=40000-'], sent: 50_000 });
  assert.deepEqual(shard(storage, 'params_shard_1.bin'), files.get('params_shard_1.bin'));

  const gone = huggingFace(files, name => name === 'params_shard_1.bin' ? { status: 404 } : null);
  await assert.rejects(run({ storage: memory(), fetch: gone.fetch }), /answered 404 for params_shard_1\.bin/);
  assert.equal(requests(gone.log, 'params_shard_1.bin').ranges.length, 1, 'not retried');

  const down = huggingFace(files, name => name === 'params_shard_1.bin' ? { status: 502 } : null);
  const downWaits = [];
  const kept = memory();
  await assert.rejects(run({ storage: kept, fetch: down.fetch, wait: async ms => { downWaits.push(ms); await new Promise(resolve => setTimeout(resolve, 5)); } }), /answered 502/);
  assert.deepEqual(downWaits, [1000, 2000, 4000, 8000, 16000, 30000], 'gives up for now after six more tries that bring nothing');
  assert.deepEqual(shard(kept, 'params_shard_0.bin'), files.get('params_shard_0.bin'), 'what finished meanwhile is kept');
});

test('a shard that is not the size tensor-cache.json lists is refused, not stored', async () => {
  const files = fakeModel([50_000]);
  for (const plan of [{ total: 60_000 }, { total: 40_000 }]) {
    const storage = await started(files);
    const hf = huggingFace(files, () => plan);
    await assert.rejects(run({ storage, fetch: hf.fetch }), /isn't the size the model lists/);
    assert.equal(storage.dbs['webllm/model'].has(url('params_shard_0.bin')), false);
    assert.equal(requests(hf.log, 'params_shard_0.bin').ranges.length, 1, 'not retried');
  }
  // A longer body than its headers and the shard list say.
  const longer = new Map(files).set('params_shard_0.bin', new Uint8Array(60_000));
  const storage = await started(files);
  await assert.rejects(run({ storage, fetch: huggingFace(longer, () => ({ total: 50_000 })).fetch }), /isn't the size the model lists/);
  assert.equal(storage.dbs['webllm/model'].has(url('params_shard_0.bin')), false);
  assert.deepEqual(await storage.pieceKeys(), []);
});

test('modelStatus counts what is on this device, and only a whole model is complete', async () => {
  const files = fakeModel();
  let saved = { [MODEL_DOWNLOAD_KEY]: { since: 1 } };
  globalThis.browser = { storage: { local: { get: async () => saved } } };
  try {
    assert.deepEqual(await modelStatus({ storage: memory() }), { complete: false, done: 0, total: null, wanted: true, downloading: false, here: false });
    const storage = await started(files);
    await storage.put('webllm/model', url('params_shard_1.bin'), files.get('params_shard_1.bin').slice().buffer);
    await storage.putPiece(url('params_shard_0.bin'), 0, new ArrayBuffer(30_000));
    await storage.putPiece(url('params_shard_0.bin'), 30_000, new ArrayBuffer(10_000));
    // Not from the start of its shard, so it doesn't count.
    await storage.putPiece(url('params_shard_2.bin'), 50_000, new ArrayBuffer(10_000));
    saved = {};
    assert.deepEqual(await modelStatus({ storage }), { complete: false, done: 100_000, total: 240_000, wanted: false, downloading: false, here: false });
    await run({ storage, fetch: huggingFace(files).fetch });
    assert.deepEqual(await modelStatus({ storage }), { complete: true, done: 240_000, total: 240_000, wanted: false, downloading: false, here: false });
    storage.dbs['webllm/model'].delete(url('tokenizer.json'));
    assert.equal((await modelStatus({ storage })).complete, false, 'WebLLM needs the tokenizer too');
  } finally { delete globalThis.browser; }
});

// Web Locks: one holder per name, the rest queued in order, and a queued
// request withdrawn when its signal aborts.
function locks() {
  const tails = new Map(), held = new Set();
  return {
    query: async () => ({ held: [...held].map(name => ({ name })), pending: [] }),
    request(name, options, callback) {
      if (typeof options === 'function') [callback, options] = [options, {}];
      const before = tails.get(name) ?? Promise.resolve();
      let release;
      const mine = new Promise(resolve => { release = resolve; });
      tails.set(name, before.then(() => mine));
      return new Promise((resolve, reject) => {
        const abort = () => { release(); reject(options.signal.reason); };
        if (options.signal?.aborted) return abort();
        options.signal?.addEventListener('abort', abort, { once: true });
        before.then(async () => {
          if (options.signal?.aborted) return;
          options.signal?.removeEventListener('abort', abort);
          held.add(name);
          try { resolve(await callback({ name })); } catch (error) { reject(error); } finally { held.delete(name); release(); }
        });
      });
    }
  };
}

test('one click: the download carries on by itself, pauses and resumes in every tab, and removing it clears it all', async () => {
  const files = fakeModel([100_000, 50_000]);
  const local = {}, changed = [];
  const tell = changes => changed.forEach(listener => listener(changes, 'local'));
  globalThis.browser = {
    storage: {
      local: {
        get: async key => key in local ? { [key]: structuredClone(local[key]) } : {},
        set: async values => { for (const [key, newValue] of Object.entries(values)) { local[key] = newValue; tell({ [key]: { newValue } }); } },
        remove: async key => { if (!(key in local)) return; const oldValue = local[key]; delete local[key]; tell({ [key]: { oldValue } }); }
      },
      onChanged: { addListener: listener => changed.push(listener) }
    },
    permissions: { contains: async () => true }
  };
  Object.defineProperty(navigator, 'locks', { value: locks(), configurable: true });
  const posted = [];
  globalThis.BroadcastChannel = class { postMessage(message) { posted.push(message); } };
  const realFetch = globalThis.fetch;
  let stall = true;
  const hf = huggingFace(files, name => name === 'params_shard_0.bin' && stall ? { hangAfter: 40_000 } : null);
  globalThis.fetch = hf.fetch;
  try {
    const tab = await import('../src/ai/model-download.js?tab');
    Object.assign(tab.modelStorage, memory());
    const events = [];
    tab.watchDownload(event => events.push(event));
    await tab.resumeDownload();
    assert.equal(hf.log.length, 0, 'nothing downloads until asked');

    const asked = tab.startDownload();
    await until(() => events.some(event => event.type === 'progress' && event.done === 90_000));
    assert.equal((await tab.modelStatus()).downloading, true);
    await tab.pauseDownload();
    await asked;
    assert.deepEqual(events.at(-1), { type: 'stopped', reason: 'paused' });
    const paused = await tab.modelStatus();
    assert.deepEqual([paused.done, paused.wanted, paused.downloading, paused.complete], [90_000, false, false, false], 'paused, with what arrived kept');

    stall = false;
    await tab.startDownload();
    assert.equal(events.at(-1).type, 'complete');
    assert.deepEqual(requests(hf.log, 'params_shard_0.bin').ranges, [null, 'bytes=40000-']);
    assert.equal(local[MODEL_DOWNLOAD_KEY], undefined, 'finished, so nothing is left to carry on');
    assert.equal((await tab.modelStatus()).complete, true);
    assert.ok(posted.some(message => message.type === 'progress'), 'other Marked tabs hear the progress');
    assert.equal(posted.at(-1).type, 'complete');

    await tab.removeModel();
    assert.equal(events.at(-1).type, 'removed');
    const removed = await tab.modelStatus();
    assert.deepEqual([removed.complete, removed.done, removed.total], [false, 0, null]);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.browser;
    delete globalThis.BroadcastChannel;
    delete navigator.locks;
  }
});
