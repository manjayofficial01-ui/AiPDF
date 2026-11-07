#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live check for the Hand tool: it must be reachable from the ribbon, show as
 * the active mode, give a grab cursor, actually pan the scroller, and — unlike
 * the old combined "Select / Hand" behaviour — it must NOT select annotations.
 *
 *   node scripts/hand-tool-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9421;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Own userData: the ribbon tab, active tool and zoom are persisted, so sharing
// the real profile let a previous run leave the app on another ribbon tab —
// where the Hand button does not exist — and the test failed for reasons that
// had nothing to do with the Hand tool.
// Per-run temp profile: fixed .smoke/ user-data dirs trip the safe-delete bulk
// guard once Chromium has written 50+ files into them.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-hand-test-ud-'));
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
if (!page) { console.log('HAND_FAIL no renderer target'); child.kill(); process.exit(1); }

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

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

for (let i = 0; i < 40; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
// Wait for the ribbon to actually paint — the Hand button lives in the Home
// tab's Tools group, and clicking before it exists is a harness race.
for (let i = 0; i < 40; i++) {
  if (await ev(`document.querySelectorAll('#ribbon .rbtn').length > 0`)) break;
  await sleep(200);
}
await sleep(1200);
await send('Page.bringToFront').catch(() => {});

const stMode = () => ev(`(document.getElementById('stMode')||{}).textContent`);
const pagesCursor = () => ev(`getComputedStyle(document.getElementById('pages')).cursor`);

// ── The Hand button exists on the Home ribbon and is clickable ─────────────
const btn = await ev(`(function(){
  var b = document.querySelector('#ribbon .rbtn[aria-label="Hand"]');
  if (!b) return null;
  var r = b.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, title: b.title };
})()`);
check('Hand button is present on the Home ribbon', !!btn, btn ? `tooltip "${btn.title}"` : 'no #ribbon .rbtn[aria-label="Hand"]');
if (!btn) { child.kill(); await sleep(800); process.exit(1); }

const beforeMode = await stMode();
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: btn.x, y: btn.y, button: 'left', clickCount: 1, buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: btn.x, y: btn.y, button: 'left' });
await sleep(500);

check('clicking Hand sets the mode to Hand', (await stMode()) === 'Hand', `stMode ${beforeMode} -> ${await stMode()}`);
check('the Hand ribbon button shows as active', await ev(`!!document.querySelector('#ribbon .rbtn[aria-label="Hand"].active')`) === true);
check('cursor over the page is grab, not crosshair', (await pagesCursor()) === 'grab', `computed cursor = ${await pagesCursor()}`);

// ── Dragging pans the scroller ─────────────────────────────────────────────
// Create the overflow condition instead of assuming it: at fit-width zoom the
// whole page can be shorter than the viewport, and then there is genuinely
// nothing to pan and the assertion would be meaningless.
{
  for (let i = 0; i < 10; i++) {
    const fits = await ev(`(function(){var s=document.getElementById('canvasWrap');return s.scrollHeight <= s.clientHeight;})()`);
    if (!fits) break;
    await ev(`(function(){var b=document.getElementById('zpIn'); if(b){b.click(); return true;} return false;})()`);
    await sleep(350);
  }
}
const spot = await ev(`(function(){
  var p = document.querySelector('.page');
  if (!p) return null;
  var b = p.getBoundingClientRect();
  var s = document.getElementById('canvasWrap').getBoundingClientRect();
  // Pick a point that is on the page AND inside the visible scroller box.
  var top = Math.max(b.top, s.top + 30);
  var bot = Math.min(b.bottom, s.bottom - 30);
  if (bot - top < 60) return null;
  return { x: b.left + b.width / 2, y: (top + bot) / 2 };
})()`);
if (!spot) { check('dragging pans the document', false, 'no visible page area inside the scroller to drag from'); }
else {
  const pre = await ev(`(function(){var s=document.getElementById('canvasWrap');return {top:s.scrollTop, left:s.scrollLeft, h:s.scrollHeight, vh:s.clientHeight};})()`);
  if (pre.h <= pre.vh) {
    check('dragging pans the document', false, `scroller still not overflowing after zoom (scrollHeight ${pre.h} <= clientHeight ${pre.vh})`);
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
    await sleep(80);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: spot.x, y: spot.y, button: 'left', clickCount: 1, buttons: 1 });
    await sleep(60);
    const midPan = await ev(`(function(){
      return { panning: document.body.classList.contains('panning'), cursor: getComputedStyle(document.body).cursor };
    })()`);
    const grabDuringPan = await ev(`getComputedStyle(document.getElementById('pages')).cursor`);
    for (let s = 1; s <= 6; s++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y - s * 25, button: 'left', buttons: 1 });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: spot.x, y: spot.y - 150, button: 'left', buttons: 0 });
    await sleep(400);
    const post = await ev(`(function(){var s=document.getElementById('canvasWrap');return {top:s.scrollTop};})()`);
    // Grab semantics: dragging the pointer UP pulls the content up, which
    // increases scrollTop. Asserting the opposite direction fails at scrollTop 0.
    check('dragging up pans the document down', post.top > pre.top, `scrollTop ${pre.top} -> ${post.top}`);
    check('body.panning is set for the duration of the drag', midPan.panning === true, JSON.stringify(midPan));
    check('cursor becomes grabbing while panning', grabDuringPan === 'grabbing', `computed cursor = ${grabDuringPan}`);
    check('body.panning is cleared after release', await ev(`!document.body.classList.contains('panning')`) === true);
  }
}

// ── Hand must not select annotations (that is what Select is for) ──────────
{
  // Undo the zoom the pan test needed, otherwise the annotation can sit outside
  // the viewport and elementFromPoint returns null for an off-screen point.
  await ev(`(function(){var b=document.getElementById('zpFit'); if(b) b.click(); var s=document.getElementById('canvasWrap'); if(s) s.scrollTop=0; return true;})()`);
  await sleep(600);
  const hit = await ev(`(function(){
    var n = document.querySelector('.annLayer .ann-hit');
    if (!n) return null;
    var r = n.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (y < 0 || y > window.innerHeight || x < 0 || x > window.innerWidth) return { offscreen: true, y: y };
    return { x: x, y: y };
  })()`);
  if (!hit || hit.offscreen) {
    check('Hand does not select an annotation', false, hit && hit.offscreen ? `annotation off-screen at y=${Math.round(hit.y)}` : 'no .ann-hit in the fixture to try');
  } else {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0 });
    await sleep(400);
    const handles = await ev(`document.querySelectorAll('.handle').length`);
    const ctx = await ev(`(document.getElementById('ctxTitle')||{}).textContent`);
    check('Hand does not select an annotation', handles === 0, `handles=${handles} ctxTitle=${ctx}`);
  }
}

// ── Select still selects ───────────────────────────────────────────────────
{
  await ev(`(function(){
    var b = document.querySelector('#ribbon .rbtn[aria-label="Select"]');
    if (b) { b.click(); return true; }
    return false;
  })()`);
  await sleep(400);
  check('Select tool is still reachable and active', (await stMode()) === 'Select', `stMode=${await stMode()}`);
  const hit = await ev(`(function(){
    var n = document.querySelector('.annLayer .ann-hit');
    if (!n) return null;
    var r = n.getBoundingClientRect();
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (y < 0 || y > window.innerHeight) return { offscreen: true, y: y };
    return { x: x, y: y };
  })()`);
  if (hit && !hit.offscreen) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
    await sleep(60);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'left', clickCount: 1, buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'left', buttons: 0 });
    await sleep(500);
    const handles = await ev(`document.querySelectorAll('.handle').length`);
    check('Select still selects an annotation', handles === 8, `handles=${handles}`);
  } else {
    check('Select still selects an annotation', false, 'no .ann-hit');
  }
}

child.kill();
await sleep(1000);
try { child.kill('SIGKILL'); } catch { /* gone */ }

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nHAND_FAIL ${failed.length}/${results.length} checks failed` : `\nHAND_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
