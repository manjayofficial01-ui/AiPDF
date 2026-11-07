#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live verification of the universal tool access and the standard shortcuts.
 *
 *   node scripts/shortcuts-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9551;

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-shortcuts-test-'));

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
  } catch { /* not up */ }
  if (!page) await sleep(400);
}
if (!page) { console.log('SC_FAIL no renderer target'); child.kill(); process.exit(1); }

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

async function key(k, code, vk, modifiers = 0) {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(260);
}
const CTRL = 2, SHIFT = 8;

async function drag(x0, y0, x1, y1) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x0 + x1) / 2, y: (y0 + y1) / 2, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1, y: y1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(400);
}
async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(280);
}

const annCount = () => ev(`document.querySelectorAll('.annLayer g.ann').length`);

await sleep(2600);
await ev(`document.querySelector('#emptyWorkspace')?.classList.add('hidden')`);

/* ══ 1. The Hand tool is reachable from every ribbon tab ══════════════════ */

const tabs = await ev(`Array.from(document.querySelectorAll('#modeTabs button')).map(function(b){ return b.textContent.trim(); })`) || [];
check('the ribbon has several mode tabs', tabs.length >= 5, `tabs=${JSON.stringify(tabs)}`);

const quick = await ev(`!!document.querySelector('.qbtn[data-tool="hand"]') && !!document.querySelector('.qbtn[data-tool="select"]')`);
check('Hand and Select are on the quick-access bar', quick === true);

let missing = [];
for (const t of tabs) {
  const okTab = await ev(`(function(){
    var b = Array.from(document.querySelectorAll('#modeTabs button')).find(function(x){ return x.textContent.trim() === ${JSON.stringify(t)}; });
    if (!b) return 'no-tab';
    b.click();
    var hand = Array.from(document.querySelectorAll('#ribbon .rbtn')).some(function(x){ return x.title === 'Hand'; });
    var sel = Array.from(document.querySelectorAll('#ribbon .rbtn')).some(function(x){ return x.title === 'Select'; });
    return hand && sel;
  })()`);
  if (okTab !== true) missing.push(`${t}:${okTab}`);
  await sleep(120);
}
check('every ribbon tab offers both Hand and Select', missing.length === 0, missing.join(', '));

// And it actually arms.
await ev(`(function(){ var b = Array.from(document.querySelectorAll('#modeTabs button')).find(function(x){ return x.textContent.trim() === 'Comment'; }); if (b) b.click(); })()`);
await sleep(250);
const handArmed = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('#ribbon .rbtn')).find(function(x){ return x.title === 'Hand'; });
  if (!b) return 'missing';
  b.click();
  return document.getElementById('stMode').textContent.trim();
})()`);
await sleep(300);
check('clicking Hand on a non-Home tab arms it', /hand/i.test(String(handArmed)), `stMode="${handArmed}"`);

/* ══ 2. Ctrl+E / D arm the Direct Editor ══════════════════════════════════ */

await ev(`(function(){ var b = Array.from(document.querySelectorAll('.qbtn[data-tool="select"]')); if (b[0]) b[0].click(); })()`);
await sleep(250);
await key('e', 'KeyE', 69, CTRL);
let mode = await ev(`document.getElementById('stMode').textContent.trim()`);
check('Ctrl+E arms the Direct Editor', /direct/i.test(String(mode)), `stMode="${mode}"`);

await key('v', 'KeyV', 86, 0);
await sleep(200);
await key('d', 'KeyD', 68, 0);
mode = await ev(`document.getElementById('stMode').textContent.trim()`);
check('D arms the Direct Editor', /direct/i.test(String(mode)), `stMode="${mode}"`);

/* ══ 3. Page navigation ══════════════════════════════════════════════════ */

await key('v', 'KeyV', 86, 0);
await sleep(300);
/** "Page 2 / 2" → { at: 2, of: 2 }. */
const pageNo = async () => {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(String(await ev(`document.getElementById('stPage').textContent`)) || '');
  return m ? { at: Number(m[1]), of: Number(m[2]) } : { at: -1, of: -1 };
};
// Land on the last page first, so Ctrl+Home has somewhere to travel from.
await key('End', 'End', 35, CTRL);
await sleep(700);
let p = await pageNo();
check('Ctrl+End goes to the last page', p.at === p.of && p.of > 0, JSON.stringify(p));
await key('Home', 'Home', 36, CTRL);
await sleep(700);
p = await pageNo();
check('Ctrl+Home goes to the first page', p.at === 1, JSON.stringify(p));

/* ══ 4. F3 opens find / steps through matches ════════════════════════════ */

await key('F3', 'F3', 114, 0);
const findOpen = await ev(`document.getElementById('findBar').classList.contains('open')`);
check('F3 opens the find bar when no search is running', findOpen === true);
await key('Escape', 'Escape', 27, 0);

/* ══ 5. Undo / redo / cut / paste / delete on a real object ═══════════════ */

// Draw a rectangle with the Rectangle tool (R).
await key('r', 'KeyR', 82, 0);
await sleep(300);
const spot = await ev(`(function(){
  var p = document.querySelector('.page'); var b = p.getBoundingClientRect();
  return { x: Math.round(b.left + 60), y: Math.round(b.top + Math.min(220, b.height * 0.25)) };
})()`);
const before = await annCount();
await drag(spot.x, spot.y, spot.x + 130, spot.y + 70);
const drawn = await annCount();
check('drawing with the Rectangle tool creates an object', drawn === before + 1, `${before} -> ${drawn}`);

await key('z', 'KeyZ', 90, CTRL);
const undone = await annCount();
check('Ctrl+Z undoes it', undone === before, `${drawn} -> ${undone}`);

await key('y', 'KeyY', 89, CTRL);
const redone = await annCount();
check('Ctrl+Y redoes it', redone === drawn, `${undone} -> ${redone}`);

// Select the object and cut it.
const obj = await ev(`(function(){
  var g = document.querySelector('.annLayer g.ann');
  if (!g) return null;
  var b = g.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
if (obj) {
  await click(obj.x, obj.y);
  await sleep(250);
  const selected = await ev(`document.querySelectorAll('.annLayer g.ann .selbox').length > 0`);
  check('the object can be selected by clicking it', selected === true);

  await key('x', 'KeyX', 88, CTRL);
  const cut = await annCount();
  check('Ctrl+X cuts the selection', cut === redone - 1, `${redone} -> ${cut}`);

  await key('v', 'KeyV', 86, CTRL);
  await sleep(350);
  const pasted = await annCount();
  check('Ctrl+V pastes it back', pasted === cut + 1, `${cut} -> ${pasted}`);

  await click(obj.x, obj.y);
  await sleep(250);
  await key('Backspace', 'Backspace', 8, 0);
  const deleted = await annCount();
  check('Backspace deletes the selection', deleted === pasted - 1, `${pasted} -> ${deleted}`);
}

/* ══ 6. Text-editing keys belong to the text, not the document ════════════ */

await key('e', 'KeyE', 69, CTRL);
await sleep(800);
const blk = await ev(`(function(){
  var n = document.querySelectorAll('.editable-text-block');
  if (!n.length) return null;
  var b = n[0].getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
if (blk) {
  await click(blk.x, blk.y);
  await sleep(500);
  // Direct Editor asks for the detected text BEFORE it opens the inline
  // surface. Skipping that question leaves a modal open and no text input,
  // so every "while typing" assertion below measures the wrong focus.
  if (await ev(`!!document.querySelector('.de-ask-text')`)) {
    const accepted = await ev(`(function(){
      var m = document.querySelector('.modal');
      var b = m && m.querySelector('button.primary');
      if (b) { b.click(); return true; }
      return false;
    })()`);
    if (!accepted) {
      await ev(`document.querySelector('.de-ask-text').focus()`);
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    }
    await sleep(600);
  }
  const open = await ev(`!!document.querySelector('.direct-editor-surface')`);
  check('the Direct Editor is open for the focus test', open === true);

  const tabsBefore = await ev(`document.querySelectorAll('.tb-tabs .tab, #tabStrip .tab').length`);
  await key('n', 'KeyN', 78, CTRL);
  const tabsAfter = await ev(`document.querySelectorAll('.tb-tabs .tab, #tabStrip .tab').length`);
  check('Ctrl+N while typing does not open a new document', tabsBefore === tabsAfter, `${tabsBefore} -> ${tabsAfter}`);

  await key('g', 'KeyG', 71, CTRL);
  const dlg = await ev(`!!document.querySelector('.modal')`);
  const stillOpen = await ev(`!!document.querySelector('.direct-editor-surface')`);
  check('Ctrl+G while typing does not open Insert Pages', dlg === false, `modal=${dlg}`);
  check('the editor survives those keystrokes', stillOpen === true);

  await key('Escape', 'Escape', 27, 0);
  await sleep(300);
}

/* ══ 7. Space still pans from any tool ═══════════════════════════════════ */

await key('r', 'KeyR', 82, 0);
await sleep(250);
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
await sleep(200);
const panning = await ev(`document.body.classList.contains('space-pan')`);
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
check('holding Space arms the temporary Hand from any tool', panning === true);

console.log(`\nSC_RESULT pass=${pass} fail=${fail}`);
child.kill();
process.exit(fail ? 1 : 0);
