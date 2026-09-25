import { test } from 'node:test';
import assert from 'node:assert/strict';
import { siteOf, fetchSite, cleanCard, markdownBlocks, htmlText } from '../sites.js';
import { countWords } from '../page-text.js';

// A stand-in for the sites' APIs: each address answers with its JSON or text.
function api(routes) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    asked.push({ url, init });
    const route = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!route) return new Response('Not found', { status: 404 });
    const [, answer] = route;
    return typeof answer === 'number' ? new Response('', { status: answer })
      : new Response(typeof answer === 'string' ? answer : JSON.stringify(answer), { headers: { 'content-type': typeof answer === 'string' ? 'text/plain' : 'application/json' } });
  };
  return { fetchImpl, asked };
}
const read = async (url, routes) => {
  const { fetchImpl, asked } = api(routes);
  return { ...await fetchSite(url, { fetchImpl }), asked };
};
const paragraphs = text => text.text.split('\n\n').map((paragraph, index) => [text.kinds.split(' ')[index], paragraph]);

test('knows posts on Hacker News and GitHub by their addresses', () => {
  assert.deepEqual(siteOf('https://news.ycombinator.com/item?id=41234567'), { site: 'hn', id: '41234567' });
  assert.deepEqual(siteOf('https://github.com/lucidrains/dreamer4'), { site: 'github', owner: 'lucidrains', repo: 'dreamer4', kind: 'repo' });
  assert.deepEqual(siteOf('https://github.com/nodejs/node/issues/123'), { site: 'github', owner: 'nodejs', repo: 'node', kind: 'issue', number: 123 });
  assert.deepEqual(siteOf('https://github.com/nodejs/node/pull/456#discussion'), { site: 'github', owner: 'nodejs', repo: 'node', kind: 'pull', number: 456 });
  for (const other of ['https://www.reddit.com/r/programming/comments/1abc2d/why_rust/', 'https://news.ycombinator.com/news', 'https://github.com/features/copilot', 'https://github.com/nodejs/node/tree/main', 'https://bsky.app/profile/jay.bsky.team/post/3kabc2d', 'https://example.com/', 'not a url']) assert.equal(siteOf(other), null, other);
});

test('a Hacker News story, with its top comments as plain text', async () => {
  const { card, text, asked } = await read('https://news.ycombinator.com/item?id=100', {
    'https://hacker-news.firebaseio.com/v0/item/100.json': { id: 100, type: 'story', by: 'pg', title: 'Show HN: Marked', url: 'https://github.com/shinoss/marked', score: 312, descendants: 145, time: 1700000000, kids: [101, 102, 103] },
    'https://hacker-news.firebaseio.com/v0/item/101.json': { id: 101, by: 'dang', text: 'Nice &amp; tidy.<p>Second &quot;paragraph&quot; with <a href="https://x.test">a link</a>.' },
    'https://hacker-news.firebaseio.com/v0/item/102.json': { id: 102, deleted: true },
    'https://hacker-news.firebaseio.com/v0/item/103.json': { id: 103, by: 'tptacek', text: 'Code:<p><pre><code>  const x = 1;\n  x++;\n</code></pre>' }
  });
  assert.equal(asked[0].init.credentials, 'omit', 'no cookies');
  assert.deepEqual([card.site, card.kind, card.title, card.handle, card.domain, card.stats], ['hn', 'story', 'Show HN: Marked', 'pg', 'github.com', { score: 312, comments: 145 }]);
  assert.deepEqual(paragraphs(text), [
    ['q', 'Link: https://github.com/shinoss/marked'], ['h3', 'Top comments'],
    ['by', 'dang'], ['p', 'Nice & tidy.'], ['p', 'Second "paragraph" with a link.'],
    ['by', 'tptacek'], ['p', 'Code:'], ['pre', 'const x = 1;\nx++;']
  ]);
});

test('a GitHub repository with its README, and issues and pull requests with their discussion', async () => {
  const api = 'https://api.github.com/repos/lucidrains/dreamer4';
  const repo = await read('https://github.com/lucidrains/dreamer4', {
    [`${api}/readme`]: '# Dreamer 4\n\nWorld models that learn by imagining.\n\n```python\nfrom dreamer4 import Dreamer\n\n\nDreamer()\n```',
    [api]: { full_name: 'lucidrains/dreamer4', description: 'Implementation of Dreamer 4', stargazers_count: 1234, forks_count: 56, language: 'Python', license: { spdx_id: 'MIT' }, topics: ['world-models', 'rl'], pushed_at: '2026-09-01T00:00:00Z' }
  });
  assert.deepEqual([repo.card.kind, repo.card.title, repo.card.text, repo.card.language, repo.card.license, repo.card.labels, repo.card.stats], ['repo', 'lucidrains/dreamer4', 'Implementation of Dreamer 4', 'Python', 'MIT', ['world-models', 'rl'], { stars: 1234, forks: 56 }]);
  assert.deepEqual(paragraphs(repo.text), [['q', 'Implementation of Dreamer 4'], ['h2', 'Dreamer 4'], ['p', 'World models that learn by imagining.'], ['pre', 'from dreamer4 import Dreamer\nDreamer()']]);

  const node = 'https://api.github.com/repos/nodejs/node';
  const pull = await read('https://github.com/nodejs/node/pull/456', {
    [`${node}/issues/456/comments`]: [{ user: { login: 'reviewer' }, body: 'LGTM' }],
    [`${node}/issues/456`]: { title: 'fs: faster reads', state: 'closed', user: { login: 'author' }, labels: [{ name: 'fs' }], body: 'Makes reads faster.', comments: 1, created_at: '2026-02-01T00:00:00Z', pull_request: {} },
    [`${node}/pulls/456`]: { merged: true }
  });
  assert.deepEqual([pull.card.kind, pull.card.state, pull.card.community, pull.card.number, pull.card.handle, pull.card.labels], ['pull', 'merged', 'nodejs/node', 456, 'author', ['fs']]);
  assert.deepEqual(paragraphs(pull.text), [['by', 'author'], ['p', 'Makes reads faster.'], ['by', 'reviewer'], ['p', 'LGTM']]);
});

test('says why a post can’t be read, and keeps only a sensible card', async () => {
  await assert.rejects(read('https://news.ycombinator.com/item?id=1', {}), /isn’t there anymore/);
  await assert.rejects(read('https://github.com/a/b', { 'https://api.github.com/repos/a/b': 403 }), /limiting requests/);
  await assert.rejects(fetchSite('https://example.com/'), /no card for this site/);
  assert.equal(cleanCard({ site: 'myspace', kind: 'post' }), null);
  assert.equal(cleanCard({ site: 'reddit', kind: 'post', title: 'Why Rust?' }), null, 'only the sites Marked reads');
  const card = cleanCard({ site: 'hn', kind: 'story', title: 'T'.repeat(400), stats: { score: -1, comments: 3, bogus: 1 }, labels: ['a', 5, ''], image: 'https://remote.test/image.jpg', fetchedAt: 9 });
  assert.deepEqual(card, { site: 'hn', kind: 'story', title: 'T'.repeat(300), stats: { comments: 3 }, labels: ['a'], fetchedAt: 9 });
});

test('Markdown and Hacker News HTML become plain text, keeping code and names whole', () => {
  assert.deepEqual(markdownBlocks('A _quiet_ word, a snake_case_name, and **bold** `code`.\n\n> Quoted\n\n1. First\n2) Second\n\n---\n\n![alt text](x.png)'), [
    { kind: 'p', text: 'A quiet word, a snake_case_name, and bold code.' },
    { kind: 'q', text: 'Quoted' }, { kind: 'li', text: '• First' }, { kind: 'li', text: '• Second' }, { kind: 'p', text: 'alt text' }
  ]);
  assert.equal(htmlText('One &#x27;two&#x27;<p>Three&#x2F;four &lt;5&gt;'), 'One \'two\'\n\nThree/four <5>');
});
