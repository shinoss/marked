// Content script for x.com and twitter.com, declared in manifest.json. It notes
// the tweet under the pointer when the context menu opens and gives it to
// background.js for "Save tweet to Marked". background.js may also inject it
// again, so it registers its listeners once and declares no top-level let or
// const. Content scripts are classic scripts, not modules; tests evaluate this
// file in a JSDOM window.

// Returns { url, author, handle, text } for the tweet containing target, or null.
// Signed-in X marks tweets with data-testid attributes. Its signed-out client
// uses plain articles, has no <time> in permalinks, and nests quoted tweets.
function readTweet(target) {
  const article = target?.closest?.('article[data-testid="tweet"], article:not([data-testid])');
  if (!article) return null;
  // A quoted tweet sits in a link card, or its own article, inside the tweet.
  const own = element => element.parentElement.closest('article, [role="link"]') === article;
  const find = selector => [...article.querySelectorAll(selector)].filter(own);
  const body = find('[data-testid="tweetText"]')[0] ?? (article.hasAttribute('data-testid') ? null : find('div[dir="auto"]')[0]);
  // The permalink wraps the tweet's <time>. Other links to the tweet add /photo/1 and similar.
  const links = find('a[href*="/status/"]').filter(link => !body?.contains(link));
  const [, handle, id] = (links.find(link => link.querySelector('time')) ?? links[0])?.pathname.match(/^\/(\w+)\/status\/(\d+)/) ?? [];
  if (!id) return null;
  // The display name links to the author's profile, as do the avatar and @handle.
  const author = find(`a[href="/${handle}" i]`).map(link => textOf(link).replace(/\s+/g, ' ').trim()).find(name => name && !name.startsWith('@'));
  return { url: `https://x.com/${handle}/status/${id}`, author: author ?? '', handle, text: body ? textOf(body).trim() : '' };
}

// Text content, with emoji that X draws as images restored from their alt text.
function textOf(node) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.data;
    else if (child.localName === 'img') text += child.alt;
    else if (child.localName !== 'script' && child.localName !== 'style') text += textOf(child);
  }
  return text;
}

// A closed shadow root keeps the page's CSS out; CSSOM styles are not subject
// to the page's Content Security Policy. background.js injects a copy of this
// function where the content script is missing; tests keep the two identical.
function showNotice(text) {
  for (const old of document.querySelectorAll('marked-notice')) old.remove();
  const host = document.createElement('marked-notice');
  const notice = host.attachShadow({ mode: 'closed' }).appendChild(document.createElement('div'));
  notice.setAttribute('role', 'status');
  notice.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:auto 16px 24px;width:fit-content;max-width:480px;margin:0 auto;box-sizing:border-box;padding:8px 12px;border:1px solid #0f1419;border-radius:4px;background:#fff;color:#0f1419;font:13px/1.4 system-ui,sans-serif;direction:ltr;pointer-events:none';
  notice.textContent = text;
  document.documentElement.append(host);
  setTimeout(() => host.remove(), 3000);
}

if (!globalThis.markedTweetCapture) {
  globalThis.markedTweetCapture = true;
  let tweet = null;
  // Capture phase, so this runs before the page's own handlers.
  window.addEventListener('contextmenu', event => { tweet = readTweet(event.target); }, true);
  // Chrome versions without the `browser` namespace provide only `chrome`.
  (globalThis.browser ?? globalThis.chrome).runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'marked:tweet-under-pointer') {
      if (!tweet) showNotice('No tweet under the cursor. Right-click a tweet to save it.');
      reply(tweet);
      // Use each right-click once, so a menu opened without one can't reuse it.
      tweet = null;
    } else if (message?.type === 'marked:notice') {
      showNotice(String(message.text));
      reply(true);
    }
  });
}
