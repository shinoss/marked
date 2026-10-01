import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { MODEL_URL } from '../ai-config.js';
import { modelStorage, MODEL_DOWNLOAD_KEY } from '../model-download.js';
import { memory, fakeModel } from './model-fixture.js';

// The chat panel never offers to download the model again once it was asked
// for: a download cut short offers Resume, one running in another Marked tab
// shows its progress, and a downloaded model loads without asking anything.
test('after the one click, the chat panel resumes, follows and loads the download without asking again', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html', pretendToBeVisual: true });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  const $ = id => document.getElementById(id);
  const local = {}, changed = [];
  const asks = [];
  globalThis.browser = {
    runtime: { getURL: path => `moz-extension://test/${path}` },
    storage: {
      local: {
        get: async key => key in local ? { [key]: local[key] } : {},
        set: async values => { Object.assign(local, values); for (const listener of changed) listener(Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }])), 'local'); },
        remove: async key => { delete local[key]; for (const listener of changed) listener({ [key]: { oldValue: true } }, 'local'); }
      },
      onChanged: { addListener: listener => changed.push(listener) }
    },
    permissions: { request: async origins => { asks.push(origins); return true; }, contains: async () => true }
  };
  const adapter = { features: new Set(['shader-f16']), limits: { maxStorageBuffersPerShaderStage: 10, maxComputeWorkgroupStorageSize: 32768, maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728 } };
  Object.defineProperty(navigator, 'gpu', { value: { requestAdapter: async () => adapter }, configurable: true });
  // Another Marked tab holds the download, and the GPU.
  let downloading = true;
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    query: async () => ({ held: downloading ? [{ name: 'marked-model-download' }] : [] }),
    request(name, options, callback) {
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason)));
    }
  } });
  const channels = [];
  globalThis.BroadcastChannel = class { constructor() { channels.push(this); } postMessage() {} };
  const fromAnotherTab = data => channels[0].onmessage({ data });
  const settle = () => new Promise(resolve => setTimeout(resolve, 10));

  // 0.9 of 2.2 GB on the device: one shard stored, and 300 MB of another in pieces.
  const files = fakeModel([1, 1]);
  const storage = memory();
  await storage.put('webllm/config', `${MODEL_URL}mlc-chat-config.json`, files.get('mlc-chat-config.json').slice().buffer);
  await storage.put('webllm/model', `${MODEL_URL}tensor-cache.json`, { records: [{ dataPath: 'params_shard_0.bin', nbytes: 1_600_000_000 }, { dataPath: 'params_shard_1.bin', nbytes: 600_000_000 }] });
  await storage.put('webllm/model', `${MODEL_URL}params_shard_1.bin`, new ArrayBuffer(1));
  storage.pieceKeys = async () => [[`${MODEL_URL}params_shard_0.bin`, 0, 300_000_000]];
  Object.assign(modelStorage, storage);
  downloading = false;
  try {
    const { openChat } = await import('../chat.js?download');
    await openChat(() => ({ children: [] }));
    await settle();
    assert.equal($('chat-status').textContent, 'Download paused. 900 MB of 2.20 GB is on this device. Choose Resume download to finish it.');
    assert.deepEqual([$('chat-start').textContent, $('chat-start').disabled, $('chat-unload').disabled, $('chat-delete-model').disabled], ['Resume download', false, true, false]);

    // Resume: the one ask, then it carries on by itself.
    $('chat-start').click();
    await settle();
    assert.equal(asks.length, 1);
    assert.ok(local[MODEL_DOWNLOAD_KEY], 'the download is wanted from now on');
    assert.deepEqual([$('chat-start').textContent, $('chat-start').disabled, $('chat-unload').textContent, $('chat-unload').disabled], ['Downloading…', true, 'Pause', false]);

    // Carried on in another Marked tab, which says how it's going.
    downloading = true;
    fromAnotherTab({ type: 'progress', done: 1_100_000_000, total: 2_200_000_000, rate: 2_000_000 });
    assert.equal($('chat-status').textContent, 'Downloading in another Marked tab: 1.10 GB of 2.20 GB, about 9 minutes left. It carries on while Marked is open, and picks up where it stopped if Marked closes.');
    assert.equal($('chat-progress').value, 0.5);
    assert.equal($('chat-start').disabled, true, 'never a second download');

    // Paused from this tab, and stopped in the other.
    globalThis.confirm = () => true;
    $('chat-unload').click();
    await settle();
    assert.equal(local[MODEL_DOWNLOAD_KEY], undefined);
    downloading = false;
    fromAnotherTab({ type: 'stopped', reason: 'paused' });
    assert.equal($('chat-status').textContent, 'Download paused. 1.10 GB of 2.20 GB is on this device. Choose Resume download to finish it.');
    assert.deepEqual([$('chat-start').textContent, $('chat-start').disabled], ['Resume download', false]);

    // A dropped connection that outlasted the retries: resume, without starting over.
    fromAnotherTab({ type: 'stopped', reason: 'error', message: 'Hugging Face answered 503 for params_shard_0.bin.' });
    assert.match($('chat-status').textContent, /^The download stopped: Hugging Face answered 503 for params_shard_0\.bin\. 1\.10 GB of 2\.20 GB is on this device\. Choose Resume download to try again\.$/);

    // Finished: it loads from this device, with no download and no prompt.
    await storage.put('webllm/model', `${MODEL_URL}params_shard_0.bin`, new ArrayBuffer(1));
    await storage.put('webllm/model', `${MODEL_URL}tokenizer.json`, new ArrayBuffer(1));
    storage.pieceKeys = async () => [];
    Object.assign(modelStorage, storage);
    // Out of view, this tab waits rather than take the GPU from the tab in front.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    fromAnotherTab({ type: 'complete' });
    await settle();
    assert.deepEqual([$('chat-start').textContent, $('chat-start').disabled], ['Load model', false]);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new dom.window.Event('visibilitychange'));
    await settle();
    assert.equal(asks.length, 1, 'only the click asked');
    assert.equal($('chat-status').textContent, 'Could not load local AI: Local AI is already running in another Marked tab. Unload it there first.', 'it went straight to loading');
    assert.equal($('chat-start').textContent, 'Load model');
  } finally {
    delete globalThis.confirm;
    delete globalThis.BroadcastChannel;
    delete navigator.locks;
    delete navigator.gpu;
    dom.window.close();
  }
});
