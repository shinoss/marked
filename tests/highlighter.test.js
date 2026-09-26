import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../highlighter.js', import.meta.url), 'utf8');
const tick = window => new Promise(resolve => window.setTimeout(resolve, 5));

// Runs the content script as browsers do: a classic script in the page's window.
// replies maps each message type to the background's answer.
function load(body, replies = {}) {
  const { window } = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { url: 'https://example.com/article', runScripts: 'outside-only' });
  const page = { window, sent: [] };
  window.chrome = { runtime: { sendMessage: async message => { page.sent.push(JSON.parse(JSON.stringify(message))); return replies[message.type]; }, onMessage: { addListener: listener => { page.listen = listener; } } } };
  const attachShadow = window.Element.prototype.attachShadow;
  // The first shadow root is the Highlight box; a note card may follow.
  window.Element.prototype.attachShadow = function (init) { const shadow = attachShadow.call(this, init); (page.shadows ??= []).push(shadow); page.shadow ??= shadow; return shadow; };
  window.eval(source);
  page.select = (selector, collapse = false) => {
    const range = window.document.createRange();
    range.selectNodeContents(window.document.querySelector(selector));
    if (collapse) range.collapse();
    window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
  };
  page.mouseup = async target => {
    (target ? window.document.querySelector(target) : window.document.body).dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, composed: true }));
    await tick(window);
  };
  page.box = () => window.document.querySelector('marked-highlighter') ? page.shadow.firstElementChild : null;
  page.buttons = () => [...page.box().querySelectorAll('button')].map(button => button.textContent);
  page.click = async label => { [...page.box().querySelectorAll('button')].find(button => button.textContent === label).click(); await tick(window); };
  return page;
}

test('on a saved page, Highlight opens a panel on the page that saves the passage and a note', async () => {
  const page = load('<p id="text">A passage worth keeping.</p>', { 'marked:highlight': { saved: 'The essay' }, 'marked:save-highlight': { ok: true } });
  assert.equal(page.box(), null, 'nothing shows before a selection');
  page.select('#text'); await page.mouseup('#text');
  assert.deepEqual(page.buttons(), ['Highlight'], 'one option, not separate highlight and note');
  await page.click('Highlight');
  assert.deepEqual(page.sent, [{ type: 'marked:page-highlights', topics: { title: '', description: '', headings: [], lead: '' } }, { type: 'marked:highlight', text: 'A passage worth keeping.' }], 'the page asks for its saved passages once, on load');
  assert.match(page.box().textContent, /On “The essay”/);
  assert.match(page.box().textContent, /A passage worth keeping\./);
  assert.deepEqual(page.buttons(), ['', '', '', '', '', 'Cancel', 'Save highlight'], 'five color swatches, then the actions');
  const swatch = color => page.box().querySelector(`[data-color="${color}"]`);
  assert.equal(swatch('yellow').getAttribute('aria-pressed'), 'true', 'yellow unless another is chosen');
  const note = page.box().querySelector('textarea');
  assert.equal(page.shadow.activeElement, note, 'the note is ready to type');
  // The panel stays open while its own clicks and keys happen.
  await page.mouseup('#text');
  assert.ok(page.box().querySelector('textarea'));
  note.value = 'Quote this.';
  swatch('green').click();
  assert.deepEqual([swatch('green').getAttribute('aria-pressed'), swatch('yellow').getAttribute('aria-pressed')], ['true', 'false']);
  await page.click('Save highlight');
  assert.deepEqual(page.sent.at(-1), { type: 'marked:save-highlight', text: 'A passage worth keeping.', note: 'Quote this.', color: 'green' });
  assert.equal(page.box().textContent, 'Highlight saved to Marked.');
  const marked = page.window.document.querySelector('marked-highlight');
  assert.equal(marked.textContent, 'A passage worth keeping.', 'the new highlight shows at once');
  assert.match(marked.style.background, /92, 201, 138/, 'in its color');
});

test('on a new page, Highlight hands off to Marked and closes; failures are shown in the panel', async () => {
  const page = load('<p id="text">Words</p>', { 'marked:highlight': { opened: true } });
  page.select('#text'); await page.mouseup('#text');
  await page.click('Highlight');
  assert.equal(page.box(), null, "Marked's editor opened instead");
  const failing = load('<p id="text">Words</p>', { 'marked:highlight': { saved: 'Page' }, 'marked:save-highlight': { error: 'This page is no longer in Marked.' } });
  failing.select('#text'); await failing.mouseup('#text');
  await failing.click('Highlight');
  await failing.click('Save highlight');
  assert.match(failing.box().textContent, /This page is no longer in Marked\./);
  await failing.click('Cancel');
  assert.equal(failing.box(), null);
});

test('ignores empty selections and text in form fields or editable areas, and hides on a click elsewhere', async () => {
  const page = load('<p id="text">Words</p><div contenteditable id="editor">Draft text</div><p id="blank">   </p>');
  for (const selector of ['#editor', '#blank']) {
    page.select(selector); await page.mouseup(selector);
    assert.equal(page.box(), null, selector);
  }
  page.select('#text'); await page.mouseup('#text');
  assert.ok(page.box());
  page.select('#text', true); await page.mouseup('#text');
  assert.equal(page.box(), null, 'a collapsed selection hides the button');
  assert.deepEqual(page.sent.map(message => message.type), ['marked:page-highlights']);
});

test('saved passages are marked again when the page opens; notes show only in Marked’s own box', async () => {
  const page = load('<p>Some <b>bold</b> words across\n   lines.</p><p>Second paragraph starts here.</p><p id="late"></p>', {
    'marked:page-highlights': { highlights: [
      { id: '1', text: 'bold words across lines. Second paragraph', note: 'A private thought' },
      { id: '2', text: 'starts here.' },
      { id: '3', text: 'Loaded later' }
    ] }
  });
  await tick(page.window);
  const document = page.window.document;
  const marks = () => [...document.querySelectorAll('marked-highlight')].map(mark => mark.textContent);
  assert.deepEqual(marks(), ['bold', ' words across\n   lines.', 'Second paragraph', 'starts here.'], 'found across elements, lines, and paragraphs, with the spaces between');
  assert.equal(document.body.textContent, 'Some bold words across\n   lines.Second paragraph starts here.', 'the page text is unchanged');
  const first = document.querySelector('marked-highlight');
  first.dispatchEvent(new page.window.MouseEvent('mouseenter'));
  assert.ok(document.querySelector('marked-note'));
  assert.match(page.shadows.at(-1).textContent, /Your note in Marked\s*A private thought/);
  assert.ok(!document.documentElement.outerHTML.includes('A private thought'), 'the note never enters the page');
  first.dispatchEvent(new page.window.MouseEvent('mouseleave'));
  assert.equal(document.querySelector('marked-note'), null);
  document.querySelectorAll('marked-highlight')[3].dispatchEvent(new page.window.MouseEvent('mouseenter'));
  assert.equal(page.shadows.at(-1).textContent, 'Highlighted in Marked');
  // A page that adds its text after loading is searched again.
  document.getElementById('late').textContent = 'Loaded later, by a script.';
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(marks().at(-1), 'Loaded later');
});

test('a page that hasn’t changed isn’t searched again for a missing passage, and editable text is never marked', async () => {
  const page = load('<div contenteditable="true">Kept <i>words</i></div><p>Other words</p>', { 'marked:page-highlights': { highlights: [{ id: '1', text: 'Kept words' }] } });
  const document = page.window.document;
  let walks = 0;
  const createTreeWalker = document.createTreeWalker.bind(document);
  document.createTreeWalker = (...args) => { walks++; return createTreeWalker(...args); };
  await tick(page.window);
  assert.equal(walks, 1);
  assert.equal(document.querySelector('marked-highlight'), null, 'not in an editable area');
  await new Promise(resolve => setTimeout(resolve, 1600));
  assert.equal(walks, 1, 'the same page has nothing new to find');
});

test('the shortcut highlights the selection, or asks for one', async () => {
  const page = load('<p id="text">Pressed, not clicked.</p>', { 'marked:highlight': { saved: 'The essay' } });
  await tick(page.window);
  const replies = [];
  page.listen({ type: 'marked:highlight-selection' }, {}, reply => replies.push(reply));
  assert.equal(page.box().textContent, 'Select some text, then press the shortcut again.');
  page.select('#text');
  page.listen({ type: 'marked:highlight-selection' }, {}, reply => replies.push(reply));
  await tick(page.window);
  assert.deepEqual(page.sent.at(-1), { type: 'marked:highlight', text: 'Pressed, not clicked.' });
  assert.match(page.box().textContent, /On “The essay”/, 'the panel opens, as from the Highlight button');
  assert.deepEqual(replies, [true, true]);
  assert.equal(page.listen({ type: 'other' }, {}, () => {}), undefined, 'other messages are left alone');
});

test('saved passages keep their colors', async () => {
  const page = load('<p>Green words and blue words.</p>', { 'marked:page-highlights': { highlights: [{ id: '1', text: 'Green words', color: 'green' }, { id: '2', text: 'blue words', color: 'blue' }, { id: '3', text: 'and' }] } });
  await tick(page.window);
  assert.deepEqual([...page.window.document.querySelectorAll('marked-highlight')].map(mark => [mark.textContent, mark.style.background.match(/\d+, \d+, \d+/)[0]]), [['Green words', '92, 201, 138'], ['and', '255, 221, 0'], ['blue words', '91, 157, 240']]);
});

test('on load, the page says what it is about: title, description, main headings, and opening paragraphs', async () => {
  const opening = 'Attention is what we give to the few things that deserve it, and withhold from the rest.';
  const page = load(`<title>On attention · Essays</title><meta name="description" content="Deciding what deserves it."><nav><h2>Contents</h2><p>${'A menu entry that is long enough to count as a paragraph, but sits in a menu. '.repeat(2)}</p></nav><main><h1>On attention</h1><p>Short.</p><p>${opening}</p><h2>Why it matters</h2><h3>Too deep</h3></main>`);
  await tick(page.window);
  assert.deepEqual(page.sent[0], { type: 'marked:page-highlights', topics: { title: 'On attention · Essays', description: 'Deciding what deserves it.', headings: ['On attention', 'Why it matters'], lead: opening } });
});

// Access to the pages you visit can be taken back in Marked while the page is open.
test('taken back, a page drops its marks and stops offering Highlight; given again, the marks return', async () => {
  const page = load('<p id="text">Green words and blue words.</p>', { 'marked:page-highlights': { highlights: [{ id: '1', text: 'Green words', color: 'green', note: 'A note.' }] } });
  await tick(page.window);
  const paragraph = page.window.document.getElementById('text');
  const marks = () => page.window.document.querySelectorAll('marked-highlight').length;
  assert.equal(marks(), 1);
  let answered = false;
  page.listen({ type: 'marked:page-access', allowed: false }, {}, () => { answered = true; });
  assert.ok(answered);
  assert.equal(marks(), 0);
  assert.deepEqual([paragraph.textContent, paragraph.childNodes.length], ['Green words and blue words.', 1], 'the text is whole again');
  page.select('#text'); await page.mouseup('#text');
  assert.equal(page.box(), null, 'no Highlight button without access');

  page.listen({ type: 'marked:page-access', allowed: true }, {}, () => {});
  await tick(page.window);
  assert.equal(marks(), 1, 'marked again');
  page.select('#text'); await page.mouseup('#text');
  assert.deepEqual(page.buttons(), ['Highlight']);
});
