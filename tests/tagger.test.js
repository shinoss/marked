import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestTags, chooseTags } from '../tagger.js';

const tags = ['Technology', 'AI', 'History', 'Fiction'];
const suggest = async page => chooseTags(await suggestTags(page, tags));

test('returns a probability for every tag, most likely first', async () => {
  const scores = await suggestTags({ title: 'Reinforcement learning - Wikipedia', url: 'https://en.wikipedia.org/wiki/Reinforcement_learning', abstract: 'In machine learning and optimal control, reinforcement learning is concerned with…' }, tags);
  assert.deepEqual(scores.map(score => score.tag).sort(), [...tags].sort());
  assert.equal(scores[0].tag, 'AI');
  assert.ok(scores.every(score => score.probability >= 0 && score.probability < 1));
});

test('suggests tags from title words, abstract words, and known domains', async () => {
  assert.deepEqual(await suggest({ title: 'IndexedDB API - Web APIs | MDN', url: 'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API' }), ['Technology']);
  assert.deepEqual(await suggest({ title: 'The fall of the Roman Empire', url: 'https://example.com/' }), ['History']);
  assert.deepEqual(await suggest({ title: 'Reading list', url: 'https://www.goodreads.com/book/show/1' }), ['Fiction']);
  // One abstract mention is not enough; two are.
  assert.deepEqual(await suggest({ title: 'Notes', url: 'https://example.com/', abstract: 'A short story.' }), []);
  assert.deepEqual(await suggest({ title: 'Notes', url: 'https://example.com/', abstract: 'A short story in a fantasy world.' }), ['Fiction']);
  // Words match whole words only: "said" is not "ai", "techno" is not "tech".
  assert.deepEqual(await suggest({ title: 'She said techno is back', url: 'https://example.com/' }), []);
});

test('matches tags added by the user by their own name', async () => {
  const scores = await suggestTags({ title: 'Kitchen designs we love', url: 'https://example.com/' }, ['Design', 'Cooking']);
  assert.deepEqual(chooseTags(scores), ['Design']);
});

test('chooseTags applies the threshold and the cap', () => {
  const scores = [{ tag: 'A', probability: 0.9 }, { tag: 'B', probability: 0.8 }, { tag: 'C', probability: 0.7 }, { tag: 'D', probability: 0.6 }, { tag: 'E', probability: 0.2 }];
  assert.deepEqual(chooseTags(scores), ['A', 'B', 'C']);
  assert.deepEqual(chooseTags(scores, { threshold: 0.75, max: 5 }), ['A', 'B']);
});
