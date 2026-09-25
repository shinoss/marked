// Marked's reader: the text saved from a bookmark's page, set for reading, with
// its highlights. Opened as reader.html?id=<bookmark>, with q=<search> to show
// words searched for, or highlight=<id> to go to one highlight. It remembers
// how far each text has been read.
import './browser-api.js';
import { createLibraryStore } from './store.js';
import { cleanHighlightText, safeURL, HIGHLIGHT_COLORS } from './bookmarks.js';
import { fetchPageText, readingMinutes, searchTerms, READING_KEY } from './page-text.js';
import { renderText, loadReadability, renderCard } from './text-view.js';
import { documentTerms, expandIndex, similar, weigh, RELATED_KEY } from './related.js';

const library = createLibraryStore(browser);
// The window, through the document, as the library page does, so tests can supply one.
const win = document.defaultView;
const $ = id => document.getElementById(id);
const params = new URLSearchParams(win.location.search);
const terms = searchTerms(params.get('q') || '');
let node = null, text = null;
// A selection waiting for a color, and the color last used.
let pending = '', lastColor = 'yellow';
let toastTimer;

const title = item => item.title || item.url || 'Untitled';
const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
function element(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}
function button(label, action, className = 'text-button', aria) {
  const el = element('button', className, label);
  el.type = 'button';
  if (aria) { el.title = aria; el.setAttribute('aria-label', aria); }
  el.addEventListener('click', action);
  return el;
}
function toast(message, action = null) {
  clearTimeout(toastTimer);
  const notice = $('toast');
  notice.replaceChildren(element('span', '', message));
  if (action) notice.append(button(action[0], () => { notice.hidden = true; action[1](); }, 'toast-action'));
  notice.hidden = false;
  toastTimer = setTimeout(() => { notice.hidden = true; }, 6000);
}
function find(root, id) {
  if (root.id === id) return root;
  for (const child of root.children || []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Reading options, kept per browser: font, size, measure, and theme. Auto
// follows Marked's own theme; Sepia is the reader's alone.
const OPTIONS_KEY = 'markedReader';
const DEFAULTS = { font: 'serif', size: 19, width: 'medium', theme: 'auto' };
const SIZES = [15, 16, 17, 18, 19, 20, 22, 24, 27];
let options = { ...DEFAULTS };
try { options = { ...DEFAULTS, ...JSON.parse(win.localStorage.getItem(OPTIONS_KEY)) }; } catch {}
function applyOptions() {
  const root = document.documentElement;
  root.dataset.font = options.font === 'sans' ? 'sans' : 'serif';
  root.dataset.width = options.width;
  root.style.setProperty('--reader-size', `${options.size}px`);
  let marked = 'system';
  try { marked = win.localStorage.getItem('markedTheme') || 'system'; } catch {}
  const theme = options.theme === 'auto' ? marked : options.theme;
  if (theme === 'light' || theme === 'sepia') root.dataset.theme = 'light';
  else if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  if (theme === 'sepia') root.dataset.readerTheme = 'sepia'; else delete root.dataset.readerTheme;
  for (const choice of document.querySelectorAll('[data-option]')) choice.setAttribute('aria-checked', String(options[choice.dataset.option] === choice.dataset.value));
  $('reader-smaller').disabled = options.size <= SIZES[0];
  $('reader-larger').disabled = options.size >= SIZES.at(-1);
}
function setOption(key, value) {
  // Changing the text's size or measure keeps the same paragraph in view.
  const block = topBlock();
  options = { ...options, [key]: value };
  try { win.localStorage.setItem(OPTIONS_KEY, JSON.stringify(options)); } catch {}
  applyOptions();
  if (block) scrollToBlock(block);
}
for (const choice of document.querySelectorAll('[data-option]')) choice.addEventListener('click', () => setOption(choice.dataset.option, choice.dataset.value));
$('reader-smaller').addEventListener('click', () => setOption('size', SIZES.findLast(size => size < options.size) ?? options.size));
$('reader-larger').addEventListener('click', () => setOption('size', SIZES.find(size => size > options.size) ?? options.size));
$('reader-menu').addEventListener('toggle', event => {
  if (event.newState !== 'open') return;
  const anchor = $('reader-options').getBoundingClientRect(), menu = $('reader-menu');
  menu.style.top = `${anchor.bottom + 8}px`;
  menu.style.left = `${Math.max(8, Math.min(anchor.right - menu.offsetWidth, win.innerWidth - menu.offsetWidth - 8))}px`;
});
// Marked's theme changed in another tab.
win.addEventListener('storage', event => { if (event.key === 'markedTheme' || event.key === OPTIONS_KEY) { if (event.key === OPTIONS_KEY) try { options = { ...DEFAULTS, ...JSON.parse(event.newValue) }; } catch {} applyOptions(); } });

const blocks = () => [...$('reader-body').querySelectorAll('[data-index]')];
// The paragraph at the top of the window, under the bar.
const topBlock = () => blocks().find(block => block.getBoundingClientRect().bottom > 72);
function scrollToBlock(block, where = 'start') {
  const rect = block.getBoundingClientRect();
  const top = where === 'center' ? rect.top + win.scrollY - win.innerHeight / 2 + rect.height / 2 : rect.top + win.scrollY - 76;
  win.scrollTo({ top: Math.max(0, top) });
}

function showHeader() {
  const url = safeURL(node.url);
  const domain = hostOf(node.url);
  document.title = `${title(node)} · Marked`;
  $('reader-title').textContent = title(node);
  $('reader-site').textContent = domain;
  for (const link of [$('reader-original'), $('reader-visit')]) { if (url) link.href = url; link.hidden = !url; }
  const saved = text?.text && text.capturedAt ? new Date(text.capturedAt).toLocaleDateString([], { dateStyle: 'medium' }) : '';
  $('reader-meta').textContent = [domain, text?.byline, text?.text && `${readingMinutes(text.words)} min read`, saved && `saved ${saved}`].filter(Boolean).join(' · ');
  $('reader-truncated').hidden = !text?.truncated;
  // A post's card: where it's from, who wrote it, and how it's doing.
  $('reader-card').hidden = !node.card;
  if (node.card) $('reader-card').replaceChildren(renderCard(document, node.card));
}
function showBody() {
  $('reader-empty').hidden = true;
  $('reader-body').hidden = false;
  $('reader-body').replaceChildren();
  renderText($('reader-body'), text.text, text.kinds, { terms, highlights: node.highlights || [] });
  $('reader-end').hidden = false;
}
function missing(message) {
  document.title = 'Marked · Reader';
  $('reader-title').textContent = 'Not in Marked';
  $('reader-empty-text').textContent = message;
  $('reader-empty').hidden = false;
  $('reader-visit').hidden = true;
}
// No text yet: download the page, as Settings does for older bookmarks.
function showEmpty() {
  $('reader-empty').hidden = false;
  $('reader-body').hidden = true;
  $('reader-empty-text').textContent = text?.error ? `Marked couldn’t read this page before: ${text.error}` : 'Marked doesn’t have this page’s text yet.';
  const download = $('reader-download');
  download.hidden = !/^https?:/.test(node.url);
  download.onclick = async () => {
    // Reading another site needs access to it; ask while the click counts as user input.
    const sites = { origins: ['<all_urls>'] };
    const access = browser.permissions?.request?.(sites).catch(() => browser.permissions.contains(sites)).catch(() => false);
    download.disabled = true;
    $('reader-error').textContent = '';
    try {
      if (await access === false) throw new Error('Allow Marked on all websites to download pages.');
      await loadReadability();
      const saved = await library.setText(node.id, { ...await fetchPageText(node.url), via: 'download' });
      if (!saved) throw new Error('This bookmark is no longer in Marked.');
      text = saved;
      showHeader();
      showBody();
      trackProgress();
    } catch (error) { $('reader-error').textContent = error.message; }
    finally { download.disabled = false; }
  };
}

// Where to start: a highlight or the words searched for, else where reading stopped.
async function place() {
  await document.fonts?.ready;
  const wanted = params.get('highlight');
  const target = wanted ? [...$('reader-body').querySelectorAll('mark.passage')].find(mark => mark.dataset.highlight === wanted)
    : terms.length ? $('reader-body').querySelector('mark.term') : null;
  if (target) {
    scrollToBlock(target, 'center');
    target.classList.add('flash');
    return;
  }
  const saved = (await browser.storage.local.get(READING_KEY))[READING_KEY]?.[node.id];
  recorded = !!saved;
  const block = saved && saved.p >= 0.03 && saved.p < 0.97 && blocks().find(item => Number(item.dataset.index) >= saved.i);
  if (block) {
    scrollToBlock(block);
    toast('Picking up where you left off.', ['Start over', () => win.scrollTo({ top: 0 })]);
  }
}

// How far along the reader is: the bar at the top, and a record for the library.
let saveTimer, recorded = false, last = null, tracking = false;
function progress() {
  const room = document.documentElement.scrollHeight - win.innerHeight;
  return room > 8 ? Math.min(1, Math.max(0, win.scrollY / room)) : null;
}
function trackProgress() {
  const update = () => {
    const done = progress();
    $('reader-progress').style.transform = `scaleX(${done ?? 1})`;
    clearTimeout(saveTimer);
    // A text that fits on one screen, or was only opened, isn't recorded.
    if (done === null || (!recorded && done < 0.03)) return;
    saveTimer = setTimeout(() => saveProgress(done), 600);
  };
  if (!tracking) {
    tracking = true;
    win.addEventListener('scroll', update, { passive: true });
    win.addEventListener('resize', update);
  }
  update();
}
async function saveProgress(done) {
  const entry = { p: Math.round(done * 1000) / 1000, i: Number(topBlock()?.dataset.index || 0), at: Date.now() };
  if (last && last.p === entry.p && last.i === entry.i) return;
  last = entry;
  recorded = true;
  await navigator.locks.request('marked-reading', async () => {
    const all = (await browser.storage.local.get(READING_KEY))[READING_KEY] || {};
    all[node.id] = entry;
    await browser.storage.local.set({ [READING_KEY]: all });
  });
}

// Highlighting: select text, then pick a color (or add a note first). A saved
// highlight opens its note, colors, and Delete when clicked.
const tools = $('reader-tools');
function hideTools() { tools.hidden = true; tools.replaceChildren(); pending = ''; }
function placeTools(rect) {
  tools.hidden = false;
  const { width, height } = tools.getBoundingClientRect();
  const top = rect.bottom + 10 + height > win.innerHeight ? rect.top - height - 10 : rect.bottom + 10;
  tools.style.top = `${Math.max(64, top)}px`;
  tools.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, win.innerWidth - width - 8))}px`;
}
function swatches(chosen, choose) {
  const group = element('div', 'swatches');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Color');
  for (const color of HIGHLIGHT_COLORS) {
    const swatch = button('', () => choose(color), `swatch hl-${color}`, color[0].toUpperCase() + color.slice(1));
    swatch.setAttribute('aria-pressed', String(color === chosen));
    group.append(swatch);
  }
  return group;
}
function noteEditor(value, save) {
  const field = element('textarea');
  field.maxLength = 2000;
  field.placeholder = 'Add a note (optional)';
  field.value = value;
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(field.value); }
  });
  const row = element('div', 'row');
  row.append(button('Save', () => save(field.value), 'text-button primary'), button('Cancel', hideTools));
  return [field, row];
}
function selectedPassage() {
  const selection = win.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!$('reader-body').contains(range.commonAncestorContainer)) return null;
  const passage = cleanHighlightText(selection.toString());
  return passage ? { passage, rect: range.getBoundingClientRect?.() ?? { top: 0, bottom: 0, left: 0, width: 0 } } : null;
}
function offerHighlight() {
  const selected = selectedPassage();
  if (!selected) return;
  pending = selected.passage;
  const row = element('div', 'row');
  row.append(swatches(null, color => saveHighlight(color)), button('Note', () => {
    const passage = pending;
    tools.replaceChildren(...noteEditor('', note => { pending = passage; saveHighlight(lastColor, note); }));
    tools.querySelector('textarea').focus();
  }));
  tools.replaceChildren(row);
  placeTools(selected.rect);
}
async function saveHighlight(color, note = '') {
  if (!pending) return;
  try {
    const saved = await library.addHighlight(node.id, { text: pending, color, note });
    lastColor = color;
    node.highlights = [...(node.highlights || []), saved];
    win.getSelection().removeAllRanges();
    hideTools();
    redraw();
    toast('Highlighted. It shows on the page, too.');
  } catch (error) { toast(error.message); }
}
function redraw() {
  const y = win.scrollY;
  showBody();
  win.scrollTo({ top: y });
}
function editHighlight(mark) {
  const highlight = (node.highlights || []).find(item => item.id === mark.dataset.highlight);
  if (!highlight) return;
  const update = async changes => {
    try {
      const saved = await library.updateHighlight(node.id, highlight.id, changes);
      node.highlights = node.highlights.map(item => item.id === saved.id ? saved : item);
      hideTools();
      redraw();
    } catch (error) { toast(error.message); }
  };
  const remove = async () => {
    try {
      await library.removeHighlight(node.id, highlight.id);
      node.highlights = node.highlights.filter(item => item.id !== highlight.id);
      hideTools();
      redraw();
      toast('Highlight deleted.', ['Undo', async () => {
        const restored = await library.addHighlight(node.id, highlight);
        node.highlights = [...node.highlights, restored];
        redraw();
      }]);
    } catch (error) { toast(error.message); }
  };
  const row = element('div', 'row');
  row.append(swatches(highlight.color || 'yellow', color => update({ color })), button(highlight.note ? 'Edit note' : 'Note', () => {
    tools.replaceChildren(...noteEditor(highlight.note || '', note => update({ note })));
    tools.querySelector('textarea').focus();
  }), button('Delete', remove));
  tools.replaceChildren(...(highlight.note ? [element('p', 'highlight-note', highlight.note)] : []), row);
  placeTools(mark.getBoundingClientRect());
}
// Where an event happened, even if its target has since been replaced.
const inTools = event => event.composedPath().includes(tools);
document.addEventListener('mouseup', event => { if (!inTools(event)) setTimeout(offerHighlight, 0); });
document.addEventListener('keyup', event => { if (event.shiftKey && !inTools(event)) setTimeout(offerHighlight, 0); });
$('reader-body').addEventListener('click', event => {
  const mark = event.target.closest?.('mark.passage[data-highlight]');
  if (mark && win.getSelection().isCollapsed) editHighlight(mark);
});
// A click anywhere else closes them; a new selection offers them again.
document.addEventListener('click', event => {
  if (tools.hidden || inTools(event) || event.target.closest?.('mark.passage[data-highlight]') || selectedPassage()) return;
  hideTools();
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { hideTools(); return; }
  // H highlights the selection in the color last used, as reading apps do.
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (event.key.toLowerCase() === 'h' && !event.metaKey && !event.ctrlKey && !event.altKey && !typing) {
    const selected = selectedPassage();
    if (!selected) return;
    event.preventDefault();
    pending = selected.passage;
    saveHighlight(lastColor);
  }
});
win.addEventListener('scroll', () => { if (!tools.hidden && !tools.contains(document.activeElement)) hideTools(); }, { passive: true });
$('reader-top').addEventListener('click', event => { event.preventDefault(); win.scrollTo({ top: 0 }); });
// Alt+Shift+H, which background.js passes to the reader tab it came from.
let ownTab = null;
browser.tabs?.getCurrent?.().then(tab => { ownTab = tab?.id ?? null; }, () => {});
browser.runtime.onMessage.addListener(message => {
  if (message?.type !== 'marked:reader-highlight' || message.tabId !== ownTab) return;
  const selected = selectedPassage();
  if (!selected) { toast('Select some text, then press the shortcut again.'); return; }
  pending = selected.passage;
  saveHighlight(lastColor);
});

// At the end, the saved bookmarks most like this one, from the index the
// library keeps: in the reader when their text is saved, else on their site.
async function showRelated(root) {
  const compact = (await browser.storage.local.get(RELATED_KEY))[RELATED_KEY];
  if (compact?.version !== 1) return;
  const index = expandIndex(compact);
  const vector = index.vectors.get(node.id) ?? weigh(index, documentTerms({ title: title(node), tags: node.tags || [], note: node.note || '', highlights: node.highlights || [], abstract: node.abstract || '', card: node.card, text: text?.text || '' }));
  const matches = similar(index, vector, { exclude: new Set([node.id]), limit: 5 }).map(match => ({ ...match, node: find(root, match.id) })).filter(match => match.node?.url);
  if (!matches.length) return;
  const texts = await library.getTexts(matches.map(match => match.id));
  $('reader-related-list').replaceChildren(...matches.map(({ node: other, shared }) => {
    const item = element('li');
    const link = element('a', 'related-title', title(other));
    if (texts[other.id]?.text) link.href = `reader.html?${new URLSearchParams({ id: other.id })}`;
    else { link.href = safeURL(other.url) || ''; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    item.append(link, element('span', 'related-meta', [hostOf(other.url), shared.length && `shares ${shared.join(', ')}`].filter(Boolean).join(' · ')));
    return item;
  }));
  $('reader-related').hidden = false;
}

async function start() {
  applyOptions();
  const id = params.get('id');
  const [root] = await library.getTree();
  node = id ? find(root, id) : null;
  if (!node?.url) { missing('This bookmark is no longer in Marked.'); return; }
  text = (await library.getTexts([node.id]))[node.id] || null;
  showHeader();
  if (!text?.text) { showEmpty(); return; }
  showBody();
  await place();
  trackProgress();
  await showRelated(root).catch(() => {});
}
export const ready = start().catch(error => { toast(error.message || String(error)); });
