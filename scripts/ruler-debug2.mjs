#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Ruler guide live DIAGNOSTIC v2 — separates COMMIT (doc.guides, sync)
 * from RENDER (rAF), captures JS errors, tests Alt-swap, polls render.
 *
 *   node scripts/ruler-debug2.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from "node:os";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9455;
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-ruler-debug2-ud-"));

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

console.log('INSTR', await ev(`(function(){
  window.__errs = []; window.__evtlog = [];
  window.addEventListener('error', function(e){ window.__errs.push(String(e.message) + ' @ ' + (e.filename||'') + ':' + (e.lineno||'')); });
  window.addEventListener('unhandledrejection', function(e){ window.__errs.push('REJ ' + String(e.reason)); });
  ['pointerdown','pointerup'].forEach(function(t){
    window.addEventListener(t, function(e){
      var tgt = e.target ? (e.target.tagName + (e.target.id ? '#'+e.target.id : '')) : 'none';
      window.__evtlog.push(t + ' tgt=' + tgt + ' @' + Math.round(e.clientX) + ',' + Math.round(e.clientY) + ' btn=' + e.button + ' alt=' + e.altKey);
    }, true);
  });
  return 'ok';
})()`));

await ev(`window.__aipdfAction('view:rulers')`);
await sleep(500);

/* Read committed guides straight from the store module (bypasses rAF). */
const readGuides = `import('/js/store.js').then(function(m){
  var d = m.activeDoc();
  return JSON.stringify({n: d && d.guides ? d.guides.length : -1, guides: d && d.guides ? d.guides.map(function(g){ return {o:g.orient, p:g.page, pt:Math.round(g.pt)}; }) : null});
})`;

const drag = async (fx, fy, tx, ty, opts = {}) => {
  // CDP modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
  const pressMods = opts.alt ? { modifiers: 1 } : {};
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1, ...pressMods });
  await sleep(50);
  const steps = opts.steps || 6;
  const altFrom = opts.altMid != null ? opts.altMid : (opts.alt ? 1 : 99); // step index Alt goes down
  for (let s = 1; s <= steps; s++) {
    const withAlt = s >= altFrom;
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left',
      x: Math.round(fx + ((tx - fx) * s) / steps),
      y: Math.round(fy + ((ty - fy) * s) / steps),
      ...(withAlt ? { modifiers: 1 } : {}),
    });
    await sleep(40);
  }
  const relMods = (opts.alt || opts.altMid) ? { modifiers: 1 } : {};
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', ...relMods });
  await sleep(300);
};

const coords = (sel) => ev(`(function(){
  var el = document.querySelector(${JSON.stringify(sel)});
  var page = document.querySelector('#pages .page');
  if (!el || !page) return null;
  var er = el.getBoundingClientRect(); var pr = page.getBoundingClientRect();
  return JSON.stringify({l: er.left, t: er.top, w: er.width, h: er.height, pl: pr.left, pt: pr.top, pw: pr.width, ph: pr.height});
})()`);

const errsOf = () => ev(`JSON.stringify(window.__errs)`);
const evtOf = (n) => ev(`JSON.stringify((window.__evtlog||[]).slice(0, ${n || 20}))`);

/* ── Test 1: left ruler pull, normal ────────────────────────────────── */
const c1 = JSON.parse(await coords('#rulerV'));
const f1 = { x: Math.round(c1.l + c1.w / 2), y: Math.round(c1.t + 120) };
const t1 = { x: Math.round(c1.pl + c1.pw * 0.5), y: Math.round(c1.pt + c1.ph * 0.4) };
await ev(`window.__evtlog = []; window.__errs = []`);
await drag(f1.x, f1.y, t1.x, t1.y);
console.log('T1_COMMIT', await ev(readGuides));
console.log('T1_RENDER_NOW', await ev(`document.querySelectorAll('.page-guides .guide-v').length`));
let poll = 0;
for (let i = 0; i < 30; i++) { await sleep(100); poll = await ev(`document.querySelectorAll('.page-guides .guide-v').length`); if (poll > 0) break; }
console.log('T1_RENDER_POLLED', poll);
console.log('T1_ERRS', await errsOf());
console.log('T1_EVT', await evtOf());

/* ── Test 2: top ruler pull (control) ───────────────────────────────── */
const c2 = JSON.parse(await coords('#rulerH'));
const f2 = { x: Math.round(c2.l + c2.w * 0.5), y: Math.round(c2.t + c2.h / 2) };
const t2 = { x: Math.round(c2.pl + c2.pw * 0.5), y: Math.round(c2.pt + c2.ph * 0.7) };
await ev(`window.__evtlog = []; window.__errs = []`);
await drag(f2.x, f2.y, t2.x, t2.y);
console.log('T2_COMMIT', await ev(readGuides));
console.log('T2_RENDER', await ev(`JSON.stringify({h: document.querySelectorAll('.page-guides .guide-h').length, v: document.querySelectorAll('.page-guides .guide-v').length})`));
console.log('T2_ERRS', await errsOf());
console.log('T2_EVT', await evtOf());

/* ── Test 3: Alt-swap — left ruler + Alt ⇒ horizontal guide ─────────── */
await ev(`window.__aipdfAction('view:clearGuides')`);
await sleep(300);
await ev(`window.__evtlog = []; window.__errs = []`);
await drag(f1.x, f1.y, t1.x, t1.y, { alt: true });
console.log('T3_COMMIT_ALT_LEFT', await ev(readGuides));
console.log('T3_RENDER', await ev(`JSON.stringify({h: document.querySelectorAll('.page-guides .guide-h').length, v: document.querySelectorAll('.page-guides .guide-v').length})`));
console.log('T3_ERRS', await errsOf());
console.log('T3_EVT', await evtOf(12));

/* ── Test 4: Alt pressed MID-DRAG (after press, before release) ─────── */
await ev(`window.__aipdfAction('view:clearGuides')`);
await sleep(300);
await ev(`window.__evtlog = []; window.__errs = []`);
await drag(f1.x, f1.y, t1.x, t1.y, { altMid: 3 });
console.log('T4_COMMIT_MID_DRAG_ALT', await ev(readGuides));
console.log('T4_RENDER', await ev(`JSON.stringify({h: document.querySelectorAll('.page-guides .guide-h').length, v: document.querySelectorAll('.page-guides .guide-v').length})`));
console.log('T4_ERRS', await errsOf());

console.log('DEBUG2_DONE');
ws.close();
child.kill();
process.exit(0);
