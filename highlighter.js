// Content script for every http(s) page, declared in manifest.json. When the
// user selects text it shows a Highlight button beside the selection; nothing
// is read or sent until the user clicks it. On a page already in Marked, the
// highlight and an optional note are added right here in a small panel; a new
// page opens Marked's editor, as Add to Marked does. Passages saved earlier are
// marked again when the page opens. Content scripts are classic scripts, not
// modules; tests evaluate this file in a JSDOM window.

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
// breaks it into lines, paragraphs, and elements, with where each character is.
function pageText(root) {
  const segments = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement?.closest('script, style, noscript, textarea, select, marked-highlighter, marked-note, [contenteditable]:not([contenteditable="false"])') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  for (let node; (node = walker.nextNode());) {
    const offsets = [];
    let chunk = '';
    for (let i = 0; i < node.data.length; i++) if (!/\s/.test(node.data[i])) { chunk += node.data[i]; offsets.push(i); }
    if (chunk) { segments.push({ node, start: text.length, offsets }); text += chunk; }
  }
  return { text, segments };
}
// The pieces of text nodes that hold passage, in page order, or [] if it isn't there.
function locate(page, passage) {
  const needle = String(passage).replace(/\s+/g, '');
  const at = needle ? page.text.indexOf(needle) : -1;
  if (at < 0) return [];
  const end = at + needle.length, pieces = [];
  page.segments.forEach((segment, order) => {
    const last = segment.start + segment.offsets.length;
    if (last <= at || segment.start >= end) return;
    // Spaces between the pieces are marked too, so the passage reads as one highlight.
    const from = segment.start <= at ? segment.offsets[at - segment.start] : 0;
    const to = last >= end ? segment.offsets[end - 1 - segment.start] + 1 : segment.node.data.length;
    pieces.push({ node: segment.node, from, to, order });
  });
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
    element.addEventListener('mouseenter', () => { element.style.opacity = '.8'; if (!primary) element.style.background = '#f0f0f0'; });
    element.addEventListener('mouseleave', () => { element.style.opacity = ''; if (!primary) element.style.background = ''; });
    element.addEventListener('click', action);
    return element;
  };
  // Keys typed in the panel stay out of the page's keyboard shortcuts.
  for (const type of ['keydown', 'keyup', 'keypress']) host.addEventListener(type, event => event.stopPropagation());
  let text = '', panel = false, anchor = null, closing;

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
    const save = async () => {
      saveButton.disabled = true;
      let reply;
      try { reply = await api.runtime.sendMessage({ type: 'marked:save-highlight', text, note: note.value }); } catch {}
      if (reply?.ok) { say('Highlight saved to Marked.'); markPassages([{ text, note: note.value.trim() }]); }
      else { error.textContent = reply?.error || 'Marked could not save the highlight. Try again.'; saveButton.disabled = false; }
    };
    const saveButton = button('Save highlight', true, save);
    const actions = make('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:10px');
    actions.append(button('Cancel', false, close), saveButton);
    box.replaceChildren(
      make('div', 'font-weight:600', 'Highlight'),
      make('div', 'color:#536471;white-space:nowrap;overflow:hidden;text-overflow:ellipsis', `On “${title}”`),
      make('div', 'margin:10px 0;padding:2px 0 2px 10px;border-left:3px solid #f2d94e;max-height:96px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere', text.trim()),
      note, error, actions
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
  // An open panel stays until it is saved or cancelled.
  const later = event => { if (!panel && !event.composedPath().includes(host)) setTimeout(show, 0); };
  document.addEventListener('mouseup', later, true);
  document.addEventListener('keyup', event => { if (event.shiftKey || event.key === 'Shift') later(event); }, true);
  document.addEventListener('selectionchange', () => { if (!panel && getSelection()?.isCollapsed) close(); });
  addEventListener('scroll', () => { if (!panel) close(); hideNote(); }, { capture: true, passive: true });

  // Saved passages, marked in yellow. Hovering one shows its note in Marked's
  // own closed box; notes are kept here, never in the page, so the site's
  // scripts can't read them.
  const MARK = 'all:unset;background:rgba(255,221,0,.45);color:inherit;border-radius:2px';
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
      if (found.length) pieces.push(...found.map(piece => ({ ...piece, note: passage.note || '' })));
      else missing.push(passage);
    }
    // From the end of the page back, so splitting a text node keeps earlier offsets valid.
    pieces.sort((a, b) => b.order - a.order || b.from - a.from);
    for (const { node, from, to, note } of pieces) {
      if (to > node.data.length || node.parentElement?.closest('marked-highlight')) continue;
      const middle = node.splitText(from);
      middle.splitText(to - from);
      const mark = document.createElement('marked-highlight');
      mark.style.cssText = MARK;
      middle.replaceWith(mark);
      mark.append(middle);
      notes.set(mark, note);
      mark.addEventListener('mouseenter', () => showNote(mark));
      mark.addEventListener('mouseleave', hideNote);
    }
    return missing;
  }
  // Pages that build their text after loading get two more tries.
  (async () => {
    let reply;
    try { reply = await api.runtime.sendMessage({ type: 'marked:page-highlights' }); } catch { return; }
    let missing = reply?.highlights || [];
    for (const wait of [0, 1500, 5000]) {
      if (!missing.length || !document.body) return;
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      missing = markPassages(missing);
    }
  })();
}
