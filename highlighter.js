// Content script for every http(s) page, registered by background.js once the
// user allows Marked on the pages they visit. When the page opens it tells
// background.js what the page is about (its title, description, headings, and
// opening paragraphs, for the related count) and marks the passages saved on it
// before. When the user selects text it shows a Highlight button beside the
// selection; the selection is read only when they click it. On a page already
// in Marked, the highlight and an optional note are added right here in a small
// panel; a new page opens Marked's editor, as Add to Marked does. Nothing it
// reads leaves the browser. Content scripts are classic scripts, not modules;
// tests evaluate this file in a JSDOM window.

// Selected text worth highlighting, or '' for none or text inside form fields.
function selectedText(selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return '';
  const node = selection.anchorNode;
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  if (document.designMode === 'on' || element?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return '';
  const text = selection.toString();
  return text.trim() ? text : '';
}

// The page's text without whitespace, so a passage matches however the page
// breaks it into lines, paragraphs, and elements, with where each text node
// starts in it. Long pages have tens of thousands of text nodes, so elements
// are checked once each and characters are found only where a passage is.
function pageText(root) {
  // Text in these is never marked. (Not a top-level const: this file can be
  // injected again into a page that has it.)
  const UNMARKED = 'script, style, noscript, textarea, select, marked-highlighter, marked-note, [contenteditable]:not([contenteditable="false"])';
  const segments = [], chunks = [];
  let length = 0;
  if (root.closest(UNMARKED)) return { text: '', segments };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : node.matches(UNMARKED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
  });
  for (let node; (node = walker.nextNode());) {
    const chunk = node.data.replace(/\s+/g, '');
    if (chunk) { segments.push({ node, start: length, length: chunk.length }); chunks.push(chunk); length += chunk.length; }
  }
  return { text: chunks.join(''), segments };
}
// Where the nth character that isn't a space is in data.
function nonSpaceOffset(data, n) {
  for (let i = 0; i < data.length; i++) if (!/\s/.test(data[i]) && n-- === 0) return i;
  return data.length;
}
// The pieces of text nodes that hold passage, in page order, or [] if it isn't there.
function locate(page, passage) {
  const needle = String(passage).replace(/\s+/g, '');
  const at = needle ? page.text.indexOf(needle) : -1;
  if (at < 0) return [];
  const end = at + needle.length, pieces = [], { segments } = page;
  // The last segment starting at or before the passage holds its start.
  let low = 0, high = segments.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (segments[middle].start <= at) low = middle; else high = middle - 1;
  }
  for (let order = low; order < segments.length && segments[order].start < end; order++) {
    const { node, start, length } = segments[order];
    // Spaces between the pieces are marked too, so the passage reads as one highlight.
    const from = start <= at ? nonSpaceOffset(node.data, at - start) : 0;
    const to = start + length >= end ? nonSpaceOffset(node.data, end - 1 - start) + 1 : node.data.length;
    pieces.push({ node, from, to, order });
  }
  return pieces;
}

if (!globalThis.markedHighlighter) {
  globalThis.markedHighlighter = true;
  const api = globalThis.browser ?? globalThis.chrome;
  // A closed shadow root keeps the page's CSS out; CSSOM styles are not subject
  // to the page's Content Security Policy.
  const host = document.createElement('marked-highlighter');
  const box = host.attachShadow({ mode: 'closed' }).appendChild(document.createElement('div'));
  const BOX = 'all:initial;position:fixed;z-index:2147483647;box-sizing:border-box;border:1px solid #0f1419;border-radius:4px;background:#fff;color:#0f1419;box-shadow:0 2px 8px rgba(0,0,0,.15);font:13px/1.4 system-ui,sans-serif;direction:ltr';
  const make = (tag, style, text) => {
    const element = document.createElement(tag);
    element.style.cssText = style;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const button = (label, primary, action) => {
    const element = make('button', `all:initial;cursor:pointer;padding:6px 10px;border-radius:3px;font:inherit;${primary ? 'background:#0f1419;color:#fff' : 'color:#0f1419'}`, label);
    element.type = 'button';
    // Hover sets values rather than clearing them: a cleared value would drop the
    // all:initial reset and show the browser's button color, dark on dark pages.
    element.addEventListener('mouseenter', () => { element.style.opacity = '.8'; if (!primary) element.style.background = '#f0f0f0'; });
    element.addEventListener('mouseleave', () => { element.style.opacity = '1'; if (!primary) element.style.background = 'transparent'; });
    element.addEventListener('click', action);
    return element;
  };
  // Highlight colors: a swatch and border shade, and the tint marked on the page.
  const EDGE = { yellow: '#f2d94e', green: '#5cc98a', blue: '#5b9df0', pink: '#f07aa9', purple: '#a384f0' };
  const TINT = { yellow: 'rgba(255,221,0,.45)', green: 'rgba(92,201,138,.4)', blue: 'rgba(91,157,240,.35)', pink: 'rgba(240,122,169,.35)', purple: 'rgba(163,132,240,.35)' };
  // Keys typed in the panel stay out of the page's keyboard shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, event => event.stopPropagation());
  // allowed: whether the user lets Marked read the pages they visit. Taken back,
  // the page goes back to how it was until access is given again.
  let text = '', panel = false, anchor = null, closing, allowed = true;

  const close = () => { host.remove(); panel = false; };
  // Beside the end of the selection: below it, or above it near the bottom of the window.
  const place = () => {
    const { width, height } = box.getBoundingClientRect();
    const top = anchor.bottom + 8 + height > innerHeight ? anchor.top - height - 8 : anchor.bottom + 8;
    box.style.top = `${Math.max(4, top)}px`;
    box.style.left = `${Math.max(4, Math.min(anchor.right - width / 2, innerWidth - width - 4))}px`;
  };
  const say = message => {
    box.style.cssText = BOX;
    box.replaceChildren(make('div', 'padding:8px 12px', message));
    place();
    closing = setTimeout(close, 2500);
  };

  function showPanel(title) {
    panel = true;
    box.style.cssText = `${BOX};width:320px;padding:12px`;
    const note = make('textarea', 'all:initial;box-sizing:border-box;display:block;width:100%;min-height:64px;padding:6px 8px;border:1px solid #cfd9de;border-radius:3px;background:#fff;color:inherit;font:inherit;white-space:pre-wrap;resize:vertical');
    note.placeholder = 'Add a note (optional)';
    note.maxLength = 2000;
    note.addEventListener('focus', () => { note.style.borderColor = '#0f1419'; });
    note.addEventListener('blur', () => { note.style.borderColor = '#cfd9de'; });
    const error = make('div', 'color:#b00020;margin-top:6px');
    let color = 'yellow';
    const quote = make('div', `margin:10px 0;padding:2px 0 2px 10px;border-left:3px solid ${EDGE.yellow};max-height:96px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere`, text.trim());
    const swatches = make('div', 'display:flex;gap:8px;margin:0 0 10px 2px');
    swatches.setAttribute('role', 'group');
    swatches.setAttribute('aria-label', 'Color');
    const choose = name => {
      color = name;
      quote.style.borderLeftColor = EDGE[name];
      for (const swatch of swatches.children) {
        const chosen = swatch.dataset.color === name;
        swatch.setAttribute('aria-pressed', String(chosen));
        swatch.style.boxShadow = `0 0 0 2px #fff, 0 0 0 3px ${chosen ? '#0f1419' : 'transparent'}`;
      }
    };
    for (const name of Object.keys(EDGE)) {
      const swatch = make('button', `all:initial;cursor:pointer;width:16px;height:16px;border-radius:50%;background:${EDGE[name]}`);
      swatch.type = 'button';
      swatch.dataset.color = name;
      swatch.title = name[0].toUpperCase() + name.slice(1);
      swatch.setAttribute('aria-label', swatch.title);
      swatch.addEventListener('click', () => { choose(name); note.focus(); });
      swatches.append(swatch);
    }
    choose(color);
    const save = async () => {
      saveButton.disabled = true;
      let reply;
      try { reply = await api.runtime.sendMessage({ type: 'marked:save-highlight', text, note: note.value, color }); } catch {}
      if (reply?.ok) { say('Highlight saved to Marked.'); markPassages([{ text, note: note.value.trim(), color }]); }
      else { error.textContent = reply?.error || 'Marked could not save the highlight. Try again.'; saveButton.disabled = false; }
    };
    const saveButton = button('Save highlight', true, save);
    const actions = make('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px');
    actions.append(button('Cancel', false, close), saveButton);
    box.replaceChildren(
      make('div', 'font-weight:600', 'Highlight'),
      make('div', 'color:#536471;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', `On “${title}”`),
      quote, swatches, note, error, actions
    );
    note.addEventListener('keydown', event => {
      if (event.key === 'Escape') close();
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) save();
    });
    place();
    note.focus();
  }

  const highlight = async () => {
    let reply;
    try { reply = await api.runtime.sendMessage({ type: 'marked:highlight', text }); } catch {}
    if (reply?.saved) showPanel(reply.saved);
    else if (reply?.opened) close();
    else say('Marked is unavailable here. Reload the page and try again.');
  };

  const show = () => {
    const selection = getSelection();
    text = selectedText(selection);
    clearTimeout(closing);
    if (!text) { close(); return; }
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects?.() ?? [];
    anchor = rects[rects.length - 1] ?? range.getBoundingClientRect?.() ?? { top: 0, bottom: 0, right: 0 };
    box.style.cssText = `${BOX};display:flex`;
    const start = button('Highlight', false, highlight);
    // Keep the page's selection when the button is pressed.
    start.addEventListener('mousedown', event => event.preventDefault());
    box.replaceChildren(start);
    document.documentElement.append(host);
    place();
  };
  // Alt+Shift+H, a Marked shortcut that background.js passes on, highlights the
  // selection as the Highlight button would.
  api.runtime.onMessage?.addListener((message, sender, reply) => {
    // Access to the pages you visit given again, or taken back, in Marked.
    if (message?.type === 'marked:page-access') {
      reply(true);
      allowed = !!message.allowed;
      if (allowed) arrive(); else standDown();
      return;
    }
    // The shortcut is the user's own request for this tab, so it works either way.
    if (message?.type !== 'marked:highlight-selection') return;
    reply(true);
    if (panel) return;
    const selection = getSelection();
    text = selectedText(selection);
    clearTimeout(closing);
    document.documentElement.append(host);
    if (!text) {
      anchor = { top: 12, bottom: 12, right: innerWidth / 2 };
      say('Select some text, then press the shortcut again.');
      return;
    }
    const range = selection.getRangeAt(0);
    const rects = range.getClientRects?.() ?? [];
    anchor = rects[rects.length - 1] ?? range.getBoundingClientRect?.() ?? { top: 0, bottom: 0, right: 0 };
    highlight();
  });
  // An open panel stays until it is saved or cancelled.
  const later = event => { if (allowed && !panel && !event.composedPath().includes(host)) setTimeout(show, 0); };
  document.addEventListener('mouseup', later, true);
  document.addEventListener('keyup', event => { if (event.shiftKey || event.key === 'Shift') later(event); }, true);
  document.addEventListener('selectionchange', () => { if (!panel && getSelection()?.isCollapsed) close(); });
  addEventListener('scroll', () => { if (!panel) close(); hideNote(); }, { capture: true, passive: true });

  // Saved passages, marked in their colors. Hovering one shows its note in
  // Marked's own closed box; notes are kept here, never in the page, so the
  // site's scripts can't read them.
  const mark = color => `all:unset;background:${TINT[color] || TINT.yellow};color:inherit;border-radius:2px`;
  const notes = new WeakMap();
  let noteHost = null, card = null;
  function hideNote() { noteHost?.remove(); }
  function showNote(mark) {
    if (!noteHost) {
      noteHost = document.createElement('marked-note');
      card = noteHost.attachShadow({ mode: 'closed' }).appendChild(document.createElement('div'));
    }
    const note = notes.get(mark);
    card.style.cssText = `${BOX};max-width:320px;padding:8px 10px;pointer-events:none`;
    card.replaceChildren(...(note
      ? [make('div', 'color:#536471;font-size:12px', 'Your note in Marked'), make('div', 'white-space:pre-wrap;overflow-wrap:anywhere', note)]
      : [make('div', 'color:#536471', 'Highlighted in Marked')]));
    document.documentElement.append(noteHost);
    const spot = mark.getClientRects()[0] ?? mark.getBoundingClientRect();
    const { width, height } = card.getBoundingClientRect();
    card.style.top = `${Math.max(4, spot.bottom + 6 + height > innerHeight ? spot.top - height - 6 : spot.bottom + 6)}px`;
    card.style.left = `${Math.max(4, Math.min(spot.left, innerWidth - width - 4))}px`;
  }
  // Marks each passage found on the page and returns the ones that aren't there yet.
  function markPassages(passages) {
    const page = pageText(document.body);
    const pieces = [], missing = [];
    for (const passage of passages) {
      const found = locate(page, passage.text);
      if (found.length) pieces.push(...found.map(piece => ({ ...piece, note: passage.note || '', color: passage.color })));
      else missing.push(passage);
    }
    // From the end of the page back, so splitting a text node keeps earlier offsets valid.
    pieces.sort((a, b) => b.order - a.order || b.from - a.from);
    for (const { node, from, to, note, color } of pieces) {
      if (to > node.data.length || node.parentElement?.closest('marked-highlight')) continue;
      const middle = node.splitText(from);
      middle.splitText(to - from);
      const marked = document.createElement('marked-highlight');
      marked.style.cssText = mark(color);
      middle.replaceWith(marked);
      marked.append(middle);
      notes.set(marked, note);
      marked.addEventListener('mouseenter', () => showNote(marked));
      marked.addEventListener('mouseleave', hideNote);
    }
    return missing;
  }
  // What the page is about, for Marked to count the saved bookmarks related to
  // it: its title, description, main headings, and opening paragraphs, leaving
  // out menus and sidebars. It stays in the browser.
  const aside = 'nav, aside, footer, [role="navigation"], [role="complementary"]';
  const words = element => element.textContent.replace(/\s+/g, ' ').trim();
  const topics = () => {
    const main = document.querySelector('main, [role="main"], article') || document.body;
    let lead = '';
    for (const paragraph of main?.querySelectorAll('p') || []) {
      if (lead.length >= 1000) break;
      if (!paragraph.closest(aside) && words(paragraph).length >= 60) lead += `${words(paragraph)} `;
    }
    return {
      title: document.title.slice(0, 300),
      description: (document.querySelector('meta[name="description" i], meta[property="og:description" i]')?.content || '').slice(0, 500),
      headings: [...document.querySelectorAll('h1, h2')].filter(heading => !heading.closest(aside)).slice(0, 8).map(heading => words(heading).slice(0, 150)).filter(Boolean),
      lead: lead.trim().slice(0, 1000)
    };
  };
  // Without access, the page goes back to how it was: no marks, no button, no note.
  function standDown() {
    close();
    hideNote();
    for (const marked of document.querySelectorAll('marked-highlight')) {
      const parent = marked.parentNode;
      marked.replaceWith(...marked.childNodes);
      parent?.normalize();
    }
  }
  // Tells Marked what the page is about and marks the passages saved on it.
  // Pages that build their text after loading get two more tries, each only if
  // the page changed since the last: another look at the same page finds nothing new.
  let arrivals = 0;
  async function arrive() {
    const arrival = ++arrivals;
    let reply;
    try { reply = await api.runtime.sendMessage({ type: 'marked:page-highlights', topics: topics() }); } catch { return; }
    let missing = reply?.highlights || [], changed = true;
    const watcher = new MutationObserver(() => { changed = true; });
    for (const wait of [0, 1500, 5000]) {
      if (!missing.length || !document.body) break;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      // Access taken back, or a newer arrival, ends this one.
      if (!allowed || arrival !== arrivals) break;
      if (!changed) continue;
      missing = markPassages(missing);
      // The marks just made aren't the page changing.
      watcher.takeRecords();
      changed = false;
      if (!wait) watcher.observe(document, { childList: true, characterData: true, subtree: true });
    }
    watcher.disconnect();
  }
  arrive();
}
