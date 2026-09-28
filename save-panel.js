// Content script that background.js adds to a page when the user saves it:
// with Add to Marked in the right-click menu or Alt+Shift+M, Save tweet to
// Marked, or Highlight on a page that isn't in Marked yet. It shows Marked's
// editor as a panel on the page, so saving never takes the user to another tab.
// background.js reads the page and keeps what it read, the preview included,
// which never enters the page; the panel shows the fields and hands back what
// the user chose. Content scripts are classic scripts, not modules; tests
// evaluate this file in a JSDOM window.

// The guard is the runtime that added the listener. After Marked is updated or
// reloaded, a page can keep the old copy of this script with its runtime gone
// (no id); then this copy takes over.
if (!globalThis.markedSavePanel?.id) {
  const api = globalThis.browser ?? globalThis.chrome;
  globalThis.markedSavePanel = api.runtime;
  // A closed shadow root keeps the page's CSS out; CSSOM styles are not subject
  // to the page's Content Security Policy.
  const host = document.createElement('marked-save');
  const box = host.attachShadow({ mode: 'closed' }).appendChild(document.createElement('div'));
  // What happens in the panel stays out of the page's own handlers: its
  // keyboard shortcuts, and focus traps that would pull the focus back.
  for (const type of ['keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'copy', 'cut', 'focusin', 'focusout', 'mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'contextmenu', 'wheel']) {
    host.addEventListener(type, event => event.stopPropagation(), { passive: true });
  }
  const INK = '#0f1419', MUTED = '#536471', LINE = '#cfd9de';
  const BOX = `all:initial;position:fixed;z-index:2147483647;top:16px;right:16px;box-sizing:border-box;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;border:1px solid ${INK};border-radius:4px;background:#fff;color:${INK};box-shadow:0 2px 8px rgba(0,0,0,.15);font:13px/1.4 system-ui,sans-serif;direction:ltr`;
  const CONTROL = `all:initial;box-sizing:border-box;display:block;width:100%;margin-top:4px;padding:6px 8px;border:1px solid ${LINE};border-radius:3px;background:#fff;color:inherit;font:inherit`;
  // Highlight colors: a swatch and border shade, as in the highlighter.
  const EDGE = { yellow: '#f2d94e', green: '#5cc98a', blue: '#5b9df0', pink: '#f07aa9', purple: '#a384f0' };
  const make = (tag, style, text) => {
    const element = document.createElement(tag);
    element.style.cssText = style;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  // all:initial takes the browser's focus ring away, so keyboard focus gets one back.
  const ring = element => {
    element.addEventListener('focus', () => { if (element.matches(':focus-visible')) element.style.outline = `1px solid ${INK}`; });
    element.addEventListener('blur', () => { element.style.outline = 'none'; });
    element.style.outlineOffset = '2px';
    return element;
  };
  const button = (label, primary, action) => {
    const element = make('button', `all:initial;cursor:pointer;padding:6px 10px;border-radius:3px;font:inherit;${primary ? `background:${INK};color:#fff` : `color:${INK}`}`, label);
    element.type = 'button';
    // Hover sets values rather than clearing them: a cleared value would drop the
    // all:initial reset and show the browser's button color, dark on dark pages.
    element.addEventListener('mouseenter', () => { element.style.opacity = '.8'; if (!primary) element.style.background = '#f0f0f0'; });
    element.addEventListener('mouseleave', () => { element.style.opacity = '1'; if (!primary) element.style.background = 'transparent'; });
    element.addEventListener('click', action);
    return ring(element);
  };
  const field = (tag, style = '') => {
    const element = make(tag, `${CONTROL};${style}`);
    element.addEventListener('focus', () => { element.style.borderColor = INK; });
    element.addEventListener('blur', () => { element.style.borderColor = LINE; });
    return element;
  };
  const text = (value, limit, placeholder = '') => {
    const element = field('input');
    element.value = value;
    element.maxLength = limit;
    element.placeholder = placeholder;
    element.autocomplete = 'off';
    return element;
  };
  const area = (value, rows, placeholder) => {
    const element = field('textarea', 'white-space:pre-wrap;overflow-wrap:anywhere;resize:vertical');
    element.value = value;
    element.rows = rows;
    element.maxLength = 2000;
    element.placeholder = placeholder;
    return element;
  };
  const labelled = (name, ...controls) => {
    const label = make('label', 'display:block;margin-top:10px');
    label.append(make('span', `color:${MUTED};font-size:12px`, name), ...controls);
    return label;
  };
  // null when Marked doesn't answer, as after it was updated or reloaded.
  const ask = async message => { try { return await api.runtime.sendMessage(message); } catch { return null; } };

  // token: the save Marked offered, which Save and Cancel answer.
  // previous: what had focus on the page, which gets it back.
  let token = null, closing, previous = null;
  const giveBack = () => {
    if (previous?.isConnected) previous.focus({ preventScroll: true });
    previous = null;
  };
  const close = () => {
    clearTimeout(closing);
    host.remove();
    token = null;
    giveBack();
  };
  const cancel = () => {
    if (token) ask({ type: 'marked:cancel-save', token });
    close();
  };
  const say = message => {
    box.style.cssText = `${BOX};padding:8px 12px`;
    box.setAttribute('role', 'status');
    box.removeAttribute('aria-label');
    box.replaceChildren(make('div', '', message));
    giveBack();
    closing = setTimeout(close, 2500);
  };

  // data: what background.js sends with marked:save-panel.
  function open(data) {
    clearTimeout(closing);
    // A panel left on the page by an older copy of Marked goes.
    for (const old of document.querySelectorAll('marked-save')) if (old !== host) old.remove();
    if (!token) previous = [document.body, host].includes(document.activeElement) ? null : document.activeElement;
    token = data.token;
    const heading = data.edit ? 'Edit bookmark' : 'Add to Marked';
    box.style.cssText = `${BOX};width:340px;padding:12px`;
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', heading);

    const name = text(data.title || '', 2000);
    const folder = field('select', 'appearance:auto;cursor:pointer');
    for (const { id, label } of data.folders || []) {
      const option = make('option', '', label);
      option.value = id;
      folder.append(option);
    }
    folder.value = data.folder;

    // A passage highlighted on a page that isn't in Marked yet comes with it.
    let color = 'yellow', highlight = [];
    const highlightNote = area('', 2, 'Optional');
    if (data.highlight) {
      const quote = make('div', `margin-top:4px;padding:2px 0 2px 10px;border-left:3px solid ${EDGE.yellow};max-height:96px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere`, data.highlight);
      const swatches = make('div', 'display:flex;gap:8px;margin:8px 0 0 2px');
      swatches.setAttribute('role', 'group');
      swatches.setAttribute('aria-label', 'Highlight color');
      const choose = chosen => {
        color = chosen;
        quote.style.borderLeftColor = EDGE[chosen];
        for (const swatch of swatches.children) {
          const on = swatch.dataset.color === chosen;
          swatch.setAttribute('aria-pressed', String(on));
          swatch.style.boxShadow = `0 0 0 2px #fff, 0 0 0 3px ${on ? INK : 'transparent'}`;
        }
      };
      for (const shade of Object.keys(EDGE)) {
        const swatch = ring(make('button', `all:initial;cursor:pointer;width:16px;height:16px;border-radius:50%;background:${EDGE[shade]}`));
        swatch.type = 'button';
        swatch.dataset.color = shade;
        swatch.title = shade[0].toUpperCase() + shade.slice(1);
        swatch.setAttribute('aria-label', swatch.title);
        swatch.addEventListener('click', () => choose(shade));
        swatches.append(swatch);
      }
      choose(color);
      const passage = make('div', 'margin-top:10px');
      passage.append(make('span', `color:${MUTED};font-size:12px`, 'Highlight'), quote, swatches);
      highlight = [passage, labelled('Note on this highlight', highlightNote)];
    }
    const note = area(data.note || '', 2, 'Why are you saving this? Local chat can use it.');

    // The library's tags, to choose from, and a field for a new one.
    const chosen = [...(data.chosen || [])];
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    const has = tag => chosen.some(other => same(other, tag));
    const paint = (chip, on) => {
      chip.setAttribute('aria-pressed', String(on));
      chip.style.borderColor = on ? INK : LINE;
      chip.style.background = on ? INK : '#fff';
      chip.style.color = on ? '#fff' : INK;
    };
    const chip = tag => {
      const element = ring(make('button', `all:initial;cursor:pointer;padding:2px 8px;border:1px solid ${LINE};border-radius:3px;font:inherit`, tag));
      element.type = 'button';
      paint(element, has(tag));
      element.addEventListener('click', () => {
        const at = chosen.findIndex(other => same(other, tag));
        if (at >= 0) chosen.splice(at, 1); else chosen.push(tag);
        paint(element, at < 0);
      });
      return element;
    };
    const chips = make('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;max-height:92px;overflow:auto');
    chips.setAttribute('role', 'group');
    chips.setAttribute('aria-label', 'Tags');
    const known = [...(data.tags || [])];
    for (const tag of chosen) if (!known.some(other => same(other, tag))) known.push(tag);
    chips.append(...known.map(chip));
    const newTag = text('', 40, 'Add a tag and press Enter');
    newTag.setAttribute('aria-label', 'New tag');
    // Tags can't hold commas: bookmark files separate tags with them.
    const addTag = () => {
      const tag = newTag.value.replace(/[,\s]+/g, ' ').trim().slice(0, 40).trim();
      newTag.value = '';
      if (!tag) return;
      const existing = [...chips.children].find(element => same(element.textContent, tag));
      if (!has(tag)) chosen.push(existing?.textContent ?? tag);
      if (existing) paint(existing, true); else chips.append(chip(tag));
    };
    const tags = make('div', 'margin-top:10px');
    tags.append(make('span', `color:${MUTED};font-size:12px`, 'Tags'), chips, newTag);

    const abstract = area(data.abstract || '', 3, 'What is this page about? Local chat uses this.');
    // The preview itself stays in Marked: it shows what's on screen, which can
    // include parts of the page from other sites.
    const preview = ring(make('input', 'all:initial;appearance:auto;margin:0;cursor:pointer'));
    preview.type = 'checkbox';
    preview.checked = true;
    const previewField = [];
    if (data.preview) {
      const choice = make('label', 'display:flex;align-items:center;gap:6px;margin-top:10px;cursor:pointer');
      choice.append(preview, make('span', '', 'Save preview'));
      previewField.push(choice, make('div', `margin:2px 0 0 19px;color:${MUTED};font-size:12px`, 'Includes visible page content. Stored only in Marked.'));
    }

    const error = make('div', 'display:none;margin-top:10px;color:#b00020');
    error.setAttribute('role', 'alert');
    const fail = message => { error.textContent = message; error.style.display = 'block'; };
    let saving = false;
    const save = async () => {
      if (saving) return;
      const title = name.value.trim();
      if (!title) { fail('Enter a name.'); name.focus(); return; }
      addTag();
      saving = true;
      saveButton.disabled = true;
      saveButton.textContent = 'Saving…';
      const mine = token;
      const reply = await ask({
        type: 'marked:save-page', token: mine, title, parentId: folder.value, note: note.value, tags: chosen, abstract: abstract.value,
        preview: !!data.preview && preview.checked, ...(data.highlight && { highlight: { color, note: highlightNote.value } })
      });
      // Opened again meanwhile: that panel is the one on the page now.
      if (token !== mine) return;
      saving = false;
      if (reply?.ok) { token = null; say('Saved to Marked.'); return; }
      fail(reply?.error || 'Marked could not save this page. Try again.');
      saveButton.disabled = false;
      saveButton.textContent = 'Save';
    };
    const saveButton = button('Save', true, save);
    const actions = make('div', 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px');
    actions.append(button('Cancel', false, cancel), saveButton);

    // Enter in the name saves, and in the tag field adds the tag; Ctrl+Enter
    // or ⌘+Enter saves from anywhere. Never while an input method is composing.
    box.onkeydown = event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
      if (event.key !== 'Enter') return;
      if (event.metaKey || event.ctrlKey || event.target === name) { event.preventDefault(); save(); }
      else if (event.target === newTag) { event.preventDefault(); addTag(); }
    };
    box.replaceChildren(
      make('div', 'font-weight:600', heading),
      make('div', `color:${MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`, String(data.url || '').replace(/^https?:\/\/(www\.)?/, '')),
      labelled('Name', name), labelled('Folder', folder), ...highlight, labelled('Note', note), tags, labelled('Abstract', abstract),
      ...previewField, error, actions
    );
    document.documentElement.append(host);
    name.focus({ preventScroll: true });
    name.select();
  }

  api.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'marked:save-panel') return;
    open(message);
    reply(true);
  });
}
