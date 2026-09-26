import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { extensionFiles, isExtensionFile, manifestFor, packageFor } from '../scripts/package.js';
import { zip } from '../scripts/zip.js';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

// Reads back what zip() wrote, through the central directory as unzip does.
function unzip(archive) {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(archive.readUInt32LE(at), 0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const size = archive.readUInt32LE(at + 20);
    const nameLength = archive.readUInt16LE(at + 28);
    const local = archive.readUInt32LE(at + 42);
    const name = archive.toString('utf8', at + 46, at + 46 + nameLength);
    const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const body = archive.subarray(start, start + size);
    files[name] = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    at += 46 + nameLength;
  }
  return files;
}

test('the Chrome package drops Firefox-only keys and activeTab, which <all_urls> already covers', () => {
  const chrome = manifestFor('chrome', manifest);
  assert.deepEqual(chrome.background, { service_worker: 'background.js', type: 'module' });
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.deepEqual(chrome.permissions, manifest.permissions.filter(permission => permission !== 'activeTab'));
  assert.ok(!chrome.permissions.includes('activeTab'));
  assert.deepEqual(chrome.host_permissions, ['<all_urls>']);
  assert.equal(chrome.minimum_chrome_version, manifest.minimum_chrome_version);
  assert.equal(chrome.version, manifest.version);
  // The repo's dual manifest is left as it is.
  assert.deepEqual(manifest.background.scripts, ['background.js']);
  assert.ok(manifest.permissions.includes('activeTab'));
});

test('the Firefox package drops Chrome-only keys and keeps its gecko settings', () => {
  const firefox = manifestFor('firefox', manifest);
  assert.deepEqual(firefox.background, { scripts: ['background.js'], type: 'module' });
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.deepEqual(firefox.browser_specific_settings, manifest.browser_specific_settings);
  assert.deepEqual(firefox.permissions, manifest.permissions);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.throws(() => manifestFor('safari', manifest), /Unknown browser/);
});

test('packages take the extension’s own files and nothing from docs, tests, the build, or the checkout', () => {
  for (const path of ['manifest.json', 'manager.html', 'manager.js', 'styles.css', 'icons/marked-16.png', 'vendor/ai-worker.js', 'vendor/fonts/fonts.css', 'vendor/qwen3-4b.wasm']) {
    assert.ok(isExtensionFile(path), path);
  }
  for (const path of ['README.md', 'package.json', 'package-lock.json', '.gitignore', '.DS_Store', '.claude/feature-ideas.md', 'docs/images/list.png', 'site/index.html',
    'tests/manifest.test.js', 'scripts/bundle.js', 'ai/runtime.js', 'node_modules/esbuild/lib/main.js', 'dist/chrome/manifest.json', 'web-ext-artifacts/marked-chrome-1.3.0.zip',
    'backups/library.json', 'icons/.DS_Store', 'vendor/.cache/x.js']) {
    assert.ok(!isExtensionFile(path), path);
  }
});

test('every file the manifest and the pages load is packaged', async () => {
  const referenced = [
    ...manifest.background.scripts, manifest.background.service_worker,
    ...manifest.content_scripts.flatMap(script => script.js),
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)
  ];
  const root = new URL('..', import.meta.url);
  for (const page of (await readdir(root)).filter(name => name.endsWith('.html'))) {
    const html = await readFile(new URL(page, root), 'utf8');
    referenced.push(page, ...[...html.matchAll(/\s(?:src|href)="([^"#:]+)"/g)].map(match => match[1]));
  }
  assert.ok(referenced.includes('vendor/fonts/fonts.css'));
  for (const path of referenced) assert.ok(isExtensionFile(path), path);
});

test('a package is the same archive every time, with the browser’s manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'marked-package-'));
  try {
    const files = {
      'manifest.json': JSON.stringify(manifest), 'manager.html': '<!doctype html>', 'manager.js': 'export {};', 'styles.css': 'body {}',
      'icons/marked-16.png': 'png', 'vendor/fonts/fonts.css': '@font-face {}', 'vendor/web-llm-tokenizers.wasm': '\0asm',
      'README.md': '# Marked', 'package.json': '{}', '.DS_Store': '', 'docs/images/list.png': 'png', 'tests/a.test.js': '', 'ai/runtime.js': '',
      'scripts/package.js': '', 'node_modules/x/index.js': '', 'dist/chrome/old.js': '', 'site/index.html': '', 'vendor/.DS_Store': ''
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const expected = ['icons/marked-16.png', 'manager.html', 'manager.js', 'manifest.json', 'styles.css', 'vendor/fonts/fonts.css', 'vendor/web-llm-tokenizers.wasm'];
    assert.deepEqual(await extensionFiles(root), expected);
    const first = await packageFor('chrome', { root });
    assert.equal(first.target, join(root, 'web-ext-artifacts', `marked-chrome-${manifest.version}.zip`));
    const archive = await readFile(first.target);
    const unpacked = unzip(archive);
    assert.deepEqual(Object.keys(unpacked), expected);
    assert.deepEqual(JSON.parse(unpacked['manifest.json']), manifestFor('chrome', manifest));
    assert.equal(unpacked['manager.js'].toString(), 'export {};');
    // dist/chrome is rebuilt from scratch and matches the archive.
    assert.deepEqual((await readdir(join(root, 'dist', 'chrome'), { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).length, expected.length);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'dist', 'chrome', 'manifest.json'), 'utf8')), manifestFor('chrome', manifest));
    await packageFor('chrome', { root });
    assert.ok(archive.equals(await readFile(first.target)));
    const firefox = unzip(await readFile((await packageFor('firefox', { root })).target));
    assert.deepEqual(JSON.parse(firefox['manifest.json']), manifestFor('firefox', manifest));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('zip stores what doesn’t compress and orders entries by name', () => {
  const random = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 167 + 13) % 256));
  const archive = zip([{ name: 'b.txt', data: Buffer.from('b'.repeat(1000)) }, { name: 'a.bin', data: random }]);
  const files = unzip(archive);
  assert.deepEqual(Object.keys(files), ['a.bin', 'b.txt']);
  assert.ok(files['a.bin'].equals(random));
  assert.equal(files['b.txt'].toString(), 'b'.repeat(1000));
  assert.ok(archive.length < 1000);
});
