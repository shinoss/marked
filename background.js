// Runs as Chrome's module service worker and as Firefox's module event page.
import './browser-api.js';
import { cleanAbstract, cleanHighlightText, safeURL, searchPages, tweetId, validIcon } from './bookmarks.js';
import { INDEX_KEY, createLibraryStore } from './store.js';
import { readPageAbstract, readPageIcon } from './page-abstract.js';
import { captureTabText, PAGE_TEXT_SETTINGS_KEY } from './page-text.js';

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
// A saved page without its text gets it when it's next open in a tab. Only
// articles, when it happens by itself: never the text of an inbox or an
// account page that happens to be bookmarked.
async function fillText(tab, page, { articlesOnly = true } = {}) {
  page ??= tab?.url && await findBookmark(tab.url);
  if (!page) return;
  const store = createLibraryStore(browser);
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
  const [preview, abstract, icon, text] = await Promise.all([
    capturePreview(tab).catch(error => { console.warn('Preview unavailable; saving without one', error); return null; }),
    captureAbstract(tab, url).catch(error => { console.warn('Abstract unavailable; saving without one', error); return ''; }),
    captureIcon(tab).catch(() => null),
    captureText(tab, url).catch(error => { console.warn('Page text unavailable; saving without it', error); return null; })
  ]);
  await openEditor(url, tab?.title || url, preview || abstract || icon || text ? { ...(preview && { preview }), ...(abstract && { abstract }), ...(icon && { icon }), ...(text && { text }) } : null);
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
  await openEditor(tweet.url, tweetTitle(tweet.author, tweet.handle, text), text ? { abstract: text } : null);
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

// The toolbar button shows a check on pages already in Marked.
async function updateBadges(tabs) {
  const byPage = await savedPages();
  await Promise.all(tabs.map(async ({ id, url }) => {
    const saved = !!url && byPage.has(pageKey(url));
    await browser.action.setBadgeText({ tabId: id, text: saved ? '✓' : '' });
    await browser.action.setTitle({ tabId: id, title: saved ? 'Open Marked (this page is saved)' : 'Open Marked' });
  }).map(update => update.catch(() => {})));
}
const updateAllBadges = () => browser.tabs.query({}).then(updateBadges).catch(error => console.warn('Could not update the toolbar badge', error));
browser.action.setBadgeBackgroundColor({ color: '#2c5949' });
browser.action.setBadgeTextColor?.({ color: '#ffffff' });
browser.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url || change.status === 'complete') updateBadges([tab]).catch(() => {});
  if (change.status === 'complete') fillText(tab).catch(error => console.warn('Page text unavailable', error));
});
// Saving, editing, or deleting in Marked updates every open tab.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[INDEX_KEY]) updateAllBadges();
});
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

// highlighter.js asks about a passage the user chose to highlight. A saved page
// answers with its title, and the page shows its own panel for the note; a new
// page opens the editor, prefilled as Add to Marked, with the passage.
async function highlightPage(tab, message) {
  const text = cleanHighlightText(message.text);
  if (!text || !tab?.url) return null;
  const bookmark = await findBookmark(tab.url);
  if (bookmark) return { saved: bookmark.title || bookmark.url };
  const [preview, abstract, icon, page] = await Promise.all([
    capturePreview(tab).catch(() => null),
    captureAbstract(tab, tab.url).catch(() => ''),
    captureIcon(tab).catch(() => null),
    captureText(tab, tab.url).catch(() => null)
  ]);
  await openEditor(tab.url, tab.title || tab.url, { highlight: text, ...(preview && { preview }), ...(abstract && { abstract }), ...(icon && { icon }), ...(page && { text: page }) });
  return { opened: true };
}
// The page's panel saves a highlight. The bookmark is looked up again from the
// tab's own URL rather than taken from the page.
async function saveHighlight(tab, message) {
  const bookmark = tab?.url && await findBookmark(tab.url);
  if (!bookmark) throw new Error('This page is no longer in Marked.');
  await createLibraryStore(browser).addHighlight(bookmark.id, { text: message.text, note: message.note });
  return { ok: true };
}
// Chrome 123 does not accept promises from listeners, so reply through sendResponse.
browser.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab) return;
  if (message?.type === 'marked:highlight') {
    highlightPage(sender.tab, message).then(reply, error => { console.error('Could not open the highlight', error); reply(null); });
    return true;
  }
  if (message?.type === 'marked:save-highlight') {
    saveHighlight(sender.tab, message).then(reply, error => reply({ error: error.message }));
    return true;
  }
  // highlighter.js asks on every page for the passages saved on it, to mark them.
  if (message?.type === 'marked:page-highlights') {
    findBookmark(sender.tab.url || sender.url).then(page => reply(page?.highlights?.length ? { highlights: page.highlights } : null), () => reply(null));
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

// Alt+Shift+M adds the current page, as Add to Marked does.
browser.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'add-to-marked') return;
  tab ??= (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  addPage({}, tab).catch(error => console.error('Could not open Add to Marked', error));
});

browser.action.onClicked.addListener(async () => {
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
