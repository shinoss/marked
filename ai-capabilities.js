// These minimums mirror the bundled WebLLM 0.2.85 runtime's device request.
// Detect them before downloading model data; WebGPU availability alone is not
// sufficient. Do not spoof limits: compiled shaders may depend on them.
export function validateAdapter(adapter, browserName = 'this browser') {
  if (!adapter) throw new Error(`Could not access a WebGPU adapter in ${browserName}.`);
  if (!adapter.features.has('shader-f16')) throw new Error('This GPU/browser combination does not expose shader-f16, required by this model.');
  const requirements = {
    maxStorageBuffersPerShaderStage: 10,
    maxComputeWorkgroupStorageSize: 32768,
    maxBufferSize: 268435456,
    maxStorageBufferBindingSize: 134217728
  };
  for (const [name, required] of Object.entries(requirements)) {
    const available = adapter.limits[name];
    if (!Number.isFinite(available) || available < required) {
      // Firefox exposes 9 storage buffers on some Macs where Chrome exposes 10+.
      const alternative = browserName === 'Firefox' ? ' Marked also runs in Chrome, which may expose a higher limit on the same GPU.' : '';
      throw new Error(`Local AI is not compatible with this GPU configuration in ${browserName}: ${name} requires ${required}, but ${browserName} exposes ${available ?? 'an unknown limit'}. This is a browser/GPU limit, not a download failure. Retrying or downloading a smaller model will not change this runtime requirement.${alternative} Bookmarks still work normally.`);
    }
  }
  return adapter;
}
