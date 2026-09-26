# Marked website

The marketing site for Marked: plain static files, no framework, no build step, no external JavaScript.

```
index.html          Landing page (hero with the install commands, features, privacy summary, FAQ)
privacy.html        Privacy policy (effective September 26, 2026)
404.html            Not-found page (uses root-absolute paths, so it works at any URL)
site.css            All styles; light only, colors are custom properties on :root
images/             The 19 screenshots from docs/images in the extension repo, as WebP (cropped: app scrollbars trimmed, close-ups for the two-up pairs)
marked.svg          Logo and favicon
favicon-32.png      PNG favicon (from icons/marked-128.png)
apple-touch-icon.png 180×180, full-bleed (iOS rounds the corners itself)
og-image.png        1200×630 social card
robots.txt, sitemap.xml
```

## Preview locally

```sh
cd site
python3 -m http.server 8000
```

Open http://localhost:8000. (`http.server` doesn't serve `404.html` for missing pages; open http://localhost:8000/404.html to see it.)

## Before launch

1. **Store links.** The page has no store buttons yet: it opens with the install-from-source commands (`#get`). Once the listings are live, add "Add to Chrome" and "Add to Firefox" links there.
2. **Domain.** The site is at `marked-bookmarks-sand.vercel.app` until it has its own domain. To move it, replace that address in `index.html` (canonical, Open Graph, Twitter), `privacy.html`, `robots.txt`, and `sitemap.xml`:
   ```sh
   grep -rl marked-bookmarks-sand.vercel.app . | xargs sed -i '' 's/marked-bookmarks-sand\.vercel\.app/your-domain.com/g'   # macOS sed
   ```
3. **404 page.** Vercel serves `404.html` for missing pages automatically (so do GitHub Pages, Netlify, and Cloudflare Pages). If the site lives in a subfolder rather than at the domain root, change the `/` paths in `404.html`.
4. **Privacy policy.** Re-read `privacy.html` against the extension you're shipping. It describes the current data flows: Hugging Face (chat model), X (embeds and the X bookmarks import), Hacker News and GitHub public APIs (cards), TypeSafe (semantic search), and page-text downloads without cookies. If any of those change, update the policy and its effective date. The contact is GitHub issues; add an email address if you want one. Use `https://<domain>/privacy.html` as the privacy policy URL in both store listings.
5. **Hosting logs.** The policy says the host may keep standard server logs. If you pick a host that doesn't, or does more, adjust section 6.

## Deploy

The site is the Vercel project `marked-bookmarks` (free plan), deployed from this folder:

```sh
cd site
npx vercel link --project marked-bookmarks   # once per checkout
npx vercel deploy --prod
```

Or connect the project to the GitHub repository in Vercel with **Root Directory** set to `site`, so every push to `main` deploys it.

`vercel link` writes `.vercel/` (the project and account IDs) and may write `.env.local` (a short-lived access token). Both are ignored by `site/.gitignore`; never commit them. `.vercelignore` keeps this README out of the deployment.

## Social image

`og-image.png` was rendered in headless Chrome from an HTML composition in the site's style: a white background with the logo, name, tagline, and `images/list.webp` (the list screenshot from `docs/images/list.png` in the extension repo) in a 1px border, with no shadow. To regenerate it after changing the screenshot or tagline, render a 1200×630 page and capture it with `Page.captureScreenshot`.

## Notes

- Look: the site is light only (`color-scheme: light`, a white page in every system theme) and borrows the extension's look from its `styles.css`: Inter, `#222` text, `#666` muted gray, 1px `#ddd` lines, square boxes, text links, and plain text links. Green appears only in the logo, yellow only where a highlight is shown. No shadows, gradients, or tinted panels.
- Fonts: Inter from Google Fonts. Visitors' browsers request it from Google, and the privacy policy says so. (The extension itself ships its own copy of its fonts since 1.3.0.)
- Screenshots keep the README's alt text. Everything below the hero screenshot uses `loading="lazy"`. The hero shows `images/list.webp`. The feature sections follow the extension README's order and wording, except that the site leaves out "Light or dark".
- Screenshots are WebP made from the repo's 2x PNGs in headless Chrome (about 1.2 MB in total). The crops: every app screenshot is cut to 1896 px wide, which drops the 22 px app scrollbar on its right edge; the highlight, Save open tabs, and tab-folder pairs are cropped to the part that matters, so they stay legible side by side; highlights-on-page is cropped to its text column; empty space is trimmed from the bottom of search-text, related, and browser-import. The address-bar, saved-badge, and related-badge strips are full width. If you replace a screenshot, redo its crop and update its `width` and `height` in `index.html`.
