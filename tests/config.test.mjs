import assert from 'node:assert/strict';
import { test } from 'node:test';

// config.js reads the page URL when it is first evaluated, so each case imports a fresh copy under its own query.
let copy = 0;
async function configFor(search, hostname = 'localhost') {
  globalThis.location = { search, hostname };
  try {
    return await import(`../web/config.js?case=${copy++}`);
  } finally {
    delete globalThis.location;
  }
}

test('laptop A reaches its own relay with no URL parameters', async () => {
  const config = await configFor('');
  assert.equal(config.USER_ID, 'A');
  assert.equal(config.RELAY_URL, 'ws://localhost:8765');
  assert.equal(config.TRACKER_SOURCE, 'websocket');
});

test('a page served from another machine looks for the relay on that machine', async () => {
  const config = await configFor('?user=B', '172.20.10.3');
  assert.equal(config.RELAY_URL, 'ws://172.20.10.3:8765');
});

test('the URL can name the relay explicitly, for either laptop', async () => {
  const config = await configFor('?user=B&relay=ws://10.0.0.7:8765&tracker=mock');
  assert.deepEqual([config.USER_ID, config.RELAY_URL, config.TRACKER_SOURCE], ['B', 'ws://10.0.0.7:8765', 'mock']);
  assert.equal((await configFor('?relay=ws://example:9')).RELAY_URL, 'ws://example:9');
});

test('no IP address is written into the app', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const dir = new URL('../web/', import.meta.url);
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.js') || n.endsWith('.html'))) {
    const text = await readFile(new URL(name, dir), 'utf8');
    assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, `${name} contains an IP address`);
  }
});
