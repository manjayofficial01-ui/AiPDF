#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/js/web-shim.js'), 'utf8');
const LS_KEY = 'aipdf.web.store';
const legacy = {
  settings: {
    theme: 'dark',
    ai: { apiKey: 'legacy-ai-secret', customHeaders: [{ name: 'Authorization', value: 'legacy-header-secret', enabled: true }] },
    tts: { keys: { elevenlabs: 'legacy-tts-secret' } },
  },
  recents: [],
};
const values = new Map([[LS_KEY, JSON.stringify(legacy)]]);
globalThis.window = {};
globalThis.location = { search: '', href: 'https://aipdf.example' };
globalThis.document = {
  readyState: 'complete',
  documentElement: {},
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
};
globalThis.localStorage = {
  getItem: (key) => values.get(key) ?? null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: (key) => values.delete(key),
};

await import('data:text/javascript;base64,' + Buffer.from(SOURCE).toString('base64'));

const scrubbed = values.get(LS_KEY) || '';
for (const secret of ['legacy-ai-secret', 'legacy-header-secret', 'legacy-tts-secret']) {
  assert.equal(scrubbed.includes(secret), false);
}
const loaded = await window.api.storeGet('settings', {});
assert.equal(loaded.theme, 'dark');
assert.equal(loaded.ai.apiKey, '');
assert.equal(loaded.ai.customHeaders[0].value, '');
assert.deepEqual(loaded.tts.keys, {});

const sessionSettings = {
  theme: 'light',
  ai: { apiKey: 'session-ai-secret', customHeaders: [{ name: 'Authorization', value: 'session-header-secret', enabled: true }] },
  tts: { keys: { fish: 'session-tts-secret' } },
};
await window.api.storeSet('settings', sessionSettings);
const inMemory = await window.api.storeGet('settings', {});
assert.equal(inMemory.ai.apiKey, 'session-ai-secret');
assert.equal(inMemory.ai.customHeaders[0].value, 'session-header-secret');
assert.equal(inMemory.tts.keys.fish, 'session-tts-secret');
const persisted = values.get(LS_KEY) || '';
for (const secret of ['session-ai-secret', 'session-header-secret', 'session-tts-secret']) {
  assert.equal(persisted.includes(secret), false);
}

console.log('WEB_SECRETS_PASS legacy scrub and memory-only session keys');
