#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Crop Pages live verification:
 *  1. the crop dialog's stage canvas actually renders the page (non-blank,
 *     screenshot saved as pixel proof);
 *  2. dragging a box + "Crop this page" commits a CropBox (pageSizes change,
 *     crops entry present).
 *
 *   node scripts/crop-preview-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from "node:os";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9477;
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-crop-preview-test-ud-"));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env: childEnv });
child.stderr.on('data', () => {});
child.stdout.on('data', () => {});
setTimeout(() => { console.log('TEST_TIMEOUT watchdog'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 180000).unref?.();

const target = await (async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!target) { console.log('TEST_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expression) {
  let r;
  try {
    r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  } catch (e) { console.log('EV_ERR', String(e.message).slice(0, 120)); return undefined; }
  if (!r || r.exceptionDetails) { console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 300)); return undefined; }
  return r.result ? r.result.value : undefined;
}

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};

for (let i = 0; i < 70; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
console.log('BOOTED');
for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
console.log('PAGES_READY');
await sleep(2000);
await ev(`(function(){
  window.__errs = [];
  window.addEventListener('error', function(e){ window.__errs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function(e){ window.__errs.push('REJ ' + String(e.reason)); });
  return 'ok';
})()`);

const before = await ev(`import('/js/store.js').then(function(m){
  var d = m.activeDoc(); var s = d.pageSizes[0];
  return JSON.stringify({ w: Math.round(s.w), h: Math.round(s.h) });
})`);

/* Open the dialog and wait for the stage to paint.
 * NOTE: fire-and-forget — page:crop resolves only when the modal closes, so
 * awaiting it here would deadlock the CDP evaluate. After it opens, wait a
 * moment so renderPageToCanvas (async) can finish blitting the page into
 * the stage canvas. */
await ev(`(function(){ window.__aipdfAction('page:crop'); return 'fired'; })()`);
console.log('CROP_FIRED');
let opened = false;
for (let i = 0; i < 30; i++) {
  await sleep(200);
  const t = await ev(`(function(){
    var ms = [...document.querySelectorAll('.modal-head')];
    return ms.some(function(h){ return (h.textContent || '').includes('Crop Pages'); });
  })()`);
  if (t) { opened = true; break; }
}
check('crop dialog opens', opened);
await sleep(1200);   // let renderPageToCanvas finish painting into the stage

/* Read back the stage canvas. A coarse grid is not safe here: the fixture's
 * ink covers ~2.4% of the page, and a 9x9 downsample aliases it away entirely
 * (measured: every cell 255), so scan the canvas at full resolution instead. */
const inkOf = `(function(){
  var body = document.querySelector('.modal-body');
  if (!body) return JSON.stringify({ err: 'no modal-body' });
  var cv = body.querySelector('canvas');
  if (!cv) return JSON.stringify({ err: 'no canvas in crop dialog' });
  var r = cv.getBoundingClientRect();
  if (!(r.width > 50 && r.height > 50)) return JSON.stringify({ err: 'bad rect', w: r.width, h: r.height });
  var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  var dark = 0;
  for (var k = 0; k < d.length; k += 4) {
    if ((d[k] + d[k + 1] + d[k + 2]) / 3 < 200) dark++;
  }
  return JSON.stringify({ dark: dark, w: cv.width, h: cv.height, cssW: Math.round(r.width), cssH: Math.round(r.height) });
})()`;
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) fs.writeFileSync(path.join(ROOT, '.smoke', 'crop-paint.png'), Buffer.from(shot.data, 'base64'));
// Poll for up to ~5s: renderPageToCanvas blits async after the modal opens.
let pv = null;
for (let k = 0; k < 25; k++) {
  await sleep(200);
  pv = await ev(inkOf);
  if (pv) { try { pv = JSON.parse(pv); if (!pv.err && pv.dark > 0) break; } catch {} }
}
console.log('STAGE_INK', pv, 'screenshot:', !!shot?.data);
check('crop stage paints the page (ink present)', pv && !pv.err && pv.dark > 0,
  pv || 'no data');

/* Drag a box over the middle of the stage, then commit. */
const stageBox = await ev(`(function(){
  var cv = document.querySelector('.modal-body canvas');
  if (!cv) return null;
  var r = cv.getBoundingClientRect();
  return JSON.stringify({ l: r.left, t: r.top, w: r.width, h: r.height });
})()`);
console.log('STAGE_BOX', stageBox);
const sb = stageBox ? JSON.parse(stageBox) : null;
let dragSize = null;
if (sb) {
  const fx = Math.round(sb.l + sb.w * 0.3), fy = Math.round(sb.t + sb.h * 0.3);
  const tx = Math.round(sb.l + sb.w * 0.8), ty = Math.round(sb.t + sb.h * 0.7);
  dragSize = { w: tx - fx, h: ty - fy };
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1 });
  await sleep(60);
  for (let s = 1; s <= 5; s++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left',
      x: Math.round(fx + ((tx - fx) * s) / 5),
      y: Math.round(fy + ((ty - fy) * s) / 5),
    });
    await sleep(40);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left' });
  await sleep(400);
  console.log('SELBOX', await ev(`(function(){
    var body = document.querySelector('.modal-body');
    var bxs = body ? [...body.querySelectorAll('div')].filter(function(d){ return d.style.display === 'block' && d.style.width && parseFloat(d.style.width) > 5; }) : [];
    return JSON.stringify(bxs.map(function(d){ return { x: d.style.left, y: d.style.top, w: d.style.width, h: d.style.height }; }));
  })()`));
  /* Click the primary button (Crop this page). */
  await ev(`(function(){
    var btns = [...document.querySelectorAll('.modal-foot button')];
    var ok = btns.find(function(x){ return /crop this page/i.test(x.textContent || ''); });
    if (ok) ok.click();
    return ok ? 'clicked' : 'no-button';
  })()`);
  await sleep(2500);
}

const after = await ev(`import('/js/store.js').then(function(m){
  var d = m.activeDoc(); var s = d.pageSizes[0];
  return d.pdf.getPage(1).then(function(p){
    return JSON.stringify({ w: Math.round(s.w), h: Math.round(s.h), view: p.view });
  });
})`);
console.log('BEFORE', before, 'AFTER', after);
const cb = after ? JSON.parse(after) : {}, bb = before ? JSON.parse(before) : {};
/* The crop lands in the file as the page's CropBox (pdf.js exposes the
 * resulting view box as page.view). doc.crops is only the build-time map, and
 * commitStructure reloads the doc (clearing it), so read the committed page. */
const expW = dragSize && bb.w ? (dragSize.w / sb.w) * bb.w : 0;
const expH = dragSize && bb.h ? (dragSize.h / sb.h) * bb.h : 0;
const sizeOk = cb.w > 0 && Math.abs(cb.w - expW) <= 6 && Math.abs(cb.h - expH) <= 6;
check('crop commits a CropBox matching the dragged box', Array.isArray(cb.view) && sizeOk,
  `box=${Math.round(expW)}x${Math.round(expH)} page=${cb.w}x${cb.h} view=${JSON.stringify(cb.view)}`);
console.log('PAGE_ERRORS', await ev(`JSON.stringify(window.__errs || [])`));

console.log(problems ? `TEST_FAIL ${problems} problem(s)` : 'TEST_PASS all checks green');
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
