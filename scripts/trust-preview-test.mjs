#!/usr/bin/env node
import { electronPath, launchElectron } from './lib/electron-harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = electronPath();
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-trust-preview-'));
const originalPath = path.join(temp, 'original.pdf');
const candidatePath = path.join(temp, 'candidate.pdf');
const profile = path.join(temp, 'profile');

const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);
const page = pdf.addPage([595.28, 841.89]);
page.drawText('Trust Preview test document', { x: 72, y: 760, size: 18, font });
const original = await pdf.save();
const candidateDoc = await PDFDocument.load(original);
const candidatePage = candidateDoc.getPage(0);
candidatePage.drawRectangle({ x: 72, y: 700, width: 80, height: 20, color: rgb(1, 0, 0) });
const candidate = await candidateDoc.save();
fs.writeFileSync(originalPath, original);
fs.writeFileSync(candidatePath, candidate);

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
const child = launchElectron(['.', originalPath, `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
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
  child.kill();
  fs.rmSync(temp, { recursive: true, force: true });
  console.error('TRUST_PREVIEW_FAIL no renderer target');
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  for (let i = 0; i < 120; i++) {
    if (await evaluate('!!window.__aipdfBooted && !!window.__aipdfState.activeId')) break;
    await delay(100);
  }
  const candidateBase64 = Buffer.from(candidate).toString('base64');
  const comparison = await evaluate(`(async () => {
    const visual = await import('/js/visualdiff.js');
    const store = await import('/js/store.js');
    const doc = store.activeDoc();
    const candidateBytes = Uint8Array.from(atob(${JSON.stringify(candidateBase64)}), function (c) { return c.charCodeAt(0); });
    const same = await visual.buildVisualComparison(doc.bytes, doc.bytes, { doc });
    const changed = await visual.buildVisualComparison(doc.bytes, candidateBytes, { doc });
    return JSON.stringify({ same: same.summary, changed: changed.summary,
      page: changed.pages[0] && { changed: changed.pages[0].changed, expected: changed.pages[0].expected,
        unexplained: changed.pages[0].unexplainedRegions.length, regions: changed.pages[0].regions.length } });
  })()`);
  const parsed = JSON.parse(comparison);
  check('identical saved bytes produce no visual changes', parsed.same.changed === 0, JSON.stringify(parsed.same));
  check('a visual-only PDF change is detected', parsed.changed.changed === 1 && parsed.page?.changed === true,
    JSON.stringify(parsed.changed));
  check('an unapproved visual region is classified as unexplained', parsed.page?.expected === false
    && parsed.page.unexplained > 0 && parsed.page.regions > 0, JSON.stringify(parsed.page));

  const canceled = await evaluate(`(async () => {
    const app = await import('/js/app.js');
    const store = await import('/js/store.js');
    const doc = store.activeDoc();
    const candidateBytes = Uint8Array.from(atob(${JSON.stringify(candidateBase64)}), function (c) { return c.charCodeAt(0); });
    doc.redactionProof = [];
    const pending = app.proofForSave(doc, candidateBytes);
    let seen = false;
    for (let i = 0; i < 120; i++) {
      const button = Array.from(document.querySelectorAll('.modal button')).find(function (b) {
        return /Cancel save/i.test(b.textContent || '');
      });
      if (button) { seen = true; button.click(); break; }
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    const result = await pending;
    return JSON.stringify({ seen: seen, result: result === null ? 'null' : typeof result });
  })()`);
  const cancelResult = JSON.parse(canceled);
  check('Trust Preview cancel blocks an unexplained visual save', cancelResult.seen && cancelResult.result === 'null',
    JSON.stringify(cancelResult));

  const overridden = await evaluate(`(async () => {
    const app = await import('/js/app.js');
    const store = await import('/js/store.js');
    const doc = store.activeDoc();
    const candidateBytes = Uint8Array.from(atob(${JSON.stringify(candidateBase64)}), function (c) { return c.charCodeAt(0); });
    const pending = app.proofForSave(doc, candidateBytes);
    let seen = false;
    for (let i = 0; i < 120; i++) {
      const button = Array.from(document.querySelectorAll('.modal button')).find(function (b) {
        return /Save anyway/i.test(b.textContent || '');
      });
      if (button) { seen = true; button.click(); break; }
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    const result = await pending;
    return JSON.stringify({ seen: seen, result: result === null ? 'null' : typeof result });
  })()`);
  const overrideResult = JSON.parse(overridden);
  check('Trust Preview explicit override allows the candidate bytes', overrideResult.seen && overrideResult.result === 'object',
    JSON.stringify(overrideResult));
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
