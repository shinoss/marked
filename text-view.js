// Showing saved page text in Marked's own pages: the library's search
// passages, the Highlights view, and the reader. Text is only ever added as
// text, never as HTML.

// Appends text to parent, marking the words searched for and, at ranges,
// passages the user highlighted, each in its color.
export function markText(parent, text, { terms = [], ranges = [] } = {}) {
  const doc = parent.ownerDocument;
  const marks = [...ranges];
  const lower = text.toLowerCase();
  if (lower.length === text.length) {
    for (const term of terms) for (let at = lower.indexOf(term); term && at >= 0; at = lower.indexOf(term, at + term.length)) marks.push({ start: at, end: at + term.length });
  }
  // Earlier first, and at the same place the longer one; overlaps give way.
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  let cursor = 0;
  for (const range of marks) {
    if (range.start < cursor) continue;
    if (range.start > cursor) parent.append(text.slice(cursor, range.start));
    const mark = doc.createElement('mark');
    mark.textContent = text.slice(range.start, range.end);
    if (range.highlight) {
      mark.className = `passage hl-${range.highlight.color || 'yellow'}`;
      if (range.highlight.id) mark.dataset.highlight = range.highlight.id;
    } else mark.className = 'term';
    parent.append(mark);
    cursor = range.end;
  }
  if (cursor < text.length) parent.append(text.slice(cursor));
}

// Where each highlight is in a text's paragraphs, whatever the whitespace, even
// across paragraphs, as the page highlighter finds them: ranges by paragraph.
export function highlightRanges(paragraphs, highlights) {
  const byParagraph = new Map();
  if (!highlights.length) return byParagraph;
  // The text without whitespace, and where each of its characters came from.
  const size = paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0);
  const paragraphOf = new Int32Array(size), offsetOf = new Int32Array(size);
  const kept = [];
  paragraphs.forEach((paragraph, index) => {
    for (let at = 0; at < paragraph.length; at++) {
      if (/\s/.test(paragraph[at])) continue;
      paragraphOf[kept.length] = index;
      offsetOf[kept.length] = at;
      kept.push(paragraph[at]);
    }
  });
  const flat = kept.join('');
  for (const highlight of highlights) {
    const needle = String(highlight.text || '').replace(/\s+/g, '');
    const at = needle ? flat.indexOf(needle) : -1;
    if (at < 0) continue;
    for (let i = at; i < at + needle.length; i++) {
      const index = paragraphOf[i], offset = offsetOf[i];
      const list = byParagraph.get(index) ?? byParagraph.set(index, []).get(index);
      const last = list.at(-1);
      if (last?.highlight === highlight) last.end = offset + 1;
      else list.push({ start: offset, end: offset + 1, highlight });
    }
  }
  return byParagraph;
}

// Lays out a saved text as headings, paragraphs, lists, quotations, and code,
// by the kinds kept with it. Texts saved before kinds were kept still show
// their bullets as lists. Each block remembers its paragraph's index.
export function renderText(container, text, kinds = '', { terms = [], highlights = [] } = {}) {
  const doc = container.ownerDocument;
  const types = kinds ? kinds.split(' ') : [];
  const paragraphs = text.split('\n\n');
  const ranges = highlightRanges(paragraphs, highlights);
  let list = null;
  paragraphs.forEach((paragraph, index) => {
    const kind = types[index] || (paragraph.startsWith('• ') ? 'li' : 'p');
    let block, shift = 0;
    if (kind === 'li') {
      if (!list) { list = doc.createElement('ul'); container.append(list); }
      block = doc.createElement('li');
      shift = paragraph.match(/^•\s*/)?.[0].length || 0;
      list.append(block);
    } else {
      list = null;
      block = doc.createElement({ q: 'blockquote', pre: 'pre', h2: 'h2', h3: 'h3' }[kind] || 'p');
      if (kind === 'by') block.className = 'by';
      container.append(block);
    }
    block.dataset.index = index;
    // A list item's bullet becomes the list's own, so its ranges move with it.
    const own = (ranges.get(index) || []).map(range => ({ ...range, start: Math.max(0, range.start - shift), end: range.end - shift })).filter(range => range.end > range.start);
    markText(block, paragraph.slice(shift), { terms, ranges: own });
  });
}

// A post's card from sites.js: where it's from and who wrote it, what it
// says, and how it's doing. compact gives short counts, like 1.2K.
const compact = count => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(count);
const plural = (count, one, many = `${one}s`) => `${compact(count)} ${count === 1 ? one : many}`;
// withState: an issue's state leads, unless its card shows it already.
export function cardStats(card, withState = true) {
  const stats = card.stats || {};
  const parts = {
    hn: [stats.score !== undefined && plural(stats.score, 'point'), stats.comments !== undefined && plural(stats.comments, 'comment')],
    github: card.kind === 'repo'
      ? [stats.stars !== undefined && `★ ${compact(stats.stars)}`, card.language, card.license]
      : [withState && card.state && card.state[0].toUpperCase() + card.state.slice(1), stats.comments !== undefined && plural(stats.comments, 'comment')]
  }[card.site] || [];
  return parts.filter(Boolean).join(' · ');
}
export function renderCard(doc, card) {
  const make = (tag, className, text) => { const el = doc.createElement(tag); el.className = className; if (text !== undefined) el.textContent = text; return el; };
  const box = make('div', `site-card site-${card.site}`);
  const head = make('div', 'site-card-head');
  const where = {
    hn: 'Hacker News',
    github: card.kind === 'repo' ? 'GitHub' : `${card.community || 'GitHub'} #${card.number}`
  }[card.site];
  head.append(make('span', 'site-card-where', where));
  const who = card.site === 'hn' ? card.handle && `by ${card.handle}` : card.handle;
  if (who && card.kind !== 'repo') head.append(make('span', 'site-card-who', who));
  box.append(head);
  if (card.title) box.append(make('p', 'site-card-title', card.title));
  if (card.site === 'github' && card.state) box.append(make('span', `site-card-state ${card.state}`, card.state[0].toUpperCase() + card.state.slice(1)));
  if (card.text) box.append(make('p', 'site-card-text', card.text));
  const stats = cardStats(card, false);
  if (stats) box.append(make('p', 'site-card-stats', stats));
  return box;
}

// Readability, for reading the pages Marked downloads. A plain script that
// defines Readability as a global, as pages get it when Marked reads them.
let readabilityLoading = null;
export function loadReadability(doc = document) {
  if (typeof globalThis.Readability === 'function') return Promise.resolve();
  return readabilityLoading ??= new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = 'vendor/readability.js';
    script.onload = () => resolve();
    script.onerror = () => { readabilityLoading = null; script.remove(); reject(new Error('Marked’s page reader is missing. Run npm run bundle, then reload Marked.')); };
    doc.head.append(script);
  });
}
