// Posts and pages from a few sites, read through their public APIs: a card for
// the library (who posted it, what it says, how it's doing) and the full text
// for search and the reader (a Hacker News post with its top comments, a
// GitHub README or discussion).
// Works in Marked's pages and its background alike: no DOM needed.

export const SITES = ['hn', 'github'];
const KINDS = ['story', 'comment', 'repo', 'issue', 'pull'];
const GITHUB_PAGES = new Set(['about', 'apps', 'codespaces', 'collections', 'customer-stories', 'enterprise', 'events', 'explore', 'features', 'issues', 'login', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'readme', 'search', 'settings', 'sponsors', 'team', 'topics', 'trending']);

// Which site a bookmark's address is on, with what's needed to read it, or null.
export function siteOf(address) {
  let url;
  try { url = new URL(address); } catch { return null; }
  const host = url.hostname.replace(/^(www|m)\./, '');
  const parts = url.pathname.split('/').filter(Boolean);
  if (host === 'news.ycombinator.com' && url.pathname === '/item' && /^\d+$/.test(url.searchParams.get('id') || '')) return { site: 'hn', id: url.searchParams.get('id') };
  if (host === 'github.com' && parts.length >= 2 && !GITHUB_PAGES.has(parts[0].toLowerCase())) {
    const [owner, name, section, number] = parts;
    const repo = name.replace(/\.git$/, '');
    if (parts.length === 2) return { site: 'github', owner, repo, kind: 'repo' };
    if ((section === 'issues' || section === 'pull') && /^\d+$/.test(number || '')) return { site: 'github', owner, repo, kind: section === 'pull' ? 'pull' : 'issue', number: Number(number) };
  }
  return null;
}

// A card as Marked keeps it on a bookmark, checked because it comes from a
// site (or a backup file).
export function cleanCard(value) {
  if (!value || typeof value !== 'object' || !SITES.includes(value.site) || !KINDS.includes(value.kind)) return null;
  const short = (field, limit) => typeof value[field] === 'string' ? value[field].replace(/\s+/g, ' ').trim().slice(0, limit) : '';
  const card = { site: value.site, kind: value.kind };
  for (const [field, limit] of [['title', 300], ['author', 100], ['handle', 100], ['community', 100], ['domain', 100], ['language', 40], ['license', 40]]) {
    const found = short(field, limit);
    if (found) card[field] = found;
  }
  const text = typeof value.text === 'string' ? value.text.replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1000) : '';
  if (text) card.text = text;
  const stats = {};
  for (const key of ['score', 'comments', 'stars', 'forks']) {
    const count = value.stats?.[key];
    if (Number.isInteger(count) && count >= 0 && count < 1e10) stats[key] = count;
  }
  if (Object.keys(stats).length) card.stats = stats;
  if (['open', 'closed', 'merged'].includes(value.state)) card.state = value.state;
  if (Number.isInteger(value.number) && value.number > 0) card.number = value.number;
  const labels = (Array.isArray(value.labels) ? value.labels : []).filter(label => typeof label === 'string').map(label => label.trim().slice(0, 40)).filter(Boolean).slice(0, 6);
  if (labels.length) card.labels = labels;
  if (Number.isFinite(value.createdAt) && value.createdAt > 0) card.createdAt = value.createdAt;
  card.fetchedAt = Number.isFinite(value.fetchedAt) && value.fetchedAt > 0 ? value.fetchedAt : Date.now();
  return card;
}

// Reads a supported page: { card, text } with text as page text keeps it
// ({ text, kinds, words }), or throws a reason to show.
export async function fetchSite(address, { fetchImpl = globalThis.fetch, signal, timeout = 15000 } = {}) {
  const site = siteOf(address);
  if (!site) throw new Error('Marked has no card for this site.');
  const get = async (url, { accept = 'application/json', as = 'json' } = {}) => {
    const timer = AbortSignal.timeout(timeout);
    let response;
    try {
      response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timer]) : timer, credentials: 'omit', headers: { Accept: accept } });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(timer.aborted ? 'The site took too long to answer.' : 'Couldn’t reach the site.');
    }
    if (response.status === 404) throw new Error('The site says it isn’t there anymore.');
    if (response.status === 403 || response.status === 429) throw new Error('The site is limiting requests. Try again later.');
    if (!response.ok) throw new Error(`The site answered ${response.status}.`);
    return as === 'text' ? response.text() : response.json();
  };
  const read = { hn: readHackerNews, github: readGitHub }[site.site];
  const { card, blocks } = await read(site, get);
  const cleaned = cleanCard({ ...card, fetchedAt: Date.now() });
  const kept = blocks.filter(block => block.text);
  const text = kept.map(block => block.text).join('\n\n');
  return { card: cleaned, text: text ? { text, kinds: kept.map(block => block.kind).join(' '), words: countWords(text), title: card.title || '' } : null };
}

async function readHackerNews({ id }, get) {
  const api = 'https://hacker-news.firebaseio.com/v0/item';
  const item = await get(`${api}/${id}.json`);
  if (!item || item.deleted || item.dead) throw new Error('Hacker News doesn’t have this item anymore.');
  const kids = await Promise.all((item.kids || []).slice(0, 8).map(kid => get(`${api}/${kid}.json`).catch(() => null)));
  const comments = kids.filter(kid => kid?.text && !kid.deleted && !kid.dead);
  const story = item.type !== 'comment';
  const card = {
    site: 'hn', kind: story ? 'story' : 'comment', title: item.title, handle: item.by, domain: hostOf(item.url),
    text: htmlText(item.text).replace(/\n\n/g, '\n'), stats: story ? { score: item.score, comments: item.descendants } : {}, createdAt: item.time * 1000
  };
  const blocks = [...(item.url ? [{ kind: 'q', text: `Link: ${item.url}` }] : []), ...htmlBlocks(item.text)];
  if (comments.length) blocks.push({ kind: 'h3', text: story ? 'Top comments' : 'Replies' });
  for (const comment of comments) blocks.push({ kind: 'by', text: comment.by }, ...htmlBlocks(comment.text));
  return { card, blocks };
}

async function readGitHub({ owner, repo, kind, number }, get) {
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const json = { accept: 'application/vnd.github+json' };
  if (kind === 'repo') {
    const [info, readme] = await Promise.all([get(api, json), get(`${api}/readme`, { accept: 'application/vnd.github.raw+json', as: 'text' }).catch(() => '')]);
    const card = {
      site: 'github', kind: 'repo', title: info.full_name, text: info.description || '', language: info.language || '',
      license: info.license?.spdx_id && info.license.spdx_id !== 'NOASSERTION' ? info.license.spdx_id : '',
      labels: info.topics, stats: { stars: info.stargazers_count, forks: info.forks_count }, createdAt: Date.parse(info.pushed_at) || undefined
    };
    return { card, blocks: [...(info.description ? [{ kind: 'q', text: info.description }] : []), ...markdownBlocks(readme)] };
  }
  const issue = await get(`${api}/issues/${number}`, json);
  const [pull, comments] = await Promise.all([
    issue.pull_request ? get(`${api}/pulls/${number}`, json).catch(() => null) : null,
    issue.comments ? get(`${api}/issues/${number}/comments?per_page=8`, json).catch(() => []) : []
  ]);
  const card = {
    site: 'github', kind: issue.pull_request ? 'pull' : 'issue', title: issue.title, community: `${owner}/${repo}`, number,
    handle: issue.user?.login, state: pull?.merged ? 'merged' : issue.state, labels: (issue.labels || []).map(label => label.name),
    text: markdownBlocks(issue.body).map(block => block.text).join('\n'), stats: { comments: issue.comments }, createdAt: Date.parse(issue.created_at) || undefined
  };
  const blocks = [{ kind: 'by', text: issue.user?.login || '' }, ...markdownBlocks(issue.body)];
  for (const comment of comments) blocks.push({ kind: 'by', text: comment.user?.login || '' }, ...markdownBlocks(comment.body));
  return { card, blocks };
}

const hostOf = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
function countWords(text) {
  try {
    let words = 0;
    for (const segment of new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text)) if (segment.isWordLike) words++;
    return words;
  } catch { return (text.match(/\S+/g) || []).length; }
}
const decode = text => text
  .replace(/&#x([0-9a-f]+);/gi, (entity, hex) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (entity, number) => String.fromCodePoint(Number(number)))
  .replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

// GitHub's Markdown as blocks of plain text: headings, list items,
// quotations, code, and paragraphs, with links reduced to their words.
export function markdownBlocks(markdown) {
  const blocks = [];
  let lines = [], code = null;
  const inline = text => decode(text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(^|[^\w*])(\*\*|__)(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
    .replace(/(^|[^\w*])([*_])(?=\S)(.+?)(?<=\S)\2(?![\w*])/g, '$1$3')
    .replace(/`([^`]+)`/g, '$1')).replace(/​/g, '').replace(/\s+/g, ' ').trim();
  const flush = () => { const text = inline(lines.join(' ')); if (text) blocks.push({ kind: 'p', text }); lines = []; };
  for (const line of String(markdown || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (code) {
      if (/^\s*(```|~~~)/.test(line)) { const text = code.join('\n').replace(/\n\s*\n+/g, '\n').trim(); if (text) blocks.push({ kind: 'pre', text }); code = null; }
      else code.push(line);
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) { flush(); code = []; continue; }
    if (!line.trim() || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { flush(); const text = inline(heading[2]); if (text) blocks.push({ kind: heading[1].length <= 2 ? 'h2' : 'h3', text }); continue; }
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ x]\]\s+)?(.*)$/i);
    if (item) { flush(); const text = inline(item[1]); if (text) blocks.push({ kind: 'li', text: `• ${text}` }); continue; }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) { flush(); const text = inline(quote[1]); if (text) blocks.push({ kind: 'q', text }); continue; }
    lines.push(line.trim());
  }
  if (code) { const text = code.join('\n').trim(); if (text) blocks.push({ kind: 'pre', text }); }
  flush();
  return blocks;
}

// Hacker News HTML (paragraphs, links, italics, code) as plain text or blocks.
export function htmlText(html) {
  return decode(String(html || '')
    .replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/gi, (block, code) => `\n\n${code.replace(/\n\s*\n+/g, '\n')}\n\n`)
    .replace(/<p>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')).replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
const htmlBlocks = html => htmlText(html).split('\n\n').map(text => ({ kind: text.includes('\n') ? 'pre' : 'p', text: text.trim() })).filter(block => block.text);

