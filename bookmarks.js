// Pure import/export helpers, shared with tests. No remote resources are loaded.
export function safeURL(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'ftp:', 'file:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
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
