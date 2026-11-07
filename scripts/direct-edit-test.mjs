#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live verification of the Direct Editor.
 *
 * Two bugs this locks down:
 *
 * 1. "In Direct Editor I can only write text and move the box — no font, size
 *    or colour." The click-away handler listened on `document` in the capture
 *    phase for every pointerdown outside the editor, so reaching for ANY
 *    properties-panel control committed the edit and tore the editor down
 *    before the control could fire. The control then wrote to the persisted
 *    defaults instead of the block.
 *
 * 2. "It shouldn't remove the text — it should add a text box upon it." A
 *    commit produces a real text box annotation over the original run, so the
 *    edit stays draggable and re-editable on screen.
 *
 *    Note the file contract is the OPPOSITE of the on-screen one: on save the
 *    writer REMOVES the owned source operators and writes the replacement as
 *    ordinary page text, and the paired box is omitted from the file so the text
 *    layer is the single source of truth (see the `truthful:` rows in
 *    --parity-test and scripts/truthful-save-test.mjs). This suite drives the
 *    LIVE UI only, so the rows below assert the overlay behaviour — the page's
 *    own text layer is untouched on screen because the edit is a preview, not a
 *    re-render.
 *
 * Asserted against the REAL app over CDP: hit testing, focus, panel routing
 * and re-render only exist on screen.
 *
 *   node scripts/direct-edit-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9547;
// A per-run profile: the default one is held by any installed copy the user has
// open, and Electron's single-instance lock then keeps this instance from
// starting at all ("no renderer target").
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-direct-ud-'));

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
if (!page) { console.log('DE_FAIL no renderer target'); child.kill(); process.exit(1); }

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
  await sleep(260);
}

/** A real pointer press on a panel control — the gesture that used to kill the
 *  editor before the control could act. */
async function pressOn(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(160);
}

/** Find the panel control by its row label, and return its screen position. */
const controlBox = (label) => ev(`(function(){
  var rows = Array.from(document.querySelectorAll('#ctxBody .prop-row'));
  for (const r of rows) {
    var l = r.querySelector('label');
    if (!l || l.textContent.trim() !== ${JSON.stringify(label)}) continue;
    var ctl = r.querySelector('select, input');
    if (!ctl) return null;
    var b = ctl.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), value: ctl.value };
  }
  return null;
})()`);

const editorState = () => ev(`(function(){
  var o = document.querySelector('.direct-editor');
  var s = document.querySelector('.direct-editor-surface');
  if (!o || !s) return { open: false };
  return {
    open: true,
    text: s.textContent,
    font: s.style.fontFamily,
    size: s.style.fontSize,
    color: s.style.color,
    weight: s.style.fontWeight,
    style: s.style.fontStyle,
    decoration: s.style.textDecoration,
  };
})()`);

await sleep(2600);
await ev(`document.querySelector('#emptyWorkspace')?.classList.add('hidden')`);

// The renderer target appears before app.js finishes booting, so on a cold start
// the ribbon buttons may not exist yet and the very first click lands on nothing
// — every later step then fails for the wrong reason. Wait for the boot flag AND
// the buttons AND a rendered page before driving the UI.
{
  const bootDeadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < bootDeadline) {
    ready = await ev(`!!window.__aipdfBooted && document.querySelectorAll('.rbtn').length > 0 && document.querySelectorAll('.page').length > 0`);
    if (ready !== true) await sleep(300);
  }
  check('the app finished booting and painted the ribbon', ready === true);
}

/* ══ 1. Arm the Direct Editor and open a block ════════════════════════════ */

const armed = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('.rbtn')).find(function(x){ return x.title === 'Direct Editor'; });
  if (!b) return false;
  b.click();
  return true;
})()`);
check('the Direct Editor can be armed from the ribbon', armed === true);
await sleep(900);

const block = await ev(`(function(){
  var n = document.querySelectorAll('.editable-text-block');
  if (!n.length) return null;
  var b = n[0].getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
if (!block) { console.log('DE_FAIL no editable block on the fixture'); child.kill(); process.exit(1); }

await click(block.x, block.y);
await sleep(300);

/* The click now asks what the text should say, prefilled with the detected
 * text, before any editing starts. This suite is about what happens AFTER that
 * question, so accept the detected text and continue. */
const asked = await ev(`(function(){
  var m = document.querySelector('.modal');
  var ta = m && m.querySelector('.de-ask-text');
  return ta ? { value: ta.value, hint: (m.querySelector('.hint') || {}).textContent || '' } : null;
})()`);
check('the click asks for the text before editing', !!asked, JSON.stringify(asked));
check('the question is prefilled with the detected block text',
  !!asked && String(asked.value || '').trim().length > 0, asked && JSON.stringify(asked.value));
check('no editor opens until the question is answered',
  (await ev(`!document.querySelector('.direct-editor-surface')`)) === true);
await ev(`document.querySelector('.de-ask-text').focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await sleep(500);

let s = await editorState();
check('answering the question opens the inline editor', s.open === true, JSON.stringify(s).slice(0, 120));

const opened = s;

/* ══ 2. The panel seeds from the block actually being edited ══════════════ */

const fontBox = await controlBox('Font');
const sizeBox = await controlBox('Size');
const colBox = await controlBox('Colour');
check('the panel shows Font, Size and Colour controls',
  !!fontBox && !!sizeBox && !!colBox,
  `font=${!!fontBox} size=${!!sizeBox} colour=${!!colBox}`);

if (fontBox) {
  // The block's own family, not the house default. The fixture's face resolves
  // to a generic, which is exactly the case that used to snap back to Helvetica.
  const inList = await ev(`(function(){
    var rows = Array.from(document.querySelectorAll('#ctxBody .prop-row'));
    for (const r of rows) {
      var l = r.querySelector('label');
      if (!l || l.textContent.trim() !== 'Font') continue;
      var sel = r.querySelector('select');
      return Array.from(sel.options).some(function(o){ return o.value === sel.value; });
    }
    return false;
  })()`);
  check('the Font control shows the block\u2019s own family', inList === true, `value=${fontBox.value}`);
}

/* ══ 3. Using a panel control does NOT close the editor ═══════════════════ */

if (fontBox) {
  await pressOn(fontBox.x, fontBox.y);
  const stillOpen = await ev(`!!document.querySelector('.direct-editor-surface')`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fontBox.x, y: fontBox.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(200);
  check('pressing a panel control keeps the editor open', stillOpen === true);
}

/* ══ 4. Font / size / colour actually retype the live block ═══════════════ */

const setFont = await ev(`(function(){
  var rows = Array.from(document.querySelectorAll('#ctxBody .prop-row'));
  for (const r of rows) {
    var l = r.querySelector('label');
    if (!l || l.textContent.trim() !== 'Font') continue;
    var sel = r.querySelector('select');
    sel.value = 'Times';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  return false;
})()`);
await sleep(300);
s = await editorState();
check('changing the font retypes the block on the page',
  setFont === true && /Times/.test(s.font || ''), `font=${s.font}`);

const setSize = await ev(`(function(){
  var rows = Array.from(document.querySelectorAll('#ctxBody .prop-row'));
  for (const r of rows) {
    var l = r.querySelector('label');
    if (!l || l.textContent.trim() !== 'Size') continue;
    var i = r.querySelector('input');
    i.value = '26';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
})()`);
await sleep(300);
s = await editorState();
const grew = Number.parseFloat(s.size) > Number.parseFloat(opened.size || '0');
check('changing the size resizes the block on the page',
  setSize === true && grew, `${opened.size} -> ${s.size}`);

const setColour = await ev(`(function(){
  var rows = Array.from(document.querySelectorAll('#ctxBody .prop-row'));
  for (const r of rows) {
    var l = r.querySelector('label');
    if (!l || l.textContent.trim() !== 'Colour') continue;
    var i = r.querySelector('input');
    i.value = '#ff0000';
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  return false;
})()`);
await sleep(300);
s = await editorState();
check('changing the colour recolours the block on the page',
  setColour === true && /255,\s*0,\s*0/.test(s.color || ''), `color=${s.color}`);

/* ══ 5. Ctrl+B means bold while you are writing, not Bates numbering ══════ */

await ev(`document.querySelector('.direct-editor-surface').focus()`);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66, modifiers: 2 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66, modifiers: 2 });
await sleep(300);
s = await editorState();
const noDialog = await ev(`!document.querySelector('.modal')`);
check('Ctrl+B bolds the text being edited', s.open === true && /700|bold/.test(s.weight || ''), `weight=${s.weight}`);
check('Ctrl+B does not open the Bates dialog', noDialog === true);

/* ══ 6. Typing, then committing, lays a TEXT BOX over the original ════════ */

await ev(`(function(){
  var s = document.querySelector('.direct-editor-surface');
  s.focus();
  var r = document.createRange(); r.selectNodeContents(s);
  var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
})()`);
for (const ch of 'Replacement words') {
  await send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch });
}
await sleep(250);

const beforeText = await ev(`(function(){
  var sp = document.querySelectorAll('.textLayer span');
  return Array.from(sp).slice(0, 2).map(function(x){ return x.textContent; }).join('|');
})()`);

// Click well away on the page: that is how a user applies the edit.
const away = await ev(`(function(){
  var p = document.querySelector('.page'); var b = p.getBoundingClientRect();
  return { x: Math.round(b.left + 12), y: Math.round(b.bottom - 12) };
})()`);
await click(away.x, away.y);
await sleep(700);

const after = await ev(`(function(){
  var boxes = Array.from(document.querySelectorAll('g.ann foreignObject div')).map(function(d){
    return { text: d.textContent, family: d.style.fontFamily, size: d.style.fontSize, color: d.style.color, weight: d.style.fontWeight };
  });
  var covers = document.querySelectorAll('g.textedit-cover').length;
  var looseText = document.querySelectorAll('g.textedit:not(.textedit-cover) foreignObject').length;
  var spans = Array.from(document.querySelectorAll('.textLayer span')).slice(0, 2).map(function(x){ return x.textContent; }).join('|');
  return { boxes: boxes, covers: covers, looseText: looseText, spans: spans,
    panelTitle: document.getElementById('ctxTitle').textContent };
})()`);

const mine = (after.boxes || []).find((b) => b.text === 'Replacement words');
check('the committed edit exists as a text box annotation', !!mine, JSON.stringify(after.boxes).slice(0, 200));
check('the text box carries the font chosen in the panel', !!mine && /Times/.test(mine.family || ''), mine && mine.family);
check('the text box carries the colour chosen in the panel', !!mine && /255,\s*0,\s*0/.test(mine.color || ''), mine && mine.color);
check('the text box carries the bold set with Ctrl+B', !!mine && /700|bold/.test(mine.weight || ''), mine && mine.weight);
check('the live preview leaves the source page text layer untouched',
  after.spans === beforeText && !!beforeText, `"${after.spans}" vs "${beforeText}"`);
check('the live preview paints a cover wash over the original run', after.covers === 1, `covers=${after.covers}`);
check('the replacement text is not drawn twice', after.looseText === 0, `loose=${after.looseText}`);
check('the properties panel opens the edit behind the new box',
  // A Direct Editor box is the on-screen handle for a text EDIT, so selecting it
  // shows the edit's panel (story, frames, composition) with the box's own
  // appearance controls kept above — not a bare typewriter box's panel.
  /Text block/i.test(after.panelTitle || ''), `title="${after.panelTitle}"`);

/* ══ 7. The resulting box is a normal, editable object ════════════════════ */

const boxPos = await ev(`(function(){
  var gs = Array.from(document.querySelectorAll('g.ann'));
  for (const g of gs) {
    var d = g.querySelector('foreignObject div');
    if (d && d.textContent === 'Replacement words') {
      var b = g.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), id: g.dataset.id };
    }
  }
  return null;
})()`);
if (boxPos) {
  await click(boxPos.x, boxPos.y);
  await sleep(300);
  const sel = await ev(`(function(){
    return { title: document.getElementById('ctxTitle').textContent,
             handles: document.querySelectorAll('.annLayer .handle, .handle').length };
  })()`);
  check('the box can be picked up again after the edit',
    /Text block/i.test(sel.title || '') && sel.handles > 0,
    `title="${sel.title}" handles=${sel.handles}`);
}

/* ══ 8. Deleting the box restores the original text ═══════════════════════ */

if (boxPos) {
  await click(boxPos.x, boxPos.y);
  await sleep(250);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 });
  await sleep(500);
  const gone = await ev(`(function(){
    var boxes = Array.from(document.querySelectorAll('g.ann foreignObject div')).map(function(d){ return d.textContent; });
    return { has: boxes.includes('Replacement words'), covers: document.querySelectorAll('g.textedit-cover').length };
  })()`);
  check('deleting the box removes it', gone.has === false);
  check('deleting the box also removes its cover wash', gone.covers === 0, `covers=${gone.covers}`);
}

console.log(`\nDE_RESULT pass=${pass} fail=${fail}`);
child.kill();
process.exit(fail ? 1 : 0);
