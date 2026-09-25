// Runs as Chrome's module service worker and as Firefox's module event page.
import './browser-api.js';
import { cleanAbstract } from './bookmarks.js';
import { readPageAbstract } from './page-abstract.js';

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
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const data = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of data) binary += String.fromCharCode(byte);
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } finally { image.close(); }
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

// Opens the manager's editor for url, handing it optional captured details.
async function openEditor(url, title, capture) {
  // Worker timers may be suspended in Chrome. Also prune abandoned captures
  // on each action; expired captures are rejected by the editor in either case.
  const session = await browser.storage.session.get(null);
  const expired = Object.keys(session).filter(key => key.startsWith('capture-') && Date.now() - session[key].createdAt >= 60000);
  if (expired.length) await browser.storage.session.remove(expired);
  const params = new URLSearchParams({ add: url, title });
  let key;
  if (capture) {
    try {
      key = `capture-${crypto.randomUUID()}`;
      await browser.storage.session.set({ [key]: { url, ...capture, createdAt: Date.now() } });
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

async function addPage(info, tab) {
  // Bookmark the top-level page, not a clicked link or embedded image/frame.
  const url = tab?.url || info.pageUrl;
  if (!url) return;
  const [preview, abstract] = await Promise.all([
    capturePreview(tab).catch(error => { console.warn('Preview unavailable; saving without one', error); return null; }),
    captureAbstract(tab, url).catch(error => { console.warn('Abstract unavailable; saving without one', error); return ''; })
  ]);
  await openEditor(url, tab?.title || url, preview || abstract ? { ...(preview && { preview }), ...(abstract && { abstract }) } : null);
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
