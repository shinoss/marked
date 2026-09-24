const ADD_MENU = 'add-to-marked';

// Register once per background startup; remove an old registration on restart.
async function registerMenu() {
  await browser.menus.removeAll();
  browser.menus.create({
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
  const image = new Image();
  image.src = imageURL;
  await image.decode();
  const canvas = document.createElement('canvas');
  const scale = Math.min(480 / image.naturalWidth, 320 / image.naturalHeight, 1);
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

browser.menus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== ADD_MENU) return;
  // Bookmark the top-level page, not a clicked link or embedded image/frame.
  const url = tab?.url || info.pageUrl;
  if (!url) return;
  try {
    const params = new URLSearchParams({ add: url, title: tab?.title || url });
    let key;
    try {
      const preview = await capturePreview(tab);
      if (preview) {
        key = `preview-${crypto.randomUUID()}`;
        await browser.storage.session.set({ [key]: { url, preview, createdAt: Date.now() } });
        params.set('preview', key);
        // Expire captures if the editor is never opened. Session storage also
        // disappears on browser restart and is not exposed to content scripts.
        setTimeout(() => browser.storage.session.remove(key).catch(console.error), 60000);
      }
    } catch (error) { console.warn('Preview unavailable; saving without one', error); }
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
