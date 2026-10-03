// Pure import/export helpers, shared with tests. No remote resources are loaded.
export function safeURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ftp:', 'file:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// A site's small icon, captured when the page is saved: a data: image under 20 KB.
export function validIcon(value) {
  return typeof value === 'string' && value.length < 20000 && /^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
// A letter and a hue for a site without an icon, from the site's name rather
// than its subdomain (en.wikipedia.org gives W), the same every time.
export function monogram(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const labels = host.split('.').filter(Boolean);
  let name = labels.length > 1 ? labels[labels.length - 2] : labels[0] || '';
  if (labels.length > 2 && name.length <= 3 && labels[labels.length - 1].length === 2) name = labels[labels.length - 3];
  const letter = (name.match(/[\p{L}\p{N}]/u)?.[0] || '•').toUpperCase();
  let hash = 0;
  for (const char of name || String(url)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return { letter, hue: hash % 360 };
}

// A short plain-text description of a bookmarked page, saved for local chat.
export const ABSTRACT_LIMIT = 2000;
export function cleanAbstract(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, ABSTRACT_LIMIT) : '';
}

// The user's own note on a bookmark. Unlike abstracts, notes keep line breaks.
export const NOTE_LIMIT = 2000;
export function cleanNote(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, NOTE_LIMIT) : '';
}

// Passages the user highlighted on a page, each with an optional note.
export const HIGHLIGHT_LIMIT = 2000;
export const HIGHLIGHTS_PER_BOOKMARK = 100;
// Yellow is every highlight's color unless another is chosen, so it's never stored.
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];
export function cleanHighlightText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, HIGHLIGHT_LIMIT) : '';
}
export function cleanHighlight(value) {
  const text = cleanHighlightText(value?.text);
  if (!text) return null;
  const note = cleanNote(value.note);
  const color = HIGHLIGHT_COLORS.includes(value.color) && value.color !== 'yellow' ? value.color : '';
  return {
    id: typeof value.id === 'string' && value.id ? value.id.slice(0, 100) : crypto.randomUUID(),
    text,
    ...(note && { note }),
    ...(color && { color }),
    createdAt: Number.isFinite(value.createdAt) && value.createdAt > 0 ? value.createdAt : Date.now()
  };
}
export function cleanHighlights(values) {
  return (Array.isArray(values) ? values : []).map(cleanHighlight).filter(Boolean).slice(0, HIGHLIGHTS_PER_BOOKMARK);
}

// Topic tags. Bookmark files separate tags with commas, so names can't contain them.
export const TAG_LENGTH = 40;
export const TAGS_PER_BOOKMARK = 12;
export function cleanTag(value) {
  return typeof value === 'string' ? value.replace(/[,\s]+/g, ' ').trim().slice(0, TAG_LENGTH).trim() : '';
}
// Deduplicates case-insensitively, keeping the first spelling.
export function cleanTags(values, limit = TAGS_PER_BOOKMARK) {
  const tags = [], seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const tag = cleanTag(value);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase()); tags.push(tag);
    if (tags.length === limit) break;
  }
  return tags;
}

// The post ID of an X (Twitter) post URL such as https://x.com/<user>/status/<id>.
export function tweetId(url) {
  try {
    const { hostname, pathname } = new URL(url);
    if (!/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/.test(hostname)) return null;
    return pathname.match(/^\/[^/]+\/status(?:es)?\/(\d{1,25})(?:\/|$)/)?.[1] || null;
  } catch { return null; }
}

export function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function exportHTML(root) {
  function entries(nodes, depth) {
    const pad = '    '.repeat(depth);
    return nodes.map(node => {
      const title = escapeHTML(node.title || node.url || 'Untitled');
      // <DD> is the Netscape bookmark format's description field.
      const abstract = cleanAbstract(node.abstract);
      const tags = cleanTags(node.tags);
      if (node.url) return `${pad}<DT><A HREF="${escapeHTML(node.url)}"${tags.length ? ` TAGS="${escapeHTML(tags.join(','))}"` : ''}>${title}</A>${abstract ? `\n${pad}<DD>${escapeHTML(abstract)}` : ''}`;
      if (node.type === 'separator') return `${pad}<HR>`;
      return `${pad}<DT><H3>${title}</H3>\n${pad}<DL><p>\n${entries(node.children || [], depth + 1)}\n${pad}</DL><p>`;
    }).join('\n');
  }
  return '<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">\n<TITLE>Bookmarks</TITLE>\n<H1>Bookmarks</H1>\n<DL><p>\n' + entries(root.children || [], 1) + '\n</DL><p>\n';
}

// Supports Firefox's JSON backup format and a bookmarks.getTree() JSON export,
// as text or already-parsed data.
export function parseJSON(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input;
  let skipped = 0;
  let count = 0;
  function convert(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 100) throw new Error('Invalid or excessively nested bookmark file.');
    if (++count > 100000) throw new Error('This file contains too many items (maximum 100,000).');
    const title = String(node.title || 'Untitled');
    if (node.type === 'separator' || node.type === 'text/x-moz-place-separator') return { type: 'separator' };
    const url = node.url || node.uri;
    if (url) {
      const clean = safeURL(url);
      if (!clean) { skipped++; return null; }
      return { title, url: clean };
    }
    if (Array.isArray(node.children)) return { title, children: node.children.map(child => convert(child, depth + 1)).filter(Boolean) };
    skipped++;
    return null;
  }
  const roots = Array.isArray(data) ? data : [data];
  const nodes = roots.flatMap(node => {
    const converted = convert(node);
    if (!converted) return [];
    return node.root === 'placesRoot' || node.id === 'root________' ? converted.children || [] : [converted];
  });
  return { nodes, skipped };
}

// The browser's own bookmarks (bookmarks.getTree()) that the library doesn't
// have yet, compared by address and kept in their folders. Separators, folders
// left empty, and addresses Marked can't open (place:, javascript:) are left out.
// already counts the bookmarks the library has.
export function planBrowserImport(browserRoot, libraryRoot) {
  const saved = new Set();
  (function collect(node) {
    if (node.url) saved.add(safeURL(node.url) || node.url);
    node.children?.forEach(collect);
  })(libraryRoot);
  let count = 0, already = 0;
  function keep(node, depth) {
    if (depth > 100) return null;
    if (node.url) {
      const url = safeURL(node.url);
      if (!url) return null;
      if (saved.has(url)) { already++; return null; }
      count++;
      return { title: node.title || url, url, dateAdded: node.dateAdded };
    }
    if (!Array.isArray(node.children)) return null;
    const children = node.children.map(child => keep(child, depth + 1)).filter(Boolean);
    return children.length ? { id: node.id, title: node.title || 'Untitled folder', dateAdded: node.dateAdded, children } : null;
  }
  const nodes = (browserRoot?.children || []).map(child => keep(child, 1)).filter(Boolean);
  return { nodes, count, already };
}

// Bookmarks whose title or address holds every word of the query, best first:
// titles that start with it, then other title matches, then address matches,
// newest first within each. pages come from the library index.
export function searchPages(pages, query, limit = 6) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const phrase = words.join(' ');
  const found = [];
  for (const page of pages) {
    const title = (page.title || '').toLowerCase(), url = page.url.toLowerCase();
    if (!words.every(word => title.includes(word) || url.includes(word))) continue;
    found.push({ page, rank: title.startsWith(phrase) ? 0 : words.every(word => title.includes(word)) ? 1 : 2 });
  }
  return found.sort((a, b) => a.rank - b.rank || (b.page.dateAdded || 0) - (a.page.dateAdded || 0)).slice(0, limit).map(({ page }) => page);
}

// The page an address points to, for spotting a page saved twice: without its
// #fragment, "www.", tracking parameters, a trailing slash, or http vs https.
export function pageIdentity(url) {
  try {
    const page = new URL(url);
    page.hash = '';
    page.hostname = page.hostname.replace(/^www\./, '');
    if (page.protocol === 'http:') page.protocol = 'https:';
    for (const key of [...page.searchParams.keys()]) if (/^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/.test(key)) page.searchParams.delete(key);
    return page.href.replace(/\/$/, '');
  } catch { return String(url); }
}

// Notes and highlights as Markdown, for a notes app: each bookmark with a note or
// highlights, under its title, with its folder and tags.
export function exportMarkdown(root, date = new Date()) {
  const text = value => String(value).replace(/([\\`*_[\]#<>])/g, '\\$1');
  const lines = ['# Notes and highlights from Marked', '', `Exported ${date.toISOString().slice(0, 10)}.`, ''];
  (function walk(node, trail) {
    for (const child of node.children || []) {
      if (Array.isArray(child.children)) { walk(child, [...trail, child.title || 'Untitled folder']); continue; }
      const highlights = cleanHighlights(child.highlights), note = cleanNote(child.note);
      if (!child.url || (!note && !highlights.length)) continue;
      lines.push(`## [${text(child.title || child.url)}](${child.url.replace(/[()\s]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`, '');
      const context = [trail.map(text).join(' / '), ...cleanTags(child.tags).map(tag => `#${tag.replace(/\s+/g, '-')}`)].filter(Boolean).join(' · ');
      if (context) lines.push(`*${context}*`, '');
      if (note) lines.push(note, '');
      for (const highlight of highlights) {
        lines.push(`> ${highlight.text}`, '');
        if (highlight.note) lines.push(highlight.note, '');
      }
    }
  })(root, []);
  return lines.join('\n');
}

export function parseHTML(text, Parser = DOMParser) {
  const doc = new Parser().parseFromString(text, 'text/html');
  const root = doc.querySelector('dl');
  if (!root) throw new Error('No bookmark list found. Choose a bookmarks HTML export from Chrome, Firefox, or Marked.');
  let skipped = 0;
  let count = 0;
  function parseList(list, depth = 0) {
    if (depth > 100) throw new Error('Bookmark folders are nested too deeply.');
    const nodes = [];
    let folder = null;
    // HTML bookmark files have optional closing DT/P tags. Walk structural
    // descendants rather than assuming that a folder's DL is its next sibling.
    function walk(parent) {
      for (const el of parent.children) {
        if (++count > 500000) throw new Error('Bookmark file is too large.');
        if (el.tagName === 'H3') {
          folder = { title: el.textContent.trim() || 'Untitled folder', children: [] };
          nodes.push(folder);
        } else if (el.tagName === 'A') {
          const url = safeURL(el.getAttribute('href'));
          const tags = cleanTags((el.getAttribute('tags') || '').split(','));
          if (url) nodes.push({ title: el.textContent.trim() || url, url, ...(tags.length && { tags }) });
          else skipped++;
          folder = null;
        } else if (el.tagName === 'DL') {
          const children = parseList(el, depth + 1);
          if (folder) folder.children.push(...children);
          else nodes.push(...children);
          folder = null;
        } else if (el.tagName === 'HR') {
          nodes.push({ type: 'separator' });
        } else if (el.tagName === 'DD') {
          // A description follows its bookmark. Folder DDs may wrap the folder's DL.
          const last = nodes.at(-1);
          const text = cleanAbstract([...el.childNodes].filter(child => child.nodeType === 3).map(child => child.textContent).join(' '));
          if (text && last?.url && !last.abstract) last.abstract = text;
          walk(el);
        } else if (['DT', 'P'].includes(el.tagName)) walk(el);
      }
    }
    walk(list);
    return nodes;
  }
  return { nodes: parseList(root), skipped };
}
