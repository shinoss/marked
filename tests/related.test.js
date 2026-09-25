import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, documentTerms, buildIndex, similar, weigh, compactIndex, expandIndex } from '../related.js';

const library = [
  ['transformer', { title: 'Transformer (deep learning architecture)', tags: ['AI'], text: 'A transformer relates tokens with multi-head attention. It trains on GPUs.' }],
  ['attention', { title: 'Attention (machine learning)', tags: ['AI'], note: 'Read before the transformer one.', text: 'Attention lets a model weigh tokens.' }],
  ['pasta', { title: 'Weeknight pasta', tags: ['Cooking'], text: 'Boil water, salt it, and cook the pasta until it is tender.' }],
  ['soup', { title: 'Tomato soup', tags: ['Cooking'], text: 'Simmer tomatoes with salt; the soup is done when tender.' }],
  ['taxes', { title: 'Filing taxes', text: 'The forms are due in April.' }]
].map(([id, fields]) => ({ id, terms: documentTerms(fields) }));

test('words: lowercased, singular, no common ones or bare numbers; Chinese and Japanese in pairs', () => {
  assert.deepEqual(tokenize('The Transformers’ GPUs, and 3 models in 2024'), ['transformer', 'gpu', 'model']);
  assert.deepEqual(tokenize('注意力 and 한국어 문장'), ['注意', '意力', '한국어', '문장']);
  assert.deepEqual(tokenize('class focus analysis APIs'), ['class', 'focus', 'analysis', 'api'], 'only plurals lose their s');
});

test('a bookmark’s own words count more than its page’s', () => {
  const terms = documentTerms({ title: 'Attention', tags: ['Focus'], note: 'attention', text: 'attention focus' });
  assert.deepEqual([terms.get('attention'), terms.get('focus')], [3 + 2 + 1, 3 + 1]);
});

test('similar bookmarks come first, with the words they share; unrelated ones don’t come at all', () => {
  const index = buildIndex(library);
  const like = id => similar(index, index.vectors.get(id), { exclude: new Set([id]) });
  assert.equal(like('transformer')[0].id, 'attention');
  assert.ok(['ai', 'transformer'].every(term => like('attention')[0].shared.includes(term)), 'with the words they share most');
  assert.deepEqual(like('pasta').map(match => match.id), ['soup'], 'cooking with cooking');
  assert.deepEqual(like('taxes'), [], 'nothing shares its words');
  const page = weigh(index, documentTerms({ title: 'How attention works in transformers' }));
  assert.equal(similar(index, page)[0].id, 'attention', 'a page not in Marked finds its bookmarks too');
});

test('the stored index is small and finds the same bookmarks', () => {
  const index = buildIndex(library);
  const compact = JSON.parse(JSON.stringify(compactIndex(index, 4)));
  assert.equal(compact.version, 1);
  assert.ok(Object.values(compact.docs).every(terms => terms.length <= 4));
  const small = expandIndex(compact);
  assert.deepEqual(similar(small, small.vectors.get('pasta'), { exclude: new Set(['pasta']) }).map(match => match.id), ['soup']);
});
