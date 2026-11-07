#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Ruler guide live DIAGNOSTIC — launches the app, enables rulers, traces the
 * pointer event path for a press on the left ruler strip and reports exactly
 * where the guide pull dies.
 *
 *   node scripts/ruler-debug.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from "node:os";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9444;
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-ruler-debug-ud-"));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env: childEnv });
child.stderr.on('data', () => {});
child.stdout.on('data', () => {});
setTimeout(() => { console.log('DEBUG_TIMEOUT watchdog'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 90000).unref?.();

const target = await (async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!target) { console.log('DEBUG_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expression) {
  let r;
  try {
    r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  } catch (e) { console.log('EV_ERR', String(e.message).slice(0, 120)); return undefined; }
  if (!r || r.exceptionDetails) { console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 300)); return undefined; }
  return r.result ? r.result.value : undefined;
}

for (let i = 0; i < 70; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2000);

/* ── 1. Enable rulers and inspect state ─────────────────────────────── */
await ev(`window.__aipdfAction('view:rulers')`);
await sleep(600);

const state = await ev(`(function(){
  const layer = document.querySelector('#rulers');
  const h = document.querySelector('#rulerH');
  const v = document.querySelector('#rulerV');
  const hc = document.querySelector('#rulerHCanvas');
  const vc = document.querySelector('#rulerVCanvas');
  const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return {l:Math.round(r.left),t:Math.round(r.top),w:Math.round(r.width),h:Math.round(r.height)}; };
  return JSON.stringify({
    layerClass: layer ? layer.className : null,
    layerPE: layer ? getComputedStyle(layer).pointerEvents : null,
    hDisplay: h ? getComputedStyle(h).display : null,
    vDisplay: v ? getComputedStyle(v).display : null,
    hPE: h ? getComputedStyle(h).pointerEvents : null,
    vPE: v ? getComputedStyle(v).pointerEvents : null,
    hRect: rect(h), vRect: rect(v), hcRect: rect(hc), vcRect: rect(vc),
    scrollerTransform: layer ? layer.style.transform : null
  });
})()`);
console.log('STATE', state);

/* ── 2. What element sits at the left-strip press point? ────────────── */
const hitTest = await ev(`(function(){
  const v = document.querySelector('#rulerV');
  if (!v) return JSON.stringify({err:'no #rulerV'});
  const r = v.getBoundingClientRect();
  const x = Math.round(r.left + r.width/2);
  const y = Math.round(r.top + Math.min(r.height/2, 100));
  const at = document.elementFromPoint(x, y);
  const stack = document.elementsFromPoint(x, y).slice(0, 6).map(function(e){ return e.tagName + (e.id?('#'+e.id):'') + (typeof e.className === 'string' && e.className ? ('.'+e.className.split(' ').join('.')) : ''); });
  return JSON.stringify({x, y, at: at ? at.tagName + (at.id?('#'+at.id):'') + (typeof at.className==='string'?('.'+at.className):'') : null, stack});
})()`);
console.log('HITTEST', hitTest);

/* ── 3. Instrument event log, then simulate the drag ────────────────── */
console.log('INSTRUMENT', await ev(`(function(){
  window.__evtlog = [];
  ['pointerdown','pointermove','pointerup','pointercancel'].forEach(function(t){
    window.addEventListener(t, function(e){
      var tgt = e.target ? (e.target.tagName + (e.target.id ? '#'+e.target.id : '') + (typeof e.target.className==='string' && e.target.className ? '.'+e.target.className.split(' ').slice(0,3).join('.') : '')) : 'none';
      window.__evtlog.push(t + ' tgt=' + tgt + ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' btn=' + e.button + ' alt=' + e.altKey);
    }, true);
  });
  return 'instrumented';
})()`));

const g = await ev(`(function(){
  var v = document.querySelector('#rulerV');
  var page = document.querySelector('#pages .page');
  if (!v || !page) return JSON.stringify({err:'missing', v: !!v, page: !!page});
  var vr = v.getBoundingClientRect();
  var pr = page.getBoundingClientRect();
  return JSON.stringify({fromX: Math.round(vr.left + vr.width/2), fromY: Math.round(vr.top + 100), toX: Math.round(pr.left + pr.width*0.5), toY: Math.round(pr.top + pr.height*0.4)});
})()`);
console.log('DRAGCOORDS', g);

const drag = async (fx, fy, tx, ty) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: Math.round((fx + tx) / 2), y: Math.round((fy + ty) / 2) });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', x: tx, y: ty });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left' });
  await sleep(400);
};

if (g) {
  const c = JSON.parse(g);
  if (!c.err) {
    await drag(c.fromX, c.fromY, c.toX, c.toY);
    console.log('AFTER_LEFT_DRAG', await ev(`JSON.stringify({preview: document.querySelectorAll('.guide-drag').length, guides: document.querySelectorAll('.page-guides .guide').length, guideV: document.querySelectorAll('.page-guides .guide-v').length, guideH: document.querySelectorAll('.page-guides .guide-h').length})`));
    console.log('EVTLOG_LEFT', await ev(`JSON.stringify((window.__evtlog||[]).slice(0, 40))`));
  } else {
    console.log('DRAGCOORDS_ERR', g);
  }
}

/* ── 4. Top ruler for comparison ────────────────────────────────────── */
await ev(`window.__evtlog = []`);
const g2 = await ev(`(function(){
  var h = document.querySelector('#rulerH');
  var page = document.querySelector('#pages .page');
  if (!h || !page) return null;
  var hr = h.getBoundingClientRect();
  var pr = page.getBoundingClientRect();
  return JSON.stringify({fromX: Math.round(hr.left + hr.width*0.5), fromY: Math.round(hr.top + hr.height/2), toX: Math.round(pr.left + pr.width*0.5), toY: Math.round(pr.top + pr.height*0.4)});
})()`);
if (g2) {
  const c2 = JSON.parse(g2);
  await drag(c2.fromX, c2.fromY, c2.toX, c2.toY);
  console.log('AFTER_TOP_DRAG', await ev(`JSON.stringify({guideH: document.querySelectorAll('.page-guides .guide-h').length, guideV: document.querySelectorAll('.page-guides .guide-v').length, preview: document.querySelectorAll('.guide-drag').length, evt: (window.__evtlog||[]).slice(0,12)})`));
}

console.log('DEBUG_DONE');
ws.close();
child.kill();
process.exit(0);
