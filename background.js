// Runs as Chrome's module service worker and as Firefox's module event page.
import './browser-api.js';
import { cleanAbstract, cleanHighlightText, safeURL, searchPages, tweetId, validIcon } from './bookmarks.js';
import { INDEX_KEY, createLibraryStore } from './store.js';
import { readPageAbstract, readPageIcon } from './page-abstract.js';
import { captureTabText, PAGE_TEXT_SETTINGS_KEY } from './page-text.js';
import { fetchSite, siteOf } from './sites.js';
import { documentTerms, expandIndex, similar, weigh, BROWSING_KEY, RELATED_KEY } from './related.js';

const ADD_MENU = 'add-to-marked';
const TWEET_MENU = 'save-tweet-to-marked';
const TWEET_URL = /^https:\/\/x\.com\/\w+\/status\/\d+$/;
const TWEET_ORIGINS = ['https://x.com/*', 'https://twitter.com/*'];
const RETRY_NOTICE = 'Marked is ready on this page now. Right-click the tweet again to save it.';

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
// account page that happens to be bookmarked. A saved post gets its card.
async function fillText(tab, page, { articlesOnly = true } = {}) {
  page ??= tab?.url && await findBookmark(tab.url);
  if (!page || (articlesOnly && !await keepText())) return;
  const store = createLibraryStore(browser);
  if (siteOf(page.url)) {
    if (page.card) return;
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

async function addPage(info, tab) {
  // Bookmark the top-level page, not a clicked link or embedded image/frame.
  const url = tab?.url || info.pageUrl;
  if (!url) return;
  // A page already in Marked opens its bookmark instead of adding a second
  // copy, and keeps the page's text if it has none yet.
  const saved = await findBookmark(url).catch(() => null);
  if (saved) {
    fillText(tab, saved, { articlesOnly: false }).catch(error => console.warn('Page text unavailable', error));
    return openManager(new URLSearchParams({ edit: saved.id }));
  }
  const [preview, abstract, icon, page, site] = await Promise.all([
    capturePreview(tab).catch(error => { console.warn('Preview unavailable; saving without one', error); return null; }),
    captureAbstract(tab, url).catch(error => { console.warn('Abstract unavailable; saving without one', error); return ''; }),
    captureIcon(tab).catch(() => null),
    captureText(tab, url).catch(error => { console.warn('Page text unavailable; saving without it', error); return null; }),
    captureSite(url)
  ]);
  // A post's own thread or discussion reads better than what the page shows of it.
  const text = site?.text && await keepText() ? site.text : page;
  const card = site?.card;
  await openEditor(url, tab?.title || url, preview || abstract || icon || text || card ? { ...(preview && { preview }), ...(abstract && { abstract }), ...(icon && { icon }), ...(text && { text }), ...(card && { card }) } : null);
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
  await openEditor(tweet.url, tweetTitle(tweet.author, tweet.handle, text), text || thread ? { ...(text && { abstract: text }), ...(thread && { text: thread }) } : null);
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
  const byPage = await savedPages();
  await Promise.all(tabs.map(async ({ id, url }) => {
    const saved = !!url && byPage.has(pageKey(url));
    const related = !saved && url && pageRelated.get(id)?.key === pageKey(url) ? pageRelated.get(id) : null;
    const text = saved ? '✓' : related ? String(related.count) : '';
    await browser.action.setBadgeText({ tabId: id, text });
    if (text) await browser.action.setBadgeBackgroundColor({ tabId: id, color: saved ? '#2c5949' : '#5b6474' });
    await browser.action.setTitle({ tabId: id, title: saved ? 'Open Marked (this page is saved)' : related ? `Open Marked (${related.count === 1 ? 'a saved bookmark relates' : `${related.count} saved bookmarks relate`} to this page)` : 'Open Marked' });
  }).map(update => update.catch(() => {})));
}
const updateAllBadges = () => browser.tabs.query({}).then(updateBadges).catch(error => console.warn('Could not update the toolbar badge', error));
browser.action.setBadgeBackgroundColor({ color: '#2c5949' });
browser.action.setBadgeTextColor?.({ color: '#ffffff' });
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'complete') updateBadges([tab]).catch(() => {});
  if (change.status === 'complete') {
    fillText(tab).catch(error => console.warn('Page text unavailable', error));
    startXImport(tabId).catch(error => console.warn('Could not start importing from X', error));
  }
});
// Saving, editing, or deleting in Marked updates every open tab.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[INDEX_KEY]) updateAllBadges();
  if (area === 'local' && changes[RELATED_KEY]) relatedCache = null;
});
browser.tabs.onRemoved?.addListener(tabId => { pageRelated.delete(tabId); browser.storage.session.remove?.(`related:${tabId}`)?.catch(() => {}); });
browser.runtime.onStartup?.addListener(updateAllBadges);
browser.runtime.onInstalled?.addListener(updateAllBadges);

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
// here to be saved. The job lives in session storage, so it outlasts a
// sleeping service worker, and only that tab may send posts.
const X_IMPORT = 'markedXImport';
async function importFromX() {
  const tab = await browser.tabs.create({ url: 'https://x.com/i/bookmarks', active: true });
  await browser.storage.session.set({ [X_IMPORT]: { tabId: tab.id, startedAt: Date.now() } });
}
// One at a time: a page can report finishing its load twice in a row.
let xStarting = Promise.resolve();
function startXImport(tabId) {
  xStarting = xStarting.catch(() => {}).then(() => askToCollect(tabId));
  return xStarting;
}
async function askToCollect(tabId) {
  const job = (await browser.storage.session.get(X_IMPORT))[X_IMPORT];
  if (job?.tabId !== tabId || job.asked) return;
  await browser.storage.session.set({ [X_IMPORT]: { ...job, asked: true } });
  const ask = () => browser.tabs.sendMessage(tabId, { type: 'marked:collect-bookmarks', pace: 900 }, { frameId: 0 });
  try { await ask(); }
  catch {
    await browser.scripting.executeScript({ target: { tabId }, files: ['tweet-capture.js'] });
    await ask();
  }
}
async function saveXBookmarks(tab, message) {
  const job = (await browser.storage.session.get(X_IMPORT))[X_IMPORT];
  if (job?.tabId !== tab.id) throw new Error('Start the import from Marked’s Import menu.');
  // X lists the newest bookmark first; dates count down from the import's start to keep that order.
  const tweets = (Array.isArray(message.tweets) ? message.tweets : []).slice(0, 200).filter(tweet => TWEET_URL.test(tweet?.url)).map(tweet => {
    const text = cleanAbstract(tweet.text);
    return { url: tweet.url, title: tweetTitle(String(tweet.author || ''), String(tweet.handle || ''), text), abstract: text, dateAdded: job.startedAt - Math.max(0, Number(tweet.order) || 0) };
  });
  const { added, known, folderId } = await createLibraryStore(browser).importTweets(tweets);
  await browser.storage.session.set({ [X_IMPORT]: { ...job, folderId } });
  return { added, known };
}
async function openXBookmarks() {
  const job = (await browser.storage.session.get(X_IMPORT))[X_IMPORT];
  await openManager(new URLSearchParams(job?.folderId ? { folder: job.folderId } : {}));
}

// highlighter.js asks about a passage the user chose to highlight. A saved page
// answers with its title, and the page shows its own panel for the note; a new
// page opens the editor, prefilled as Add to Marked, with the passage.
async function highlightPage(tab, message) {
  const text = cleanHighlightText(message.text);
  if (!text || !tab?.url) return null;
  const bookmark = await findBookmark(tab.url);
  if (bookmark) return { saved: bookmark.title || bookmark.url };
  const [preview, abstract, icon, captured, site] = await Promise.all([
    capturePreview(tab).catch(() => null),
    captureAbstract(tab, tab.url).catch(() => ''),
    captureIcon(tab).catch(() => null),
    captureText(tab, tab.url).catch(() => null),
    captureSite(tab.url)
  ]);
  const page = site?.text && await keepText() ? site.text : captured;
  await openEditor(tab.url, tab.title || tab.url, { highlight: text, ...(preview && { preview }), ...(abstract && { abstract }), ...(icon && { icon }), ...(page && { text: page }), ...(site?.card && { card: site.card }) });
  return { opened: true };
}
// The page's panel saves a highlight. The bookmark is looked up again from the
// tab's own URL rather than taken from the page.
async function saveHighlight(tab, message) {
  const bookmark = tab?.url && await findBookmark(tab.url);
  if (!bookmark) throw new Error('This page is no longer in Marked.');
  await createLibraryStore(browser).addHighlight(bookmark.id, { text: message.text, note: message.note, color: message.color });
  return { ok: true };
}
// Chrome 123 does not accept promises from listeners, so reply through sendResponse.
browser.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab) return;
  // From Marked's own pages.
  if (message?.type === 'marked:import-x' && sender.url?.startsWith(browser.runtime.getURL(''))) {
    importFromX().then(() => reply({ ok: true }), error => reply({ error: error.message }));
    return true;
  }
  // From X's bookmarks page, while Marked imports them.
  if (message?.type === 'marked:x-bookmarks') {
    saveXBookmarks(sender.tab, message).then(reply, error => reply({ error: error.message }));
    return true;
  }
  if (message?.type === 'marked:open-x-bookmarks') {
    openXBookmarks().catch(error => console.error('Could not open Marked', error));
    return;
  }
  if (message?.type === 'marked:highlight') {
    highlightPage(sender.tab, message).then(reply, error => { console.error('Could not open the highlight', error); reply(null); });
    return true;
  }
  if (message?.type === 'marked:save-highlight') {
    saveHighlight(sender.tab, message).then(reply, error => reply({ error: error.message }));
    return true;
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
  try { await ask(); }
  catch {
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['highlighter.js'] });
    await ask();
  }
}
browser.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'add-to-marked' && command !== 'highlight-selection') return;
  tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  if (command === 'add-to-marked') addPage({}, tab).catch(error => console.error('Could not open Add to Marked', error));
  else highlightSelection(tab).catch(error => console.warn('Could not highlight on this page', error));
});

browser.action.onClicked.addListener(async tab => {
  // On a page with related bookmarks, the button shows them.
  const related = tab?.id != null && (pageRelated.get(tab.id) ?? (await browser.storage.session.get(`related:${tab.id}`))[`related:${tab.id}`]);
  if (related && related.key === pageKey(tab.url)) {
    const key = `capture-${crypto.randomUUID()}`;
    await browser.storage.session.set({ [key]: { ...related.page, createdAt: Date.now() } });
    await browser.tabs.create({ url: `${browser.runtime.getURL('manager.html')}?related=${key}` });
    return;
  }
  const url = browser.runtime.getURL('manager.html');
  const tabs = await browser.tabs.query({});
  const existing = tabs.find(tab => tab.url === url);
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url });
  }
});
