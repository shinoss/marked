# Marked

A minimal Firefox bookmark manager with folders, search, list/gallery views, local page previews, and HTML import/export.

## Try it

Requires Firefox 142+ on desktop.

1. Clone this repository.
2. Open `about:debugging#/runtime/this-firefox` in Firefox.
3. Choose **Load Temporary Add-on…** and select `manifest.json`.
4. Open **Marked** from the extensions menu.

On first opening, Marked copies your Firefox bookmarks into its own local library. Subsequent changes are independent and never modify Firefox bookmarks.

Right-click a webpage and choose **Add to Marked** to save it. Uncheck **Save preview** if you don't want to retain a screenshot of the visible page.

Temporary add-ons are removed when Firefox restarts. Export bookmarks before uninstalling or clearing extension data; HTML exports do not include previews. Permanent installation on standard Firefox requires Mozilla signing.

## Develop

Requires Node.js 22+.

```sh
npm ci
npm test
npm run lint:extension
npm run build
```

No build step is needed to try the extension. Reload the manager tab after UI changes; use **Reload** in `about:debugging` after changing the manifest or background script.

Builds are written to `web-ext-artifacts/`. Tests use a mocked browser API; test browser integration in Firefox as well.

- `manager.html`, `manager.js`, `styles.css`: interface
- `store.js`: local library and initial bookmark copy
- `background.js`: toolbar and context-menu actions
- `bookmarks.js`: import/export
- `tests/`: automated tests
