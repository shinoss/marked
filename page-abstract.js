// Injected into the page with scripting.executeScript when the user chooses
// "Add to Marked", so it must not reference anything outside this function.
// Returns the page's own description followed by its first visible paragraphs.
export function readPageAbstract() {
  const LIMIT = 1000;
  const SKIP = 'nav, footer, aside, form, dialog, [role="dialog"], [aria-modal="true"], [hidden], [aria-hidden="true"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]';
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const meta = key => clean(document.querySelector(`meta[name="${key}" i], meta[property="${key}" i]`)?.getAttribute('content'));
  const parts = [];
  // Skip text already covered, and let a paragraph replace a shorter part it contains.
  const add = text => {
    if (!text || parts.some(part => part.includes(text))) return;
    const index = parts.findIndex(part => text.includes(part));
    if (index >= 0) parts[index] = text; else parts.push(text);
  };
  add(meta('description') || meta('og:description') || meta('twitter:description'));
  const root = document.querySelector('article, main, [role="main"]') || document.body;
  for (const paragraph of root ? root.querySelectorAll('p') : []) {
    if (parts.join(' ').length >= LIMIT) break;
    if (paragraph.closest(SKIP) || paragraph.checkVisibility?.({ visibilityProperty: true, opacityProperty: true }) === false) continue;
    const text = clean(paragraph.innerText ?? paragraph.textContent);
    if (text.length >= 40) add(text);
  }
  let text = parts.join(' ');
  if (text.length > LIMIT) {
    const cut = text.lastIndexOf(' ', LIMIT);
    text = text.slice(0, cut > LIMIT * 0.8 ? cut : LIMIT) + '…';
  }
  return { url: location.href, text };
}
