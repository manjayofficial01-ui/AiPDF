#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live verification that objects stay editable once they exist.
 *
 * The bug: a drawing tool was a one-way door. The tool layer sat on top of the
 * annotation layer with `pointer-events:auto`, so with Text box / Rectangle /
 * … armed every click laid down ANOTHER object. The one you had just drawn —
 * the thing you wanted to recolour or retype — could never be picked up again,
 * and the properties panel kept describing the *tool* because the fresh object
 * was never announced as selected. Hence "no live edit or modification is
 * possible, neither with text box nor object".
 *
 * Asserted against the REAL app over CDP, because every part of the property
 * under test (hit testing, panel routing, re-render) only exists on screen.
 *
 *   node scripts/object-edit-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9533;
// A fresh profile per run. The shared default profile remembers whichever
// ribbon tab another suite used last (and restores it on boot); when that was
// "AI" the Home/Comment drawing group — and its Polygon button — was absent,
// which made the vertex-tools assertion fail for reasons outside this suite.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-object-ud-'));

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
if (!page) { console.log('OBJ_FAIL no renderer target'); child.kill(); process.exit(1); }

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
  return r.result ? r.result.value : undefined;
};

async function key(k, code, vk, modifiers = 0) {
  const printable = k.length === 1;
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  if (printable) await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const type = async (str) => { for (const c of str) await key(c, 'Key' + c.toUpperCase(), c.toUpperCase().charCodeAt(0)); };

async function aimAt(x, y, expect = null, tries = 24) {
  let last = '';
  for (let i = 0; i < (expect ? tries : 1); i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await sleep(40);
    if (!expect) return 'unverified';
    last = await ev(`(function(){ var e = document.elementFromPoint(${x}, ${y}); if(!e) return 'null';
      return e.matches(${JSON.stringify(expect)}) ? 'MATCH:' + e.tagName + '.' + (e.getAttribute('class')||'') : e.tagName + '.' + (e.getAttribute('class')||''); })()`);
    if (String(last).startsWith('MATCH:')) return last;
  }
  return last;
}
async function click(x, y, expect = null) {
  const aimed = await aimAt(x, y, expect);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0 });
  await sleep(280);
  return aimed;
}
/**
 * Double-click at a point.
 *
 * CDP's `Input.dispatchMouseEvent` never synthesises a `dblclick` — not even
 * with `clickCount: 2` on both the press and the release (verified: the counter
 * stays at 0). Real hit testing still matters, so instead of guessing the
 * target we ask the page what is under the point and dispatch the event on it,
 * exactly the way app.js:530 does for its own double-click path.
 */
async function dblclick(x, y) {
  await aimAt(x, y);
  const ok = await ev(`(function(){
    var e = document.elementFromPoint(${x}, ${y});
    if (!e) return false;
    e.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: ${x}, clientY: ${y} }));
    return true;
  })()`);
  if (!ok) console.log(`  nothing under (${x},${y}) to double-click`);
  await sleep(350);
}
async function drag(x0, y0, x1, y1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  for (let s = 1; s <= 6; s++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * s) / 6, y: y0 + ((y1 - y0) * s) / 6, button: 'left', buttons: 1 });
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', buttons: 0 });
  await sleep(320);
}

for (let i = 0; i < 50; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
await sleep(2500);
await send('Page.bringToFront').catch(() => {});

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/* ── helpers that read the live DOM ────────────────────────────────────── */

const snapshot = () => ev(`(function(){
  // Everything is read from the SELECTED group: the fixture ships with its own
  // annotation, so "the first g.ann on the page" is not the object under test.
  var sel = null;
  Array.prototype.forEach.call(document.querySelectorAll('.annLayer svg > g.ann'), function (g) {
    if (g.querySelector('.selbox')) sel = g;
  });
  var fo = sel ? sel.querySelector('foreignObject div') : null;
  var shape = sel ? sel.querySelector('rect, ellipse, path') : null;
  return {
    anns: document.querySelectorAll('.annLayer svg > g.ann').length,
    selbox: document.querySelectorAll('.annLayer .selbox').length,
    handles: document.querySelectorAll('.annLayer .handle').length,
    ctxTitle: (document.getElementById('ctxTitle')||{}).textContent,
    tool: (document.getElementById('stMode')||{}).textContent,
    text: fo ? fo.textContent : null,
    textColor: fo ? fo.style.color : null,
    stroke: shape ? shape.getAttribute('stroke') : null,
    // The inline editor is appended to the page wrapper, not the SVG layer.
    // Form widgets are textareas too, so they must be excluded or the check
    // passes on the fixture's AcroForm fields instead of the real editor.
    editor: !!inlineEditor(),
  };
  function inlineEditor() {
    var all = Array.prototype.slice.call(document.querySelectorAll('.page textarea'));
    for (var i = 0; i < all.length; i++) if (!all[i].closest('.formLayer')) return all[i];
    return null;
  }
})()`);

/** Set a labelled colour input in the properties panel and fire its events. */
const setPanelColour = (label, hex) => ev(`(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('#ctxBody .prop-row'));
  for (var i = 0; i < rows.length; i++) {
    var l = rows[i].querySelector('label');
    var c = rows[i].querySelector('input[type=color]');
    if (l && c && l.textContent === ${JSON.stringify(label)}) {
      c.value = ${JSON.stringify(hex)};
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
      return 'set';
    }
  }
  var labels = rows.map(function(r){ var x = r.querySelector('label'); return x ? x.textContent : '?'; });
  return 'MISSING (have: ' + labels.join(', ') + ')';
})()`);

/** A patch of page with no object on it: not over an .ann, a text block or a
 *  form widget, and clear of the properties panel. */
const findEmpty = () => ev(`(function(){
  var p = document.querySelector('.page');
  if (!p) return { x: 8, y: 8 };
  var b = p.getBoundingClientRect();
  var top = Math.max(b.top, 160), bot = Math.min(b.bottom, window.innerHeight - 90);
  var left = Math.max(b.left, 130), right = Math.min(b.right, window.innerWidth - 340);
  function clear(x, y) {
    var e = document.elementFromPoint(x, y);
    return !!e && !!e.closest('.page') && !e.closest('.ann') && !e.closest('.textedit') && !e.closest('.formLayer');
  }
  for (var y = top + 40; y < bot - 80; y += 12) {
    for (var x = left + 40; x < right - 100; x += 12) {
      if (clear(x, y) && clear(x + 80, y + 60) && clear(x + 40, y + 30)) return { x: x, y: y };
    }
  }
  return { x: left + 40, y: top + 40 };
})()`);

/* ── a clear spot on the page ──────────────────────────────────────────── */

const spot = await ev(`(function(){
  var p = document.querySelector('.page');
  if (!p) return null;
  var b = p.getBoundingClientRect();
  var top = Math.max(b.top, 160), bot = Math.min(b.bottom, window.innerHeight - 80);
  var left = Math.max(b.left, 130), right = Math.min(b.right, window.innerWidth - 330);
  function usable(x, y) { var e = document.elementFromPoint(x, y); return !!(e && e.closest('.page')); }
  var s = null;
  for (var y = top + 50; y < bot - 160 && !s; y += 20) {
    for (var x = left + 60; x < right - 80; x += 20) {
      if (usable(x, y) && usable(x - 70, y - 30) && usable(x + 70, y + 30) && usable(x + 70, y + 110)) { s = { x: x, y: y }; break; }
    }
  }
  return s;
})()`);
if (!spot) { console.log('OBJ_FAIL no clear spot on the page'); child.kill(); await sleep(600); process.exit(1); }

/* ══ 1. A text box is editable the moment it exists ═════════════════════ */

await key('t', 'KeyT', 84); await sleep(250);
const beforeAnn = (await snapshot()).anns;
await drag(spot.x - 70, spot.y - 30, spot.x + 70, spot.y + 30);
await sleep(500);
let s = await snapshot();
check('drawing a text box creates it', s.anns === beforeAnn + 1, `anns ${beforeAnn} -> ${s.anns}`);
check('the new text box is selected', s.selbox === 1 && s.handles === 8, `selbox=${s.selbox} handles=${s.handles}`);
check('the properties panel describes the OBJECT, not the tool', s.ctxTitle === 'Text box', `ctxTitle="${s.ctxTitle}"`);

/* ══ 2. Typing into the fresh box ══════════════════════════════════════ */

await type('Hello');
await sleep(350);
await key('Escape', 'Escape', 27);
await sleep(350);
s = await snapshot();
check('typed text lands in the box', s.text === 'Hello', `text="${s.text}"`);

/* ══ 3. Clicking it again picks it up instead of stacking a new one ═════ */

const armed = await snapshot();
check('the Text box tool is still armed', armed.tool === 'Text box', `tool="${armed.tool}"`);
await click(spot.x, spot.y, '.ann, .ann-hit');
s = await snapshot();
check('clicking the box again does NOT create another object', s.anns === armed.anns, `anns ${armed.anns} -> ${s.anns}`);
check('clicking the box again keeps it selected', s.selbox === 1 && s.handles === 8, `selbox=${s.selbox} handles=${s.handles}`);
check('the panel still describes the object', s.ctxTitle === 'Text box', `ctxTitle="${s.ctxTitle}"`);

/* ══ 4. Double-click re-opens the inline editor (text is editable) ══════ */

// Escape first: it cancels the composer left open by step 2 and frees the
// keyboard, so 'v' reaches the app instead of landing in the textarea.
await key('Escape', 'Escape', 27);
await sleep(200);
await key('v', 'KeyV', 86);
await sleep(250);
await dblclick(spot.x, spot.y);
const editorUp = await ev(`(function(){
  var all = Array.prototype.slice.call(document.querySelectorAll('.page textarea'));
  for (var i = 0; i < all.length; i++) if (!all[i].closest('.formLayer')) return all[i].value;
  return null;
})()`);
check('double-click re-opens the inline text editor', editorUp !== null && editorUp !== undefined, `editor value=${JSON.stringify(editorUp)}`);
if (editorUp !== null && editorUp !== undefined) {
  await ev(`(function(){
    var all = Array.prototype.slice.call(document.querySelectorAll('.page textarea'));
    for (var i = 0; i < all.length; i++) if (!all[i].closest('.formLayer')) { all[i].focus(); all[i].select(); return; }
  })()`);
  await type('Bye');
  await sleep(300);
  // Escape closes the composer; closing it blurs the textarea, and blur is
  // what commits — so the edit lands, exactly as it did when the box was new.
  await key('Escape', 'Escape', 27);
  await sleep(350);
  check('closing the composer leaves no stray editor', (await snapshot()).editor === false, 'no textarea left on the page');
  await click(spot.x, spot.y, '.ann, .ann-hit');
  await sleep(250);
  s = await snapshot();
  check('re-typed text replaces the old text', s.text === 'Bye', `text="${s.text}"`);
}

/* ══ 5. The colour of the text can be changed ══════════════════════════ */

const colRes = await setPanelColour('Text colour', '#00aa00');
await sleep(350);
s = await snapshot();
check('the panel exposes a Text colour control', colRes === 'set', String(colRes));
check('changing it recolours the text on the page', s.textColor === 'rgb(0, 170, 0)', `color=${s.textColor}`);

/* ══ 6. Same story for a shape ═════════════════════════════════════════ */

await key('r', 'KeyR', 82); await sleep(250);
const beforeRect = (await snapshot()).anns;
await drag(spot.x - 60, spot.y + 70, spot.x + 60, spot.y + 130);
await sleep(450);
s = await snapshot();
check('drawing a rectangle creates it', s.anns === beforeRect + 1, `anns ${beforeRect} -> ${s.anns}`);
check('the new rectangle is selected', s.selbox === 1 && s.handles === 8, `selbox=${s.selbox} handles=${s.handles}`);
check('the panel describes the rectangle', s.ctxTitle === 'Rectangle', `ctxTitle="${s.ctxTitle}"`);

const armed2 = await snapshot();
await click(spot.x, spot.y + 100, '.ann, .ann-hit');
s = await snapshot();
check('clicking the rectangle again does NOT stack another one', s.anns === armed2.anns, `anns ${armed2.anns} -> ${s.anns}`);
check('the rectangle stays selected with handles', s.handles === 8, `handles=${s.handles}`);

const rectCol = await setPanelColour('Stroke', '#0000ff');
await sleep(350);
s = await snapshot();
// SVG serialises the attribute, so compare without whitespace.
const strokeNorm = String(s.stroke || '').replace(/\s+/g, '');
check('the rectangle colour can be changed', rectCol === 'set' && strokeNorm === 'rgb(0,0,255)', `${rectCol} stroke=${s.stroke}`);

/* ══ 7. A resize handle is grabbable while the tool is still armed ══════ */

const hp = await ev(`(function(){ var e = document.querySelector('.handle[data-h="5"]'); if (!e) return null;
  var b = e.getBoundingClientRect(); return { x: b.left + b.width/2, y: b.top + b.height/2 }; })()`);
if (hp) {
  const before = await ev(`(function(){ var s = document.querySelector('.annLayer .selbox'); return s ? s.getBoundingClientRect().bottom : null; })()`);
  await drag(hp.x, hp.y, hp.x, hp.y + 40);
  const after = await ev(`(function(){ var s = document.querySelector('.annLayer .selbox'); return s ? s.getBoundingClientRect().bottom : null; })()`);
  check('a resize handle still drags with the Rectangle tool armed', after !== null && Math.abs(after - before - 40) <= 4,
    `bottom ${before && before.toFixed(1)} -> ${after && after.toFixed(1)} (want +40)`);
} else {
  check('a resize handle still drags with the Rectangle tool armed', false, 'handle[data-h="5"] not found');
}

/* ══ 8. Bare page still draws (the pick-up rule did not swallow drawing) ═ */

const empty = await findEmpty();
const before2 = (await snapshot()).anns;
await drag(empty.x, empty.y, empty.x + 80, empty.y + 60);
await sleep(450);
s = await snapshot();
check('clicking bare page still draws a new object', s.anns === before2 + 1, `anns ${before2} -> ${s.anns} at (${Math.round(empty.x)},${Math.round(empty.y)})`);

/* ══ 9. Vertex tools still lay down vertices ════════════════════════════ */

// The pick-up rule must not steal the click that drops a polygon vertex.
const polyBtn = await ev(`(function(){
  var b = document.querySelector('#ribbon button[aria-label="Polygon"]');
  if (!b) return null;
  var r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
if (!polyBtn) {
  check('the vertex tools still lay down vertices', false, 'no Polygon button on the ribbon');
} else {
  await click(polyBtn.x, polyBtn.y);
  await sleep(250);
  const before3 = (await snapshot()).anns;
  const pts = await ev(`(function(){
    var out = [];
    var p = document.querySelector('.page'); var b = p.getBoundingClientRect();
    var top = Math.max(b.top, 170), left = Math.max(b.left, 140);
    function clear(x, y) { var e = document.elementFromPoint(x, y); return !!e && !!e.closest('.page') && !e.closest('.ann'); }
    for (var y = top; y < top + 300 && out.length < 3; y += 60) {
      for (var x = left; x < left + 300 && out.length < 3; x += 60) {
        if (clear(x, y) && clear(x + 40, y) && clear(x, y + 40)) out.push({ x: x, y: y });
      }
    }
    return out;
  })()`);
  for (const p of pts.slice(0, 3)) { await click(p.x, p.y); await sleep(120); }
  await key('Enter', 'Enter', 13);
  await sleep(400);
  s = await snapshot();
  check('the vertex tools still lay down vertices', s.anns === before3 + 1, `anns ${before3} -> ${s.anns} after ${pts.length} clicks`);
}

/* ── done ─────────────────────────────────────────────────────────────── */

const failed = results.filter((r) => !r.ok);
console.log(`\nOBJECT_EDIT ${failed.length ? 'FAIL' : 'PASS'} ${results.length - failed.length}/${results.length}`);
if (failed.length) console.log('OBJ_FAIL ' + failed.map((f) => f.name).join(' | '));
child.kill();
await sleep(600);
process.exit(failed.length ? 1 : 0);
