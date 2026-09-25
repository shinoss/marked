import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookmarkLine, semanticSearch, semanticMatches, WINDOW } from '../semantic-search.js';

test('each bookmark becomes one short line: no address, folder, tags, or labels', () => {
  const node = {
    title: 'On | attention', url: 'https://www.example.com/private/path?token=abc', tags: ['Essays'],
    note: 'Reread\nbefore the review', abstract: 'A short essay.', highlights: [{ text: 'Mark the exact sentence.' }]
  };
  const line = bookmarkLine(node);
  assert.equal(line, 'On attention; Reread before the review; Mark the exact sentence.; A short essay.');
  assert.ok(!/example|token|private|Essays/.test(line));
  assert.equal(bookmarkLine(node, { notes: false, highlights: false }), 'On attention; A short essay.');
  assert.equal(bookmarkLine({ title: 'https://a.test/page', url: 'https://a.test/page' }), '', 'a title that is only the address is left out');
  assert.ok(bookmarkLine({ title: 'x'.repeat(500), url: 'https://a.test/' }).length <= 160);
});

// A stand-in for Jev that favours lines containing a word, and records requests.
function fakeJev(word) {
  const requests = [];
  const ask = async ({ state, questions }) => {
    requests.push({ state, questions });
    const lines = state.split('\n').map(line => line.split('| '));
    const weights = lines.map(([, text]) => (text.includes(word) ? 10 : 0.1));
    const sum = weights.reduce((a, b) => a + b, 0);
    return { answers: {
      where: { type: 'choice', probabilities: Object.fromEntries(lines.map(([id], i) => [id, weights[i] / sum])) },
      exists: { type: 'noul', noul: weights.some(w => w > 1) ? 0.92 : 0.04 }
    } };
  };
  return { ask, requests };
}

test('one request ranks a small library, with a Choice over short ids and a yes/no for any match', async () => {
  const entries = [{ id: 'a', line: 'Cooking pasta' }, { id: 'b', line: 'Protecting your attention' }, { id: 'c', line: 'Gardening' }];
  const { ask, requests } = fakeJev('attention');
  const { ranked, exists } = await semanticSearch('that essay about focus', entries, ask);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].state, 'B000| Cooking pasta\nB001| Protecting your attention\nB002| Gardening');
  assert.deepEqual(requests[0].questions.where.criteria, { B000: null, B001: null, B002: null });
  assert.equal(requests[0].questions.where.type, 'choice');
  assert.match(requests[0].questions.where.instructions, /"that essay about focus"/);
  assert.equal(requests[0].questions.exists.type, 'noul');
  assert.deepEqual(ranked.map(item => item.id), ['b', 'a', 'c']);
  assert.equal(exists, 0.92);
  assert.deepEqual(await semanticSearch('anything', [], ask), { ranked: [], exists: 0 });
});

test('larger libraries are ranked in windows, then the leaders of every window together', async () => {
  const entries = Array.from({ length: 600 }, (_, i) => ({ id: `n${i}`, line: i === 437 ? 'The target bookmark' : `Bookmark ${i}` }));
  const { ask, requests } = fakeJev('target');
  const { ranked } = await semanticSearch('target', entries, ask);
  assert.equal(requests.length, 4, 'three windows and a final pass');
  assert.ok(requests.slice(0, 3).every(request => Object.keys(request.questions.where.criteria).length <= WINDOW));
  const final = requests[3].state.split('\n');
  assert.ok(final.length <= WINDOW && final.some(line => line.endsWith('The target bookmark')));
  assert.equal(ranked[0].id, 'n437');
});

test('shows the likely matches only', () => {
  const ranked = probabilities => probabilities.map((probability, i) => ({ id: String(i), probability }));
  const ids = (list, options) => semanticMatches(ranked(list), options).map(item => item.id);
  assert.deepEqual(ids([0.6, 0.3, 0.06, 0.02, 0.005]), ['0', '1'], 'far less likely results are left out');
  assert.deepEqual(ids([0.9, 0.1]), ['0'], 'a clear winner stands alone');
  assert.deepEqual(ids(Array(10).fill(0.1)), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'], 'equally good matches all show');
  assert.deepEqual(ids([0.6, 0.3], { max: 1 }), ['0']);
  assert.deepEqual(ids([0.004]), []);
});
