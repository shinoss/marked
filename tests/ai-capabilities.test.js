import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter } from '../ai-capabilities.js';
const adapter = () => ({ features: new Set(['shader-f16']), limits: { maxStorageBuffersPerShaderStage: 10, maxComputeWorkgroupStorageSize: 32768, maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728 } });
test('rejects the reported Firefox nine-buffer limit before loading a model and suggests Chrome', () => {
  const gpu = adapter(); gpu.limits.maxStorageBuffersPerShaderStage = 9;
  assert.throws(() => validateAdapter(gpu, 'Firefox'), /requires 10, but Firefox exposes 9.*runs in Chrome/);
  assert.throws(() => validateAdapter(gpu), error => /requires 10, but this browser exposes 9/.test(error.message) && !/Chrome/.test(error.message));
});
test('accepts minimum runtime limits and rejects insufficient shared memory', () => {
  const gpu = adapter(); assert.equal(validateAdapter(gpu), gpu);
  gpu.limits.maxComputeWorkgroupStorageSize = 16384;
  assert.throws(() => validateAdapter(gpu), /maxComputeWorkgroupStorageSize/);
});
test('requires an adapter and half precision', () => {
  assert.throws(() => validateAdapter(null), /Could not access a WebGPU adapter in this browser/);
  const gpu = adapter(); gpu.features.clear();
  assert.throws(() => validateAdapter(gpu), /shader-f16/);
});
