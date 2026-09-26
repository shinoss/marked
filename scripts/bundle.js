import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

await mkdir('vendor', { recursive: true });
const url = 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/025bcaf3780fa8254f5e5efd3bfea0a5397248f4/web-llm-models/v0_2_84/base/Qwen3-4B-q4f16_1_cs1k-webgpu.wasm';
const expected = 'a986a53c92579714eb7ec36856004f5fb75272c9f69091f14eb6b2086eea4440';
let wasm;
try { wasm = await readFile('vendor/qwen3-4b.wasm'); } catch {}
const hash = data => createHash('sha256').update(data).digest('hex');
// The source package for review includes this file, so a review build never
// downloads it.
if (!wasm || hash(wasm) !== expected) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Model runtime download failed: ${response.status}`);
  wasm = Buffer.from(await response.arrayBuffer());
  if (hash(wasm) !== expected) throw new Error('Model runtime checksum mismatch');
  await writeFile('vendor/qwen3-4b.wasm', wasm);
}
// Everything else in vendor/ is regenerated, so nothing stale gets packaged.
for (const file of await readdir('vendor')) if (file !== 'qwen3-4b.wasm') await rm(`vendor/${file}`, { recursive: true });

// WebLLM embeds its tokenizer and grammar WebAssembly as base64 data URIs. They
// are written out as real .wasm files next to the worker instead, so no encoded
// code ships. These Emscripten single-file builds read a module that isn't a
// data URI with a synchronous XHR from the script's own directory (vendor/),
// which works in the module worker that runs the engine. They never fetch or
// stream it, so the MIME type doesn't matter.
const embeddedWasm = /"data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/g;
// Which module a literal belongs to, from the code that follows it.
const wasmOwners = [['tokenizers', 'asyncInitTokenizers'], ['xgrammar', 'StructuralTagItem']];
function wasmName(contents, offset) {
  const next = wasmOwners.map(([name, marker]) => [name, contents.indexOf(marker, offset)]).filter(([, at]) => at >= 0).sort((a, b) => a[1] - b[1]);
  if (!next.length) throw new Error('Unknown WebAssembly module embedded in WebLLM');
  return `web-llm-${next[0][0]}.wasm`;
}
const extracted = new Map();
// WebLLM's prebuilt model list points at model libraries on GitHub and weights
// on Hugging Face. Marked always passes its own appConfig (ai-config.js), so the
// list and its GitHub prefix are emptied: they are only a fallback when no
// appConfig is given.
const prebuilt = /(const modelLibURLPrefix = )"[^"]*";\n([\s\S]*?const prebuiltAppConfig = )\{\n[\s\S]*?\n\};\n/;
const webLLM = {
  name: 'web-llm-local',
  setup(builder) {
    builder.onLoad({ filter: /web-llm\/lib\/index\.js$/ }, async args => {
      let contents = await readFile(args.path, 'utf8');
      if (!prebuilt.test(contents)) throw new Error('WebLLM changed: prebuiltAppConfig not found');
      contents = contents.replace(prebuilt, '$1"";\n$2{ cacheBackend: "cache", model_list: [] };\n');
      contents = contents.replace(embeddedWasm, (_literal, base64, offset) => {
        const name = wasmName(contents, offset);
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.readUInt32BE(0) !== 0x0061736d) throw new Error(`${name} is not WebAssembly`);
        if (extracted.has(name)) throw new Error(`Two embedded modules resolve to ${name}`);
        extracted.set(name, bytes);
        return JSON.stringify(name);
      });
      if (extracted.size !== wasmOwners.length) throw new Error(`Expected ${wasmOwners.length} embedded WebAssembly modules in WebLLM, found ${extracted.size}`);
      return { contents, loader: 'js' };
    });
  }
};
await build({
  entryPoints: { 'ai-runtime': 'ai/runtime.js', 'ai-worker': 'ai/worker.js' },
  outdir: 'vendor', bundle: true, format: 'esm', platform: 'browser', target: ['firefox142', 'chrome123'],
  splitting: true, minify: true, legalComments: 'eof', plugins: [webLLM]
});
for (const [name, bytes] of extracted) await writeFile(`vendor/${name}`, bytes);
for (const file of await readdir('vendor')) {
  if (!file.endsWith('.js')) continue;
  const code = await readFile(`vendor/${file}`, 'utf8');
  // Emscripten's own data URI prefix check stays; encoded modules must not.
  for (const banned of [/data:application\/octet-stream;base64,[A-Za-z0-9+/]/, /raw\.githubusercontent\.com/, /huggingface\.co\/mlc-ai/]) {
    if (banned.test(code)) throw new Error(`vendor/${file} still matches ${banned}`);
  }
}
await copyFile('node_modules/@mlc-ai/web-llm/LICENSE', 'vendor/WebLLM-LICENSE');
await copyFile('node_modules/loglevel/LICENSE-MIT', 'vendor/loglevel-LICENSE');
// Mozilla's Readability, unchanged: Marked injects it into pages to read their
// text, and loads it in its own pages to read the ones it downloads.
await copyFile('node_modules/@mozilla/readability/Readability.js', 'vendor/readability.js');
await copyFile('node_modules/@mozilla/readability/Readability-readerable.js', 'vendor/readability-readerable.js');
await copyFile('node_modules/@mozilla/readability/LICENSE.md', 'vendor/Readability-LICENSE.md');

// Inter and Literata from Fontsource, the same variable fonts and subsets
// Google Fonts served, under the family names the stylesheets already use.
// Inter as Google served it (weight axis, upright); Literata with its optical
// size axis, upright and italic.
const fonts = [
  ['inter', 'Inter', ['wght.css']],
  ['literata', 'Literata', ['opsz.css', 'opsz-italic.css']]
];
await mkdir('vendor/fonts');
const faces = [];
for (const [id, family, sheets] of fonts) {
  const dir = `node_modules/@fontsource-variable/${id}`;
  for (const sheet of sheets) {
    const css = await readFile(`${dir}/${sheet}`, 'utf8');
    for (const [, file] of css.matchAll(/url\(\.\/files\/([\w.-]+\.woff2)\)/g)) await copyFile(`${dir}/files/${file}`, `vendor/fonts/${file}`);
    faces.push(css.replaceAll(`'${family} Variable'`, `'${family}'`).replaceAll('url(./files/', 'url(').trim());
  }
  await copyFile(`${dir}/LICENSE`, `vendor/fonts/${family}-OFL.txt`);
}
await writeFile('vendor/fonts/fonts.css', faces.join('\n\n') + '\n');
console.log(`Bundled local WebLLM runtime (${[...extracted.keys()].join(', ')}), verified model WASM, and copied Readability and fonts. No model weights downloaded.`);
