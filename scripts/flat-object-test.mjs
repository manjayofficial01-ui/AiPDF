#!/usr/bin/env node
/**
 * Live verification of the Edit Object tool on a page that LOOKS flat.
 *
 * The contract:
 *  - a click picks the TOP-MOST object under the pointer (the PDF paints the
 *    last object over the earlier ones, so that is the one the reader sees);
 *  - an object drawn inside a Form XObject is selectable and reports its
 *    page coordinates;
 *  - a page with no image objects says so, instead of failing silently;
 *  - a page that is one full-page bitmap says THAT, because the picture
 *    inside a bitmap is not a separate object.
 *
 * Hit testing and the messages only exist on screen, so this runs against the
 * real app over CDP.
 *
 *   node scripts/flat-object-test.mjs
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
const FIXTURE = path.join(ROOT, '.smoke', 'flat-object-fixture.pdf');
const PORT = 9519;
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-flat-'));

/* 1. Fixture — page 1: a background image, a smaller image on top of it, and
 *    a logo drawn inside a Form XObject. Page 2: text only, no objects. */
{
  const { PDFDocument, PDFName } = require('@cantoo/pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const big = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')));
  const small = await doc.embedPng(fs.readFileSync(path.join(ROOT, 'assets', 'icon.png')));
  page.drawImage(big, { x: 20, y: 20, width: 260, height: 200 });      // background
  page.drawImage(small, { x: 100, y: 80, width: 80, height: 60 });      // painted later, on top
  // A logo inside a Form XObject: the page draws the form, the form draws
  // the image, and the image is still one selectable object.
  const formDict = doc.context.obj({
    Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1],
    Resources: doc.context.obj({ XObject: doc.context.obj({ Im0: small.ref }) }),
  });
  formDict.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(Buffer.from('q 1 0 0 1 0 0 cm\n/Im0 Do\nQ\n', 'latin1'))));
  const formRef = doc.context.register(formDict);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: doc.context.obj({ Fm0: formRef }) }));
  const content = 'q 60 0 0 45 300 230 cm\n/Fm0 Do\nQ\n';
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(Buffer.from(content, 'latin1'))));
  // The other objects have to survive the hand-written content stream.
  page.node.set(PDFName.of('Resources'), doc.context.obj({
    XObject: doc.context.obj({ Fm0: formRef, ImBig: big.ref, ImSmall: small.ref }),
  }));
  const mixed = 'q 260 0 0 200 20 20 cm\n/ImBig Do\nQ\nq 80 0 0 60 100 80 cm\n/ImSmall Do\nQ\nq 60 0 0 45 300 230 cm\n/Fm0 Do\nQ\n';
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(Buffer.from(mixed, 'latin1'))));
  const textPage = doc.addPage([400, 300]);
  textPage.drawText('No objects on this page', { x: 40, y: 150, size: 14 });
  // A page that is ONE bitmap: the picture inside it is not an object.
  const rasterPage = doc.addPage([400, 300]);
  rasterPage.drawImage(big, { x: 0, y: 0, width: 400, height: 300 });
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
const mouse = (type, x, y, modifiers = 0) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: type === 'mouseMoved' ? 1 : undefined, modifiers });

for (let i = 0; i < 80; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 1`)) break; await sleep(300); }
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
  async objects(i) {
    const { activeDoc } = await import('/js/store.js');
    const { openNativeImagePage, closeNativeImageSession } = await import('/js/image-pdf-browser.mjs');
    const s = await openNativeImagePage(activeDoc().bytes, i);
    const out = s.objects.map(function (o) { return { kind: o.kind, name: o.name, bounds: o.bounds, order: o.order, container: o.container }; });
    closeNativeImageSession(s);
    return out;
  },
  box() {
    var b = document.querySelector('.img-edit-box');
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top, tip: b.getAttribute('data-tip') || b.getAttribute('title') || '' };
  },
  toasts() { return [...document.querySelectorAll('.toast')].map(function (t) { return t.textContent; }); }
}; 'ok'`);

const objects = JSON.parse(await ev(`__it.objects(0).then(JSON.stringify)`) || '[]');
console.log('OBJECTS', JSON.stringify(objects));
check('the page reports four objects', objects.length === 4, JSON.stringify(objects.map((o) => o.kind)));
check('the form is one of them', objects.some((o) => o.kind === 'form'));
check('the image inside the form is one of them', objects.some((o) => o.kind === 'image' && o.container.length === 1));

/* Arm the tool. */
await ev(`(function(){ var b = document.querySelector('#ribbon button[aria-label="Edit object"]'); if (b) b.click(); return !!b; })()`);
await sleep(500);
check('Edit object tool is armed', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editImage')()`));

const ppp = await ev(`(function(){ var cv = document.querySelector('.page[data-i="0"] canvas.pdf'); return cv.getBoundingClientRect().width / 400; })()`);
const pt = async (x, y) => JSON.parse(await ev(`__it.point(0, ${x}, ${y}).then(JSON.stringify)`));
const boxOf = async () => JSON.parse((await ev(`JSON.stringify(__it.box())`)) || 'null');
const waitBox = async (want = true, tries = 40) => {
  for (let i = 0; i < tries; i++) { const b = await boxOf(); if (!!b === want) return b; await sleep(250); }
  return await boxOf();
};
/** The page can be re-laid out (a toast appears, the sidebar reflows), so the
 *  screen position of a PDF point is only stable once the layout settles. */
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
async function click(x, y, modifiers = 0) {
  for (let attempt = 0; attempt < 6; attempt++) {
    await settle();
    const before = await rectOf();
    const p = await pt(x, y);
    if ((await rectOf()) !== before) continue;      // the layout moved; try again
    await mouse('mousePressed', p.x, p.y, modifiers);
    await sleep(50);
    await mouse('mouseReleased', p.x, p.y, modifiers);
    return;
  }
}

/* 1. A click where two objects overlap picks the one painted LAST. */
await click(140, 110);            // inside the small image, which is over the big one
const overlapped = await waitBox(true);
console.log('OVERLAP_BOX', JSON.stringify(overlapped));
check('the overlapping click selects an object', !!overlapped);
check('it selects the object painted on top (80x60pt), not the one underneath',
  !!overlapped && Math.abs(overlapped.w - 80 * ppp) < 10 && Math.abs(overlapped.h - 60 * ppp) < 10,
  overlapped ? `${Math.round(overlapped.w)}x${Math.round(overlapped.h)}px vs ${Math.round(80 * ppp)}x${Math.round(60 * ppp)}px` : 'no box');

/* 2. The logo inside the Form XObject is selectable, in page coordinates. */
await click(330, 252);            // centre of the form's image
const nested = await waitBox(true);
console.log('NESTED_BOX', JSON.stringify(nested));
check('the object inside the form is selectable', !!nested);
check('it is reported at its page position (60x45pt)',
  !!nested && Math.abs(nested.w - 60 * ppp) < 10 && Math.abs(nested.h - 45 * ppp) < 10,
  nested ? `${Math.round(nested.w)}x${Math.round(nested.h)}px vs ${Math.round(60 * ppp)}x${Math.round(45 * ppp)}px` : 'no box');
check('the toolbar says the object lives in a form',
  await ev(`(function(){ var n=document.querySelector('.img-crop-note'); return !!n && /form/i.test(n.textContent); })()`),
  'the note names the container');

/* 3. Alt+click steps down to the group that contains it. */
await click(330, 252, 1);         // Alt = modifiers 1
const group = await waitBox(true);
console.log('GROUP_BOX', JSON.stringify(group));
check('alt+click selects the enclosing group', !!group && /group/i.test(group.tip || ''), group ? group.tip : 'no box');
check('a group offers no crop', await ev(`(function(){ var b=[...document.querySelectorAll('.img-toolbar button')].map(function(x){return x.textContent;}); return b.indexOf('Crop')<0 && b.indexOf('Replace')<0; })()`));

/* 4. A page with no image objects says so. */
await ev(`(function(){ var p=document.querySelector('.page[data-i="1"]'); if(p) p.scrollIntoView(); return !!p; })()`);
await sleep(600);
const p2 = JSON.parse(await ev(`__it.point(1, 200, 150).then(JSON.stringify)`));
await mouse('mousePressed', p2.x, p2.y);
await sleep(50);
await mouse('mouseReleased', p2.x, p2.y);
await sleep(500);
const toasts = await ev(`__it.toasts()`) || [];
console.log('TOASTS', JSON.stringify(toasts));
check('an object-free page explains itself', toasts.some((t) => /no image objects/i.test(t)), JSON.stringify(toasts));

/* 5. A page that is one bitmap says THAT — the picture inside a bitmap is
 *    not an object, and pretending otherwise would be a lie. */
await ev(`(function(){ var p=document.querySelector('.page[data-i="2"]'); if(p) p.scrollIntoView(); return !!p; })()`);
await sleep(600);
const p3 = JSON.parse(await ev(`__it.point(2, 200, 150).then(JSON.stringify)`));
await mouse('mousePressed', p3.x, p3.y);
await sleep(50);
await mouse('mouseReleased', p3.x, p3.y);
await sleep(800);
console.log('RASTER_BOX', JSON.stringify(await boxOf()));
console.log('RASTER_TOOLBAR', await ev(`(function(){ var n=document.querySelector('.img-crop-note'); return n?n.textContent:null; })()`));
check('a full-page bitmap is named as one',
  await ev(`(function(){ var n=document.querySelector('.img-crop-note'); return !!n && /page image/i.test(n.textContent); })()`),
  await ev(`(function(){ var n=document.querySelector('.img-crop-note'); return n?n.textContent:null; })()`));
check('the whole page is selected as one object', await ev(`(function(){ var b=document.querySelector('.img-edit-box'); if(!b) return false; var r=b.getBoundingClientRect(); var cv=document.querySelector('.page[data-i="2"] canvas.pdf').getBoundingClientRect(); return Math.abs(r.width-cv.width)<12 && Math.abs(r.height-cv.height)<12; })()`));

console.log('ERRORS', JSON.stringify(errs));
console.log(problems ? `TEST_FAIL ${problems} problem(s)` : 'TEST_PASS all checks green');
ws.close(); child.kill();
process.exit(problems ? 1 : 0);
