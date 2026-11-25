#!/usr/bin/env node
import { electronPath, launchElectron } from './lib/electron-harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = electronPath();
const PAGE_COUNT = 120;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-viewer-large-'));
const fixture = path.join(temp, 'large.pdf');
const profile = path.join(temp, 'profile');

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < PAGE_COUNT; i++) {
  const page = pdf.addPage([595.28, 841.89]);
  page.drawText(`Large document page ${i + 1}`, { x: 72, y: 760, size: 18, font });
}
fs.writeFileSync(fixture, await pdf.save());

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
const child = launchElectron(['.', fixture, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    page = (await response.json()).find((target) => target.type === 'page' && target.url.includes('index.html')) || null;
  } catch { /* not ready */ }
  if (!page) await delay(200);
}
if (!page) {
  child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
  console.error('VIEWER_LARGE_FAIL no renderer target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  for (let i = 0; i < 120; i++) {
    if (await evaluate('!!window.__aipdfBooted')) break;
    await delay(100);
  }
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`document.querySelectorAll('#pages .page').length === ${PAGE_COUNT}`)) break;
    await delay(100);
  }
  await delay(1200);

  const initial = await evaluate(`(() => {
    const canvases = Array.from(document.querySelectorAll('#pages canvas.pdf'));
    return { pages: document.querySelectorAll('#pages .page').length, canvases: canvases.length,
      canvasBytes: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0) };
  })()`);
  check('large document creates every stable page wrapper', initial.pages === PAGE_COUNT, `pages=${initial.pages}`);
  check('initial load creates canvases only for visible pages', initial.canvases <= 12,
    `canvases=${initial.canvases}, canvasBytes=${initial.canvasBytes}`);
  check('initial canvas backing store stays bounded', initial.canvasBytes <= 20 * 1024 * 1024,
    `canvasBytes=${initial.canvasBytes}`);

  await evaluate(`(async () => {
    const viewer = await import('/js/viewer.js');
    viewer.scrollToPage(60, { smooth: false });
    return true;
  })()`);
  for (let i = 0; i < 200; i++) {
    if (await evaluate(`(async () => !!((await import('/js/viewer.js')).pageEl(60)?.rendered))()`)) break;
    await delay(100);
  }
  const scrolled = await evaluate(`(async () => {
    const viewer = await import('/js/viewer.js');
    const rec = viewer.pageEl(60);
    const canvases = Array.from(document.querySelectorAll('#pages canvas.pdf'));
    return { rendered: !!rec?.rendered, text: rec?.textLayer?.textContent || '',
      canvases: canvases.length, canvasBytes: canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0) };
  })()`);
  check('scrolling renders a distant page on demand', scrolled.rendered && scrolled.text.includes('Large document page 61'),
    `rendered=${scrolled.rendered}`);
  check('canvas backing stores remain bounded after a distant jump', scrolled.canvasBytes <= 30 * 1024 * 1024,
    `canvases=${scrolled.canvases}, canvasBytes=${scrolled.canvasBytes}`);
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
