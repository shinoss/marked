// Access to the pages you visit (http and https), which Marked asks for in its
// own page, in its own words, rather than at install. It powers the Highlight
// button, saved highlights on pages, ✓ on saved pages, the related count,
// keeping the text of saved pages, and Save open tabs. What Marked reads there
// stays on the device.
// <all_urls> rather than http and https patterns: Firefox only lets an
// extension capture a tab's preview with <all_urls> (or activeTab).
export const ALL_SITES = { origins: ['<all_urls>'] };
// Set when the user answers "Not now", so the library doesn't ask again on its own.
export const SITE_ACCESS_ASKED_KEY = 'markedSiteAccessAsked';

export async function hasSiteAccess(api) {
  try { return await api.permissions.contains(ALL_SITES); } catch { return false; }
}
