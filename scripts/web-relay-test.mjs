#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/js/web-shim.js'), 'utf8');
const SHIM_URL = 'data:text/javascript;base64,' + Buffer.from(SOURCE).toString('base64');

globalThis.window = {};
globalThis.location = { search: '', href: 'https://aipdf.example' };
globalThis.document = {
  readyState: 'complete',
  documentElement: {},
  querySelector: () => null,
  getElementById: () => null,
  addEventListener: () => {},
};
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

await import(SHIM_URL);
assert.equal(window.AIPDF_WEB, true);

const endpoint = 'https://api.openai.com/v1/chat/completions';
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  calls.push({ url: String(url), options });
  if (String(url) === endpoint) throw new TypeError('Simulated CORS/network failure');
  if (String(url) === '/api/relay-token') {
    return new Response(JSON.stringify({ ok: true, token: 'signed-relay-token', expiresAt: Date.now() + 300000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (String(url) === '/api/proxy') {
    return new Response(JSON.stringify({ choices: [{ message: { content: 'relayed answer' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`Unexpected fetch: ${url}`);
};

const result = await window.api.aiChat({
  url: endpoint,
  body: { messages: [{ role: 'user', content: 'Hello' }] },
});
assert.equal(result.ok, true);
assert.equal(result.text, 'relayed answer');
assert.deepEqual(calls.map((call) => call.url), [endpoint, '/api/relay-token', '/api/proxy']);
const tokenBody = JSON.parse(calls[1].options.body);
assert.deepEqual(tokenBody, { url: endpoint });
const relayBody = JSON.parse(calls[2].options.body);
assert.equal(relayBody.relayToken, 'signed-relay-token');
assert.equal(relayBody.url, endpoint);
assert.equal(relayBody.method, 'POST');
assert.deepEqual(relayBody.body, { messages: [{ role: 'user', content: 'Hello' }] });

const deniedCalls = [];
globalThis.fetch = async (url) => {
  deniedCalls.push(String(url));
  if (String(url) === endpoint) throw new TypeError('Simulated CORS/network failure');
  if (String(url) === '/api/relay-token') {
    return new Response(JSON.stringify({ ok: false, error: 'The relay target is not allowed.' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error('Proxy must not be called after token denial');
};
const denied = await window.api.aiChat({ url: 'https://example.com/collect', body: {} });
assert.equal(denied.ok, false);
assert.match(denied.error, /not allowed/i);
assert.deepEqual(deniedCalls, ['https://example.com/collect', '/api/relay-token']);

console.log('WEB_RELAY_PASS token acquisition, proxy envelope, and denial path');
