import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { readPageText, cleanPageText, captureTabText, fetchPageText, searchTerms, passageAround, readingMinutes, PAGE_TEXT_LIMIT } from '../page-text.js';

globalThis.Readability = Readability;
globalThis.isProbablyReaderable = isProbablyReaderable;
globalThis.DOMParser = new JSDOM().window.DOMParser;
const sentence = 'Attention is the currency of a working life, and most of it is spent before we notice.';
const article = `<!doctype html><html lang="en"><head><title>On attention</title><meta name="author" content="Ada Writer"></head><body>
  <header><nav><a href="/">Home</a> <a href="/about">About us</a></nav></header>
  <main><article>
    <h1>On attention</h1>
    <p>${sentence} ${sentence}</p>
    <h2>Why it matters</h2>
    <p>Deciding what deserves your attention is a skill. It can be practiced, like any other, with patience and some honesty about where the hours go.</p>
    <ul><li>Protect the mornings</li><li>Batch the messages</li></ul>
    <p>A saved link is a promise to your <em>future</em> self, and a <a href="/notes">note</a> says why you made it.</p>
    <pre>const   focus = true;
if (focus) work();</pre>
  </article></main>
  <footer>Copyright 2026 · Privacy</footer>
  <script>var tracker = 1;</script>
</body></html>`;
const documentOf = html => new JSDOM(html, { url: 'https://example.com/essay' }).window.document;

test('reads the article as paragraphs, leaving out the page around it', () => {
  const page = readPageText(documentOf(article));
  const paragraphs = page.text.split('\n\n');
  assert.ok(paragraphs.includes(`${sentence} ${sentence}`));
  assert.ok(paragraphs.includes('Why it matters'), 'headings are paragraphs of their own');
  assert.ok(paragraphs.includes('• Protect the mornings') && paragraphs.includes('• Batch the messages'), 'list items get bullets');
  assert.ok(paragraphs.includes('A saved link is a promise to your future self, and a note says why you made it.'), 'inline markup is just text');
  assert.ok(paragraphs.includes('const focus = true;\nif (focus) work();'), 'code keeps its lines');
  for (const chrome of ['Home', 'About us', 'Copyright', 'tracker']) assert.ok(!page.text.includes(chrome), `no ${chrome}`);
  assert.equal(page.words, page.text.match(/[\p{L}\p{N}]+/gu).length);
  assert.equal(page.url, '', 'a downloaded page has no address of its own');
  assert.equal(page.lang, 'en');
  assert.equal(page.truncated, false);
});

test('a page that isn’t an article keeps all its text, without navigation; a long one is cut', () => {
  const tool = readPageText(documentOf('<body><nav>Menu Pricing</nav><div>Convert units</div><div><span>From</span> <b>meters</b></div><footer>Legal</footer></body>'));
  assert.equal(tool.text, 'Convert units\n\nFrom meters');
  const long = readPageText(documentOf(`<body><article>${`<p>${'word '.repeat(2000)}</p>`.repeat(30)}</article></body>`));
  assert.ok(long.truncated);
  assert.ok(long.text.length <= PAGE_TEXT_LIMIT && long.text.length > PAGE_TEXT_LIMIT * 0.9);
  assert.ok(long.text.endsWith('word'), 'cut between words');
});

test('only articles, when asked: an inbox or an account page is skipped', () => {
  const inbox = documentOf('<body><nav>Inbox Sent Drafts</nav><table><tr><td>Bank</td><td>Your statement is ready</td></tr><tr><td>Ada</td><td>Lunch?</td></tr></table></body>');
  assert.equal(readPageText(inbox, { articlesOnly: true }).skipped, true);
  assert.ok(readPageText(inbox).text.includes('Your statement is ready'), 'kept when saved on purpose');
  assert.ok(readPageText(documentOf(article), { articlesOnly: true }).text.includes(sentence));
});

test('page text is checked before it’s kept: text or the reason there is none', () => {
  assert.equal(cleanPageText(null), null);
  assert.equal(cleanPageText({ text: '   ' }), null, 'nothing to keep');
  const kept = cleanPageText({ text: '  One   line\r\n\r\n\r\n\r\nTwo\tlines ', words: 99999, via: 'elsewhere', title: 'T'.repeat(500), capturedAt: 5, extra: 'dropped' });
  assert.deepEqual(kept, { capturedAt: 5, text: 'One line\n\nTwo lines', words: 4, title: 'T'.repeat(300) }, 'an impossible word count is counted again');
  assert.equal(cleanPageText({ text: 'x'.repeat(PAGE_TEXT_LIMIT + 10) }).text.length, PAGE_TEXT_LIMIT);
  const failed = cleanPageText({ error: ' The site answered 404. ', via: 'download' });
  assert.deepEqual(Object.keys(failed).sort(), ['capturedAt', 'error', 'via']);
  assert.equal(failed.error, 'The site answered 404.');
});

test('reads a tab’s text with Readability injected first, only while the tab shows the page', async () => {
  const calls = [];
  let shown = 'https://example.com/essay#part-2';
  const api = { scripting: { executeScript: async details => { calls.push(details.files?.join() ?? [details.func.name, JSON.stringify(details.args)]); return [{ result: details.func ? { url: shown, text: 'The essay.', words: 2 } : undefined }]; } } };
  const text = await captureTabText(api, 3, 'https://example.com/essay');
  assert.deepEqual(calls, ['vendor/readability.js,vendor/readability-readerable.js', ['readPageText', '[null,{"articlesOnly":false}]']]);
  assert.deepEqual([text.text, text.words], ['The essay.', 2], 'the same page with another #fragment counts');
  shown = 'https://example.com/other';
  assert.equal(await captureTabText(api, 3, 'https://example.com/essay'), null);
  api.scripting.executeScript = () => new Promise(() => {});
  assert.equal(await captureTabText(api, 3, 'https://example.com/essay', { timeout: 20 }), null, 'a page that never answers is skipped');
});

test('downloads a page without cookies, in its own encoding, and says why one can’t be read', async () => {
  const requests = [];
  const respond = (body, headers = {}, status = 200) => async (url, init) => { requests.push({ url, init }); return new Response(body, { status, headers }); };
  const page = await fetchPageText('https://example.com/essay', { fetchImpl: respond(article, { 'content-type': 'text/html; charset=utf-8' }) });
  assert.ok(page.text.includes(sentence));
  assert.equal(requests[0].init.credentials, 'omit');
  // A Korean page in EUC-KR that names its encoding only in a meta tag.
  const korean = Buffer.concat([Buffer.from('<html><head><meta charset="euc-kr"></head><body><p>'), Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]), Buffer.from('</p></body></html>')]);
  assert.equal((await fetchPageText('https://example.kr/', { fetchImpl: respond(korean, { 'content-type': 'text/html' }) })).text, '한글');
  assert.equal((await fetchPageText('https://example.com/notes.txt', { fetchImpl: respond('Plain\n\n\nnotes', { 'content-type': 'text/plain' }) })).text, 'Plain\n\nnotes');
  await assert.rejects(fetchPageText('https://example.com/gone', { fetchImpl: respond('', {}, 404) }), /The site answered 404/);
  await assert.rejects(fetchPageText('https://example.com/paper.pdf', { fetchImpl: respond('%PDF', { 'content-type': 'application/pdf' }) }), /Not a web page \(application\/pdf\)/);
  await assert.rejects(fetchPageText('https://example.com/empty', { fetchImpl: respond('<body><script>app()</script></body>', { 'content-type': 'text/html' }) }), /No readable text/);
  await assert.rejects(fetchPageText('https://down.test/', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), /Couldn’t reach the site/);
  const big = await fetchPageText('https://example.com/big', { limit: 1000, fetchImpl: respond(`<body><p>${'a '.repeat(5000)}</p></body>`, { 'content-type': 'text/html' }) });
  assert.ok(big.text.length < 1000, 'reads no more than the limit');
});

test('search words, quoted phrases, and the passage around a match', () => {
  assert.deepEqual(searchTerms('  Attention "Working   Life" attention "unclosed'), ['attention', 'working life', 'unclosed']);
  const text = `Before.\n\n${sentence} Then more words follow here to make this paragraph long enough to cut.\n\nAfter.`;
  const passage = passageAround(text, text.toLowerCase(), 'currency', 30);
  assert.deepEqual(passage, { text: 'Attention is the currency of a working life, and most', cutBefore: false, cutAfter: true }, 'it starts at its paragraph and ends at a word break');
  assert.equal(passageAround(text, text.toLowerCase(), 'after', 30).text, 'After.');
  assert.equal(passageAround(text, text.toLowerCase(), 'absent'), null);
  assert.deepEqual([readingMinutes(10), readingMinutes(2300)], [1, 10]);
});
