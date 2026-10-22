#!/usr/bin/env node
/**
 * Live verification that the Edit image tool is a marquee tool.
 *
 * The contract: with Edit image armed, a DRAG draws a marquee, the image
 * placement inside that marquee is detected, and the detected object is fully
 * movable — drag it anywhere, resize it from a corner. A press that never
 * moves must stay an ordinary click (that gesture is covered by
 * image-tool-test.mjs and must not regress), and a marquee over empty space
 * must clear the selection.
 *
 * Asserted against the real app over CDP: hit testing, zoom-independent
 * coordinate conversion and re-render only exist on screen.
 *
 *   node scripts/image-marquee-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.smoke', 'image-marquee-fixture.pdf');
const PORT = 9517;
// A per-run temp user-data dir: a fixed dir under .smoke/ grows past the
// bulk-delete guard and then refuses to start on the second run.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-marquee-'));

/* 1. Fixture: two placed copies of assets/icon.png on a 400x300 page.
 *    A = [40,180]-[160,270] (120x90pt), B = [240,40]-[340,120] (100x80pt). */
{
  const { PDFDocument } = require('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const img = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')));
  page.drawImage(img, { x: 40, y: 180, width: 120, height: 90 });
  page.drawImage(img, { x: 240, y: 40, width: 100, height: 80 });
  fs.writeFileSync(FIXTURE, await doc.save());
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stderr.on('data', () => {}); child.stdout.on('data', () => {});
setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 180000).unref?.();

const target = await (async () => {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!target) { console.log('FAIL no target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0; const pending = new Map(); const errs = [];
const send = (method, params) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 220));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 220));
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r || r.exceptionDetails) { console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 400)); return undefined; }
  return r.result ? r.result.value : undefined;
}
let problems = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); if (!ok) problems++; };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: type === 'mouseMoved' ? 1 : undefined, ...extra });

for (let i = 0; i < 80; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2000);

await ev(`window.__it = {
  async vp(i) {
    const { activeDoc } = await import('/js/store.js');
    const p = await activeDoc().pdf.getPage(i + 1);
    const d = activeDoc();
    const rot = (p.rotate || 0) + ((d.pageRotate || {})[i] || 0);
    return p.getViewport({ scale: 1, rotation: rot });
  },
  async point(i, x, y) {
    const v = await this.vp(i);
    const cv = document.querySelector('.page[data-i="' + i + '"] canvas.pdf');
    const r = cv.getBoundingClientRect();
    const q = v.convertToViewportPoint(x, y);
    return { x: r.left + (q[0] / v.width) * r.width, y: r.top + (q[1] / v.height) * r.height };
  },
  async bounds() {
    const { activeDoc } = await import('/js/store.js');
    const { openNativeImagePage, closeNativeImageSession } = await import('/js/image-pdf-browser.mjs');
    const s = await openNativeImagePage(activeDoc().bytes, 0);
    const out = s.images.map(function (im) { return { name: im.name, bounds: im.bounds, matrix: im.matrix, clipped: im.clipped }; });
    closeNativeImageSession(s);
    return out;
  },
  box() {
    var b = document.querySelector('.img-edit-box');
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top, handles: document.querySelectorAll('.img-handle').length, toolbar: !!document.querySelector('.img-toolbar') };
  }
}; 'ok'`);

const ppp = await ev(`(function(){ var cv = document.querySelector('.page[data-i="0"] canvas.pdf'); return cv.getBoundingClientRect().width / 400; })()`);
/* The page re-lays out after boot (a toast appears, the panel reflows), so a
 * screen position is only meaningful once the layout has settled. */
const rectOf = () => ev(`(function(){ var cv=document.querySelector('.page[data-i="0"] canvas.pdf'); if(!cv) return ''; var r=cv.getBoundingClientRect(); return [r.left,r.top,r.width,r.height].join(','); })()`);
async function settle() {
  let last = null, same = 0;
  for (let i = 0; i < 40; i++) {
    const now = await rectOf();
    same = (now && now === last) ? same + 1 : 0;
    if (same >= 3) return true;
    last = now;
    await sleep(200);
  }
  return false;
}
/** Screen positions of PDF points, taken from one settled layout. */
async function pointsAt(list) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await settle();
    const before = await rectOf();
    const pts = JSON.parse(await ev(`Promise.all([${list.map(([x, y]) => `__it.point(0, ${x}, ${y})`).join(',')}]).then(a => JSON.stringify(a))`));
    if ((await rectOf()) !== before) continue;
    return pts;
  }
  return JSON.parse(await ev(`Promise.all([${list.map(([x, y]) => `__it.point(0, ${x}, ${y})`).join(',')}]).then(a => JSON.stringify(a))`));
}
const pt = async (x, y) => (await pointsAt([[x, y]]))[0];
const boxOf = async () => JSON.parse((await ev(`JSON.stringify(__it.box())`)) || 'null');
const waitBox = async (want = true, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const b = await boxOf();
    if (!!b === want) return b;
    await sleep(250);
  }
  return await boxOf();
};
async function marquee(a, b) {
  await mouse('mousePressed', a.x, a.y);
  await sleep(60);
  for (let s = 1; s <= 6; s++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * s) / 6, a.y + ((b.y - a.y) * s) / 6);
    await sleep(35);
  }
  await mouse('mouseReleased', b.x, b.y);
}
async function dragBy(from, dx, dy) {
  await mouse('mousePressed', from.x, from.y);
  await sleep(60);
  for (let s = 1; s <= 5; s++) { await mouse('mouseMoved', from.x + (dx * s) / 5, from.y + (dy * s) / 5); await sleep(40); }
  await mouse('mouseReleased', from.x + dx, from.y + dy);
}

/* 2. Arm the tool. */
await ev(`(function(){ var b = document.querySelector('#ribbon button[aria-label="Edit object"]'); if (b) b.click(); return !!b; })()`);
await sleep(400);
check('Edit object tool is armed', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editImage')()`));

/* 3. Marquee around B, starting from empty page — no click ever lands on it.
 *    Start (230,132) and end (346,34): neither corner is inside any image. */
const [m1a, m1b] = await pointsAt([[230, 132], [346, 34]]);
await marquee(m1a, m1b);
const b1 = await waitBox(true);
console.log('MARQUEE_BOX', JSON.stringify(b1), 'ppp', ppp);
check('a marquee detects the image inside it', !!b1, b1 ? `${Math.round(b1.w)}x${Math.round(b1.h)}px` : 'no box');
check('the detected object is image B (100x80pt)', !!b1 && Math.abs(b1.w - 100 * ppp) < 10 && Math.abs(b1.h - 80 * ppp) < 10,
  b1 ? `${Math.round(b1.w)}x${Math.round(b1.h)}px vs ${Math.round(100 * ppp)}x${Math.round(80 * ppp)}px` : '');
check('detected object is fully movable (move + 4 resize handles + toolbar)', !!b1 && b1.handles === 4 && b1.toolbar, b1 ? `handles=${b1.handles} toolbar=${b1.toolbar}` : '');

/* 4. Drag the detected object: +20pt right, +10pt up. */
const center = { x: b1.left + b1.w / 2, y: b1.top + b1.h / 2 };
await dragBy(center, 20 * ppp, -10 * ppp);
await sleep(2500);
let moved = null;
for (let i = 0; i < 20; i++) {
  const all = JSON.parse((await ev(`__it.bounds().then(JSON.stringify)`)) || '[]');
  const hit = all.find((x) => Math.abs(x.bounds[0] - 260) < 5 && Math.abs(x.bounds[1] - 50) < 5);
  if (hit) { moved = all; break; }
  await sleep(300);
}
console.log('AFTER_MOVE', JSON.stringify(moved));
check('dragging moves the detected object', !!moved, JSON.stringify((moved || []).map((x) => x.bounds)));

/* 5. A press that never moves still selects by point (the old gesture). */
const c1 = await pt(100, 225);
console.log('CLICK5', JSON.stringify({ c1, rect: await rectOf(), at: await ev(`(function(){ var e=document.elementFromPoint(${Math.round(c1.x)},${Math.round(c1.y)}); return e?e.tagName+'.'+(e.getAttribute('class')||''):'null'; })()`) }));
await mouse('mousePressed', c1.x, c1.y);
await sleep(40);
await mouse('mouseReleased', c1.x, c1.y);
const b2 = await waitBox(true);
check('clicking an image still selects it', !!b2, b2 ? `${Math.round(b2.w)}x${Math.round(b2.h)}px` : 'no box');
check('the click selected image A (120x90pt)', !!b2 && Math.abs(b2.w - 120 * ppp) < 10 && Math.abs(b2.h - 90 * ppp) < 10,
  b2 ? `${Math.round(b2.w)}x${Math.round(b2.h)}px` : '');

/* 6. A marquee over empty space clears the selection. */
const [e1, e2] = await pointsAt([[10, 25], [30, 20]]);
await marquee(e1, e2);
check('a marquee over empty space clears the selection', !(await waitBox(false, 20)));

/* 7. A marquee round both images picks the best match (the larger one). */
const [f1, f2] = await pointsAt([[30, 285], [370, 30]]);
await marquee(f1, f2);
const b3 = await waitBox(true);
console.log('BOTH_BOX', JSON.stringify(b3));
check('a marquee round both images selects one of them', !!b3, b3 ? `${Math.round(b3.w)}x${Math.round(b3.h)}px` : 'no box');
check('it picks the best-covered placement (A, 120x90pt)', !!b3 && Math.abs(b3.w - 120 * ppp) < 10 && Math.abs(b3.h - 90 * ppp) < 10,
  b3 ? `${Math.round(b3.w)}x${Math.round(b3.h)}px vs ${Math.round(120 * ppp)}x${Math.round(90 * ppp)}px` : '');

console.log('ERRORS', JSON.stringify(errs));
console.log(problems ? `TEST_FAIL ${problems} problem(s)` : 'TEST_PASS all checks green');
ws.close(); child.kill();
process.exit(problems ? 1 : 0);
