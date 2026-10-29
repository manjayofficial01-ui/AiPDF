#!/usr/bin/env node
/**
 * Area Direct Edit must read ONLY the marquee.
 *
 * The bug this locks down: a drag over part of a scanned page recognised the
 * WHOLE page and then kept every block that merely intersected the rectangle —
 * so a full row of text running past the box became editable as one unit, and
 * words the user never selected were dragged into the edit.
 *
 * The contract now:
 *   - the page render is CROPPED to the marquee before the engine sees it;
 *   - the region read is stored apart from doc.ocr[page] (that record means
 *     "the whole page was read" and feeds search, AI and the saved layer);
 *   - the area therefore yields FEWER lines than the page, and every editable
 *     block lies inside the rectangle the user drew.
 *
 * Measured on the real scan fixture against the real engine — no mocks: the
 * crop, the viewport mapping and the block geometry only exist in the app.
 *
 *   node scripts/area-region-ocr-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'scan.pdf');
const PAGE = 0;

if (!fs.existsSync(FIXTURE)) { console.log('AREA_OCR_FAIL missing fixture ' + FIXTURE); process.exit(1); }
if (!fs.existsSync(ELECTRON)) { console.log('AREA_OCR_FAIL missing electron ' + ELECTRON); process.exit(1); }

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
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-area-ocr-ud-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 300000);
bail.unref?.();

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!target) await sleep(400);
}
if (!target) { console.log('AREA_OCR_FAIL no renderer target'); child.kill(); process.exit(1); }

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
  if (!r || r.exceptionDetails) {
    console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 400));
    return undefined;
  }
  return r.result ? r.result.value : undefined;
}
const evJson = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch { return null; } };

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1,
  buttons: type === 'mouseMoved' ? 1 : undefined,
});

for (let i = 0; i < 120; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2000);
await ev(`document.querySelector('#emptyWorkspace')?.classList.add('hidden')`);

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
  async source(i) {
    const te = await import('/js/textedit.js');
    const s = await te.editableSource(i);
    return { source: s.source, blocks: s.blocks.map(function (b) { return { text: b.text, r: b.coverRect }; }) };
  },
  async state() {
    const { activeDoc } = await import('/js/store.js');
    const d = activeDoc();
    const keys = Object.keys(d.ocrRegions || {});
    return {
      keys: keys,
      regionLines: keys.length ? ((d.ocrRegions[keys[0]].lines || []).length) : 0,
      regionRect: keys.length ? d.ocrRegions[keys[0]].rect : null,
      pageLines: (d.ocr && d.ocr[${PAGE}] && d.ocr[${PAGE}].lines || []).length,
      pageText: (d.ocr && d.ocr[${PAGE}] && d.ocr[${PAGE}].text || '').slice(0, 120),
      dom: document.querySelectorAll('.editable-text-block').length,
    };
  }
}; 'ok'`);

/* ── 0. The fixture really is a scan ─────────────────────────────────────── */
const noText = await ev(`(async function(){ const v = await import('/js/viewer.js'); const tc = await v.getTextContent(${PAGE}); return !tc || !tc.items.some(function(it){ return it.str && it.str.trim(); }); })()`);
check('the fixture page has no native text (it must be recognised)', noText === true);

/* ── 1. Whole-page baseline ──────────────────────────────────────────────── */
await ev(`(function(){ var b = Array.from(document.querySelectorAll('#ribbon .rbtn')).find(function(x){ return /^direct editor$/i.test((x.getAttribute('aria-label') || x.title || '').trim()); }); if (b) b.click(); return !!b; })()`);
await sleep(1200);
check('the Direct Editor is armed', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editText')()`));

const base = await evJson(`(async function(){
  const te = await import('/js/textedit.js');
  const r = await te.recognizePageForEditing(${PAGE}, { langs: 'eng' });
  return JSON.stringify({ ok: r.ok, blocks: r.blocks, src: await te.editableSource(${PAGE}).then(function(s){ return { source: s.source, blocks: s.blocks.map(function(b){ return { text: b.text, r: b.coverRect }; }) }; }) });
})()`);
const baseline = base?.src?.blocks || [];
console.log('BASELINE', JSON.stringify({ ok: base?.ok, blocks: baseline.length }));
check('whole-page recognition produced editable blocks', baseline.length >= 4, `blocks=${baseline.length}`);
if (baseline.length < 4) { console.log('AREA_OCR_FAIL not enough baseline blocks'); ws.close(); child.kill(); process.exit(1); }

const baseState = await evJson('(async () => JSON.stringify(await __it.state()))()');
const basePageText = baseState?.pageText;

/* ── 2. Draw a box over TWO lines in the middle of the page ──────────────── */
const withY = baseline.map((b) => ({ text: b.text, r: b.r, cy: (b.r[1] + b.r[3]) / 2 }))
  .sort((a, b) => b.cy - a.cy);                      // top first
const lo = 1;
const hi = Math.min(2, withY.length - 2);            // a band, never the whole page
const band = withY.slice(lo, hi + 1);
const REGION = [
  Math.min(...band.map((b) => b.r[0])) - 1,
  Math.min(...band.map((b) => b.r[1])) - 1,
  Math.max(...band.map((b) => b.r[2])) + 1,
  Math.max(...band.map((b) => b.r[3])) + 1,
];
const centreInside = (r, box) => {
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
};
console.log('REGION', JSON.stringify(REGION.map((v) => Math.round(v * 10) / 10)), 'band', JSON.stringify(band.map((b) => b.text.slice(0, 40))));

/* ── 3. Arm Area Direct Edit and drag that box ───────────────────────────── */
const armed = await ev(`(function(){ var b = Array.from(document.querySelectorAll('#ribbon .rbtn')).find(function(x){ return /area direct edit/i.test((x.getAttribute('aria-label') || x.title || '')); }); if (b) b.click(); return !!b; })()`);
check('the Area Direct Edit tool can be armed', armed === true);
await sleep(600);
check('Area Direct Edit is the active tool', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editArea')()`));

await ev(`(async () => { const v = await import('/js/viewer.js'); v.setZoom('fitPage'); return 'ok'; })()`);
await sleep(1600);
const a = await evJson(`__it.point(${PAGE}, ${REGION[0]}, ${REGION[3]}).then(JSON.stringify)`);
const b = await evJson(`__it.point(${PAGE}, ${REGION[2]}, ${REGION[1]}).then(JSON.stringify)`);
const win = await evJson(`JSON.stringify({ w: innerWidth, h: innerHeight })`);
const onScreen = (p) => p && p.x >= 0 && p.x < win.w && p.y >= 0 && p.y < win.h;
check('the marquee drag is fully on screen', onScreen(a) && onScreen(b),
  `a=(${Math.round(a?.x)},${Math.round(a?.y)}) b=(${Math.round(b?.x)},${Math.round(b?.y)}) in ${win.w}x${win.h}`);

await mouse('mouseMoved', a.x, a.y);
await mouse('mousePressed', a.x, a.y);
await sleep(80);
for (let s = 1; s <= 8; s++) {
  await mouse('mouseMoved', a.x + ((b.x - a.x) * s) / 8, a.y + ((b.y - a.y) * s) / 8);
  await sleep(40);
}
await mouse('mouseReleased', b.x, b.y);

let regionState = null;
for (let i = 0; i < 200; i++) {
  regionState = await evJson('(async () => JSON.stringify(await __it.state()))()');
  if (regionState && regionState.keys.length > 0) break;
  await sleep(400);
}
const after = await evJson(`(async () => JSON.stringify(await __it.source(${PAGE})))()`);
const area = after?.blocks || [];
console.log('AREA', JSON.stringify({ region: regionState?.regionRect, lines: regionState?.regionLines, blocks: area.map((x) => x.text.slice(0, 40)) }));

/* The rectangle the app itself recorded — the drag's corners are whole screen
 * pixels, so it differs from the requested box by up to a point. Every
 * assertion below is against what was actually drawn, not what was asked for. */
const drawn = await evJson(`(async () => JSON.stringify((await import('/js/store.js')).state.editRegion))()`);
const BOX = drawn?.rect || REGION;
const expected = baseline.filter((b) => centreInside(b.r, BOX)).length;
const outsideTexts = baseline.filter((b) => !centreInside(b.r, BOX))
  .map((b) => String(b.text || '').replace(/\s+/g, ' ').trim().toLowerCase())
  .filter((t) => t.length > 2);
console.log('DRAWN', JSON.stringify(BOX.map((v) => Math.round(v * 10) / 10)), 'expected≈', expected);

/* ── 4. What the area must be ────────────────────────────────────────────── */
check('the marquee created a region record of its own', (regionState?.keys || []).length === 1,
  JSON.stringify(regionState?.keys));
check('the whole-page record was NOT overwritten by the area read',
  regionState?.pageText === basePageText && regionState?.pageLines === baseState?.pageLines,
  `pageLines ${baseState?.pageLines} -> ${regionState?.pageLines}`);
check('the area read produced fewer lines than the whole page',
  regionState?.regionLines > 0 && regionState?.regionLines < regionState?.pageLines,
  `area=${regionState?.regionLines} page=${regionState?.pageLines}`);
check('the region record keeps the rectangle it was read for',
  Array.isArray(regionState?.regionRect) && regionState.regionRect.every((v, k) => Math.abs(v - BOX[k]) < 0.05),
  JSON.stringify(regionState?.regionRect?.map((v) => Math.round(v * 10) / 10)));
check('only the text under the marquee is editable',
  area.length >= 1 && area.length < baseline.length,
  `area=${area.length} page=${baseline.length}`);
check('the area holds what the page really has in that box',
  Math.abs(area.length - expected) <= 2,
  `area=${area.length} expected≈${expected}`);
const strays = area.filter((x) => !centreInside(x.r, BOX));
check('every editable block lies inside the drawn rectangle', strays.length === 0,
  strays.length ? JSON.stringify(strays.map((x) => ({ t: x.text.slice(0, 30), r: x.r.map((v) => Math.round(v)) }))) : '');
const poached = area.filter((x) => outsideTexts.includes(String(x.text || '').replace(/\s+/g, ' ').trim().toLowerCase()));
check('no text from outside the box was dragged into the area', poached.length === 0,
  poached.length ? JSON.stringify(poached.map((x) => x.text.slice(0, 40))) : '');
check('the on-screen hit targets match the area blocks', regionState?.dom === area.length,
  `dom=${regionState?.dom} blocks=${area.length}`);
check('the Direct Editor took over after the marquee', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editText')()`));

/* ── 5. Re-dragging the same box reuses the read ─────────────────────────── */
const again = await evJson(`(async function(){
  const te = await import('/js/textedit.js');
  const st = await import('/js/store.js');
  const r = await te.recognizeRegionForEditing(${PAGE}, ${JSON.stringify(BOX)});
  return JSON.stringify({ ok: r.ok, blocks: r.blocks, keys: Object.keys(st.activeDoc().ocrRegions || {}).length });
})()`);
check('recognising the same area again reuses the cached read', again?.keys === 1 && again?.blocks === area.length,
  JSON.stringify(again));

/* ── 6. A box over PART of a row must not take the row whole ─────────────── */
const widest = baseline.slice().sort((x, y) => (y.r[2] - y.r[0]) - (x.r[2] - x.r[0]))[0];
const PART = [
  widest.r[0] - 1, widest.r[1] - 1,
  widest.r[0] + (widest.r[2] - widest.r[0]) * 0.4, widest.r[3] + 1,
];
const rowWords = String(widest.text || '').replace(/\s+/g, ' ').trim().split(' ')
  .filter((w) => w.length >= 4 && /[a-z0-9]/i.test(w));
const outsideWord = rowWords.length ? rowWords[rowWords.length - 1] : null;
console.log('PART', JSON.stringify(PART.map((v) => Math.round(v * 10) / 10)),
  'row', JSON.stringify(String(widest.text).slice(0, 60)), 'outsideWord', outsideWord);

await ev(`(function(){ var b = Array.from(document.querySelectorAll('#ribbon .rbtn')).find(function(x){ return /area direct edit/i.test((x.getAttribute('aria-label') || x.title || '')); }); if (b) b.click(); return !!b; })()`);
await sleep(600);
const c1 = await evJson(`__it.point(${PAGE}, ${PART[0]}, ${PART[3]}).then(JSON.stringify)`);
const c2 = await evJson(`__it.point(${PAGE}, ${PART[2]}, ${PART[1]}).then(JSON.stringify)`);
await mouse('mouseMoved', c1.x, c1.y);
await mouse('mousePressed', c1.x, c1.y);
await sleep(80);
for (let s = 1; s <= 8; s++) {
  await mouse('mouseMoved', c1.x + ((c2.x - c1.x) * s) / 8, c1.y + ((c2.y - c1.y) * s) / 8);
  await sleep(40);
}
await mouse('mouseReleased', c2.x, c2.y);

let partState = null;
for (let i = 0; i < 200; i++) {
  partState = await evJson('(async () => JSON.stringify(await __it.state()))()');
  if (partState && partState.keys.length >= 2) break;
  await sleep(400);
}
const drawn2 = await evJson(`(async () => JSON.stringify((await import('/js/store.js')).state.editRegion))()`);
const BOX2 = drawn2?.rect || PART;
const after2 = await evJson(`(async () => JSON.stringify(await __it.source(${PAGE})))()`);
const area2 = after2?.blocks || [];
console.log('PART_AREA', JSON.stringify(area2.map((x) => x.text.slice(0, 40))));
check('a box over part of a row is read on its own', (partState?.keys || []).length === 2,
  JSON.stringify(partState?.keys));
check('a partial box still finds the text inside it', area2.length >= 1, `blocks=${area2.length}`);
const overhang = area2.filter((x) => x.r[2] > BOX2[2] + 1);
check('nothing to the RIGHT of the box edge is recognised', overhang.length === 0,
  overhang.length ? JSON.stringify(overhang.map((x) => ({ t: x.text.slice(0, 30), right: Math.round(x.r[2]), edge: Math.round(BOX2[2]) }))) : '');
check('a partial box never makes the whole row editable',
  !area2.some((x) => String(x.text || '').replace(/\s+/g, ' ').trim() === String(widest.text || '').replace(/\s+/g, ' ').trim()),
  JSON.stringify(area2.map((x) => String(x.text).slice(0, 40))));
if (outsideWord) {
  check(`a word that sits outside the box ("${outsideWord}") is not recognised`,
    !area2.some((x) => String(x.text || '').toLowerCase().includes(outsideWord.toLowerCase())),
    JSON.stringify(area2.map((x) => String(x.text).slice(0, 40))));
}

check('no console errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
clearTimeout(bail);
console.log(problems ? `AREA_OCR_FAIL ${problems} problem(s)` : 'AREA_OCR_PASS all checks green');
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
