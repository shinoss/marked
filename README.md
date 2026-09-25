# Marked

A minimal bookmark manager for Chrome and Firefox with folders, tags, notes, search, list/gallery views, local page previews and abstracts, and HTML import/export.

## Try it

Requires desktop Chrome 123+ or Firefox 142+. Both browsers load the same folder and manifest.

1. Clone this repository and run `npm ci && npm run bundle:ai` (Node.js 22+). This packages the local inference runtime, not model weights.
2. Load the extension:
   - **Chrome:** open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the repository folder.
   - **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select `manifest.json`.
3. Open **Marked** from the extensions menu.

On first opening, Marked copies your browser's bookmarks into its own local library. Subsequent changes are independent and never modify the browser's bookmarks.

Right-click a webpage and choose **Add to Marked** to save it. Uncheck **Save preview** if you don't want to retain a screenshot of the visible page. Marked also fills in an **Abstract**: the page's own description followed by its first visible paragraphs, up to about 1,000 characters. Edit or clear it before saving. Local chat and search use it. Marked reads the page only when you choose **Add to Marked**, using the `activeTab` and `scripting` permissions. Apart from x.com and twitter.com (see below), it has no standing access to sites. Bookmarks copied from the browser or imported without descriptions have no abstract; add one with **Edit**.

### Notes and tags

Add a **Note** to any bookmark: your own words about why you saved it. A yellow **Note** label marks bookmarks with a note, in the list and on gallery cards; click it to read the whole note. Gallery cards for posts from X show the note itself beside the post. Notes are searchable, and local chat can use them.

**Tags** are topics such as Technology, AI, History, or Fiction. The editor shows your tag list as chips: click one to toggle it, or type a new tag and press Enter to add it to the list. When you use **Add to Marked**, likely tags are pre-selected. Choose **Suggest** to suggest tags for any bookmark. Add a tag to the list with the **+** next to **Tags** in the sidebar. The sidebar lists every tag with its count; click one to see those bookmarks, or remove it from the list and from every bookmark with its delete button. Search also matches tags.

Suggestions currently come from a simple keyword stand-in in `tagger.js` that runs entirely on your device: title words, abstract words, and a few known sites. It is meant to be replaced by TypeSafe's Jev model later; Marked does not call any tagging service yet.

### Posts from X

On x.com, right-click a post and choose **Save tweet to Marked**. On x.com the browser groups Marked's two menu items under **Marked — Bookmark Manager**. The editor opens with the post's link, a title like `Name (@handle) on X: “…”`, the post's text as its abstract, and suggested tags. If the pointer isn't over a post, Marked shows "No tweet under the cursor" on the page instead. A small content script on x.com and twitter.com (`tweet-capture.js`) notes which post is under the pointer when you open the menu. It reads nothing else and sends nothing off your device, but it does mean Marked has standing access to those two sites. If the page doesn't have Marked's script yet, for example because the tab was open before Marked was installed or reloaded, Marked adds it and asks you to right-click the post again. Firefox may leave x.com ungranted after an update, so the first **Save tweet to Marked** there also shows Firefox's permission prompt; allow it, and posts save on the first try from then on.

Bookmarks of posts on X (`x.com/<user>/status/<id>`, including older `twitter.com` links) appear as normal rows in the list view. In the gallery they show X's official embedded post, which loads from `platform.twitter.com`, across a full row with the title, date, tags, and note beside it. A narrow gallery stacks the details below the post. Other cards fill the space around posts, so the gallery's order can differ slightly from the list's. That request reaches X only while the gallery is open; the list view never contacts X.

Each browser keeps its own Marked library. To move a library between browsers, for example from Firefox to Chrome, choose **Backup** in one and **Import** the downloaded `marked-backup-….json` in the other. Backups keep folders, dates, previews, abstracts, notes, and tags, and are imported into a new “Imported” folder. HTML exports keep abstracts as bookmark descriptions (`<DD>`) and tags in Firefox's `TAGS` attribute, but not previews, dates, or notes.

Firefox removes temporary add-ons when it restarts; permanent installation on standard Firefox requires Mozilla signing. Chrome keeps unpacked extensions across restarts. Back up before uninstalling or clearing extension data.

Chrome lists `'background.scripts' requires manifest version of 2 or lower` under **Errors** for the extension. This is expected: the manifest declares a service worker for Chrome and background scripts for Firefox, and each browser ignores the other's entry.

## Develop

Requires Node.js 22+.

```sh
npm ci
npm run bundle:ai
npm test
npm run lint:extension
npm run build
```

Run `npm run bundle:ai` once before loading from source. Packaged extension ZIPs already contain the runtime. Reload the manager tab after UI changes. After changing the manifest or background script, use **Reload** in `about:debugging` (Firefox) or the reload button on `chrome://extensions` (Chrome).

Builds are written to `web-ext-artifacts/`; the same files load in Chrome after unzipping. `lint:extension` checks Firefox compatibility and reports one expected warning that Firefox ignores the Chrome service worker entry. Tests use a mocked browser API; test browser integration in Chrome and Firefox as well.

- `manager.html`, `manager.js`, `styles.css`: interface
- `store.js`: local library and initial bookmark copy
- `background.js`: toolbar and context-menu actions (a Chrome service worker and a Firefox event page)
- `page-abstract.js`: reads a page's description and opening text when you choose **Add to Marked**
- `tagger.js`: suggests tags (a local stand-in for a future Jev integration)
- `tweet-capture.js`: content script on x.com that finds the post under the pointer for **Save tweet to Marked**
- `browser-api.js`: provides the `browser` namespace in Chrome versions without it
- `bookmarks.js`, `backup.js`: import/export and backups
- `chat.js`, `ai-context.js`, `ai-config.js`: local chat and context selection
- `ai/`, `scripts/bundle-ai.js`: bundled WebLLM worker/runtime
- `tests/`: automated tests

## Experimental local chat

Open **Chat**, then choose **Download / load model** and approve access to the model-download hosts. Qwen3 4B (4-bit) downloads about 2.3 GB once into extension-local IndexedDB. After that, opening **Chat** loads the model from that cache automatically; reloading the page or restarting the browser does not download it again unless browser storage is cleared or evicted. No companion app, accounts, or API keys are needed.

Requires WebGPU with `shader-f16` and the bundled runtime’s GPU limits, including at least 10 storage buffers per shader stage. **On a Mac, use Chrome for local chat.** Some Firefox/macOS configurations expose only 9 storage buffers per shader stage and cannot run this runtime, while Chrome exposes the required limits (verified with Chrome 153 on an Apple Silicon Mac). The panel checks GPU support before fetching weights and rejects incompatible configurations. A smaller model alone does not fix that runtime requirement. Apple Silicon Macs with 16 GB or more memory are recommended; hardware alone does not guarantee browser compatibility. Initialization may take time and uses several GB of memory. There is no CPU/cloud fallback. A successful capability check does not guarantee the model will fit or run.

- Chat uses a limited, lexically selected sample of saved **titles, domains, folder names, tags, notes, and abstracts** (notes shortened to about 200 bytes and abstracts to about 300), plus a short overview of your tags, not full pages or screenshots. View the supplied bookmarks under each response.
- Connections are speculative; the model can be wrong. It cannot browse sites or modify bookmarks. A short recent exchange is retained as context; chats disappear on page reload.
- Bookmark metadata, abstracts, notes, tags, and chat messages are not uploaded. Model downloads contact Hugging Face and its CDN; network requests reveal normal connection information to those services.
- **Stop** interrupts generation. **Unload** (after a confirmation) cancels loading or releases GPU memory but keeps the download. Closing the panel does not unload it. Only one Marked tab can load the model at a time.
- **Remove download** deletes cached model files without touching bookmarks. Clearing chat does not delete the model.

Executable JavaScript and WASM are packaged locally; only model data is downloaded at runtime. The build pins the model revision and verifies the packaged model WASM checksum. `vendor/` is generated and excluded from Git but included in the extension ZIP. See `THIRD_PARTY.md` for dependencies.

GPU inference and offline cache reuse must be tested in the actual browser on the target Mac. Automated tests do not run a multi-GB model.
