import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../panel.html', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

// What background.js keeps for a save, and for a highlight's note (panelData there).
const form = {
  token: 'token-1', edit: false, url: 'https://www.example.com/essays/attention', title: 'On attention',
  folders: [{ id: 'root', label: 'Library (top level)' }, { id: 'reading', label: '　Reading' }], folder: 'root',
  tags: ['Technology', 'AI', 'History'], chosen: ['AI'], note: '', abstract: 'Deciding what deserves it.', highlight: '', preview: true
};
const passage = { token: 'note-1', title: 'The essay', text: 'A passage worth keeping.' };

// Opens panel.html as save-panel.js does, at #save or #highlight. data is what
// Marked answers marked:panel-data with; replies, its answers to the rest.
let opened = 0;
async function open(kind, data, replies = {}) {
  const { window } = new JSDOM(html, { url: `https://extension.local/panel.html#${kind}` });
  globalThis.document = window.document;
  const page = { window, sent: [], told: [] };
  globalThis.browser = { runtime: { sendMessage: async message => {
    page.sent.push(structuredClone(message));
    return message.type === 'marked:panel-data' ? data : replies[message.type];
  } } };
  // What the panel tells save-panel.js, through the page: in JSDOM a window is its own parent.
  window.addEventListener('message', event => page.told.push(event.data));
  const { ready } = await import(`../panel.js?${++opened}`);
  await ready;
  await tick();
  const document = window.document;
  page.panel = () => document.getElementById('panel');
  page.field = name => [...document.querySelectorAll('label')].find(label => label.firstChild.textContent === name)?.querySelector('input, textarea, select');
  page.buttons = selector => [...document.querySelectorAll(selector ?? 'button')];
  page.click = async label => { page.buttons().find(button => button.textContent === label).click(); await tick(); };
  page.key = async (target, key, init = {}) => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); await tick(); };
  page.type = (target, value) => { target.value = value; target.dispatchEvent(new window.Event('input', { bubbles: true })); };
  page.swatch = color => document.querySelector(`[data-color="${color}"]`);
  // save-panel.js gives the frame the focus as it shows the panel.
  page.focus = () => window.dispatchEvent(new window.FocusEvent('focus'));
  return page;
}

test('the save panel shows what Marked read, with the name ready to type, and says how tall it is', async () => {
  const page = await open('save', form);
  assert.deepEqual(page.sent, [{ type: 'marked:panel-data', kind: 'save' }], 'it asks Marked what to show');
  const panel = page.panel();
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.equal(panel.getAttribute('aria-label'), 'Add to Marked');
  assert.match(panel.textContent, /^Add to Marked\s*Open Marked\s*example\.com\/essays\/attention/);
  assert.equal(page.window.document.querySelector('.related'), null, 'no related bookmarks to show');
  const name = page.field('Name');
  assert.equal(name.value, 'On attention');
  assert.equal(page.window.document.activeElement, page.window.document.body, 'nothing takes the keyboard before the panel shows');
  page.focus();
  assert.equal(page.window.document.activeElement, name, 'then the name does');
  assert.deepEqual([name.selectionStart, name.selectionEnd], [0, 'On attention'.length], 'typing replaces the name');
  const folder = page.field('Folder');
  assert.deepEqual([...folder.options].map(option => [option.value, option.textContent]), [['root', 'Library (top level)'], ['reading', '　Reading']]);
  assert.equal(folder.value, 'root');
  assert.deepEqual(page.buttons('[aria-label="Tags"] button').map(chip => [chip.textContent, chip.getAttribute('aria-pressed')]), [['Technology', 'false'], ['AI', 'true'], ['History', 'false']]);
  assert.equal(page.field('Abstract').value, 'Deciding what deserves it.');
  assert.equal(page.field('Note').value, '');
  assert.equal(page.window.document.querySelector('input[type="checkbox"]').checked, true, 'Save preview, ticked as in the editor');
  assert.match(panel.textContent, /Includes visible page content\. Stored only in Marked\./);
  assert.equal(page.window.document.querySelector('img'), null, 'the preview itself stays in Marked');
  assert.deepEqual(page.buttons().slice(-2).map(button => button.textContent), ['Cancel', 'Save']);
  assert.deepEqual(page.told, [{ marked: 'panel', height: 0 }], 'save-panel.js sizes the frame to it');
});

test('Save hands back what the user chose, then says so and lets the page have its focus back', async () => {
  const page = await open('save', form, { 'marked:save-page': { ok: true } });
  page.type(page.field('Name'), '  Attention, briefly ');
  page.field('Folder').value = 'reading';
  page.type(page.field('Note'), 'Read before the weekly review.');
  await page.click('Technology');
  await page.click('AI');
  const newTag = page.window.document.querySelector('[aria-label="New tag"]');
  page.type(newTag, ' Essays,  focus ');
  await page.key(newTag, 'Enter');
  assert.equal(page.buttons('[aria-label="Tags"] button').at(-1).textContent, 'Essays focus', 'commas can’t be in a tag');
  page.type(newTag, 'history');
  page.type(page.field('Abstract'), 'Edited.');
  page.window.document.querySelector('input[type="checkbox"]').click();
  await page.click('Save');
  assert.deepEqual(page.sent.at(-1), { type: 'marked:save-page', token: 'token-1', title: 'Attention, briefly', parentId: 'reading', note: 'Read before the weekly review.', tags: ['Technology', 'Essays focus', 'History'], abstract: 'Edited.', preview: false },
    'a tag typed but not yet added counts, spelled as the library spells it');
  assert.equal(page.panel().textContent, 'Saved to Marked.');
  assert.equal(page.panel().getAttribute('role'), 'status');
  assert.deepEqual(page.told.at(-1), { marked: 'panel', done: true });
});

test('Enter in the name saves, Ctrl+Enter saves from anywhere, and Escape cancels', async () => {
  const page = await open('save', form, { 'marked:save-page': { ok: true } });
  await page.key(page.field('Name'), 'Enter', { isComposing: true });
  assert.equal(page.sent.length, 1, 'not while an input method is composing');
  await page.key(page.field('Note'), 'Enter');
  assert.equal(page.sent.length, 1, 'Enter in the note is a new line');
  await page.key(page.field('Note'), 'Enter', { ctrlKey: true });
  assert.equal(page.sent.at(-1).type, 'marked:save-page');
  const again = await open('save', { ...form, token: 'token-2' });
  await again.key(again.field('Name'), 'Enter');
  assert.deepEqual([again.sent.at(-1).type, again.sent.at(-1).token], ['marked:save-page', 'token-2']);
  const third = await open('save', { ...form, token: 'token-3' });
  await third.key(third.field('Abstract'), 'Escape');
  assert.deepEqual(third.sent.at(-1), { type: 'marked:cancel-save', token: 'token-3' });
  assert.deepEqual(third.told.at(-1), { marked: 'panel', close: true });
});

test('a failed save shows why in the panel and can be tried again; an empty name is refused', async () => {
  const replies = { 'marked:save-page': { error: 'This panel is out of date. Save the page again.' } };
  const page = await open('save', form, replies);
  page.type(page.field('Name'), '   ');
  await page.click('Save');
  assert.equal(page.sent.length, 1, 'nothing is sent');
  assert.equal(page.window.document.querySelector('[role="alert"]').textContent, 'Enter a name.');
  page.type(page.field('Name'), 'On attention');
  await page.click('Save');
  assert.match(page.panel().textContent, /This panel is out of date\. Save the page again\./);
  const save = page.buttons().at(-1);
  assert.deepEqual([save.textContent, save.disabled], ['Save', false]);
  replies['marked:save-page'] = undefined;
  await page.click('Save');
  assert.match(page.panel().textContent, /Marked could not save this page\. Try again\./, 'when Marked doesn’t answer');
  await page.click('Cancel');
  assert.deepEqual(page.sent.at(-1), { type: 'marked:cancel-save', token: 'token-1' });
  assert.deepEqual(page.told.at(-1), { marked: 'panel', close: true });
});

test('Marked, and the saved bookmarks related to the page, are a click away in the save panel', async () => {
  const page = await open('save', { ...form, related: 3 });
  await page.click('3 saved bookmarks relate to this page');
  await page.click('Open Marked');
  assert.deepEqual(page.sent.slice(1), [{ type: 'marked:open-related' }, { type: 'marked:open-marked' }]);
  assert.ok(page.panel().querySelector('input'), 'the panel stays, with what was typed');
  const one = await open('save', { ...form, related: 1 });
  assert.equal(one.window.document.querySelector('.related').textContent, 'A saved bookmark relates to this page');
});

test('on a page already in Marked, the panel edits its bookmark', async () => {
  const page = await open('save', { ...form, edit: true, note: 'Kept for the review.', chosen: ['History'], folder: 'reading', preview: false });
  assert.equal(page.panel().getAttribute('aria-label'), 'Edit bookmark');
  assert.match(page.panel().textContent, /^Edit bookmark/);
  assert.equal(page.field('Note').value, 'Kept for the review.');
  assert.equal(page.field('Folder').value, 'reading');
  assert.deepEqual(page.buttons('[aria-pressed="true"]').map(chip => chip.textContent), ['History']);
  assert.equal(page.window.document.querySelector('input[type="checkbox"]'), null, 'no new preview to keep');
});

test('a passage highlighted on a new page comes with it, in the color the user picks, with its own note', async () => {
  const page = await open('save', { ...form, highlight: 'Attention is the one budget that never grows.' }, { 'marked:save-page': { ok: true } });
  assert.match(page.panel().textContent, /HighlightAttention is the one budget that never grows\./);
  assert.equal(page.swatch('yellow').getAttribute('aria-pressed'), 'true');
  page.swatch('blue').click();
  assert.deepEqual([page.swatch('blue').getAttribute('aria-pressed'), page.swatch('yellow').getAttribute('aria-pressed')], ['true', 'false']);
  page.type(page.field('Note on this highlight'), 'The key line.');
  await page.click('Save');
  assert.deepEqual(page.sent.at(-1).highlight, { color: 'blue', note: 'The key line.' });
});

test('the note panel saves a note and a color for the passage, which stays with Marked', async () => {
  const page = await open('highlight', passage, { 'marked:save-highlight': { ok: true } });
  assert.deepEqual(page.sent, [{ type: 'marked:panel-data', kind: 'highlight' }]);
  const panel = page.panel();
  assert.equal(panel.getAttribute('aria-label'), 'Highlight');
  assert.match(panel.textContent, /On “The essay”/);
  assert.match(panel.textContent, /A passage worth keeping\./);
  assert.deepEqual(page.buttons().map(button => button.textContent), ['', '', '', '', '', 'Cancel', 'Save highlight'], 'five color swatches, then the actions');
  assert.equal(page.swatch('yellow').getAttribute('aria-pressed'), 'true', 'yellow unless another is chosen');
  const note = page.window.document.querySelector('textarea');
  page.focus();
  assert.equal(page.window.document.activeElement, note, 'the note is ready to type');
  note.value = 'Quote this.';
  page.swatch('green').click();
  assert.equal(page.window.document.activeElement, note, 'choosing a color keeps the note’s place');
  assert.deepEqual([page.swatch('green').getAttribute('aria-pressed'), page.swatch('yellow').getAttribute('aria-pressed')], ['true', 'false']);
  await page.click('Save highlight');
  assert.deepEqual(page.sent.at(-1), { type: 'marked:save-highlight', token: 'note-1', note: 'Quote this.', color: 'green' });
  assert.equal(page.panel().textContent, 'Highlight saved to Marked.');
  assert.deepEqual(page.told.at(-1), { marked: 'panel', done: true });
});

test('the note panel shows why a save failed, saves with Ctrl+Enter, and cancels with Escape', async () => {
  const replies = { 'marked:save-highlight': { error: 'This page is no longer in Marked.' } };
  const page = await open('highlight', passage, replies);
  await page.click('Save highlight');
  assert.match(page.panel().textContent, /This page is no longer in Marked\./);
  assert.equal(page.buttons().at(-1).disabled, false, 'and can be tried again');
  replies['marked:save-highlight'] = { ok: true };
  await page.key(page.window.document.querySelector('textarea'), 'Enter', { metaKey: true });
  assert.equal(page.panel().textContent, 'Highlight saved to Marked.');
  const other = await open('highlight', passage);
  await other.key(other.window.document.querySelector('textarea'), 'Escape');
  assert.deepEqual(other.sent.at(-1), { type: 'marked:cancel-highlight', token: 'note-1' });
  assert.deepEqual(other.told.at(-1), { marked: 'panel', close: true });
});

test('with nothing waiting for it, the panel asks to close', async () => {
  const page = await open('save', null);
  assert.equal(page.panel().children.length, 0);
  assert.deepEqual(page.told, [{ marked: 'panel', close: true }]);
});
