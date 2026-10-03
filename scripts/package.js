import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zip } from './zip.js';

// Stages the extension for one store in dist/<browser> and zips it into
// web-ext-artifacts/. The repo keeps its dual manifest for loading unpacked.
export const BROWSERS = ['chrome', 'firefox'];

export function manifestFor(browser, manifest) {
  const out = structuredClone(manifest);
  if (browser === 'chrome') {
    // Chrome reports background.scripts as an MV2-only key.
    delete out.background.scripts;
    delete out.browser_specific_settings;
  } else if (browser === 'firefox') {
    delete out.background.service_worker;
    delete out.minimum_chrome_version;
    // Chrome-only: Firefox gives each install its own random address anyway.
    for (const entry of out.web_accessible_resources || []) delete entry.use_dynamic_url;
  } else {
    throw new Error(`Unknown browser "${browser}". Use ${BROWSERS.join(' or ')}.`);
  }
  return out;
}

// The extension is everything in src/: the manifest, the pages with their
// scripts and styles, lib/, ai/, icons/, tour/, and the generated vendor/. Docs,
// the site, tests, build scripts, package files, the README, and anything
// private lying in the checkout (backups, exports, profiles) live outside it, so
// they never reach a store. Hidden files (.DS_Store and the like) are skipped.
export const SOURCE_DIR = 'src';
export function isExtensionFile(path) {
  return !path.split('/').some(part => part.startsWith('.'));
}

async function walk(root, dir) {
  const files = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await walk(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// Paths are relative to src/, which is how they appear in the package.
export async function extensionFiles(root) {
  return (await walk(join(root, SOURCE_DIR), '')).filter(isExtensionFile).sort();
}

export async function packageFor(browser, { root, out = join(root, 'dist', browser), artifacts = join(root, 'web-ext-artifacts') }) {
  const manifest = JSON.parse(await readFile(join(root, SOURCE_DIR, 'manifest.json'), 'utf8'));
  const staged = manifestFor(browser, manifest);
  const files = await extensionFiles(root);
  await rm(out, { recursive: true, force: true });
  const entries = [];
  for (const name of files) {
    const data = name === 'manifest.json' ? Buffer.from(JSON.stringify(staged, null, 2) + '\n') : await readFile(join(root, SOURCE_DIR, name));
    await mkdir(dirname(join(out, name)), { recursive: true });
    await writeFile(join(out, name), data);
    entries.push({ name, data });
  }
  await mkdir(artifacts, { recursive: true });
  const target = join(artifacts, `marked-${browser}-${manifest.version}.zip`);
  const archive = zip(entries);
  await writeFile(target, archive);
  return { target, files, bytes: archive.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const browsers = process.argv.slice(2);
  if (!browsers.length) throw new Error(`Name a browser: node scripts/package.js ${BROWSERS.join(' ')}`);
  // src/vendor/ is generated; without it the package would miss chat, Readability and fonts.
  for (const generated of ['vendor/ai-worker.js', 'vendor/web-llm-tokenizers.wasm', 'vendor/qwen3-4b.wasm', 'vendor/readability.js', 'vendor/fonts/fonts.css']) {
    await access(join(root, SOURCE_DIR, generated)).catch(() => { throw new Error(`${SOURCE_DIR}/${generated} is missing. Run npm run bundle first.`); });
  }
  for (const browser of browsers) {
    const { target, files, bytes } = await packageFor(browser, { root });
    console.log(`${browser}: ${files.length} files in dist/${browser}, ${(bytes / 1e6).toFixed(2)} MB → ${target.slice(root.length)}`);
  }
}
