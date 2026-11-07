#!/usr/bin/env node
/**
 * Regression test for the OCR + Direct Editor path.
 *
 * Covers the case the unit tests cannot: a page that has no extractable text
 * at all (an image-only PDF) and has to be read by Tesseract before it can
 * be edited. Verifies that:
 *
 *   - the empty-state notice appears, not a dead canvas
 *   - Recognize Text runs, returns blocks, and renders hit targets
 *   - an edit on a recognised block commits with the right kind & bg
 *   - the saved file is searchable (text extracted) and contains the edit
 *
 *   node scripts/ocr-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from "node:os";
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'scan.pdf');
const PORT = 9461;
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-ocr-test-ud-"));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
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
if (!page) { console.log('OCR_FAIL no renderer target'); child.kill(); process.exit(1); }

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
for (let i = 0; i < 60; i++) { if (await ev('document.querySelectorAll(\'#pages .page\').length > 0')) break; await sleep(300); }
await sleep(2500);
await send('Page.bringToFront').catch(() => {});

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

// 1. The page truly has no text.
const noText = await ev(`(async function(){
  var v = await import('/js/viewer.js');
  var tc = await v.getTextContent(0);
  return !tc || tc.items.length === 0;
})()`);
check('scan fixture has no text operators', noText === true);

// 2. Arming Direct Editor shows the empty notice, not a dead canvas.
await ev(`(function(){
  var b = Array.from(document.querySelectorAll('#ribbon .rbtn')).find(function(x){ return /direct editor/i.test((x.getAttribute('aria-label')||x.getAttribute('title')||'')); });
  b && b.click();
})()`);
await sleep(1500);
const hasNotice = await ev(`!!document.querySelector('.editable-empty')`);
check('arming Direct Editor shows the "no text" notice', hasNotice === true);
const noticeText = await ev(`(document.querySelector('.editable-empty')||{}).textContent || ''`);
check('notice mentions OCR / Recognize', /recognis|ocr/i.test(noticeText));
const noTargets = await ev(`document.querySelectorAll('.editable-text-block').length`);
check('no editable blocks on an image-only page', noTargets === 0);

// 3. The notice button runs OCR, blocks appear, hit targets are styled as OCR.
const ocrResult = await ev(`(async function(){
  var te = await import('/js/textedit.js');
  return await te.recognizePageForEditing(0, { langs: 'eng' });
})()`);
check('recognizePageForEditing returns ok', ocrResult && ocrResult.ok === true,
  `blocks=${ocrResult && ocrResult.blocks} conf=${ocrResult && ocrResult.confidence}%`);
check('OCR produced at least 4 blocks', ocrResult && ocrResult.blocks >= 4,
  `blocks=${ocrResult && ocrResult.blocks}`);

await sleep(500);
const targetsAfter = await ev(`(function(){
  return { count: document.querySelectorAll('.editable-text-block').length,
    fromOcr: document.querySelectorAll('.editable-text-block.from-ocr').length };
})()`);
check('hit targets are rendered after OCR', targetsAfter.count > 0, `count=${targetsAfter.count}`);
check('OCR hit targets are visually distinct (dashed / warn border)',
  targetsAfter.fromOcr === targetsAfter.count && targetsAfter.count > 0,
  `fromOcr=${targetsAfter.fromOcr} of ${targetsAfter.count}`);

// 4. Edit a recognised block: commit records kind='o' and a sampled bg.
const box = await ev(`(function(){ var t=document.querySelectorAll('.editable-text-block')[1] || document.querySelector('.editable-text-block'); if(!t) return null; var r=t.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
if (box) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(1000);
  // Clicking a fresh block now asks for the text first (prefilled with the
  // detected text). An OCR block is usually MULTI-LINE, and there Enter starts
  // a new line rather than applying — so accept the detected text through the
  // modal's primary button, which works for both single- and multi-line text.
  if (await ev(`!!document.querySelector('.de-ask-text')`)) {
    await ev(`(function(){
      var m = document.querySelector('.modal');
      var b = m && m.querySelector('button.primary');
      if (b) { b.click(); return true; }
      return false;
    })()`);
    await sleep(700);
  }
}
const surfaceOpen = await ev(`!!document.querySelector('.direct-editor-surface')`);
check('clicking a recognised block opens the Direct Editor', surfaceOpen);
const edit = await ev(`(async function(){
  var s = document.querySelector('.direct-editor-surface');
  if (!s) return null;
  s.focus();
  s.textContent = 'OCR EDIT PROBE';
  s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await new Promise(function(r){ setTimeout(r, 600); });
  var st = await import('/js/store.js');
  var e = (st.activeDoc().textEdits || []).slice(-1)[0];
  return e ? { text: e.text, kind: e.kind, hasBg: !!e.bg, bg: e.bg } : null;
})()`);
check('edit committed with kind "o"', edit && edit.kind === 'o', edit ? JSON.stringify(edit) : 'no edit');
check('edit sampled a backdrop colour near white',
  edit && Array.isArray(edit.bg) && edit.bg.every(function(c){ return c > 0.85 && c < 1.0001; }),
  edit ? `bg=${edit.bg && edit.bg.map(function(c){return c.toFixed(3);}).join(',')}` : 'no bg');

// 5. The saved file is searchable AND carries the new text.
const saved = await ev(`(async function(){
  var st = await import('/js/store.js');
  var pw = await import('/js/pdfwrite.js');
  var d = st.activeDoc();
  var bytes = await pw.buildPdf(d);
  var w = await window.api.writeFile('.smoke/ocr-test-out.pdf', bytes);
  return { ok: w && w.ok, bytes: bytes.length, err: w && w.error };
})()`);
check('save succeeded', saved && saved.ok, saved ? `bytes=${saved.bytes}` : `err=${saved && saved.err}`);

if (saved && saved.ok) {
  const data = new Uint8Array(fs.readFileSync(path.join(ROOT, '.smoke', 'ocr-test-out.pdf')));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
  const pageObj = await doc.getPage(1);
  const tc = await pageObj.getTextContent();
  const txt = tc.items.map((i) => i.str).join(' ');
  check('saved file extracts 200+ characters', txt.length >= 200, `got ${txt.length}`);
  check('saved file carries the OCR\'d title', /SCANNED INVOICE/.test(txt));
  // A Direct Editor commit is a TEXT BOX laid over the original, not a rewrite
  // of the page content — so the replacement lives in the annotation, not in
  // getTextContent(). Acrobat searches annotations too.
  //
  // A /FreeText annotation exposes its text in three different places depending
  // on the reader: /Contents (the annotation's "contents" string, surfaced by
  // pdf.js as contentsObj.str and — for older pdf.js — .contents), and the
  // appearance stream, which pdf.js reads back as .textContent. Our writer
  // fills both /Contents and the /AP stream, so accept any of them; asserting on
  // .contents alone failed even though the text was plainly in the file.
  const anns = await pageObj.getAnnotations();
  const annTxt = (anns || []).map((a) => [
    a.contents,
    a.contentsObj && a.contentsObj.str,
    Array.isArray(a.textContent) ? a.textContent.join(' ') : a.textContent,
  ].filter(Boolean).join(' ')).join(' ');
  check('saved file carries the user edit',
    /OCR EDIT PROBE/.test(txt) || /OCR EDIT PROBE/.test(annTxt),
    `pageText=${/OCR EDIT PROBE/.test(txt)} annots=${/OCR EDIT PROBE/.test(annTxt)} (${(anns || []).length} annots)`);
  // The edit must be findable from the in-memory doc: the recognised block
  // it was applied to now shows the replacement through blockText().
  const replaced = (await ev(`(async function(){
    var st = await import('/js/store.js');
    var tb = await import('/js/textblocks.js');
    var te = await import('/js/textedit.js');
    var src = await te.editableSource(0);
    for (var b of src.blocks) {
      var e = tb.editForBlock(st.activeDoc(), 0, b);
      if (e && e.text === 'OCR EDIT PROBE') return b.text;   // original block text (pre-edit)
    }
    return null;
  })()`));
  check('the OCR block carries the recorded edit',
    replaced != null,
    replaced ? `original block text starts: ${String(replaced).slice(0,40)}` : 'no block with the edit');
}

child.kill();
await sleep(300);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
