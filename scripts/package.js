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
    // <all_urls> already grants what activeTab would, and reviewers read the
    // pair as asking for more than the extension needs.
    out.permissions = out.permissions.filter(permission => permission !== 'activeTab');
  } else if (browser === 'firefox') {
    delete out.background.service_worker;
    delete out.minimum_chrome_version;
  } else {
    throw new Error(`Unknown browser "${browser}". Use ${BROWSERS.join(' or ')}.`);
  }
  return out;
}

// An allowlist, so docs, the site, tests, build scripts, the ai/ sources that
// bundle.js compiles, package files, the README, and anything private lying in
// the checkout (backups, exports, profiles) never reach a store: the manifest,
// the pages with their scripts and styles at the top level, icons/, and vendor/.
const FOLDERS = ['icons', 'vendor'];
export function isExtensionFile(path) {
  const parts = path.split('/');
  if (parts.some(part => part.startsWith('.'))) return false;
  if (parts.length === 1) return path === 'manifest.json' || /\.(js|html|css)$/.test(path);
  return FOLDERS.includes(parts[0]);
}

async function walk(root, dir) {
  const files = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory() && (dir || FOLDERS.includes(entry.name)) && !entry.name.startsWith('.')) files.push(...await walk(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function extensionFiles(root) {
  return (await walk(root, '')).filter(isExtensionFile).sort();
}

export async function packageFor(browser, { root, out = join(root, 'dist', browser), artifacts = join(root, 'web-ext-artifacts') }) {
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const staged = manifestFor(browser, manifest);
  const files = await extensionFiles(root);
  await rm(out, { recursive: true, force: true });
  const entries = [];
  for (const name of files) {
    const data = name === 'manifest.json' ? Buffer.from(JSON.stringify(staged, null, 2) + '\n') : await readFile(join(root, name));
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
  // vendor/ is generated; without it the package would miss chat, Readability and fonts.
  for (const generated of ['vendor/ai-worker.js', 'vendor/web-llm-tokenizers.wasm', 'vendor/qwen3-4b.wasm', 'vendor/readability.js', 'vendor/fonts/fonts.css']) {
    await access(join(root, generated)).catch(() => { throw new Error(`${generated} is missing. Run npm run bundle first.`); });
  }
  for (const browser of browsers) {
    const { target, files, bytes } = await packageFor(browser, { root });
    console.log(`${browser}: ${files.length} files in dist/${browser}, ${(bytes / 1e6).toFixed(2)} MB → ${target.slice(root.length)}`);
  }
}
