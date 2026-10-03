import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source = await readFile(new URL('../src/tweet-capture.js', import.meta.url), 'utf8');

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
  page.extras = selector => JSON.parse(JSON.stringify(window.readExtras(page.$(selector))));
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

// For a tagged import: what a post quotes, shows and links to, read apart from
// the post itself, which stays as it was.
const quoting = `<article data-testid="tweet" role="article">
  <div data-testid="User-Name"><a href="/alice" role="link"><span>Alice</span></a><a href="/alice" role="link" tabindex="-1"><span>@alice</span></a><a href="/alice/status/111" role="link"><time>2h</time></a></div>
  <div data-testid="tweetText"><span>Look at this</span></div>
  <a href="/alice/status/111/photo/1" role="link"><div data-testid="tweetPhoto"><img alt="A chart of  sea levels since 1900" src="p1.jpg"></div></a>
  <a href="/alice/status/111/photo/2" role="link"><div data-testid="tweetPhoto"><img alt="Image" src="p2.jpg"></div></a>
  <div data-testid="card.wrapper"><a href="https://t.co/abc" role="link" aria-label="nature.com Sea levels are rising faster"><img alt="" src="card.jpg"><span>From nature.com</span></a></div>
  <div role="link" tabindex="0">
    <div data-testid="User-Name"><div><span><span>Bob</span></span></div><div><span>@bob</span><span>·</span><time>5h</time></div></div>
    <div data-testid="tweetText"><span>Quoted words </span><img alt="🌊" src="wave.svg"></div>
    <a href="/bob/status/222/photo/1" role="link"><div data-testid="tweetPhoto"><img alt="Bob’s photo of the tide" src="q.jpg"></div></a>
  </div>
</article>`;
const quotingExtras = { quote: { author: 'Bob @bob', text: 'Quoted words 🌊' }, images: ['A chart of sea levels since 1900'], link: 'nature.com Sea levels are rising faster' };

test('reads the post a tweet quotes, its own image descriptions and its link preview, for tagging; the import sends them', async () => {
  const page = load(quoting);
  assert.deepEqual(page.extras('article'), quotingExtras, 'not X’s “Image”, nor the quoted post’s photo');
  assert.deepEqual(page.read('article'), { url: 'https://x.com/alice/status/111', author: 'Alice', handle: 'alice', text: 'Look at this' }, 'the post itself, as before');
  // A summary card shows the site, title and description, each in its own span.
  const summary = load(`<article data-testid="tweet"><div data-testid="User-Name"><a href="/ada" role="link"><span>Ada</span></a><a href="/ada/status/3" role="link"><time>1h</time></a></div>
    <div data-testid="card.wrapper"><a href="https://t.co/x" role="link"><div><span>arxiv.org</span></div><div><span>Attention Is All You Need</span></div><div><span>The dominant sequence models</span></div></a></div></article>`);
  assert.deepEqual(summary.extras('article'), { link: 'arxiv.org Attention Is All You Need The dominant sequence models' });
  assert.deepEqual(load(signedIn).extras('article'), {}, 'a post with none of them');

  const importing = load(quoting, 'https://x.com/i/history');
  importing.window.scrollBy = () => {};
  const sent = await run(importing, [{ added: 1, known: 0 }]);
  const { tweets } = sent.find(message => message.type === 'marked:x-bookmarks');
  assert.deepEqual(tweets, [{ url: 'https://x.com/alice/status/111', author: 'Alice', handle: 'alice', text: 'Look at this', ...quotingExtras, order: 0 }]);
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
  const background = await readFile(new URL('../src/background.js', import.meta.url), 'utf8');
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

// X's bookmarks page, and a run of the import there: each round lets the
// script's promises settle and then fires its next timer.
const post = id => `<article data-testid="tweet"><div data-testid="User-Name"><a href="/ada" role="link"><span>Ada</span></a><a href="/ada/status/${id}"><time datetime="2026-01-01T00:00:00Z">Jan 1</time></a></div><div data-testid="tweetText" dir="auto"><span>Post ${id}</span></div></article>`;
async function run(page, replies, { rounds = 30, each = () => {}, reload = true, catchUp } = {}) {
  const sent = [];
  page.window.chrome.runtime.sendMessage = async message => {
    sent.push(JSON.parse(JSON.stringify(message)));
    if (message.type === 'marked:x-bookmarks') return replies.shift() ?? { added: 0, known: 0 };
    return message.type === 'marked:x-reload' ? reload : true;
  };
  page.ask({ type: 'marked:collect-bookmarks', pace: 10, ...(catchUp !== undefined && { catchUp }) });
  for (let i = 0; i < rounds; i++) {
    await new Promise(resolve => setImmediate(resolve));
    each(i);
    const timer = page.timers.find(item => item.delay >= 10);
    if (!timer) continue;
    page.timers.splice(page.timers.indexOf(timer), 1);
    timer.callback();
  }
  return sent;
}
const panel = page => page.shadows.find(({ root }) => root.host.localName === 'marked-progress').root;
const ends = sent => sent.filter(message => message.type === 'marked:x-import-end').map(message => message.complete);

test('on X’s bookmarks page, Marked collects every post as it scrolls, and stops at the end or where it left off', async () => {
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

  // An import the user chose to tag says how many posts got tags, and why it stopped tagging.
  const tagging = load(post(7) + post(6), 'https://x.com/i/bookmarks');
  let turns = 0;
  tagging.window.scrollBy = () => { if (++turns === 1) tagging.window.document.body.insertAdjacentHTML('beforeend', post(5)); };
  await run(tagging, [{ added: 2, tagged: 2, known: 0 }, { added: 1, tagged: 0, known: 0, tagError: 'TypeSafe is busy. Try again in a minute.' }]);
  assert.equal(panel(tagging).textContent, 'Saved 3 new posts from your X bookmarks to Marked, 2 tagged. Couldn’t tag the rest: TypeSafe is busy. Try again in a minute.Open in Marked');
  const untagged = load(post(8), 'https://x.com/i/bookmarks');
  untagged.window.scrollBy = () => {};
  await run(untagged, [{ added: 1, tagged: 0, known: 0, tagError: 'Add your TypeSafe API key in Marked’s Settings to tag posts.' }]);
  assert.equal(panel(untagged).textContent, 'Saved 1 new post from your X bookmarks to Marked. Couldn’t tag it: Add your TypeSafe API key in Marked’s Settings to tag posts.Open in Marked');
});

// X draws the bookmarks a while after its page loads, only while its tab is in
// front, and sometimes not at all until it's reloaded. None of that is "signed out".
test('Marked waits for X to show the bookmarks: while it loads, while you sign in, and while the tab is behind; then reloads, twice at most', async () => {
  // Slower than the eight empty rounds that used to end the import.
  const slow = load('', 'https://x.com/i/bookmarks');
  slow.window.scrollBy = () => {};
  const texts = [];
  let sent = await run(slow, [{ added: 2, known: 0 }], { rounds: 60, each: round => {
    texts.push(panel(slow).textContent);
    if (round === 20) slow.window.document.body.insertAdjacentHTML('beforeend', post(2) + post(1));
  } });
  assert.equal(texts[0], 'Marked is waiting for X to show your bookmarks…Stop');
  assert.equal(panel(slow).textContent, 'Saved 2 new posts from your X bookmarks to Marked.Open in Marked');
  assert.deepEqual(ends(sent), [true], 'it reached the end');

  // Signed out: as long as it takes to sign in, here.
  const signIn = load('<p>Log in</p>', 'https://x.com/i/flow/login?redirect_after_login=%2Fi%2Fbookmarks');
  signIn.window.scrollBy = () => {};
  sent = await run(signIn, [{ added: 1, known: 0 }], { rounds: 120, each: round => {
    if (round === 80) {
      assert.equal(panel(signIn).textContent, 'Sign in to X in this tab. Marked carries on once your bookmarks show.Stop');
      signIn.window.history.pushState({}, '', '/i/bookmarks');
      signIn.window.document.body.innerHTML = post(3);
    }
  } });
  assert.equal(panel(signIn).textContent, 'Saved 1 new post from your X bookmarks to Marked.Open in Marked');

  // Behind other tabs, X loads nothing, and that's no reason to stop.
  const behind = load('', 'https://x.com/i/bookmarks');
  behind.window.scrollBy = () => {};
  let state = 'hidden';
  Object.defineProperty(behind.window.document, 'visibilityState', { get: () => state, configurable: true });
  sent = await run(behind, [{ added: 1, known: 0 }], { rounds: 100, each: round => {
    if (round === 70) {
      assert.equal(panel(behind).textContent, 'Waiting for X. Keep this tab in front, where X loads your bookmarks.Stop');
      state = 'visible';
      behind.window.document.body.innerHTML = post(4);
    }
  } });
  assert.equal(panel(behind).textContent, 'Saved 1 new post from your X bookmarks to Marked.Open in Marked');

  // Nothing after about 45 seconds in front: reload, as X suggests; then say so.
  const stuck = load('', 'https://x.com/i/bookmarks');
  sent = await run(stuck, [], { rounds: 70 });
  assert.deepEqual(sent.map(message => message.type), ['marked:x-reload']);
  assert.equal(panel(stuck).textContent, 'X hasn’t shown your bookmarks yet. Reloading to try again…Stop');
  const given = load('', 'https://x.com/i/bookmarks');
  sent = await run(given, [], { rounds: 70, reload: false });
  assert.equal(panel(given).textContent, 'X didn’t show your bookmarks. If it says something went wrong, wait a few minutes, then import again from Marked.Close');
  assert.deepEqual(ends(sent), [false]);
  const elsewhere = load('', 'https://x.com/home');
  await run(elsewhere, [], { rounds: 70, reload: false });
  assert.match(panel(elsewhere).textContent, /^X didn’t open your bookmarks\./);

  // No bookmarks at all.
  const empty = load('<div data-testid="emptyState"><span>Save posts for later</span></div>', 'https://x.com/i/bookmarks');
  sent = await run(empty, []);
  assert.equal(panel(empty).textContent, 'There are no bookmarks on X to import.Close');
  assert.deepEqual(ends(sent), [true]);
});

// X moved the bookmarks to the Bookmarks tab of its History page, /i/history,
// and sends /i/bookmarks there. The page's other tab, Likes, isn't bookmarks.
test('X’s History page: Marked imports its Bookmarks tab, never Likes, and stops if the tab leaves the bookmarks', async () => {
  const history = load(post(3) + post(2), 'https://x.com/i/history');
  history.window.scrollBy = () => {};
  let sent = await run(history, [{ added: 2, known: 0 }]);
  assert.equal(panel(history).textContent, 'Saved 2 new posts from your X bookmarks to Marked.Open in Marked');

  // X sends /i/bookmarks on to /i/history while the import runs.
  const moving = load(post(5), 'https://x.com/i/bookmarks');
  let turns = 0;
  moving.window.scrollBy = () => { if (++turns === 1) { moving.window.history.replaceState({}, '', '/i/history'); moving.window.document.body.insertAdjacentHTML('beforeend', post(4)); } };
  await run(moving, [{ added: 1, known: 0 }, { added: 1, known: 0 }]);
  assert.equal(panel(moving).textContent, 'Saved 2 new posts from your X bookmarks to Marked.Open in Marked');

  // Likes are never read as bookmarks.
  const likes = load(post(9), 'https://x.com/i/history/likes');
  sent = await run(likes, [], { rounds: 70, reload: false });
  assert.deepEqual(sent.filter(message => message.type === 'marked:x-bookmarks'), []);
  assert.match(panel(likes).textContent, /^X didn’t open your bookmarks\./);

  // Switching to Likes partway stops the import with what it saved; the next one catches up.
  const switching = load(post(8) + post(7), 'https://x.com/i/history');
  let clicked = false;
  switching.window.scrollBy = () => { if (!clicked) { clicked = true; switching.window.history.pushState({}, '', '/i/history/likes'); switching.window.document.body.innerHTML = post(99); } };
  sent = await run(switching, [{ added: 2, known: 0 }]);
  assert.deepEqual(sent.filter(message => message.type === 'marked:x-bookmarks').map(message => message.tweets.map(tweet => tweet.url)), [['https://x.com/ada/status/8', 'https://x.com/ada/status/7']], 'nothing from Likes');
  assert.equal(panel(switching).textContent, 'Stopped when this tab left your bookmarks. Saved 2 new posts from your X bookmarks to Marked.Open in Marked');
  assert.deepEqual(ends(sent), [false]);

  // Signed out, X now asks you to sign in at /i/jf/onboarding, with no login buttons to spot.
  const signIn = load('<main><h1>Sign in to X</h1></main>', 'https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fi%2Fbookmarks&mode=login');
  signIn.window.scrollBy = () => {};
  await run(signIn, [{ added: 1, known: 0 }], { rounds: 120, each: round => {
    if (round === 80) {
      assert.equal(panel(signIn).textContent, 'Sign in to X in this tab. Marked carries on once your bookmarks show.Stop');
      signIn.window.history.pushState({}, '', '/i/history');
      signIn.window.document.body.innerHTML = post(6);
    }
  } });
  assert.equal(panel(signIn).textContent, 'Saved 1 new post from your X bookmarks to Marked.Open in Marked');
});

test('X’s spinner means more is coming; an import that stopped short is caught up by the next, past the posts it saved', async () => {
  // A spinner while X fetches the next page: longer than eight empty rounds.
  const spinning = load(`<div data-testid="primaryColumn"><div role="progressbar"></div><section>${post(9)}</section></div>`, 'https://x.com/i/bookmarks');
  spinning.window.scrollBy = () => {};
  let sent = await run(spinning, [{ added: 1, known: 0 }, { added: 1, known: 0 }], { rounds: 60, each: round => {
    if (round === 20) spinning.$('section').insertAdjacentHTML('beforeend', post(8));
  } });
  assert.equal(panel(spinning).textContent, 'Saved 2 new posts from your X bookmarks to Marked.Open in Marked');

  // Stopped: the next import must not stop at what this one saved.
  const stopped = load(post(7), 'https://x.com/i/bookmarks');
  stopped.window.scrollBy = () => {};
  // More of the page below, so the import is still going when Stop is pressed.
  Object.defineProperty(stopped.window.document.documentElement, 'scrollHeight', { value: 100000, configurable: true });
  sent = await run(stopped, [{ added: 1, known: 0 }], { rounds: 6, each: round => { if (round === 3) panel(stopped).querySelector('button').click(); } });
  assert.match(panel(stopped).textContent, /^Stopped\. Saved 1 new post/);
  assert.deepEqual(ends(sent), [false]);

  // Catching up: 45 saved posts in a row, then more below them.
  const later = load(Array.from({ length: 45 }, (item, index) => post(200 - index)).join(''), 'https://x.com/i/bookmarks');
  let more = true;
  later.window.scrollBy = () => { if (more) { more = false; later.window.document.body.insertAdjacentHTML('beforeend', post(100)); } };
  sent = await run(later, [{ added: 0, known: 45 }, { added: 1, known: 0 }], { rounds: 40, catchUp: true });
  assert.equal(sent.filter(message => message.type === 'marked:x-bookmarks').length, 2, 'past the saved posts');
  assert.equal(panel(later).textContent, 'Saved 1 new post from your X bookmarks to Marked; 45 were already there.Open in Marked');
  assert.deepEqual(ends(sent), [true]);
});

// X draws more posts as the page nears its bottom. Scrolled to the bottom with
// no spinner, X has nothing left, so the import ends after a second look;
// further up, X may still be drawing posts, so it waits as long as before.
test('the import ends soon after its last post at the bottom of the page, and waits longer further up', async () => {
  const bottom = load(post(5), 'https://x.com/i/history');
  bottom.window.scrollBy = () => {};
  let sent = await run(bottom, [{ added: 1, known: 0 }], { rounds: 3 });
  assert.equal(panel(bottom).textContent, 'Saved 1 new post from your X bookmarks to Marked.Open in Marked', 'two looks after the last post');
  assert.deepEqual(ends(sent), [true]);

  const above = load(post(6), 'https://x.com/i/history');
  above.window.scrollBy = () => {};
  Object.defineProperty(above.window.document.documentElement, 'scrollHeight', { value: 100000, configurable: true });
  sent = await run(above, [{ added: 1, known: 0 }], { rounds: 6 });
  assert.equal(panel(above).textContent, 'Saving your X bookmarks to Marked: 1 new…Stop', 'more page below');
  assert.deepEqual(ends(sent), []);
});
