#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { detectLocalAi, applyLocalAiSettings } from '../src/renderer/js/local-ai.js';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

test('local AI detection prefers Ollama and applies a no-key provider profile', async () => {
  const ollama = await serve((req, res) => {
    assert.equal(req.url, '/api/tags');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] }));
  });
  try {
    const found = await detectLocalAi({ ollamaUrl: ollama.url, lmStudioUrl: 'http://127.0.0.1:1', timeoutMs: 500 });
    assert.equal(found.provider, 'ollama');
    assert.equal(found.models[0], 'llama3.2:latest');
    const applied = applyLocalAiSettings(found, { model: 'old', temperature: 0.3, apiKey: 'secret' });
    assert.equal(applied.provider, 'ollama');
    assert.equal(applied.baseUrl, `${ollama.url}/v1`);
    assert.equal(applied.model, 'llama3.2:latest');
    assert.equal(applied.authMode, 'none');
    assert.equal(applied.apiKey, '');
    assert.equal(applied.temperature, 0.3);
  } finally { ollama.server.close(); }
});

test('local AI detection falls back to LM Studio model listings', async () => {
  const lm = await serve((req, res) => {
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
  });
  try {
    const found = await detectLocalAi({ ollamaUrl: 'http://127.0.0.1:1', lmStudioUrl: lm.url, timeoutMs: 500 });
    assert.equal(found.provider, 'lmstudio');
    assert.equal(found.models[0], 'local-model');
    assert.equal(applyLocalAiSettings(found, {}).baseUrl, `${lm.url}/v1`);
  } finally { lm.server.close(); }
});

test('local AI detection returns null when no server has models', async () => {
  const empty = await serve((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [] }));
  });
  try {
    const found = await detectLocalAi({ ollamaUrl: empty.url, lmStudioUrl: empty.url, timeoutMs: 500 });
    assert.equal(found, null);
  } finally { empty.server.close(); }
});
