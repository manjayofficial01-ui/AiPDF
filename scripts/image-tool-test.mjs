#!/usr/bin/env node
/* Live verification of the Edit Image tool: select a placed image, move it,
 * resize from a corner, rotate, fade and delete, then re-read the committed
 * bytes with the native adapter.
 *
 *   node scripts/image-tool-test.mjs
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
const FIXTURE = path.join(ROOT, '.smoke', 'image-fixture.pdf');
const PORT = 9510;
// A per-run temp user-data dir. A fixed dir under .smoke/ grows past the
// bulk-delete guard, and then this suite cannot even start a second time.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-imagetool-'));

/* 1. Fixture: two placed copies of assets/icon.png on a 400x300 page. */
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
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: type === 'mouseMoved' ? 'left' : 'left', clickCount: 1, buttons: type === 'mouseMoved' ? 1 : undefined, ...extra });

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
  }
}; 'ok'`);

const before = await ev(`__it.bounds().then(JSON.stringify)`);
console.log('IMAGES_BEFORE', before);
check('fixture has two image placements', JSON.parse(before || '[]').length === 2, before);

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

/* 2. Arm the tool and click the first image. */
await ev(`(function(){ var b = document.querySelector('#ribbon button[aria-label="Edit object"]'); if (b) b.click(); return b ? 'clicked' : 'none'; })()`);
await sleep(300);
check('Edit object tool is in the ribbon', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editImage' && !!document.querySelector('#ribbon button[aria-label="Edit object"]'))()`));

const [p1] = await pointsAt([[100, 225]]);
await mouse('mousePressed', p1.x, p1.y);
await sleep(40);
await mouse('mouseReleased', p1.x, p1.y);
let box = null;
for (let i = 0; i < 40; i++) { await sleep(250); box = await ev(`(function(){ var b = document.querySelector('.img-edit-box'); var t = document.querySelector('.img-toolbar'); return b ? JSON.stringify({ box: b.getBoundingClientRect(), toolbar: !!t, title: b.title }) : null; })()`); if (box) break; }
console.log('SELECTED', box);
const b0 = box ? JSON.parse(box) : null;
check('clicking an image selects it', !!b0 && b0.toolbar, box || 'no box');
check('selection box covers the image', b0 && b0.box.width > 40 && b0.box.height > 30, b0 ? `${Math.round(b0.box.width)}x${Math.round(b0.box.height)}` : '');

/* 3. Drag to move (+20pt x, +10pt y in PDF space). */
async function dragScreen(from, dx, dy) {
  await mouse('mousePressed', from.x, from.y);
  await sleep(50);
  for (let s = 1; s <= 5; s++) { await mouse('mouseMoved', from.x + (dx * s) / 5, from.y + (dy * s) / 5); await sleep(40); }
  await mouse('mouseReleased', from.x + dx, from.y + dy);
}
const scale = JSON.parse(await ev(`(function(){ var cv = document.querySelector('.page[data-i="0"] canvas.pdf'); return JSON.stringify({ w: cv.getBoundingClientRect().width }); })()`));
const ppp = scale.w / 400;               // CSS px per PDF point (page is 400pt wide)
const center = { x: b0.box.left + b0.box.width / 2, y: b0.box.top + b0.box.height / 2 };
await dragScreen(center, 20 * ppp, -10 * ppp);   // right 20pt, up 10pt => dy +10
await sleep(2500);
let moved = null;
for (let i = 0; i < 20; i++) {
  await sleep(300);
  const b = JSON.parse(await ev(`__it.bounds().then(JSON.stringify)`) || '[]');
  const img = b.find((x) => Math.abs(x.bounds[0] - 60) < 4 && Math.abs(x.bounds[1] - 190) < 4);
  if (img) { moved = b; break; }
}
console.log('AFTER_MOVE', JSON.stringify(moved));
const mi = (moved || []).find((x) => x.bounds[0] > 50 && x.bounds[1] > 185);
check('drag moves the placement ~20,10 pt', !!mi, JSON.stringify((moved || []).map((x) => x.bounds)));

/* 4. Resize from the SE handle. */
const handle = JSON.parse(await ev(`(function(){ var h = document.querySelector('.img-handle-se'); if (!h) return null; var r = h.getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width/2, y: r.top + r.height/2 }); })()`) || 'null');
let resized = null;
if (handle) {
  await dragScreen(handle, 25 * ppp, 15 * ppp);   // right + down (PDF height grows downward = -y)
  await sleep(2500);
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const b = JSON.parse(await ev(`__it.bounds().then(JSON.stringify)`) || '[]');
    const img = b.find((x) => (x.bounds[2] - x.bounds[0]) > 136 && (x.bounds[3] - x.bounds[1]) > 100);
    if (img) { resized = b; break; }
  }
}
console.log('AFTER_RESIZE', JSON.stringify(resized));
check('corner drag resizes the placement', !!resized, JSON.stringify((resized || []).map((x) => x.bounds)));

/* 5. Rotate right 90° from the toolbar. */
const boxNow = JSON.parse(await ev(`(function(){ var b = document.querySelector('.img-edit-box'); return b ? JSON.stringify({ w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }) : null; })()`) || 'null');
await ev(`(function(){ var b = [...document.querySelectorAll('.img-toolbar button')].find(function(x){ return /Rotate right/.test(x.title); }); if (b) b.click(); return b ? 'ok' : 'none'; })()`);
await sleep(2500);
const rot = JSON.parse(await ev(`__it.bounds().then(JSON.stringify)`) || '[]');
const rotated = rot.find((x) => Math.abs(x.matrix[1]) > 1 || Math.abs(x.matrix[2]) > 1);
const boxAfter = JSON.parse(await ev(`(function(){ var b = document.querySelector('.img-edit-box'); return b ? JSON.stringify({ w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }) : null; })()`) || 'null');
console.log('AFTER_ROTATE', JSON.stringify(rotated), boxNow, boxAfter);
check('rotate 90° rewrites the placement matrix', !!rotated);
check('selection box follows the rotation', !!boxNow && !!boxAfter && boxAfter.w < boxNow.w, boxNow && boxAfter ? `${Math.round(boxNow.w)}x${Math.round(boxNow.h)} -> ${Math.round(boxAfter.w)}x${Math.round(boxAfter.h)}` : '');

/* 6. Opacity 50%. */
await ev(`(function(){ var s = document.querySelector('.img-toolbar select'); if (!s) return 'none'; s.value = '50'; s.dispatchEvent(new Event('change')); return 'ok'; })()`);
await sleep(2500);
check('opacity change commits without error', await ev(`!!document.querySelector('.img-edit-box')`));

/* 7. Delete. */
await ev(`(function(){ var b = [...document.querySelectorAll('.img-toolbar button')].find(function(x){ return /Delete/.test(x.textContent); }); if (b) b.click(); return b ? 'ok' : 'none'; })()`);
await sleep(3000);
const afterDelete = JSON.parse(await ev(`__it.bounds().then(JSON.stringify)`) || '[]');
console.log('AFTER_DELETE', JSON.stringify(afterDelete));
check('delete removes one placement', afterDelete.length === 1, `${afterDelete.length} left`);
check('selection cleared after delete', !(await ev(`!!document.querySelector('.img-edit-box')`)));

/* 8. Crop the second image down to its left half. */
const [p2] = await pointsAt([[290, 80]]);
await mouse('mousePressed', p2.x, p2.y);
await sleep(40);
await mouse('mouseReleased', p2.x, p2.y);
for (let i = 0; i < 30; i++) { await sleep(250); if (await ev(`!!document.querySelector('.img-edit-box')`)) break; }
const cropBtn = await ev(`(function(){ var b = [...document.querySelectorAll('.img-toolbar button')].find(function(x){ return /^Crop$/.test(x.textContent); }); if (b) b.click(); return b ? 'ok' : 'none'; })()`);
check('crop button is available', cropBtn === 'ok', String(cropBtn));
await sleep(300);
const [ca, cbpt] = await pointsAt([[240, 40], [290, 120]]);
await mouse('mousePressed', ca.x, ca.y);
await sleep(50);
for (let s = 1; s <= 5; s++) { await mouse('mouseMoved', ca.x + ((cbpt.x - ca.x) * s) / 5, ca.y + ((cbpt.y - ca.y) * s) / 5); await sleep(40); }
await mouse('mouseReleased', cbpt.x, cbpt.y);
await sleep(500);
const appliedCrop = await ev(`(function(){ var b = [...document.querySelectorAll('.img-crop-bar button')].find(function(x){ return /Apply crop/.test(x.textContent); }); if (b) b.click(); return b ? 'ok' : 'none'; })()`);
check('crop confirm bar appears', appliedCrop === 'ok', String(appliedCrop));
await sleep(3000);
const croppedList = JSON.parse(await ev(`__it.bounds().then(JSON.stringify)`) || '[]');
console.log('AFTER_CROP', JSON.stringify(croppedList));
check('crop commits a clipped placement', croppedList.some((x) => x.clipped), JSON.stringify(croppedList));
const cropBox = JSON.parse(await ev(`(function(){ var b = document.querySelector('.img-edit-box'); return b ? JSON.stringify({ w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, handles: document.querySelectorAll('.img-handle').length }) : null; })()`) || 'null');
console.log('CROP_BOX', JSON.stringify(cropBox));
check('cropped selection covers the kept half', !!cropBox && Math.abs(cropBox.w - 50 * ppp) < 8,
  cropBox ? `${Math.round(cropBox.w)}px vs ${Math.round(50 * ppp)}px` : 'no box');

/* 9. A cropped placement offers delete only — the adapter refuses further
 *    native edits once the Do invocation carries a clip. */
await sleep(400);
const [p3] = await pointsAt([[245, 80]]);
await mouse('mousePressed', p3.x, p3.y);
await sleep(40);
await mouse('mouseReleased', p3.x, p3.y);
for (let i = 0; i < 30; i++) { await sleep(250); if (await ev(`!!document.querySelector('.img-edit-box')`)) break; }
console.log('CROPPED_UI', await ev(`(function(){
  var bar = document.querySelector('.img-toolbar');
  return JSON.stringify({
    box: !!document.querySelector('.img-edit-box'),
    handles: document.querySelectorAll('.img-handle').length,
    note: (document.querySelector('.img-crop-note') || {}).textContent || null,
    buttons: bar ? [...bar.querySelectorAll('button')].map(function(b){ return b.textContent; }) : [],
  });
})()`));
check('cropped image has no resize handles', (await ev(`document.querySelectorAll('.img-handle').length`)) === 0);
check('cropped image offers delete only', await ev(`(function(){ var bar = document.querySelector('.img-toolbar'); if (!bar) return false; var labels = [...bar.querySelectorAll('button')].map(function(b){ return b.textContent; }); return labels.length === 1 && labels[0] === 'Delete'; })()`));

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) fs.writeFileSync(path.join(ROOT, '.smoke', 'image-tool.png'), Buffer.from(shot.data, 'base64'));
console.log('ERRORS', JSON.stringify(errs));
console.log(problems ? `TEST_FAIL ${problems} problem(s)` : 'TEST_PASS all checks green');
ws.close(); child.kill();
process.exit(problems ? 1 : 0);