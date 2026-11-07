#!/usr/bin/env node
/**
 * THE acceptance test for the reported bug, on the reported file:
 * "D:\Advertisement\ad\Ok\3\Sunmoon Media 4x12 Gorakha sadak yojana.pdf"
 * (a scanned Nepali tender sheet: a 2×5 ruled table, 10 cells, only 4 of
 * which used to become editable blocks).
 *
 * Boots the real app with that file, runs the Direct Editor's recognition
 * (OCR — the page has no native text), then inspects the editable block list
 * through the same editableSource() the Direct Editor consumes:
 *   - many independent blocks in the table zone (not the old 3-4 row blocks)
 *   - no editable block spans most of the table width any more
 *   - the recognised cell texts are present (GRP no., works description,
 *     builder, bid amount)
 *
 *   node scripts/table-real-ocr-live.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from "node:os";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FILE = 'D:\\Advertisement\\ad\\Ok\\3\\Sunmoon Media 4x12 Gorakha sadak yojana.pdf';
const OUT = path.join(ROOT, '.smoke');
const PORT = 9427;
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(FILE)) { console.log('OCR_TABLE_FAIL real file missing: ' + FILE); process.exit(1); }

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// Own userData: never fights the single-instance lock of a real open window,
// same recipe scripts/ocr-test.mjs uses.
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-table-real-ocr-live-ud-"));
const child = spawn(ELECTRON, ['.', FILE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env: childEnv });
child.stderr.on('data', () => {});
// Watchdog: OCR has 4 minutes; nothing here should exceed 7 minutes total.
setTimeout(() => { console.log('OCR_TABLE_FAIL global watchdog (7 min)'); try { child.kill(); } catch {} process.exit(2); }, 420000).unref?.();
const __log = (...a) => console.log(new Date().toISOString().slice(17, 23), ...a);

const target = await (async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!target) { console.log('OCR_TABLE_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression, tag = '') => {
  let timedOut = false;
  const res = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(25000).then(() => { timedOut = true; return null; }),
  ]);
  if (timedOut) { console.log(`STUCK evaluate ${tag}`); return null; }
  return res && res.result ? res.result.value : undefined;
};

for (let i = 0; i < 70; i++) {
  if (await ev('!!window.__aipdfBooted')) break;
  await sleep(300);
}
await sleep(2200);
__log('booted, doc pages: ' + await ev('window.__aipdfState.docs[0]?.numPages'));
for (let i = 0; i < 40; i++) {
  if ((await ev('window.__aipdfState.docs[0]?.numPages || 0')) > 0) break;
  await sleep(500);
}
__log('doc pages: ' + await ev('window.__aipdfState.docs[0]?.numPages'));

/* Run the Direct Editor's recognition through the same hook the headless OCR
 * gate uses (ocrPage on page 1, default language — the table's key cells are
 * English). Poll progress; first run may fetch the language data. */
__log('running OCR…');
const ocrRun = ev(`window.__aipdfRunOcrTest ? window.__aipdfRunOcrTest() : null`, 'ocrRun');
let ocrResult = null;
for (let i = 0; i < 60; i++) {
  ocrResult = await Promise.race([Promise.resolve(ocrRun).catch((e) => ({ execError: e.message })), sleep(5000).then(() => null)]);
  if (ocrResult) break;
  const prog = await ev('JSON.stringify((window.__aipdfOcrProgress || []).slice(-3))', 'prog');
  __log('OCR_WAIT ' + (i + 1) * 5 + 's ' + prog);
}
__log('ocr result: ' + JSON.stringify(ocrResult).slice(0, 200));
const ocrLines = (await ev('window.__aipdfState.docs[0]?.ocr?.[0]?.lines?.length || 0')) || 0;
__log('ocr lines: ' + ocrLines);

const src = await ev(`window.__aipdfEditableSource(0)`, 'editableSource');
const blocks = src?.blocks || [];
console.log(`editable blocks: ${blocks.length} (source=${src?.source})`);
for (const b of blocks) {
  const r = (b.ownRect || b.coverRect || []).map((x) => Math.round(x));
  console.log(`  x[${r[0]},${r[2]}] y[${r[1]},${r[3]}] "${String(b.text || '').replace(/\s+/g, ' ').slice(0, 58)}"`);
}

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};

const pageW = await ev(`window.__aipdfState.docs[0]?.pageSizes?.[0]?.w || 454`);
const pageH = await ev(`window.__aipdfState.docs[0]?.pageSizes?.[0]?.h || 340`);
check('recognition produced editable blocks', blocks.length > 0, `source=${src?.source}, blocks=${blocks.length}`);
check('the scan took the OCR path with detected table split', src?.source === 'ocr' || native > 0, `source=${src?.source}`);

/* The tender table occupies the bottom band of the page (y 31..110 of 340);
 * the body paragraphs above it legitimately span the full width. */
const tableBlocks = blocks.filter((b) => {
  const r = b.ownRect || b.coverRect || [0, 0, 0, 0];
  return ((r[1] + r[3]) / 2) < pageH * 0.34; // PDF space: smaller y = lower on page
});
check('the table zone has many independent blocks (was 3-4)', tableBlocks.length >= 6, `${tableBlocks.length}`);

/* No block may span most of the table width any more — the old bug merged
 * whole rows into one wide block. */
const wide = tableBlocks.filter((b) => {
  const r = b.ownRect || b.coverRect || [0, 0, 0, 0];
  return (r[2] - r[0]) > pageW * 0.55;
});
check('no table block spans most of the table width', wide.length === 0,
  JSON.stringify(wide.map((b) => String(b.text || '').slice(0, 30))));

/* Distinct column starts — cells sit at clearly different x offsets. */
const starts = [...new Set(tableBlocks.map((b) => Math.round((b.ownRect || b.coverRect)[0] / 12)))];
check('cells start at several distinct columns (≥3)', starts.length >= 3, `${starts.length} clusters: ${starts.join(',')}`);

/* Recognised cell content survives as separate blocks. */
const all = (frag) => blocks.some((b) => String(b.text || '').replace(/\s+/g, ' ').toLowerCase().includes(frag));
check('key cell texts present (bid no. / works / builder / amount)',
  (all('33701119') || all('grp')) && (all('upgrading') || all('blacktop')) && (all('mandali') || all('builders')) && (all('522,961') || all('18,522')),
  JSON.stringify(blocks.map((b) => String(b.text || '').replace(/\s+/g, ' ').slice(0, 20))));

/* Zoom stability — the offset bug: blocks must re-render at the new scale and
 * stay glued to the text. Arm the Direct Editor first (block overlays only
 * exist in editText tool), compare each block's position RELATIVE to the page
 * rectangle before and after zooming: the relative layout must not move more
 * than ~1% of the page. */
await ev(`window.__aipdfAction('tool:editText')`);
await sleep(2000);
const before = await ev(`(function(){
  const pg = document.querySelector('#pages .page').getBoundingClientRect();
  const blocks = [...document.querySelectorAll('.editable-text-block')];
  return JSON.stringify({ pageW: pg.width, pageH: pg.height, pageL: pg.left, pageT: pg.top,
    blocks: blocks.map((b) => { const r = b.getBoundingClientRect(); return { l: +( (r.left - pg.left) / pg.width ).toFixed(4), t: +(( r.top - pg.top ) / pg.height ).toFixed(4) }; }) });
})()`);
await ev(`window.__aipdfAction('view:zoomIn')`);
await sleep(900);
await ev(`window.__aipdfAction('view:zoomIn')`);
await sleep(1200);
const after = await ev(`(function(){
  const pg = document.querySelector('#pages .page').getBoundingClientRect();
  const blocks = [...document.querySelectorAll('.editable-text-block')];
  return JSON.stringify({ pageW: pg.width, pageH: pg.height, pageL: pg.left, pageT: pg.top,
    blocks: blocks.map((b) => { const r = b.getBoundingClientRect(); return { l: +( (r.left - pg.left) / pg.width ).toFixed(4), t: +(( r.top - pg.top ) / pg.height ).toFixed(4) }; }) });
})()`);
const B = JSON.parse(before || '{}'), A = JSON.parse(after || '{}');
check('zoom changes the page scale (the test zoomed)', A.pageW > B.pageW * 1.15, `${B.pageW} -> ${A.pageW}`);
let maxDrift = 0;
if (B.blocks && A.blocks && B.blocks.length === A.blocks.length) {
  for (let i = 0; i < B.blocks.length; i++) {
    maxDrift = Math.max(maxDrift, Math.abs(B.blocks[i].l - A.blocks[i].l), Math.abs(B.blocks[i].t - A.blocks[i].t));
  }
}
check('blocks keep their page-relative position across zoom (max drift ≤ 1%)',
  B.blocks && A.blocks && B.blocks.length === A.blocks.length && maxDrift <= 0.01,
  `blocks ${B.blocks?.length}/${A.blocks?.length}, maxDrift ${maxDrift.toFixed(4)}`);

/* ── Marquee area select — "edit this region only" ──────────────────────── */
/* The Direct Editor panel's Select-area button: drag a rectangle over the
 * bottom-right of the page (amount cell + remarks) — only the blocks inside
 * it remain editable, and the region outline is drawn. */
const armBtn = await ev(`(function(){
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Select area');
  if (b) { b.click(); return true; }
  return false;
})()`);
await sleep(400);
check('Select area button present in the Direct Editor panel', armBtn === true);

const pageRect = await ev(`(function(){
  const r = document.querySelector('#pages .page').getBoundingClientRect();
  return { l: r.left, t: r.top, w: r.width, h: r.height };
})()`);
const page = { l: pageRect.l, t: pageRect.t, w: pageRect.w, h: pageRect.h };
const dragM = async (x0, y0, x1, y1) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  const steps = 8;
  for (let s = 1; s <= steps; s++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left',
      x: Math.round(x0 + ((x1 - x0) * s) / steps),
      y: Math.round(y0 + ((y1 - y0) * s) / steps),
    });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left' });
  await sleep(400);
};
const mq = {
  x0: Math.round(page.l + page.w * 0.5), y0: Math.round(page.t + page.h * 0.68),
  x1: Math.round(page.l + page.w * 0.98), y1: Math.round(page.t + page.h * 0.93),
};
await dragM(mq.x0, mq.y0, mq.x1, mq.y1);
await sleep(600);
const mqState = await ev(`(function(){
  const pg = document.querySelector('#pages .page').getBoundingClientRect();
  const blocks = [...document.querySelectorAll('.editable-text-block')].map((b) => {
    const r = b.getBoundingClientRect();
    return { l: (r.left - pg.left) / pg.width, t: (r.top - pg.top) / pg.height, r: (r.right - pg.left) / pg.width, b: (r.bottom - pg.top) / pg.height };
  });
  const box = document.querySelector('.edit-region-box');
  return JSON.stringify({ n: blocks.length, blocks, outline: !!box, region: window.__aipdfState.editRegion, pagePt: window.__aipdfState.docs[0]?.pageSizes?.[0] });
})()`);
const M = JSON.parse(mqState || '{}');
check('marquee limits the editable blocks to the selected region (3–9 blocks, was 16)',
  M.n >= 3 && M.n <= 9, `${M.n}: ${JSON.stringify((M.blocks || []).length)}`);
check('every remaining block intersects the marquee area',
  (M.blocks || []).every((b) => b.l < 0.98 && b.r > 0.5 && b.t < 0.93 && b.b > 0.68),
  JSON.stringify(M.blocks));
check('the active region outline is drawn', M.outline === true);

/* Clear area → the full block list returns. */
await ev(`(function(){
  const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Clear area');
  if (b) b.click();
})()`);
await sleep(600);
const afterClearN = await ev(`document.querySelectorAll('.editable-text-block').length`);
check('Clear area restores all blocks', afterClearN === 16, `${afterClearN}`);

/* ── The Area Direct Edit TOOL (ribbon icon next to Direct Editor) ───────── */
/* Arming the tool and dragging the marquee must filter the same way, then
 * hand off to the Direct Editor so the region's cells are clickable. */
await ev(`window.__aipdfAction('tool:editArea')`);
await sleep(400);
check('Area Direct Edit tool arms', (await ev(`window.__aipdfState.tool === 'editArea'`)) === true);
const mq2 = {
  x0: Math.round(page.l + page.w * 0.04), y0: Math.round(page.t + page.h * 0.66),
  x1: Math.round(page.l + page.w * 0.45), y1: Math.round(page.t + page.h * 0.93),
};
await dragM(mq2.x0, mq2.y0, mq2.x1, mq2.y1);
await sleep(800);
const toolAfter = await ev(`window.__aipdfState.tool`);
const n2 = await ev(`document.querySelectorAll('.editable-text-block').length`);
check('tool marquee filters blocks and hands off to the Direct Editor',
  toolAfter === 'editText' && n2 >= 2 && n2 <= 8, `tool=${toolAfter}, blocks=${n2}`);

/* Visual proof: arm the Direct Editor and screenshot the block overlays. */
await ev(`window.__aipdfAction('tool:editText')`, 'editText');
await sleep(2500);
await send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  if (r?.data) fs.writeFileSync(path.join(OUT, 'table-real-ocr.png'), Buffer.from(r.data, 'base64'));
});

console.log(problems ? `\nOCR_TABLE_FAIL ${problems} problem(s)` : `\nOCR_TABLE_PASS all checks green`);
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
