import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm';
// Surface configuration/tokenizer/shard fetches, which happen before WebLLM's
// tensor progress callback. Never send bookmark or chat content over the network.
const originalFetch = self.fetch.bind(self);
self.fetch = async (...args) => {
  const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url || String(args[0]), self.location.href);
  const file = url.pathname.split('/').pop();
  const report = text => self.postMessage({ kind: 'initProgressCallback', content: { progress: null, timeElapsed: 0, text } });
  report(`Fetching ${file}…`);
  const response = await originalFetch(...args);
  if (!response.ok) throw new Error(`Could not fetch ${file}: HTTP ${response.status}`);
  report(`Reading ${file}… (download or local runtime file)`);
  return response;
};
const handler = new WebWorkerMLCEngineHandler();
self.onmessage = event => handler.onmessage(event);
self.postMessage({ kind: 'marked-ready' });
