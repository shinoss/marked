import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeAge } from '../time.js';

test('uses only the largest approximate time unit', () => {
  const now = 1800000000000;
  const age = seconds => relativeAge(now - seconds * 1000, now);
  assert.equal(age(20), 'just now');
  assert.equal(age(34 * 60), '34m ago');
  assert.equal(age(90 * 60), '1h ago');
  assert.equal(age(2 * 86400 + 3600), '2 days ago');
  assert.equal(age(8 * 86400), '1 week ago');
  assert.equal(age(65 * 86400), '2 months ago');
  assert.equal(age(400 * 86400), '1 year ago');
  assert.equal(relativeAge(undefined, now), '');
  assert.equal(relativeAge(0, now), '');
  assert.equal(relativeAge(now + 1000, now), 'just now');
});
