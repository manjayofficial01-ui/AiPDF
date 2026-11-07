#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Verify that a text box produced by the Direct Editor is moveable and
 * resizable, the same as a regular Text Box annotation.
 *
 *   node scripts/textbox-resize-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9549;
/* A per-run user-data dir in the OS temp area, not a fixed one in the repo.
 * A fixed dir has to be bulk-deleted on every run, and a recursive delete of a
 * user-data tree trips the environment's bulk-delete guard once it passes ~50
 * files — so the suite would pass once and then refuse to start. A fresh path
 * needs no delete at all and leaves the repo clean. */
const UD = path.join(os.tmpdir(), `aipdf-textbox-resize-${process.pid}-${Date.now()}`);
mkdirSync(path.dirname(UD), { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null; } catch {}
  if (!page) await sleep(400);
}
if (!page) { console.log('FAIL no renderer'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) { return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); }
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

for (let i = 0; i < 60; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev('document.querySelectorAll("#pages .page").length > 0')) break; await sleep(300); }
await sleep(2000);
await send('Page.bringToFront').catch(() => {});

let pass = 0, fail = 0;
const check = (n, ok, d='') => { ok ? (pass++, console.log(`  ok   ${n}`)) : (fail++, console.log(`  FAIL ${n}${d?' — '+d:''}`)); };

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(200);
}
// CDP's Input.dispatchMouseEvent sometimes doesn't drive SVG element gestures
// (selectionchange / pointer-capture). Dispatch the pointer events directly in
// the renderer — same events the real mouse produces.
const drag = async (x0, y0, x1, y1) => ev(`(async function(){
  const target = document.elementFromPoint(${x0}, ${y0});
  if (!target) return { ok: false, why: 'no element at start' };
  const pdown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: ${x0}, clientY: ${y0}, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 });
  const pmove = new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: ${x1}, clientY: ${y1}, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1 });
  const pup   = new PointerEvent('pointerup',   { bubbles: true, cancelable: true, clientX: ${x1}, clientY: ${y1}, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 });
  target.dispatchEvent(pdown);
  await new Promise(function(r){ setTimeout(r, 50); });
  window.dispatchEvent(pmove);
  await new Promise(function(r){ setTimeout(r, 50); });
  window.dispatchEvent(pup);
  await new Promise(function(r){ setTimeout(r, 100); });
  return { ok: true, target: target.tagName + '.' + (target.getAttribute('class')||'') };
})()`);

// 1. Open Direct Editor on a text block and commit a replacement.
const blockBox = await ev(`(function(){
  var t = document.querySelector('.editable-text-block') || (function(){
    var b = document.querySelectorAll('#ribbon .rbtn');
    for (var x of b) if ((x.getAttribute('aria-label')||'').toLowerCase().includes('direct editor')) { x.click(); return null; }
  })();
  return null;
})()`);
// arm Direct Editor explicitly
await ev(`(async function(){
  var b = Array.from(document.querySelectorAll('#ribbon .rbtn')).find(function(x){ return (x.getAttribute('aria-label')||'').toLowerCase().includes('direct editor'); });
  if (b) b.click();
})()`);
await sleep(800);
const block = await ev(`(function(){ var t=document.querySelector('.editable-text-block'); if(!t) return null; var r=t.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2}; })()`);
check('a text block is hit-testable', !!block, block ? '' : 'no editable block found');
if (block) {
  await click(block.x, block.y);
  await sleep(700);
  // Clicking a block now asks for the text first (the detected text is
  // prefilled). This suite is about the box that a commit produces, so accept
  // the detected text as-is and carry on.
  const asked = await ev(`!!document.querySelector('.de-ask-text')`);
  if (asked) {
    await ev(`document.querySelector('.de-ask-text').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(500);
  }
  const opened = await ev(`!!document.querySelector('.direct-editor-surface')`);
  check('clicking a block opens the Direct Editor', opened);
  if (opened) {
    const committed = await ev(`(async function(){
      var s = document.querySelector('.direct-editor-surface');
      s.focus(); s.textContent = 'RESIZE PROBE';
      s.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      await new Promise(function(r){ setTimeout(r, 500); });
      var st = await import('/js/store.js');
      var d = st.activeDoc();
      var edit = (d.textEdits||[]).slice(-1)[0];
      var box = edit && edit.boxId ? d.annots.find(function(a){ return a.id === edit.boxId; }) : null;
      return edit ? { editRect: edit.rect, bg: !!edit.bg, box: box ? { id: box.id, type: box.type, rect: box.rect } : null } : null;
    })()`);
    check('commit produces an edit with a paired textbox', committed && committed.box, JSON.stringify(committed));
    if (committed && committed.box) {
      // 2. Select the textbox and verify handles exist.
      const sel = await ev(`(async function(){
        var st = await import('/js/store.js');
        st.state.selection = [${JSON.stringify(committed.box.id)}];
        var ev2 = new CustomEvent('selection');
        document.dispatchEvent(ev2);
        return null;
      })()`);
      await sleep(300);
      const handles = await ev(`document.querySelectorAll('#pages .page .handle').length`);
      check('selecting the textbox shows 8 resize handles', handles === 8, `got ${handles}`);
      // 3. Resize by dragging the SE handle (data-h="4") outward.
      const diag = await ev(`(function(){
        var btns = Array.from(document.querySelectorAll('.editable-text-block')).map(function(b){ return b.dataset.block; });
        var h = document.querySelector('#pages .page .handle[data-h="4"]');
        var hr = h ? h.getBoundingClientRect() : null;
        var hel = hr ? document.elementFromPoint(hr.left + hr.width/2, hr.top + hr.height/2) : null;
        var hbtn = hel && hel.closest ? hel.closest('.editable-text-block') : null;
        return {
          btnCount: btns.length, btns: btns,
          handleTop: hel ? hel.tagName + '.' + (hel.getAttribute('class') || '') : 'none',
          handleBtnBlock: hbtn ? hbtn.dataset.block : null,
        };
      })()`);
      console.log('  [diag] btnCount=' + diag.btnCount + ' btns=' + JSON.stringify(diag.btns) + ' handleTop=' + diag.handleTop + ' handleBtnBlock=' + diag.handleBtnBlock);
      const handlePos = await ev(`(function(){
        var h = document.querySelector('#pages .page .handle[data-h="4"]');
        if (!h) return null;
        var r = h.getBoundingClientRect();
        var el = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
        return { x: r.left + r.width/2, y: r.top + r.height/2, topEl: el ? el.tagName + '.' + (el.getAttribute('class') || '') : 'none', topIsHandle: el === h };
      })()`);
      console.log('  [diag] handle topEl=' + (handlePos && handlePos.topEl) + ' topIsHandle=' + (handlePos && handlePos.topIsHandle));
      const before = committed.box.rect;
      if (handlePos) {
        const dRes = await drag(handlePos.x, handlePos.y, handlePos.x + 80, handlePos.y + 40);
        const after = await ev(`(async function(){ var st = await import('/js/store.js'); var a = st.activeDoc().annots.find(function(x){ return x.id === ${JSON.stringify(committed.box.id)}; }); return a ? a.rect : null; })()`);
        const grew = after && (after[2] - after[0] > before[2] - before[0] + 20) && (after[3] - after[1] > before[3] - before[1] + 10);
        check('dragging the SE handle resizes the textbox', grew, `dragTarget=${JSON.stringify(dRes.target)} before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
      } else {
        check('SE handle found', false, 'no .handle[data-h="4"]');
      }
      // 4. Move the textbox by dragging its body.
      const bodyPos = await ev(`(function(){
        var g = document.querySelector('#pages .page g.ann[data-id="' + ${JSON.stringify(committed.box.id)} + '"] .ann-hit');
        if (!g) return null;
        var r = g.getBoundingClientRect();
        return { x: r.left + r.width/2, y: r.top + r.height/2 };
      })()`);
      if (bodyPos) {
        const beforeMove = await ev(`(async function(){ var st = await import('/js/store.js'); var a = st.activeDoc().annots.find(function(x){ return x.id === ${JSON.stringify(committed.box.id)}; }); return a.rect; })()`);
        const dRes2 = await drag(bodyPos.x, bodyPos.y, bodyPos.x + 60, bodyPos.y + 30);
        const afterMove = await ev(`(async function(){ var st = await import('/js/store.js'); var a = st.activeDoc().annots.find(function(x){ return x.id === ${JSON.stringify(committed.box.id)}; }); return a.rect; })()`);
        const moved = afterMove && (Math.abs(afterMove[0] - beforeMove[0]) > 10 || Math.abs(afterMove[1] - beforeMove[1]) > 10);
        check('dragging the body moves the textbox', moved, `drag=${JSON.stringify(dRes2)} before=${JSON.stringify(beforeMove)} after=${JSON.stringify(afterMove)}`);
      }
    }
  }
}

child.kill();
await sleep(300);
console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
