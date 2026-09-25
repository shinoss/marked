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

// Injected the same way. Returns the page's icon drawn at 32 pixels as a PNG data
// URL, or null. The page loads its own icon, so Marked never contacts the site;
// an icon on another site's server counts only if that server allows it (CORS).
// Larger icons come first, so the result isn't a blurry enlargement.
export async function readPageIcon() {
  const size = link => link.relList.contains('apple-touch-icon') ? 180 : Math.max(0, ...String(link.sizes || '').split(/\s+/).map(value => parseInt(value, 10) || 0));
  const links = [...document.querySelectorAll('link[rel~="icon" i], link[rel~="apple-touch-icon" i]')].sort((a, b) => size(b) - size(a));
  for (const source of [...links.map(link => link.href), new URL('/favicon.ico', location.href).href]) {
    try {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      // The load event, not decode(): a hidden tab never decodes. A slow icon gets a second.
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        setTimeout(reject, 1000);
        image.src = source;
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 32, 32);
      // A one-tone icon on a see-through background vanishes on one of Marked's
      // themes (GitHub's is white while the browser is dark), so it gets a backing.
      const { data } = context.getImageData(0, 0, 32, 32);
      let opaque = 0, light = 0, dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 128) continue;
        opaque++;
        const luminance = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (luminance > 215) light++; else if (luminance < 60) dark++;
      }
      const backing = opaque < 32 * 32 * 0.9 && (light > opaque * 0.8 ? '#24292f' : dark > opaque * 0.8 ? '#ffffff' : '');
      if (backing) {
        context.clearRect(0, 0, 32, 32);
        context.fillStyle = backing;
        context.beginPath();
        context.roundRect(0, 0, 32, 32, 7);
        context.fill();
        context.drawImage(image, 5, 5, 22, 22);
      }
      return canvas.toDataURL('image/png');
    } catch {}
  }
  return null;
}
