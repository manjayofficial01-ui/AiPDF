#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Capture real screenshots of the running app for visual verification.
 *
 * A CSS diff cannot tell you whether the redesign actually looks right, and the
 * boot tests cannot see rendering at all. This launches the real app over CDP,
 * opens the fixture, and saves a PNG per theme.
 *
 *   node scripts/ui-shot.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const OUT = path.resolve(ROOT, process.argv[2] || '.smoke');
const PORT = 9412;

fs.mkdirSync(OUT, { recursive: true });

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-ui-shot-'));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE; // would make require('electron') return the Node binding
// windowsHide must NOT be set: it makes Windows create the child window hidden,
// and a hidden window produces no frames to capture.
const child = spawn(ELECTRON, ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, FIXTURE], { cwd: ROOT, env: childEnv });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

const list = await (async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* port not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();

if (!list) { console.log('SHOT_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(list.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
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

// Wait for boot, then make sure a document is actually on screen.
for (let i = 0; i < 60; i++) {
  if (await ev('!!window.__aipdfBooted')) break;
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 2500));
const state = await ev(`JSON.stringify({
  pages: document.querySelectorAll('.page').length,
  canvasInk: [...document.querySelectorAll('.page canvas')].some(c => c.width > 0),
  rail: !!document.getElementById('rail'),
  theme: document.documentElement.dataset.theme || (document.body.classList.contains('dark') ? 'dark' : 'light'),
})`);
console.log('STATE ' + await ev(`JSON.stringify({
  pages: document.querySelectorAll('.page').length,
  canvasInk: [...document.querySelectorAll('.page canvas')].some(c => c.width > 0),
  rail: !!document.getElementById('rail'),
  stDims: (document.getElementById('stDims') || {}).textContent,
  theme: document.documentElement.dataset.theme || (document.body.classList.contains('dark') ? 'dark' : 'light'),
})`));

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log('WROTE ' + file + ' (' + fs.statSync(file).size + ' bytes)');
}

// Force light first: the theme choice persists in settings between runs, so
// without this the "light" shot can silently come out dark.
for (let i = 0; i < 3; i++) {
  if ((await ev(`document.documentElement.dataset.theme`)) === 'light') break;
  await ev(`document.getElementById('btnTheme').click()`);
  await new Promise((r) => setTimeout(r, 700));
}
await new Promise((r) => setTimeout(r, 500));
// Rulers default to off, so turn them on before shooting or the proof is empty.
await ev(`(function(){var t=document.getElementById('rulerToggle'); if(t) t.click(); return !!t;})()`);
await new Promise((r) => setTimeout(r, 800));
console.log('RULERS ' + await ev(`JSON.stringify({togglePresent: !!document.getElementById('rulerToggle'), unit: (document.getElementById('rulerUnit')||{}).textContent, painted: [...document.querySelectorAll('canvas')].filter(c=>/ruler/i.test(c.id)).map(c=>c.width+'x'+c.height)})`));
await shot('ui-light.png');

// Flip to dark through the real user path (the titlebar theme button), which
// updates settings.theme and calls applyTheme(). Forcing classes + setTheme()
// here instead makes applyTheme's own setTheme(settings.theme) fight the change
// back to light when the saved theme is 'system'.
await ev(`document.getElementById('btnTheme').click()`);
await new Promise((r) => setTimeout(r, 1200));
await shot('ui-dark.png');

ws.close();
child.kill();
process.exit(0);
