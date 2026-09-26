import './browser-api.js';
import { safeURL, cleanAbstract, cleanNote, cleanTag, cleanTags, cleanHighlightText, exportHTML, exportMarkdown, parseHTML, parseJSON, planBrowserImport, pageIdentity, tweetId, validIcon, monogram, HIGHLIGHT_COLORS } from './bookmarks.js';
import { exportBackup, parseBackup } from './backup.js';
import { createLibraryStore, STORAGE_KEY, TEXT_PREFIX, PREVIEW_PREFIX } from './store.js';
import { captureTabText, cleanPageText, fetchPageText, passageAround, readingStatus, searchTerms, PAGE_TEXT_SETTINGS_KEY, READING_KEY } from './page-text.js';
import { markText, loadReadability, renderCard, cardStats } from './text-view.js';
import { cleanCard, fetchSite, siteOf } from './sites.js';
import { indexBuilder, compactIndex, documentTerms, similar, weigh, BROWSING_KEY, RELATED_KEY } from './related.js';
import { relativeAge } from './time.js';
import { suggestTags, chooseTags } from './tagger.js';
import { askJev, recordJevUsage, jevCost, estimateJevTokens, formatCost, JEV_ORIGINS, JEV_SETTINGS_KEY, JEV_USAGE_KEY } from './jev.js';
import { bookmarkLine, semanticSearch, semanticMatches } from './semantic-search.js';
import { ALL_SITES, SITE_ACCESS_ASKED_KEY, hasSiteAccess } from './site-access.js';
const library = createLibraryStore(browser);

const $ = id => document.getElementById(id);
// special is 'rediscover' or 'duplicates' while one of those views is open.
const state = { root: null, nodes: new Map(), folder: null, tag: null, special: null, rediscover: [], tags: [], selected: new Set(), expanded: new Set(), visible: [], editing: null, highlightFilter: { color: null, site: '', since: '' } };
let toastTimer, refreshTimer, loadVersion = 0;
let view = 'list';
let pendingPreview = null;
let pendingPreviewURL = null;
// The site's icon, when it came with the page from Add to Marked.
let pendingIcon = null;
// Tags chosen in the open editor; suggestions never override the user's own picks.
let editorTags = [], tagsTouched = false, editorSession = 0;
let pendingHighlight = '', pendingColor = 'yellow';
// The page's text, and a post's card, when they came with the page from Add to Marked.
let pendingText = null, pendingCard = null;
// Saved page texts by bookmark id, read after the library; search looks through them.
// version counts changes, so work done over the texts knows when it's stale.
const pageTexts = new class extends Map {
  version = 0;
  set(id, text) { this.version++; return super.set(id, text); }
  delete(id) { this.version++; return super.delete(id); }
  clear() { this.version++; super.clear(); }
}();
// Previews by bookmark id, kept apart from the library and read after it.
const previews = new Map();
let previewTimer;
let textSettings = { keep: true };
// Related bookmarks: an index of each bookmark's most telling words, built
// when first needed after a change, and a smaller copy stored for the reader
// and the Marked button. browsing: whether that button counts related saves.
let relatedIndex = null, relatedSaveTimer = null, storedRelated = '';
let browsing = { related: true };
// How far each text has been read in Marked's reader, by bookmark id.
let reading = {};
const readerURL = (node, params = {}) => `reader.html?${new URLSearchParams({ id: node.id, ...params })}`;
// Semantic search with the user's own Jev key. Jev is asked only when the user
// chooses Semantic, never while typing.
// preview is temporary: it works without a key and logs requests instead of sending them.
// Notes and highlights go to Jev only after the user turns them on.
const JEV_DEFAULTS = { apiKey: '', notes: false, highlights: false, preview: false };
let jev = { ...JEV_DEFAULTS };
let jevUsage = null;
const semantic = { query: '', result: null, status: '', error: '', cost: 0, cached: false, controller: null, cache: new Map() };
const semanticReady = () => !!jev.apiKey || jev.preview;
// Whether the results are Jev's answer for what's in the search box.
const semanticShown = () => !!semantic.status && semantic.query.toLowerCase() === $('search').value.trim().toLowerCase();
// Light, Dark, or System (the default), kept per browser so theme.js can apply
// it before the page draws. X's embeds follow along.
const THEME_KEY = 'markedTheme';
const darkScheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
const isDark = () => document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && !!darkScheme?.matches);
function readTheme() {
  try { return document.defaultView.localStorage.getItem(THEME_KEY) || 'system'; } catch { return 'system'; }
}
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  for (const choice of document.querySelectorAll('[data-theme-choice]')) choice.setAttribute('aria-checked', String(choice.dataset.themeChoice === theme));
}
function setTheme(theme) {
  try { document.defaultView.localStorage.setItem(THEME_KEY, theme); } catch {}
  applyTheme(theme);
  render();
}
const validPreview = value => typeof value === 'string' && value.startsWith('data:image/jpeg;base64,') && value.length < 500000;
const isFolder = node => node && !node.url && node.type !== 'separator';
const protectedNode = node => node.id === state.root.id;
const title = node => node.title || node.url || 'Untitled';
const sameTag = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
function displayDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || url; }
  catch { return url; }
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(text, action, className, label) {
  const el = element('button', className, text);
  el.type = 'button';
  if (label) { el.title = label; el.setAttribute('aria-label', label); }
  // A row's buttons name their action; one listener on the list runs it (rowActions).
  if (typeof action === 'string') el.dataset.action = action;
  else el.addEventListener('click', action);
  return el;
}
// Runs callback when the page is idle, or after timeout at the latest; Firefox
// and Chrome have requestIdleCallback, and anything else gets a short timer.
function whenIdle(callback, timeout = 1000) {
  const win = document.defaultView;
  if (win.requestIdleCallback) win.requestIdleCallback(callback, { timeout });
  else setTimeout(() => callback({ timeRemaining: () => 0 }), 16);
}
// A slice of idle time to work in: what the browser offers, between 5 and 12 ms.
const sliceEnd = deadline => performance.now() + Math.min(12, Math.max(5, deadline.timeRemaining()));
function glyph(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}
const FOLDER_GLYPH = 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z';
// A site's icon, or a tile with its initial in a color of its own.
function siteIcon(node, large = false) {
  const tile = element('span', `site-icon${large ? ' large' : ''}`);
  tile.setAttribute('aria-hidden', 'true');
  if (isFolder(node)) { tile.classList.add('folder'); tile.append(glyph(FOLDER_GLYPH)); }
  else if (validIcon(node.icon)) { const image = element('img'); image.src = node.icon; image.alt = ''; tile.classList.add('image'); tile.append(image); }
  else { const { letter, hue } = monogram(node.url); tile.textContent = letter; tile.style.setProperty('--hue', hue); }
  return tile;
}
function iconButton(kind, action, className, label) {
  const el = button('', action, className, label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', {
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7',
    pencil: 'M14 5l5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z',
    related: 'M9.5 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM14.5 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z'
  }[kind]);
  svg.append(path);
  el.append(svg);
  return el;
}
const colorOf = highlight => highlight.color || 'yellow';
const colorName = color => color[0].toUpperCase() + color.slice(1);
// A row of color swatches, the chosen one ringed.
function swatches(chosen, choose, className = 'swatches') {
  const group = element('div', className);
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Color');
  for (const color of HIGHLIGHT_COLORS) {
    const swatch = button('', () => choose(color), `swatch hl-${color}`, colorName(color));
    swatch.setAttribute('aria-pressed', String(color === chosen));
    group.append(swatch);
  }
  return group;
}
function toast(message, undo = null, undone = 'Restored to Marked.') {
  clearTimeout(toastTimer);
  const notice = $('toast');
  notice.replaceChildren(element('span', '', message));
  notice.hidden = false;
  if (undo) {
    const undoButton = button('Undo', async () => {
      undoButton.disabled = true;
      try {
        await undo();
        toast(undone);
      } catch (error) {
        notice.querySelector('span').textContent = `Could not restore: ${error.message}. Try Undo again.`;
        undoButton.disabled = false;
      }
    }, 'toast-action');
    notice.append(undoButton, button('Dismiss', () => { notice.hidden = true; notice.replaceChildren(); }, 'toast-action'));
  } else {
    toastTimer = setTimeout(() => { notice.hidden = true; }, 6000);
  }
}
function fail(error) { toast(error.message || String(error)); }
// A breadcrumb for a folder; dropping items on it moves them there.
function crumb(label, id) {
  const link = button(label, () => navigate(id === state.root.id ? null : id));
  link.dataset.id = id;
  return link;
}
function ancestors(id) {
  const result = [];
  let node = state.nodes.get(id);
  while (node && node.id !== state.root.id) { result.unshift(node); node = state.nodes.get(node.parentId); }
  return result;
}
function path(id) { return ancestors(id).map(title).join(' / ') || 'Library'; }
function defaultFolder() {
  if (state.folder && isFolder(state.nodes.get(state.folder))) return state.folder;
  return state.root.id;
}
async function load() {
  const version = ++loadVersion;
  relatedIndex = null;
  const [[root], tags] = await Promise.all([library.getTree(), library.getTags()]);
  if (version !== loadVersion) return;
  state.root = root;
  state.tags = tags;
  state.nodes.clear();
  function index(node) { state.nodes.set(node.id, node); node.children?.forEach(index); }
  index(root);
  if (state.folder && !state.nodes.has(state.folder)) state.folder = null;
  for (const id of state.selected) if (!state.nodes.has(id)) state.selected.delete(id);
  // Cached rankings describe the old library; the next search asks Jev again.
  semantic.cache.clear();
  render();
}
async function loadTexts() {
  const ids = [...state.nodes.values()].filter(node => node.url).map(node => node.id);
  // A few hundred at a time: a library's texts run to many megabytes, and
  // reading them all at once holds the page up.
  const texts = {};
  for (let at = 0; at < ids.length; at += 200) Object.assign(texts, await library.getTexts(ids.slice(at, at + 200)));
  pageTexts.clear();
  for (const [id, text] of Object.entries(texts)) pageTexts.set(id, text);
  render();
  if ($('settings-dialog').open) renderTextSettings();
}
// Only the gallery shows previews, so the list isn't drawn again for them.
async function loadPreviews() {
  const saved = await library.getPreviews([...state.nodes.values()].filter(node => node.url).map(node => node.id));
  previews.clear();
  for (const [id, preview] of Object.entries(saved)) previews.set(id, preview);
  if (view === 'gallery') render();
}
function navigate(id) {
  state.folder = id;
  state.tag = null;
  state.special = null;
  state.selected.clear();
  $('search').value = '';
  if (id) ancestors(id).forEach(node => state.expanded.add(node.id));
  render();
}
function showTag(tag) {
  state.tag = tag;
  state.folder = null;
  state.special = null;
  state.selected.clear();
  $('search').value = '';
  render();
}
function showSpecial(kind) {
  Object.assign(state, { special: kind, folder: null, tag: null });
  state.selected.clear();
  $('search').value = '';
  if (kind === 'rediscover') state.rediscover = pickRediscover();
  render();
}
// A few bookmarks saved more than two weeks ago, picked at random. Ones with a
// note or highlights are three times as likely: they meant something.
function pickRediscover(count = 8) {
  const pool = [...state.nodes.values()].filter(node => node.url && Date.now() - (node.dateAdded || 0) > 14 * 864e5)
    .map(node => ({ id: node.id, weight: node.note || node.highlights?.length ? 3 : 1 }));
  const picked = [];
  while (picked.length < count && pool.length) {
    let roll = Math.random() * pool.reduce((sum, item) => sum + item.weight, 0);
    const index = pool.findIndex(item => (roll -= item.weight) < 0);
    picked.push(pool.splice(index < 0 ? pool.length - 1 : index, 1)[0].id);
  }
  return picked;
}
let relatedShared = new Map();
function relatedList() {
  const matches = relatedMatches(state.relatedTo);
  relatedShared = new Map(matches.map(match => [match.id, match.shared]));
  return matches.map(match => state.nodes.get(match.id)).filter(Boolean);
}
// What a bookmark is about, for comparing it with others.
const termsOf = node => documentTerms({ title: title(node), tags: node.tags || [], note: node.note || '', highlights: node.highlights || [], abstract: node.abstract || '', card: node.card, text: pageTexts.get(node.id)?.text || '' });
// The index, built a slice at a time while the page is idle: each bookmark's
// words, then their weights. relatedIndexNow finishes it at once if it's
// needed sooner, and builds it all if the library or its texts changed since.
let relatedBuild = null;
function startRelatedBuild() {
  return relatedBuild = { root: state.root, texts: pageTexts.version, nodes: [...state.nodes.values()].filter(node => node.url), added: 0, builder: indexBuilder() };
}
function buildRelatedIndexLater() {
  const build = startRelatedBuild();
  whenIdle(function step(deadline) {
    if (relatedBuild !== build || relatedIndex) return;
    if (build.root !== state.root || build.texts !== pageTexts.version) { buildRelatedIndexLater(); return; }
    const end = sliceEnd(deadline);
    while (build.added < build.nodes.length && performance.now() < end) {
      const node = build.nodes[build.added++];
      build.builder.add(node.id, termsOf(node));
    }
    while (build.added === build.nodes.length && performance.now() < end) if (build.builder.weigh(20)) { relatedIndexNow(); return; }
    whenIdle(step);
  });
}
function relatedIndexNow() {
  if (!relatedIndex) {
    const build = relatedBuild?.root === state.root && relatedBuild.texts === pageTexts.version ? relatedBuild : startRelatedBuild();
    relatedBuild = null;
    for (const node of build.nodes.slice(build.added)) build.builder.add(node.id, termsOf(node));
    build.builder.weigh();
    relatedIndex = build.builder.index;
    clearTimeout(relatedSaveTimer);
    relatedSaveTimer = setTimeout(saveRelatedIndex, 1500);
  }
  return relatedIndex;
}
// The small copy for the reader and the background, written only when it
// changed; the write waits for the next idle moment, apart from the comparing.
function saveRelatedIndex() {
  if (!relatedIndex) return;
  const compact = compactIndex(relatedIndex);
  const signature = JSON.stringify([compact.n, compact.docs]);
  if (signature === storedRelated) return;
  storedRelated = signature;
  whenIdle(() => browser.storage.local.set({ [RELATED_KEY]: compact }).catch(() => {}));
}
// Bookmarks like the one with source.id, or like a page described by source.page.
function relatedMatches(source) {
  const index = relatedIndexNow();
  if (source.id) return similar(index, index.vectors.get(source.id) ?? weigh(index, termsOf(state.nodes.get(source.id))), { exclude: new Set([source.id]), limit: 12 });
  const same = new Set([...state.nodes.values()].filter(node => node.url && pageIdentity(node.url) === pageIdentity(source.page.url)).map(node => node.id));
  return similar(index, weigh(index, documentTerms(source.page)), { exclude: same, limit: 12 });
}
function showRelated(source) {
  Object.assign(state, { special: 'related', folder: null, tag: null, relatedTo: source });
  state.selected.clear();
  $('search').value = '';
  render();
}
// Texts started in the reader and not finished, most recently read first.
function continuing() {
  return [...state.nodes.values()].filter(node => node.url && pageTexts.get(node.id)?.text && readingStatus(pageTexts.get(node.id), reading[node.id]).state === 'reading')
    .sort((a, b) => (reading[b.id].at || 0) - (reading[a.id].at || 0));
}
// Bookmarks for the same page, grouped, oldest first in each group. Every
// render asks, so the answer is kept until the library is read again.
let duplicateGroups = { root: null, groups: [] };
function findDuplicates() {
  if (duplicateGroups.root === state.root) return duplicateGroups.groups;
  const groups = new Map();
  for (const node of state.nodes.values()) {
    if (!node.url) continue;
    const key = pageIdentity(node.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  duplicateGroups = { root: state.root, groups: [...groups.values()].filter(group => group.length > 1).map(group => group.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0))) };
  return duplicateGroups.groups;
}
async function mergeGroups(groups) {
  const copies = groups.reduce((sum, group) => sum + group.length - 1, 0);
  if (!copies || !await confirmAction('Merge duplicates?', `Fold ${copies === 1 ? 'the extra copy' : `${copies} extra copies`} into the oldest bookmark for ${groups.length === 1 ? 'the page' : `each of ${groups.length} pages`}? Every tag, note, and highlight is kept.`, 'Merge')) return;
  const removed = await library.mergeDuplicates(groups.map(group => group.map(node => node.id)));
  await load();
  toast(`Merged ${removed} ${removed === 1 ? 'copy' : 'copies'}.`);
}
function renderTags() {
  const counts = new Map();
  for (const node of state.nodes.values()) for (const tag of node.tags || []) counts.set(tag.toLowerCase(), (counts.get(tag.toLowerCase()) || 0) + 1);
  $('tag-list').replaceChildren(...state.tags.map(tag => {
    const row = element('div', 'folder-row tag-row');
    const active = sameTag(state.tag, tag);
    const link = button('', () => showTag(tag), `folder-link${active ? ' active' : ''}`);
    link.title = tag;
    if (active) link.setAttribute('aria-current', 'page');
    link.append(element('span', 'folder-name', tag), element('span', 'count', counts.get(tag.toLowerCase()) || 0));
    row.append(link, iconButton('trash', () => removeTag(tag).catch(fail), 'folder-delete', `Remove tag ${tag}`));
    return row;
  }));
}
async function removeTag(tag) {
  const count = [...state.nodes.values()].filter(node => node.tags?.some(t => sameTag(t, tag))).length;
  if (!await confirmAction('Remove tag?', `Remove “${tag}” from your tag list${count ? ` and from ${count} ${count === 1 ? 'bookmark' : 'bookmarks'}` : ''}? The bookmarks themselves are kept.`, 'Remove tag')) return;
  await library.removeTag(tag);
  if (sameTag(state.tag, tag)) state.tag = null;
  await load(); toast(`Removed the tag “${tag}”.`);
}
function renderTree() {
  $('folder-tree').replaceChildren();
  $('all-bookmarks').classList.toggle('active', !state.folder && !state.tag && !state.special && !$('search').value.trim());
  $('rediscover-nav').classList.toggle('active', state.special === 'rediscover');
  const started = continuing().length;
  $('continue-nav').hidden = !started && state.special !== 'continue';
  $('continue-nav').classList.toggle('active', state.special === 'continue');
  $('continue-count').textContent = started ? started.toLocaleString() : '';
  const highlightCount = [...state.nodes.values()].reduce((sum, node) => sum + (node.highlights?.length || 0), 0);
  $('highlights-nav').hidden = !highlightCount && state.special !== 'highlights';
  $('highlights-nav').classList.toggle('active', state.special === 'highlights');
  $('highlights-count').textContent = highlightCount ? highlightCount.toLocaleString() : '';
  $('duplicates-nav').classList.toggle('active', state.special === 'duplicates');
  renderTags();
  $('total').textContent = [...state.nodes.values()].filter(n => n.url).length.toLocaleString();
  // A folder counts every bookmark inside it, subfolders included.
  const counts = new Map();
  (function count(node) {
    let total = 0;
    for (const child of node.children || []) total += child.url ? 1 : count(child);
    counts.set(node.id, total);
    return total;
  })(state.root);
  function append(node, depth) {
    const row = element('div', 'folder-row');
    row.dataset.id = node.id;
    row.draggable = true;
    row.style.paddingLeft = `${depth * 14}px`;
    const children = (node.children || []).filter(isFolder);
    const expanded = state.expanded.has(node.id);
    const toggle = button(children.length ? (expanded ? '▾' : '▸') : '', () => {
      if (expanded) state.expanded.delete(node.id); else state.expanded.add(node.id);
      renderTree();
    }, 'disclosure', `${expanded ? 'Collapse' : 'Expand'} ${title(node)}`);
    toggle.disabled = !children.length;
    if (children.length) toggle.setAttribute('aria-expanded', String(expanded));
    const link = button('', () => navigate(node.id), `folder-link${state.folder === node.id ? ' active' : ''}`);
    link.title = title(node);
    if (state.folder === node.id) link.setAttribute('aria-current', 'page');
    link.append(element('span', 'folder-name', title(node)), element('span', 'count', counts.get(node.id).toLocaleString()));
    row.append(toggle, link);
    if (!protectedNode(node)) {
      row.append(
        iconButton('pencil', () => openEditor(node), 'folder-edit', `Edit folder ${title(node)}`),
        iconButton('trash', () => removeItems([node.id]).catch(fail), 'folder-delete', `Delete folder ${title(node)}`)
      );
    }
    $('folder-tree').append(row);
    if (expanded) children.forEach(child => append(child, depth + 1));
  }
  state.root.children.filter(isFolder).forEach(node => append(node, 0));
}
function render() {
  if (!state.root) return;
  // Measured before anything changes, while the layout is still current.
  const reach = rowsInReach();
  renderTree();
  const highlighting = state.special === 'highlights';
  $('highlight-tools').hidden = $('highlight-list').hidden = !highlighting;
  $('search').placeholder = highlighting ? 'Search highlights…' : 'Search all bookmarks…';
  if (highlighting) { renderHighlights(); return; }
  document.querySelector('.table-wrap').classList.toggle('gallery', view === 'gallery');
  $('list-view').setAttribute('aria-pressed', String(view === 'list'));
  $('gallery-view').setAttribute('aria-pressed', String(view === 'gallery'));
  const query = $('search').value.trim().toLowerCase();
  const current = state.nodes.get(state.folder);
  const showLocation = !current;
  document.querySelector('.location-column').hidden = !showLocation;
  const tag = query ? null : state.tag;
  const special = query ? null : state.special;
  const duplicates = findDuplicates();
  const copies = duplicates.reduce((sum, group) => sum + group.length - 1, 0);
  $('duplicates-nav').hidden = !copies && special !== 'duplicates';
  $('duplicates-count').textContent = copies ? copies.toLocaleString() : '';
  // The first bookmark of each group of copies, for a Merge button on its row.
  const groupStarts = new Map(special === 'duplicates' ? duplicates.map(group => [group[0].id, group]) : []);
  const terms = searchTerms(query);
  // Bookmarks found only in their page text, with the passage to show.
  const passages = new Map();
  let nodes = query ? searchLibrary(terms, passages)
    : special === 'rediscover' ? state.rediscover.map(id => state.nodes.get(id)).filter(Boolean)
    : special === 'duplicates' ? duplicates.flat()
    : special === 'continue' ? continuing()
    : special === 'related' ? relatedList()
    : tag ? [...state.nodes.values()].filter(n => n.url && n.tags?.some(t => sameTag(t, tag)))
    : current ? [...(current.children || [])].filter(n => n.type !== 'separator') : [...state.nodes.values()].filter(n => n.url);
  const sort = $('sort').value;
  if (sort !== 'default' && !special) nodes.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || (sort === 'title' ? collator.compare(title(a), title(b)) : (b.dateAdded || 0) - (a.dateAdded || 0)));
  // Matches in a bookmark's own details come before those only in its page's text.
  if (query) nodes.sort((a, b) => Number(passages.has(a.id)) - Number(passages.has(b.id)));
  // Jev's matches lead, most relevant first; the remaining keyword matches follow.
  if (query && semantic.result && semantic.query.toLowerCase() === query) {
    const lead = semanticMatches(semantic.result.ranked).map(match => state.nodes.get(match.id)).filter(Boolean);
    const ids = new Set(lead.map(node => node.id));
    nodes = [...lead, ...nodes.filter(node => !ids.has(node.id))];
  }
  state.visible = nodes;
  // Open all is for a folder, a tag, or search results, never the whole library.
  const bookmarks = nodes.filter(node => node.url).length;
  $('open-all').hidden = !bookmarks || (!query && !tag && !current);
  $('open-all').title = `Open the ${bookmarks === 1 ? 'bookmark' : `${bookmarks.toLocaleString()} bookmarks`} shown here in new tabs`;
  const visibleIds = new Set(nodes.map(n => n.id));
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id);
  const about = special === 'related' && (state.relatedTo.id ? title(state.nodes.get(state.relatedTo.id) || {}) : state.relatedTo.page.title);
  const specialTitle = { rediscover: 'Rediscover', duplicates: 'Duplicates', continue: 'Continue reading', related: `Like “${about}”` }[special];
  $('page-title').textContent = query ? 'Search results' : specialTitle || tag || (current ? title(current) : 'All bookmarks');
  $('breadcrumbs').replaceChildren(crumb('Library', state.root.id));
  if (tag) $('breadcrumbs').append(element('span', '', '/'), element('span', '', 'Tags'));
  $('shuffle').hidden = special !== 'rediscover' || !nodes.length;
  $('merge-all').hidden = special !== 'duplicates' || !copies;
  $('view-note').hidden = !special || !nodes.length;
  $('view-note').textContent = special === 'related' ? 'Bookmarks that share its most telling words: in titles, tags, notes, highlights, and saved text.'
    : special === 'continue' ? 'Pages you started reading in Marked, the latest first.'
    : special === 'rediscover' ? 'A few things you saved a while ago, picked at random. The ones with notes and highlights come up more often.'
    : `${duplicates.length.toLocaleString()} ${duplicates.length === 1 ? 'page is' : 'pages are'} saved more than once. Merging keeps the oldest bookmark with every tag, note, and highlight.`;
  if (current) for (const node of ancestors(current.id)) $('breadcrumbs').append(element('span', '', '/'), crumb(title(node), node.id));
  showRows(nodes, { view, special, query, terms, passages, groups: groupStarts, showLocation, dark: isDark() }, reach);
  document.querySelector('.table-wrap').hidden = nodes.length === 0;
  $('empty').hidden = nodes.length > 0;
  // An empty library greets you with ways to fill it.
  const welcome = !query && !special && !tag && !current && !nodes.length;
  $('welcome').hidden = !welcome;
  $('empty').classList.toggle('welcoming', welcome);
  document.querySelector('.list-toolbar').hidden = welcome;
  $('empty').querySelector('h2').textContent = welcome ? 'Welcome to Marked' : query ? 'No bookmarks found' : special === 'rediscover' ? 'Nothing to rediscover yet' : special === 'duplicates' ? 'No duplicates' : special === 'continue' ? 'Nothing to continue' : special === 'related' ? 'Nothing like it yet' : tag ? 'No bookmarks with this tag' : 'No bookmarks yet';
  $('empty').querySelector('p').textContent = welcome ? 'Bring in the bookmarks you already have, or save the page you’re reading.' : query ? 'Try other words. Search looks through names, addresses, folders, notes, tags, highlights, and the text of saved pages.' : special === 'rediscover' ? 'Bookmarks you saved a while ago show up here.' : special === 'duplicates' ? 'Every page is saved just once.' : special === 'continue' ? 'Pages you start reading in Marked wait here until you finish them.' : special === 'related' ? 'As you save more, bookmarks that share its words show up here.' : tag ? 'Add it to a bookmark with Edit.' : 'Add a bookmark or import your saved collection.';
  renderSemanticStatus();
  $('list-label').textContent = `${nodes.length.toLocaleString()} ${nodes.length === 1 ? 'item' : 'items'}`;
  renderSelection();
}
// The list and gallery are built as they come near the window: a render builds
// the first rows, or as many as reach past the window when it's scrolled, and
// more follow as the end comes within a screen (moreRows). A row whose details
// haven't changed is kept as it is, so a render keeps the page where it was and
// costs little. Without IntersectionObserver, every row is built at once.
const FIRST_ROWS = 40;
const shown = { nodes: [], context: null, count: 0, rows: new Map() };
const collator = new Intl.Collator();
const rowsEnd = element('div', 'rows-end');
rowsEnd.setAttribute('aria-hidden', 'true');
document.querySelector('.table-wrap').append(rowsEnd);
const Observer = document.defaultView.IntersectionObserver;
const moreRows = Observer && new Observer(entries => {
  // Look again after adding rows: they may not reach far enough yet.
  if (entries.at(-1).isIntersecting && addRows()) watchRowsEnd();
}, { rootMargin: '0px 0px 100% 0px' });
function watchRowsEnd() {
  if (!moreRows) return;
  moreRows.unobserve(rowsEnd);
  moreRows.observe(rowsEnd);
}
// How many of the rows shown reach down to a screen below the window, when it's scrolled.
function rowsInReach() {
  const win = document.defaultView;
  if (!moreRows || !(win.scrollY > 0)) return 0;
  const rows = $('items').rows, limit = win.innerHeight * 2;
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().top < limit) low = middle + 1; else high = middle;
  }
  return low;
}
function showRows(nodes, context, reach = 0) {
  const body = $('items'), old = shown.rows;
  Object.assign(shown, { nodes, context, rows: new Map() });
  const wanted = nodes.slice(0, moreRows ? Math.max(FIRST_ROWS, reach) : nodes.length).map(node => rowFor(node, old));
  if (!wanted.some(row => row.parentNode === body)) {
    const fragment = document.createDocumentFragment();
    for (const row of wanted) fragment.append(row);
    body.replaceChildren(fragment);
  } else {
    // Rows no longer shown go; kept rows stay in place, and new ones go between them.
    const keep = new Set(wanted);
    for (const row of [...body.rows]) if (!keep.has(row)) row.remove();
    let next = body.firstElementChild;
    for (const row of wanted) {
      if (row === next) next = next.nextElementSibling;
      else body.insertBefore(row, next);
    }
  }
  shown.count = wanted.length;
  watchRowsEnd();
}
// The next rows, when the end of the list comes near the window.
function addRows(count = FIRST_ROWS) {
  const end = Math.min(shown.nodes.length, shown.count + count);
  if (shown.count >= end) return false;
  const fragment = document.createDocumentFragment();
  for (let at = shown.count; at < end; at++) fragment.append(rowFor(shown.nodes[at], shown.rows));
  $('items').append(fragment);
  shown.count = end;
  return true;
}
function rowFor(node, old) {
  const key = rowKey(node, shown.context);
  const kept = old.get(node.id);
  const preview = previews.get(node.id);
  const row = kept && kept.key === key && kept.preview === preview && kept.icon === node.icon ? kept.row : buildRow(node, shown.context);
  shown.rows.set(node.id, { row, key, preview, icon: node.icon });
  // Selection and dragging change without a rebuild.
  const selected = state.selected.has(node.id);
  row.classList.toggle('selected', selected);
  row.cells[0].firstChild.checked = selected;
  row.classList.toggle('dragged', !!drag?.ids.includes(node.id));
  return row;
}
// Everything a row shows but its selection (and its preview and icon, compared as they are).
function rowKey(node, { view, special, query, passages, groups, showLocation, dark }) {
  const page = node.url && pageTexts.get(node.id);
  const status = page?.text && readingStatus(page, reading[node.id]);
  const tweet = view === 'gallery' && !isFolder(node) && tweetId(node.url);
  return JSON.stringify([view, tweet && dark, showLocation && path(node.parentId), node.title, node.url, node.type, node.children?.length,
    node.dateAdded, relativeAge(node.dateAdded), status && `${status.state} ${status.label}`, node.card, node.tags, node.note, node.highlights?.length,
    groups.get(node.id)?.map(copy => copy.id), special === 'related' && relatedShared.get(node.id), passages.get(node.id), passages.has(node.id) && query, protectedNode(node)]);
}
// A bookmark or folder as a list row or a gallery card. Its buttons name their
// action, which rowActions runs for the row's bookmark as it is then.
function buildRow(node, { view, special, query, terms, passages, groups, showLocation }) {
  const row = element('tr');
  row.dataset.id = node.id;
  row.draggable = !protectedNode(node);
  const group = groups.get(node.id);
  if (group) row.classList.add('group-start');
  const checkCell = element('td', 'check-cell');
  const check = element('input'); check.type = 'checkbox'; check.disabled = protectedNode(node);
  check.setAttribute('aria-label', `Select ${title(node)}`);
  checkCell.append(check);
  const nameCell = element('td');
  const main = element('div', 'item-main');
  const text = element('div', 'item-text');
  let link;
  if (isFolder(node)) link = button(title(node), 'open', 'item-title');
  else {
    link = element('a', 'item-title', title(node));
    const url = safeURL(node.url);
    if (url) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    else { link.title = 'This URL cannot be opened here. Use your browser’s bookmark manager for special bookmark URLs.'; }
  }
  link.title ||= title(node);
  const metadata = element('div', 'item-metadata');
  const domain = element('span', 'item-url', isFolder(node) ? `${node.children?.length || 0} ${node.children?.length === 1 ? 'item' : 'items'}` : displayDomain(node.url));
  if (node.url) domain.title = node.url;
  const details = element('span', 'item-details');
  const age = relativeAge(node.dateAdded);
  if (age) {
    const added = element('time', 'item-age', age);
    added.dateTime = new Date(node.dateAdded).toISOString();
    added.title = new Date(node.dateAdded).toLocaleString();
    details.append(added);
  }
  const page = node.url && pageTexts.get(node.id);
  if (page?.text) {
    const status = readingStatus(page, reading[node.id]);
    const read = element('a', `item-read ${status.state}`, status.label);
    read.href = readerURL(node);
    read.target = '_blank';
    read.title = `Read the text saved from ${title(node)} in Marked`;
    details.append(read);
  }
  const stats = node.card && cardStats(node.card);
  if (stats) details.append(element('span', 'item-stats', stats));
  // Tags and the note marker share one line. Gallery cards keep the line even
  // when empty so page cards are the same height; X posts show the note itself.
  const labels = element('span', 'item-tags');
  for (const tag of node.tags || []) labels.append(Object.assign(button(tag, 'tag', 'tag', `Show bookmarks tagged ${tag}`), { value: tag }));
  if (node.note) labels.append(button('Note', 'note', 'note-chip', `Show the note on ${title(node)}`));
  const highlights = node.highlights?.length;
  if (highlights) labels.append(button(`${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}`, 'highlights', 'highlight-chip', `Show highlights on ${title(node)}`));
  if (group) labels.append(button(`Merge ${group.length} copies`, 'merge', 'merge-chip', `Merge the ${group.length} bookmarks for ${displayDomain(node.url)}`));
  if (!isFolder(node)) details.append(labels);
  metadata.append(domain, details);
  text.append(link, metadata);
  const shared = special === 'related' && relatedShared.get(node.id);
  if (shared?.length) text.append(element('p', 'item-reason', `Shares ${shared.length > 1 ? `${shared.slice(0, -1).join(', ')} and ${shared.at(-1)}` : shared[0]}`));
  const passage = passages.get(node.id);
  if (passage) {
    const quote = element('a', 'item-passage');
    quote.href = readerURL(node, { q: query });
    quote.target = '_blank';
    quote.title = 'Read this in the saved text';
    markText(quote, `${passage.cutBefore ? '…' : ''}${passage.text}${passage.cutAfter ? '…' : ''}`, { terms });
    text.append(quote);
  }
  if (node.note) {
    const note = element('p', 'item-note', node.note);
    note.title = node.note;
    text.append(note);
  }
  // Only the gallery shows previews (the list hides them), and X's embeds, so the list view never contacts X.
  main.append(view === 'gallery' ? cardPreview(node, row) : siteIcon(node), text);
  nameCell.append(main);
  row.append(checkCell, nameCell);
  if (showLocation) {
    const location = element('td', 'item-location', path(node.parentId));
    location.title = location.textContent;
    row.append(location);
  }
  const actions = element('td', 'row-actions');
  if (node.url) actions.append(iconButton('related', 'related', 'item-action', `More like ${title(node)}`));
  if (!protectedNode(node)) actions.append(iconButton('pencil', 'edit', 'item-action', `Edit ${title(node)}`), iconButton('trash', 'delete', 'item-action', `Delete ${title(node)}`));
  row.append(actions);
  return row;
}
function cardPreview(node, row) {
  const preview = element('div', 'card-preview');
  const tweet = !isFolder(node) && tweetId(node.url);
  if (tweet) {
    row.classList.add('tweet-row');
    preview.classList.add('tweet');
    preview.append(tweetEmbed(tweet));
  } else if (node.card) {
    preview.classList.add('card-site');
    preview.append(renderCard(document, node.card));
  } else if (validPreview(previews.get(node.id))) {
    const image = element('img'); image.src = previews.get(node.id); image.alt = ''; image.loading = 'lazy';
    preview.append(image);
  } else {
    // Without a screenshot, a card shows the site's icon or its letter on the site's color.
    const tile = siteIcon(node, true);
    preview.classList.add(isFolder(node) ? 'folder-preview' : tile.classList.contains('image') ? 'icon-preview' : 'letter-preview');
    if (tile.style.getPropertyValue('--hue')) preview.style.setProperty('--hue', tile.style.getPropertyValue('--hue'));
    preview.append(tile);
  }
  return preview;
}
// What a row's buttons do, for its bookmark or folder as it is now.
const rowActions = {
  open: node => navigate(node.id),
  tag: (node, target) => showTag(target.value),
  note: node => showNote(node),
  highlights: node => showHighlights(node.id),
  merge: node => { const group = shown.context.groups.get(node.id); if (group) mergeGroups([group]).catch(fail); },
  related: node => showRelated({ id: node.id }),
  edit: node => openEditor(node),
  delete: node => removeItems([node.id]).catch(fail)
};
$('items').addEventListener('click', event => {
  const target = event.target.closest?.('[data-action]');
  const node = target && state.nodes.get(target.closest('tr[data-id]')?.dataset.id);
  if (node) rowActions[target.dataset.action]?.(node, target);
});
$('items').addEventListener('change', event => {
  const check = event.target, row = check.closest?.('tr[data-id]');
  if (!row || check.type !== 'checkbox') return;
  if (check.checked) state.selected.add(row.dataset.id); else state.selected.delete(row.dataset.id);
  row.classList.toggle('selected', check.checked);
  renderSelection();
});
// Bookmarks and folders with every search term in their details or, for a
// bookmark, in its saved page text; passages gets the text around the first
// term only the page has.
// Each item's details as search reads them, lowercased once per library; and
// the last search, so typing more of the same words (every earlier word part
// of a new one) looks only through what already matched.
let searchable = { root: null, details: new Map() }, lastSearch = null;
function searchLibrary(terms, passages) {
  const highlightText = node => (node.highlights || []).map(h => `${h.text} ${h.note || ''}`).join(' ');
  if (searchable.root !== state.root) searchable = { root: state.root, details: new Map() };
  const narrower = lastSearch?.root === state.root && lastSearch.texts === pageTexts.version && lastSearch.terms.every(term => terms.some(next => next.includes(term)));
  const matches = [];
  for (const node of narrower ? lastSearch.matches : state.nodes.values()) {
    if (node.id === state.root.id || node.type === 'separator') continue;
    let details = searchable.details.get(node.id);
    if (details === undefined) searchable.details.set(node.id, details = `${title(node)} ${node.url || ''} ${path(node.parentId)} ${node.abstract || ''} ${node.note || ''} ${(node.tags || []).join(' ')} ${highlightText(node)}`.toLowerCase());
    const missing = terms.filter(term => !details.includes(term));
    if (missing.length) {
      const page = node.url && pageTexts.get(node.id);
      if (!page?.text) continue;
      page.lower ??= page.text.toLowerCase();
      if (!missing.every(term => page.lower.includes(term))) continue;
      passages.set(node.id, passageAround(page.text, page.lower, missing[0]));
    }
    matches.push(node);
  }
  lastSearch = { root: state.root, texts: pageTexts.version, terms, matches };
  return [...matches];
}
// X's official post embed. Its frame reports its height with a postMessage.
// Heights X last reported, so a reload starts each post at its real size
// instead of growing or shrinking. A per-browser convenience; safe to lose.
const TWEET_HEIGHTS = 'markedTweetHeights';
const tweetHeights = (() => {
  try { return JSON.parse(document.defaultView.localStorage.getItem(TWEET_HEIGHTS)) || {}; } catch { return {}; }
})();
function tweetEmbed(id) {
  const frame = element('iframe', 'tweet-embed');
  frame.dataset.tweet = id;
  // Unknown posts start collapsed rather than at a placeholder height.
  frame.style.height = `${tweetHeights[id] || 0}px`;
  frame.src = `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true${isDark() ? '&theme=dark' : ''}`;
  frame.title = 'Post on X';
  frame.loading = 'lazy';
  frame.referrerPolicy = 'no-referrer';
  frame.setAttribute('scrolling', 'no');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
  return frame;
}
document.defaultView.addEventListener('message', event => {
  if (event.origin !== 'https://platform.twitter.com') return;
  let data = event.data;
  try { if (typeof data === 'string') data = JSON.parse(data); } catch { return; }
  const message = data?.['twttr.embed'];
  const height = Number(message?.params?.[0]?.height);
  if (message?.method !== 'twttr.private.resize' || !(height > 0 && height < 5000)) return;
  const frame = [...document.querySelectorAll('iframe.tweet-embed')].find(f => f.contentWindow === event.source);
  if (!frame) return;
  frame.style.height = `${Math.ceil(height)}px`;
  tweetHeights[frame.dataset.tweet] = Math.ceil(height);
  try { document.defaultView.localStorage.setItem(TWEET_HEIGHTS, JSON.stringify(tweetHeights)); } catch {}
});
function showHighlights(id) {
  const node = state.nodes.get(id);
  if (!node?.highlights?.length) { if ($('highlights-dialog').open) $('highlights-dialog').close(); return; }
  $('highlights-title').textContent = `Highlights on “${title(node)}”`;
  $('highlights-list').replaceChildren(...node.highlights.map(highlight => {
    const item = element('li', `hl-${colorOf(highlight)}`);
    const quote = element('blockquote', 'quote', highlight.text);
    const remove = iconButton('trash', async () => {
      try { await library.removeHighlight(id, highlight.id); await load(); showHighlights(id); } catch (error) { fail(error); }
    }, 'item-action', 'Delete highlight');
    item.append(quote, remove);
    if (highlight.note) item.append(element('p', 'highlight-note', highlight.note));
    item.append(element('p', 'highlight-date', relativeAge(highlight.createdAt)));
    return item;
  }));
  if (!$('highlights-dialog').open) $('highlights-dialog').showModal();
}
// The Highlights view: every highlight in the library, newest first, narrowed
// by color, site, when it was made, and the search box.
function allHighlights() {
  const list = [];
  for (const node of state.nodes.values()) for (const highlight of node.highlights || []) list.push({ node, highlight });
  return list.sort((a, b) => (b.highlight.createdAt || 0) - (a.highlight.createdAt || 0));
}
// Where a highlight opens: in the reader when its page's text is saved, else
// the page, scrolled to the passage by a text fragment (both browsers follow them).
function highlightLink(node, highlight) {
  if (pageTexts.get(node.id)?.text) return readerURL(node, { highlight: highlight.id });
  const url = safeURL(node.url);
  if (!url) return '';
  const words = highlight.text.split(/\s+/);
  const part = text => encodeURIComponent(text).replace(/-/g, '%2D').replace(/,/g, '%2C');
  const passage = words.length > 12 ? `${part(words.slice(0, 5).join(' '))},${part(words.slice(-5).join(' '))}` : part(highlight.text);
  return `${url.split('#')[0]}#:~:text=${passage}`;
}
function renderHighlights() {
  const filter = state.highlightFilter;
  const terms = searchTerms($('search').value.trim().toLowerCase());
  const days = { week: 7, month: 31, year: 366 }[filter.since];
  const all = allHighlights();
  // Every filter but color, so each color's count says what choosing it shows.
  const matching = all.filter(({ node, highlight }) => (!filter.site || displayDomain(node.url) === filter.site)
    && (!days || Date.now() - (highlight.createdAt || 0) < days * 864e5)
    && terms.every(term => `${highlight.text} ${highlight.note || ''} ${title(node)}`.toLowerCase().includes(term)));
  const shown = filter.color ? matching.filter(({ highlight }) => colorOf(highlight) === filter.color) : matching;
  $('page-title').textContent = 'Highlights';
  $('breadcrumbs').replaceChildren(crumb('Library', state.root.id));
  for (const id of ['open-all', 'shuffle', 'merge-all', 'view-note', 'semantic-status', 'welcome']) $(id).hidden = true;
  document.querySelector('.list-toolbar:not(.highlight-tools)').hidden = true;
  document.querySelector('.table-wrap').hidden = true;
  $('highlight-count').textContent = `${shown.length.toLocaleString()} ${shown.length === 1 ? 'highlight' : 'highlights'}`;
  $('highlight-colors').replaceChildren(...[null, ...HIGHLIGHT_COLORS].map(color => {
    const count = color ? matching.filter(({ highlight }) => colorOf(highlight) === color).length : matching.length;
    const chip = button(color ? count.toLocaleString() : 'All', () => { filter.color = color; render(); }, color ? `color-chip hl-${color}` : 'color-chip', color ? `${colorName(color)}: ${count}` : 'Every color');
    chip.setAttribute('aria-pressed', String(filter.color === color));
    chip.hidden = !!color && !count && filter.color !== color;
    return chip;
  }));
  // Sites, most highlighted first.
  const sites = new Map();
  for (const { node } of all) sites.set(displayDomain(node.url), (sites.get(displayDomain(node.url)) || 0) + 1);
  const option = (label, value) => { const choice = element('option', '', label); choice.value = value; return choice; };
  $('highlight-site').replaceChildren(option('All sites', ''), ...[...sites].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([site, count]) => option(`${site} (${count})`, site)));
  $('highlight-site').value = filter.site;
  $('highlight-since').value = filter.since;
  $('highlight-list').replaceChildren(...shown.map(({ node, highlight }) => highlightItem(node, highlight, terms)));
  $('empty').hidden = shown.length > 0;
  $('empty').classList.remove('welcoming');
  $('empty').querySelector('h2').textContent = all.length ? 'No highlights match' : 'No highlights yet';
  $('empty').querySelector('p').textContent = all.length ? 'Try another color, site, time, or search.' : `Select text on any page, then choose Highlight or press ${KEY.alt}${MAC ? '' : '+'}${KEY.shift}${MAC ? '' : '+'}H.`;
  state.visible = [];
  renderSelection();
}
function highlightItem(node, highlight, terms) {
  const color = colorOf(highlight);
  const item = element('li', `highlight-item hl-${color}`);
  const quote = element('blockquote', 'quote');
  markText(quote, highlight.text, { terms });
  item.append(quote);
  if (highlight.note) item.append(element('p', 'highlight-note', highlight.note));
  const source = element('div', 'highlight-source');
  const page = element('a', 'highlight-page', title(node));
  const url = safeURL(node.url);
  if (url) { page.href = url; page.target = '_blank'; page.rel = 'noopener noreferrer'; }
  page.title = node.url;
  const age = element('time', 'item-age', relativeAge(highlight.createdAt));
  if (highlight.createdAt) age.dateTime = new Date(highlight.createdAt).toISOString();
  const open = element('a', 'highlight-open', 'Show passage');
  const link = highlightLink(node, highlight);
  if (link) { open.href = link; open.target = '_blank'; open.rel = 'noopener noreferrer'; }
  open.hidden = !link;
  const actions = element('span', 'highlight-actions');
  actions.append(swatches(color, next => recolor(node, highlight, next).catch(fail), 'swatches small'), open, iconButton('trash', () => deleteHighlight(node, highlight).catch(fail), 'item-action', 'Delete highlight'));
  source.append(siteIcon(node), page, element('span', 'item-url', displayDomain(node.url)), age, actions);
  item.append(source);
  return item;
}
async function recolor(node, highlight, color) {
  if (colorOf(highlight) === color) return;
  await library.updateHighlight(node.id, highlight.id, { color });
  await load();
}
async function deleteHighlight(node, highlight) {
  await library.removeHighlight(node.id, highlight.id);
  await load();
  toast('Highlight deleted.', async () => { await library.addHighlight(node.id, highlight); await load(); }, 'Highlight restored.');
}
// Reads a capture the background stored for this request, if it is still fresh.
async function readCapture(key) {
  if (!key?.startsWith('capture-')) return null;
  try {
    const capture = (await browser.storage.session.get(key))[key];
    await browser.storage.session.remove(key);
    return capture && Date.now() - capture.createdAt < 60000 ? capture : null;
  } catch { return null; }
}
function renderSemanticStatus() {
  const status = $('semantic-status');
  // Semantic stays pressed while Jev's results show; typing something new releases it.
  $('semantic-toggle').setAttribute('aria-pressed', String(semanticShown()));
  status.hidden = !semanticShown();
  if (status.hidden) return;
  const total = jevUsage?.calls ? ` · ${formatCost(jevCost(jevUsage.inputTokens, jevUsage.outputTokens))} in total` : '';
  if (semantic.status === 'searching') status.textContent = 'Searching by meaning with Jev…';
  else if (semantic.status === 'error') status.textContent = `Semantic search didn't run: ${semantic.error} Showing keyword matches.`;
  else if (semantic.status === 'preview') status.textContent = `Preview only: nothing was sent to TypeSafe. This search would cost about ${formatCost(jevCost(semantic.estimated))} (≈${semantic.estimated.toLocaleString()} input tokens; output is free). The request is in the browser console. Showing keyword matches.`;
  else {
    const none = semantic.result.exists < 0.35;
    status.textContent = `${none ? 'No bookmark clearly matches; the closest come first.' : 'Ranked by meaning with Jev.'} ${semantic.cached ? 'Repeated search, no charge' : `This search ${formatCost(semantic.cost)}`}${total}.`;
  }
}
// Asks Jev about what's in the search box, once each time the user chooses
// Semantic. A newer search cancels an older one; a repeated query comes from
// the cache, free.
function searchByMeaning() {
  semantic.controller?.abort();
  const query = $('search').value.trim();
  if (semantic.cache.has(query)) Object.assign(semantic, { query, result: semantic.cache.get(query), status: 'done', cached: true });
  else {
    Object.assign(semantic, { query, result: null, status: 'searching' });
    runSemantic(query);
  }
  render();
}
function clearSemantic() {
  semantic.controller?.abort();
  Object.assign(semantic, { query: '', result: null, status: '' });
}
// One line per bookmark, as Jev reads them; bookmarks with nothing to read are left out.
const searchEntries = (options = jev) => [...state.nodes.values()].filter(node => node.url)
  .map(node => ({ id: node.id, line: bookmarkLine(node, options) })).filter(entry => entry.line);
async function runSemantic(query) {
  const controller = semantic.controller = new AbortController();
  let inputTokens = 0, outputTokens = 0, estimated = 0;
  const onUsage = usage => {
    inputTokens += Number(usage.input_tokens) || 0;
    outputTokens += Number(usage.output_tokens) || 0;
    recordJevUsage(browser.storage.local, usage).then(total => { jevUsage = total; renderSemanticStatus(); }, () => {});
  };
  try {
    const result = await semanticSearch(query, searchEntries(), request => {
      estimated += estimateJevTokens(request);
      return askJev({ ...request, apiKey: jev.apiKey, preview: jev.preview, signal: controller.signal, onUsage });
    });
    if (controller.signal.aborted) return;
    if (!jev.preview) semantic.cache.set(query, result);
    // If the query was edited meanwhile, the paid answer waits in the cache.
    if (semantic.query !== query) return;
    if (jev.preview) Object.assign(semantic, { result: null, status: 'preview', estimated });
    else Object.assign(semantic, { result, status: 'done', cost: jevCost(inputTokens, outputTokens), cached: false });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError' || semantic.query !== query) return;
    Object.assign(semantic, { result: null, status: 'error', error: error.message });
  }
  render();
}
async function saveJev() {
  await browser.storage.local.set({ [JEV_SETTINGS_KEY]: jev });
}
function renderUsage() {
  $('jev-usage').textContent = jevUsage?.calls
    ? `${jevUsage.calls.toLocaleString()} ${jevUsage.calls === 1 ? 'request' : 'requests'} · ${jevUsage.inputTokens.toLocaleString()} input tokens · ${formatCost(jevCost(jevUsage.inputTokens, jevUsage.outputTokens))} since ${new Date(jevUsage.since).toLocaleDateString()}`
    : 'No requests yet.';
  $('jev-reset').disabled = !jevUsage?.calls;
}
// What one search of the whole library costs, from the requests it would send
// with the options ticked in Settings. Nothing is sent.
async function renderEstimate() {
  const entries = searchEntries({ notes: $('jev-notes').checked, highlights: $('jev-highlights').checked });
  let tokens = 0;
  await semanticSearch('something I saved a while ago', entries, request => { tokens += estimateJevTokens(request); return {}; });
  $('jev-estimate').textContent = entries.length
    ? `Each search of your ${entries.length.toLocaleString()} ${entries.length === 1 ? 'bookmark' : 'bookmarks'} costs about ${formatCost(jevCost(tokens))} (≈${tokens.toLocaleString()} input tokens; output is free).`
    : '';
}
// Settings has a section for each topic, chosen from its sidebar. Changes apply
// at once, except a new API key, which TypeSafe checks when it's saved.
let settingsSection = 'appearance';
// What to do once a key is saved, when Semantic asked for one.
let afterKey = null;
const settingsTabs = () => [...document.querySelectorAll('.settings-nav [role="tab"]')];
function showSettingsSection(name, focus = false) {
  settingsSection = name;
  for (const tab of settingsTabs()) {
    const selected = tab.dataset.section === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const panel of document.querySelectorAll('.settings-panels [role="tabpanel"]')) panel.hidden = panel.dataset.section !== name;
  document.querySelector('.settings-panels').scrollTop = 0;
}
function openSettings(section = settingsSection, { message = '', after = null } = {}) {
  afterKey = after;
  $('jev-key').value = jev.apiKey;
  $('jev-notes').checked = jev.notes;
  $('jev-highlights').checked = jev.highlights;
  $('jev-preview').checked = jev.preview;
  $('jev-remove').hidden = !jev.apiKey;
  $('settings-status').textContent = message;
  $('settings-error').textContent = '';
  renderUsage();
  renderEstimate().catch(() => {});
  renderTextSettings();
  $('browsing-related').checked = browsing.related;
  showSettingsSection(section);
  $('settings-dialog').showModal();
  if (section === 'semantic' && !jev.apiKey) $('jev-key').focus();
  else document.querySelector('.settings-nav [aria-selected="true"]').focus();
}
// Page text: whether to keep it, how much there is, and downloading it for
// bookmarks that don't have it. A download runs in this tab, four pages at a
// time, and stops if the tab closes; the next one picks up where it stopped.
const textDownload = { controller: null, done: 0, total: 0 };
const downloadable = node => /^https?:/.test(node.url) && !tweetId(node.url);
const pageCount = count => `${count.toLocaleString()} ${count === 1 ? 'page' : 'pages'}`;
function formatBytes(bytes) {
  return bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;
}
// Bookmarks without their text, or a post without its card.
function textsMissing() {
  return [...state.nodes.values()].filter(node => node.url && downloadable(node) && (!pageTexts.get(node.id)?.text || (!node.card && siteOf(node.url))));
}
function renderTextSettings() {
  $('text-keep').checked = textSettings.keep;
  const bookmarks = [...state.nodes.values()].filter(node => node.url);
  const kept = bookmarks.map(node => pageTexts.get(node.id)?.text).filter(Boolean);
  const size = kept.reduce((sum, text) => sum + text.length, 0);
  $('text-stats').textContent = `${kept.length.toLocaleString()} of ${bookmarkCount(bookmarks.length)}${kept.length ? ` · about ${formatBytes(size)}` : ''}`;
  $('text-clear').hidden = !kept.length;
  const running = !!textDownload.controller;
  $('text-stop').hidden = !running;
  $('text-progress').hidden = !running;
  if (running) {
    $('text-progress').max = textDownload.total;
    $('text-progress').value = textDownload.done;
    $('text-status').textContent = `Downloading ${textDownload.done.toLocaleString()} of ${pageCount(textDownload.total)}…`;
  }
  const missing = textsMissing();
  const failed = missing.filter(node => pageTexts.get(node.id)?.error).length;
  $('text-missing').textContent = !missing.length ? 'Every bookmark has its text.'
    : `${bookmarkCount(missing.length)} ${missing.length === 1 ? 'doesn’t have its' : 'don’t have their'} text yet${failed ? `, including ${failed.toLocaleString()} that couldn’t be read last time` : ''}. Marked can download each page from its site. No cookies go with the request, so pages that need you to sign in may come back empty.`;
  $('text-download').hidden = running || !missing.length;
  $('text-download').textContent = `Download text for ${bookmarkCount(missing.length)}`;
}
// A post's card and its thread or discussion, from its site's API.
async function readSite(node, signal) {
  const { card, text } = await fetchSite(node.url, { signal });
  if (card) await library.setCards({ [node.id]: card });
  const saved = text && await library.setText(node.id, { ...text, via: 'download' });
  if (saved) pageTexts.set(node.id, saved);
  return saved || null;
}
async function downloadTexts() {
  // Reading other sites needs access to them. Ask while the click still counts
  // as user input; without one, go ahead if access was already given.
  const access = browser.permissions?.request?.(ALL_SITES).catch(() => browser.permissions.contains(ALL_SITES)).catch(() => false);
  const targets = textsMissing();
  if (!targets.length || textDownload.controller) return;
  if (await access === false) { $('text-status').textContent = 'Allow Marked on all websites to download pages, then try again.'; return; }
  const controller = textDownload.controller = new AbortController();
  Object.assign(textDownload, { done: 0, total: targets.length });
  let saved = 0, failed = 0;
  renderTextSettings();
  try {
    // Posts read their sites' APIs; only other pages need Readability.
    if (targets.some(node => !siteOf(node.url))) await loadReadability();
    const queue = [...targets];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length && !controller.signal.aborted) {
        const node = queue.shift();
        let stored = null, read = false;
        try {
          // A post reads its site's API; any other page, its own address.
          stored = siteOf(node.url) ? await readSite(node, controller.signal)
            : await library.setText(node.id, { ...await fetchPageText(node.url, { signal: controller.signal }), via: 'download' }, { replace: false });
          read = true;
        } catch (error) {
          if (controller.signal.aborted) return;
          stored = await library.setText(node.id, { error: error.message, via: 'download' }, { replace: false }).catch(() => null);
        }
        if (stored) pageTexts.set(node.id, stored);
        if (read) saved++; else failed++;
        textDownload.done++;
        if ($('settings-dialog').open) renderTextSettings();
      }
    }));
    const summary = `${controller.signal.aborted ? 'Stopped. ' : ''}Saved the text of ${pageCount(saved)}${failed ? `; ${failed.toLocaleString()} couldn’t be read` : ''}.`;
    $('text-status').textContent = summary;
    if (!$('settings-dialog').open) toast(summary);
  } catch (error) {
    $('text-status').textContent = error.message;
  } finally {
    textDownload.controller = null;
    // Cards arrived in the library, too.
    await load().catch(() => {});
    renderTextSettings();
  }
}
// Settings changed: cached answers are stale, and keyword matches return.
function refreshSemantic() {
  semantic.cache.clear();
  clearSemantic();
  render();
}
let noteNode = null;
function showNote(node) {
  noteNode = node;
  $('note-title').textContent = title(node);
  $('note-site').textContent = displayDomain(node.url);
  $('note-text').textContent = node.note;
  $('note-dialog').showModal();
}
function renderSelection() {
  const count = state.selected.size;
  $('selection-tools').hidden = !count;
  $('list-label').hidden = !!count;
  $('selection-count').textContent = `${count} selected`;
  const selectable = state.visible.filter(n => !protectedNode(n));
  $('select-all').checked = selectable.length > 0 && count === selectable.length;
  $('select-all').indeterminate = count > 0 && count < selectable.length;
  $('select-all').disabled = !selectable.length;
}
function fillFolders(select, excluded = new Set(), selected = defaultFolder()) {
  select.replaceChildren();
  function append(node, depth) {
    if (!isFolder(node) || excluded.has(node.id)) return;
    const option = element('option', '', `${'　'.repeat(depth)}${title(node)}`);
    option.value = node.id; select.append(option);
    node.children?.forEach(child => append(child, depth + 1));
  }
  const rootOption = element('option', '', 'Library (top level)');
  rootOption.value = state.root.id;
  select.append(rootOption);
  state.root.children.forEach(node => append(node, 1));
  if ([...select.options].some(o => o.value === selected)) select.value = selected;
}
function openEditor(node = null, folder = false) {
  state.editing = node;
  pendingPreview = validPreview(previews.get(node?.id)) ? previews.get(node.id) : null;
  pendingPreviewURL = node?.url || null;
  showEditorPreview();
  const isDir = node ? isFolder(node) : folder;
  $('editor-title').textContent = `${node ? 'Edit' : 'New'} ${isDir ? 'folder' : 'bookmark'}`;
  $('edit-name').value = node?.title || '';
  $('edit-url').value = node?.url || '';
  $('url-field').hidden = isDir;
  $('edit-url').required = !isDir;
  $('abstract-field').hidden = isDir;
  $('edit-abstract').value = node?.abstract || '';
  $('note-field').hidden = isDir;
  $('edit-note').value = node?.note || '';
  $('tags-field').hidden = isDir;
  editorTags = node ? [...(node.tags || [])] : state.tag ? [state.tag] : [];
  tagsTouched = false; editorSession++;
  $('new-tag').value = ''; $('tags-hint').textContent = '';
  renderTagOptions();
  $('editor-error').textContent = '';
  pendingHighlight = ''; pendingColor = 'yellow'; $('highlight-field').hidden = true; $('edit-highlight-note').value = '';
  fillFolders($('edit-parent'), new Set(node ? [node.id] : []), node?.parentId || defaultFolder());
  $('editor').showModal(); $('edit-name').focus();
}
function renderEditorColors() {
  $('edit-highlight-colors').replaceChildren(...swatches(pendingColor, color => { pendingColor = color; renderEditorColors(); }).children);
  $('edit-highlight').className = `quote hl-${pendingColor}`;
}
function renderTagOptions() {
  $('edit-tags').replaceChildren(...cleanTags([...state.tags, ...editorTags], Infinity).map(tag => {
    const chip = button(tag, () => {
      tagsTouched = true;
      editorTags = editorTags.some(t => sameTag(t, tag)) ? editorTags.filter(t => !sameTag(t, tag)) : [...editorTags, tag];
      renderTagOptions();
    }, 'tag-option');
    chip.setAttribute('aria-pressed', String(editorTags.some(t => sameTag(t, tag))));
    return chip;
  }));
}
function addEditorTag() {
  const tag = cleanTag($('new-tag').value);
  $('new-tag').value = '';
  if (!tag) return;
  tagsTouched = true;
  if (!editorTags.some(t => sameTag(t, tag))) editorTags.push(tag);
  renderTagOptions();
}
// Adds likely tags from the fields; automatic runs defer to the user's own picks.
async function suggestEditorTags(automatic = false) {
  const session = editorSession;
  const page = { title: $('edit-name').value, url: $('edit-url').value, abstract: $('edit-abstract').value };
  const suggested = chooseTags(await suggestTags(page, state.tags));
  if (session !== editorSession || !$('editor').open || (automatic && tagsTouched)) return;
  for (const tag of suggested) if (!editorTags.some(t => sameTag(t, tag))) editorTags.push(tag);
  renderTagOptions();
  $('tags-hint').textContent = suggested.length ? `Suggested from the title, address, and abstract: ${suggested.join(', ')}.` : 'No tags matched. Choose tags yourself.';
}
function showEditorPreview() {
  $('preview-field').hidden = !pendingPreview;
  $('save-preview').checked = !!pendingPreview;
  if (pendingPreview) $('edit-preview').src = pendingPreview;
  else $('edit-preview').removeAttribute('src');
}
async function confirmAction(heading, message, accept) {
  $('confirm-title').textContent = heading; $('confirm-message').textContent = message; $('confirm-accept').textContent = accept;
  const dialog = $('confirm-dialog'); dialog.returnValue = '';
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept'), { once: true }); dialog.showModal(); });
}
function topLevelIds(ids) {
  const set = new Set(ids);
  return ids.filter(id => { const node = state.nodes.get(id); return node && !protectedNode(node) && !ancestors(node.parentId).some(parent => set.has(parent.id)); });
}
async function removeItems(ids) {
  ids = topLevelIds(ids);
  if (!ids.length) return;
  const single = ids.length === 1 ? state.nodes.get(ids[0]) : null;
  const folder = single && isFolder(single);
  function descendants(node) {
    return (node.children || []).reduce((count, child) => count + 1 + descendants(child), 0);
  }
  const childCount = ids.reduce((count, id) => count + descendants(state.nodes.get(id)), 0);
  const subject = single ? `“${title(single)}”` : `${ids.length} selected items`;
  const contents = childCount ? ` This also deletes all ${childCount} nested items, including every bookmark and subfolder inside. Are you OK with deleting all of them?` : '';
  if (!await confirmAction(folder ? 'Delete folder?' : 'Delete bookmarks?', `Delete ${subject} from Marked?${contents} Your browser’s own bookmarks will not change. You can undo using the message shown after deletion.`, folder ? 'Delete folder' : 'Delete')) return;
  const deleted = await library.removeMany(ids);
  state.selected.clear(); await load();
  toast('Deleted from Marked.', async () => {
    await library.restoreMany(deleted);
    await load();
  });
}
$('editor-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try {
    const name = $('edit-name').value.trim();
    if (!name) throw new Error('Enter a name.');
    const folder = $('url-field').hidden;
    const url = folder ? undefined : safeURL($('edit-url').value.trim());
    if (!folder && !url) throw new Error('Use an http, https, ftp, or file URL.');
    if (!folder) addEditorTag();
    const changes = { title: name, ...(folder ? {} : { url, abstract: cleanAbstract($('edit-abstract').value), note: cleanNote($('edit-note').value), tags: editorTags }) };
    if (pendingPreview) {
      changes.preview = !folder && $('save-preview').checked && url === pendingPreviewURL ? pendingPreview : null;
    }
    if (pendingHighlight && !state.editing) changes.highlights = [{ text: pendingHighlight, note: $('edit-highlight-note').value, color: pendingColor }];
    if (pendingIcon && !state.editing && url === pendingPreviewURL) changes.icon = pendingIcon;
    const parentId = $('edit-parent').value;
    if (state.editing) {
      await library.update(state.editing.id, changes, parentId);
    } else {
      const captured = url === pendingPreviewURL;
      const created = await library.create({ ...changes, ...(pendingCard && captured && { card: pendingCard }), parentId, type: folder ? 'folder' : 'bookmark' });
      if (pendingText && captured && textSettings.keep) {
        const saved = await library.setText(created.id, { ...pendingText, via: 'page' }).catch(() => null);
        if (saved) pageTexts.set(created.id, saved);
      }
      if (!folder && !(pendingCard && captured) && siteOf(url)) readSite(created).catch(error => console.warn('No card for this bookmark', error));
    }
    $('editor').close(); await load(); toast('Saved to Marked.');
  } catch (error) { $('editor-error').textContent = error.message; }
  finally { submit.disabled = false; }
});
$('move-selected').addEventListener('click', () => {
  fillFolders($('move-parent'), state.selected); $('move-error').textContent = ''; $('move-dialog').showModal();
});
$('move-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled = true;
  try {
    const parentId = $('move-parent').value;
    if (!parentId) throw new Error('Choose a destination folder.');
    await library.moveMany(topLevelIds([...state.selected]), parentId);
    $('move-dialog').close(); state.selected.clear(); await load(); toast('Items moved.');
  } catch (error) { $('move-error').textContent = error.message; }
  finally { event.submitter.disabled = false; }
});
// Drag and drop: bookmarks and folders go into any folder (in the list, the
// sidebar, or the breadcrumbs), and within a folder shown in saved order they
// can be arranged by hand. Alt+↑ and Alt+↓ do the same from the keyboard.
const DRAG_TYPE = 'application/x-marked-items';
const rowOf = id => [...$('items').rows].find(row => row.dataset.id === id);
let drag = null, expandTimer = null;
const canArrange = () => !!state.folder && !state.tag && !state.special && !$('search').value.trim() && $('sort').value === 'default';
// A folder can take the dragged items unless it is one of them or inside one.
const canTake = folder => isFolder(folder) && !drag.ids.some(id => id === folder.id || ancestors(folder.id).some(parent => parent.id === id));
function clearDrop() {
  for (const marked of document.querySelectorAll('.drop-before, .drop-after, .drop-into')) marked.classList.remove('drop-before', 'drop-after', 'drop-into');
}
// Where a drop on this row lands: 'into' a folder (its middle), or 'before' or
// 'after' it (across a list row's height, or a card's width) when arranging.
function dropPlace(row, event) {
  const target = state.nodes.get(row.dataset.id);
  if (!drag || !target || drag.ids.includes(target.id)) return null;
  const rect = row.getBoundingClientRect();
  const gallery = view === 'gallery';
  const along = gallery ? (event.clientX - rect.left) / (rect.width || 1) : (event.clientY - rect.top) / (rect.height || 1);
  const arrange = canArrange() && target.parentId === state.folder;
  if (canTake(target) && (!arrange || (along > 0.25 && along < 0.75))) return 'into';
  if (!arrange) return null;
  return along < 0.5 ? 'before' : 'after';
}
// The child that comes after node in its folder, skipping the ones being moved.
function nextSibling(node) {
  const siblings = state.nodes.get(node.parentId)?.children || [];
  return siblings.slice(siblings.findIndex(child => child.id === node.id) + 1).find(child => !drag.ids.includes(child.id))?.id ?? null;
}
async function moveItems(ids, parentId, beforeId = null) {
  const places = await library.moveMany(ids, parentId, beforeId);
  state.selected.clear();
  await load();
  // Arranging within the folder on screen needs no message; moving elsewhere can be undone.
  if (places.every(place => place.parentId === parentId)) return;
  const destination = state.nodes.get(parentId);
  const what = ids.length === 1 ? `“${title(state.nodes.get(ids[0]))}”` : `${ids.length} items`;
  toast(`Moved ${what} to ${destination.id === state.root.id ? 'the top of the library' : `“${title(destination)}”`}.`, async () => {
    await library.placeMany(places);
    await load();
  }, 'Moved back.');
}
function startDrag(event, ids) {
  drag = { ids };
  const nodes = ids.map(id => state.nodes.get(id));
  const urls = nodes.filter(node => node.url).map(node => node.url);
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData(DRAG_TYPE, ids.join(','));
  // Dropped outside Marked, bookmarks are their addresses: a new tab, a message, a document.
  if (urls.length) event.dataTransfer.setData('text/uri-list', urls.join('\r\n'));
  event.dataTransfer.setData('text/plain', urls.length ? urls.join('\n') : nodes.map(title).join('\n'));
  if (ids.length > 1) {
    const label = element('div', 'drag-label', `${ids.length} items`);
    document.body.append(label);
    event.dataTransfer.setDragImage?.(label, 12, 12);
    setTimeout(() => label.remove(), 0);
  }
  document.body.classList.add('dragging');
  for (const id of ids) rowOf(id)?.classList.add('dragged');
}
function endDrag() {
  drag = null;
  clearTimeout(expandTimer);
  clearDrop();
  document.body.classList.remove('dragging');
  for (const row of document.querySelectorAll('.dragged')) row.classList.remove('dragged');
}
$('items').addEventListener('dragstart', event => {
  const row = event.target.closest?.('tr[data-id]');
  if (!row || !row.draggable) return;
  // A selected row carries the whole selection with it.
  const ids = state.selected.has(row.dataset.id) ? topLevelIds([...state.selected]) : [row.dataset.id];
  if (!ids.length) { event.preventDefault(); return; }
  startDrag(event, ids);
});
$('items').addEventListener('dragover', event => {
  const row = event.target.closest?.('tr[data-id]');
  const place = row && dropPlace(row, event);
  clearDrop();
  if (!place) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  row.classList.add(`drop-${place}`);
});
$('items').addEventListener('drop', event => {
  const row = event.target.closest?.('tr[data-id]');
  const place = row && dropPlace(row, event);
  if (!place) return;
  event.preventDefault();
  const target = state.nodes.get(row.dataset.id), ids = drag.ids;
  const move = place === 'into' ? moveItems(ids, target.id) : moveItems(ids, state.folder, place === 'before' ? target.id : nextSibling(target));
  endDrag();
  move.catch(fail);
});
// Folders in the sidebar and the breadcrumbs take drops too; a closed folder
// opens after a moment, so items can go deeper.
$('folder-tree').addEventListener('dragstart', event => {
  const row = event.target.closest?.('.folder-row[data-id]');
  if (row) startDrag(event, [row.dataset.id]);
});
for (const area of ['folder-tree', 'breadcrumbs']) {
  const targetOf = event => event.target.closest?.('[data-id]');
  $(area).addEventListener('dragover', event => {
    const target = targetOf(event), folder = target && drag && state.nodes.get(target.dataset.id);
    if (!folder || !canTake(folder)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (target.classList.contains('drop-into')) return;
    clearDrop();
    target.classList.add('drop-into');
    clearTimeout(expandTimer);
    if (area === 'folder-tree' && !state.expanded.has(folder.id) && folder.children?.some(isFolder)) {
      expandTimer = setTimeout(() => { state.expanded.add(folder.id); renderTree(); }, 700);
    }
  });
  $(area).addEventListener('drop', event => {
    const target = targetOf(event), folder = target && drag && state.nodes.get(target.dataset.id);
    if (!folder || !canTake(folder)) return;
    event.preventDefault();
    const ids = drag.ids;
    endDrag();
    moveItems(ids, folder.id).catch(fail);
  });
}
document.addEventListener('dragend', endDrag);
// Alt+↑ and Alt+↓ move the focused bookmark within its folder, in saved order.
$('items').addEventListener('keydown', async event => {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !canArrange()) return;
  const row = event.target.closest?.('tr[data-id]');
  const siblings = (state.nodes.get(state.folder)?.children || []).filter(child => child.type !== 'separator');
  const index = siblings.findIndex(child => child.id === row?.dataset.id);
  const up = event.key === 'ArrowUp';
  if (index < 0 || !siblings[index + (up ? -1 : 1)]) return;
  event.preventDefault();
  const focused = [...row.querySelectorAll('input, a, button')].indexOf(event.target);
  try {
    await library.moveMany([row.dataset.id], state.folder, up ? siblings[index - 1].id : siblings[index + 2]?.id ?? null);
    await load();
  } catch (error) { fail(error); return; }
  rowOf(row.dataset.id)?.querySelectorAll('input, a, button')[Math.max(0, focused)]?.focus();
});
function download(contents, type, name, extension) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = element('a'); link.href = url; link.download = `${name}-${new Date().toISOString().slice(0, 10)}.${extension}`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// One Export menu offers three files. A backup keeps everything, dates and
// previews too, for Import to restore in any browser's Marked; a standard
// bookmarks file is for other browsers and apps; the notes and highlights go
// to a notes app as Markdown.
async function downloadBackup() {
  const ids = [...state.nodes.values()].filter(node => node.url).map(node => node.id);
  const [texts, saved] = await Promise.all([library.getTexts(ids), library.getPreviews(ids)]);
  download(exportBackup(state.root, texts, saved), 'application/json', 'marked-backup', 'json');
  toast('Backup downloaded. Import it into Marked, in this browser or another, to restore your library.');
}
function exportBookmarks() {
  download(exportHTML(state.root), 'text/html;charset=utf-8', 'marked-bookmarks', 'html');
  toast('Exported your complete bookmark collection.');
}
function exportNotes() {
  const annotated = [...state.nodes.values()].filter(node => node.url && (node.note || node.highlights?.length)).length;
  if (!annotated) { toast('No notes or highlights to export yet.'); return; }
  download(exportMarkdown(state.root), 'text/markdown;charset=utf-8', 'marked-notes', 'md');
  toast(`Exported the notes and highlights on ${annotated} ${annotated === 1 ? 'bookmark' : 'bookmarks'}.`);
}
for (const [id, run] of [['export-backup', downloadBackup], ['export-html', exportBookmarks], ['export-markdown', exportNotes]]) {
  $(id).addEventListener('click', () => { $('export-menu').hidePopover?.(); Promise.resolve(run()).catch(fail); });
}
// Each menu opens under its button, lined up with its right edge; popovers
// otherwise sit in the middle of the page.
for (const [menu, owner] of [['export-menu', 'export'], ['import-menu', 'import']]) {
  $(menu).addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    const anchor = $(owner).getBoundingClientRect();
    $(menu).style.top = `${anchor.bottom + 8}px`;
    $(menu).style.left = `${Math.max(8, Math.min(anchor.right - $(menu).offsetWidth, document.defaultView.innerWidth - $(menu).offsetWidth - 8))}px`;
  });
}
// Import: a bookmarks file or backup, the browser's bookmarks, or X's.
$('import-file-open').addEventListener('click', () => { $('import-menu').hidePopover?.(); $('import-file').click(); });
$('import-browser').addEventListener('click', () => { $('import-menu').hidePopover?.(); offerBrowserImport({ asked: true }).catch(fail); });
$('import-x').addEventListener('click', () => { $('import-menu').hidePopover?.(); importFromX().catch(fail); });
// Marked opens X's bookmarks page in a new tab and saves every post there into
// an "X bookmarks" folder, as the page shows them; it needs you signed in to X.
async function importFromX() {
  // Firefox asks for access to X while the click still counts as user input.
  const access = browser.permissions?.request?.({ origins: ['https://x.com/*', 'https://twitter.com/*'] }).catch(() => true);
  if (await access === false) { toast('Marked needs access to x.com to read your bookmarks there.'); return; }
  const reply = await browser.runtime.sendMessage({ type: 'marked:import-x' });
  if (reply?.error) throw new Error(reply.error);
  toast('Collecting your bookmarks on X. Keep that tab open until it says it’s done.');
}

$('import-file').addEventListener('change', async () => {
  const file = $('import-file').files[0]; $('import-file').value = '';
  if (!file) return;
  try {
    const json = file.name.toLowerCase().endsWith('.json');
    // Marked backups include previews, so allow them to be larger.
    if (file.size > (json ? 250 : 25) * 1024 * 1024) throw new Error(`Choose a bookmark file smaller than ${json ? 250 : 25} MB.`);
    const text = await file.text();
    let parsed;
    if (json) {
      const data = JSON.parse(text);
      parsed = data?.format === 'marked' ? parseBackup(data) : parseJSON(data);
    } else parsed = parseHTML(text);
    const { nodes, skipped } = parsed;
    if (!nodes.length) throw new Error('No supported bookmarks or folders found.');
    let count = 0; const countNodes = list => list.forEach(n => { count++; if (n.children) countNodes(n.children); }); countNodes(nodes);
    const parentId = defaultFolder();
    if (!await confirmAction('Import bookmarks?', `Add ${count.toLocaleString()} items in a new “Imported” folder under ${path(parentId)}? Existing bookmarks are kept; duplicates are not merged.${skipped ? ` ${skipped} unsupported items will be skipped.` : ''}`, 'Import')) return;
    $('import').disabled = true;
    const container = await library.importTree(nodes, parentId, `Imported · ${new Date().toLocaleDateString()}`);
    await load(); navigate(container.id); toast(`Imported ${count.toLocaleString()} items${skipped ? `; skipped ${skipped} unsupported items` : ''}.`);
  } catch (error) {
    fail(error);
  } finally { $('import').disabled = false; load().catch(fail); }
});
// The browser's own bookmarks. Marked asks once, the first time it finds some
// the library doesn't have; Settings imports them any time after that.
const BROWSER_IMPORT_KEY = 'markedBrowserImportAsked';
// "Firefox" or "Chrome", for messages about the browser's bookmarks.
const browserName = (async () => {
  try { if (browser.runtime?.getBrowserInfo) return (await browser.runtime.getBrowserInfo()).name; } catch {}
  const brand = navigator.userAgentData?.brands?.map(({ brand }) => brand).find(brand => /^(Google Chrome|Microsoft Edge|Brave|Opera)$/.test(brand));
  return brand?.replace(/^(Google|Microsoft) /, '') || 'your browser';
})();
browserName.then(name => {
  $('browser-import-open').textContent = `Import from ${name}…`;
  $('welcome-import').textContent = `Import from ${name}`;
});
$('welcome-import').addEventListener('click', () => offerBrowserImport({ asked: true }).catch(fail));
const bookmarkCount = count => `${count.toLocaleString()} ${count === 1 ? 'bookmark' : 'bookmarks'}`;
async function offerBrowserImport({ asked = false } = {}) {
  const [[browserRoot], name] = await Promise.all([browser.bookmarks.getTree(), browserName]);
  const { count, already } = planBrowserImport(browserRoot, state.root);
  if (!count) {
    if (asked) toast(`Every bookmark in ${name} is already in Marked.`);
    return;
  }
  // Never on top of the editor or another dialog; Marked asks on a later visit.
  if (!asked && document.querySelector('dialog[open]')) return;
  const one = count === 1;
  $('browser-import-title').textContent = `Import bookmarks from ${name}?`;
  $('browser-import-text').textContent = `Marked found ${bookmarkCount(count)} in ${name}${already ? ` that ${one ? 'isn’t' : 'aren’t'} in Marked yet` : ''}. Import ${one ? 'it, keeping its folder' : 'them, keeping their folders'}? Nothing changes in ${name}.`;
  $('browser-import-accept').textContent = `Import ${bookmarkCount(count)}`;
  $('browser-import-error').textContent = '';
  const dialog = $('browser-import-dialog'); dialog.returnValue = '';
  dialog.showModal();
}
async function askFirstImport() {
  try {
    if (!(await browser.storage.local.get(BROWSER_IMPORT_KEY))[BROWSER_IMPORT_KEY]) await offerBrowserImport();
  } catch {}
}
$('browser-import-accept').addEventListener('click', async () => {
  const button = $('browser-import-accept'); button.disabled = true;
  $('browser-import-error').textContent = '';
  try {
    const count = await library.importBrowser();
    const dialog = $('browser-import-dialog'); dialog.returnValue = 'imported'; dialog.close();
    await load();
    toast(`Imported ${bookmarkCount(count)} from ${await browserName}.`);
  } catch (error) {
    $('browser-import-error').textContent = error.message;
  } finally { button.disabled = false; }
});
// Answered either way, so Marked doesn't ask again on its own.
$('browser-import-dialog').addEventListener('close', () => {
  browser.storage.local.set({ [BROWSER_IMPORT_KEY]: Date.now() }).catch(() => {});
  if ($('browser-import-dialog').returnValue !== 'imported') toast('You can import them later from Settings.');
});
$('browser-import-open').addEventListener('click', () => {
  $('settings-dialog').close();
  offerBrowserImport({ asked: true }).catch(fail);
});
$('chat-toggle').addEventListener('click', async () => {
  try {
    const { openChat } = await import('./chat.js');
    await openChat(() => state.root);
  } catch (error) { fail(error); }
});
$('all-bookmarks').addEventListener('click', () => navigate(null));
$('rediscover-nav').addEventListener('click', () => showSpecial('rediscover'));
$('highlights-nav').addEventListener('click', () => showSpecial('highlights'));
$('continue-nav').addEventListener('click', () => showSpecial('continue'));
$('highlight-site').addEventListener('change', () => { state.highlightFilter.site = $('highlight-site').value; render(); });
$('highlight-since').addEventListener('change', () => { state.highlightFilter.since = $('highlight-since').value; render(); });
$('duplicates-nav').addEventListener('click', () => showSpecial('duplicates'));
$('shuffle').addEventListener('click', () => { state.rediscover = pickRediscover(); render(); });
$('merge-all').addEventListener('click', () => mergeGroups(findDuplicates()).catch(fail));
$('welcome-add').addEventListener('click', () => openEditor());
$('suggest-tags').addEventListener('click', () => suggestEditorTags().catch(fail));
$('sidebar-add-tag').addEventListener('click', () => {
  $('tag-name').value = ''; $('tag-error').textContent = '';
  $('tag-dialog').showModal(); $('tag-name').focus();
});
$('tag-form').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const tag = await library.addTag($('tag-name').value);
    $('tag-dialog').close(); await load(); toast(`Added the tag “${tag}”.`);
  } catch (error) { $('tag-error').textContent = error.message; }
});
// Access to the pages you visit is asked for here, in Marked's own words, not
// at install. "Not now" puts the question away; Settings → Browsing keeps the switch.
let siteAccess = false;
async function renderSiteAccess() {
  siteAccess = await hasSiteAccess(browser);
  const asked = await browser.storage.local.get(SITE_ACCESS_ASKED_KEY).then(saved => !!saved[SITE_ACCESS_ASKED_KEY], () => false);
  $('site-access').hidden = siteAccess || asked;
  $('site-access-state').textContent = siteAccess ? 'Allowed on all websites' : 'Not allowed';
  $('site-access-toggle').textContent = siteAccess ? 'Turn off' : 'Allow';
}
// The browser shows its prompt only for a request made in the click itself.
function allowSites() {
  return browser.permissions.request(ALL_SITES).then(granted => {
    if (granted) toast('Marked can now read the pages you visit. What it reads never leaves your device.');
    return renderSiteAccess();
  }).catch(fail);
}
$('allow-sites').addEventListener('click', allowSites);
$('site-access-later').addEventListener('click', () => {
  $('site-access').hidden = true;
  browser.storage.local.set({ [SITE_ACCESS_ASKED_KEY]: Date.now() }).catch(() => {});
  toast('You can allow it later in Settings → Browsing.');
});
$('site-access-toggle').addEventListener('click', () => {
  if (!siteAccess) { allowSites(); return; }
  browser.permissions.remove(ALL_SITES).then(renderSiteAccess).catch(fail);
});
// Granted or taken back in another Marked page or the browser's own settings.
browser.permissions?.onAdded?.addListener(() => { renderSiteAccess(); });
browser.permissions?.onRemoved?.addListener(() => { renderSiteAccess(); });
renderSiteAccess();
$('note-edit').addEventListener('click', () => { $('note-dialog').close(); if (noteNode) openEditor(noteNode); });
// Enter adds the typed tag instead of submitting the editor.
$('new-tag').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  addEditorTag();
});
$('new-bookmark').addEventListener('click', () => openEditor());
$('open-all').addEventListener('click', async () => {
  const urls = state.visible.filter(node => node.url).map(node => node.url);
  if (urls.length > 10 && !await confirmAction('Open all?', `Open ${urls.length.toLocaleString()} bookmarks in new tabs?`, `Open ${urls.length.toLocaleString()} tabs`)) return;
  for (const url of urls) await browser.tabs.create({ url, active: false }).catch(() => {});
});
// Saves the web pages open in this window to a new folder, to pick the session up later.
let openTabs = [];
$('save-tabs').addEventListener('click', async () => {
  // Other tabs' addresses need access to the pages you visit. Ask while the
  // click still counts as user input; where access is granted this resolves at once.
  const access = browser.permissions?.request?.(ALL_SITES).catch(() => false);
  try {
    const granted = await access;
    const current = await browser.tabs.getCurrent();
    const seen = new Set();
    openTabs = (await browser.tabs.query({ currentWindow: true })).flatMap(tab => {
      const url = safeURL(tab.url);
      if (!url || tab.id === current?.id || seen.has(url)) return [];
      seen.add(url);
      return [{ id: tab.id, url, title: tab.title || url }];
    });
    if (!openTabs.length) { toast(granted === false ? 'Allow Marked on all websites to read your open tabs, then try again.' : 'No web pages are open in this window.'); return; }
    const count = openTabs.length;
    $('tabs-text').textContent = `Save the ${count === 1 ? 'page' : `${count} pages`} open in this window to a new folder in ${path(defaultFolder())}?`;
    $('tabs-save').textContent = `Save ${count} ${count === 1 ? 'tab' : 'tabs'}`;
    $('tabs-close').checked = false;
    $('tabs-error').textContent = '';
    $('tabs-dialog').showModal();
  } catch (error) { fail(error); }
});
$('tabs-form').addEventListener('submit', async event => {
  event.preventDefault();
  const submit = event.submitter; submit.disabled = true;
  try {
    const name = `Tabs · ${new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
    const folder = await library.importTree(openTabs.map(({ url, title }) => ({ url, title })), defaultFolder(), name);
    if (textSettings.keep) await saveTabTexts(folder);
    if ($('tabs-close').checked) await browser.tabs.remove(openTabs.map(tab => tab.id)).catch(() => {});
    $('tabs-dialog').close();
    await load(); navigate(folder.id);
    toast(`Saved ${openTabs.length} ${openTabs.length === 1 ? 'tab' : 'tabs'} to “${name}”.`);
  } catch (error) {
    $('tabs-error').textContent = error.message;
  } finally { submit.disabled = false; }
});
// Four tabs at a time; a tab that can't be read (asleep, or a browser page) is skipped.
async function saveTabTexts(folder) {
  const ids = new Map(folder.children.map(node => [node.url, node.id]));
  const queue = openTabs.filter(tab => ids.has(tab.url) && /^https?:/.test(tab.url) && !tweetId(tab.url));
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const tab = queue.shift();
      const text = await captureTabText(browser, tab.id, tab.url).catch(() => null);
      const saved = text && await library.setText(ids.get(tab.url), { ...text, via: 'tabs' }).catch(() => null);
      if (saved) pageTexts.set(ids.get(tab.url), saved);
    }
  }));
}
$('new-folder').addEventListener('click', () => openEditor(null, true));
$('sidebar-add').addEventListener('click', () => openEditor(null, true));
let searchTimer;
$('search').addEventListener('input', () => {
  // Jev's results belong to the query they answered; any edit returns keyword
  // matches. A request still on its way finishes into the cache.
  if (semantic.status && !semanticShown()) Object.assign(semantic, { query: '', result: null, status: '' });
  clearTimeout(searchTimer); searchTimer = setTimeout(() => { state.selected.clear(); render(); }, 120);
});
$('semantic-toggle').addEventListener('click', () => {
  if (!semanticReady()) {
    // Once the key is saved, the search it was for runs.
    openSettings('semantic', { message: 'Add your TypeSafe API key to search by meaning.', after: () => { if ($('search').value.trim().length >= 3) searchByMeaning(); } });
    return;
  }
  if (semanticShown()) { clearSemantic(); render(); }
  else if ($('search').value.trim().length < 3) toast('Type what you’re looking for, then choose Semantic.');
  else searchByMeaning();
  $('search').focus();
});
$('settings').addEventListener('click', () => openSettings());
for (const tab of settingsTabs()) tab.addEventListener('click', () => showSettingsSection(tab.dataset.section));
// The sidebar is a vertical tab list: the arrow keys, Home, and End move through it.
document.querySelector('.settings-nav').addEventListener('keydown', event => {
  const tabs = settingsTabs(), index = tabs.indexOf(document.activeElement);
  const next = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (index < 0 || next === undefined) return;
  event.preventDefault();
  showSettingsSection(tabs[(next + tabs.length) % tabs.length].dataset.section, true);
});
$('settings-dialog').addEventListener('close', () => { afterKey = null; });
for (const choice of document.querySelectorAll('[data-theme-choice]')) choice.addEventListener('click', () => setTheme(choice.dataset.themeChoice));
applyTheme(readTheme());
darkScheme?.addEventListener('change', () => { if (!document.documentElement.dataset.theme) render(); });
// Another Marked tab changed the theme.
document.defaultView.addEventListener('storage', event => { if (event.key === THEME_KEY) { applyTheme(event.newValue || 'system'); render(); } });
// What each search sends, and preview mode, apply as soon as they change;
// answers Jev gave under the old options are dropped.
for (const [id, option] of [['jev-notes', 'notes'], ['jev-highlights', 'highlights'], ['jev-preview', 'preview']]) {
  $(id).addEventListener('change', () => {
    jev = { ...jev, [option]: $(id).checked };
    saveJev().catch(fail);
    refreshSemantic();
    renderEstimate().catch(() => {});
  });
}
$('browsing-related').addEventListener('change', () => {
  browsing = { ...browsing, related: $('browsing-related').checked };
  browser.storage.local.set({ [BROWSING_KEY]: browsing }).catch(fail);
});
$('text-keep').addEventListener('change', () => {
  textSettings = { ...textSettings, keep: $('text-keep').checked };
  browser.storage.local.set({ [PAGE_TEXT_SETTINGS_KEY]: textSettings }).catch(fail);
});
$('text-download').addEventListener('click', () => downloadTexts().catch(fail));
$('text-stop').addEventListener('click', () => textDownload.controller?.abort());
$('text-clear').addEventListener('click', async () => {
  if (!await confirmAction('Delete all saved text?', 'Search will look through names, addresses, notes, tags, and highlights only. Your bookmarks stay, and Marked keeps the text of pages you save from now on unless you turn that off.', 'Delete text')) return;
  const count = await library.clearTexts();
  pageTexts.clear();
  $('text-status').textContent = `Deleted the text of ${pageCount(count)}.`;
  renderTextSettings();
  render();
});
$('jev-reset').addEventListener('click', async () => {
  jevUsage = { calls: 0, inputTokens: 0, outputTokens: 0, since: Date.now() };
  await browser.storage.local.set({ [JEV_USAGE_KEY]: jevUsage }).catch(fail);
  renderUsage(); renderSemanticStatus();
});
$('jev-remove').addEventListener('click', async () => {
  jev = { ...jev, apiKey: '' };
  await saveJev().catch(fail);
  $('jev-key').value = ''; $('jev-remove').hidden = true;
  $('settings-error').textContent = '';
  $('settings-status').textContent = 'Key removed.';
  refreshSemantic();
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const apiKey = $('jev-key').value.trim();
  $('settings-error').textContent = '';
  if (!apiKey) { $('settings-status').textContent = ''; $('settings-error').textContent = 'Paste your TypeSafe API key first.'; return; }
  if (apiKey === jev.apiKey) { $('settings-status').textContent = 'This key is already saved.'; return; }
  // Ask for access to TypeSafe while the click still counts as user input.
  const access = browser.permissions.request({ origins: JEV_ORIGINS }).catch(() => false);
  const submit = event.submitter || $('settings-form').querySelector('[type=submit]'); submit.disabled = true;
  try {
    if (!await access) throw new Error('Marked needs access to api.typesafe.ai to use Jev.');
    if (!jev.preview) {
      // A tiny request confirms the key before anything depends on it.
      $('settings-status').textContent = 'Checking the key with TypeSafe…';
      await askJev({
        apiKey, state: 'Marked is checking that this API key works.',
        questions: { check: { type: 'noul', instructions: 'Is this text about an API key?' } },
        onUsage: usage => recordJevUsage(browser.storage.local, usage).then(total => { jevUsage = total; renderUsage(); }, () => {})
      });
    }
    jev = { ...jev, apiKey };
    await saveJev();
    $('jev-remove').hidden = false;
    $('settings-status').textContent = 'Key saved. Choose Semantic beside the search box to search by meaning.';
    refreshSemantic();
    const after = afterKey;
    if (after) { $('settings-dialog').close(); after(); }
  } catch (error) {
    $('settings-status').textContent = '';
    $('settings-error').textContent = error.message;
  } finally { submit.disabled = false; }
});
$('sort').addEventListener('change', render);
function setView(mode) {
  view = mode; render();
  browser.storage.local.set({ markedView: mode }).catch(fail);
}
for (const mode of ['list', 'gallery']) $(mode + '-view').addEventListener('click', () => setView(mode));
$('editor').addEventListener('close', () => {
  pendingPreview = null; pendingPreviewURL = null; pendingIcon = null; pendingText = null; pendingCard = null; showEditorPreview();
});
$('select-all').addEventListener('change', () => { state.selected = new Set($('select-all').checked ? state.visible.filter(n => !protectedNode(n)).map(n => n.id) : []); render(); });
$('clear-selection').addEventListener('click', () => { state.selected.clear(); render(); });
$('delete-selected').addEventListener('click', () => removeItems([...state.selected]).catch(fail));
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $(el.dataset.close).close()));
// Key names as this computer shows them.
const MAC = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '');
const KEY = { mod: MAC ? '⌘' : 'Ctrl', alt: MAC ? '⌥' : 'Alt', shift: MAC ? '⇧' : 'Shift' };
function keys(...names) {
  const span = element('span', 'keys');
  for (const name of names) span.append(element('kbd', '', name));
  return span;
}
const SHORTCUTS = [
  [[KEY.mod, 'K'], 'Jump to a bookmark, folder, tag, or command'],
  [['/'], 'Search'],
  [['?'], 'Show these shortcuts'],
  [['esc'], 'Close a dialog'],
  [[KEY.alt, KEY.shift, 'M'], 'Save the page you’re on, from any tab'],
  [[KEY.alt, KEY.shift, 'H'], 'Highlight the text selected on a page'],
  [['mk', 'space'], 'Search Marked from the address bar'],
  [[KEY.mod, '↵'], 'Save a highlight on a page'],
  [[KEY.alt, '↑', '↓'], 'Move a bookmark up or down, in saved order']
];
function showShortcuts() {
  $('shortcuts-list').replaceChildren(...SHORTCUTS.flatMap(([names, what]) => {
    const term = element('dt');
    term.append(keys(...names));
    return [term, element('dd', '', what)];
  }));
  $('shortcuts-dialog').showModal();
}
$('palette-open').replaceChildren(keys(MAC ? '⌘K' : 'Ctrl K'));
$('welcome-tips').replaceChildren(...[
  [[element('b', '', 'Select text')], ' on any page, then choose ', element('b', '', 'Highlight')],
  [[keys(KEY.alt, KEY.shift, 'M')], ' saves the page you’re on'],
  [[keys('mk', 'space')], ' in the address bar searches your library'],
  [[keys(KEY.mod, 'K')], ' jumps to anything here']
].map(([lead, ...rest]) => { const tip = element('li'); tip.append(...lead, ...rest); return tip; }));

// ⌘K or Ctrl+K: jump to any bookmark, folder, or tag, or run a command. Before
// anything is typed, it lists the newest bookmarks and every command.
const palette = { results: [], active: 0 };
function commands() {
  const theme = readTheme();
  return [
    ['Add bookmark', 'new save create page', () => openEditor()],
    ['New folder', 'create', () => openEditor(null, true)],
    ['Save open tabs', 'session window', () => $('save-tabs').click()],
    ['Rediscover', 'random old resurface forgotten', () => showSpecial('rediscover')],
    ['Highlights', 'quotes passages notes colors', () => showSpecial('highlights')],
    ['Continue reading', 'reader progress unfinished', () => showSpecial('continue')],
    ['Find duplicates', 'merge copies dedupe', () => showSpecial('duplicates')],
    [view === 'list' ? 'Show the gallery' : 'Show the list', 'view layout cards previews', () => setView(view === 'list' ? 'gallery' : 'list')],
    ['Import a bookmarks file', 'html json backup restore', () => $('import-file').click()],
    ['Import bookmarks from X', 'twitter tweets posts saved', () => importFromX().catch(fail)],
    ['Import from this browser', 'chrome firefox bookmarks', () => offerBrowserImport({ asked: true }).catch(fail)],
    ['Export bookmarks', 'html download file', exportBookmarks],
    ['Export notes and highlights', 'markdown obsidian notion download', exportNotes],
    ['Download a backup', 'export json move browser restore', () => downloadBackup().catch(fail)],
    ['Open chat', 'ai ask question model', () => $('chat-toggle').click()],
    ['Settings', 'preferences options theme appearance', () => openSettings()],
    ['Page text settings', 'full text download saved copy offline read', () => openSettings('text')],
    ['Semantic search settings', 'jev typesafe api key meaning', () => openSettings('semantic')],
    ...[['dark', 'Use the dark theme'], ['light', 'Use the light theme'], ['system', 'Match the system’s theme']]
      .filter(([value]) => value !== theme).map(([value, label]) => [label, 'appearance night day color mode', () => setTheme(value)]),
    ['Keyboard shortcuts', 'help keys', showShortcuts]
  ].map(([label, keywords, run]) => ({ kind: 'command', label, keywords, run }));
}
function paletteResults(query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  // 3: the name starts with the query; 2: a word in it does; 1: it's in there.
  const score = (label, extra = '') => {
    const name = label.toLowerCase(), more = extra.toLowerCase();
    if (!words.every(word => name.includes(word) || more.includes(word))) return 0;
    if (name.startsWith(words.join(' '))) return 3;
    return name.split(/[^\p{L}\p{N}]+/u).some(part => part.startsWith(words[0])) ? 2 : 1;
  };
  const results = commands().map(command => ({ ...command, score: words.length ? score(command.label, command.keywords) + 0.2 : 1 })).filter(command => command.score >= 1);
  if (!words.length) {
    const newest = [...state.nodes.values()].filter(node => node.url).sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0)).slice(0, 5);
    return [...newest.map(node => ({ kind: 'bookmark', node, label: title(node) })), ...results];
  }
  for (const node of state.nodes.values()) {
    if (node.id === state.root.id || node.type === 'separator') continue;
    const found = isFolder(node) ? score(title(node)) : score(title(node), `${node.url} ${(node.tags || []).join(' ')}`);
    if (found) results.push({ kind: isFolder(node) ? 'folder' : 'bookmark', node, label: title(node), score: found + (isFolder(node) ? 0.1 : 0) });
  }
  for (const tag of state.tags) {
    const found = score(tag);
    if (found) results.push({ kind: 'tag', tag, label: tag, score: found + 0.1 });
  }
  return results.sort((a, b) => b.score - a.score || (b.node?.dateAdded || 0) - (a.node?.dateAdded || 0)).slice(0, 40);
}
function renderPalette() {
  const kinds = { bookmark: 'Open', folder: 'Folder', tag: 'Tag', command: 'Command' };
  // Before anything is typed, the list has two parts: the newest bookmarks and the commands.
  const browsing = !$('palette-input').value.trim();
  let section = '';
  $('palette-list').replaceChildren(...palette.results.flatMap((result, index) => {
    const heading = browsing ? (result.kind === 'command' ? 'Commands' : 'Recent') : '';
    const label = heading && heading !== section ? [element('li', 'palette-section', heading)] : [];
    section = heading;
    if (label.length) label[0].setAttribute('role', 'presentation');
    const item = element('li', 'palette-item');
    item.id = `palette-${index}`;
    item.setAttribute('role', 'option');
    const icon = result.node ? siteIcon(result.node) : element('span', `site-icon ${result.kind}-glyph`, result.kind === 'tag' ? '#' : '›');
    icon.setAttribute('aria-hidden', 'true');
    const text = element('span', 'palette-text');
    text.append(element('span', 'palette-label', result.label));
    const detail = result.kind === 'bookmark' ? displayDomain(result.node.url) : result.kind === 'folder' ? path(result.node.parentId) : '';
    if (detail) text.append(element('span', 'palette-detail', detail));
    item.append(icon, text, element('span', 'palette-kind', kinds[result.kind]));
    item.addEventListener('mousemove', () => { if (palette.active !== index) { palette.active = index; markActive(); } });
    item.addEventListener('click', () => runPalette(index));
    return [...label, item];
  }));
  if (!palette.results.length) $('palette-list').append(element('li', 'palette-empty', 'Nothing matches. Try other words.'));
  markActive();
}
function markActive() {
  for (const item of $('palette-list').querySelectorAll('.palette-item')) item.setAttribute('aria-selected', String(item.id === `palette-${palette.active}`));
  const active = $(`palette-${palette.active}`);
  $('palette-input').setAttribute('aria-activedescendant', active ? active.id : '');
  active?.scrollIntoView?.({ block: 'nearest' });
}
function openPalette() {
  $('palette-input').value = '';
  palette.results = paletteResults('');
  palette.active = 0;
  renderPalette();
  $('palette').showModal();
  $('palette-input').focus();
}
function runPalette(index) {
  const result = palette.results[index];
  if (!result) return;
  $('palette').close();
  if (result.kind === 'bookmark') browser.tabs.create({ url: result.node.url }).catch(fail);
  else if (result.kind === 'folder') navigate(result.node.id);
  else if (result.kind === 'tag') showTag(result.tag);
  else result.run();
}
$('palette-input').addEventListener('input', () => {
  palette.results = paletteResults($('palette-input').value);
  palette.active = 0;
  renderPalette();
});
$('palette-input').addEventListener('keydown', event => {
  const count = palette.results.length;
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && count) {
    event.preventDefault();
    palette.active = (palette.active + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
    markActive();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    runPalette(palette.active);
  }
});
// A click beside the box closes it.
$('palette').addEventListener('click', event => { if (event.target === $('palette')) $('palette').close(); });
$('palette-open').addEventListener('click', () => openPalette());

document.addEventListener('keydown', event => {
  // ⌘K or Ctrl+K opens the palette from anywhere, and closes it again.
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if ($('palette').open) $('palette').close();
    else if (!document.querySelector('dialog[open]')) openPalette();
    return;
  }
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (event.ctrlKey || event.metaKey || event.altKey || typing || document.querySelector('dialog[open]')) return;
  if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  else if (event.key === '?') { event.preventDefault(); showShortcuts(); }
});
let textTimer;
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => load().catch(fail), 200);
  }
  // Page texts the background saved, or another Marked tab.
  const texts = area === 'local' ? Object.keys(changes).filter(key => key.startsWith(TEXT_PREFIX)) : [];
  for (const key of texts) {
    const id = key.slice(TEXT_PREFIX.length);
    if (changes[key].newValue) pageTexts.set(id, changes[key].newValue); else pageTexts.delete(id);
  }
  if (texts.length) {
    relatedIndex = null;
    clearTimeout(textTimer);
    textTimer = setTimeout(() => { render(); if ($('settings-dialog').open) renderTextSettings(); }, 200);
  }
  // Previews come and go with their bookmarks; a change to the library redraws anyway.
  const shots = area === 'local' ? Object.keys(changes).filter(key => key.startsWith(PREVIEW_PREFIX)) : [];
  for (const key of shots) {
    const id = key.slice(PREVIEW_PREFIX.length);
    if (changes[key].newValue) previews.set(id, changes[key].newValue); else previews.delete(id);
  }
  if (shots.length && view === 'gallery' && !changes[STORAGE_KEY]) { clearTimeout(previewTimer); previewTimer = setTimeout(render, 200); }
  if (area === 'local' && changes[PAGE_TEXT_SETTINGS_KEY]) textSettings = { keep: true, ...changes[PAGE_TEXT_SETTINGS_KEY].newValue };
  if (area === 'local' && changes[READING_KEY]) { reading = changes[READING_KEY].newValue || {}; clearTimeout(textTimer); textTimer = setTimeout(render, 200); }
  // Settings and usage changed in another Marked tab.
  if (area === 'local' && changes[JEV_USAGE_KEY]) { jevUsage = changes[JEV_USAGE_KEY].newValue || null; renderSemanticStatus(); }
  // This tab's own saves arrive here too, unchanged, and are skipped.
  const settings = area === 'local' && changes[JEV_SETTINGS_KEY] && { ...JEV_DEFAULTS, ...changes[JEV_SETTINGS_KEY].newValue };
  if (settings && ['apiKey', 'notes', 'highlights', 'preview'].some(key => settings[key] !== jev[key])) { jev = settings; refreshSemantic(); }
});
Promise.all([load(), browser.storage.local.get(['markedView', JEV_SETTINGS_KEY, JEV_USAGE_KEY, PAGE_TEXT_SETTINGS_KEY, READING_KEY, RELATED_KEY, BROWSING_KEY]).then(saved => {
  reading = saved[READING_KEY] || {};
  storedRelated = saved[RELATED_KEY] ? JSON.stringify([saved[RELATED_KEY].n, saved[RELATED_KEY].docs]) : '';
  browsing = { related: true, ...saved[BROWSING_KEY] };
  view = saved.markedView === 'gallery' ? 'gallery' : 'list';
  jev = { ...jev, ...(saved[JEV_SETTINGS_KEY] || {}) };
  jevUsage = saved[JEV_USAGE_KEY] || null;
  textSettings = { keep: true, ...(saved[PAGE_TEXT_SETTINGS_KEY] || {}) };
})]).then(async () => {
  // The library's first render is already on screen, unless it chose another view.
  if (shown.context?.view !== view) render();
  askFirstImport();
  const previewsLoaded = loadPreviews().catch(fail);
  // With the texts in, the Marked button and the reader get an up-to-date index.
  loadTexts().then(() => setTimeout(buildRelatedIndexLater, 1000)).catch(fail);
  const params = new URLSearchParams(document.location.search);
  if (!['add', 'edit', 'q', 'folder', 'related'].some(key => params.has(key))) return;
  // Consume the request so refreshing the tab does not repeat it.
  document.defaultView.history.replaceState(null, '', document.location.pathname);
  // A search typed after "mk" in the address bar.
  if (params.has('q')) { $('search').value = params.get('q'); render(); return; }
  // The Marked button asked what's related to the page it was on.
  if (params.has('related')) {
    const page = await readCapture(params.get('related'));
    if (page?.url) { await loadTexts(); showRelated({ page }); } else toast('That page is no longer open.');
    return;
  }
  // A folder to show, such as the one an import filled.
  if (params.has('folder')) { if (isFolder(state.nodes.get(params.get('folder')))) navigate(params.get('folder')); return; }
  // Add to Marked on a page that's already saved edits its bookmark.
  if (params.has('edit')) {
    // The editor shows the bookmark's preview.
    await previewsLoaded;
    const node = state.nodes.get(params.get('edit'));
    if (node?.url) openEditor(node); else toast('This bookmark is no longer in Marked.');
    return;
  }
  const url = safeURL(params.get('add'));
  if (!url) { toast('This page URL cannot be bookmarked.'); return; }
  openEditor();
  $('edit-name').value = params.get('title') || url;
  $('edit-url').value = url;
  // Captures are optional; the bookmark can still be saved without one.
  const capture = await readCapture(params.get('capture'));
  if ($('editor').open && capture?.url === url) {
    if (validPreview(capture.preview)) { pendingPreview = capture.preview; pendingPreviewURL = url; showEditorPreview(); }
    if (validIcon(capture.icon)) { pendingIcon = capture.icon; pendingPreviewURL = url; }
    const text = cleanPageText(capture.text);
    if (text?.text) { pendingText = text; pendingPreviewURL = url; }
    const card = cleanCard(capture.card);
    if (card) { pendingCard = card; pendingPreviewURL = url; }
    // Don't overwrite anything typed while the capture was loading.
    const abstract = cleanAbstract(capture.abstract);
    if (abstract && !$('edit-abstract').value) $('edit-abstract').value = abstract;
    pendingHighlight = cleanHighlightText(capture.highlight);
    if (pendingHighlight) {
      $('edit-highlight').textContent = pendingHighlight;
      $('highlight-field').hidden = false;
      renderEditorColors();
    }
  }
  await suggestEditorTags(true);
}).catch(fail);
