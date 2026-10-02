import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tagAnswers, tagBatch, tagRequest, TAGS_PER_POST } from '../x-tags.js';
import { DEFAULT_TAGS } from '../store.js';

test('one request holds the posts, and asks of each whether each tag fits it', () => {
  const posts = [{ url: 'https://x.com/a/status/1', author: 'Ada @ada', text: 'A new\nmodel   for proofs' }, { url: 'https://x.com/b/status/2', author: 'Bo', text: 'goal! '.repeat(200) }];
  const { state, questions } = tagRequest(['AI', 'Sports'], posts);
  assert.deepEqual(state.posts[0], { text: 'A new model for proofs' }, 'not who posted it');
  assert.ok(state.posts[1].text.length <= 500, 'long posts are cut');
  assert.deepEqual(Object.keys(questions), ['p0t0', 'p0t1', 'p1t0', 'p1t1']);
  assert.equal(questions.p1t0.type, 'noul');
  assert.equal(questions.p1t0.instructions, 'Does the tag “AI” fit the post in `posts[1]`?', 'naming the post’s place in the state');
  assert.deepEqual(Object.keys(questions.p0t1.criteria), ['true', 'false']);
});

test('a post goes with the post it quotes, its image descriptions and its link preview, each cut short', () => {
  const post = { url: 'https://x.com/a/status/1', author: 'Ada @ada', text: 'Look', quote: { author: 'Bo @bo', text: 'q'.repeat(400) }, images: ['A chart', 'b'.repeat(300), 'c', 'd', 'e'], link: `arxiv.org ${'t'.repeat(400)}` };
  const { state } = tagRequest(['AI'], [post]);
  const [sent] = state.posts;
  assert.deepEqual(Object.keys(sent), ['text', 'quoted_post', 'image_descriptions', 'link_preview']);
  assert.equal(sent.quoted_post, 'q'.repeat(300), 'the quoted post’s text, not who posted it');
  assert.ok(!('quoted_post' in tagRequest(['AI'], [{ ...post, quote: { author: 'Bo @bo', text: ' ' } }]).state.posts[0]), 'a quote with no text adds nothing');
  assert.deepEqual(sent.image_descriptions.map(description => description.length), [7, 200, 1, 1], 'four at most');
  assert.equal(sent.link_preview.length, 300);
  // Said once for the request, not in every question.
  assert.match(state.about, /quoted_post.*image_descriptions.*link_preview/);
});

test('fewer posts per request the more tags there are', () => {
  assert.equal(tagBatch(DEFAULT_TAGS), 20);
  assert.equal(tagBatch(Array(40).fill('t')), 10);
  assert.equal(tagBatch(Array(100).fill('t')), 4);
  assert.equal(tagBatch(Array(1000).fill('t')), 1);
});

test('each post gets the tags that fit it, best first and a few at most; none, when none fits', () => {
  const tags = ['Technology', 'AI', 'Business', 'Sports', 'Health'];
  const posts = ['1', '2', '3'].map(id => ({ url: `https://x.com/a/status/${id}` }));
  const answers = {
    p0t0: { noul: 0.8 }, p0t1: { noul: 0.97 }, p0t2: { noul: 0.6 }, p0t3: { noul: 0.02 }, p0t4: { noul: 0.55 },
    p1t0: { noul: 0.1 }, p1t1: { noul: 0.3 }, p1t2: { noul: 0.49 }, p1t3: { noul: 0.2 }, p1t4: { noul: 0.1 },
    p2t3: { noul: 0.9 }
  };
  assert.deepEqual(tagAnswers(tags, posts, answers), {
    'https://x.com/a/status/1': ['AI', 'Technology', 'Business'],
    'https://x.com/a/status/3': ['Sports']
  });
  assert.equal(TAGS_PER_POST, 3);
  assert.deepEqual(tagAnswers(tags, posts, {}), {}, 'a preview, which answers nothing');
});
