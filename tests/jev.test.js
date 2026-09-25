import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { askJev, recordJevUsage, jevCost, estimateJevTokens, formatCost, JevError, JEV_ENDPOINT, JEV_USAGE_KEY } from '../jev.js';
import { fixture } from './storage-fixture.js';

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const questions = { check: { type: 'noul', instructions: 'Is it?' } };
// askJev logs every request; this keeps test output quiet and records what it says.
const log = mock.method(console, 'log', () => {});

test('sends the documented System One request with the bearer key', async () => {
  let sent;
  const usages = [];
  const data = await askJev({
    apiKey: 'sk-test', state: 'Some text', questions, onUsage: usage => usages.push(usage),
    fetchImpl: async (url, init) => { sent = { url, init }; return reply(200, { model: 'jev-1.13.0', answers: { check: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 300, output_tokens: 20 } }); }
  });
  assert.equal(sent.url, JEV_ENDPOINT);
  assert.equal(sent.init.method, 'POST');
  assert.deepEqual(sent.init.headers, { Authorization: 'Bearer sk-test', 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(sent.init.body), { model: 'jev-latest', state: 'Some text', questions });
  assert.equal(data.answers.check.noul, 0.9);
  assert.deepEqual(usages, [{ input_tokens: 300, output_tokens: 20 }]);
});

test('logs each request as sent, retries included, with the key cut to its last four characters', async () => {
  log.mock.resetCalls();
  const sent = [];
  const statuses = [429, 200];
  await askJev({ apiKey: 'sk-secret-1234', state: 'Some text', questions, retryDelay: 1, fetchImpl: async (url, init) => { sent.push(init); return reply(statuses.shift(), { answers: {} }); } });
  assert.deepEqual(log.mock.calls.map(call => call.arguments[0]), [`Jev request: POST ${JEV_ENDPOINT}`, `Jev request (retry 1): POST ${JEV_ENDPOINT}`]);
  for (const [i, call] of log.mock.calls.entries()) {
    const { headers, body } = call.arguments[1];
    assert.deepEqual(body, JSON.parse(sent[i].body));
    assert.deepEqual(headers, { Authorization: 'Bearer …1234', 'Content-Type': 'application/json' });
  }
  assert.ok(!JSON.stringify(log.mock.calls.map(call => call.arguments)).includes('secret'));
});

test('preview logs the request it would send, sends nothing, and needs no key', async () => {
  log.mock.resetCalls();
  let fetched = false, counted = false;
  const data = await askJev({ apiKey: '', state: 'Some text', questions, preview: true, onUsage: () => { counted = true; }, fetchImpl: async () => { fetched = true; } });
  assert.deepEqual(data, { answers: {} });
  assert.ok(!fetched && !counted);
  assert.deepEqual(log.mock.calls.map(call => call.arguments), [[
    `Jev request (preview, not sent): POST ${JEV_ENDPOINT}`,
    { headers: { Authorization: 'Bearer <your API key>', 'Content-Type': 'application/json' }, body: { model: 'jev-latest', state: 'Some text', questions } }
  ]]);
});

test('retries rate limits and overload, then explains other errors plainly', async () => {
  const statuses = [429, 529, 200];
  const data = await askJev({ apiKey: 'k', state: 's', questions, retryDelay: 1, fetchImpl: async () => reply(statuses.shift(), { answers: {}, usage: { input_tokens: 1 } }) });
  assert.deepEqual(data.answers, {});
  await assert.rejects(askJev({ apiKey: 'bad', state: 's', questions, fetchImpl: async () => reply(401, { error: { message: 'invalid key' } }) }),
    error => error instanceof JevError && error.status === 401 && /rejected the API key/.test(error.message));
  await assert.rejects(askJev({ apiKey: 'k', state: 's', questions, retries: 0, fetchImpl: async () => reply(429, {}) }), error => error.status === 429);
  await assert.rejects(askJev({ apiKey: 'k', state: 's', questions, fetchImpl: async () => reply(500, { detail: 'boom' }) }), /error \(500\): boom/);
  await assert.rejects(askJev({ apiKey: 'k', state: 's', questions, fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), error => error.status === 0 && /could not reach TypeSafe/.test(error.message));
});

test('a cancelled search stops without an error of its own', async () => {
  const controller = new AbortController();
  const pending = askJev({ apiKey: 'k', state: 's', questions, signal: controller.signal, retryDelay: 60000, fetchImpl: async () => reply(429, {}) });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('estimates input tokens within a few percent of the usage in TypeSafe’s documented examples', () => {
  const state = 'Help! My payouts have been failing for 3 days.';
  const examples = [
    [{ is_urgent: { type: 'noul', instructions: 'Does this convey urgency?' } }, 296],
    [{ department: { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: 'Payments, invoicing, refunds', technical: 'Bugs, outages, integrations', sales: 'Pricing, upgrades, new accounts' } } }, 318],
    [{ frustration: { type: 'score', instructions: 'How frustrated is the customer?', criteria: ['Calm', 'Frustrated', 'Very angry'] } }, 304]
  ];
  for (const [questions, reported] of examples) {
    const estimate = estimateJevTokens({ state, questions });
    assert.ok(Math.abs(estimate - reported) / reported < 0.05, `estimated ${estimate}, TypeSafe reported ${reported}`);
  }
  const empty = estimateJevTokens({ state: '', questions: {} });
  assert.equal(estimateJevTokens({ state: '북마크', questions: {} }) - empty, 3, 'a token per character in other scripts');
});

test('prices input tokens only and keeps a running total across calls', async () => {
  assert.equal(jevCost(1_000_000), 0.042);
  assert.equal(jevCost(1_000_000, 1_000_000), 0.042, 'output is free');
  assert.equal(formatCost(0), '$0.00');
  assert.equal(formatCost(0.000084), '$0.000084');
  assert.equal(formatCost(0.0421), '$0.0421');
  assert.equal(formatCost(12.3456), '$12.35');
  const mock = fixture({ id: 'root', children: [] });
  await Promise.all([
    recordJevUsage(mock.api.storage.local, { input_tokens: 1000, output_tokens: 10 }, mock.locks),
    recordJevUsage(mock.api.storage.local, { input_tokens: 500, output_tokens: 5 }, mock.locks)
  ]);
  const total = (await mock.api.storage.local.get())[JEV_USAGE_KEY];
  assert.deepEqual({ ...total, since: 0 }, { calls: 2, inputTokens: 1500, outputTokens: 15, since: 0 });
});
