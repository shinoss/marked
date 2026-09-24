// Runs as Chrome's module service worker and as Firefox's module event page.
import './browser-api.js';
import { cleanAbstract } from './bookmarks.js';
import { readPageAbstract } from './page-abstract.js';

const ADD_MENU = 'add-to-marked';

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

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== ADD_MENU) return;
  // Bookmark the top-level page, not a clicked link or embedded image/frame.
  const url = tab?.url || info.pageUrl;
  if (!url) return;
  try {
    // Worker timers may be suspended in Chrome. Also prune abandoned captures
    // on each action; expired captures are rejected by the editor in either case.
    const session = await browser.storage.session.get(null);
    const expired = Object.keys(session).filter(key => key.startsWith('capture-') && Date.now() - session[key].createdAt >= 60000);
    if (expired.length) await browser.storage.session.remove(expired);
    const params = new URLSearchParams({ add: url, title: tab?.title || url });
    let key;
    try {
      const [preview, abstract] = await Promise.all([
        capturePreview(tab).catch(error => { console.warn('Preview unavailable; saving without one', error); return null; }),
        captureAbstract(tab, url).catch(error => { console.warn('Abstract unavailable; saving without one', error); return ''; })
      ]);
      if (preview || abstract) {
        key = `capture-${crypto.randomUUID()}`;
        await browser.storage.session.set({ [key]: { url, ...(preview && { preview }), ...(abstract && { abstract }), createdAt: Date.now() } });
        params.set('capture', key);
        // Expire captures if the editor is never opened. Session storage also
        // disappears on browser restart and is not exposed to content scripts.
        setTimeout(() => browser.storage.session.remove(key).catch(console.error), 60000);
      }
    } catch (error) { console.warn('Page capture unavailable; saving without it', error); }
    try {
      await browser.tabs.create({ url: `${browser.runtime.getURL('manager.html')}?${params}` });
    } catch (error) {
      if (key) await browser.storage.session.remove(key);
      throw error;
    }
  } catch (error) { console.error('Could not open Add to Marked', error); }
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
