#!/usr/bin/env node
/**
 * Integration test for the Documents menu tools (Compare / Overlay / Scale /
 * Remove Blank Pages / Adjust Colors).
 *
 * These run inside the real app over CDP because every one of them is a
 * renderer feature: an IPC file read, a modal, a rebuild. A pure-Node test
 * cannot prove the wiring; this one drives the actual dispatch path.
 *
 *   node scripts/doctools-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from "node:os";
import { fileURLToPath } from 'node:url';
import { PDFDocument as PdfLibDoc, StandardFonts, rgb } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'doctools.pdf');
const OTHER = path.join(ROOT, '.fixtures', 'doctools-other.pdf');
const PORT = 9481;
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-doctools-test-ud-"));
const OUT = path.join(ROOT, '.smoke', 'doctools-out.pdf');

/* The app serves standard-font metrics from /v/stdfonts/ (see viewer.js). This
   test runs in plain Node, so point pdf.js at the same files on disk — without
   it, every page that names a non-embedded Type1 font logs an
   UnknownErrorException and its text may read back empty. */
const STD_FONT_DATA_URL = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;

/* pdf.js rejects Node Buffers outright — they are Uint8Array subclasses, which
   is exactly why the check trips. Copy into a plain Uint8Array instead. */
const toBytes = (data) => (data instanceof Uint8Array && data.constructor === Uint8Array
  ? data
  : Uint8Array.from(data));

const openPdf = (data) => pdfjs.getDocument({
  data: toBytes(data),
  useSystemFonts: false,
  standardFontDataUrl: STD_FONT_DATA_URL,
}).promise;

const pageTexts = async (pdf) => {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push(tc.items.map((x) => x.str).join(' '));
  }
  return out;
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/* ── fixtures ──────────────────────────────────────────────────────────── */

async function fixtureA() {
  const doc = await PdfLibDoc.create();
  // A font must be embedded from the document it is used in, or pdf-lib emits
  // a page whose text is not readable back.
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([400, 400]);
    if (i < 2) p.drawText(`Fixture A page ${i + 1}`, { x: 40, y: 340, size: 18, font, color: rgb(0, 0, 0) });
    if (i === 1) p.drawText('LINE THREE', { x: 40, y: 40, size: 14, font, color: rgb(0, 0, 0) });
    // Page 3 is left empty on purpose: the Remove Blank Pages test needs one.
  }
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, await doc.save());
}

async function fixtureB() {
  const doc = await PdfLibDoc.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([400, 400]);
    p.drawText(`Fixture A page ${i + 1}`, { x: 40, y: 340, size: 18, font, color: rgb(0, 0, 0) });
    if (i === 1) p.drawText('LINE THREE EDITED', { x: 40, y: 40, size: 14, font, color: rgb(0, 0, 0) });
    if (i === 2) {
      p.drawRectangle({ x: 50, y: 300, width: 300, height: 60, color: rgb(0.2, 0.2, 0.2) });
      p.drawText('OVERLAYED STAMP', { x: 60, y: 320, size: 20, font, color: rgb(1, 1, 1) });
    }
  }
  fs.mkdirSync(path.dirname(OTHER), { recursive: true });
  fs.writeFileSync(OTHER, await doc.save());
}

await fixtureA();
await fixtureB();

/* ── drive the app ─────────────────────────────────────────────────────── */

const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!page) await sleep(400);
}
if (!page) { console.log('DOCTOOLS_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

for (let i = 0; i < 60; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev('document.querySelectorAll("#pages .page").length > 0')) break; await sleep(300); }
await sleep(2000);

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/* 1. Compare: diff the live document's text against fixture B's text. */
const bTexts = await (async () => {
  const pdf = await openPdf(fs.readFileSync(OTHER));
  const out = await pageTexts(pdf);
  pdf.destroy();
  return out;
})();

const cmp = await ev(`(async function(){
  var c = await import('/js/compare.js');
  var v = await import('/js/viewer.js');
  var a = [];
  for (var i = 0; i < 3; i++) a.push(await v.getPageText(i));
  var r = c.buildComparison(a, ${JSON.stringify(bTexts)});
  return { changed: r.summary.changed, added: r.summary.added, removed: r.summary.removed,
           perPage: r.pages.map(function(p){ return p.changed; }) };
})()`);
/* Page 1 is identical in both fixtures. Page 2 edits LINE THREE, and page 3
   goes from blank (A) to the OVERLAYED STAMP block (B) — so both 2 and 3 must
   be flagged. Asserting all three would let a "flag everything" implementation
   pass; asserting only page 2 would let a "detect added text" gap pass. */
check('compare flags only the genuinely different pages',
  cmp && cmp.changed === 2 && cmp.perPage[0] === false && cmp.perPage[1] === true && cmp.perPage[2] === true,
  `changed=${cmp && cmp.changed} perPage=${JSON.stringify(cmp && cmp.perPage)}`);
check('compare reports both added and removed lines',
  cmp && cmp.added >= 1 && cmp.removed >= 1, `+${cmp && cmp.added} -${cmp && cmp.removed}`);

/* 2. Compare UI wiring: the modules the dialog uses are reachable. */
const compareUi = await ev(`(async function(){
  var mod = await import('/js/docxtools.js');
  var c = await import('/js/compare.js');
  return { parsers: typeof mod.parsePageRange, jump: typeof c.jumpToPage, report: typeof c.comparisonReport };
})()`);
check('compare UI dependencies are reachable',
  compareUi && compareUi.parsers === 'function' && compareUi.jump === 'function' && compareUi.report === 'function');

/* 3. Overlay end-to-end through buildPdf on the live document. */
const overlay = await ev(`(async function(){
  var st = await import('/js/store.js');
  var pw = await import('/js/pdfwrite.js');
  var d = st.activeDoc();
  d.overlay = null;
  var r = await window.api.readFile(${JSON.stringify(OTHER)});
  if (!r.ok) return { ok: false, err: 'read' };
  // Page index 2 of the other document carries the stamp, so it must land on
  // every page of this document.
  d.overlay = { bytes: r.data, pages: [2], x: 0, y: 0, scale: 1, opacity: 1, fit: false };
  var bytes = await pw.buildPdf(d, {});
  await window.api.writeFile(${JSON.stringify(OUT)}, bytes);
  return { ok: true, bytes: bytes.length };
})()`);
check('overlay rebuilds the document', overlay && overlay.ok, `bytes=${overlay && overlay.bytes}`);

if (overlay && overlay.ok) {
  const saved = new Uint8Array(fs.readFileSync(OUT));
  const pdf = await openPdf(saved);
  const texts = await pageTexts(pdf);
  pdf.destroy();
  check('overlay page lands on every page',
    texts.every((t) => /OVERLAYED STAMP/.test(t)), `${texts.filter((t) => /OVERLAYED STAMP/.test(t)).length}/${texts.length}`);
  check('original document text survives the overlay',
    texts.slice(0, 2).every((t) => /Fixture A page/.test(t)), texts.slice(0, 2).join(' / '));
}

/* 4. Scale: the op-model mutator, then buildPdf honours the new op types. */
const scaled = await ev(`(async function(){
  var st = await import('/js/store.js');
  var pw = await import('/js/pdfwrite.js');
  var d = st.activeDoc();
  d.overlay = null; d.pageOps = null;      // reset the overlay from step 3
  var mod = await import('/js/docxtools.js');
  var n = mod.scalePages(d, 0.5);
  var bytes = await pw.buildPdf(d, {});
  await window.api.writeFile(${JSON.stringify(OUT)}, bytes);
  return { scaled: n, bytes: bytes.length };
})()`);
check('scalePages wraps the op list', scaled && scaled.scaled === 3, `scaled=${scaled && scaled.scaled}`);

if (scaled && scaled.ok !== false) {
  const pdf = await openPdf(fs.readFileSync(OUT));
  const p1 = await pdf.getPage(1);
  const vp = p1.getViewport({ scale: 1 });
  pdf.destroy();
  check('scaled output is half the original size', Math.abs(vp.width - 200) < 1.5 && Math.abs(vp.height - 200) < 1.5,
    `page=${Math.round(vp.width)}x${Math.round(vp.height)}`);
}

/* 5. Remove blank pages: page 3 of the fixture is a blank draw. */
const blanks = await ev(`(async function(){
  var v = await import('/js/viewer.js');
  var out = [];
  for (var i=0;i<3;i++){
    try {
      var cv = await v.renderPageToCanvas(i, 24);
      var d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
      var base = [d[0],d[1],d[2],d[3]];
      var blank = true;
      for (var q=4;q<d.length;q+=4) {
        if (d[q]!==base[0]||d[q+1]!==base[1]||d[q+2]!==base[2]||d[q+3]!==base[3]) { blank=false; break; }
      }
      out.push(blank);
    } catch(e){ out.push('err:'+e.message); }
  }
  return out;
})()`);
check('blank detection flags only the empty page',
  Array.isArray(blanks) && blanks.filter((b) => b === true).length === 1 && blanks[2] === true,
  `blank=${JSON.stringify(blanks)}`);

const removed = await ev(`(async function(){
  var st = await import('/js/store.js');
  var pw = await import('/js/pdfwrite.js');
  var mod = await import('/js/docxtools.js');
  var d = st.activeDoc();
  d.overlay = null; d.pageOps = null;
  var r = mod.removeBlankPages(d, ${JSON.stringify(blanks)});
  if (!r.removed) return { removed: 0 };
  var bytes = await pw.buildPdf(d, {});
  await window.api.writeFile(${JSON.stringify(OUT)}, bytes);
  return { removed: r.removed, remaining: r.remaining };
})()`);
check('removeBlankPages drops exactly one page',
  removed && removed.removed === 1 && removed.remaining === 2,
  `removed=${removed && removed.removed} remaining=${removed && removed.remaining}`);

if (removed && removed.removed) {
  const pdf = await openPdf(fs.readFileSync(OUT));
  check('saved file now has 2 pages', pdf.numPages === 2, `pages=${pdf.numPages}`);
  pdf.destroy();
}

/* 6. Adjust Colors: the raster op type must round-trip a filter. */
const adj = await ev(`(async function(){
  var st = await import('/js/store.js');
  var pw = await import('/js/pdfwrite.js');
  var mod = await import('/js/docxtools.js');
  var d = st.activeDoc();
  d.overlay = null; d.pageOps = null;
  var n = mod.rasterizePages(d, [0], 'grayscale(1)', 120);
  if (!n) return { ok: false };
  var bytes = await pw.buildPdf(d, {});
  await window.api.writeFile(${JSON.stringify(OUT)}, bytes);
  return { ok: true, n: n, bytes: bytes.length };
})()`);
check('rasterizePages produces a colour-adjusted image page', adj && adj.ok === true && adj.n === 1, `n=${adj && adj.n}`);

if (adj && adj.ok) {
  const pdf = await openPdf(fs.readFileSync(OUT));
  check('adjusted page count is unchanged', pdf.numPages === 3, `pages=${pdf.numPages}`);
  pdf.destroy();
}

child.kill();
await sleep(300);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
