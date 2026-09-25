import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { safeURL, parseHTML, parseJSON, exportHTML, cleanTags, cleanNote, tweetId } from '../bookmarks.js';
const Parser = new JSDOM('').window.DOMParser;

test('rejects executable and malformed URLs', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'about:config', 'not a URL']) assert.equal(safeURL(url), null);
  assert.equal(safeURL('https://example.com'), 'https://example.com/');
});
test('imports nested Firefox HTML including optional end tags', () => {
  const input = `<DL><p><DT><H3>Work</H3><DL><p><DT><A HREF="https://example.com">Example</A><DT><H3>Reading</H3><DL><p><DT><A HREF="https://example.org">Book</A></DL><p></DL><p><DT><H3>Empty</H3><DL><p></DL><p><DT><A HREF="https://mozilla.org">Mozilla</A></DL>`;
  const { nodes } = parseHTML(input, Parser);
  assert.equal(nodes.length, 3);
  assert.equal(nodes[0].children[1].children[0].title, 'Book');
  assert.deepEqual(nodes[1], { title: 'Empty', children: [] });
  assert.equal(nodes[2].title, 'Mozilla');
});
test('HTML export round trips hierarchy, separators, and escaped text', () => {
  const nodes = [{ title: 'A & <B> "C"', children: [{ title: '<script>alert(1)</script>', url: 'https://example.com/?a=1&b=2' }, { type: 'separator' }, { title: 'Empty', children: [] }] }];
  const html = exportHTML({ children: nodes });
  assert.ok(!html.includes('<script>'));
  assert.deepEqual(parseHTML(html, Parser), { nodes, skipped: 0 });
});
test('HTML export and import keep abstracts as bookmark descriptions', () => {
  const nodes = [{ title: 'Folder', children: [{ title: 'Paper', url: 'https://example.com/', abstract: 'About <world> models & agents' }] }];
  const html = exportHTML({ children: nodes });
  assert.ok(html.includes('<DD>About &lt;world&gt; models &amp; agents'));
  assert.deepEqual(parseHTML(html, Parser).nodes, nodes);
  // Firefox also writes folder descriptions, which are not bookmark abstracts.
  const firefox = '<DL><p><DT><H3>Work</H3>\n<DD>Folder notes\n<DL><p><DT><A HREF="https://example.org/">Doc</A>\n<DD>Doc notes\n</DL><p></DL>';
  assert.deepEqual(parseHTML(firefox, Parser).nodes, [{ title: 'Work', children: [{ title: 'Doc', url: 'https://example.org/', abstract: 'Doc notes' }] }]);
});
test('HTML export and import keep tags in the TAGS attribute that Firefox uses', () => {
  const nodes = [{ title: 'Paper', url: 'https://example.com/', tags: ['AI', 'Machine "learning"'] }];
  const html = exportHTML({ children: nodes });
  assert.ok(html.includes('TAGS="AI,Machine &quot;learning&quot;"'));
  assert.deepEqual(parseHTML(html, Parser).nodes, nodes);
  assert.deepEqual(parseHTML('<DL><DT><A HREF="https://example.org/" TAGS="history, ,History,war">War</A></DL>', Parser).nodes[0].tags, ['history', 'war']);
});
test('cleans tags, notes, and recognizes X post links', () => {
  assert.deepEqual(cleanTags(['  AI ', 'ai', 'Deep,learning', '', 42, 'x'.repeat(60)]), ['AI', 'Deep learning', 'x'.repeat(40)]);
  assert.equal(cleanTags(Array.from({ length: 20 }, (_, i) => `t${i}`)).length, 12);
  assert.equal(cleanNote('  Read   later \r\n\r\n\r\n for the   talk  '), 'Read later\n\nfor the talk');
  assert.equal(cleanNote(7), '');
  assert.equal(tweetId('https://x.com/jack/status/20'), '20');
  assert.equal(tweetId('https://twitter.com/a/status/123/photo/1?s=20'), '123');
  assert.equal(tweetId('https://x.com/home'), null);
  assert.equal(tweetId('https://example.com/a/status/1'), null);
});
test('unsafe imports are skipped', () => {
  const result = parseHTML('<DL><DT><A HREF="javascript:alert(1)">Bad</A><DT><A HREF="https://example.com">Good</A></DL>', Parser);
  assert.equal(result.skipped, 1);
  assert.equal(result.nodes.length, 1);
});
test('reads Firefox JSON backups without duplicating places root', () => {
  const result = parseJSON(JSON.stringify({ root: 'placesRoot', children: [{ title: 'Toolbar', children: [{ title: 'Example', uri: 'https://example.com' }, { type: 'text/x-moz-place-separator' }] }] }));
  assert.equal(result.nodes[0].title, 'Toolbar');
  assert.equal(result.nodes[0].children[0].url, 'https://example.com/');
  assert.equal(result.nodes[0].children[1].type, 'separator');
});
test('reads already-parsed JSON data', () => {
  const result = parseJSON({ title: 'Folder', children: [{ title: 'A', url: 'https://example.com' }] });
  assert.equal(result.nodes[0].children[0].url, 'https://example.com/');
});
test('rejects invalid documents', () => {
  assert.throws(() => parseHTML('<html>not bookmarks</html>', Parser));
  assert.throws(() => parseJSON('invalid json'));
  assert.throws(() => parseJSON('null'));
});
