// Which bookmarks are like each other, by the telling words they share: in
// titles, tags, notes, highlights, abstracts, cards, and saved text. A word
// counts for more the fewer bookmarks use it (TF-IDF), and each bookmark keeps
// only its most telling words, so comparing a whole library stays quick.
// Everything here runs on the device; nothing is sent anywhere.

// The compact index the library writes for its background and reader pages.
export const RELATED_KEY = 'markedRelatedV1';
// Whether the Marked button counts the saved bookmarks related to the page you're on.
export const BROWSING_KEY = 'markedBrowsing';

const STOP = new Set(`a about above after again against all almost also am among an and another any are around as at away back be became because been before being below between both but by came can cannot could did do does doing done down during each either else enough even ever every few for from further get gets got had has have having he her here hers herself him himself his how however i if in into is it its itself just last least less like made make many may me might more most much must my myself near need never new next no nor not now of off often on once one only or other others our ours out over own per perhaps put rather really said same say says see seen several shall she should since so some still such than that the their theirs them then there these they thing things this those though three through thus to too two under until up upon us use used using very was way we well were what when where whether which while who whom whose why will with within without would yet you your yours
  http https www com org net html htm php wikipedia wiki retrieved archived original isbn doi pmid pmc issn arxiv references reference external links link edit edited page pages article articles jump navigation menu search share click read more comments comment reply replies posted post posts via`.split(/\s+/));

// A text's words, lowercased, in the singular, without common words; Chinese
// and Japanese, which don't space their words, in pairs of characters.
export function tokenize(text) {
  const terms = [];
  for (const [raw] of String(text || '').matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = raw.toLowerCase();
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) {
      const characters = [...word];
      if (characters.length === 1) terms.push(word);
      for (let at = 0; at < characters.length - 1; at++) terms.push(characters[at] + characters[at + 1]);
      continue;
    }
    if (word.length < 2 || /^\d+$/.test(word) || STOP.has(word)) continue;
    // Plurals lose their s, GPUs as well; words like focus, analysis, and class keep it.
    const singular = word.length > 3 && (/[^siu]s$/.test(word) || /^\p{Lu}{2,}s$/u.test(raw)) ? word.slice(0, -1) : word;
    if (!STOP.has(singular)) terms.push(singular);
  }
  return terms;
}

// What a bookmark is about, as weighted terms: its own words count more than
// its page's, and only the opening of a long page counts at all.
export function documentTerms({ title = '', tags = [], note = '', highlights = [], abstract = '', card = null, text = '' }) {
  const terms = new Map();
  const add = (source, weight) => { for (const term of tokenize(source)) terms.set(term, (terms.get(term) || 0) + weight); };
  add(title, 3);
  add(tags.join(' '), 3);
  add(note, 2);
  add(highlights.map(highlight => `${highlight.text} ${highlight.note || ''}`).join(' '), 2);
  add(abstract, 1);
  if (card) add(`${card.title || ''} ${card.text || ''} ${card.community || ''} ${(card.labels || []).join(' ')}`, 1);
  add(String(text).slice(0, 5000), 1);
  return terms;
}

// docs: [{ id, terms }]. Keeps each bookmark's keep most telling terms.
export function buildIndex(docs, keep = 40) {
  const df = new Map();
  for (const { terms } of docs) for (const term of terms.keys()) df.set(term, (df.get(term) || 0) + 1);
  const index = { n: docs.length, df, vectors: new Map(), postings: new Map() };
  for (const { id, terms } of docs) {
    // Even a word no other bookmark uses stays: a page you visit may share it.
    const vector = weigh(index, terms, keep);
    index.vectors.set(id, vector);
    for (const [term, weight] of vector) {
      const list = index.postings.get(term) ?? index.postings.set(term, []).get(term);
      list.push([id, weight]);
    }
  }
  return index;
}
// Terms weighted by TF-IDF, the keep strongest, scaled to length 1; terms fewer
// than minDf bookmarks use are left out.
export function weigh(index, terms, keep = 40, minDf = 1) {
  const weighted = [];
  for (const [term, count] of terms) {
    const df = index.df.get(term) || 0;
    if (df < minDf) continue;
    weighted.push([term, (1 + Math.log(count)) * Math.log((index.n + 1) / df)]);
  }
  weighted.sort((a, b) => b[1] - a[1]);
  const top = weighted.slice(0, keep).filter(([, weight]) => weight > 0);
  const length = Math.hypot(...top.map(([, weight]) => weight)) || 1;
  return top.map(([term, weight]) => [term, weight / length]);
}

// The bookmarks most like vector, best first, with the words they share most.
export function similar(index, vector, { exclude = new Set(), limit = 8, min = 0.06 } = {}) {
  const scores = new Map();
  for (const [term, weight] of vector) {
    for (const [id, other] of index.postings.get(term) || []) {
      if (exclude.has(id)) continue;
      const score = scores.get(id) ?? scores.set(id, { id, score: 0, shared: [] }).get(id);
      score.score += weight * other;
      score.shared.push([term, weight * other]);
    }
  }
  return [...scores.values()].filter(match => match.score >= min).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(match => ({ id: match.id, score: match.score, shared: match.shared.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([term]) => term) }));
}

// The index, small enough to store for the background and the reader: each
// bookmark's strongest terms, and how many bookmarks use each.
export function compactIndex(index, keep = 24) {
  const docs = {}, df = {};
  for (const [id, vector] of index.vectors) {
    docs[id] = vector.slice(0, keep).map(([term, weight]) => [term, Math.round(weight * 1000) / 1000]);
    for (const [term] of docs[id]) df[term] = index.df.get(term);
  }
  return { version: 1, n: index.n, df, docs, builtAt: Date.now() };
}
export function expandIndex(compact) {
  const index = { n: compact.n, df: new Map(Object.entries(compact.df || {})), vectors: new Map(), postings: new Map() };
  for (const [id, vector] of Object.entries(compact.docs || {})) {
    index.vectors.set(id, vector);
    for (const [term, weight] of vector) {
      const list = index.postings.get(term) ?? index.postings.set(term, []).get(term);
      list.push([id, weight]);
    }
  }
  return index;
}
