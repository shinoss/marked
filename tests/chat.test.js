import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('opening chat without WebGPU explains incompatibility without downloading anything', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.browser = { runtime: { getURL: path => `moz-extension://test/${path}` } };
  Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  const { openChat } = await import('../chat.js');
  await openChat(() => ({ children: [] }));
  assert.equal(document.getElementById('chat-panel').hidden, false);
  assert.equal(document.getElementById('chat-start').disabled, true);
  assert.match(document.getElementById('chat-status').textContent, /WebGPU is unavailable/);
  document.getElementById('chat-close').click();
  assert.equal(document.getElementById('chat-panel').hidden, true);
  assert.equal(document.getElementById('chat-toggle').getAttribute('aria-expanded'), 'false');
  dom.window.close();
});

test('Enter submits the chat form; Shift+Enter and IME composition do not', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.browser = { runtime: { getURL: path => `moz-extension://test/${path}` } };
  Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  const { openChat } = await import(`../chat.js?enter`);
  await openChat(() => ({ children: [] }));
  let submits = 0;
  document.getElementById('chat-form').addEventListener('submit', () => submits++);
  const press = init => {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });
    document.getElementById('chat-question').dispatchEvent(event);
    return event.defaultPrevented;
  };
  assert.equal(press({ shiftKey: true }), false);
  assert.equal(press({ isComposing: true }), false);
  assert.equal(submits, 0);
  assert.equal(press({}), true);
  assert.equal(submits, 1);
  dom.window.close();
});

test('Unload asks for confirmation and does nothing when declined', async () => {
  const dom = new JSDOM(await readFile(new URL('../manager.html', import.meta.url), 'utf8'), { url: 'https://extension.local/manager.html' });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.browser = { runtime: { getURL: path => `moz-extension://test/${path}` } };
  Object.defineProperty(navigator, 'gpu', { value: undefined, configurable: true });
  const { openChat } = await import(`../chat.js?unload`);
  await openChat(() => ({ children: [] }));
  const unloadButton = document.getElementById('chat-unload');
  const statusText = () => document.getElementById('chat-status').textContent;
  const prompts = [];
  try {
    globalThis.confirm = message => { prompts.push(message); return false; };
    unloadButton.disabled = false; unloadButton.click();
    assert.equal(prompts.length, 1);
    assert.match(statusText(), /WebGPU is unavailable/);
    globalThis.confirm = message => { prompts.push(message); return true; };
    unloadButton.disabled = false; unloadButton.click();
    assert.equal(prompts.length, 2);
    assert.match(statusText(), /Model unloaded/);
  } finally {
    delete globalThis.confirm;
    dom.window.close();
  }
});
