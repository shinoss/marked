import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readPageAbstract } from '../page-abstract.js';

function read(html, reader = readPageAbstract) {
  const dom = new JSDOM(html, { url: 'https://example.com/post' });
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  try { return reader(); } finally {
    delete globalThis.document; delete globalThis.location;
    dom.window.close();
  }
}
const article = `<head><meta property="og:description" content="Fallback"><meta name="Description" content="A post about world models."></head>
  <body><nav><p>Home · About · Contact · Subscribe · Search the whole site</p></nav>
  <article><p>Short.</p><p hidden>Hidden paragraph that should never be included in the abstract.</p>
  <p>A post about world models. Agents learn behaviour by imagining future outcomes.</p>
  <p>The second paragraph explains training in more detail than the first one does.</p></article></body>`;
const expected = 'A post about world models. Agents learn behaviour by imagining future outcomes. The second paragraph explains training in more detail than the first one does.';

test('reads the description and first article paragraphs, skipping page chrome', () => {
  assert.deepEqual(read(article), { url: 'https://example.com/post', text: expected });
});

test('skips cookie banners, clips long pages, and returns nothing for unreadable pages', () => {
  const long = read(`<body><div id="cookie-consent"><p>We use cookies to improve your experience on this site.</p></div>
    <p>${'word '.repeat(150)}</p><p>${'more '.repeat(150)}</p></body>`);
  assert.ok(!long.text.includes('cookies'));
  assert.ok(long.text.length <= 1001);
  assert.ok(long.text.endsWith('…'));
  assert.equal(read('<body><p>Too short to describe anything</p></body>').text, '');
});

test('still works when serialized and injected, as scripting.executeScript does', () => {
  const injected = new Function(`return (${readPageAbstract})`)();
  assert.equal(read(article, injected).text, expected);
});
