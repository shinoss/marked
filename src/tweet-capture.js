// Content script for x.com and twitter.com, registered by background.js once
// Marked is allowed there. It notes the tweet under the pointer when the
// context menu opens and gives it to background.js for "Save tweet to Marked".
// background.js may also inject it again, so it registers its listeners once
// and declares no top-level let or const. Content scripts are classic scripts,
// not modules; tests evaluate this file in a JSDOM window.

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

// For a tagged import, what a post shows besides its own text, for Jev to read
// with it: the post it quotes, the descriptions of its images (when the author
// wrote one; X's own says only "Image"), and the preview of a page it links to.
// Jev reads text only, so images go as their descriptions or not at all.
// Returns { quote: { author, text }, images: [description], link }, with only
// what the post has.
function readExtras(article) {
  // A quoted post is a card, or its own article, inside the post. The post's
  // own photos are links too, so only a card that is a <div> counts.
  const quoted = element => element.parentElement.closest('article, div[role="link"]') !== article;
  const extras = {};
  const name = [...article.querySelectorAll('[data-testid="User-Name"]')].find(quoted);
  if (name) {
    const card = name.parentElement.closest('article, div[role="link"]');
    const parts = [...name.querySelectorAll('span')].map(span => textOf(span).replace(/\s+/g, ' ').trim());
    const handle = parts.find(part => /^@\w+$/.test(part));
    const author = parts.find(part => part && part !== '·' && !part.startsWith('@'));
    const text = card.querySelector('[data-testid="tweetText"]');
    extras.quote = { author: [author, handle].filter(Boolean).join(' '), text: text ? textOf(text).trim() : '' };
  }
  const images = [...article.querySelectorAll('[data-testid="tweetPhoto"] img, a[href*="/photo/"] img')]
    .filter(image => !quoted(image)).map(image => image.alt.replace(/\s+/g, ' ').trim()).filter(alt => alt && alt !== 'Image');
  if (images.length) extras.images = [...new Set(images)];
  // A link card shows the site, and often the page's title and description,
  // each in its own span; a large card's link label holds the site and title.
  const card = [...article.querySelectorAll('[data-testid="card.wrapper"]')].find(element => !quoted(element));
  if (card) {
    const shown = [...card.querySelectorAll('span')].filter(span => !span.querySelector('span')).map(span => textOf(span).replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
    const label = (card.querySelector('a[aria-label]')?.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim();
    if (shown || label) extras.link = label.length > shown.length ? label : shown;
  }
  return extras;
}

// On a tweet's own page, the posts its author wrote just before and after it:
// the thread, unrolled. Just the tweet when it isn't part of one.
function readThread(tweet) {
  const [, handle] = location.pathname.match(/^\/(\w+)\/status\/\d+/) ?? [];
  if (!handle || handle.toLowerCase() !== tweet.handle.toLowerCase()) return [];
  const tweets = [...document.querySelectorAll('article[data-testid="tweet"]')].map(readTweet).filter(Boolean);
  const at = tweets.findIndex(item => item.url === tweet.url);
  const same = item => item?.handle.toLowerCase() === tweet.handle.toLowerCase();
  if (at < 0) return [];
  let start = at, end = at;
  while (same(tweets[start - 1])) start--;
  while (same(tweets[end + 1])) end++;
  const thread = tweets.slice(start, end + 1).map(item => item.text).filter(Boolean);
  return thread.length > 1 ? thread : [];
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

// A panel at the corner of the page for a long task: what's happening, and
// a Stop button, which becomes Close (or Open in Marked) when it's done.
function progressPanel(api) {
  for (const old of document.querySelectorAll('marked-progress')) old.remove();
  const host = document.createElement('marked-progress');
  const box = host.attachShadow({ mode: 'closed' }).appendChild(document.createElement('div'));
  box.setAttribute('role', 'status');
  box.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:16px;bottom:24px;display:flex;align-items:center;gap:14px;max-width:440px;box-sizing:border-box;padding:10px 14px;border:1px solid #0f1419;border-radius:6px;background:#fff;color:#0f1419;font:13px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.15);direction:ltr';
  const label = document.createElement('span');
  const action = document.createElement('button');
  action.type = 'button';
  action.style.cssText = 'all:initial;flex-shrink:0;cursor:pointer;font:600 13px/1.4 system-ui,sans-serif;color:#0f1419;text-decoration:underline;text-underline-offset:3px';
  box.append(label, action);
  document.documentElement.append(host);
  const panel = {
    stopped: false,
    say(text) { label.textContent = text; },
    finish(text, open) {
      label.textContent = text;
      action.textContent = open ? 'Open in Marked' : 'Close';
      action.onclick = () => { host.remove(); if (open) api.runtime.sendMessage({ type: 'marked:open-x-bookmarks' }); };
    }
  };
  action.textContent = 'Stop';
  action.onclick = () => { panel.stopped = true; };
  return panel;
}

// Whether the tab shows your bookmarks: /i/bookmarks, which X now sends on to
// the Bookmarks tab of its History page, /i/history. That page's other tab,
// Likes (/i/history/likes), isn't bookmarks.
function onBookmarks() { return /^\/i\/(bookmarks(\/|$)|history\/?$)/.test(location.pathname); }
// What X's bookmarks page shows before its first posts: 'posts', 'empty' (no
// bookmarks), 'signed-out' (X asks you to sign in), or null while X is still
// loading, or showing something else. X's markup changes, so these are hints;
// an import gives up on X only after a long wait. X's sign-in pages pass on
// where to go next in redirect_after_login; its newest, /i/jf/onboarding, has
// no login buttons to spot.
function bookmarksPage() {
  if (/^\/(login|signup|i\/flow\/(login|signup|single_sign_on)|i\/jf\/onboarding)\b/.test(location.pathname) || new URLSearchParams(location.search).has('redirect_after_login') || document.querySelector('[data-testid="loginButton"], [data-testid="signupButton"]')) return 'signed-out';
  if (!onBookmarks()) return null;
  if ([...document.querySelectorAll('article[data-testid="tweet"]')].some(readTweet)) return 'posts';
  if (document.querySelector('[data-testid="emptyState"]')) return 'empty';
  return null;
}
// X loads more of the page only while its tab is in front, and shows a spinner
// while it does.
function hiddenPage() { return document.visibilityState === 'hidden'; }
function xLoading() { return !!document.querySelector('[data-testid="primaryColumn"] [role="progressbar"]'); }
// Scrolled as far as the page goes. X draws more posts as you near the bottom.
function atBottom() { return scrollY + innerHeight >= (document.scrollingElement || document.documentElement).scrollHeight - 4; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// On X's bookmarks page, collects every bookmarked post for Marked: waits for X
// to show them, scrolls down the list, hands new posts to background.js as they
// appear, and stops at the end, or once it meets posts an earlier import already
// saved, unless that one stopped before the end (catchUp). Tells background.js
// how it ended, so the next import knows whether to catch up.
async function collectBookmarks(api, pace, catchUp) {
  const panel = progressPanel(api);
  const end = complete => api.runtime.sendMessage({ type: 'marked:x-import-end', complete }).catch(() => {});
  panel.say('Marked is waiting for X to show your bookmarks…');
  // X draws the bookmarks a while after its page loads. Signed out, it waits
  // for you to sign in here; otherwise for about 45 seconds of the tab in front.
  let page, waited = 0;
  while (!panel.stopped && !['posts', 'empty'].includes(page = bookmarksPage())) {
    if (page === 'signed-out') panel.say('Sign in to X in this tab. Marked carries on once your bookmarks show.');
    else if (hiddenPage()) panel.say('Waiting for X. Keep this tab in front, where X loads your bookmarks.');
    else if (++waited >= 50) break;
    await sleep(pace);
  }
  if (panel.stopped) { panel.finish('Stopped.'); end(false); return; }
  if (page === 'empty') { panel.finish('There are no bookmarks on X to import.'); end(true); return; }
  if (page !== 'posts') {
    // As X itself suggests when it can't load them: reload, twice at most.
    if (await api.runtime.sendMessage({ type: 'marked:x-reload' }).catch(() => false)) { panel.say('X hasn’t shown your bookmarks yet. Reloading to try again…'); return; }
    panel.finish(onBookmarks() ? 'X didn’t show your bookmarks. If it says something went wrong, wait a few minutes, then import again from Marked.'
      : 'X didn’t open your bookmarks. Open them on X to check they show, then import again from Marked.');
    end(false);
    return;
  }
  panel.say('Marked is reading your bookmarks…');
  const seen = new Set();
  // tagged: posts Jev gave tags, in an import the user chose to tag;
  // tagError: why it couldn't tag some, the first time it says.
  let order = 0, added = 0, known = 0, tagged = 0, streak = 0, idle = 0, tagError = '', complete = false, left = false;
  const progress = () => `Saving your X bookmarks to Marked: ${added} new${tagged ? `, ${tagged} tagged` : ''}${known ? `, ${known} already there` : ''}…`;
  while (!panel.stopped) {
    // Only what X shows as your bookmarks: if the tab goes to Likes, a tab
    // away, or anywhere else, the import stops, and the next one catches up.
    if (!onBookmarks()) { left = true; break; }
    const fresh = [...document.querySelectorAll('article[data-testid="tweet"]')].map(article => [readTweet(article), article])
      .filter(([tweet]) => tweet && !seen.has(tweet.url)).map(([tweet, article]) => ({ ...tweet, ...readExtras(article) }));
    for (const tweet of fresh) seen.add(tweet.url);
    if (fresh.length) {
      idle = 0;
      let reply;
      try { reply = await api.runtime.sendMessage({ type: 'marked:x-bookmarks', tweets: fresh.map(tweet => ({ ...tweet, order: order++ })) }); } catch {}
      if (!reply || reply.error) { panel.finish(reply?.error || 'Marked stopped answering. Reload Marked and try again.'); end(false); return; }
      added += reply.added;
      known += reply.known;
      tagged += reply.tagged || 0;
      tagError ||= typeof reply.tagError === 'string' ? reply.tagError : '';
      streak = reply.added ? 0 : streak + reply.known;
      panel.say(progress());
      if (streak >= 40 && !catchUp) { complete = true; break; }
    } else if (hiddenPage()) {
      // Not the end: X is waiting for the tab to come back.
      panel.say(`${progress()} Keep this tab in front, where X loads your bookmarks.`);
    } else {
      // Nothing new. A spinner means X is still fetching more, so wait longer;
      // at the bottom of the page without one, X has nothing left to draw, and
      // a second look is enough. Ending too soon would leave a gap.
      idle += xLoading() ? 0.25 : atBottom() ? 4 : 1;
      if (idle >= 8) { complete = true; break; }
    }
    scrollBy(0, Math.round(innerHeight * 0.8));
    await sleep(fresh.length ? pace : pace * 1.6);
  }
  end(complete && !panel.stopped);
  panel.finish(`${panel.stopped ? 'Stopped. ' : left ? 'Stopped when this tab left your bookmarks. ' : ''}Saved ${added} new ${added === 1 ? 'post' : 'posts'} from your X bookmarks to Marked${tagged ? `, ${tagged} tagged` : ''}${known ? `; ${known} ${known === 1 ? 'was' : 'were'} already there` : ''}.${tagError ? ` Couldn’t tag ${tagged ? 'the rest' : added === 1 ? 'it' : 'them'}: ${tagError}` : ''}`, added + known > 0);
}

if (!globalThis.markedTweetCapture) {
  globalThis.markedTweetCapture = true;
  let tweet = null;
  // Capture phase, so this runs before the page's own handlers.
  window.addEventListener('contextmenu', event => { tweet = readTweet(event.target); }, true);
  // Chrome versions without the `browser` namespace provide only `chrome`.
  const api = globalThis.browser ?? globalThis.chrome;
  let collecting = false;
  api.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type === 'marked:tweet-under-pointer') {
      if (!tweet) showNotice('No tweet under the cursor. Right-click a tweet to save it.');
      reply(tweet && { ...tweet, thread: readThread(tweet) });
      // Use each right-click once, so a menu opened without one can't reuse it.
      tweet = null;
    } else if (message?.type === 'marked:notice') {
      showNotice(String(message.text));
      reply(true);
    } else if (message?.type === 'marked:collect-bookmarks') {
      // Marked opened this tab to import the bookmarks; one collection at a time.
      if (!collecting) {
        collecting = true;
        collectBookmarks(api, Number(message.pace) || 900, message.catchUp === true).finally(() => { collecting = false; });
      }
      reply(true);
    }
  });
}
