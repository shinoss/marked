import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../save-panel.js', import.meta.url), 'utf8');
const tick = window => new Promise(resolve => window.setTimeout(resolve, 5));

// What background.js sends for a new page, as in its tests.
const offer = {
  type: 'marked:save-panel', token: 'token-1', edit: false, url: 'https://www.example.com/essays/attention', title: 'On attention',
  folders: [{ id: 'root', label: 'Library (top level)' }, { id: 'reading', label: '　Reading' }], folder: 'root',
  tags: ['Technology', 'AI', 'History'], chosen: ['AI'], note: '', abstract: 'Deciding what deserves it.', highlight: '', preview: true
};

// Runs the content script as browsers do: a classic script in the page's window,
// added by background.js. replies maps each message type to the background's answer.
function load(replies = {}) {
  const { window } = new JSDOM('<!DOCTYPE html><body><p>An essay.</p><input id="search"></body>', { url: 'https://www.example.com/essays/attention', runScripts: 'outside-only' });
  const page = { window, sent: [], heard: [] };
  window.chrome = { runtime: { id: 'marked', sendMessage: async message => { page.sent.push(JSON.parse(JSON.stringify(message))); return replies[message.type]; }, onMessage: { addListener: listener => { page.listen = listener; } } } };
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) { return page.shadow = attachShadow.call(this, init); };
  // The page's own handlers, which should never hear what happens in the panel.
  for (const type of ['keydown', 'click', 'input']) window.document.addEventListener(type, event => page.heard.push(event.type));
  window.eval(source);
  page.open = (details = {}) => { let answer; page.listen({ ...offer, ...details }, {}, value => { answer = value; }); return answer; };
  page.box = () => window.document.querySelector('marked-save') ? page.shadow.firstElementChild : null;
  page.field = name => [...page.shadow.querySelectorAll('label')].find(label => label.firstChild.textContent === name)?.querySelector('input, textarea, select');
  page.buttons = selector => [...page.shadow.querySelectorAll(selector ?? 'button')];
  page.click = async label => { page.buttons().find(button => button.textContent === label).click(); await tick(window); };
  page.key = async (target, key, init = {}) => { target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, composed: true, cancelable: true, ...init })); await tick(window); };
  page.type = (target, value) => { target.value = value; target.dispatchEvent(new window.Event('input', { bubbles: true, composed: true })); };
  return page;
}

test('Add to Marked opens a panel on the page, filled in, with the name ready to type', () => {
  const page = load();
  page.window.document.getElementById('search').focus();
  assert.equal(page.box(), null, 'nothing shows until Marked asks');
  assert.equal(page.open(), true);
  const box = page.box();
  assert.equal(box.getAttribute('role'), 'dialog');
  assert.equal(box.getAttribute('aria-label'), 'Add to Marked');
  assert.match(box.textContent, /^Add to Marked\s*example\.com\/essays\/attention/);
  const name = page.field('Name');
  assert.equal(name.value, 'On attention');
  assert.equal(page.shadow.activeElement, name);
  assert.deepEqual([name.selectionStart, name.selectionEnd], [0, 'On attention'.length], 'typing replaces the name');
  const folder = page.field('Folder');
  assert.deepEqual([...folder.options].map(option => [option.value, option.textContent]), [['root', 'Library (top level)'], ['reading', '　Reading']]);
  assert.equal(folder.value, 'root');
  assert.deepEqual(page.buttons('[aria-label="Tags"] button').map(chip => [chip.textContent, chip.getAttribute('aria-pressed')]), [['Technology', 'false'], ['AI', 'true'], ['History', 'false']]);
  assert.equal(page.field('Abstract').value, 'Deciding what deserves it.');
  assert.equal(page.field('Note').value, '');
  assert.equal(page.shadow.querySelector('input[type="checkbox"]').checked, true, 'Save preview, ticked as in the editor');
  assert.match(box.textContent, /Includes visible page content\. Stored only in Marked\./);
  assert.equal(page.shadow.querySelector('img'), null, 'the preview itself stays in Marked');
  assert.deepEqual(page.buttons().slice(-2).map(button => button.textContent), ['Cancel', 'Save']);
});

test('Save hands back what the user chose, then says so and gives the focus back to the page', async () => {
  const page = load({ 'marked:save-page': { ok: true } });
  const search = page.window.document.getElementById('search');
  search.focus();
  page.open();
  page.type(page.field('Name'), '  Attention, briefly ');
  page.field('Folder').value = 'reading';
  page.type(page.field('Note'), 'Read before the weekly review.');
  await page.click('Technology');
  await page.click('AI');
  const newTag = page.shadow.querySelector('[aria-label="New tag"]');
  page.type(newTag, ' Essays,  focus ');
  await page.key(newTag, 'Enter');
  assert.equal(page.buttons('[aria-label="Tags"] button').at(-1).textContent, 'Essays focus', 'commas can’t be in a tag');
  page.type(newTag, 'history');
  page.type(page.field('Abstract'), 'Edited.');
  page.shadow.querySelector('input[type="checkbox"]').click();
  await page.click('Save');
  assert.deepEqual(page.sent, [{ type: 'marked:save-page', token: 'token-1', title: 'Attention, briefly', parentId: 'reading', note: 'Read before the weekly review.', tags: ['Technology', 'Essays focus', 'History'], abstract: 'Edited.', preview: false }],
    'a tag typed but not yet added counts, spelled as the library spells it');
  assert.equal(page.box().textContent, 'Saved to Marked.');
  assert.equal(page.box().getAttribute('role'), 'status');
  assert.equal(page.window.document.activeElement, search, 'back where the user was');
  assert.deepEqual(page.heard, [], 'the page never heard the clicks, keys, or typing');
});

test('Enter in the name saves, Ctrl+Enter saves from anywhere, and Escape cancels', async () => {
  const page = load({ 'marked:save-page': { ok: true } });
  page.open();
  await page.key(page.field('Name'), 'Enter', { isComposing: true });
  assert.deepEqual(page.sent, [], 'not while an input method is composing');
  await page.key(page.field('Name'), 'Enter');
  assert.equal(page.sent.at(-1).type, 'marked:save-page');
  page.open({ token: 'token-2' });
  await page.key(page.field('Note'), 'Enter');
  assert.equal(page.sent.length, 1, 'Enter in the note is a new line');
  await page.key(page.field('Note'), 'Enter', { ctrlKey: true });
  assert.equal(page.sent.at(-1).token, 'token-2');
  page.open({ token: 'token-3' });
  await page.key(page.field('Abstract'), 'Escape');
  assert.equal(page.box(), null);
  assert.deepEqual(page.sent.at(-1), { type: 'marked:cancel-save', token: 'token-3' });
});

test('a failed save shows why in the panel and can be tried again; an empty name is refused', async () => {
  const replies = { 'marked:save-page': { error: 'This panel is out of date. Save the page again.' } };
  const page = load(replies);
  page.open();
  page.type(page.field('Name'), '   ');
  await page.click('Save');
  assert.deepEqual(page.sent, []);
  assert.match(page.shadow.querySelector('[role="alert"]').textContent, /^Enter a name\.$/);
  page.type(page.field('Name'), 'On attention');
  await page.click('Save');
  assert.match(page.box().textContent, /This panel is out of date\. Save the page again\./);
  const save = page.buttons().at(-1);
  assert.deepEqual([save.textContent, save.disabled], ['Save', false]);
  replies['marked:save-page'] = undefined;
  await page.click('Save');
  assert.match(page.box().textContent, /Marked could not save this page\. Try again\./, 'when Marked doesn’t answer');
  await page.click('Cancel');
  assert.equal(page.box(), null);
  assert.deepEqual(page.sent.at(-1), { type: 'marked:cancel-save', token: 'token-1' });
});

test('on a page already in Marked, the panel edits its bookmark', () => {
  const page = load();
  page.open({ edit: true, title: 'On attention', note: 'Kept for the review.', chosen: ['History'], folder: 'reading', preview: false });
  assert.equal(page.box().getAttribute('aria-label'), 'Edit bookmark');
  assert.match(page.box().textContent, /^Edit bookmark/);
  assert.equal(page.field('Note').value, 'Kept for the review.');
  assert.equal(page.field('Folder').value, 'reading');
  assert.deepEqual(page.buttons('[aria-pressed="true"]').map(chip => chip.textContent), ['History']);
  assert.equal(page.shadow.querySelector('input[type="checkbox"]'), null, 'no new preview to keep');
});

test('a passage highlighted on a new page comes with it, in the color the user picks, with its own note', async () => {
  const page = load({ 'marked:save-page': { ok: true } });
  page.open({ highlight: 'Attention is the one budget that never grows.' });
  assert.match(page.box().textContent, /HighlightAttention is the one budget that never grows\./);
  const swatch = color => page.shadow.querySelector(`[data-color="${color}"]`);
  assert.equal(swatch('yellow').getAttribute('aria-pressed'), 'true');
  swatch('blue').click();
  assert.deepEqual([swatch('blue').getAttribute('aria-pressed'), swatch('yellow').getAttribute('aria-pressed')], ['true', 'false']);
  page.type(page.field('Note on this highlight'), 'The key line.');
  await page.click('Save');
  assert.deepEqual(page.sent.at(-1).highlight, { color: 'blue', note: 'The key line.' });
});

test('saving again replaces the panel; an older copy of Marked’s panel goes', () => {
  const page = load();
  const stale = page.window.document.createElement('marked-save');
  page.window.document.documentElement.append(stale);
  page.open();
  page.open({ token: 'token-2', title: 'Another page' });
  assert.deepEqual([...page.window.document.querySelectorAll('marked-save')].length, 1);
  assert.equal(page.field('Name').value, 'Another page');
});
