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

// On X's bookmarks page, collects every bookmarked post for Marked: scrolls
// down the list, hands new posts to background.js as they appear, and stops at
// the end, or once it meets posts an earlier import already saved.
async function collectBookmarks(api, pace) {
  const panel = progressPanel(api);
  if (!location.pathname.startsWith('/i/bookmarks')) { panel.finish('Sign in to X, open your bookmarks, and try again.'); return; }
  panel.say('Marked is reading your bookmarks…');
  const seen = new Set();
  let order = 0, added = 0, known = 0, streak = 0, idle = 0;
  while (!panel.stopped) {
    const fresh = [...document.querySelectorAll('article[data-testid="tweet"]')].map(readTweet).filter(tweet => tweet && !seen.has(tweet.url));
    for (const tweet of fresh) seen.add(tweet.url);
    if (fresh.length) {
      idle = 0;
      let reply;
      try { reply = await api.runtime.sendMessage({ type: 'marked:x-bookmarks', tweets: fresh.map(tweet => ({ ...tweet, order: order++ })) }); } catch {}
      if (!reply || reply.error) { panel.finish(reply?.error || 'Marked stopped answering. Reload Marked and try again.'); return; }
      added += reply.added;
      known += reply.known;
      streak = reply.added ? 0 : streak + reply.known;
      panel.say(`Saving your X bookmarks to Marked: ${added} new${known ? `, ${known} already there` : ''}…`);
      if (streak >= 40) break;
    } else if (++idle >= 8) break;
    scrollBy(0, Math.round(innerHeight * 0.8));
    await new Promise(resolve => setTimeout(resolve, fresh.length ? pace : pace * 1.6));
  }
  panel.finish(!seen.size ? 'No bookmarks here. Sign in to X, open your bookmarks, and try again.'
    : `${panel.stopped ? 'Stopped. ' : ''}Saved ${added} new ${added === 1 ? 'post' : 'posts'} from your X bookmarks to Marked${known ? `; ${known} ${known === 1 ? 'was' : 'were'} already there` : ''}.`, added + known > 0);
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
        collectBookmarks(api, Number(message.pace) || 900).finally(() => { collecting = false; });
      }
      reply(true);
    }
  });
}
