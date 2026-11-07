#!/usr/bin/env node
/**
 * Capture screenshots of the three Foxit-parity panels (Attachments,
 * Signatures, Layers) and the command palette, so the panel UI can be
 * verified visually — a headless test proves the data path, not the look.
 *
 *   node scripts/panel-shots.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT = path.resolve(ROOT, process.argv[2] || '.smoke/shots');
const PORT = 9413;

fs.mkdirSync(OUT, { recursive: true });

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-panel-shots-'));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

async function run(fixture, name) {
  const child = spawn(ELECTRON, ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, path.join(ROOT, '.fixtures', fixture)], { cwd: ROOT, env: childEnv });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  let list = null;
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) { list = t; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!list) { console.log(`PANEL_SHOT_FAIL ${name}: no renderer target`); child.kill(); return; }

  const ws = new WebSocket(list.webSocketDebuggerUrl);
  let mid = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

  for (let i = 0; i < 60; i++) {
    if (await ev('!!window.__aipdfBooted')) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await new Promise((r) => setTimeout(r, 2500));

  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const p = path.join(OUT, file);
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
    console.log(`WROTE ${p} (${fs.statSync(p).size} bytes)`);
  };

  // Open the panel through the real rail button, the way a user would.
  for (const [panel, file] of name) {
    await ev(`document.querySelector('.rail-btn[data-panel="${panel}"]').click()`);
    await new Promise((r) => setTimeout(r, 900));
    const filled = await ev(`document.getElementById('sideBody').textContent.slice(0, 60)`);
    console.log(`PANEL ${panel}: ${JSON.stringify(filled)}`);
    await shot(file);
  }

  ws.close();
  child.kill();
  await new Promise((r) => setTimeout(r, 800));
}

await run('fixture-attach.pdf', [
  ['attachments', 'panel-attachments.png'],
  ['signatures', 'panel-signatures.png'],
]);
await run('fixture-layers.pdf', [
  ['layers', 'panel-layers.png'],
]);
console.log('PANEL_SHOTS_DONE');
