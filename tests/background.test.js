import { test } from 'node:test';
import assert from 'node:assert/strict';

test('context menu opens a prefilled editor for the page, not the clicked link', async () => {
  let menu, onClick;
  const opened = [];
  globalThis.browser = {
    menus: {
      removeAll: async () => {},
      create: details => { menu = details; },
      onClicked: { addListener: listener => { onClick = listener; } }
    },
    runtime: { getURL: path => `moz-extension://marked/${path}` },
    tabs: { create: async details => { opened.push(details); } },
    action: { onClicked: { addListener() {} } }
  };
  await import('../background.js');
  assert.equal(menu.title, 'Add to Marked');
  await onClick({ menuItemId: 'add-to-marked', pageUrl: 'https://example.com/', linkUrl: 'https://other.test/' }, { url: 'https://example.com/?a=1&b=2', title: 'A & B' });
  const request = new URL(opened[0].url);
  assert.equal(request.searchParams.get('add'), 'https://example.com/?a=1&b=2');
  assert.equal(request.searchParams.get('title'), 'A & B');
  await onClick({ menuItemId: 'other' }, {});
  assert.equal(opened.length, 1);
});
