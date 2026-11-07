#!/usr/bin/env node
/**
 * Live verification of CELL-SCOPED editing in the Direct Editor.
 *
 * The feature: clicking text inside a table cell must open an editor sized to
 * that CELL, commit a record that knows which row/column it belongs to, and
 * save truthfully — the cell's own source text gone, the replacement present,
 * and the NEIGHBOURING cells untouched. That last clause is the whole point:
 * a detector that reports a table but still edits a whole row is worse than no
 * detector, because the user cannot see the difference until they save.
 *
 * Runs against the real app over CDP with .fixtures/table.pdf, which carries a
 * ruled 3×3 grid (A1..C3) and a borderless 2×2 grid (X1/Y1/X2/Y2).
 *
 *   node scripts/make-table-fixture.mjs && node scripts/table-cell-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'table.pdf');
const PORT = 9551;

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-table-cell-test-'));

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
if (!page) { console.log('TC_FAIL no renderer target'); child.kill(); process.exit(1); }

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
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
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

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(280);
}

await sleep(2600);
await ev(`document.querySelector('#emptyWorkspace')?.classList.add('hidden')`);

// Cold start: the renderer target exists before app.js has booted, so the very
// first click can land on nothing. Wait for the boot flag, the ribbon and a
// painted page before driving anything.
{
  const bootDeadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < bootDeadline) {
    ready = await ev(`!!window.__aipdfBooted && document.querySelectorAll('.rbtn').length > 0 && document.querySelectorAll('.page').length > 0`);
    if (ready !== true) await sleep(300);
  }
  check('the app finished booting and painted the ribbon', ready === true);
}

/* ══ 1. Arm the Direct Editor ═════════════════════════════════════════════ */

const armed = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('.rbtn')).find(function(x){ return x.title === 'Direct Editor'; });
  if (!b) return false;
  b.click();
  return true;
})()`);
check('the Direct Editor can be armed from the ribbon', armed === true);
await sleep(1200);

/* ══ 2. Both tables are recognised and drawn on the page ══════════════════ */

const grid = await ev(`(function(){
  var regions = Array.from(document.querySelectorAll('.table-region'));
  return {
    regions: regions.length,
    tags: regions.map(function(r){ var t = r.querySelector('.table-tag'); return t ? t.textContent.trim() : ''; }),
    cells: document.querySelectorAll('.table-cell').length,
  };
})()`);
check('three table regions are drawn on the page', grid.regions === 3, JSON.stringify(grid.tags));
check('the regions are labelled with their grid size',
  grid.tags.filter((t) => /3×3/.test(t)).length === 2 && grid.tags.some((t) => /2×2/.test(t)),
  JSON.stringify(grid.tags));
check('every cell gets its own outline', grid.cells === 22, `cells=${grid.cells}`);   // 9 + 9 + 4

/* ══ 3. Blocks inside a table are tagged with their cell ══════════════════ */

const tagged = await ev(`(function(){
  var btns = Array.from(document.querySelectorAll('.editable-text-block'));
  var inTable = btns.filter(function(b){ return b.classList.contains('in-table'); });
  return {
    total: btns.length,
    inTable: inTable.length,
    sample: inTable.slice(0, 3).map(function(b){
      return { text: b.textContent.trim(), r: b.dataset.row, c: b.dataset.col, t: b.dataset.table };
    }),
    titled: inTable.every(function(b){ return /Table \\d+ · R\\d+C\\d+ of \\d+×\\d+/.test(b.title || ''); }),
  };
})()`);
check('blocks that sit in a cell are marked as in-table', tagged.inTable >= 13, JSON.stringify(tagged.sample));
check('each in-table block carries its row and column', tagged.inTable > 0
  && tagged.sample.every((s) => s.r != null && s.c != null && s.t), JSON.stringify(tagged.sample));
check('the tooltip names the cell and the grid', tagged.titled === true);

/* ══ 4. Clicking a cell opens an editor sized to the CELL ═════════════════ */

const b2 = await ev(`(function(){
  var btns = Array.from(document.querySelectorAll('.editable-text-block'));
  // The 3×3 ruled grid is the one with a third column; the borderless grid is
  // 2×2 and has its own R2C2, so the column count is what tells them apart.
  var threeCol = {};
  btns.forEach(function(x){ if (x.dataset.col === '2' && x.dataset.table) threeCol[x.dataset.table] = true; });
  var b = btns.find(function(x){
    return x.classList.contains('in-table') && x.dataset.row === '1' && x.dataset.col === '1'
      && threeCol[x.dataset.table];
  });
  if (!b) return null;
  var r = b.getBoundingClientRect();
  // The whole row, so the test can prove the editor is narrower than it.
  var row = btns.filter(function(x){ return x.dataset.table === b.dataset.table && x.dataset.row === b.dataset.row; });
  var left = Math.min.apply(null, row.map(function(x){ return x.getBoundingClientRect().left; }));
  var right = Math.max.apply(null, row.map(function(x){ return x.getBoundingClientRect().right; }));
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           w: Math.round(r.width), rowW: Math.round(right - left),
           row: b.dataset.row, col: b.dataset.col };
})()`);
if (!b2) { console.log('TC_FAIL no in-table block at R2C2 on the fixture'); child.kill(); process.exit(1); }
check('the B2 cell exposes a hit target', b2.row === '1' && b2.col === '1', `R${b2.row}C${b2.col}`);

/** The "what should this say?" dialog that now stands between a click and an
 *  edit. Returns its prefilled value and hint so the test can prove the dialog
 *  is really carrying the DETECTED text and really names the cell. */
const askState = () => ev(`(function(){
  var m = document.querySelector('.modal');
  if (!m) return { open: false };
  var ta = m.querySelector('.de-ask-text');
  var hints = Array.from(m.querySelectorAll('.hint')).map(function(h){ return h.textContent.trim(); });
  return { open: true, value: ta ? ta.value : null, hints: hints,
           buttons: Array.from(m.querySelectorAll('button')).map(function(b){ return b.textContent.trim(); }) };
})()`);

/** Replace the dialog's contents with `text` and apply it with a real Enter. */
async function answer(text) {
  await ev(`(function(){ var t = document.querySelector('.de-ask-text'); if (!t) return false; t.focus(); t.select(); return true; })()`);
  await send('Input.insertText', { text });
  await sleep(120);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(450);
}

/* ══ 4. Asking first: the dialog carries the DETECTED cell text ═══════════ */

await click(b2.x, b2.y);
await sleep(500);

const asked = await askState();
check('clicking a cell asks for the text before editing', asked.open === true, JSON.stringify(asked).slice(0, 140));
check('the dialog is prefilled with the detected cell text', asked.value === 'B2', `value=${JSON.stringify(asked.value)}`);
check('the dialog names the cell the text came from',
  (asked.hints || []).some((h) => /R2C2 of 3×3/.test(h)), JSON.stringify(asked.hints));
check('no editor is opened while the question is still up',
  (await ev(`!document.querySelector('.direct-editor')`)) === true);

// Cancelling must leave the document exactly as it was: no editor, no record.
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
await sleep(400);
check('cancelling the question opens no editor',
  (await ev(`!document.querySelector('.direct-editor')`)) === true);
check('cancelling the question records no edit',
  (await ev(`(window.__aipdfGetTextEdits()||[]).length`)) === 0);

/* ══ 5. Answering it opens a CELL-scoped editor seeded with the answer ════ */

await click(b2.x, b2.y);
await sleep(500);
check('the question is asked again on a fresh click', (await askState()).open === true);
await answer('Revised');

const ed = await ev(`(function(){
  var o = document.querySelector('.direct-editor');
  var s = document.querySelector('.direct-editor-surface');
  if (!o || !s) return { open: false };
  var r = o.getBoundingClientRect();
  var tag = o.querySelector('.de-table-tag');
  return { open: true, w: Math.round(r.width), text: s.textContent,
           row: o.dataset.row, col: o.dataset.col, table: o.dataset.table,
           tag: tag ? tag.textContent.trim() : '' };
})()`);
check('answering the question opens the inline editor', ed.open === true, JSON.stringify(ed).slice(0, 120));
check('the editor is seeded with the answered text, not the original', ed.text === 'Revised', `"${ed.text}"`);
check('the editor is scoped to the cell, not the row',
  ed.open === true && ed.w <= b2.w * 1.25 && ed.w < b2.rowW * 0.75,
  `editor=${ed.w}px cell=${b2.w}px row=${b2.rowW}px`);
check('the editor knows which cell it is editing', ed.row === '1' && ed.col === '1', `R${ed.row}C${ed.col}`);
check('the editor is labelled with the cell', /R2C2/.test(ed.tag || ''), `tag="${ed.tag}"`);

/* ══ 6. Commit the answered text ═════════════════════════════════════════ */

const away = await ev(`(function(){
  var p = document.querySelector('.page'); var b = p.getBoundingClientRect();
  return { x: Math.round(b.left + 12), y: Math.round(b.bottom - 12) };
})()`);
await click(away.x, away.y);
await sleep(800);

/* ══ 7. The edit record knows its table cell ══════════════════════════════ */

const edits = await ev(`window.__aipdfGetTextEdits()`);
const edit = Array.isArray(edits) ? edits.find((e) => e.text === 'Revised') : null;
check('the committed edit is recorded', !!edit, JSON.stringify(edits).slice(0, 200));
check('the record names the cell it belongs to',
  !!edit && edit.table && edit.table.row === 1 && edit.table.col === 1,
  edit && JSON.stringify(edit.table));
check('the record knows the table grid size',
  !!edit && edit.table && edit.table.rows === 3 && edit.table.cols === 3,
  edit && JSON.stringify(edit.table));
check('the record is flow-mode inside a single frame',
  !!edit && edit.mode === 'flow' && edit.frames.length === 1, edit && `${edit.mode}/${edit.frames?.length}`);
const fw = edit?.frames?.[0]?.rect ? edit.frames[0].rect[2] - edit.frames[0].rect[0] : 0;
check('the frame is the cell rect, not the row rect', fw > 20 && fw < 150, `frame width=${Math.round(fw)}`);

/* ══ 8. The SAVED file is truthful at cell granularity ════════════════════ */

const saved = await ev(`window.__aipdfSaveAndExtract(0)`);
const text = String(saved?.text || '');
check('the document still builds after a cell edit', !!saved && !saved.error && saved.bytes > 0,
  JSON.stringify(saved).slice(0, 160));
check('the replacement is present in the saved file', /\bRevised\b/.test(text), text.slice(0, 160));
check('the ORIGINAL cell text is gone from the saved file', !/\bB2\b/.test(text), text.slice(0, 160));
check('the cell above is untouched', /\bA2\b/.test(text) && /\bC2\b/.test(text), text.slice(0, 160));
check('the rows around it are untouched',
  /\bA1\b/.test(text) && /\bC1\b/.test(text) && /\bA3\b/.test(text) && /\bC3\b/.test(text),
  text.slice(0, 160));
check('the borderless table below is untouched',
  /\bX1\b/.test(text) && /\bY1\b/.test(text) && /\bX2\b/.test(text) && /\bY2\b/.test(text),
  text.slice(0, 160));

/* ══ 9. A row that arrives as ONE text run still edits per CELL ═══════════
 * The fixture's third table lays its cells close enough together that text
 * grouping merges each row into a single block. The complaint this locks down:
 * "it treats every row as a cell". The grid must win — one block per cell, and
 * a cell edit must leave its neighbours alone in the saved file. */

const rowGroups = await ev(`(function(){
  var btns = Array.from(document.querySelectorAll('.editable-text-block.in-table'));
  var byTable = {};
  btns.forEach(function(b){
    var k = b.dataset.table; if (!k) return;
    var r = b.getBoundingClientRect();
    (byTable[k] = byTable[k] || { id: k, n: 0, top: 1e9, maxW: 0, cells: [] });
    var g = byTable[k];
    g.n++; g.top = Math.min(g.top, r.top); g.maxW = Math.max(g.maxW, r.width);
    g.cells.push({ r: b.dataset.row, c: b.dataset.col, w: Math.round(r.width),
                   x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  });
  return Object.values(byTable).sort(function(a, b){ return a.top - b.top; });
})()`);
check('three table regions expose hit targets', Array.isArray(rowGroups) && rowGroups.length === 3,
  Array.isArray(rowGroups) && JSON.stringify(rowGroups.map((g) => [g.id, g.n, Math.round(g.maxW)])));

// The merged-row table is the lowest of the three 3×3 grids on the page.
const nine = (rowGroups || []).filter((g) => g.n === 9);
const mergedGroup = nine[nine.length - 1] || null;
check('the merged-row table yields 9 block buttons, one per cell',
  !!mergedGroup && mergedGroup.n === 9,
  JSON.stringify((rowGroups || []).map((g) => [g.id, g.n, Math.round(g.maxW)])));
check('no button in that table is a whole-row block',
  !!mergedGroup && mergedGroup.maxW < 160, mergedGroup && `maxW=${Math.round(mergedGroup.maxW)}px`);

const q2b = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('.editable-text-block.in-table')).find(function(x){
    return x.dataset.table === ${JSON.stringify(mergedGroup?.id || '')} && x.dataset.row === '1' && x.dataset.col === '1';
  });
  if (!b) return null;
  // This table sits below the fold; a raw mouse event at its off-screen
  // coordinates would hit nothing at all.
  b.scrollIntoView({ block: 'center' });
  var r = b.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
})()`);
if (!q2b) { console.log('TC_FAIL no Q2 cell button on the merged-row table'); child.kill(); process.exit(1); }
await sleep(350);

await click(q2b.x, q2b.y);
await sleep(500);
const mergedAsk = await askState();
check('the merged-row cell asks for ITS text, not the row text',
  mergedAsk.open === true && String(mergedAsk.value || '').trim() === 'Q2abcdefghij',
  JSON.stringify(mergedAsk.value));
await answer('RevisedQ');
await sleep(300);

const mergedEd = await ev(`(function(){
  var o = document.querySelector('.direct-editor');
  var s = document.querySelector('.direct-editor-surface');
  if (!o || !s) return { open: false };
  return { open: true, text: s.textContent, row: o.dataset.row, col: o.dataset.col,
           w: Math.round(o.getBoundingClientRect().width) };
})()`);
check('the merged-row editor is scoped to the cell', mergedEd.open === true && mergedEd.w < 160,
  JSON.stringify(mergedEd));
check('the merged-row editor edits row 1 column 1',
  mergedEd.row === '1' && mergedEd.col === '1', `R${mergedEd.row}C${mergedEd.col}`);

// Ctrl+Enter applies, so this commit does not depend on where the page happens
// to be scrolled to.
await ev(`(function(){
  var s = document.querySelector('.direct-editor-surface');
  s.focus();
  s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
})()`);
await sleep(800);

const saved2 = await ev(`window.__aipdfSaveAndExtract(0)`);
const text2 = String(saved2?.text || '');
check('the merged-row replacement is in the saved file', /RevisedQ/.test(text2), text2.slice(0, 200));
check('the original merged-row cell text is gone', !/Q2abcdefghij/.test(text2), text2.slice(0, 200));
check('the cell to its LEFT survives', /P2abcdefghij/.test(text2), text2.slice(0, 200));
check('the cell to its RIGHT survives', /R2abcdefghij/.test(text2), text2.slice(0, 200));
check('the rows above and below survive',
  /P1abcdefghij/.test(text2) && /Q1abcdefghij/.test(text2) && /R1abcdefghij/.test(text2)
  && /P3abcdefghij/.test(text2) && /Q3abcdefghij/.test(text2) && /R3abcdefghij/.test(text2),
  text2.slice(0, 200));
check('the first table edit is still intact in the same save',
  /Revised/.test(text2) && !/\bB2\b/.test(text2), text2.slice(0, 200));

console.log(`\nTC_RESULT pass=${pass} fail=${fail}`);
child.kill();
process.exit(fail ? 1 : 0);
