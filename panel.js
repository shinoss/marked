// Marked's panels on web pages: the save panel, for Add to Marked, Save tweet
// to Marked, and Highlight on a page that isn't in Marked yet; and the note
// panel, for a highlight on a saved page. save-panel.js shows this page in a
// frame on the web page. A page's scripts hear every key pressed in its own
// document, even inside a closed shadow root, but never in a frame from
// another origin, so what the user types here reaches Marked alone. The panel
// asks background.js what to show and sends it what the user chose; all it
// tells the page is its height, and when it's done.
import './browser-api.js';
import { HIGHLIGHT_COLORS } from './bookmarks.js';

const win = document.defaultView;
const panel = document.getElementById('panel');
// save or highlight, as save-panel.js opened it.
const kind = win.location.hash === '#highlight' ? 'highlight' : 'save';
// Highlight colors: a swatch, and the quote's border.
const EDGE = { yellow: '#f2d94e', green: '#5cc98a', blue: '#5b9df0', pink: '#f07aa9', purple: '#a384f0' };
// The field the user starts typing in.
let first = null;

// To save-panel.js, through the page: the panel's height; done (saved: the
// page gets its focus back, and the panel goes soon); or close (at once).
const tell = message => win.parent.postMessage({ marked: 'panel', ...message }, '*');
// null when Marked doesn't answer, as after it was updated or reloaded.
const ask = async message => { try { return await browser.runtime.sendMessage(message); } catch { return null; } };

function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function button(label, action, className = 'button') {
  const el = element('button', className, label);
  el.type = 'button';
  el.addEventListener('click', action);
  return el;
}
function control(tag, value, limit, properties = {}) {
  const el = Object.assign(element(tag, 'control'), properties);
  el.value = value;
  el.maxLength = limit;
  return el;
}
function labelled(name, field) {
  const label = element('label', 'field');
  label.append(element('span', 'label', name), field);
  return label;
}
// Five colors for a highlight, yellow unless another is chosen; the quote's
// border follows the choice.
function swatches(quote, name, chosen = () => {}) {
  const group = element('div', 'swatches');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', name);
  let color;
  const choose = shade => {
    color = shade;
    quote.style.borderLeftColor = EDGE[shade];
    for (const swatch of group.children) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === shade));
  };
  for (const shade of HIGHLIGHT_COLORS) {
    const swatch = button('', () => { choose(shade); chosen(); }, 'swatch');
    swatch.dataset.color = shade;
    swatch.style.background = EDGE[shade];
    swatch.title = shade[0].toUpperCase() + shade.slice(1);
    swatch.setAttribute('aria-label', swatch.title);
    group.append(swatch);
  }
  choose('yellow');
  return { group, color: () => color };
}
const error = () => {
  const el = element('div', 'error');
  el.setAttribute('role', 'alert');
  return el;
};
// Saved: the panel says so while the page gets its focus back.
function done(message) {
  panel.onkeydown = null;
  panel.setAttribute('role', 'status');
  panel.removeAttribute('aria-label');
  panel.replaceChildren(element('div', '', message));
  tell({ done: true });
}

// data: what background.js keeps for this save (panelData there).
function saveForm(data) {
  const heading = data.edit ? 'Edit bookmark' : 'Add to Marked';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', heading);
  const name = control('input', data.title || '', 2000, { autocomplete: 'off' });
  const folder = element('select', 'control');
  for (const { id, label } of data.folders || []) {
    const option = element('option', '', label);
    option.value = id;
    folder.append(option);
  }
  folder.value = data.folder;

  // A passage highlighted on a page that isn't in Marked yet comes with it.
  const highlightNote = control('textarea', '', 2000, { rows: 2, placeholder: 'Optional' });
  let passage = null;
  const highlight = [];
  if (data.highlight) {
    const quote = element('div', 'quote', data.highlight);
    passage = swatches(quote, 'Highlight color');
    const field = element('div', 'field');
    field.append(element('span', 'label', 'Highlight'), quote, passage.group);
    highlight.push(field, labelled('Note on this highlight', highlightNote));
  }
  const note = control('textarea', data.note || '', 2000, { rows: 2, placeholder: 'Why are you saving this? Local chat can use it.' });

  // The library's tags, to choose from, and a field for a new one.
  const chosen = [...(data.chosen || [])];
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  const has = tag => chosen.some(other => same(other, tag));
  const chip = tag => {
    const el = button(tag, () => {
      const at = chosen.findIndex(other => same(other, tag));
      if (at >= 0) chosen.splice(at, 1); else chosen.push(tag);
      el.setAttribute('aria-pressed', String(at < 0));
    }, 'chip');
    el.setAttribute('aria-pressed', String(has(tag)));
    return el;
  };
  const chips = element('div', 'chips');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Tags');
  const known = [...(data.tags || [])];
  for (const tag of chosen) if (!known.some(other => same(other, tag))) known.push(tag);
  chips.append(...known.map(chip));
  const newTag = control('input', '', 40, { autocomplete: 'off', placeholder: 'Add a tag and press Enter' });
  newTag.setAttribute('aria-label', 'New tag');
  // Tags can't hold commas: bookmark files separate tags with them.
  const addTag = () => {
    const tag = newTag.value.replace(/[,\s]+/g, ' ').trim().slice(0, 40).trim();
    newTag.value = '';
    if (!tag) return;
    const existing = [...chips.children].find(el => same(el.textContent, tag));
    if (!has(tag)) chosen.push(existing?.textContent ?? tag);
    if (existing) existing.setAttribute('aria-pressed', 'true'); else chips.append(chip(tag));
  };
  const tags = element('div', 'field');
  tags.append(element('span', 'label', 'Tags'), chips, newTag);

  const abstract = control('textarea', data.abstract || '', 2000, { rows: 3, placeholder: 'What is this page about? Local chat uses this.' });
  // The preview itself stays in Marked: it shows what's on screen, which can
  // include parts of the page from other sites.
  const preview = element('input');
  preview.type = 'checkbox';
  preview.checked = true;
  const previewField = [];
  if (data.preview) {
    const choice = element('label', 'check');
    choice.append(preview, element('span', '', 'Save preview'));
    previewField.push(choice, element('div', 'hint', 'Includes visible page content. Stored only in Marked.'));
  }

  const problem = error();
  let saving = false;
  const save = async () => {
    if (saving) return;
    const title = name.value.trim();
    if (!title) { problem.textContent = 'Enter a name.'; name.focus(); return; }
    addTag();
    saving = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    const reply = await ask({
      type: 'marked:save-page', token: data.token, title, parentId: folder.value, note: note.value, tags: chosen, abstract: abstract.value,
      preview: !!data.preview && preview.checked, ...(passage && { highlight: { color: passage.color(), note: highlightNote.value } })
    });
    if (reply?.ok) { done('Saved to Marked.'); return; }
    saving = false;
    problem.textContent = reply?.error || 'Marked could not save this page. Try again.';
    saveButton.disabled = false;
    saveButton.textContent = 'Save';
  };
  const cancel = () => { ask({ type: 'marked:cancel-save', token: data.token }); tell({ close: true }); };
  const saveButton = button('Save', save, 'button primary');
  const actions = element('div', 'actions');
  actions.append(button('Cancel', cancel), saveButton);

  // Enter in the name saves, and in the tag field adds the tag; Ctrl+Enter
  // or ⌘+Enter saves from anywhere. Never while an input method is composing.
  panel.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
    if (event.key !== 'Enter') return;
    if (event.metaKey || event.ctrlKey || event.target === name) { event.preventDefault(); save(); }
    else if (event.target === newTag) { event.preventDefault(); addTag(); }
  };
  panel.replaceChildren(
    element('h1', '', heading),
    element('div', 'muted line', String(data.url || '').replace(/^https?:\/\/(www\.)?/, '')),
    labelled('Name', name), labelled('Folder', folder), ...highlight, labelled('Note', note), tags, labelled('Abstract', abstract),
    ...previewField, problem, actions
  );
  first = name;
}

// The note panel for a passage highlighted on a saved page. data: the
// bookmark's title and the passage (panelData in background.js).
function noteForm(data) {
  panel.classList.add('highlight');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Highlight');
  const quote = element('div', 'quote', data.text);
  const colors = swatches(quote, 'Color', () => note.focus());
  const note = control('textarea', '', 2000, { className: 'control note', placeholder: 'Add a note (optional)' });
  const problem = error();
  let saving = false;
  const save = async () => {
    if (saving) return;
    saving = true;
    saveButton.disabled = true;
    const reply = await ask({ type: 'marked:save-highlight', token: data.token, note: note.value, color: colors.color() });
    if (reply?.ok) { done('Highlight saved to Marked.'); return; }
    saving = false;
    problem.textContent = reply?.error || 'Marked could not save the highlight. Try again.';
    saveButton.disabled = false;
  };
  const cancel = () => { ask({ type: 'marked:cancel-highlight', token: data.token }); tell({ close: true }); };
  const saveButton = button('Save highlight', save, 'button primary');
  const actions = element('div', 'actions');
  actions.append(button('Cancel', cancel), saveButton);
  panel.onkeydown = event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save(); }
  };
  panel.replaceChildren(element('h1', '', 'Highlight'), element('div', 'muted line', `On “${data.title}”`), quote, colors.group, note, problem, actions);
  first = note;
}

function focusFirst() {
  first?.focus({ preventScroll: true });
  if (kind === 'save') first?.select();
}
// save-panel.js sizes the frame to the panel, and shows it once it's told.
const report = () => tell({ height: Math.ceil(panel.getBoundingClientRect().height) });

async function start() {
  const data = await ask({ type: 'marked:panel-data', kind });
  // Nothing waits for this panel anymore: another took its place, or its page moved on.
  if (!data?.token) { tell({ close: true }); return; }
  if (kind === 'highlight') noteForm(data); else saveForm(data);
  // The first field gets the focus once save-panel.js gives it to the frame, as
  // the panel shows: never before, so no one types into a panel they can't see.
  win.addEventListener('focus', () => { if ([document.body, null].includes(document.activeElement)) focusFirst(); }, { once: true });
  if (win.ResizeObserver) new win.ResizeObserver(report).observe(panel);
  report();
}
export const ready = start();
