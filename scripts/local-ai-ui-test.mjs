#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-local-ai-ui-'));
const profile = path.join(temp, 'profile');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const port = await freePort();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target = null;
const deadline = Date.now() + 40000;
while (!target && Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    target = (await response.json()).find((item) => item.type === 'page' && item.url.includes('index.html')) || null;
  } catch { /* not ready */ }
  if (!target) await delay(200);
}
if (!target) {
  child.kill(); fs.rmSync(temp, { recursive: true, force: true });
  console.error('LOCAL_AI_UI_FAIL no renderer target');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id != null && pending.has(message.id)) {
    const record = pending.get(message.id);
    pending.delete(message.id);
    message.error ? record.reject(new Error(message.error.message)) : record.resolve(message.result || {});
  }
});
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label) => {
  for (let i = 0; i < 200; i++) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await waitFor('!!window.__aipdfBooted', 'app boot');
  await evaluate(`(async () => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (input, init) {
      if (String(input) === 'http://localhost:11434/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen2.5:7b' }] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input, init);
    };
    const ai = await import('/js/ai.js');
    ai.configureAI(false);
    return true;
  })()`);
  await waitFor(`!!document.querySelector('.modal')`, 'AI settings modal');
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.modal button')).find(function (item) {
      return /Detect local AI/i.test(item.textContent || '');
    });
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await waitFor(`(() => {
    const modal = document.querySelector('.modal');
    return !!modal && /Ollama connected/i.test(modal.textContent || '');
  })()`, 'local AI detection');
  const applied = await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.modal-foot button')).find(function (item) {
      return /^OK$/i.test(item.textContent || '');
    });
    if (!button) return null;
    button.click();
    return true;
  })()`);
  const config = await evaluate(`JSON.stringify(window.__aipdfSettings.ai)`);
  const parsed = JSON.parse(config);
  check('local AI settings dialog detects Ollama and saves a no-key profile', applied === true
    && parsed.provider === 'ollama', config);
  check('detected local AI uses the local endpoint, first model, and no credentials', parsed.baseUrl === 'http://localhost:11434/v1'
    && parsed.model === 'llama3.2:latest' && parsed.authMode === 'none' && parsed.apiKey === '', config);
} finally {
  send('Browser.close').catch(() => {});
  try { ws.close(); } catch { /* already closed */ }
  child.kill();
  await delay(300);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
