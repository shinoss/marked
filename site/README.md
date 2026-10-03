# Marked website

The marketing site for Marked: plain static files, no framework, no build step, no external JavaScript.

```
index.html          Landing page (hero with the Chrome Web Store button and the install commands, the four steps of the tour, the other features, privacy summary, FAQ)
privacy.html        Privacy policy (effective October 1, 2026)
404.html            Not-found page (uses root-absolute paths, so it works at any URL)
site.css            All styles; light only, colors are custom properties on :root
images/list.webp    The library in list view, from docs/images/list.png in the extension repo (cut to 1896 px wide, without the app's scrollbar)
images/tour/        The four animations from the extension's tour (tour/ in the extension repo), and a still of each for reduced motion
fonts/              Literata for section titles (latin, upright), from the extension's vendor/fonts, with its OFL license
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

1. **Store links.** The hero (`#get`) has "Add to Chrome" and "Add to Firefox" buttons for the two store listings (a Firefox visitor gets the Firefox one first), and the FAQ and footer link to both.
2. **Domain.** The site is at `marked-bookmarks-sand.vercel.app` until it has its own domain. To move it, replace that address in `index.html` (canonical, Open Graph, Twitter), `privacy.html`, `robots.txt`, and `sitemap.xml`:
   ```sh
   grep -rl marked-bookmarks-sand.vercel.app . | xargs sed -i '' 's/marked-bookmarks-sand\.vercel\.app/your-domain.com/g'   # macOS sed
   ```
3. **404 page.** Vercel serves `404.html` for missing pages automatically (so do GitHub Pages, Netlify, and Cloudflare Pages). If the site lives in a subfolder rather than at the domain root, change the `/` paths in `404.html`.
4. **Privacy policy.** Re-read `privacy.html` against the extension you're shipping. It describes the current data flows: Hugging Face (chat model), X (embeds and the X bookmarks import), Hacker News and GitHub public APIs (cards), TypeSafe (semantic search, and tagging X imports), and page-text downloads without cookies. If any of those change, update the policy and its effective date. The contact is GitHub issues; add an email address if you want one. Use `https://<domain>/privacy.html` as the privacy policy URL in both store listings.
5. **Hosting logs.** The policy says the host may keep standard server logs. If you pick a host that doesn't, or does more, adjust section 7.

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

`og-image.png` was rendered in headless Chrome from an HTML composition in the site's style: the cream page with the logo, name, and tagline in Inter, a line with "the why" in the green marker, and `images/list.webp` on a forest-green stage that runs off the right and bottom edges. To regenerate it after changing the screenshot or tagline, render a 1200×630 page and capture it with `Page.captureScreenshot`.

## Notes

- Look: light only (`color-scheme: light`) and warm: a cream page (`--paper`), text in a green-tinted near-black, and the logo's forest green (`--forest`, `#2c5949`) for the hero's stage, buttons, the privacy band, and the footer, with pale sage (`--sage`) behind the tour animations and on the install card's bar. Colors are flat: no gradients or glows. Highlights are drawn in the app's green. Every text color is checked for contrast where it's used; the ratios are in the comments in `site.css`.
- Type: section titles (the `h2`s on the home page, and the page titles of the privacy policy and the 404 page) are in Literata, as the extension's tour titles are. Everything else is Inter, as in the app, including the name in the hero, the feature titles, the FAQ, and the privacy policy's headings. Keep the serif to those titles; it was tried for more and read as too much.
- Fonts: Inter from Google Fonts, which visitors' browsers request from Google, as the privacy policy says. Literata is served from `fonts/` on this site, so it adds no outside request. Only its latin subset is here; the page is in English.
- Hero: the name, tagline, and description beside the store button and the install card, then `images/list.webp` on the forest stage. It's the only screenshot on the page.
- Animations: the four steps show the extension's tour animations (animated WebP, 920 px wide for a 2x screen), with the tour's titles and alt text. If the tour's animations change, copy `tour/*.webp` from the extension repo into `images/tour/` and update each `width` and `height` in `index.html`. Everything below the hero uses `loading="lazy"`.
- Reduced motion: each animation is in a `<picture>` whose `(prefers-reduced-motion: reduce)` source is a still WebP of one frame: save 40 (the note typed, a tag chosen), highlight 40 (a color chosen, the note typed), search 17 and import 22 (their last frames). Remake a still after replacing its animation, with Pillow: open the WebP, take `ImageSequence.Iterator(image)` frame N, and save it as WebP at quality 82.
- "What else it does" stands in for the screenshots the site used to have: nine features from the extension README, a sentence or two each. The privacy band's list of services matches the privacy policy, so change both together.
