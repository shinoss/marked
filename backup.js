import { safeURL, cleanAbstract, cleanNote, cleanTags, cleanHighlights, validIcon } from './bookmarks.js';
import { cleanPageText } from './page-text.js';

// texts: saved page texts by bookmark id. Each rides along on its bookmark;
// notes of pages that couldn't be read are left out.
export function exportBackup(root, texts = {}) {
  return JSON.stringify({ format: 'marked', version: 1, exportedAt: new Date().toISOString(), children: root.children || [] },
    (key, value) => value?.url && texts[value.id]?.text ? { ...value, text: texts[value.id] } : value);
}
export function parseBackup(data) {
  if (data?.format !== 'marked' || data.version !== 1 || !Array.isArray(data.children)) throw new Error('Unsupported Marked backup.');
  let count = 0, skipped = 0;
  function convert(node, depth) {
    if (!node || typeof node !== 'object' || depth > 100 || ++count > 100000) throw new Error('Invalid or excessively large bookmark hierarchy.');
    const result = { title: String(node.title || 'Untitled').slice(0, 2000) };
    if (Number.isFinite(node.dateAdded) && node.dateAdded > 0 && node.dateAdded <= 8640000000000000) result.dateAdded = node.dateAdded;
    if (node.type === 'separator') return { ...result, type: 'separator' };
    if (node.url) {
      result.url = safeURL(node.url);
      if (!result.url) { skipped++; return null; }
      if (typeof node.preview === 'string' && node.preview.length < 500000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(node.preview)) result.preview = node.preview;
      if (validIcon(node.icon)) result.icon = node.icon;
      const abstract = cleanAbstract(node.abstract);
      if (abstract) result.abstract = abstract;
      const note = cleanNote(node.note);
      if (note) result.note = note;
      const tags = cleanTags(node.tags);
      if (tags.length) result.tags = tags;
      const highlights = cleanHighlights(node.highlights);
      if (highlights.length) result.highlights = highlights;
      const text = cleanPageText(node.text);
      if (text?.text) result.text = { ...text, via: text.via || 'backup' };
    } else if (Array.isArray(node.children)) {
      result.children = node.children.map(child => convert(child, depth + 1)).filter(Boolean);
    } else throw new Error('A backup item is missing its URL or folder contents.');
    return result;
  }
  return { nodes: data.children.map(node => convert(node, 0)).filter(Boolean), skipped };
}
