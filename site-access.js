// Access to the pages you visit (http and https), which Marked asks for in its
// own page, in its own words, rather than at install. It lets Marked show the
// Highlight button on selected text, bring back highlights and ✓ on pages you
// revisit, count related bookmarks, and keep the text of saved articles you
// revisit; Save open tabs and downloading text for older bookmarks ask for it
// when used. Saving a page doesn't need it: the Marked button, the menu, and
// the shortcuts use activeTab. What Marked reads stays on the device.
// <all_urls> rather than http and https patterns: Firefox only lets an
// extension capture a tab's preview with <all_urls> (or activeTab).
export const ALL_SITES = { origins: ['<all_urls>'] };
// Set when the user answers "Not now", so the library doesn't ask again on its own.
export const SITE_ACCESS_ASKED_KEY = 'markedSiteAccessAsked';
// Set once the user saves a page from Marked's panel on it, or puts away the
// library's guide to doing that, which new users see (manager.js).
export const SAVE_GUIDE_KEY = 'markedSaveGuideDone';

export async function hasSiteAccess(api) {
  try { return await api.permissions.contains(ALL_SITES); } catch { return false; }
}
