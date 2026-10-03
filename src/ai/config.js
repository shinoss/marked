export const MODEL_ID = 'Qwen3-4B-q4f16_1-MLC';
export const MODEL_REVISION = 'a5c9fab855e3ccbdfed2e7e69683d75f30332161';
// The model's files, at a fixed revision so what's downloaded never changes.
export const MODEL_URL = `https://huggingface.co/mlc-ai/${MODEL_ID}/resolve/${MODEL_REVISION}/`;
export const MODEL_ORIGINS = ['https://huggingface.co/*', 'https://*.huggingface.co/*', 'https://*.hf.co/*'];
export function modelConfig(baseURL) {
  return {
    cacheBackend: 'indexeddb',
    model_list: [{
      model_id: MODEL_ID,
      model: MODEL_URL,
      model_lib: new URL('vendor/qwen3-4b.wasm', baseURL).href,
      required_features: ['shader-f16'],
      overrides: { context_window_size: 4096, prefill_chunk_size: 512 }
    }]
  };
}
