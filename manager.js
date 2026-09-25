import './browser-api.js';
import { safeURL, cleanAbstract, cleanNote, cleanTag, cleanTags, cleanHighlightText, exportHTML, parseHTML, parseJSON, planBrowserImport, tweetId } from './bookmarks.js';
import { exportBackup, parseBackup } from './backup.js';
import { createLibraryStore, STORAGE_KEY } from './store.js';
import { relativeAge } from './time.js';
import { suggestTags, chooseTags } from './tagger.js';
import { askJev, recordJevUsage, jevCost, estimateJevTokens, formatCost, JEV_ORIGINS, JEV_SETTINGS_KEY, JEV_USAGE_KEY } from './jev.js';
import { bookmarkLine, semanticSearch, semanticMatches } from './semantic-search.js';
const library = createLibraryStore(browser);

const $ = id => document.getElementById(id);
const state = { root: null, nodes: new Map(), folder: null, tag: null, tags: [], selected: new Set(), expanded: new Set(), visible: [], editing: null };
let toastTimer, refreshTimer, loadVersion = 0;
let view = 'list';
let pendingPreview = null;
let pendingPreviewURL = null;
// Tags chosen in the open editor; suggestions never override the user's own picks.
let editorTags = [], tagsTouched = false, editorSession = 0;
let pendingHighlight = '';
// Semantic search with the user's own Jev key. Jev is asked only when the user
// chooses Semantic, never while typing.
// preview is temporary: it works without a key and logs requests instead of sending them.
let jev = { apiKey: '', notes: true, highlights: true, preview: false };
let jevUsage = null;
const semantic = { query: '', result: null, status: '', error: '', cost: 0, cached: false, controller: null, cache: new Map() };
const semanticReady = () => !!jev.apiKey || jev.preview;
// Whether the results are Jev's answer for what's in the search box.
const semanticShown = () => !!semantic.status && semantic.query.toLowerCase() === $('search').value.trim().toLowerCase();
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
function navigate(id) {
  state.folder = id;
  state.tag = null;
  state.selected.clear();
  $('search').value = '';
  if (id) ancestors(id).forEach(node => state.expanded.add(node.id));
  render();
}
function showTag(tag) {
  state.tag = tag;
  state.folder = null;
  state.selected.clear();
  $('search').value = '';
  render();
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
  $('all-bookmarks').classList.toggle('active', !state.folder && !state.tag);
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
  const highlightText = node => (node.highlights || []).map(h => `${h.text} ${h.note || ''}`).join(' ');
  let nodes = query ? [...state.nodes.values()].filter(node => node.id !== state.root.id && node.type !== 'separator' && `${title(node)} ${node.url || ''} ${path(node.parentId)} ${node.abstract || ''} ${node.note || ''} ${(node.tags || []).join(' ')} ${highlightText(node)}`.toLowerCase().includes(query))
    : tag ? [...state.nodes.values()].filter(n => n.url && n.tags?.some(t => sameTag(t, tag)))
    : current ? [...(current.children || [])].filter(n => n.type !== 'separator') : [...state.nodes.values()].filter(n => n.url);
  const sort = $('sort').value;
  if (sort !== 'default') nodes.sort((a, b) => Number(isFolder(b)) - Number(isFolder(a)) || (sort === 'title' ? title(a).localeCompare(title(b)) : (b.dateAdded || 0) - (a.dateAdded || 0)));
  // Jev's matches lead, most relevant first; the remaining keyword matches follow.
  if (query && semantic.result && semantic.query.toLowerCase() === query) {
    const lead = semanticMatches(semantic.result.ranked).map(match => state.nodes.get(match.id)).filter(Boolean);
    const ids = new Set(lead.map(node => node.id));
    nodes = [...lead, ...nodes.filter(node => !ids.has(node.id))];
  }
  state.visible = nodes;
  const visibleIds = new Set(nodes.map(n => n.id));
  for (const id of state.selected) if (!visibleIds.has(id)) state.selected.delete(id);
  $('page-title').textContent = query ? 'Search results' : tag || (current ? title(current) : 'All bookmarks');
  $('breadcrumbs').replaceChildren(button('Library', () => navigate(null)));
  if (tag) $('breadcrumbs').append(element('span', '', '/'), element('span', '', 'Tags'));
  if (current) for (const node of ancestors(current.id)) $('breadcrumbs').append(element('span', '', '/'), button(title(node), () => navigate(node.id)));
  const fragment = document.createDocumentFragment();
  for (const node of nodes) {
    const row = element('tr', state.selected.has(node.id) ? 'selected' : '');
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
    // Tags and the note marker share one line. Gallery cards keep the line even
    // when empty so page cards are the same height; X posts show the note itself.
    const labels = element('span', 'item-tags');
    for (const tag of node.tags || []) labels.append(button(tag, () => showTag(tag), 'tag', `Show bookmarks tagged ${tag}`));
    if (node.note) labels.append(button('Note', () => showNote(node), 'note-chip', `Show the note on ${title(node)}`));
    const highlights = node.highlights?.length;
    if (highlights) labels.append(button(`${highlights} ${highlights === 1 ? 'highlight' : 'highlights'}`, () => showHighlights(node.id), 'highlight-chip', `Show highlights on ${title(node)}`));
    if (!isFolder(node)) details.append(labels);
    metadata.append(domain, details);
    text.append(link, metadata);
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
    } else preview.append(element('span', '', isFolder(node) ? 'Folder' : 'No preview'));
    main.append(preview, text); nameCell.append(main);
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
  $('empty').querySelector('h2').textContent = query ? 'No bookmarks found' : tag ? 'No bookmarks with this tag' : 'No bookmarks yet';
  $('empty').querySelector('p').textContent = query ? 'Try another name, URL, folder, note, or tag.' : tag ? 'Add it to a bookmark with Edit.' : 'Add a bookmark or import your saved collection.';
  renderSemanticStatus();
  $('list-label').textContent = `${nodes.length.toLocaleString()} ${nodes.length === 1 ? 'item' : 'items'}`;
  renderSelection();
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
  frame.src = `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true`;
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
function openSettings(message = '') {
  $('jev-key').value = jev.apiKey;
  $('jev-notes').checked = jev.notes;
  $('jev-highlights').checked = jev.highlights;
  $('jev-preview').checked = jev.preview;
  $('jev-remove').hidden = !jev.apiKey;
  $('settings-status').textContent = message;
  $('settings-error').textContent = '';
  renderUsage();
  renderEstimate();
  $('settings-dialog').showModal();
  if (!jev.apiKey) $('jev-key').focus();
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
    const parentId = $('edit-parent').value;
    if (state.editing) {
      await library.update(state.editing.id, changes, parentId);
    } else await library.create({ ...changes, parentId, type: folder ? 'folder' : 'bookmark' });
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
$('export').addEventListener('click', () => {
  download(exportHTML(state.root), 'text/html;charset=utf-8', 'marked-bookmarks', 'html');
  toast('Exported your complete bookmark collection.');
});
// Each browser keeps its own Marked library. A backup keeps dates and previews,
// which HTML exports drop, so a library can move between Firefox and Chrome.
$('backup').addEventListener('click', () => {
  download(exportBackup(state.root), 'application/json', 'marked-backup', 'json');
  toast('Backup downloaded. Import it into Marked in another browser to move your library.');
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
browserName.then(name => { $('browser-import-open').textContent = `Import from ${name}…`; });
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
  if (!semanticReady()) { openSettings('Add your TypeSafe API key to search by meaning.'); return; }
  if (semanticShown()) { clearSemantic(); render(); }
  else if ($('search').value.trim().length < 3) toast('Type what you’re looking for, then choose Semantic.');
  else searchByMeaning();
  $('search').focus();
});
$('settings').addEventListener('click', () => openSettings());
for (const id of ['jev-notes', 'jev-highlights']) $(id).addEventListener('change', renderEstimate);
$('jev-reset').addEventListener('click', async () => {
  jevUsage = { calls: 0, inputTokens: 0, outputTokens: 0, since: Date.now() };
  await browser.storage.local.set({ [JEV_USAGE_KEY]: jevUsage }).catch(fail);
  renderUsage(); renderSemanticStatus();
});
$('jev-remove').addEventListener('click', async () => {
  jev = { ...jev, apiKey: '' };
  await saveJev().catch(fail);
  $('settings-dialog').close(); refreshSemantic();
});
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const apiKey = $('jev-key').value.trim();
  const preview = $('jev-preview').checked;
  const newKey = !!apiKey && apiKey !== jev.apiKey;
  // Ask for access to TypeSafe while the click still counts as user input.
  const access = newKey ? browser.permissions.request({ origins: JEV_ORIGINS }).catch(() => false) : Promise.resolve(true);
  const submit = event.submitter; submit.disabled = true;
  $('settings-error').textContent = '';
  try {
    if (!await access) throw new Error('Marked needs access to api.typesafe.ai to use Jev.');
    if (newKey && !preview) {
      // A tiny request confirms the key before anything depends on it.
      $('settings-status').textContent = 'Checking the key with TypeSafe…';
      await askJev({
        apiKey, state: 'Marked is checking that this API key works.',
        questions: { check: { type: 'noul', instructions: 'Is this text about an API key?' } },
        onUsage: usage => recordJevUsage(browser.storage.local, usage).then(total => { jevUsage = total; renderUsage(); }, () => {})
      });
    }
    jev = { apiKey, notes: $('jev-notes').checked, highlights: $('jev-highlights').checked, preview };
    await saveJev();
    $('settings-dialog').close();
    refreshSemantic();
  } catch (error) {
    $('settings-status').textContent = '';
    $('settings-error').textContent = error.message;
  } finally { submit.disabled = false; }
});
$('sort').addEventListener('change', render);
for (const mode of ['list', 'gallery']) $(mode + '-view').addEventListener('click', () => {
  view = mode; render();
  browser.storage.local.set({ markedView: mode }).catch(fail);
});
$('editor').addEventListener('close', () => {
  pendingPreview = null; pendingPreviewURL = null; showEditorPreview();
});
$('select-all').addEventListener('change', () => { state.selected = new Set($('select-all').checked ? state.visible.filter(n => !protectedNode(n)).map(n => n.id) : []); render(); });
$('clear-selection').addEventListener('click', () => { state.selected.clear(); render(); });
$('delete-selected').addEventListener('click', () => removeItems([...state.selected]).catch(fail));
document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $(el.dataset.close).close()));
document.addEventListener('keydown', event => {
  if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !document.querySelector('dialog[open]') && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); $('search').focus(); }
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => load().catch(fail), 200);
  }
  // Settings and usage changed in another Marked tab.
  if (area === 'local' && changes[JEV_USAGE_KEY]) { jevUsage = changes[JEV_USAGE_KEY].newValue || null; renderSemanticStatus(); }
  // This tab's own saves arrive here too, unchanged, and are skipped.
  const settings = area === 'local' && changes[JEV_SETTINGS_KEY] && { apiKey: '', notes: true, highlights: true, preview: false, ...changes[JEV_SETTINGS_KEY].newValue };
  if (settings && ['apiKey', 'notes', 'highlights', 'preview'].some(key => settings[key] !== jev[key])) { jev = settings; refreshSemantic(); }
});
Promise.all([load(), browser.storage.local.get(['markedView', JEV_SETTINGS_KEY, JEV_USAGE_KEY]).then(saved => {
  view = saved.markedView === 'gallery' ? 'gallery' : 'list';
  jev = { ...jev, ...(saved[JEV_SETTINGS_KEY] || {}) };
  jevUsage = saved[JEV_USAGE_KEY] || null;
})]).then(async () => {
  render();
  askFirstImport();
  const params = new URLSearchParams(document.location.search);
  if (!params.has('add')) return;
  // Consume the request so refreshing the tab does not reopen the dialog.
  document.defaultView.history.replaceState(null, '', document.location.pathname);
  const url = safeURL(params.get('add'));
  if (!url) { toast('This page URL cannot be bookmarked.'); return; }
  openEditor();
  $('edit-name').value = params.get('title') || url;
  $('edit-url').value = url;
  // Captures are optional; the bookmark can still be saved without one.
  const capture = await readCapture(params.get('capture'));
  if ($('editor').open && capture?.url === url) {
    if (validPreview(capture.preview)) { pendingPreview = capture.preview; pendingPreviewURL = url; showEditorPreview(); }
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
