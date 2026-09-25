import './browser-api.js';
import { safeURL, cleanAbstract, cleanNote, cleanTag, cleanTags, cleanHighlightText, exportHTML, exportMarkdown, parseHTML, parseJSON, planBrowserImport, pageIdentity, tweetId, validIcon, monogram } from './bookmarks.js';
import { exportBackup, parseBackup } from './backup.js';
import { createLibraryStore, STORAGE_KEY, TEXT_PREFIX } from './store.js';
import { captureTabText, cleanPageText, fetchPageText, passageAround, readingMinutes, searchTerms, PAGE_TEXT_SETTINGS_KEY } from './page-text.js';
import { relativeAge } from './time.js';
import { suggestTags, chooseTags } from './tagger.js';
import { askJev, recordJevUsage, jevCost, estimateJevTokens, formatCost, JEV_ORIGINS, JEV_SETTINGS_KEY, JEV_USAGE_KEY } from './jev.js';
import { bookmarkLine, semanticSearch, semanticMatches } from './semantic-search.js';
const library = createLibraryStore(browser);

const $ = id => document.getElementById(id);
// special is 'rediscover' or 'duplicates' while one of those views is open.
const state = { root: null, nodes: new Map(), folder: null, tag: null, special: null, rediscover: [], tags: [], selected: new Set(), expanded: new Set(), visible: [], editing: null };
let toastTimer, refreshTimer, loadVersion = 0;
let view = 'list';
let pendingPreview = null;
let pendingPreviewURL = null;
// The site's icon, when it came with the page from Add to Marked.
let pendingIcon = null;
// Tags chosen in the open editor; suggestions never override the user's own picks.
let editorTags = [], tagsTouched = false, editorSession = 0;
let pendingHighlight = '';
// The page's text, when it came with the page from Add to Marked.
let pendingText = null;
// Saved page texts by bookmark id, read after the library; search looks through them.
const pageTexts = new Map();
let textSettings = { keep: true };
// Semantic search with the user's own Jev key. Jev is asked only when the user
// chooses Semantic, never while typing.
// preview is temporary: it works without a key and logs requests instead of sending them.
let jev = { apiKey: '', notes: true, highlights: true, preview: false };
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
  el.addEventListener('click', action);
  return el;
}
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
  path.setAttribute('d', kind === 'trash'
    ? 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7'
    : 'M14 5l5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z');
  svg.append(path);
  el.append(svg);
  return el;
}
function toast(message, undo = null) {
  clearTimeout(toastTimer);
  const notice = $('toast');
  notice.replaceChildren(element('span', '', message));
  notice.hidden = false;
  if (undo) {
    const undoButton = button('Undo', async () => {
      undoButton.disabled = true;
      try {
        await undo();
        toast('Restored to Marked.');
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
  const texts = await library.getTexts([...state.nodes.values()].filter(node => node.url).map(node => node.id));
  pageTexts.clear();
  for (const [id, text] of Object.entries(texts)) pageTexts.set(id, text);
  render();
  if ($('settings-dialog').open) renderTextSettings();
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
// Bookmarks for the same page, grouped, oldest first in each group.
function findDuplicates() {
  const groups = new Map();
  for (const node of state.nodes.values()) {
    if (!node.url) continue;
    const key = pageIdentity(node.url);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }
  return [...groups.values()].filter(group => group.length > 1).map(group => group.sort((a, b) => (a.dateAdded || 0) - (b.dateAdded || 0)));
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
  renderTree();
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
    : tag ? [...state.nodes.values()].filter(n => n.url && n.tags?.some(t => sameTag(t, tag)))
    : current ? [...(current.children || [])].filter(n => n.type !== 'separator') : [...state.nodes.values()].filter(n => n.url);
  const sort = $('sort').value;
  if (sort !== 'default' && !special) nodes.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || (sort === 'title' ? title(a).localeCompare(title(b)) : (b.dateAdded || 0) - (a.dateAdded || 0)));
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
  const specialTitle = { rediscover: 'Rediscover', duplicates: 'Duplicates' }[special];
  $('page-title').textContent = query ? 'Search results' : specialTitle || tag || (current ? title(current) : 'All bookmarks');
  $('breadcrumbs').replaceChildren(button('Library', () => navigate(null)));
  if (tag) $('breadcrumbs').append(element('span', '', '/'), element('span', '', 'Tags'));
  $('shuffle').hidden = special !== 'rediscover' || !nodes.length;
  $('merge-all').hidden = special !== 'duplicates' || !copies;
  $('view-note').hidden = !special || !nodes.length;
  $('view-note').textContent = special === 'rediscover' ? 'A few things you saved a while ago, picked at random. The ones with notes and highlights come up more often.'
    : `${duplicates.length.toLocaleString()} ${duplicates.length === 1 ? 'page is' : 'pages are'} saved more than once. Merging keeps the oldest bookmark with every tag, note, and highlight.`;
  if (current) for (const node of ancestors(current.id)) $('breadcrumbs').append(element('span', '', '/'), button(title(node), () => navigate(node.id)));
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    const row = element('tr', state.selected.has(node.id) ? 'selected' : '');
    const group = groupStarts.get(node.id);
    if (group) row.classList.add('group-start');
    const checkCell = element('td', 'check-cell');
    const check = element('input'); check.type = 'checkbox'; check.checked = state.selected.has(node.id); check.disabled = protectedNode(node);
    check.setAttribute('aria-label', `Select ${title(node)}`);
    check.addEventListener('change', () => { if (check.checked) state.selected.add(node.id); else state.selected.delete(node.id); row.classList.toggle('selected', check.checked); renderSelection(); });
    checkCell.append(check);
    const nameCell = element('td');
    const main = element('div', 'item-main');
    const text = element('div', 'item-text');
    let link;
    if (isFolder(node)) link = button(title(node), () => navigate(node.id), 'item-title');
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
    if (page?.text) details.append(button(`${readingMinutes(page.words)} min read`, () => showText(node), 'item-read', `Read the text saved from ${title(node)}`));
    // Tags and the note marker share one line. Gallery cards keep the line even
    // when empty so page cards are the same height; X posts show the note itself.
    const labels = element('span', 'item-tags');
    for (const tag of node.tags || []) labels.append(button(tag, () => showTag(tag), 'tag', `Show bookmarks tagged ${tag}`));
    if (node.note) labels.append(button('Note', () => showNote(node), 'note-chip', `Show the note on ${title(node)}`));
    const highlights = node.highlights?.length;
    if (highlights) labels.append(button(`${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}`, () => showHighlights(node.id), 'highlight-chip', `Show highlights on ${title(node)}`));
    if (group) labels.append(button(`Merge ${group.length} copies`, () => mergeGroups([group]).catch(fail), 'merge-chip', `Merge the ${group.length} bookmarks for ${displayDomain(node.url)}`));
    if (!isFolder(node)) details.append(labels);
    metadata.append(domain, details);
    text.append(link, metadata);
    const passage = passages.get(node.id);
    if (passage) {
      const quote = element('button', 'item-passage');
      quote.type = 'button';
      quote.title = 'Show this in the saved text';
      markText(quote, `${passage.cutBefore ? '…' : ''}${passage.text}${passage.cutAfter ? '…' : ''}`, { terms });
      quote.addEventListener('click', () => showText(node, terms));
      text.append(quote);
    }
    if (node.note) {
      const note = element('p', 'item-note', node.note);
      note.title = node.note;
      text.append(note);
    }
    const preview = element('div', 'card-preview');
    const tweet = view === 'gallery' && !isFolder(node) ? tweetId(node.url) : null;
    // Only the gallery shows X's embed, so the list view never contacts X.
    if (tweet) {
      row.classList.add('tweet-row');
      preview.classList.add('tweet');
      preview.append(tweetEmbed(tweet));
    } else if (validPreview(node.preview)) {
      const image = element('img'); image.src = node.preview; image.alt = ''; image.loading = 'lazy';
      preview.append(image);
    } else {
      // Without a screenshot, a card shows the site's icon or its letter on the site's color.
      const tile = siteIcon(node, true);
      preview.classList.add(isFolder(node) ? 'folder-preview' : tile.classList.contains('image') ? 'icon-preview' : 'letter-preview');
      if (tile.style.getPropertyValue('--hue')) preview.style.setProperty('--hue', tile.style.getPropertyValue('--hue'));
      preview.append(tile);
    }
    main.append(preview, siteIcon(node), text); nameCell.append(main);
    const location = element('td', 'item-location', path(node.parentId)); location.title = path(node.parentId);
    const actions = element('td', 'row-actions');
    if (!protectedNode(node)) actions.append(iconButton('pencil', () => openEditor(node), 'item-action', `Edit ${title(node)}`), iconButton('trash', () => removeItems([node.id]).catch(fail), 'item-action', `Delete ${title(node)}`));
    row.append(checkCell, nameCell);
    if (showLocation) row.append(location);
    row.append(actions); fragment.append(row);
  }
  $('items').replaceChildren(fragment);
  document.querySelector('.table-wrap').hidden = nodes.length === 0;
  $('empty').hidden = nodes.length > 0;
  // An empty library greets you with ways to fill it.
  const welcome = !query && !special && !tag && !current && !nodes.length;
  $('welcome').hidden = !welcome;
  $('empty').classList.toggle('welcoming', welcome);
  document.querySelector('.list-toolbar').hidden = welcome;
  $('empty').querySelector('h2').textContent = welcome ? 'Welcome to Marked' : query ? 'No bookmarks found' : special === 'rediscover' ? 'Nothing to rediscover yet' : special === 'duplicates' ? 'No duplicates' : tag ? 'No bookmarks with this tag' : 'No bookmarks yet';
  $('empty').querySelector('p').textContent = welcome ? 'Bring in the bookmarks you already have, or save the page you’re reading.' : query ? 'Try other words. Search looks through names, addresses, folders, notes, tags, highlights, and the text of saved pages.' : special === 'rediscover' ? 'Bookmarks you saved a while ago show up here.' : special === 'duplicates' ? 'Every page is saved just once.' : tag ? 'Add it to a bookmark with Edit.' : 'Add a bookmark or import your saved collection.';
  renderSemanticStatus();
  $('list-label').textContent = `${nodes.length.toLocaleString()} ${nodes.length === 1 ? 'item' : 'items'}`;
  renderSelection();
}
// Bookmarks and folders with every search term in their details or, for a
// bookmark, in its saved page text; passages gets the text around the first
// term only the page has.
function searchLibrary(terms, passages) {
  const highlightText = node => (node.highlights || []).map(h => `${h.text} ${h.note || ''}`).join(' ');
  return [...state.nodes.values()].filter(node => {
    if (node.id === state.root.id || node.type === 'separator') return false;
    const details = `${title(node)} ${node.url || ''} ${path(node.parentId)} ${node.abstract || ''} ${node.note || ''} ${(node.tags || []).join(' ')} ${highlightText(node)}`.toLowerCase();
    const missing = terms.filter(term => !details.includes(term));
    if (!missing.length) return true;
    const page = node.url && pageTexts.get(node.id);
    if (!page?.text) return false;
    page.lower ??= page.text.toLowerCase();
    if (!missing.every(term => page.lower.includes(term))) return false;
    passages.set(node.id, passageAround(page.text, page.lower, missing[0]));
    return true;
  });
}
// Appends text to parent, marking the passages the user highlighted and the
// words searched for.
function markText(parent, text, { terms = [], highlights = [] } = {}) {
  const ranges = [];
  for (const passage of highlights) {
    const at = text.indexOf(passage);
    if (passage && at >= 0) ranges.push([at, at + passage.length, 'passage']);
  }
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    for (const term of terms) for (let at = lower.indexOf(term); term && at >= 0; at = lower.indexOf(term, at + term.length)) ranges.push([at, at + term.length, 'term']);
  }
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let cursor = 0;
  for (const [start, end, kind] of ranges) {
    if (start < cursor) continue;
    if (start > cursor) parent.append(text.slice(cursor, start));
    parent.append(element('mark', kind, text.slice(start, end)));
    cursor = end;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}
// The text saved from a bookmark's page, with the user's highlights marked and,
// when it's opened from a search, the words searched for, scrolled into view.
let textNode = null;
function showText(node, terms = []) {
  const page = pageTexts.get(node.id);
  if (!page?.text) return;
  textNode = node;
  $('text-title').textContent = title(node);
  const saved = new Date(page.capturedAt).toLocaleDateString([], { dateStyle: 'medium' });
  $('text-meta').textContent = [displayDomain(node.url), page.byline, `${readingMinutes(page.words)} min read`, `saved ${saved}`].filter(Boolean).join(' · ');
  $('text-truncated').hidden = !page.truncated;
  const highlights = (node.highlights || []).map(highlight => highlight.text);
  $('text-body').replaceChildren(...page.text.split('\n\n').map(paragraph => {
    const block = element('p');
    markText(block, paragraph, { terms, highlights });
    return block;
  }));
  const url = safeURL(node.url);
  $('text-open').hidden = !url;
  if (url) $('text-open').href = url;
  $('text-dialog').showModal();
  $('text-body').scrollTop = 0;
  $('text-body').querySelector('mark.term')?.scrollIntoView?.({ block: 'center' });
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
    const item = element('li');
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
function textsMissing() {
  return [...state.nodes.values()].filter(node => node.url && downloadable(node) && !pageTexts.get(node.id)?.text);
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
// Readability, for reading the pages Marked downloads. A plain script that
// defines Readability as a global, just as pages get it when Marked reads them.
let readabilityLoading = null;
function loadReadability() {
  if (typeof globalThis.Readability === 'function') return Promise.resolve();
  return readabilityLoading ??= new Promise((resolve, reject) => {
    const script = element('script');
    script.src = 'vendor/readability.js';
    script.onload = () => resolve();
    script.onerror = () => { readabilityLoading = null; script.remove(); reject(new Error('Marked’s page reader is missing. Run npm run bundle, then reload Marked.')); };
    document.head.append(script);
  });
}
async function downloadTexts() {
  // Reading other sites needs access to them. Ask while the click still counts
  // as user input; without one, go ahead if access was already given.
  const sites = { origins: ['<all_urls>'] };
  const access = browser.permissions?.request?.(sites).catch(() => browser.permissions.contains(sites)).catch(() => false);
  const targets = textsMissing();
  if (!targets.length || textDownload.controller) return;
  if (await access === false) { $('text-status').textContent = 'Allow Marked on all websites to download pages, then try again.'; return; }
  const controller = textDownload.controller = new AbortController();
  Object.assign(textDownload, { done: 0, total: targets.length });
  let saved = 0, failed = 0;
  renderTextSettings();
  try {
    await loadReadability();
    const queue = [...targets];
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (queue.length && !controller.signal.aborted) {
        const node = queue.shift();
        let text;
        try { text = { ...await fetchPageText(node.url, { signal: controller.signal }), via: 'download' }; }
        catch (error) {
          if (controller.signal.aborted) return;
          text = { error: error.message, via: 'download' };
        }
        const stored = await library.setText(node.id, text, { replace: false }).catch(() => null);
        if (stored) pageTexts.set(node.id, stored);
        if (stored?.text) saved++; else failed++;
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
    renderTextSettings();
    render();
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
  pendingPreview = validPreview(node?.preview) ? node.preview : null;
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
  pendingHighlight = ''; $('highlight-field').hidden = true; $('edit-highlight-note').value = '';
  fillFolders($('edit-parent'), new Set(node ? [node.id] : []), node?.parentId || defaultFolder());
  $('editor').showModal(); $('edit-name').focus();
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
    if (pendingHighlight && !state.editing) changes.highlights = [{ text: pendingHighlight, note: $('edit-highlight-note').value }];
    if (pendingIcon && !state.editing && url === pendingPreviewURL) changes.icon = pendingIcon;
    const parentId = $('edit-parent').value;
    if (state.editing) {
      await library.update(state.editing.id, changes, parentId);
    } else {
      const created = await library.create({ ...changes, parentId, type: folder ? 'folder' : 'bookmark' });
      if (pendingText && url === pendingPreviewURL && textSettings.keep) {
        const saved = await library.setText(created.id, { ...pendingText, via: 'page' }).catch(() => null);
        if (saved) pageTexts.set(created.id, saved);
      }
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
  const texts = await library.getTexts([...state.nodes.values()].filter(node => node.url).map(node => node.id));
  download(exportBackup(state.root, texts), 'application/json', 'marked-backup', 'json');
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
// The menu opens under Export, lined up with its right edge; popovers
// otherwise sit in the middle of the page.
$('export-menu').addEventListener('toggle', event => {
  if (event.newState !== 'open') return;
  const anchor = $('export').getBoundingClientRect(), menu = $('export-menu');
  menu.style.top = `${anchor.bottom + 8}px`;
  menu.style.left = `${Math.max(8, Math.min(anchor.right - menu.offsetWidth, document.defaultView.innerWidth - menu.offsetWidth - 8))}px`;
});
$('import').addEventListener('click', () => $('import-file').click());
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
// Firefox may leave content-script sites ungranted; the Highlight button needs all of them.
const ALL_SITES = ['http://*/*', 'https://*/*'];
$('allow-sites').addEventListener('click', async () => {
  try { if (await browser.permissions.request({ origins: ALL_SITES })) $('site-access').hidden = true; } catch (error) { fail(error); }
});
browser.permissions?.contains?.({ origins: ALL_SITES }).then(granted => { $('site-access').hidden = granted; }, () => {});
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
  // Firefox shows other tabs' addresses only with site access. Ask while the
  // click still counts as user input; where access is granted this resolves at once.
  const access = browser.permissions?.request?.({ origins: ['<all_urls>'] }).catch(() => false);
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
  pendingPreview = null; pendingPreviewURL = null; pendingIcon = null; pendingText = null; showEditorPreview();
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
  [['mk', 'space'], 'Search Marked from the address bar'],
  [[KEY.mod, '↵'], 'Save a highlight on a page']
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
    ['Find duplicates', 'merge copies dedupe', () => showSpecial('duplicates')],
    [view === 'list' ? 'Show the gallery' : 'Show the list', 'view layout cards previews', () => setView(view === 'list' ? 'gallery' : 'list')],
    ['Import a bookmarks file', 'html json backup restore', () => $('import').click()],
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
    clearTimeout(textTimer);
    textTimer = setTimeout(() => { render(); if ($('settings-dialog').open) renderTextSettings(); }, 200);
  }
  if (area === 'local' && changes[PAGE_TEXT_SETTINGS_KEY]) textSettings = { keep: true, ...changes[PAGE_TEXT_SETTINGS_KEY].newValue };
  // Settings and usage changed in another Marked tab.
  if (area === 'local' && changes[JEV_USAGE_KEY]) { jevUsage = changes[JEV_USAGE_KEY].newValue || null; renderSemanticStatus(); }
  // This tab's own saves arrive here too, unchanged, and are skipped.
  const settings = area === 'local' && changes[JEV_SETTINGS_KEY] && { apiKey: '', notes: true, highlights: true, preview: false, ...changes[JEV_SETTINGS_KEY].newValue };
  if (settings && ['apiKey', 'notes', 'highlights', 'preview'].some(key => settings[key] !== jev[key])) { jev = settings; refreshSemantic(); }
});
Promise.all([load(), browser.storage.local.get(['markedView', JEV_SETTINGS_KEY, JEV_USAGE_KEY, PAGE_TEXT_SETTINGS_KEY]).then(saved => {
  view = saved.markedView === 'gallery' ? 'gallery' : 'list';
  jev = { ...jev, ...(saved[JEV_SETTINGS_KEY] || {}) };
  jevUsage = saved[JEV_USAGE_KEY] || null;
  textSettings = { keep: true, ...(saved[PAGE_TEXT_SETTINGS_KEY] || {}) };
})]).then(async () => {
  render();
  askFirstImport();
  loadTexts().catch(fail);
  const params = new URLSearchParams(document.location.search);
  if (!['add', 'edit', 'q'].some(key => params.has(key))) return;
  // Consume the request so refreshing the tab does not repeat it.
  document.defaultView.history.replaceState(null, '', document.location.pathname);
  // A search typed after "mk" in the address bar.
  if (params.has('q')) { $('search').value = params.get('q'); render(); return; }
  // Add to Marked on a page that's already saved edits its bookmark.
  if (params.has('edit')) {
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
    // Don't overwrite anything typed while the capture was loading.
    const abstract = cleanAbstract(capture.abstract);
    if (abstract && !$('edit-abstract').value) $('edit-abstract').value = abstract;
    pendingHighlight = cleanHighlightText(capture.highlight);
    if (pendingHighlight) {
      $('edit-highlight').textContent = pendingHighlight;
      $('highlight-field').hidden = false;
    }
  }
  await suggestEditorTags(true);
}).catch(fail);
