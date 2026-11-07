#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Dialogs must be movable by their title bar.
 *
 * The case that prompted this: the "Edit text" dialog sits over the very text
 * you are comparing against, and there was no way to move it aside.
 *
 * The contract:
 *   - dragging `.modal-head` moves the whole `.modal` by the pointer delta;
 *   - the drag detaches the modal from the backdrop's grid centring (fixed
 *     left/top) and keeps part of it on screen;
 *   - the close X is NOT a drag handle — a press there never moves the modal,
 *     and the X still closes it;
 *   - the button row still works after a drag.
 *
 * Real app, real pointer events through CDP — no mocks.
 *
 *   node scripts/modal-drag-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');

if (!fs.existsSync(ELECTRON)) { console.log('DRAG_FAIL missing electron ' + ELECTRON); process.exit(1); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-drag-ud-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`];
if (fs.existsSync(FIXTURE)) args.splice(1, 0, FIXTURE);
const child = spawn(ELECTRON, args, { cwd: ROOT, env });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 180000);
bail.unref?.();

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!target) await sleep(400);
}
if (!target) { console.log('DRAG_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const errs = [];
const send = (method, params) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 220));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 220));
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r || r.exceptionDetails) { console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 400)); return undefined; }
  return r.result ? r.result.value : undefined;
}
const evJson = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch { return null; } };

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};

/* A drag is press → several moves → release, all with the left button down. */
const press = (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 });
const move = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'left', buttons: 1 });
const release = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 0 });
const click = async (x, y) => { await press(x, y); await sleep(40); await release(x, y); };
const drag = async (from, to, steps = 8) => {
  await press(from.x, from.y);
  await sleep(60);
  for (let s = 1; s <= steps; s++) {
    await move(from.x + ((to.x - from.x) * s) / steps, from.y + ((to.y - from.y) * s) / steps);
    await sleep(35);
  }
  await release(to.x, to.y);
};

for (let i = 0; i < 120; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
await sleep(1200);

/** Open a dialog shaped like the one in the screenshot (narrow, textarea). */
const openDialog = () => ev(`(async function(){
  const d = await import('/js/dialog.js');
  d.showModal({
    title: 'Edit text',
    width: 'narrow',
    body: (b) => {
      const ta = document.createElement('textarea');
      ta.className = 'de-ask-text';
      ta.value = 'Drag this window by its title bar.';
      b.appendChild(ta);
    },
    buttons: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Edit', value: true, kind: 'primary', default: true },
    ],
  });
  return 'ok';
})()`);

const rects = () => evJson(`(function(){
  const m = document.querySelector('.modal');
  const h = document.querySelector('.modal-head');
  const x = document.querySelector('.modal-head button');
  const r = m && m.getBoundingClientRect();
  const hr = h && h.getBoundingClientRect();
  const xr = x && x.getBoundingClientRect();
  const cs = m && getComputedStyle(m);
  return JSON.stringify({
    modal: r && { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height },
    head: hr && { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 },
    close: xr && { x: xr.left + xr.width / 2, y: xr.top + xr.height / 2 },
    position: cs && cs.position,
    inlineLeft: m && m.style.left,
    inlineTop: m && m.style.top,
    count: document.querySelectorAll('.modal').length,
  });
})()`);

/* ── 1. Drag the title bar ─────────────────────────────────────────────── */
await openDialog();
await sleep(700);                       // let the entrance animation settle
let a = await rects();
check('the dialog opened', !!a && a.count === 1, JSON.stringify(a && { count: a.count }));
check('the dialog starts centred by the backdrop grid', !!a && a.position !== 'fixed', a && `position=${a.position}`);

const DX = 140, DY = 100;
await drag(a.head, { x: a.head.x + DX, y: a.head.y + DY });
await sleep(250);
let b = await rects();
const movedX = b.modal.l - a.modal.l;
const movedY = b.modal.t - a.modal.t;
check('dragging the title bar moves the dialog horizontally', Math.abs(movedX - DX) <= 3, `dx=${Math.round(movedX)} want ${DX}`);
check('dragging the title bar moves the dialog vertically', Math.abs(movedY - DY) <= 3, `dy=${Math.round(movedY)} want ${DY}`);
check('the dialog is detached from the grid (fixed position)', b.position === 'fixed', `position=${b.position}`);
check('the dialog keeps an explicit left/top', !!b.inlineLeft && !!b.inlineTop, `${b.inlineLeft}, ${b.inlineTop}`);
check('the dialog is still fully on screen',
  b.modal.l >= 0 && b.modal.t >= 0 && b.modal.r <= (await ev('innerWidth')) && b.modal.b <= (await ev('innerHeight')),
  JSON.stringify({ l: Math.round(b.modal.l), t: Math.round(b.modal.t), r: Math.round(b.modal.r), b: Math.round(b.modal.b) }));

/* ── 2. The close X still closes (and is not a handle) ─────────────────── */
const beforeX = b;
await drag(b.close, { x: b.close.x + 90, y: b.close.y + 70 });
await sleep(250);
let c = await rects();
check('a press that starts on the close X does not move the dialog',
  !!c && Math.abs(c.modal.l - beforeX.modal.l) < 1 && Math.abs(c.modal.t - beforeX.modal.t) < 1,
  JSON.stringify({ was: Math.round(beforeX.modal.l), now: c && Math.round(c.modal.l) }));
check('the dialog is still open after a drag that began on the X', !!c && c.count === 1);

await click(c.close.x, c.close.y);
await sleep(350);
const closed = await rects();
check('the close X still closes the dialog', !closed || closed.count === 0, JSON.stringify(closed && { count: closed.count }));

/* ── 3. A second dialog: the buttons still work after a drag ───────────── */
await openDialog();
await sleep(600);
let d = await rects();
await drag(d.head, { x: d.head.x - 60, y: d.head.y + 40 });
await sleep(200);
let e = await rects();
check('a second dialog drags independently', !!e && Math.abs((e.modal.l - d.modal.l) + 60) <= 3,
  e ? `dx=${Math.round(e.modal.l - d.modal.l)} want -60` : 'no dialog');
// Click the primary "Edit" button where it now sits.
const editBtn = await evJson(`(function(){
  const btns = Array.from(document.querySelectorAll('.modal-foot button'));
  const b = btns.find((x) => /edit/i.test(x.textContent || '')) || btns[btns.length - 1];
  const r = b && b.getBoundingClientRect();
  return JSON.stringify(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
})()`);
await click(editBtn.x, editBtn.y);
await sleep(350);
const afterOk = await rects();
check('the primary button still resolves the dialog after a drag', !afterOk || afterOk.count === 0,
  JSON.stringify(afterOk && { count: afterOk.count }));

/* ── 4. The REAL "Edit text" dialog, opened the way a user opens it ─────── */
// The reported case is not a synthetic dialog: it is the ask modal that a
// block click produces. Prove THAT one drags too.
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(1200);
const armed = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('#ribbon .rbtn'))
    .find(function(x){ return /^direct editor$/i.test((x.getAttribute('aria-label') || x.title || '').trim()); });
  if (b) b.click();
  return !!b;
})()`);
check('the Direct Editor can be armed', armed === true);

let blockPt = null;
for (let i = 0; i < 60 && !blockPt; i++) {
  blockPt = await evJson(`(function(){
    var t = Array.from(document.querySelectorAll('.editable-text-block')).find(function(el){
      var r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    });
    if (!t) return null;
    var r = t.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
  })()`);
  if (!blockPt) await sleep(300);
}
check('a text block is clickable on the fixture', !!blockPt, JSON.stringify(blockPt));

if (blockPt) {
  await click(blockPt.x, blockPt.y);
  await sleep(800);
  check('the real "Edit text" dialog opened', (await ev(`!!document.querySelector('.de-ask-text')`)) === true);
  const realBefore = await rects();
  await drag(realBefore.head, { x: realBefore.head.x + 120, y: realBefore.head.y + 80 });
  await sleep(250);
  const realAfter = await rects();
  check('the real "Edit text" dialog can be dragged',
    !!realAfter
      && Math.abs((realAfter.modal.l - realBefore.modal.l) - 120) <= 3
      && Math.abs((realAfter.modal.t - realBefore.modal.t) - 80) <= 3,
    realAfter ? `dx=${Math.round(realAfter.modal.l - realBefore.modal.l)} dy=${Math.round(realAfter.modal.t - realBefore.modal.t)}` : 'no dialog');
  // Cancel so the run leaves no edit behind.
  const cancelPt = await evJson(`(function(){
    var b = Array.from(document.querySelectorAll('.modal-foot button')).find(function(x){ return /cancel/i.test(x.textContent || ''); });
    var r = b && b.getBoundingClientRect();
    return JSON.stringify(r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
  })()`);
  if (cancelPt) { await click(cancelPt.x, cancelPt.y); await sleep(300); }
}

check('no console errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
clearTimeout(bail);
console.log(problems ? `DRAG_FAIL ${problems} problem(s)` : 'DRAG_PASS all checks green');
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
