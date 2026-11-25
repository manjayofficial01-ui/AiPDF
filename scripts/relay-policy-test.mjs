#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const {
  isAllowedRelayTarget,
  issueRelayToken,
  verifyRelayToken,
  createRateLimiter,
} = require('../api/relay-policy.js');

const SECRET = 'test-secret-for-relay-policy-only';

test('relay target policy allows known providers and rejects private or arbitrary hosts', () => {
  assert.equal(isAllowedRelayTarget('https://api.openai.com/v1/chat/completions'), true);
  assert.equal(isAllowedRelayTarget('https://generativelanguage.googleapis.com/v1beta/models'), true);
  assert.equal(isAllowedRelayTarget('https://api.elevenlabs.io/v1/text-to-speech/voice'), true);
  assert.equal(isAllowedRelayTarget('https://team.openai.azure.com/openai/deployments/model/chat/completions'), true);
  assert.equal(isAllowedRelayTarget('https://example.com/collect'), false);
  assert.equal(isAllowedRelayTarget('https://127.0.0.1/admin'), false);
  assert.equal(isAllowedRelayTarget('https://10.0.0.8/admin'), false);
  assert.equal(isAllowedRelayTarget('http://api.openai.com/v1/chat/completions'), false);
  assert.equal(isAllowedRelayTarget('not a url'), false);
});

test('relay target policy supports explicitly configured extra provider hosts', () => {
  assert.equal(isAllowedRelayTarget('https://models.internal.example/v1', ['models.internal.example']), true);
  assert.equal(isAllowedRelayTarget('https://other.internal.example/v1', ['models.internal.example']), false);
});

test('relay tokens are signed, host-bound, short-lived, and tamper-resistant', () => {
  const now = 1_800_000_000_000;
  const url = 'https://api.openai.com/v1/chat/completions';
  const token = issueRelayToken(url, SECRET, { now });
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 40);
  assert.deepEqual(verifyRelayToken(token, url, SECRET, { now }), { ok: true, host: 'api.openai.com' });
  assert.equal(verifyRelayToken(token, 'https://openrouter.ai/api/v1/chat/completions', SECRET, { now }).ok, false);
  assert.equal(verifyRelayToken(token, url, 'wrong-secret', { now }).ok, false);
  assert.equal(verifyRelayToken(`${token}x`, url, SECRET, { now }).ok, false);
  assert.equal(verifyRelayToken(token, url, SECRET, { now: now + 6 * 60_000 }).ok, false);
  assert.equal(verifyRelayToken('', url, SECRET, { now }).ok, false);
});

test('relay token issuance refuses missing secrets and disallowed targets', () => {
  assert.throws(() => issueRelayToken('https://api.openai.com/v1', ''), /secret/i);
  assert.throws(() => issueRelayToken('https://example.com/collect', SECRET), /not allowed/i);
});

test('relay rate limiter allows the configured burst and then blocks the client', () => {
  let now = 1_000;
  const limit = createRateLimiter({ limit: 2, windowMs: 1_000, now: () => now });
  assert.equal(limit('203.0.113.7').ok, true);
  assert.equal(limit('203.0.113.7').ok, true);
  const blocked = limit('203.0.113.7');
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.equal(limit('203.0.113.8').ok, true);
  now += 1_001;
  assert.equal(limit('203.0.113.7').ok, true);
});

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    json(payload) { this.payload = payload; return this; },
    write(chunk) { this.body += chunk.toString(); return true; },
    end() { this.ended = true; return this; },
  };
}

test('token endpoint issues a host-bound token and rejects bad origins or targets', async () => {
  const handler = require('../api/relay-token.js');
  const previousSecret = process.env.AIPDF_RELAY_SECRET;
  process.env.AIPDF_RELAY_SECRET = SECRET;
  try {
    const allowed = mockResponse();
    await handler({ method: 'POST', headers: { host: 'aipdf.example' }, body: { url: 'https://api.openai.com/v1/chat/completions' } }, allowed);
    assert.equal(allowed.statusCode, 200);
    assert.equal(verifyRelayToken(allowed.payload.token, 'https://api.openai.com/v1/chat/completions', SECRET).ok, true);

    const crossOrigin = mockResponse();
    await handler({ method: 'POST', headers: { host: 'aipdf.example', origin: 'https://evil.example' }, body: { url: 'https://api.openai.com/v1' } }, crossOrigin);
    assert.equal(crossOrigin.statusCode, 403);

    const malformedOrigin = mockResponse();
    await handler({ method: 'POST', headers: { host: 'aipdf.example', origin: 'not a url' }, body: { url: 'https://api.openai.com/v1' } }, malformedOrigin);
    assert.equal(malformedOrigin.statusCode, 403);

    const denied = mockResponse();
    await handler({ method: 'POST', headers: { host: 'aipdf.example' }, body: { url: 'https://example.com/collect' } }, denied);
    assert.equal(denied.statusCode, 403);
  } finally {
    if (previousSecret == null) delete process.env.AIPDF_RELAY_SECRET;
    else process.env.AIPDF_RELAY_SECRET = previousSecret;
  }
});

test('proxy forwards a valid signed request to an allowed provider', async () => {
  const handler = require('../api/proxy.js');
  const url = 'https://api.openai.com/v1/chat/completions';
  const token = issueRelayToken(url, SECRET);
  let fetched = null;
  const previousFetch = globalThis.fetch;
  const previousSecret = process.env.AIPDF_RELAY_SECRET;
  process.env.AIPDF_RELAY_SECRET = SECRET;
  globalThis.fetch = async (target, options) => {
    fetched = { target, options };
    return {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: (async function* () { yield Buffer.from('{"ok":true}'); })(),
    };
  };
  try {
    const req = { method: 'POST', headers: {}, body: { url, method: 'POST', headers: { Authorization: 'Bearer test', cookie: 'secret' }, body: { model: 'test' }, relayToken: token } };
    const res = mockResponse();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '{"ok":true}');
    assert.equal(fetched.target, url);
    assert.equal(fetched.options.headers.Authorization, 'Bearer test');
    assert.equal(fetched.options.headers.cookie, undefined);
    assert.deepEqual(JSON.parse(fetched.options.body), { model: 'test' });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret == null) delete process.env.AIPDF_RELAY_SECRET;
    else process.env.AIPDF_RELAY_SECRET = previousSecret;
  }
});

test('proxy rejects an unsigned request before fetching upstream', async () => {
  const handler = require('../api/proxy.js');
  let fetched = false;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched = true; throw new Error('must not fetch'); };
  const previousSecret = process.env.AIPDF_RELAY_SECRET;
  process.env.AIPDF_RELAY_SECRET = SECRET;
  try {
    const req = { method: 'POST', headers: {}, body: { url: 'https://api.openai.com/v1/chat/completions' } };
    const res = {
      statusCode: 200,
      headers: {},
      status(code) { this.statusCode = code; return this; },
      setHeader(name, value) { this.headers[name] = value; },
      json(payload) { this.payload = payload; return this; },
      end() { this.ended = true; return this; },
    };
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.equal(fetched, false);
    assert.match(res.payload.error, /token/i);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousSecret == null) delete process.env.AIPDF_RELAY_SECRET;
    else process.env.AIPDF_RELAY_SECRET = previousSecret;
  }
});
