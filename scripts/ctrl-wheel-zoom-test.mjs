#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live verification of the Ctrl + mouse-wheel zoom gesture.
 *
 *   node scripts/ctrl-wheel-zoom-test.mjs
 *
 * The scale is read from the rendered page width (rec.wrap width = pageW *
 * scale), which is the truthful visual result. #zoomSelect is NOT a reliable
 * probe: it can only hold values that exist as <option>s, so an arbitrary
 * custom scale makes it fall back to its first entry.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9561;

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-ctrl-wheel-zoom-test-'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', `--user-data-dir=${PROFILE}`, FIXTURE, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up yet */ }
  if (!page) await sleep(400);
}
if (!page) { console.log('CWZ_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result ? r.result.value : undefined;
};

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

/* Cold start is racy: the target appears before app.js finishes booting and a
   page is rendered. Wait for both before dispatching anything. */
const bootDeadline = Date.now() + 30000;
while (Date.now() < bootDeadline) {
  const ready = await ev(`!!window.__aipdfBooted && document.querySelectorAll('.page').length > 0`);
  if (ready === true) break;
  await sleep(300);
}
await sleep(700);
await ev(`document.querySelector('#emptyWorkspace')?.classList.add('hidden')`);

const CTRL = 2;
/** Rendered page width in px — proportional to the live zoom scale. */
const pageWidth = () => ev(`(function(){ var p = document.querySelector('.page'); return p ? Math.round(p.getBoundingClientRect().width) : -1; })()`);

const center = await ev(`(function(){
  var el = document.getElementById('canvasWrap');
  var b = el.getBoundingClientRect();
  return { x: Math.round(b.left + b.width * 0.5), y: Math.round(b.top + b.height * 0.5) };
})()`);
check('the document area is on screen', !!center && center.x > 0 && center.y > 0, JSON.stringify(center));

async function wheel(deltaY, modifiers) {
  await send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0, deltaY, modifiers,
  });
  await sleep(360);
}

const w0 = await pageWidth();
check('a page is rendered at a measurable scale', w0 > 0, `w=${w0}`);

await wheel(-120, CTRL);
const w1 = await pageWidth();
check('Ctrl+wheel up zooms in (page grows)', w1 > w0, `${w0} -> ${w1}`);

await wheel(-120, CTRL);
const w2 = await pageWidth();
check('a second Ctrl+wheel up zooms in further', w2 > w1, `${w1} -> ${w2}`);

await wheel(120, CTRL);
const w3 = await pageWidth();
check('Ctrl+wheel down zooms back out (page shrinks)', w3 < w2, `${w2} -> ${w3}`);

/* A plain wheel must scroll the document, never zoom it. */
const wBeforePlain = await pageWidth();
await wheel(120, 0);
const wAfterPlain = await pageWidth();
check('a plain wheel does not change the zoom', wBeforePlain === wAfterPlain, `${wBeforePlain} -> ${wAfterPlain}`);

/* Zooming out past the initial fit must also work (the chord is symmetric). */
const wBeforeOut = await pageWidth();
await wheel(360, CTRL);
const wAfterOut = await pageWidth();
check('a strong Ctrl+wheel down keeps zooming out', wAfterOut < wBeforeOut, `${wBeforeOut} -> ${wAfterOut}`);

console.log(`\nCWZ_RESULT pass=${pass} fail=${fail}`);
child.kill();
process.exit(fail ? 1 : 0);
