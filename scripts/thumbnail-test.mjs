#!/usr/bin/env node
/**
 * Content-thumbnail + publisher/licence gate.
 *
 * Proves, in a real renderer:
 *   1. page 1 of a PDF is actually rasterised to a JPEG data URL
 *   2. the Start page Recent rows show that raster (not the placeholder)
 *   3. Help ▸ About shows Author / Publisher / Website / MIT licence
 *   4. Help ▸ License shows the complete MIT text
 *
 * Uses a per-run os.tmpdir() profile — a shared profile leaves the renderer at
 * readyState:interactive and produces false failures.
 *
 *   node scripts/thumbnail-test.mjs
 */
import './ensure-fixture.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const OUT = path.join(ROOT, '.smoke');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const PORT = await freePort();
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-thumbnail-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
process.on('exit', () => { try { child.kill(); } catch { /* gone */ } });

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up yet */ }
  if (!target) await sleep(350);
}
if (!target) { console.log('THUMBNAIL_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++mid;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 30000);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r && r.result ? r.result.value : null;
};
const escape = async () => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

try {
  for (let i = 0; i < 60; i++) {
    if (await ev('window.__aipdfBooted === true')) break;
    await sleep(250);
  }
  check('renderer booted', await ev('window.__aipdfBooted === true'));

  // 1. Real page-1 raster from pdf.js, through the local-server module.
  const lit = JSON.stringify(FIXTURE);
  const thumb = await ev(`(async () => {
    const m = await import('/js/thumbnails.js');
    const src = await m.getPdfThumbnail(${lit}, 96);
    return { prefix: typeof src === 'string' ? src.slice(0, 23) : '', len: src ? src.length : 0 };
  })()`);
  check('page 1 renders to a JPEG data URL',
    thumb && thumb.prefix === 'data:image/jpeg;base64,' && thumb.len > 1200,
    thumb ? `${thumb.prefix} (${thumb.len} chars)` : 'no result');

  // 2. Start page Recent rows show the raster, not the placeholder icon.
  await ev(`(async () => { const m = await import('/js/app.js'); m.onMenuAction('help:startPage'); return true; })()`);
  let ready = 0;
  for (let i = 0; i < 40 && !ready; i++) {
    ready = await ev(`document.querySelectorAll('.wr-item .pdf-thumb.ready img').length`);
    if (!ready) await sleep(250);
  }
  check('Start page Recent rows show content thumbnails', ready > 0, `${ready} raster(s)`);
  const startShot = await send('Page.captureScreenshot', { format: 'png' });
  if (startShot && startShot.data) fs.writeFileSync(path.join(OUT, 'thumbnail-start-page.png'), Buffer.from(startShot.data, 'base64'));

  // 2b. The boot/empty workspace shows the same previews. Chromium UA gives
  // buttons align-items:flex-start, so also assert the card has real geometry.
  await ev(`(async () => { const m = await import('/js/app.js'); m.onMenuAction('file:close'); return true; })()`);
  await sleep(500);
  let card = null;
  for (let i = 0; i < 40 && !(card && card.ready); i++) {
    card = await ev(`(() => {
      const el = document.querySelector('.ew-rec .pdf-thumb');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { ready: !!el.querySelector('img'), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!(card && card.ready)) await sleep(250);
  }
  check('empty workspace shows recent cover previews',
    !!(card && card.ready && card.w >= 30 && card.h >= 40),
    card ? `${card.w}x${card.h}px ready=${card.ready}` : 'no card');
  const emptyShot = await send('Page.captureScreenshot', { format: 'png' });
  if (emptyShot && emptyShot.data) fs.writeFileSync(path.join(OUT, 'thumbnail-empty-workspace.png'), Buffer.from(emptyShot.data, 'base64'));

  // 3. About dialog carries the exact publisher / website / licence identity.
  await ev(`(async () => { const m = await import('/js/app.js'); m.onMenuAction('help:about'); return true; })()`);
  await sleep(350);
  const about = await ev(`document.querySelector('.modal')?.textContent || ''`);
  check('About shows author, publisher, website and MIT licence',
    about.includes('Manjay Dongol') && about.includes('https://github.com/manjayofficial01-ui/AiPDF')
      && about.includes('MIT License') && about.includes('Copyright'),
    about.slice(0, 90).replace(/\s+/g, ' '));
  await escape();

  // 4. License dialog holds the complete MIT terms.
  await ev(`(async () => { const m = await import('/js/app.js'); m.onMenuAction('help:license'); return true; })()`);
  await sleep(350);
  const lic = await ev(`document.querySelector('.lg-lic-text')?.textContent || ''`);
  check('License dialog shows the full MIT text',
    lic.startsWith('MIT License') && lic.includes('Copyright (c) 2026 Manjay Dongol')
      && lic.includes('THE SOFTWARE IS PROVIDED "AS IS"'),
    `${lic.length} chars`);
  await escape();
} catch (err) {
  check('probe completed', false, String(err && err.message ? err.message : err));
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nTHUMBNAIL_FAIL ${failed.length}/${results.length} checks failed` : `\nTHUMBNAIL_PASS all ${results.length} checks green`);
child.kill();
process.exit(failed.length ? 1 : 0);
