import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../tweet-capture.js', import.meta.url), 'utf8');

// Runs the content script as browsers do: a classic script in the page's window.
function load(body, url = 'https://x.com/home') {
  const { window } = new JSDOM(`<!DOCTYPE html><body>${body}</body>`, { url, runScripts: 'outside-only' });
  const page = { window, $: selector => window.document.querySelector(selector), timers: [], shadows: [] };
  window.setTimeout = (callback, delay) => page.timers.push({ callback, delay });
  // Record closed shadow roots so the test can read the notice.
  const attachShadow = window.Element.prototype.attachShadow;
  window.Element.prototype.attachShadow = function (init) { const root = attachShadow.call(this, init); page.shadows.push({ root, init }); return root; };
  window.chrome = { runtime: { onMessage: { addListener: listener => { page.listener = listener; } } } };
  window.eval(source);
  // Objects from the page's realm are copied so deepEqual compares plain objects.
  const copy = value => value && typeof value === 'object' ? { ...value } : value;
  page.read = target => copy(window.readTweet(typeof target === 'string' ? page.$(target) : target));
  page.ask = message => { let response; page.listener(message, {}, value => { response = value; }); return copy(response); };
  page.rightClick = selector => page.$(selector).dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  page.notices = () => page.shadows.filter(({ root }) => root.host.isConnected).map(({ root }) => root.querySelector('[role="status"]').textContent);
  return page;
}

// Signed-in X, trimmed to the parts Marked reads. Emoji are images there.
const signedIn = `<header><p id="outside">Home</p></header>
<article data-testid="tweet" role="article" tabindex="0">
  <div data-testid="Tweet-User-Avatar"><a href="/jack" role="link"><img alt="" src="avatar.jpg"></a></div>
  <div data-testid="User-Name">
    <a href="/jack" role="link"><div dir="ltr"><span>jack </span><img id="badge" alt="🐦" src="1f426.svg"></div></a>
    <a href="/jack" role="link" tabindex="-1"><div dir="ltr"><span>@jack</span></div></a>
    <div dir="ltr" aria-hidden="true"><span>·</span></div>
    <a href="/jack/status/20" role="link"><time datetime="2006-03-21T20:50:14.000Z">Mar 21, 2006</time></a>
  </div>
  <div data-testid="tweetText" dir="auto"><span id="text">just setting up my twttr </span><img alt="🐣" src="1f423.svg"><span>
see </span><a href="https://t.co/abc" role="link"><span aria-hidden="true">https://</span>example.com</a></div>
  <div role="group"><a href="/jack/status/20/analytics" role="link"><span id="views">5M</span></a></div>
</article>`;
const jack = { url: 'https://x.com/jack/status/20', author: 'jack 🐦', handle: 'jack', text: 'just setting up my twttr 🐣\nsee https://example.com' };

test('reads the canonical URL, author, handle, and text of the tweet under the pointer', () => {
  const page = load(signedIn);
  for (const target of ['#text', '#views', '#badge', 'article']) assert.deepEqual(page.read(target), jack, target);
});

test('returns null outside a tweet, for other articles, and for tweets without a permalink', () => {
  const page = load(`${signedIn}
    <article data-testid="notification"><a href="/jack/status/20"><span id="notification">jack liked your post</span></a></article>
    <article data-testid="tweet"><div data-testid="tweetText"><span id="ad">Promoted, no permalink</span></div></article>`);
  for (const target of ['#outside', '#notification', '#ad', 'body']) assert.equal(page.read(target), null, target);
  assert.equal(page.read(null), null);
  assert.equal(page.read(page.window.document), null);
});

test('a quote tweet is saved as the quoting tweet, never with the quoted text or link', () => {
  const card = time => `<div role="link" tabindex="0">
    <div data-testid="User-Name"><a href="/bob" role="link"><span>Bob</span></a>${time}</div>
    <div data-testid="tweetText"><span id="quoted">Quoted words</span></div>
    <a href="/bob/status/222/photo/1" role="link"><img alt="Image" src="photo.jpg"></a>
  </div>`;
  const page = load(`<article data-testid="tweet" role="article">
    <div data-testid="User-Name"><a href="/alice" role="link"><span>Alice</span></a><a href="/alice/status/111" role="link"><time>2h</time></a></div>
    <div data-testid="tweetText"><span id="comment">Look at this</span></div>
    ${card('<time>5h</time>')}
  </article>`);
  const alice = { url: 'https://x.com/alice/status/111', author: 'Alice', handle: 'alice', text: 'Look at this' };
  assert.deepEqual(page.read('#comment'), alice);
  assert.deepEqual(page.read('#quoted'), alice, 'the card is part of the quoting tweet');
  // A tweet's own page puts its permalink last, after the card. Also cover a
  // quoted tweet with a linked time and a quoting tweet with no text.
  const focal = load(`<article data-testid="tweet" role="article" tabindex="-1">
    <div data-testid="User-Name"><a href="/alice" role="link"><span>Alice</span></a></div>
    ${card('<a href="/bob/status/222" role="link"><time>5h</time></a>')}
    <a href="/alice/status/111" role="link"><time>3:14 PM · Mar 21, 2026</time></a>
  </article>`);
  assert.deepEqual(focal.read('#quoted'), { ...alice, text: '' });
  // Outside a recognized card, another tweet's link may come first; the permalink wraps <time>.
  const unmarked = load(`<article data-testid="tweet"><div data-testid="User-Name"><a href="/alice" role="link"><span>Alice</span></a></div>
    <div><a href="/bob/status/222/photo/1"><img alt="" src="photo.jpg"></a></div>
    <a href="/alice/status/111" role="link"><time>3:14 PM · Mar 21, 2026</time></a></article>`);
  assert.equal(unmarked.read('img').url, alice.url);
});

test('canonicalizes permalinks to https://x.com/<handle>/status/<id>', () => {
  const read = href => load(`<article data-testid="tweet"><div data-testid="User-Name"><a href="/jack" role="link"><span>jack</span></a>
    <a href="${href}" role="link"><time>1h</time></a></div><div data-testid="tweetText"><span id="text">hi</span></div></article>`).read('#text')?.url;
  assert.equal(read('/jack/status/20/photo/1'), 'https://x.com/jack/status/20');
  assert.equal(read('/jack/status/20/analytics?src=hash#top'), 'https://x.com/jack/status/20');
  assert.equal(read('https://twitter.com/jack/status/20?s=20'), 'https://x.com/jack/status/20');
  // Numeric IDs exceed Number precision and must be kept as text.
  assert.equal(read('/jack/status/1770888775830262034'), 'https://x.com/jack/status/1770888775830262034');
  assert.equal(read('/jack/status/latest'), undefined);
  const mixedCase = load(`<article data-testid="tweet"><div data-testid="User-Name"><a href="/jack" role="link"><span>jack</span></a>
    <a href="https://mobile.twitter.com/Jack/status/20" role="link"><time>1h</time></a></div></article>`);
  assert.deepEqual(mixedCase.read('time'), { url: 'https://x.com/Jack/status/20', author: 'jack', handle: 'Jack', text: '' });
});

// X's signed-out client (seen on x.com in September 2026): no data-testid, no
// <time>, and a quoted tweet is an article nested in a link card.
test('reads the signed-out markup, where a quoted tweet is its own article', () => {
  const page = load(`<article class="flex flex-col gap-1">
    <a href="/elonmusk"><div><img alt="@elonmusk" src="a.jpg"></div></a>
    <div><span><a href="/elonmusk"><div>Elon Musk</div></a><div><span aria-label="Verified account" role="button"><svg></svg></span></div></span>
    <span><a href="/elonmusk"><span>@elonmusk</span></a></span></div>
    <span><a href="/elonmusk/status/2103238840072937532">1h</a><script>window.__xClientTextFormatters?.run('1h')</script></span>
    <div dir="auto"><span id="comment">Easy way to see how the 𝕏 algorithm works</span></div>
    <div data-href="/XOpenSource/status/2103234630342357089" data-timeline-entry="" role="link"><article>
      <a href="/XOpenSource"><div><img alt="@XOpenSource" src="b.jpg"></div></a>
      <span><a href="/XOpenSource"><div>X Open Source</div></a></span><span><a href="/XOpenSource"><span>@XOpenSource</span></a></span>
      <span><a href="/XOpenSource/status/2103234630342357089">1h</a></span>
      <div dir="auto"><span id="quoted">By popular request, a new, easier way to see Under The Hood.</span></div>
      <a aria-label="Screenshot" href="/XOpenSource/status/2103234630342357089/photo/1"><img alt="Screenshot" src="c.jpg"></a>
    </article></div>
    <div data-engagement-action="reply"><a aria-label="Reply" href="/elonmusk/status/2103238840072937532"><svg></svg><span id="replies">18K</span></a></div>
  </article>`);
  const elon = { url: 'https://x.com/elonmusk/status/2103238840072937532', author: 'Elon Musk', handle: 'elonmusk', text: 'Easy way to see how the 𝕏 algorithm works' };
  assert.deepEqual(page.read('#comment'), elon);
  assert.deepEqual(page.read('#replies'), elon);
  assert.deepEqual(page.read('#quoted'), { url: 'https://x.com/XOpenSource/status/2103234630342357089', author: 'X Open Source', handle: 'XOpenSource', text: 'By popular request, a new, easier way to see Under The Hood.' });
  // On a tweet's own page, media and the text's links come before the permalink.
  const focal = load(`<article class="flex flex-col gap-1">
    <a href="/jack"><div><img alt="@jack" src="a.jpg"></div></a>
    <span><a href="/jack"><div>jack</div></a></span><span><a href="/jack"><span>@jack</span></a></span>
    <div dir="auto"><span id="focal">see </span><a href="https://x.com/biz/status/21">x.com/biz/status/21</a></div>
    <a aria-label="Image" href="/jack/status/20/photo/1"><img alt="" src="p.jpg"></a>
    <div><span><a href="/jack/status/20">8:50 PM · Mar 21, 2006</a></span></div>
  </article>`);
  assert.deepEqual(focal.read('#focal'), { url: 'https://x.com/jack/status/20', author: 'jack', handle: 'jack', text: 'see x.com/biz/status/21' });
});

test('replies with the tweet from the last right-click, once, and otherwise shows a notice', () => {
  const page = load(signedIn);
  const ask = () => page.ask({ type: 'marked:tweet-under-pointer' });
  page.rightClick('#text');
  const reply = ask();
  assert.deepEqual({ ...reply, thread: [...reply.thread] }, { ...jack, thread: [] }, 'on a timeline, a tweet is just itself');
  assert.deepEqual(page.notices(), []);
  assert.equal(ask(), null, 'each right-click is used once');
  page.rightClick('#text');
  page.rightClick('#outside');
  assert.equal(ask(), null);
  assert.deepEqual(page.notices(), ['No tweet under the cursor. Right-click a tweet to save it.']);
  assert.ok(page.shadows.every(({ init }) => init.mode === 'closed'));
  assert.deepEqual(page.timers.map(({ delay }) => delay), [3000, 3000]);
});

test('shows other notices on request, one at a time, for three seconds', () => {
  const page = load(signedIn);
  page.ask({ type: 'marked:tweet-under-pointer' });
  assert.equal(page.ask({ type: 'marked:notice', text: 'Saved elsewhere.' }), true);
  assert.deepEqual(page.notices(), ['Saved elsewhere.']);
  assert.equal(page.window.document.querySelectorAll('marked-notice').length, 1);
  page.timers.at(-1).callback();
  assert.deepEqual(page.notices(), []);
  assert.equal(page.ask({ type: 'other' }), undefined);
  assert.equal(page.window.document.querySelectorAll('marked-notice').length, 0);
});

test('background.js injects this same notice where the content script is missing', async () => {
  const background = await readFile(new URL('../background.js', import.meta.url), 'utf8');
  const notice = text => text.match(/^function showNotice\(text\) \{$[\s\S]*?^\}$/m)?.[0];
  assert.ok(notice(source));
  assert.equal(notice(background), notice(source));
});

test('on its own page, a tweet brings the thread its author wrote around it', () => {
  const tweet = (handle, id, words) => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/${handle}" role="link"><span>${handle}</span></a><a href="/${handle}/status/${id}"><time datetime="2026-01-01T00:00:00Z">Jan 1</time></a></div><div data-testid="tweetText" dir="auto"><span id="t${id}">${words}</span></div></article>`;
  const thread = [tweet('ada', 1, 'Before the thread.'), tweet('jack', 20, 'One: the start.'), tweet('jack', 21, 'Two: the middle.'), tweet('jack', 22, 'Three: the end.'), tweet('bob', 23, 'A reply from someone else.'), tweet('jack', 24, 'Jack, later, to Bob.')].join('');
  const page = load(thread, 'https://x.com/jack/status/20');
  page.rightClick('#t21');
  const saved = page.ask({ type: 'marked:tweet-under-pointer' });
  assert.equal(saved.url, 'https://x.com/jack/status/21');
  assert.deepEqual([...saved.thread], ['One: the start.', 'Two: the middle.', 'Three: the end.'], 'only the author’s posts next to it');
  page.rightClick('#t23');
  assert.deepEqual([...page.ask({ type: 'marked:tweet-under-pointer' }).thread], [], 'a reply by someone else is just itself');
});

test('on X’s bookmarks page, Marked collects every post as it scrolls, and stops at the end or where it left off', async () => {
  const post = id => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/ada" role="link"><span>Ada</span></a><a href="/ada/status/${id}"><time datetime="2026-01-01T00:00:00Z">Jan 1</time></a></div><div data-testid="tweetText" dir="auto"><span>Post ${id}</span></div></article>`;
  const run = async (page, replies) => {
    const sent = [];
    page.window.chrome.runtime.sendMessage = async message => { sent.push(message); return message.type === 'marked:x-bookmarks' ? replies.shift() ?? { added: 0, known: 0 } : true; };
    page.ask({ type: 'marked:collect-bookmarks', pace: 10 });
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setImmediate(resolve));
      const timer = page.timers.find(item => item.delay >= 10);
      if (!timer) continue;
      page.timers.splice(page.timers.indexOf(timer), 1);
      timer.callback();
    }
    return sent;
  };
  const panel = page => page.shadows.find(({ root }) => root.host.localName === 'marked-progress').root;
  const page = load(post(3) + post(2), 'https://x.com/i/bookmarks');
  // X shows more posts, one of them again, as the page scrolls down.
  let scrolls = 0;
  page.window.scrollBy = () => { if (++scrolls === 1) page.window.document.body.insertAdjacentHTML('beforeend', post(2) + post(1)); };
  const sent = await run(page, [{ added: 2, known: 0 }, { added: 0, known: 1 }]);
  const batches = JSON.parse(JSON.stringify(sent.filter(message => message.type === 'marked:x-bookmarks').map(message => message.tweets.map(tweet => [tweet.url, tweet.order]))));
  assert.deepEqual(batches, [[['https://x.com/ada/status/3', 0], ['https://x.com/ada/status/2', 1]], [['https://x.com/ada/status/1', 2]]], 'each post once, in the page’s order');
  assert.equal(panel(page).textContent, 'Saved 2 new posts from your X bookmarks to Marked; 1 was already there.Open in Marked');
  panel(page).querySelector('button').click();
  assert.deepEqual({ ...sent.at(-1) }, { type: 'marked:open-x-bookmarks' });

  // A later import stops where the last one ended.
  const again = load(Array.from({ length: 45 }, (item, index) => post(100 + index)).join(''), 'https://x.com/i/bookmarks');
  again.window.scrollBy = () => {};
  const repeat = await run(again, [{ added: 0, known: 45 }]);
  assert.equal(repeat.filter(message => message.type === 'marked:x-bookmarks').length, 1);
  assert.match(panel(again).textContent, /^Saved 0 new posts from your X bookmarks to Marked; 45 were already there\./);

  const signedOut = load('<p>Log in</p>', 'https://x.com/i/flow/login');
  await run(signedOut, []);
  assert.equal(panel(signedOut).textContent, 'Sign in to X, open your bookmarks, and try again.Close');
});
