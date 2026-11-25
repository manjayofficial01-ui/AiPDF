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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-batch-file-'));
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
  console.error('BATCH_FILE_FAIL no renderer target');
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
  const output = await evaluate(`(async () => {
    const batch = await import('/js/batch.js');
    const pdfjs = await import('/v/pdf.min.mjs');
    const recipe = { name: 'Number and sanitize', steps: [
      { id: 'sanitize', params: {} },
      { id: 'addPageNumbers', params: { formatId: 'n-of-N' } },
    ] };
    const result = await batch.runBatchFile(${JSON.stringify(FIXTURE)}, recipe);
    const pdf = await pdfjs.getDocument({ data: result.bytes.slice(0), useSystemFonts: false }).promise;
    const texts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const content = await (await pdf.getPage(i)).getTextContent();
      texts.push(content.items.map(function (item) { return item.str || ''; }).join(' '));
    }
    const metadata = await pdf.getMetadata();
    await pdf.destroy();
    return JSON.stringify({ ok: result.ok, bytes: result.bytes.length, pages: texts.length,
      numbers: texts.map(function (text, index) { return text.includes('Page ' + (index + 1) + ' of ' + texts.length); }),
      title: metadata.info?.Title || '' });
  })()`);
  const parsed = JSON.parse(output);
  check('batch worker produces a complete processed PDF', parsed.ok && parsed.bytes > 0 && parsed.pages === 3,
    JSON.stringify(parsed));
  check('batch page-number recipe writes one correct number per page', parsed.numbers.every(Boolean), JSON.stringify(parsed.numbers));
  check('batch sanitize recipe clears document metadata', parsed.title === '', `title=${parsed.title}`);

  await evaluate(`(async () => {
    const batch = await import('/js/batch.js');
    batch.openBatchWorkbench();
    return true;
  })()`);
  await waitFor(`(() => {
    const modal = document.querySelector('.modal');
    return !!modal && /Batch Document Workbench/i.test(modal.textContent || '');
  })()`, 'batch workbench modal');
  const ui = await evaluate(`(() => {
    const modal = document.querySelector('.modal');
    return JSON.stringify({ add: !!Array.from(modal.querySelectorAll('button')).find(function (b) { return /Add PDFs/.test(b.textContent || ''); }),
      run: !!Array.from(modal.querySelectorAll('button')).find(function (b) { return /Run batch/.test(b.textContent || ''); }),
      steps: modal.querySelectorAll('.batch-step').length });
  })()`);
  const uiParsed = JSON.parse(ui);
  check('batch workbench exposes file selection, run controls, and recipe steps', uiParsed.add && uiParsed.run && uiParsed.steps === 5, ui);
  await evaluate(`(() => {
    const button = Array.from(document.querySelectorAll('.modal-foot button')).find(function (b) { return /^Close$/i.test(b.textContent || ''); });
    if (button) button.click();
    return true;
  })()`);
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
