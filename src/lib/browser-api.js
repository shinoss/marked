// Firefox provides the Promise-based `browser` namespace. Chrome's Manifest V3
// `chrome` APIs return Promises too, so alias it and use `browser` everywhere.
// Loaded as a module by the background script and manager page.
globalThis.browser ??= globalThis.chrome;
