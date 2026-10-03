import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../src/save-panel.js', import.meta.url), 'utf8');
const ORIGIN = 'moz-extension://marked';

// Runs the content script as browsers do: a classic script in the page's window,
// added by background.js. Its timers wait until a test runs them.
// Chrome may serve the panel at a per-session address (address) instead of
// Marked's own, which it keeps as the panel's origin.
function load({ address = ORIGIN } = {}) {
  const { window } = new JSDOM('<!DOCTYPE html><body><p>An essay.</p><input id="search"></body>', { url: 'https://www.example.com/essays/attention', runScripts: 'outside-only' });
  const page = { window, answers: [], timers: [] };
  window.chrome = { runtime: { id: 'marked', getURL: path => `${path === 'panel.html' ? address : ORIGIN}/${path}`, onMessage: { addListener: listener => { page.listen = listener; } } } };
  window.setTimeout = (run, ms) => page.timers.push({ run, ms });
  window.clearTimeout = id => { if (page.timers[id - 1]) page.timers[id - 1].run = null; };
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) { return page.shadow = attachShadow.call(this, init); };
  window.eval(source);
  // panel.html in the frame (JSDOM loads no frames, so a window stands in for it).
  const panel = new JSDOM('', { url: `${ORIGIN}/panel.html` }).window;
  page.open = (details = {}) => {
    const answering = page.listen({ type: 'marked:show-panel', kind: 'save', ...details }, {}, answer => page.answers.push(answer));
    Object.defineProperty(page.frame(), 'contentWindow', { value: panel, configurable: true });
    return answering;
  };
  page.host = () => window.document.querySelector('marked-save');
  page.frame = () => page.host() ? page.shadow.querySelector('iframe') : null;
  // What the panel tells the page it's on, as panel.js does.
  page.tell = (data, { from = panel, origin = ORIGIN } = {}) => window.dispatchEvent(new window.MessageEvent('message', { data: { marked: 'panel', ...data }, source: from, origin }));
  page.wait = ms => { for (const timer of page.timers.filter(timer => timer.ms === ms && timer.run)) { const { run } = timer; timer.run = null; run(); } };
  return page;
}

test('the panel is Marked’s own page in a frame: nothing on the page takes what the user types', () => {
  const page = load();
  assert.equal(page.open(), true, 'Marked hears back once the panel shows');
  const frame = page.frame();
  assert.equal(frame.src, `${ORIGIN}/panel.html#save`);
  assert.equal(page.shadow.children.length, 1, 'the frame, and nothing else, in a closed shadow root');
  assert.equal(page.window.document.querySelectorAll('input, textarea, select, [contenteditable]').length, 1, 'the page’s own search field only');
  assert.equal(page.shadow.querySelectorAll('input, textarea, select, [contenteditable]').length, 0);
  assert.equal(frame.style.visibility, 'hidden', 'nothing shows until the panel is ready');
  assert.deepEqual(page.answers, []);
});

test('once the panel says how tall it is, the frame shows at the top right, takes the focus, and Marked hears back', () => {
  const page = load();
  page.window.document.getElementById('search').focus();
  page.open();
  page.tell({ height: 400 });
  const frame = page.frame();
  assert.deepEqual([frame.style.visibility, frame.style.height, frame.style.top, frame.style.right, frame.style.width], ['visible', '402px', '16px', '16px', '340px']);
  assert.equal(page.shadow.activeElement, frame, 'typing goes to the panel');
  assert.deepEqual(page.answers, [true]);
  page.tell({ height: 5000 });
  assert.equal(frame.style.height, `${768 - 32}px`, 'never taller than the window');
  assert.deepEqual(page.answers, [true], 'answered once');
});

test('in Chrome the panel loads at an address that changes every session, and is heard from Marked’s own origin', () => {
  const page = load({ address: 'chrome-extension://8bcd6fc5-4451-4270-bc81-e8e65b063beb' });
  page.open();
  assert.equal(page.frame().src, 'chrome-extension://8bcd6fc5-4451-4270-bc81-e8e65b063beb/panel.html#save');
  page.tell({ height: 100 }, { origin: 'chrome-extension://8bcd6fc5-4451-4270-bc81-e8e65b063beb' });
  assert.deepEqual(page.answers, [], 'the address isn’t the panel’s origin');
  page.tell({ height: 100 });
  assert.deepEqual(page.answers, [true]);
});

test('only the panel in the frame is heard: not the page, nor a frame the page sent elsewhere', () => {
  const page = load();
  page.open();
  page.tell({ height: 100 }, { from: page.window });
  page.tell({ height: 100 }, { origin: 'https://www.example.com' });
  page.window.dispatchEvent(new page.window.MessageEvent('message', { data: { height: 100 }, source: page.frame().contentWindow, origin: ORIGIN }));
  assert.equal(page.frame().style.visibility, 'hidden');
  assert.deepEqual(page.answers, []);
  page.tell({ close: true }, { from: page.window });
  assert.ok(page.frame(), 'the page can’t close it by pretending');
  // The page can send the frame to another address; then the panel goes.
  page.tell({ height: 100 });
  page.frame().dispatchEvent(new page.window.Event('load'));
  assert.ok(page.frame());
  page.frame().dispatchEvent(new page.window.Event('load'));
  assert.equal(page.frame(), null);
});

test('a panel whose frame never loads goes, and Marked is told it didn’t show', () => {
  const page = load();
  page.open();
  page.wait(5000);
  assert.equal(page.host(), null);
  assert.deepEqual(page.answers, [false]);
  // A panel with nothing to show closes before it shows.
  page.open();
  page.tell({ close: true });
  assert.equal(page.host(), null);
  assert.deepEqual(page.answers, [false, false]);
});

test('saved, the page gets its focus back at once and the panel goes a moment later; closed, it goes at once', () => {
  const page = load();
  const search = page.window.document.getElementById('search');
  search.focus();
  page.open();
  page.tell({ height: 300 });
  assert.equal(page.window.document.activeElement, page.host());
  page.tell({ done: true });
  assert.equal(page.window.document.activeElement, search, 'back where the user was');
  assert.ok(page.frame(), 'the panel still says it saved');
  page.wait(2500);
  assert.equal(page.host(), null);
  page.open();
  page.tell({ height: 300 });
  page.tell({ close: true });
  assert.equal(page.host(), null);
  assert.equal(page.window.document.activeElement, search);
});

test('the note panel goes beside its passage: below it, or above it near the bottom of the window', () => {
  const page = load();
  page.open({ kind: 'highlight', anchor: { top: 100, bottom: 120, right: 500 } });
  assert.equal(page.frame().src, `${ORIGIN}/panel.html#highlight`);
  page.tell({ height: 198 });
  const frame = page.frame();
  assert.deepEqual([frame.style.width, frame.style.height, frame.style.top, frame.style.left], ['320px', '200px', '128px', '340px']);
  page.open({ kind: 'highlight', anchor: { top: 700, bottom: 720, right: 1000 } });
  page.tell({ height: 198 });
  assert.deepEqual([page.frame().style.top, page.frame().style.left], ['492px', '700px']);
});

test('opening again puts the new panel in the old one’s place; an older copy of Marked’s panel goes', () => {
  const page = load();
  const stale = page.window.document.createElement('marked-save');
  page.window.document.documentElement.append(stale);
  page.open();
  page.open({ kind: 'highlight', anchor: { top: 10, bottom: 20, right: 30 } });
  assert.deepEqual(page.answers, [true], 'the first counts as shown: the second shows in its place');
  assert.equal(page.window.document.querySelectorAll('marked-save').length, 1);
  assert.equal(page.shadow.querySelectorAll('iframe').length, 1);
  assert.equal(page.frame().src, `${ORIGIN}/panel.html#highlight`);
  page.tell({ height: 50 });
  assert.deepEqual(page.answers, [true, true]);
  assert.equal(page.listen({ type: 'other' }, {}, () => {}), undefined, 'other messages are left alone');
});
