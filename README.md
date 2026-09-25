<p align="center">
  <img src="icons/marked.svg" width="96" height="96" alt="Marked logo">
</p>

<h1 align="center">Marked</h1>

<p align="center">
  <b>A local-first bookmark library for Chrome and Firefox.</b><br>
  Save pages, posts from X, and the sentences that mattered, with your own notes and tags,<br>
  and ask a private, on-device AI how it all connects.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-123%2B-4285F4?logo=googlechrome&logoColor=white" alt="Chrome 123+">
  <img src="https://img.shields.io/badge/Firefox-142%2B-FF7139?logo=firefoxbrowser&logoColor=white" alt="Firefox 142+">
  <img src="https://img.shields.io/badge/Manifest-V3-2c5949" alt="Manifest V3">
  <img src="https://img.shields.io/badge/AI-on--device%20WebGPU-2c5949" alt="On-device AI with WebGPU">
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#privacy">Privacy</a> ·
  <a href="#develop">Develop</a>
</p>

<p align="center">
  <img src="docs/images/list.png" width="880" alt="The Marked library in list view, with folders, tags, notes, and highlights">
</p>

---

Browser bookmarks are a pile of titles you never open again. Marked keeps the *why*: your note, the passage you highlighted, a short abstract of the page, and tags. It all stays in your browser.

## Features

### Organize and find

Folders, tags, notes, and page abstracts captured when you save. Search everything instantly (press <kbd>/</kbd>), or browse a gallery of page previews and embedded posts from X. Each bookmark shows its site's icon, or its initial in the site's color.

<p align="center">
  <img src="docs/images/gallery.png" width="880" alt="Gallery view with page previews and an embedded post from X">
</p>

### Jump anywhere

Press <kbd>⌘</kbd>+<kbd>K</kbd> (<kbd>Ctrl</kbd>+<kbd>K</kbd> on Windows and Linux) to jump to any bookmark, folder, or tag, or to run a command. Press <kbd>?</kbd> for every shortcut.

<p align="center">
  <img src="docs/images/palette.png" width="880" alt="The command palette, matching bookmarks, folders, and commands as you type">
</p>

### Keep it fresh

- **Rediscover** brings back a few things you saved a while ago, favoring ones with notes or highlights.
- **Duplicates** finds pages you saved more than once and merges them, keeping every tag, note, and highlight.

### Highlight any sentence

Select text on any page and choose **Highlight** to save the passage with a note. Open the page again and your highlights are marked in yellow; hover over one to see your note.

<table>
  <tr>
    <td width="50%"><img src="docs/images/highlight-button.png" alt="Selecting a sentence shows the Highlight button"></td>
    <td width="50%"><img src="docs/images/highlight-panel.png" alt="The highlight panel on the page, with a note"></td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/highlights-on-page.png" width="880" alt="Saved highlights marked again on a revisited page, with a note shown on hover">
</p>

### Save posts from X

Right-click a post on x.com and choose **Save tweet to Marked**.

<p align="center">
  <img src="docs/images/save-tweet.png" width="880" alt="The editor, prefilled from a post on X">
</p>

### From any tab

- Type `mk` and a space in the address bar to search your library.
- The Marked button shows ✓ on pages you've saved.
- <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> saves the page you're on.
- **Save open tabs** keeps the whole window as a folder; **Open all** brings it back.

<p align="center">
  <img src="docs/images/address-bar.png" width="880" alt="Typing mk wiki in Firefox's address bar lists matching bookmarks from Marked">
</p>

<p align="center">
  <img src="docs/images/saved-badge.png" width="880" alt="The Marked button in Firefox's toolbar shows a check on a saved page">
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/images/save-tabs.png" alt="Saving the pages open in the window"></td>
    <td width="50%"><img src="docs/images/tabs-folder.png" alt="The saved session as a folder, with Open all"></td>
  </tr>
</table>

### Ask your bookmarks

**Chat** runs Qwen3 4B on your GPU and answers with citations to your bookmarks. Nothing leaves your device.

<p align="center">
  <img src="docs/images/chat.png" width="880" alt="Local chat answering a question about the library, with citations">
</p>

### Light or dark

Marked follows your system's theme, or pick one in **Settings**.

<p align="center">
  <img src="docs/images/dark.png" width="880" alt="The gallery in the dark theme">
</p>

### Search by meaning

Add a [TypeSafe Jev](https://typesafe.ai) API key in **Settings**, then click **Semantic** to rank bookmarks by meaning instead of keywords.

### Yours to keep

On first run, Marked offers to import your browser's bookmarks, folders and all, and never changes them. **Backup** moves everything to Marked in another browser; **Export** writes a standard bookmarks file, or your notes and highlights as Markdown.

<p align="center">
  <img src="docs/images/browser-import.png" width="880" alt="On first run, Marked offers to import the bookmarks it found in Chrome">
</p>

## Install

Load it from source. You need desktop Chrome 123+ or Firefox 142+, and Node.js 22+.

```sh
git clone https://github.com/shinoss/marked.git
cd marked
npm ci && npm run bundle:ai
```

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and select the folder.
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select `manifest.json`.

> [!NOTE]
> Chrome shows a harmless `'background.scripts' requires manifest version of 2 or lower` error, because one manifest serves both browsers. Firefox removes temporary add-ons when it restarts.

Local chat needs WebGPU and downloads the model (about 2.3 GB) from Hugging Face once. On a Mac, use Chrome and 16 GB of memory or more.

## Privacy

Your library stays in your browser. Marked only contacts:

- **Google Fonts**, for the Inter font.
- **Hugging Face**, when you download the chat model.
- **X**, to show embedded posts in the gallery.
- **TypeSafe**, when you click **Semantic**: your query and each bookmark's title and abstract (plus notes and highlights, if you allow them). Never addresses, folders, or tags.

Access to all websites lets Marked show the **Highlight** button, mark saved highlights, show ✓ on saved pages, and read your open tabs for **Save open tabs**. None of that leaves your device.

## Develop

```sh
npm ci
npm run bundle:ai        # once
npm test                 # unit and DOM tests
npm run lint:extension   # Firefox compatibility
npm run build            # extension ZIP in web-ext-artifacts/
```

After changing the manifest or background script, reload the extension. The tests mock the browser and don't run the model.

<p align="center"><sub>Screenshots show a demo library; the essay is a demo page served at <code>example.com</code>.</sub></p>
