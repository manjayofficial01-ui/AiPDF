#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Ruler guides live test — Photoshop-style drag from the rulers, verified in
 * the running app with real pointer events:
 *   1. drag down from the top ruler → a horizontal guide appears at the drop
 *   2. drag from the left ruler → a vertical guide appears
 *   3. dropping near the page's bottom edge snaps to it
 *   4. dragging an existing guide moves it
 *   5. dragging it back onto the ruler deletes it
 *   6. View ▸ Clear Guides removes the rest
 *
 *   node scripts/guides-live-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from "node:os";
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9433;
// Per-run temp profile: fixed .smoke/ user-data dirs grow past 50 files and
// trip the safe-delete bulk guard; they also inherit another suite settings.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), "aipdf-guides-live-test-ud-"));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env: childEnv });
child.stderr.on('data', () => {});
setTimeout(() => { console.log('GUIDES_FAIL watchdog'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 120000).unref?.();

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
if (!target) { console.log('GUIDES_FAIL no renderer target'); child.kill(); process.exit(1); }

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
  } catch (e) { console.log('EV_ERR', String(e.message).slice(0, 80)); return undefined; }
  if (!r || r.exceptionDetails) return undefined;
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

await ev(`window.__aipdfAction('view:rulers')`);
await sleep(500);
check('rulers visible', (await ev(`!!document.querySelector('.rulers.on')`)) === true);

const drag = async (fromX, fromY, toX, toY) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1 });
  const steps = 8;
  for (let s = 1; s <= steps; s++) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', button: 'left',
      x: Math.round(fromX + ((toX - fromX) * s) / steps),
      y: Math.round(fromY + ((toY - fromY) * s) / steps),
    });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left' });
  await sleep(250);
};

const rectOf = async (sel) => {
  const v = await ev(`(function(){ const r = document.querySelector(${JSON.stringify(sel)}); if (!r) return null; const b = r.getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width, h: b.height }; })()`);
  return v || { l: 0, t: 0, w: 0, h: 0 };
};

const hStrip = await rectOf('#rulerH');
const vStrip = await rectOf('#rulerV');
const page = await rectOf('#pages .page');
check('ruler strips take events', hStrip.w > 100 && vStrip.h > 100, JSON.stringify({ hStrip, vStrip }));

/* 1 — drag DOWN from the top ruler: a horizontal guide appears at the drop. */
const dropY1 = Math.round(page.t + page.h * 0.3);
await drag(Math.round(hStrip.l + page.w * 0.5), Math.round(hStrip.t + hStrip.h / 2), Math.round(page.l + page.w * 0.5), dropY1);
const g1pct = await ev(`(function(){ const g = document.querySelector('.page-guides .guide-h'); return g ? parseFloat(g.style.top) : null; })()`);
check('drag from top ruler creates a horizontal guide', g1pct != null, `topPct=${g1pct}`);
check('the guide sits at the drop position (30%)', g1pct != null && Math.abs(g1pct - 30) < 2.5, `at ${g1pct}%`);

/* 2 — drag RIGHT from the left ruler: a vertical guide. */
const dropX2 = Math.round(page.l + page.w * 0.35);
await drag(Math.round(vStrip.l + vStrip.w / 2), Math.round(vStrip.t + page.h * 0.4), dropX2, Math.round(page.t + page.h * 0.4));
const g2n = await ev(`document.querySelectorAll('.page-guides .guide-v').length`);
check('drag from left ruler creates a vertical guide', (g2n || 0) >= 1, `${g2n} vertical guide(s)`);

/* 3 — edge snap: drop 2px above the page's bottom edge → the guide pins to 100%. */
await drag(Math.round(hStrip.l + page.w * 0.7), Math.round(hStrip.t + hStrip.h / 2), Math.round(page.l + page.w * 0.7), Math.round(page.t + page.h - 2));
const snaps = await ev(`JSON.stringify([...document.querySelectorAll('.page-guides .guide-h')].map((g) => g.style.top))`);
const snapList = snaps ? JSON.parse(snaps) : [];
check('dropping at the page edge snaps to it (a guide at top:100%)',
  snapList.some((t) => parseFloat(t) > 99), JSON.stringify(snapList));

/* 4 — move the first horizontal guide by dragging it. */
const g1pos = await ev(`(function(){
  const g = document.querySelector('.page-guides .guide-h');
  const r = g.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`);
// The page can be taller than the window. A drop below the viewport still
// "moves" the guide (its rect just scrolls out of sight) but the follow-up
// press cannot start a gesture, so the guide is never deleted. Keep the drop
// inside the visible window.
const vh = Number(await ev('window.innerHeight')) || 800;
const newY = Math.min(Math.round(page.t + page.h * 0.6), vh - 60);
await drag(g1pos.x, g1pos.y, g1pos.x, newY);
const movedY = await ev(`(function(){ const g = document.querySelector('.page-guides .guide-h'); return Math.round(g.getBoundingClientRect().top); })()`);
check('dragging an existing guide moves it', movedY != null && Math.abs(movedY - newY) < 14, `guide top ${movedY} vs target ${newY}`);

/* 5 — drag it back onto the top ruler: deleted. Re-read the guide's live
   centre: after the move its top edge no longer sits on the ::after hit strip,
   so pressing at `movedY` starts no gesture at all. */
const gNow = JSON.parse(await ev(`(function(){
  var g = document.querySelector('.page-guides .guide-h');
  var r = g.getBoundingClientRect();
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
})()`));
await drag(gNow.x, gNow.y, Math.round(hStrip.l + page.w * 0.5), Math.round(hStrip.t + hStrip.h / 2));
const afterDel = await ev(`document.querySelectorAll('.page-guides .guide-h').length`);
check('dropping a guide on its ruler deletes it', afterDel === 1, `${afterDel} horizontal guide(s) left`);

/* 6 — Clear Guides. */
await ev(`window.__aipdfAction('view:clearGuides')`);
await sleep(250);
const afterClear = await ev(`document.querySelectorAll('.page-guides .guide').length`);
check('Clear Guides removes them all', afterClear === 0, `${afterClear} left`);

/* Visual proof: two guides back in place, then a screenshot. */
await drag(Math.round(hStrip.l + page.w * 0.5), Math.round(hStrip.t + hStrip.h / 2), Math.round(page.l + page.w * 0.5), Math.round(page.t + page.h * 0.4));
await drag(Math.round(vStrip.l + vStrip.w / 2), Math.round(vStrip.t + page.h * 0.4), Math.round(page.l + page.w * 0.35), Math.round(page.t + page.h * 0.4));
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) fs.writeFileSync(path.join(ROOT, '.smoke', 'guides.png'), Buffer.from(shot.data, 'base64'));

console.log(problems ? `GUIDES_FAIL ${problems} problem(s)` : 'GUIDES_PASS all checks green');
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
