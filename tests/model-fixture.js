import { MODEL_URL } from '../src/ai/config.js';

// IndexedDB as model-download.js uses it: WebLLM's databases of { url, data },
// and pieces keyed by [url, start, end]. Values are copied, as IndexedDB does.
export function memory() {
  const dbs = { 'webllm/config': new Map(), 'webllm/model': new Map(), 'webllm/wasm': new Map() };
  const pieces = new Map();
  return {
    dbs,
    keys: async name => new Set(dbs[name].keys()),
    get: async (name, url) => structuredClone(dbs[name].get(url)),
    put: async (name, url, data) => { dbs[name].set(url, structuredClone(data)); },
    pieceKeys: async () => [...pieces.values()].map(piece => [piece.url, piece.start, piece.end]),
    pieces: async url => [...pieces.values()].filter(piece => piece.url === url).map(piece => structuredClone(piece)),
    putPiece: async (url, start, data) => { pieces.set(`${url} ${start} ${start + data.byteLength}`, { url, start, end: start + data.byteLength, data: structuredClone(data) }); },
    dropPieces: async url => { for (const [key, piece] of pieces) if (piece.url === url) pieces.delete(key); },
    clear: async () => { for (const db of Object.values(dbs)) db.clear(); pieces.clear(); }
  };
}

const encode = value => new TextEncoder().encode(JSON.stringify(value));
// A model like Qwen3's: a configuration naming tokenizer.json, a shard list,
// and shards of distinct bytes.
export function fakeModel(sizes = [100_000, 60_000, 80_000]) {
  const shards = sizes.map((size, index) => [`params_shard_${index}.bin`, Uint8Array.from({ length: size }, (_, at) => (index * 31 + at * 7) % 251)]);
  return new Map([
    ['mlc-chat-config.json', encode({ model_type: 'qwen3', tokenizer_files: ['tokenizer.json', 'vocab.json', 'merges.txt'] })],
    ['tensor-cache.json', encode({ metadata: { ParamSize: sizes.length }, records: shards.map(([dataPath, bytes]) => ({ dataPath, format: 'raw-shard', nbytes: bytes.length, records: [] })) })],
    ['tokenizer.json', encode({ version: '1.0', model: { type: 'BPE' } })],
    ...shards
  ]);
}

// Hugging Face, played from memory. behave(name, request) can answer with a
// status, ignore Range, claim another start or total, drop the connection
// after cutAfter bytes, or stall after hangAfter bytes until the request is
// aborted. log lists each request with the bytes it was sent.
export function huggingFace(files, behave = () => null) {
  const log = [];
  async function fetch(url, { signal, headers = {} } = {}) {
    if (signal?.aborted) throw signal.reason;
    const name = url.slice(MODEL_URL.length);
    const request = { name, range: headers.Range ?? null, sent: 0 };
    log.push(request);
    const plan = behave(name, request) || {};
    if (plan.status) return new Response('Unavailable', { status: plan.status });
    const data = files.get(name);
    if (!data) return new Response('Entry not found', { status: 404 });
    const asked = !plan.ignoreRange && /^bytes=(\d+)-$/.exec(request.range || '');
    const start = asked ? Number(asked[1]) : 0;
    const headersOut = asked
      ? { 'Content-Range': `bytes ${plan.start ?? start}-${data.length - 1}/${plan.total ?? data.length}` }
      : { 'Content-Length': String(plan.total ?? data.length) };
    const body = data.subarray(start);
    const cut = plan.cutAfter ?? Infinity, hang = plan.hangAfter ?? Infinity;
    let at = 0;
    const stream = new ReadableStream({
      start(controller) { signal?.addEventListener('abort', () => { try { controller.error(signal.reason); } catch {} }, { once: true }); },
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 0));
        if (at >= body.length) return controller.close();
        if (at >= cut) return controller.error(new TypeError('network error'));
        if (at >= hang) return new Promise(() => {});
        const end = Math.min(body.length, at + 10_000, cut, hang);
        controller.enqueue(body.slice(at, end));
        request.sent += end - at;
        at = end;
      }
    });
    return new Response(stream, { status: asked ? 206 : 200, headers: headersOut });
  }
  return { fetch, log };
}
