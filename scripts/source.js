import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.js';

// The source package AMO reviewers rebuild with `npm ci && npm run build-for-amo`:
// every git-tracked file as it is in the working tree, plus vendor/qwen3-4b.wasm.
// That file is gitignored, and without it bundle.js would download it from
// GitHub, which AMO's rule on dependencies doesn't allow. docs/ and site/ are
// neither part of the extension nor of its build.
const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const LEFT_OUT = /^(docs|site)\//;
const MODEL_LIB = 'vendor/qwen3-4b.wasm';

const entries = [];
for (const name of git('ls-files', '-z').split('\0').filter(Boolean)) {
  if (LEFT_OUT.test(name)) continue;
  try { entries.push({ name, data: await readFile(join(root, name)) }); } catch (error) {
    if (error.code !== 'ENOENT') throw error; // deleted but not yet committed
  }
}
const wasm = await readFile(join(root, MODEL_LIB)).catch(() => { throw new Error(`${MODEL_LIB} is missing. Run npm run bundle first.`); });
entries.push({ name: MODEL_LIB, data: wasm });

const { version } = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const target = join(root, 'web-ext-artifacts', `marked-source-${version}.zip`);
await mkdir(join(root, 'web-ext-artifacts'), { recursive: true });
const archive = zip(entries);
await writeFile(target, archive);
console.log(`source: ${entries.length} files, ${(archive.length / 1e6).toFixed(2)} MB → web-ext-artifacts/marked-source-${version}.zip`);
console.log(`${MODEL_LIB} sha256 ${createHash('sha256').update(wasm).digest('hex')}`);
// The source must rebuild the package it's uploaded with, so say when it
// differs from HEAD or leaves out files that aren't committed yet.
const changed = git('status', '--porcelain', '--untracked-files=no').trim();
if (changed) console.warn(`Note: uncommitted changes to tracked files are included:\n${changed}`);
const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(name => name && !name.startsWith('.'));
if (untracked.length) console.warn(`Note: untracked files are left out until committed:\n${untracked.join('\n')}`);
