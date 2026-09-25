import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await mkdir('vendor', { recursive: true });
const url = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-4B-q4f16_1_cs1k-webgpu.wasm';
const expected = 'a986a53c92579714eb7ec36856004f5fb75272c9f69091f14eb6b2086eea4440';
let wasm;
try { wasm = await readFile('vendor/qwen3-4b.wasm'); } catch {}
const hash = data => createHash('sha256').update(data).digest('hex');
if (!wasm || hash(wasm) !== expected) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model runtime download failed: ${response.status}`);
  wasm = Buffer.from(await response.arrayBuffer());
  if (hash(wasm) !== expected) throw new Error('Model runtime checksum mismatch');
  await writeFile('vendor/qwen3-4b.wasm', wasm);
}
// WebLLM includes large embedded WASM data URIs. Split those unchanged data
// literals into local modules so every JS file stays below Firefox's lint limit
// (Chrome has no such limit, but loads the same split bundle).
// No code or WASM is downloaded by the installed extension.
const embedded = [];
const separateWasm = {
  name: 'separate-embedded-wasm',
  setup(builder) {
    builder.onResolve({ filter: /^marked-wasm:/ }, args => ({ path: args.path, namespace: 'marked-wasm' }));
    builder.onLoad({ filter: /.*/, namespace: 'marked-wasm' }, args => ({ contents: `export default ${JSON.stringify(embedded[Number(args.path.split(':')[1])])};`, loader: 'js' }));
    builder.onLoad({ filter: /web-llm\/lib\/index\.js$/ }, async args => {
      let contents = await readFile(args.path, 'utf8');
      const imports = [];
      contents = contents.replace(/"(data:application\/octet-stream;base64,[A-Za-z0-9+/=]+)"/g, (_literal, data) => {
        const index = embedded.push(data) - 1;
        imports.push(`const { default: embeddedWasm${index} } = await import('marked-wasm:${index}');`);
        return `embeddedWasm${index}`;
      });
      return { contents: imports.join('\n') + '\n' + contents, loader: 'js', resolveDir: new URL('../node_modules/@mlc-ai/web-llm/lib/', import.meta.url).pathname };
    });
  }
};
for (const file of await readdir('vendor')) if (file.endsWith('.js')) await unlink(`vendor/${file}`);
await build({
  entryPoints: { 'ai-runtime': 'ai/runtime.js', 'ai-worker': 'ai/worker.js' },
  outdir: 'vendor', bundle: true, format: 'esm', platform: 'browser', target: ['firefox142', 'chrome123'],
  splitting: true, minify: true, legalComments: 'eof', plugins: [separateWasm]
});
await copyFile('node_modules/@mlc-ai/web-llm/LICENSE', 'vendor/WebLLM-LICENSE');
await copyFile('node_modules/loglevel/LICENSE-MIT', 'vendor/loglevel-LICENSE');
// Mozilla's Readability, unchanged: Marked injects it into pages to read their
// text, and loads it in its own pages to read the ones it downloads.
await copyFile('node_modules/@mozilla/readability/Readability.js', 'vendor/readability.js');
await copyFile('node_modules/@mozilla/readability/Readability-readerable.js', 'vendor/readability-readerable.js');
await copyFile('node_modules/@mozilla/readability/LICENSE.md', 'vendor/Readability-LICENSE.md');
console.log('Bundled local WebLLM runtime, verified model WASM, and copied Readability. No model weights downloaded.');
