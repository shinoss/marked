// Ranks bookmarks by meaning with Jev, following TypeSafe's line-by-line search
// recipe (https://docs.typesafe.ai/cookbooks/semantic_find.md): each bookmark
// becomes one line with a short id in the state, a Choice over those ids ranks
// them, and a yes/no question says whether anything matches at all. A Choice
// takes at most 255 options, so larger libraries are ranked in windows of 250 in
// parallel, then the leaders of every window are ranked together, because
// probabilities are only comparable within one request.
export const WINDOW = 250;

const clean = (text, max) => String(text ?? '').replace(/[\s|]+/g, ' ').trim().slice(0, max);

// What Jev reads for one bookmark, kept short because every token is paid for:
// the title, the note and highlights when allowed, and the abstract, separated
// by semicolons without labels. The address, folder, and tags are never sent; a
// title that is only the address is left out too.
export function bookmarkLine(node, { notes = true, highlights = true } = {}) {
  return [
    node.title !== node.url && clean(node.title, 160),
    notes && clean(node.note, 200),
    ...(highlights ? (node.highlights || []).slice(0, 3).map(highlight => clean(highlight.text, 120)) : []),
    clean(node.abstract, 240)
  ].filter(Boolean).join('; ');
}

// entries: [{ id, line }]; ask({ state, questions }) makes one Jev request.
// Resolves to { ranked: [{ id, probability }] best first, exists } where exists
// is the probability that any bookmark matches.
export async function semanticSearch(query, entries, ask) {
  query = clean(query, 300);
  const rank = async list => {
    const ids = list.map((_, i) => `B${String(i).padStart(3, '0')}`);
    const { answers } = await ask({
      state: list.map((entry, i) => `${ids[i]}| ${entry.line}`).join('\n'),
      questions: {
        where: { type: 'choice', instructions: `Which bookmark best matches what the user is looking for: "${query}"?`, criteria: Object.fromEntries(ids.map(id => [id, null])) },
        exists: { type: 'noul', instructions: `Does any bookmark match what the user is looking for: "${query}"?`, criteria: { true: 'At least one bookmark is about what the user describes', false: 'No bookmark is about what the user describes' } }
      }
    });
    const probabilities = answers?.where?.probabilities || {};
    return {
      ranked: list.map((entry, i) => ({ id: entry.id, probability: Number(probabilities[ids[i]]) || 0 })).sort((a, b) => b.probability - a.probability),
      exists: Number(answers?.exists?.noul) || 0
    };
  };
  if (!entries.length) return { ranked: [], exists: 0 };
  if (entries.length <= WINDOW) return rank(entries);
  const windows = [];
  for (let i = 0; i < entries.length; i += WINDOW) windows.push(entries.slice(i, i + WINDOW));
  const first = await Promise.all(windows.map(rank));
  const perWindow = Math.max(3, Math.floor(WINDOW / windows.length));
  const leaders = first.flatMap(result => result.ranked.slice(0, perWindow))
    .sort((a, b) => b.probability - a.probability).slice(0, WINDOW);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  return rank(leaders.map(leader => byId.get(leader.id)));
}

// The results worth showing: best first, until they hold most of the
// probability, skipping any far less likely than the best match. A clear
// winner stands alone; a query many bookmarks fit equally shows them all.
export function semanticMatches(ranked, { mass = 0.95, floor = 0.01, relative = 0.25, max = 30 } = {}) {
  const matches = [];
  const cutoff = Math.max(floor, (ranked[0]?.probability || 0) * relative);
  let total = 0;
  for (const item of ranked) {
    if (matches.length >= max || total >= mass || item.probability < cutoff) break;
    matches.push(item);
    total += item.probability;
  }
  return matches;
}
