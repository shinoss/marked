// Page text: the readable text of a saved page, kept so search finds words
// anywhere in it, and so it outlives the page. Mozilla's Readability, the engine
// of Firefox's Reader View, finds the article; npm run bundle copies it to
// vendor/readability.js.

// Whether to keep the text of pages as they're saved and revisited: { keep }.
export const PAGE_TEXT_SETTINGS_KEY = 'markedPageText';
// How far each saved text has been read in Marked's reader, by bookmark id:
// { p: 0 to 1, i: the paragraph at the top, at: when }.
export const READING_KEY = 'markedReadingV1';
// What each paragraph of a text is, space-separated in order: a paragraph,
// a heading, a list item, a quotation, code, or who wrote what follows (in a
// thread or a discussion).
export const BLOCK_KINDS = ['p', 'h2', 'h3', 'li', 'q', 'pre', 'by'];
// About 30,000 words, more than a long feature article; longer pages are cut.
export const PAGE_TEXT_LIMIT = 200000;
const VIA = ['page', 'visit', 'tabs', 'download', 'backup'];

// Injected into the page with scripting.executeScript right after
// vendor/readability.js, so it must not reference anything outside itself.
// Marked's own pages also call it on a page they downloaded, as source.
// Returns the article's text, one paragraph per block, with blank lines between,
// and what kind of block each paragraph is.
// With articlesOnly, a page that doesn't read like an article (an inbox, an
// account page, an app) is skipped, as Firefox's Reader View would skip it.
export function readPageText(source, { articlesOnly = false } = {}) {
  const doc = source || document;
  if (articlesOnly && typeof isProbablyReaderable === 'function' && !isProbablyReaderable(doc)) return { url: source ? '' : location.href, text: '', skipped: true };
  const LIMIT = 200000;
  const BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|CAPTION|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|SECTION|SUMMARY|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|CANVAS|IFRAME|OBJECT|EMBED|BUTTON|SELECT|OPTION|INPUT|TEXTAREA)$/;
  // Page furniture, left out when a page isn't an article and all its text is read.
  const CHROME = 'nav, header, footer, aside, form, dialog, menu, [hidden], [aria-hidden="true"], [role="navigation"], [role="banner"], [role="contentinfo"], [role="dialog"]';
  function paragraphs(root, skip) {
    const parts = [], kinds = [];
    let line = '', kind = 'p';
    const flush = () => {
      const text = line.replace(/\s+/g, ' ').trim();
      if (text && text !== '•') { parts.push(text); kinds.push(kind); }
      line = '';
    };
    (function walk(node) {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { line += child.data; continue; }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (SKIP.test(tag) || (skip && child.matches(skip))) continue;
        if (tag === 'PRE') {
          flush();
          // Code keeps its lines, but never a blank one, which would split it.
          const text = child.textContent.replace(/[^\S\n]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
          if (text) { parts.push(text); kinds.push('pre'); }
          continue;
        }
        if (!BLOCK.test(tag)) { walk(child); continue; }
        flush();
        const outer = kind;
        kind = /^H[12]$/.test(tag) ? 'h2' : /^H[3-6]$/.test(tag) ? 'h3' : tag === 'LI' ? 'li' : tag === 'BLOCKQUOTE' ? 'q' : kind;
        if (tag === 'LI') line = '• ';
        walk(child);
        flush();
        kind = outer;
      }
    })(root);
    flush();
    return { parts, kinds };
  }
  let article = null;
  try {
    // Readability rearranges the document it reads, so it gets a copy; the
    // serializer hands back its article element instead of HTML.
    if (typeof Readability === 'function') article = new Readability(doc.cloneNode(true), { serializer: element => element }).parse();
  } catch {}
  let found = article?.content ? paragraphs(article.content) : { parts: [], kinds: [] };
  // A page that isn't an article (a product, a tool, a list) keeps all its
  // text instead, without the menus Readability would have kept with it.
  if (found.parts.join('').length < 200 && doc.body) {
    const all = paragraphs(doc.body, CHROME);
    if (all.parts.length) found = all;
  }
  let text = '', truncated = false, kept = 0;
  for (const part of found.parts) {
    const room = LIMIT - text.length - (text ? 2 : 0);
    if (room <= 0) { truncated = true; break; }
    const cut = part.lastIndexOf(' ', room);
    const piece = part.length > room ? part.slice(0, cut > room * 0.8 ? cut : room) : part;
    text += (text ? '\n\n' : '') + piece;
    kept++;
    if (piece.length < part.length) { truncated = true; break; }
  }
  let words = 0;
  try {
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (segment.isWordLike) words++;
  } catch { words = (text.match(/\S+/g) || []).length; }
  const clean = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  return {
    url: source ? '' : location.href,
    text, words, truncated, kinds: found.kinds.slice(0, kept).join(' '),
    title: clean(article?.title), byline: clean(article?.byline), siteName: clean(article?.siteName),
    published: clean(article?.publishedTime), lang: clean(article?.lang || doc.documentElement?.lang).slice(0, 20)
  };
}

export function countWords(text) {
  try {
    let words = 0;
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (segment.isWordLike) words++;
    return words;
  } catch { return (text.match(/\S+/g) || []).length; }
}

// A page's text as Marked keeps it: the text, or why there is none, and when.
// Checked here because it comes from a web page or a backup file.
export function cleanPageText(value) {
  if (!value || typeof value !== 'object') return null;
  const short = (field, limit = 300) => typeof value[field] === 'string' ? value[field].replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const text = typeof value.text === 'string'
    ? value.text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, PAGE_TEXT_LIMIT)
    : '';
  const record = { capturedAt: Number.isFinite(value.capturedAt) && value.capturedAt > 0 ? value.capturedAt : Date.now() };
  if (VIA.includes(value.via)) record.via = value.via;
  if (!text) {
    const error = short('error', 200);
    return error ? { ...record, error } : null;
  }
  record.text = text;
  record.words = Number.isInteger(value.words) && value.words >= 0 && value.words <= text.length ? value.words : countWords(text);
  // One kind per paragraph; a shortened text keeps the kinds of what's left.
  const kinds = typeof value.kinds === 'string' ? value.kinds.split(' ') : [];
  const count = text.split('\n\n').length;
  if (kinds.length >= count && kinds.every(kind => BLOCK_KINDS.includes(kind)) && kinds.slice(0, count).some(kind => kind !== 'p')) record.kinds = kinds.slice(0, count).join(' ');
  if (value.truncated === true) record.truncated = true;
  for (const field of ['title', 'byline', 'siteName', 'published', 'lang']) {
    const found = short(field, field === 'lang' ? 20 : 300);
    if (found) record[field] = found;
  }
  return record;
}

const samePage = (a, b) => {
  try { const one = new URL(a), two = new URL(b); one.hash = two.hash = ''; return one.href === two.href; } catch { return false; }
};
// Reads the text of the page open in a tab, or null if the tab can't be read,
// has moved on to another page, or (with articlesOnly) isn't an article.
export async function captureTabText(api, tabId, url, { timeout = 4000, articlesOnly = false } = {}) {
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(resolve, timeout, null); });
  const reading = (async () => {
    await api.scripting.executeScript({ target: { tabId }, files: ['vendor/readability.js', 'vendor/readability-readerable.js'] });
    const [injection] = await api.scripting.executeScript({ target: { tabId }, func: readPageText, args: [null, { articlesOnly }] });
    return injection?.result;
  })();
  reading.catch(() => {});
  try {
    const result = await Promise.race([reading, expired]);
    return result && samePage(result.url, url) ? cleanPageText(result) : null;
  } finally { clearTimeout(timer); }
}

// Downloads a page and reads its text, for bookmarks saved without it. Only
// Marked's own pages call this: the response is parsed as inert data, never
// run, and no cookies go with the request.
export async function fetchPageText(url, { signal, fetchImpl = globalThis.fetch, limit = 5 * 1024 * 1024, timeout = 20000 } = {}) {
  const timer = AbortSignal.timeout(timeout);
  let response;
  try {
    response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timer]) : timer, credentials: 'omit', headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' } });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(timer.aborted ? 'The site took too long to answer.' : 'Couldn’t reach the site.');
  }
  if (!response.ok) throw new Error(`The site answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
  const type = (response.headers.get('content-type') || 'text/html').toLowerCase();
  const plain = type.startsWith('text/plain');
  if (!plain && !/html|xml/.test(type)) throw new Error(`Not a web page (${type.split(';')[0].trim()}).`);
  const markup = decode(await readBody(response, limit), type);
  const record = cleanPageText(plain ? { text: markup } : readPageText(new DOMParser().parseFromString(markup, 'text/html')));
  if (!record?.text) throw new Error('No readable text on the page.');
  return record;
}
async function readBody(response, limit) {
  if (!response.body?.getReader) return new Uint8Array(await response.arrayBuffer()).subarray(0, limit);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  if (size >= limit) reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const piece = chunk.subarray(0, bytes.length - offset);
    bytes.set(piece, offset);
    offset += piece.length;
  }
  return bytes;
}
// The response's own encoding: from its header, else the page's meta tag, else UTF-8.
function decode(bytes, type) {
  let label = /charset\s*=\s*["']?([\w:.-]+)/i.exec(type)?.[1];
  if (!label) label = /<meta[^>]+charset\s*=\s*["']?([\w:.-]+)/i.exec(new TextDecoder('windows-1252').decode(bytes.subarray(0, 4096)))?.[1];
  try { return new TextDecoder(label || 'utf-8').decode(bytes); } catch { return new TextDecoder().decode(bytes); }
}

export const readingMinutes = words => Math.max(1, Math.round(words / 230));
// Where a reader is in a text: not started, part way (with minutes left), or done.
export function readingStatus(text, progress) {
  const minutes = readingMinutes(text.words);
  const p = progress?.p || 0;
  if (p >= 0.97) return { state: 'read', label: 'Read' };
  if (p >= 0.03) return { state: 'reading', label: `${Math.max(1, Math.ceil(minutes * (1 - p)))} min left` };
  return { state: 'new', label: `${minutes} min read` };
}

// A search's words, lowercased; "quoted words" stay together as one phrase.
export function searchTerms(query) {
  const terms = [];
  for (const [, phrase, word] of String(query).toLowerCase().matchAll(/"([^"]*)"|(\S+)/g)) {
    const term = (phrase ?? word.replace(/"/g, '')).replace(/\s+/g, ' ').trim();
    if (term && !terms.includes(term)) terms.push(term);
  }
  return terms;
}

// The passage around the first place term appears in text, cut at word
// breaks and kept within its paragraph; lower is text in lowercase.
export function passageAround(text, lower, term, radius = 90) {
  let at = lower.length === text.length ? lower.indexOf(term) : -1;
  if (at < 0) at = text.toLowerCase().indexOf(term);
  if (at < 0) return null;
  let start = Math.max(0, at - radius), end = Math.min(text.length, at + term.length + radius);
  const paragraph = text.lastIndexOf('\n', at);
  if (paragraph >= start) start = paragraph + 1;
  else if (start > 0) { const space = text.indexOf(' ', start); if (space >= 0 && space < at) start = space + 1; }
  const next = text.indexOf('\n', at + term.length);
  if (next >= 0 && next <= end) end = next;
  else if (end < text.length) { const space = text.lastIndexOf(' ', end); if (space > at + term.length) end = space; }
  return { text: text.slice(start, end).trim(), cutBefore: start > 0 && text[start - 1] !== '\n', cutAfter: end < text.length && text[end] !== '\n' };
}
