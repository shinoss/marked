// Content script that background.js adds to a page to show one of Marked's
// panels there: the save panel, when the user saves the page (Add to Marked in
// the right-click menu or Alt+Shift+M, Save tweet to Marked, or Highlight on a
// page that isn't in Marked yet), or the note panel for a highlight on a saved
// page. The panel itself is Marked's own page, panel.html, in a frame. A page's
// scripts can listen to every key pressed in the page, even inside a closed
// shadow root, but not in a frame from another origin, so what the user types
// in the panel reaches Marked alone. This script only places the frame, sizes
// it to the panel, and takes it away. Content scripts are classic scripts, not
// modules; tests evaluate this file in a JSDOM window.

// The guard is the runtime that added the listener. After Marked is updated or
// reloaded, a page can keep the old copy of this script with its runtime gone
// (no id); then this copy takes over.
if (!globalThis.markedSavePanel?.id) {
  const api = globalThis.browser ?? globalThis.chrome;
  globalThis.markedSavePanel = api.runtime;
  // Chrome serves the panel at an address that changes every session, so no
  // site can find Marked by asking for it; the panel keeps Marked's own origin.
  const PAGE = api.runtime.getURL('panel.html');
  const ORIGIN = api.runtime.getURL('').replace(/\/$/, '');
  // How long the panel may take to load before Marked shows it another way.
  const LOADING = 5000;
  // The panel draws everything inside the frame; the frame, its border.
  const FRAME = 'all:initial;position:fixed;z-index:2147483647;display:block;box-sizing:border-box;margin:0;height:0;border:1px solid #0f1419;border-radius:4px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15);color-scheme:light;visibility:hidden';
  const host = document.createElement('marked-save');
  const shadow = host.attachShadow({ mode: 'closed' });
  // The focus moving into the frame is a focusout on the page; its focus traps
  // shouldn't pull it back.
  for (const type of ['focusin', 'focusout']) host.addEventListener(type, event => event.stopPropagation());

  // frame: the panel on the page. shown answers background.js once the panel
  // shows, or can't. anchor: the passage a note panel goes beside.
  // previous: what had focus on the page, which gets it back.
  let frame = null, kind = 'save', anchor = null, shown = null, previous = null, height = 0, loading, closing;
  const answer = ok => { const reply = shown; shown = null; clearTimeout(loading); reply?.(ok); };
  const giveBack = () => {
    if ([host, document.body, null].includes(document.activeElement) && previous?.isConnected) previous.focus({ preventScroll: true });
    previous = null;
  };
  const close = () => {
    clearTimeout(closing);
    answer(false);
    frame = null;
    shadow.replaceChildren();
    host.remove();
    giveBack();
  };
  // The frame as tall as the panel, within the window: a save panel at the top
  // right, a note panel beside its passage, below it or above it near the bottom.
  function place() {
    const beside = kind === 'highlight' && anchor;
    const tall = Math.max(1, Math.min(height + 2, innerHeight - (beside ? 8 : 32)));
    frame.style.height = `${tall}px`;
    if (!beside) return;
    const width = Math.min(320, innerWidth - 8);
    frame.style.top = `${Math.max(4, anchor.bottom + 8 + tall > innerHeight ? anchor.top - tall - 8 : anchor.bottom + 8)}px`;
    frame.style.left = `${Math.max(4, Math.min(anchor.right - width / 2, innerWidth - width - 4))}px`;
  }

  function open(message, reply) {
    clearTimeout(closing);
    // A panel still loading in this one's place counts as shown: this one follows it.
    answer(true);
    // A panel left on the page by an older copy of Marked goes.
    for (const old of document.querySelectorAll('marked-save')) if (old !== host) old.remove();
    if (!frame) previous = [document.body, host, null].includes(document.activeElement) ? null : document.activeElement;
    kind = message.kind === 'highlight' ? 'highlight' : 'save';
    anchor = ['top', 'bottom', 'right'].every(side => Number.isFinite(message.anchor?.[side])) ? message.anchor : null;
    height = 0;
    frame = document.createElement('iframe');
    frame.title = kind === 'highlight' ? 'Marked: highlight' : 'Marked: save this page';
    frame.style.cssText = kind === 'highlight' && anchor ? `${FRAME};width:320px;max-width:calc(100vw - 8px)` : `${FRAME};top:16px;right:16px;width:340px;max-width:calc(100vw - 32px)`;
    // Once loaded, the panel stays on panel.html: a frame the page sent elsewhere goes.
    let loads = 0;
    frame.addEventListener('load', () => { if (++loads > 1) close(); });
    frame.src = `${PAGE}#${kind}`;
    shadow.replaceChildren(frame);
    document.documentElement.append(host);
    shown = reply;
    loading = setTimeout(close, LOADING);
  }

  // Only the panel in the frame, still on Marked's page, is heard.
  addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== ORIGIN || event.data?.marked !== 'panel') return;
    const { data } = event;
    if (Number.isFinite(data.height) && data.height >= 0) {
      height = data.height;
      place();
      if (shown) {
        frame.style.visibility = 'visible';
        frame.focus();
        answer(true);
      }
    }
    // Saved: the page gets its focus back while the panel says so.
    if (data.done) {
      giveBack();
      clearTimeout(closing);
      closing = setTimeout(close, 2500);
    }
    if (data.close) close();
  }, true);
  addEventListener('resize', () => { if (frame && height) place(); });

  api.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== 'marked:show-panel') return;
    open(message, reply);
    // Answered once the panel shows, or can't.
    return true;
  });
}
