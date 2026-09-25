import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatContext, bookmarkEntries, clipBytes, visibleAnswer } from '../ai-context.js';
import { modelConfig, MODEL_REVISION } from '../ai-config.js';

const root = { children: [
  { title: 'Cities', children: [{ id: 'a', title: 'Urban planning', url: 'https://example.com/private?secret=123', dateAdded: 100 }] },
  { title: 'Software', children: [{ id: 'b', title: 'Software architecture', url: 'https://example.org', dateAdded: 200 }] }
] };

test('extracts folders and retrieves relevant metadata without URL secrets or previews', () => {
  assert.equal(bookmarkEntries(root)[0].folder, 'Cities');
  const context = buildChatContext(root, 'urban planning');
  assert.equal(context.sources[0].id, 'a');
  const input = context.messages.map(m => m.content).join('');
  assert.ok(input.includes('not have full articles'));
  assert.ok(!input.includes('secret=123'));
  assert.equal(context.total, 2);
  assert.ok(input.includes('example.com'));
});
test('bounds multilingual prompts and history for the 4096-token context', () => {
  const large = { children: Array.from({ length: 200 }, (_, i) => ({ id: String(i), title: '日本語'.repeat(200), url: 'https://example.com/' + i })) };
  const context = buildChatContext(large, '質問'.repeat(1000), [{ role: 'user', content: 'old'.repeat(1000) }, { role: 'assistant', content: '回答'.repeat(1000) }]);
  const bytes = new TextEncoder().encode(context.messages.map(m => m.content).join('')).length;
  assert.ok(bytes <= 4800);
  assert.ok(context.sources.length < 200);
  assert.equal(clipBytes('a😀b', 4), 'a');
});
test('handles empty library and samples different folders for broad questions', () => {
  assert.equal(buildChatContext(null, 'connections').sources.length, 0);
  const context = buildChatContext(root, 'What connections do you see?');
  assert.equal(new Set(context.sources.map(s => s.folder)).size, 2);
});
test('pins model data and loads executable WASM only from extension package', () => {
  const config = modelConfig('moz-extension://test/');
  assert.ok(config.model_list[0].model.includes(MODEL_REVISION));
  assert.equal(config.model_list[0].model_lib, 'moz-extension://test/vendor/qwen3-4b.wasm');
  assert.equal(config.cacheBackend, 'indexeddb');
});

test('visibleAnswer hides reasoning blocks, including partial ones while streaming', () => {
  assert.equal(visibleAnswer('<think>\n\n</think>\n\nHello! How can I assist you today?'), 'Hello! How can I assist you today?');
  assert.equal(visibleAnswer('<think>still reasoning'), '');
  assert.equal(visibleAnswer('<thi'), '');
  assert.equal(visibleAnswer('<think>a</think>One <think>b</think>two'), 'One two');
  assert.equal(visibleAnswer('Plain answer with 1 < 2'), 'Plain answer with 1 < 2');
});

test('includes clipped abstracts and ranks bookmarks by abstract text', () => {
  const library = { children: [
    { id: 'plain', title: 'Plain', url: 'https://plain.test/', dateAdded: 300 },
    { id: 'dreamer', title: 'lucidrains/dreamer4', url: 'https://github.com/lucidrains/dreamer4', abstract: 'Implementation of an agent that learns inside a world model. ' + 'detail '.repeat(200), dateAdded: 100 }
  ] };
  const context = buildChatContext(library, 'Which bookmarks cover world models?');
  assert.equal(context.sources[0].id, 'dreamer');
  const system = context.messages[0].content;
  const rows = JSON.parse(system.slice(system.lastIndexOf('\n') + 1));
  assert.match(rows[0].abstract, /^Implementation of an agent/);
  assert.ok(new TextEncoder().encode(rows[0].abstract).length <= 300);
  assert.equal(rows[1].abstract, undefined);
});

test('gives chat the tags and note of each bookmark, and an overview of tags', () => {
  const library = { children: [
    { id: 'n', title: 'Some page', url: 'https://page.test/', tags: ['Fiction'], note: 'Gift idea for Sam', dateAdded: 100 },
    { id: 'o', title: 'Other', url: 'https://other.test/', tags: ['Fiction', 'History'], dateAdded: 200 }
  ] };
  const context = buildChatContext(library, 'Any gift ideas?');
  assert.equal(context.sources[0].id, 'n', 'notes are searched');
  const system = context.messages[0].content;
  const rows = JSON.parse(system.slice(system.lastIndexOf('\n') + 1));
  assert.deepEqual(rows[0].tags, ['Fiction']);
  assert.equal(rows[0].note, 'Gift idea for Sam');
  assert.ok(system.includes('Tag overview: Fiction: 2; History: 1.'));
});

test('gives chat up to three clipped highlights per bookmark and ranks by them', () => {
  const library = { children: [
    { id: 'plain', title: 'Plain', url: 'https://plain.test/', dateAdded: 300 },
    { id: 'quoted', title: 'Essay', url: 'https://essay.test/', dateAdded: 100, highlights: ['Attention is a scarce resource. ' + 'x'.repeat(300), 'Two', 'Three', 'Four'].map(text => ({ id: text, text, createdAt: 1 })) }
  ] };
  const context = buildChatContext(library, 'What did I highlight about attention?');
  assert.equal(context.sources[0].id, 'quoted');
  const system = context.messages[0].content;
  const rows = JSON.parse(system.slice(system.lastIndexOf('\n') + 1));
  assert.equal(rows[0].highlights.length, 3);
  assert.ok(rows[0].highlights[0].startsWith('Attention is a scarce resource.'));
  assert.ok(new TextEncoder().encode(rows[0].highlights[0]).length <= 160);
});
