// Runs as Chrome's module service worker and as Firefox's module event page.
import './browser-api.js';
import { cleanAbstract, cleanHighlightText, safeURL, searchPages, tweetId, validIcon } from './bookmarks.js';
import { DEFAULT_TAGS, INDEX_KEY, createLibraryStore } from './store.js';
import { readPageAbstract, readPageIcon } from './page-abstract.js';
import { captureTabText, PAGE_TEXT_SETTINGS_KEY } from './page-text.js';
import { fetchSite, siteOf } from './sites.js';
import { documentTerms, expandIndex, similar, weigh, BROWSING_KEY, RELATED_KEY } from './related.js';
import { hasSiteAccess, SAVE_GUIDE_KEY } from './site-access.js';
import { suggestTags, chooseTags } from './tagger.js';
import { askJev, jevConsent, recordJevUsage, JEV_SETTINGS_KEY } from './jev.js';
import { tagAnswers, tagBatch, tagRequest } from './x-tags.js';

const ADD_MENU = 'add-to-marked';
const TWEET_MENU = 'save-tweet-to-marked';
const OPEN_MENU = 'open-marked';
const TWEET_URL = /^https:\/\/x\.com\/\w+\/status\/\d+$/;
const TWEET_ORIGINS = ['https://x.com/*', 'https://twitter.com/*'];
const RETRY_NOTICE = 'Marked is ready on this page now. Right-click the tweet again to save it.';
// The folder the last page saved from its panel went into; the next one starts there.
const SAVE_FOLDER_KEY = 'markedSaveFolder';

// The scripts Marked runs in web pages: the Highlight button and saved
// highlights on every page, and tweet capture on X. Their sites need access,
// which Marked asks for in its own page instead of at install, so each script
// is registered once its sites are allowed and removed if access is taken back.
const PAGE_SCRIPTS = [
  { id: 'marked-highlighter', matches: ['http://*/*', 'https://*/*'], js: ['highlighter.js'], runAt: 'document_idle', allFrames: false },
  { id: 'marked-tweet-capture', matches: TWEET_ORIGINS, js: ['tweet-capture.js'], runAt: 'document_idle', allFrames: false }
];
let pageScripts = Promise.resolve();
// One sync at a time: startup, install, and permission changes can overlap.
function syncPageScripts({ openTabs = false } = {}) {
  pageScripts = pageScripts.catch(() => {}).then(async () => {
    const registered = new Set((await browser.scripting.getRegisteredContentScripts()).map(script => script.id));
    for (const script of PAGE_SCRIPTS) {
      const allowed = await browser.permissions.contains({ origins: script.matches });
      if (allowed && !registered.has(script.id)) {
        await browser.scripting.registerContentScripts([script]);
        // Pages already open get it too, so the Highlight button works without a reload.
        if (openTabs) {
          for (const tab of await browser.tabs.query({ url: script.matches })) {
            await browser.scripting.executeScript({ target: { tabId: tab.id }, files: script.js }).catch(() => {});
          }
        }
      } else if (!allowed && registered.has(script.id)) {
        await browser.scripting.unregisterContentScripts({ ids: [script.id] });
      }
    }
  });
  return pageScripts;
}
const syncFailed = error => console.warn('Could not update Marked’s page scripts', error);
// Page scripts already running in open tabs follow the switch too, without a
// reload: taken back, they remove their marks and stop offering Highlight.
async function tellPages(allowed) {
  for (const tab of await browser.tabs.query({})) browser.tabs.sendMessage(tab.id, { type: 'marked:page-access', allowed }).catch(() => {});
}
// Taken back: forget what was worked out for open tabs, and clear their marks.
async function forgetPages() {
  pageRelated.clear();
  const related = Object.keys(await browser.storage.session.get(null)).filter(key => key.startsWith('related:'));
  if (related.length) await browser.storage.session.remove(related);
}

// Register once per background startup; remove an old registration on restart.
// `contextMenus` is Chrome's name for this API; Firefox supports it as an alias.
async function registerMenu() {
  await browser.contextMenus.removeAll();
  browser.contextMenus.create({
    id: ADD_MENU,
    title: 'Add to Marked',
    contexts: ['page', 'selection', 'link', 'image', 'video', 'audio'],
    documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*', 'ftp://*/*']
  });
  // The content script tweet-capture.js runs on these sites.
  browser.contextMenus.create({
    id: TWEET_MENU,
    title: 'Save tweet to Marked',
    contexts: ['page', 'link', 'image', 'video', 'selection'],
    documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*']
  });
  // The Marked button saves the page you're on; its own right-click menu opens Marked.
  browser.contextMenus.create({ id: OPEN_MENU, title: 'Open Marked', contexts: ['action'] });
}
registerMenu().catch(console.error);

async function capturePreview(tab) {
  if (!tab?.active || tab.id == null) return null;
  const [before] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (before?.id !== tab.id || before.url !== tab.url) return null;
  const imageURL = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
  const [after] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (after?.id !== tab.id || after.url !== tab.url) return null;
  // Service workers have no document, Image, or HTMLCanvasElement. These APIs
  // work in both Chrome's worker and Firefox's background page.
  const bytes = Uint8Array.from(atob(imageURL.split(',')[1]), char => char.charCodeAt(0));
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  try {
    const scale = Math.min(480 / image.width, 320 / image.height, 1);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    return dataURL(await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 }));
  } finally { image.close(); }
}
async function dataURL(blob) {
  let binary = '';
  for (const byte of new Uint8Array(await blob.arrayBuffer())) binary += String.fromCharCode(byte);
  return `data:${blob.type};base64,${btoa(binary)}`;
}

// The page's icon for the library's lists, read by the page itself, like the
// abstract. Marked's pages may only contact a few known services, so it never
// downloads icons. Without one, Marked shows a letter tile instead.
async function captureIcon(tab) {
  if (tab?.id == null) return null;
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, 2000, []); });
  try {
    const [injection] = await Promise.race([browser.scripting.executeScript({ target: { tabId: tab.id }, func: readPageIcon }), timeout]);
    return validIcon(injection?.result) ? injection.result : null;
  } finally { clearTimeout(timer); }
}

// activeTab grants access to this tab only after the user chooses Add to Marked.
async function captureAbstract(tab, url) {
  if (tab?.id == null) return '';
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, 2000, []); });
  try {
    const [injection] = await Promise.race([browser.scripting.executeScript({ target: { tabId: tab.id }, func: readPageAbstract }), timeout]);
    // Discard text from a page the tab navigated to after the click.
    return injection?.result?.url === url ? cleanAbstract(injection.result.text) : '';
  } finally { clearTimeout(timer); }
}

// The page's readable text, kept with its bookmark for search (Settings can
// turn this off). X posts keep their text as the abstract instead.
async function keepText() {
  try { return (await browser.storage.local.get(PAGE_TEXT_SETTINGS_KEY))[PAGE_TEXT_SETTINGS_KEY]?.keep !== false; } catch { return true; }
}
async function captureText(tab, url, options) {
  if (tab?.id == null || !/^https?:/.test(url) || tweetId(url) || !await keepText()) return null;
  return captureTabText(browser, tab.id, url, options);
}
// A post on Hacker News or GitHub gets a card, and its thread
// or discussion as its text, from the site's own API.
async function captureSite(url) {
  if (!siteOf(url)) return null;
  try { return await fetchSite(url, { timeout: 8000 }); } catch (error) { console.warn('No card for this page', error); return null; }
}
// A saved page without its text gets it when it's next open in a tab. Only
// articles, when it happens by itself: never the text of an inbox or an
// account page that happens to be bookmarked. A post gets its card from its
// site's API when it's saved, never on a visit: nothing Marked reads while you
// browse leaves the device.
async function fillText(tab, page, { articlesOnly = true } = {}) {
  page ??= tab?.url && await findBookmark(tab.url);
  if (!page || (articlesOnly && !await keepText())) return;
  const store = createLibraryStore(browser);
  if (siteOf(page.url)) {
    if (page.card || articlesOnly) return;
    const site = await captureSite(page.url);
    if (!site?.card) return;
    await store.setCards({ [page.id]: site.card });
    if (site.text && await keepText()) await store.setText(page.id, { ...site.text, via: 'visit' });
    return;
  }
  if ((await store.getTexts([page.id]))[page.id]?.text) return;
  const text = await captureText(tab, tab.url, { articlesOnly });
  if (text) await store.setText(page.id, { ...text, via: 'visit' }, { replace: false });
}

// Opens the manager with query params, handing it optional captured details.
async function openManager(params, capture) {
  // Worker timers may be suspended in Chrome. Also prune abandoned captures
  // on each action; expired captures are rejected by the editor in either case.
  const session = await browser.storage.session.get(null);
  const expired = Object.keys(session).filter(key => key.startsWith('capture-') && Date.now() - session[key].createdAt >= 60000);
  if (expired.length) await browser.storage.session.remove(expired);
  let key;
  if (capture) {
    try {
      key = `capture-${crypto.randomUUID()}`;
      await browser.storage.session.set({ [key]: { ...capture, createdAt: Date.now() } });
      params.set('capture', key);
      // Expire captures if the editor is never opened. Session storage also
      // disappears on browser restart and is not exposed to content scripts.
      setTimeout(() => browser.storage.session.remove(key).catch(console.error), 60000);
    } catch (error) { console.warn('Page capture unavailable; saving without it', error); }
  }
  try {
    await browser.tabs.create({ url: `${browser.runtime.getURL('manager.html')}?${params}` });
  } catch (error) {
    if (key) await browser.storage.session.remove(key);
    throw error;
  }
}

// Opens the manager's editor for url, handing it optional captured details.
function openEditor(url, title, capture) {
  return openManager(new URLSearchParams({ add: url, title }), capture && { url, ...capture });
}

// What Marked reads from a page for its bookmark. The preview comes first,
// before Marked shows anything on the page, with the abstract, which the save
// panel shows. The rest, read while the user fills in the panel, is the icon,
// the page's text, and a post's card: rest() resolves to them.
async function readPage(tab, url) {
  const abstract = captureAbstract(tab, url).catch(error => { console.warn('Abstract unavailable; saving without one', error); return ''; });
  const icon = captureIcon(tab).catch(() => null);
  const site = captureSite(url);
  const [preview, description] = await Promise.all([takePreview(tab, url), abstract]);
  const read = { ...(preview && { preview }), ...(description && { abstract: description }) };
  const rest = async () => {
    const [page, post, image] = await Promise.all([captureText(tab, url).catch(error => { console.warn('Page text unavailable; saving without it', error); return null; }), site, icon]);
    // A post's own thread or discussion reads better than what the page shows of it.
    const text = post?.text && await keepText() ? post.text : page;
    return { ...(image && { icon: image }), ...(text && { text }), ...(post?.card && { card: post.card }) };
  };
  return { read, rest };
}
// Saving a page again while its panel is open keeps the preview taken before
// the panel appeared; a new one would show the panel.
async function takePreview(tab, url) {
  const open = tab?.id != null && (await browser.storage.session.get(offerKey(tab.id)).catch(() => ({})))[offerKey(tab.id)];
  if (open && !open.id && open.url === url) return open.preview ?? null;
  return capturePreview(tab).catch(error => { console.warn('Preview unavailable; saving without one', error); return null; });
}

// Saving happens on the page, in Marked's save panel: panel.html, which
// save-panel.js shows there in a frame (showPanel). Marked keeps what it read
// from the page here, by tab, until the user saves or cancels. It's in session
// storage, so a save after the worker slept still has it. None of it goes to
// the page: the panel asks for what it shows (panelData), which is never the
// preview or the page's text. offer is a new page ({ url, title, and what was
// read }) or a saved one ({ id }). False where the panel can't show, as on the
// browser's own pages; the caller opens Marked's editor instead.
const offerKey = tabId => `save:${tabId}`;
// What's still being read for each tab's offer.
const reading = new Map();
async function offerSave(tab, offer, rest = async () => ({})) {
  if (tab?.id == null || (!offer.id && !safeURL(offer.url))) return false;
  const key = offerKey(tab.id), token = crypto.randomUUID();
  // The rest is read once the panel shows, and a save waits for it, even one
  // made the moment the panel appears.
  let showing;
  const read = new Promise(resolve => { showing = resolve; }).then(shown => shown && rest().then(async found => {
    const current = (await browser.storage.session.get(key))[key];
    if (current?.token === token && Object.keys(found).length) await browser.storage.session.set({ [key]: { ...current, ...found } });
  })).catch(error => console.warn('Could not finish reading the page', error));
  reading.set(tab.id, read);
  let shown = false;
  try {
    // A new page's panel says how many saved bookmarks relate to it, as the
    // Marked button's count did, unless what's saved is a post on the page.
    const related = offer.id ? null : await relatedTo(tab);
    const count = related && related.key === pageKey(offer.url) ? related.count : 0;
    await browser.storage.session.set({ [key]: { ...offer, token, form: { ...await saveForm(offer), ...(count && { related: count }) } } });
    shown = await showPanel(tab, 'save');
  } catch (error) {
    console.warn('Marked’s panel can’t show on this page; opening the editor instead', error);
  }
  showing(shown);
  if (shown) return true;
  if (reading.get(tab.id) === read) reading.delete(tab.id);
  try { if ((await browser.storage.session.get(key))[key]?.token === token) await browser.storage.session.remove(key); } catch {}
  return false;
}
// What the save panel shows for an offer: the page, or its saved bookmark, with
// the library's folders and tags.
async function saveForm(offer) {
  const store = createLibraryStore(browser);
  const [[root], tags, remembered] = await Promise.all([store.getTree(), store.getTags(), browser.storage.local.get(SAVE_FOLDER_KEY)]);
  // Folders as the editor lists them, the library's top level first.
  const folders = [];
  let bookmark = null;
  (function walk(node, depth) {
    if (node.url) { if (node.id === offer.id) bookmark = node; return; }
    if (node.type === 'separator') return;
    folders.push({ id: node.id, label: depth ? `${'　'.repeat(depth)}${node.title || 'Untitled'}` : 'Library (top level)' });
    node.children?.forEach(child => walk(child, depth + 1));
  })(root, 0);
  if (offer.id && !bookmark) throw new Error('This bookmark is no longer in Marked.');
  const last = remembered[SAVE_FOLDER_KEY];
  const folder = bookmark ? bookmark.parentId : folders.some(({ id }) => id === last) ? last : root.id;
  // A new page gets the tags its title, address, and abstract suggest, as in the editor.
  const chosen = bookmark ? bookmark.tags || [] : chooseTags(await suggestTags({ title: offer.title, url: offer.url, abstract: offer.abstract }, tags));
  return {
    edit: !!bookmark, url: bookmark ? bookmark.url : offer.url, title: bookmark ? bookmark.title : offer.title,
    folders, folder, tags, chosen, note: bookmark?.note || '', abstract: (bookmark ? bookmark.abstract : offer.abstract) || '',
    highlight: offer.highlight || '', preview: !!offer.preview
  };
}
// Shows one of Marked's panels on the tab's page: save-panel.js puts panel.html
// there in a frame. True once the panel shows; false where its frame never
// loads. Throws where Marked can't add to the page, as on the browser's own.
async function showPanel(tab, kind, details = {}) {
  await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['save-panel.js'] });
  return await browser.tabs.sendMessage(tab.id, { type: 'marked:show-panel', kind, ...details }, { frameId: 0 }) === true;
}
// What a panel asks for as it opens: for a save, the offer's form; for a
// highlight's note, the passage and its bookmark's title. Null if nothing
// waits for it.
async function panelData(tab, kind) {
  const key = kind === 'highlight' ? noteKey(tab.id) : offerKey(tab.id);
  const offer = (await browser.storage.session.get(key))[key];
  if (!offer) return null;
  return kind === 'highlight' ? { token: offer.token, title: offer.title, text: offer.text } : offer.form ? { token: offer.token, ...offer.form } : null;
}
// Save in the panel. The panel sends only what the user chose there; the page
// being saved and what Marked read from it come from the offer.
async function savePage(tab, message) {
  const key = offerKey(tab.id);
  await reading.get(tab.id);
  const offer = (await browser.storage.session.get(key))[key];
  if (!offer || offer.token !== message.token) throw new Error('This panel is out of date. Save the page again.');
  const title = typeof message.title === 'string' ? message.title.trim().slice(0, 2000) : '';
  if (!title) throw new Error('Enter a name.');
  const store = createLibraryStore(browser);
  const changes = { title, note: message.note, abstract: message.abstract, tags: message.tags };
  if (offer.id) await store.update(offer.id, changes, message.parentId);
  else {
    const created = await store.create({
      ...changes, url: offer.url, parentId: message.parentId, type: 'bookmark',
      ...(message.preview === true && offer.preview && { preview: offer.preview }), ...(offer.icon && { icon: offer.icon }), ...(offer.card && { card: offer.card }),
      ...(offer.highlight && { highlights: [{ text: offer.highlight, note: message.highlight?.note, color: message.highlight?.color }] })
    });
    if (offer.text && await keepText()) await store.setText(created.id, { ...offer.text, via: 'page' }).catch(error => console.warn('Could not keep the page text', error));
    await browser.storage.local.set({ [SAVE_FOLDER_KEY]: created.parentId });
    markSaved(tab, created.highlights?.[0]);
  }
  // Someone who has saved a page from its panel knows how: Marked's guide goes.
  if (!(await browser.storage.local.get(SAVE_GUIDE_KEY))[SAVE_GUIDE_KEY]) await browser.storage.local.set({ [SAVE_GUIDE_KEY]: Date.now() });
  await browser.storage.session.remove(key);
  reading.delete(tab.id);
  return { ok: true };
}
async function dropOffer(tabId, token) {
  await reading.get(tabId);
  const key = offerKey(tabId);
  if ((await browser.storage.session.get(key))[key]?.token !== token) return;
  await browser.storage.session.remove(key);
  reading.delete(tabId);
}
// A highlight just saved shows as marked on the page at once.
function markSaved(tab, highlight) {
  if (highlight) browser.tabs.sendMessage(tab.id, { type: 'marked:highlight-saved', highlight: { text: highlight.text, note: highlight.note || '', color: highlight.color } }, { frameId: 0 }).catch(() => {});
}

async function addPage(info, tab) {
  // Bookmark the top-level page, not a clicked link or embedded image/frame.
  const url = tab?.url || info.pageUrl;
  if (!url) return;
  // A page already in Marked edits its bookmark instead of adding a second
  // copy, and keeps the page's text if it has none yet.
  const saved = await findBookmark(url).catch(() => null);
  if (saved) {
    if (!await offerSave(tab, { id: saved.id })) await openManager(new URLSearchParams({ edit: saved.id }));
    fillText(tab, saved, { articlesOnly: false }).catch(error => console.warn('Page text unavailable', error));
    return;
  }
  const title = tab?.title || url;
  const { read, rest } = await readPage(tab, url);
  if (await offerSave(tab, { url, title, ...read }, rest)) return;
  const capture = { ...read, ...await rest() };
  await openEditor(url, title, Object.keys(capture).length ? capture : null);
}

async function saveTweet(tab) {
  if (tab?.id == null) return;
  let tweet;
  try {
    tweet = await browser.tabs.sendMessage(tab.id, { type: 'marked:tweet-under-pointer' }, { frameId: 0 });
  } catch (error) {
    // No content script: the tab was open before Marked was installed or
    // reloaded, or the browser has not granted Marked this site. This click
    // grants activeTab: add the script now so the next right-click works.
    console.warn('Tweet capture unavailable', error);
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['tweet-capture.js'] });
    await browser.scripting.executeScript({ target: { tabId: tab.id }, func: showNotice, args: [RETRY_NOTICE] });
    return;
  }
  // The content script has already told the user if no tweet was under the pointer.
  // It shares a process with the page, so accept only a canonical tweet URL.
  if (!TWEET_URL.test(tweet?.url)) return;
  const text = cleanAbstract(tweet.text);
  // A thread, unrolled on the tweet's own page, becomes the text of the bookmark.
  const posts = (Array.isArray(tweet.thread) ? tweet.thread : []).map(cleanAbstract).filter(Boolean).slice(0, 50);
  const thread = posts.length > 1 && await keepText()
    ? { text: posts.flatMap((post, index) => [`${index + 1}/${posts.length}`, post]).join('\n\n'), kinds: posts.flatMap(() => ['by', 'p']).join(' ') }
    : null;
  const title = tweetTitle(tweet.author, tweet.handle, text);
  const read = { ...(text && { abstract: text }), ...(thread && { text: thread }) };
  if (!await offerSave(tab, { url: tweet.url, title, ...read })) await openEditor(tweet.url, title, text || thread ? read : null);
}

// Titles a tweet after X's page titles, adding the handle: Name (@handle) on X: “text”.
function tweetTitle(author, handle, text) {
  const who = author && handle ? `${author} (@${handle})` : author || (handle ? `@${handle}` : 'Tweet');
  if (!text) return `${who} on X`;
  // Clip whole characters, including emoji, preferring a word break.
  const characters = Array.from(new Intl.Segmenter().segment(text), ({ segment }) => segment);
  if (characters.length <= 100) return `${who} on X: “${text}”`;
  const head = characters.slice(0, 100).join('');
  const space = head.lastIndexOf(' ');
  return `${who} on X: “${(space > head.length * 0.8 ? head.slice(0, space) : head).trimEnd()}…”`;
}

// Injected with executeScript where tweet-capture.js is not running, so it must
// not reference anything outside itself. Identical to showNotice there.
function showNotice(text) {
  for (const old of document.querySelectorAll('marked-notice')) old.remove();
  const host = document.createElement('marked-notice');
  const notice = host.attachShadow({ mode: 'closed' }).appendChild(document.createElement('div'));
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:auto 16px 24px;width:fit-content;max-width:480px;margin:0 auto;box-sizing:border-box;padding:8px 12px;border:1px solid #0f1419;border-radius:4px;background:#fff;color:#0f1419;font:13px/1.4 system-ui,sans-serif;direction:ltr;pointer-events:none';
  notice.textContent = text;
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 3000);
}

// The same page with or without a #fragment.
function pageKey(url) {
  try { const page = new URL(url); page.hash = ''; return page.href; } catch { return url; }
}
// Saved pages by address, the newest bookmark of each, from the library's small
// index rather than the whole library with its previews.
async function savedPages() {
  const byPage = new Map();
  for (const page of (await createLibraryStore(browser).getIndex()).pages) {
    const key = pageKey(page.url), old = byPage.get(key);
    if (!old || page.dateAdded > old.dateAdded) byPage.set(key, page);
  }
  return byPage;
}
// The newest bookmark of url in the library, or null.
async function findBookmark(url) {
  return (await savedPages()).get(pageKey(url)) ?? null;
}

// Saved bookmarks related to the page in each tab, found by comparing its title
// and headings with the library's stored index: { key, count, page } by tab id.
// Kept in session storage too, for a click after the worker slept.
const pageRelated = new Map();
let relatedCache = null;
async function relatedIndex() {
  if (!relatedCache) {
    const compact = (await browser.storage.local.get(RELATED_KEY))[RELATED_KEY];
    relatedCache = compact?.version === 1 ? expandIndex(compact) : null;
  }
  return relatedCache;
}
async function relateTab(tab, topics) {
  if (tab?.id == null || !/^https?:/.test(tab.url || '') || !topics) return;
  const browsing = (await browser.storage.local.get(BROWSING_KEY))[BROWSING_KEY];
  const index = browsing?.related === false ? null : await relatedIndex();
  const page = { url: tab.url, title: String(topics.title || '').slice(0, 300), abstract: [topics.description, ...(Array.isArray(topics.headings) ? topics.headings : [])].map(part => String(part || '').slice(0, 300)).join(' ').slice(0, 1500), text: String(topics.lead || '').slice(0, 1000) };
  // Two telling words in common at least, or it's a coincidence.
  const matches = index ? similar(index, weigh(index, documentTerms(page)), { limit: 9, min: 0.12 }).filter(match => match.shared.length >= 2) : [];
  const key = `related:${tab.id}`;
  if (matches.length) {
    const found = { key: pageKey(tab.url), count: matches.length, page };
    pageRelated.set(tab.id, found);
    await browser.storage.session.set({ [key]: found });
  } else {
    pageRelated.delete(tab.id);
    await browser.storage.session.remove?.(key);
  }
  await updateBadges([tab]);
}

// The toolbar button shows a check on pages already in Marked, and on other
// pages how many saved bookmarks relate to them.
async function updateBadges(tabs) {
  // Only with access to the pages you visit: not even on a tab whose address
  // Marked can see because the user just used it there.
  const allowed = await hasSiteAccess(browser);
  const byPage = allowed ? await savedPages() : new Map();
  await Promise.all(tabs.map(async ({ id, url }) => {
    const saved = allowed && !!url && byPage.has(pageKey(url));
    const related = allowed && !saved && url && pageRelated.get(id)?.key === pageKey(url) ? pageRelated.get(id) : null;
    const text = saved ? '✓' : related ? String(related.count) : '';
    await browser.action.setBadgeText({ tabId: id, text });
    if (text) await browser.action.setBadgeBackgroundColor({ tabId: id, color: saved ? '#2c5949' : '#5b6474' });
    // What a click does there: save the page, or edit its bookmark, or, where
    // there's no web page, open Marked.
    const title = url && !safeURL(url) ? 'Open Marked'
      : saved ? 'Edit in Marked (this page is saved)'
      : related ? `Save to Marked (${related.count === 1 ? 'a saved bookmark relates' : `${related.count} saved bookmarks relate`} to this page)`
      : 'Save to Marked';
    await browser.action.setTitle({ tabId: id, title });
  }).map(update => update.catch(() => {})));
}
const updateAllBadges = () => browser.tabs.query({}).then(updateBadges).catch(error => console.warn('Could not update the toolbar badge', error));
browser.action.setBadgeBackgroundColor({ color: '#2c5949' });
browser.action.setBadgeTextColor?.({ color: '#ffffff' });
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'complete') updateBadges([tab]).catch(() => {});
  if (change.status === 'loading') xTabLoading(tabId).catch(() => {});
  if (change.status === 'complete') {
    fillText(tab).catch(error => console.warn('Page text unavailable', error));
    startXImport(tab).catch(error => console.warn('Could not start importing from X', error));
  }
});
// Saving, editing, or deleting in Marked updates every open tab.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[INDEX_KEY]) updateAllBadges();
  if (area === 'local' && changes[RELATED_KEY]) relatedCache = null;
});
browser.tabs.onRemoved?.addListener(tabId => {
  pageRelated.delete(tabId);
  reading.delete(tabId);
  browser.storage.session.remove?.([`related:${tabId}`, offerKey(tabId), noteKey(tabId)])?.catch(() => {});
});
browser.runtime.onStartup?.addListener(() => { updateAllBadges(); syncPageScripts().catch(syncFailed); });
browser.runtime.onInstalled?.addListener(details => {
  updateAllBadges();
  syncPageScripts().catch(syncFailed);
  // A new install opens Marked, which shows how to save a page, with the tour
  // over it the first time (manager.js).
  if (details?.reason === 'install') {
    browser.storage.local.set({ markedTour: 'pending' }).catch(() => {}).then(openMarked)
      .catch(error => console.error('Could not open Marked', error));
  }
});
// Allowed in Marked's page, or in the browser's own settings; or taken back there.
browser.permissions?.onAdded?.addListener(() => {
  syncPageScripts({ openTabs: true }).then(() => tellPages(true)).catch(syncFailed);
  updateAllBadges();
});
browser.permissions?.onRemoved?.addListener(() => {
  syncPageScripts().then(() => tellPages(false)).catch(syncFailed);
  forgetPages().catch(() => {}).then(updateAllBadges);
});

// Type "mk", a space, and a few words in the address bar to search Marked.
// Chrome styles suggestions with XML markup; Firefox shows plain text.
const plainSuggestions = !!browser.runtime.getBrowserInfo;
const markup = text => plainSuggestions ? String(text) : String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
function suggestion(page) {
  let domain = '';
  try { domain = new URL(page.url).hostname.replace(/^www\./, ''); } catch {}
  const title = markup(page.title || page.url);
  // Firefox shows each suggestion's address after it; Chrome gets the domain, dimmed.
  return { content: page.url, description: plainSuggestions ? title : `${title} <dim>${markup(domain)}</dim>` };
}
browser.omnibox?.onInputChanged.addListener((text, suggest) => {
  browser.omnibox.setDefaultSuggestion({ description: `Search Marked for “${markup(text.trim())}”` });
  createLibraryStore(browser).getIndex()
    .then(({ pages }) => suggest(searchPages(pages, text).map(suggestion)), () => suggest([]));
});
// A chosen suggestion's text is its address; anything else is searched in Marked.
browser.omnibox?.onInputEntered.addListener((text, disposition) => {
  const url = safeURL(text.trim()) ?? `${browser.runtime.getURL('manager.html')}?${new URLSearchParams({ q: text.trim() })}`;
  const opening = disposition === 'currentTab' ? browser.tabs.update({ url }) : browser.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
  opening.catch(error => console.error('Could not open the search', error));
});

// Importing the bookmarks from X: Marked opens X's bookmarks page, and once it
// loads, asks the content script there to collect them; each batch comes back
// here to be saved, tagged by Jev if the user chose that. The job
// lives in session storage, so it outlasts a sleeping service worker, and only
// that tab may send posts.
const X_IMPORT = 'markedXImport';
const X_PAGE = /^https:\/\/(x|twitter)\.com\//;
// Whether the last import that saved posts went on to the end of the bookmarks,
// or to posts saved by an import that did. If it stopped short, the next import
// catches up: it doesn't stop at saved posts, and fills in the ones below them.
const X_COMPLETE_KEY = 'markedXImportComplete';
async function importFromX({ tag = false } = {}) {
  const catchUp = (await browser.storage.local.get(X_COMPLETE_KEY))[X_COMPLETE_KEY] !== true;
  const tab = await browser.tabs.create({ url: 'https://x.com/i/bookmarks', active: true });
  await browser.storage.session.set({ [X_IMPORT]: { tabId: tab.id, startedAt: Date.now(), tag, catchUp } });
  // X may have finished loading before the job was stored.
  const loaded = await browser.tabs.get?.(tab.id).catch(() => null);
  if (loaded?.status === 'complete') await startXImport(loaded);
}
// The job is read and changed one step at a time, so the tab's loads and the
// batches it saves can't undo each other's changes. step(job) returns the
// changes to store, if any.
let xJobs = Promise.resolve();
function withXJob(step) {
  const run = xJobs.catch(() => {}).then(async () => {
    const job = (await browser.storage.session.get(X_IMPORT))[X_IMPORT];
    const changes = await step(job);
    if (job && changes) await browser.storage.session.set({ [X_IMPORT]: { ...job, ...changes } });
  });
  xJobs = run;
  return run;
}
// Asked once per page: a page can report finishing its load twice in a row,
// and a new page in the tab (a reload, or X sending you on once you sign in)
// is asked again, until the import ends.
function xTabLoading(tabId) {
  return withXJob(job => job?.tabId === tabId && job.asked && !job.finished ? { asked: false } : null);
}
async function startXImport(tab) {
  let catchUp = null;
  await withXJob(job => {
    // Firefox reports a new tab's about:blank loaded before X starts loading.
    if (job?.tabId !== tab.id || job.asked || job.finished || (tab.url && !X_PAGE.test(tab.url))) return null;
    // A page asked after posts were saved must not stop at them.
    catchUp = !!(job.catchUp || job.saved);
    return { asked: true };
  });
  if (catchUp === null) return;
  const ask = () => browser.tabs.sendMessage(tab.id, { type: 'marked:collect-bookmarks', pace: 900, catchUp }, { frameId: 0 });
  try { await ask(); }
  catch {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['tweet-capture.js'] });
    await ask();
  }
}
// When X hasn't shown the bookmarks after a long wait, the page asks to be
// reloaded, as X itself suggests when it can't load them: twice at most.
async function reloadXImport(tab) {
  let reload = false;
  await withXJob(job => {
    if (job?.tabId !== tab.id || job.finished || (job.reloads || 0) >= 2) return null;
    reload = true;
    return { reloads: (job.reloads || 0) + 1, asked: false };
  });
  return reload;
}
async function endXImport(tab, complete) {
  let ended = false;
  await withXJob(job => {
    if (job?.tabId !== tab.id) return null;
    ended = true;
    return { finished: true };
  });
  if (ended && complete) await browser.storage.local.set({ [X_COMPLETE_KEY]: true });
}
async function saveXBookmarks(tab, message) {
  const job = (await browser.storage.session.get(X_IMPORT))[X_IMPORT];
  if (job?.tabId !== tab.id) throw new Error('Start the import from Marked’s Import menu.');
  // X lists the newest bookmark first; dates count down from the import's start to keep that order.
  const tweets = (Array.isArray(message.tweets) ? message.tweets : []).slice(0, 200).filter(tweet => TWEET_URL.test(tweet?.url)).map(tweet => {
    const text = cleanAbstract(tweet.text), author = String(tweet.author || ''), handle = String(tweet.handle || '');
    return { url: tweet.url, title: tweetTitle(author, handle, text), abstract: text, by: [author, handle && `@${handle}`].filter(Boolean).join(' '), context: tweetContext(tweet), dateAdded: job.startedAt - Math.max(0, Number(tweet.order) || 0) };
  });
  const store = createLibraryStore(browser);
  const { chosen, error } = job.tag ? await tagTweets(store, tweets) : { chosen: {} };
  const { added, tagged, known, folderId } = await store.importTweets(tweets, 'X bookmarks', chosen);
  await withXJob(async current => {
    if (current?.tabId !== tab.id) return null;
    // Until this import reaches the end, there may be a gap below what it saved.
    if (added && !current.saved) await browser.storage.local.set({ [X_COMPLETE_KEY]: false });
    // Once tagging fails, the rest of the import isn't tagged, rather than
    // trying TypeSafe again for every batch the page sends.
    return { ...(folderId && { folderId }), ...(error && { tag: false }), ...(added && { saved: true }) };
  });
  return { added, tagged, known, ...(error && { tagError: error }) };
}
// What a post shows besides its text, as tweet-capture.js read it from X's page:
// the post it quotes, its image descriptions, and its link preview. Only Jev
// reads it, to tag the post; the bookmark doesn't keep it.
function tweetContext(tweet) {
  const plain = value => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 1000) : '';
  const quote = { author: plain(tweet.quote?.author), text: plain(tweet.quote?.text) };
  const images = (Array.isArray(tweet.images) ? tweet.images : []).map(plain).filter(Boolean).slice(0, 4);
  const link = plain(tweet.link);
  return { ...((quote.author || quote.text) && { quote }), ...(images.length && { images }), ...(link && { link }) };
}
// The new posts among tweets, each with the tags from the user's tag list that
// Jev says fit it best, with the user's own TypeSafe key: { chosen: { url: [tag] } },
// and why it stopped, if it couldn't tag them all. A tag list the user emptied
// gets DEFAULT_TAGS back first, for Jev to choose from. Posts no tag fits get
// none. With previews on in Settings, it needs no key and sends nothing: each
// request goes to this console instead, for every batch of the import, and no
// post gets tags.
async function tagTweets(store, tweets) {
  const chosen = {};
  try {
    const posts = (await store.newTweets(tweets)).map(tweet => ({ url: tweet.url, author: tweet.by, text: tweet.abstract, ...tweet.context }));
    if (!posts.length) return { chosen };
    const jev = (await browser.storage.local.get(JEV_SETTINGS_KEY))[JEV_SETTINGS_KEY] || {};
    if (!jev.apiKey && !jev.preview) throw new Error('Add your TypeSafe API key in Marked’s Settings to tag posts.');
    if (!jev.preview && !await jevConsent(browser, ['websiteContent'])) throw new Error('Firefox isn’t letting Marked send posts to TypeSafe. Save your key in Marked’s Settings again to allow it.');
    let tags = await store.getTags();
    if (!tags.length) tags = await store.addTags(DEFAULT_TAGS);
    const size = tagBatch(tags);
    for (let at = 0; at < posts.length; at += size) {
      const batch = posts.slice(at, at + size);
      const { answers } = await askJev({ apiKey: jev.apiKey, preview: jev.preview, ...tagRequest(tags, batch), onUsage: usage => { recordJevUsage(browser.storage.local, usage).catch(() => {}); } });
      Object.assign(chosen, tagAnswers(tags, batch, answers));
    }
    return { chosen };
  } catch (error) {
    console.warn('Could not tag the posts from X', error);
    return { chosen, error: error.message };
  }
}
async function openXBookmarks() {
  const job = (await browser.storage.session.get(X_IMPORT))[X_IMPORT];
  await openManager(new URLSearchParams(job?.folderId ? { folder: job.folderId } : {}));
}

// highlighter.js asks about a passage the user chose to highlight. A saved page
// gets Marked's note panel beside the passage; a new page gets the save panel,
// as with Add to Marked, with the passage.
async function highlightPage(tab, message) {
  const text = cleanHighlightText(message.text);
  if (!text || !tab?.url) return null;
  const bookmark = await findBookmark(tab.url);
  if (bookmark) return offerNote(tab, bookmark, text, cleanAnchor(message.anchor));
  const title = tab.title || tab.url;
  const { read, rest } = await readPage(tab, tab.url);
  if (!await offerSave(tab, { url: tab.url, title, highlight: text, ...read }, rest)) await openEditor(tab.url, title, { highlight: text, ...read, ...await rest() });
  return { opened: true };
}
// Where the passage is in the window, for the note panel to go beside it.
const cleanAnchor = anchor => ['top', 'bottom', 'right'].every(side => Number.isFinite(anchor?.[side])) ? { top: anchor.top, bottom: anchor.bottom, right: anchor.right } : null;
// A highlight on a saved page gets its note in Marked's note panel. The passage
// and the page it's on wait here, by tab, until the user saves or cancels there.
const noteKey = tabId => `highlight:${tabId}`;
async function offerNote(tab, bookmark, text, anchor) {
  const key = noteKey(tab.id), token = crypto.randomUUID();
  let shown = false;
  try {
    await browser.storage.session.set({ [key]: { token, url: tab.url, title: bookmark.title || bookmark.url, text } });
    shown = await showPanel(tab, 'highlight', { anchor });
  } catch (error) {
    console.warn('Marked’s note panel can’t show on this page; keeping the highlight without a note', error);
  }
  if (shown) return { opened: true };
  // Where the panel can't show, the passage is kept anyway, without a note.
  try { if ((await browser.storage.session.get(key))[key]?.token === token) await browser.storage.session.remove(key); } catch {}
  markSaved(tab, await createLibraryStore(browser).addHighlight(bookmark.id, { text }));
  return { highlighted: true };
}
// Save in the note panel: the passage kept here goes to the bookmark of the
// page it was highlighted on, looked up again.
async function saveNote(tab, message) {
  const key = noteKey(tab.id);
  const offer = (await browser.storage.session.get(key))[key];
  if (!offer || offer.token !== message.token) throw new Error('This panel is out of date. Highlight the passage again.');
  const bookmark = await findBookmark(offer.url);
  if (!bookmark) throw new Error('This page is no longer in Marked.');
  const saved = await createLibraryStore(browser).addHighlight(bookmark.id, { text: offer.text, note: message.note, color: message.color });
  await browser.storage.session.remove(key);
  markSaved(tab, saved);
  return { ok: true };
}
async function dropNote(tabId, token) {
  const key = noteKey(tabId);
  if ((await browser.storage.session.get(key))[key]?.token === token) await browser.storage.session.remove(key);
}
// Marked's panels on web pages are its own page, panel.html, in save-panel.js's
// frame. Only they save what the user chose there, never a script in the page.
function fromPanel(sender) {
  try {
    const { protocol, pathname } = new URL(sender.url);
    return protocol === new URL(browser.runtime.getURL('')).protocol && pathname === '/panel.html';
  } catch { return false; }
}
// Chrome 123 does not accept promises from listeners, so reply through sendResponse.
browser.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab) return;
  // From Marked's own pages.
  if (message?.type === 'marked:import-x' && sender.url?.startsWith(browser.runtime.getURL(''))) {
    importFromX({ tag: message.tag === true }).then(() => reply({ ok: true }), error => reply({ error: error.message }));
    return true;
  }
  // From X's bookmarks page, while Marked imports them.
  if (message?.type === 'marked:x-bookmarks') {
    saveXBookmarks(sender.tab, message).then(reply, error => reply({ error: error.message }));
    return true;
  }
  if (message?.type === 'marked:x-reload') {
    reloadXImport(sender.tab).then(reload => {
      reply(reload);
      if (reload) browser.tabs.reload(sender.tab.id).catch(error => console.warn('Could not reload X', error));
    }, () => reply(false));
    return true;
  }
  if (message?.type === 'marked:x-import-end') {
    endXImport(sender.tab, message.complete === true).catch(error => console.warn('Could not finish importing from X', error));
    return;
  }
  if (message?.type === 'marked:open-x-bookmarks') {
    openXBookmarks().catch(error => console.error('Could not open Marked', error));
    return;
  }
  if (message?.type === 'marked:highlight') {
    highlightPage(sender.tab, message).then(reply, error => { console.error('Could not open the highlight', error); reply(null); });
    return true;
  }
  // From Marked's panels, which it showed on this tab.
  if (fromPanel(sender)) {
    if (message?.type === 'marked:panel-data') {
      panelData(sender.tab, message.kind).then(reply, () => reply(null));
      return true;
    }
    if (message?.type === 'marked:save-page') {
      savePage(sender.tab, message).then(reply, error => reply({ error: error.message }));
      return true;
    }
    if (message?.type === 'marked:cancel-save') {
      dropOffer(sender.tab.id, message.token).catch(() => {});
      return;
    }
    if (message?.type === 'marked:save-highlight') {
      saveNote(sender.tab, message).then(reply, error => reply({ error: error.message }));
      return true;
    }
    if (message?.type === 'marked:cancel-highlight') {
      dropNote(sender.tab.id, message.token).catch(() => {});
      return;
    }
    if (message?.type === 'marked:open-marked') {
      openMarked().catch(error => console.error('Could not open Marked', error));
      return;
    }
    if (message?.type === 'marked:open-related') {
      openRelated(sender.tab).catch(error => console.error('Could not open Marked', error));
      return;
    }
  }
  // highlighter.js asks on every page for the passages saved on it, to mark
  // them, and says what an unsaved page is about, to count related bookmarks.
  if (message?.type === 'marked:page-highlights') {
    findBookmark(sender.tab.url || sender.url).then(page => {
      reply(page?.highlights?.length ? { highlights: page.highlights } : null);
      if (!page) relateTab(sender.tab, message.topics).catch(error => console.warn('Could not find related bookmarks', error));
    }, () => reply(null));
    return true;
  }
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === ADD_MENU) return addPage(info, tab).catch(error => console.error('Could not open Add to Marked', error));
  if (info.menuItemId === OPEN_MENU) return openMarked().catch(error => console.error('Could not open Marked', error));
  if (info.menuItemId === TWEET_MENU) {
    // Firefox leaves content-script sites ungranted after some installs and
    // updates. Ask now, while the click still counts as user input; this
    // resolves at once without a prompt when access is already granted.
    if (browser.runtime.getBrowserInfo) browser.permissions.request({ origins: TWEET_ORIGINS }).catch(error => console.warn('Could not request access to X', error));
    return saveTweet(tab).catch(error => console.error('Could not save tweet to Marked', error));
  }
});

// Alt+Shift+M adds the current page, as Add to Marked does. Alt+Shift+H
// highlights the selection, through the page's highlighter; a tab opened
// before Marked was installed gets the highlighter first.
async function highlightSelection(tab) {
  if (tab?.id == null) return;
  // Marked's reader highlights in its own page, which content scripts can't reach.
  if (tab.url?.startsWith(browser.runtime.getURL('reader.html'))) {
    await browser.runtime.sendMessage({ type: 'marked:reader-highlight', tabId: tab.id });
    return;
  }
  const ask = () => browser.tabs.sendMessage(tab.id, { type: 'marked:highlight-selection' }, { frameId: 0 });
  // The highlighter answers true. Without it the page has no answer, or one
  // from another of Marked's scripts (save-panel.js) that leaves this alone.
  if (await ask().catch(() => null) === true) return;
  await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['highlighter.js'] });
  await ask();
}
browser.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'add-to-marked' && command !== 'highlight-selection') return;
  tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (command === 'add-to-marked') addPage({}, tab).catch(error => console.error('Could not open Add to Marked', error));
  else highlightSelection(tab).catch(error => console.warn('Could not highlight on this page', error));
});

// Marked's library: its open tab, brought forward, or a new one.
async function openMarked() {
  const url = browser.runtime.getURL('manager.html');
  const existing = (await browser.tabs.query({})).find(tab => tab.url === url);
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
}
// The saved bookmarks related to the page in a tab, if it's still that page.
async function relatedTo(tab) {
  if (tab?.id == null) return null;
  const related = pageRelated.get(tab.id) ?? (await browser.storage.session.get(`related:${tab.id}`))[`related:${tab.id}`];
  return related?.key === pageKey(tab.url) ? related : null;
}
// Marked, showing the bookmarks related to the page in a tab.
async function openRelated(tab) {
  const related = await relatedTo(tab);
  if (!related) return openMarked();
  const key = `capture-${crypto.randomUUID()}`;
  await browser.storage.session.set({ [key]: { ...related.page, createdAt: Date.now() } });
  await browser.tabs.create({ url: `${browser.runtime.getURL('manager.html')}?related=${key}` });
}

// The Marked button saves the page you're on, in its panel, as Add to Marked
// does, or edits its bookmark once it's saved. Where there's no web page to
// save, as on a new tab or the browser's own pages, it opens Marked.
browser.action.onClicked.addListener(tab => (safeURL(tab?.url) ? addPage({}, tab) : openMarked())
  .catch(error => console.error('Could not save the page', error)));
