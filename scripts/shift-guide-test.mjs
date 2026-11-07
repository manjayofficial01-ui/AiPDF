#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live verification: (1) the vertical guide PAINTS (screenshot proof) after
 * the .guide-v::after height fix, (2) Shift-draw constraints:
 *   - line + Shift → snaps to 0°/45°/90°
 *   - rect + Shift → square (equal sides)
 *   - same drags WITHOUT Shift → unconstrained (control)
 *
 *   node scripts/shift-guide-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from "node:os";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9466;
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-shift-guide-test-ud-"));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env: childEnv });
child.stderr.on('data', () => {});
child.stdout.on('data', () => {});
setTimeout(() => { console.log('TEST_TIMEOUT watchdog'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 90000).unref?.();

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
if (!target) { console.log('TEST_FAIL no renderer target'); child.kill(); process.exit(1); }

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

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};

for (let i = 0; i < 70; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2000);
await ev(`(function(){
  window.__errs = [];
  window.addEventListener('error', function(e){ window.__errs.push(String(e.message)); });
  window.addEventListener('unhandledrejection', function(e){ window.__errs.push('REJ ' + String(e.reason)); });
  return 'ok';
})()`);

const drag = async (fx, fy, tx, ty, shift = false) => {
  // The fixture page is taller than the window. A press BELOW the viewport
  // never reaches the renderer, so the drag silently creates nothing and the
  // next check re-reads the previous shape. Translate BOTH endpoints by the
  // same amount: dx/dy (the thing under test) is unchanged, while moves that
  // leave the viewport still arrive thanks to pointer capture.
  const vh = Number(await ev('window.innerHeight')) || 800;
  const over = Math.max(fy, ty) - (vh - 40);
  if (over > 0) { fy -= over; ty -= over; }
  const m = shift ? { modifiers: 8 } : {};   // Shift = 8 in the CDP bitmask
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fx, y: fy, button: 'left', clickCount: 1, ...m });
  await sleep(50);
  for (let s = 1; s <= 6; s++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left',
      x: Math.round(fx + ((tx - fx) * s) / 6),
      y: Math.round(fy + ((ty - fy) * s) / 6),
      ...m,
    });
    await sleep(35);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', ...m });
  await sleep(350);
};

const pageBox = async () => JSON.parse(await ev(`(function(){
  var pr = document.querySelector('#pages .page').getBoundingClientRect();
  return JSON.stringify({l: pr.left, t: pr.top, w: pr.width, h: pr.height});
})()`));
const at = (pb, fx, fy) => ({ x: Math.round(pb.l + pb.w * fx), y: Math.round(pb.t + pb.h * fy) });
const readAnnots = () => ev(`import('/js/store.js').then(function(m){
  var d = m.activeDoc();
  return JSON.stringify((d && d.annots ? d.annots : []).map(function(a){ return {t: a.type, r: a.rect, p: a.points || null}; }));
})`);

/* ── 1. Vertical guide paints (screenshot proof) ────────────────────── */
await ev(`window.__aipdfAction('view:rulers')`);
await sleep(500);
const vStrip = JSON.parse(await ev(`(function(){ var r = document.querySelector('#rulerV').getBoundingClientRect(); return JSON.stringify({l:r.left,t:r.top,w:r.width,h:r.height}); })()`));
const pb1 = await pageBox();
await drag(Math.round(vStrip.l + vStrip.w / 2), Math.round(vStrip.t + 120), Math.round(pb1.l + pb1.w * 0.5), Math.round(pb1.t + pb1.h * 0.4));
await sleep(600);
const gv = await ev(`document.querySelectorAll('.page-guides .guide-v').length`);
check('left-ruler drag commits a vertical guide', gv >= 1, `${gv} guide-v`);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) fs.writeFileSync(path.join(ROOT, '.smoke', 'guide-v-paint.png'), Buffer.from(shot.data, 'base64'));
console.log('SCREENSHOT .smoke/guide-v-paint.png saved:', !!shot?.data);
await ev(`window.__aipdfAction('view:clearGuides')`);
await sleep(300);

console.log('PART1_DONE');
await ev(`window.__aipdfAction('view:clearGuides')`);
await sleep(300);

/* ── 2. Shift-line: 45° case, horizontal case, free control ─────────── */
let pb = await pageBox();

await ev(`window.__aipdfAction('tool:line')`);
await sleep(200);
const armed1 = await ev(`import('/js/store.js').then(function(m){ return m.state.tool; })`);
check('line tool armed', armed1 === 'line', `tool=${armed1}`);

// Screen-space geometry helpers. The fixture pages carry /Rotate 90 (portrait
// source shown landscape), so PDF axes are NOT the axes the user sees:
// assertions about WHICH axis a line snapped to must run in screen space via
// toCss(). (Axis-or-45° CLASSIFICATION is rotation-invariant — the 45°
// lattice maps onto itself under 90° turns — but "horizontal vs vertical"
// is not, and a press landing on an existing annotation selects instead of
// drawing, so drags probe for an empty spot first.)
const pageIdx = await ev(`Number(document.querySelector('#pages .page').dataset.i)`);
const scr = async (x, y) => JSON.parse(await ev(`import('/js/viewer.js').then(function(m){ var q = m.toCss(${pageIdx}, ${x}, ${y}); return JSON.stringify(q); })`));
const lineScreen = async (p) => { const A = await scr(p[0], p[1]); const B = await scr(p[2], p[3]); return { dx: B.x - A.x, dy: B.y - A.y }; };
const emptySpot = async (fx, fy) => {
  for (const [ox, oy] of [[0, 0], [0.06, 0], [0, 0.06], [-0.06, 0], [0, -0.06], [0.08, 0.04]]) {
    const c = { x: Math.round(pb.l + pb.w * (fx + ox)), y: Math.round(pb.t + pb.h * (fy + oy)) };
    const blocked = await ev(`(function(){ var t = document.elementFromPoint(${c.x}, ${c.y}); return !!(t && t.closest && t.closest('.ann')); })()`);
    if (!blocked) return c;
  }
  return { x: Math.round(pb.l + pb.w * fx), y: Math.round(pb.t + pb.h * fy) };
};

/* A drawn shape keeps a transparent 12px hit stroke. The next press anywhere
   near it SELECTS instead of drawing, so `anns.filter(...).pop()` re-reads the
   previous shape and every later check reports the first drag. Start each
   measurement from a clean sheet (the ellipse case below does this by hand). */
const clearAnns = async () => {
  await ev(`import('/js/store.js').then(function(m){
    var d = m.activeDoc(); var ids = (d.annots || []).map(function(a){ return a.id; });
    if (ids.length) m.removeAnnots(ids);
    return 'ok';
  })`);
  await ev(`import('/js/annots.js').then(function(m){ m.renderPageAnnotations(${pageIdx}); return 'ok'; })`);
  pb = await pageBox();
  await sleep(200);
};

// Diagonal drag (~46° on screen) + Shift → snaps to a 45° diagonal.
let a = await emptySpot(0.55, 0.15), b = await emptySpot(0.75, 0.45);
await clearAnns();
await drag(a.x, a.y, b.x, b.y, true);
let anns = JSON.parse(await readAnnots() || '[]');
let ln = anns.filter((x) => x.t === 'line').pop();
let sc = ln && ln.p ? await lineScreen(ln.p) : null;
check('line + Shift snaps to 45° (screen)', !!sc && Math.abs(Math.abs(sc.dx) - Math.abs(sc.dy)) < 2 && Math.min(Math.abs(sc.dx), Math.abs(sc.dy)) > 5,
  sc ? `dx=${sc.dx.toFixed(1)} dy=${sc.dy.toFixed(1)}` : JSON.stringify(anns));

// Shallow drag (~13° from horizontal on screen) + Shift → visually HORIZONTAL.
// The page is 742x1049 here, so 0.30w / 0.05h ≈ 13°: anything above 22.5°
// legitimately snaps to the 45° lattice instead (constrainDrawPt rounds to
// the nearest multiple of 45°). Keep the vertical delta small enough that the
// test really measures the horizontal case it claims to measure.
a = await emptySpot(0.55, 0.60); b = await emptySpot(0.85, 0.65);
await clearAnns();
await drag(a.x, a.y, b.x, b.y, true);
anns = JSON.parse(await readAnnots() || '[]');
ln = anns.filter((x) => x.t === 'line').pop();
sc = ln && ln.p ? await lineScreen(ln.p) : null;
check('line + Shift snaps to horizontal (screen)', !!sc && Math.abs(sc.dy) < 2,
  sc ? `dx=${sc.dx.toFixed(1)} dy=${sc.dy.toFixed(1)}` : 'missing');

// Same shallow drag WITHOUT Shift → stays free (control).
a = await emptySpot(0.55, 0.75); b = await emptySpot(0.85, 0.85);
await clearAnns();
await drag(a.x, a.y, b.x, b.y, false);
anns = JSON.parse(await readAnnots() || '[]');
ln = anns.filter((x) => x.t === 'line').pop();
sc = ln && ln.p ? await lineScreen(ln.p) : null;
check('line without Shift stays unconstrained (screen)', !!sc
  && Math.min(Math.abs(sc.dx), Math.abs(sc.dy)) > 5
  && Math.abs(Math.abs(sc.dx) - Math.abs(sc.dy)) > 5,
  sc ? `dx=${sc.dx.toFixed(1)} dy=${sc.dy.toFixed(1)}` : 'missing');

/* ── 3. Shift-rect: square vs free control ──────────────────────────── */
await ev(`window.__aipdfAction('tool:rect')`);
await sleep(200);

a = await emptySpot(0.50, 0.30); b = await emptySpot(0.70, 0.55);   // dx≠dy
await clearAnns();
await drag(a.x, a.y, b.x, b.y, true);
anns = JSON.parse(await readAnnots() || '[]');
let rc = anns.filter((x) => x.t === 'rect').pop();
const sqW = rc ? Math.abs(rc.r[2] - rc.r[0]) : NaN, sqH = rc ? Math.abs(rc.r[3] - rc.r[1]) : NaN;
check('rect + Shift is a square', !!rc && Math.abs(sqW - sqH) < 1.0, `w=${sqW.toFixed(1)} h=${sqH.toFixed(1)}`);

a = await emptySpot(0.50, 0.60); b = await emptySpot(0.85, 0.75);   // clearly wide
await clearAnns();
await drag(a.x, a.y, b.x, b.y, false);
anns = JSON.parse(await readAnnots() || '[]');
rc = anns.filter((x) => x.t === 'rect').pop();
const fw = rc ? Math.abs(rc.r[2] - rc.r[0]) : NaN, fh = rc ? Math.abs(rc.r[3] - rc.r[1]) : NaN;
check('rect without Shift stays free', !!rc && Math.abs(fw - fh) > 5, `w=${fw.toFixed(1)} h=${fh.toFixed(1)}`);

/* ── 4. Shift-ellipse → circle (Photoshop bonus, same rule) ─────────── */
await ev(`window.__aipdfAction('tool:ellipse')`);
await sleep(200);
console.log('ELLIPSE_TOOL', await ev(`import('/js/store.js').then(function(m){ return m.state.tool; })`));
// Fresh page box (selection side-effects can reflow the canvas) and a clean
// sheet: every press on an existing annotation's transparent hit stroke
// (stroke-width 12) selects instead of drawing, which is what swallowed the
// earlier ellipse drags.
pb = await pageBox();
const wiped = await ev(`import('/js/store.js').then(function(m){
  var d = m.activeDoc(); var ids = (d.annots || []).map(function(a){ return a.id; });
  if (ids.length) m.removeAnnots(ids);
  return String(ids.length);
})`);
await ev(`import('/js/annots.js').then(function(m){ m.renderPageAnnotations(${pageIdx}); return 'ok'; })`);
await sleep(300);
console.log('ELLIPSE_WIPED', wiped, 'pb2=', JSON.stringify(pb));
a = await emptySpot(0.55, 0.45); b = await emptySpot(0.75, 0.70);
console.log('ELLIPSE_SPOTS', JSON.stringify({ a, b }),
  'probe=', await ev(`(function(){ var t = document.elementFromPoint(${a.x}, ${a.y}); return t ? String(!!(t.closest && t.closest('.ann'))) : 'no-target'; })()`));
await drag(a.x, a.y, b.x, b.y, true);
anns = JSON.parse(await readAnnots() || '[]');
console.log('ELLIPSE_ANNS', JSON.stringify(anns.map((x) => x.t)));
const el = anns.filter((x) => x.t === 'ellipse').pop();
const ew = el ? Math.abs(el.r[2] - el.r[0]) : NaN, eh = el ? Math.abs(el.r[3] - el.r[1]) : NaN;
check('ellipse + Shift is a circle', !!el && Math.abs(ew - eh) < 1.0, `w=${ew.toFixed(1)} h=${eh.toFixed(1)}`);

const errs = await ev(`JSON.stringify(window.__errs || [])`);
console.log('PAGE_ERRORS', errs);

console.log(problems ? `TEST_FAIL ${problems} problem(s)` : 'TEST_PASS all checks green');
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
