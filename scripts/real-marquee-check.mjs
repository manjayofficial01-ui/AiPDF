#!/usr/bin/env node
/**
 * Real-world check of the Edit image marquee on a supplied PDF.
 *
 *   node scripts/real-marquee-check.mjs "path/to/file.pdf" [pageIndex]
 *
 * The file is COPY-checked: the PDF is opened from a temp copy, so nothing the
 * app does can touch the original. Reports what the tool detects and whether
 * the detected object is movable, on a real page rather than a fixture.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A free TCP port, so repeated runs (this script is pointed at many PDFs in
 *  turn) never collide with a still-closing Electron from the previous run. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SRC = process.argv[2];
const PAGE = Number(process.argv[3] || 0);
if (!SRC || !fs.existsSync(SRC)) { console.log('FAIL missing pdf: node scripts/real-marquee-check.mjs <file.pdf>'); process.exit(1); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-real-'));
const COPY = path.join(TMP, path.basename(SRC));
fs.copyFileSync(SRC, COPY);
const PORT = await freePort();
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-real-ud-'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', COPY, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stderr.on('data', () => {}); child.stdout.on('data', () => {});
setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 180000).unref?.();

const target = await (async () => {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!target) { console.log('FAIL no target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0; const pending = new Map(); const errs = [];
const send = (method, params) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 200));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 200));
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r || r.exceptionDetails) { console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 300)); return undefined; }
  return r.result ? r.result.value : undefined;
}
let problems = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); if (!ok) problems++; };
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: type === 'mouseMoved' ? 1 : undefined, ...extra });

for (let i = 0; i < 90; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 80; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2500);

await ev(`window.__it = {
  async vp(i) {
    const { activeDoc } = await import('/js/store.js');
    const p = await activeDoc().pdf.getPage(i + 1);
    const d = activeDoc();
    const rot = (p.rotate || 0) + ((d.pageRotate || {})[i] || 0);
    return p.getViewport({ scale: 1, rotation: rot });
  },
  async point(i, x, y) {
    const v = await this.vp(i);
    const cv = document.querySelector('.page[data-i="' + i + '"] canvas.pdf');
    const r = cv.getBoundingClientRect();
    const q = v.convertToViewportPoint(x, y);
    return { x: r.left + (q[0] / v.width) * r.width, y: r.top + (q[1] / v.height) * r.height };
  },
  async bounds(i) {
    const { activeDoc } = await import('/js/store.js');
    const { openNativeImagePage, closeNativeImageSession } = await import('/js/image-pdf-browser.mjs');
    const s = await openNativeImagePage(activeDoc().bytes, i);
    const out = s.images.map(function (im) { return { name: im.name, bounds: im.bounds, clipped: im.clipped, mask: !!im.resource?.imageMask }; });
    closeNativeImageSession(s);
    return out;
  },
  box() {
    var b = document.querySelector('.img-edit-box');
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), left: r.left, top: r.top, handles: document.querySelectorAll('.img-handle').length, toolbar: !!document.querySelector('.img-toolbar') };
  }
}; 'ok'`);

console.log('FILE', SRC);
console.log('PAGES', await ev(`(async () => (await import('/js/store.js')).activeDoc().numPages)()`));
const imgs = JSON.parse((await ev(`__it.bounds(${PAGE}).then(JSON.stringify)`)) || '[]');
console.log(`PLACEMENTS on page ${PAGE}:`, JSON.stringify(imgs));
check('the page has an editable image placement', imgs.length > 0, JSON.stringify(imgs.map((i) => i.bounds)));

/* Arm the tool. */
await ev(`(function(){ var b = document.querySelector('#ribbon button[aria-label="Edit object"]'); if (b) b.click(); return !!b; })()`);
await sleep(500);
check('Edit object tool is armed', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editImage')()`));

/* A marquee dropped in the MIDDLE of the page — deliberately not touching any
   corner, so only detection can pick the object up.

   The zoom matters: the default is fit-width, so a tall page (a 3x46 ad is
   1300pt high) renders far taller than the window and the "middle" of the page
   lands off-screen where no mouse event can reach it. Fit the whole page into
   the view first, so the gesture is a gesture a user could actually make. */
await ev(`(async () => { const v = await import('/js/viewer.js'); v.setZoom('fitPage'); return 'ok'; })()`);
await sleep(1800);

const dims = JSON.parse(await ev(`(async () => { const { activeDoc } = await import('/js/store.js'); const p = await activeDoc().pdf.getPage(${PAGE + 1}); const v = p.getViewport({ scale: 1 }); return JSON.stringify({ w: v.width, h: v.height }); })()`));
const ppp = await ev(`(function(){ var cv = document.querySelector('.page[data-i="${PAGE}"] canvas.pdf'); return cv.getBoundingClientRect().width / ${dims.w}; })()`);
const pt = async (x, y) => JSON.parse(await ev(`__it.point(${PAGE}, ${x}, ${y}).then(JSON.stringify)`));
const boxOf = async () => JSON.parse((await ev(`JSON.stringify(__it.box())`)) || 'null');
const waitBox = async (want = true, tries = 40) => {
  for (let i = 0; i < tries; i++) { const b = await boxOf(); if (!!b === want) return b; await sleep(250); }
  return await boxOf();
};

const a = await pt(dims.w * 0.3, dims.h * 0.7);
const b = await pt(dims.w * 0.6, dims.h * 0.4);
/* Both ends of the drag must be on-screen, or the harness is testing nothing
   (a mouse event outside the window simply never reaches the page). */
const win = JSON.parse(await ev(`JSON.stringify({ w: innerWidth, h: innerHeight })`));
const onScreen = (p) => p.x >= 0 && p.x < win.w && p.y >= 0 && p.y < win.h;
console.log('MARQUEE_POINTS', JSON.stringify({ a, b }), 'window', JSON.stringify(win));
check('the marquee drag is inside the window', onScreen(a) && onScreen(b),
  `a=(${Math.round(a.x)},${Math.round(a.y)}) b=(${Math.round(b.x)},${Math.round(b.y)}) in ${win.w}x${win.h}`);
await mouse('mousePressed', a.x, a.y);
await sleep(60);
for (let s = 1; s <= 6; s++) { await mouse('mouseMoved', a.x + ((b.x - a.x) * s) / 6, a.y + ((b.y - a.y) * s) / 6); await sleep(35); }
await mouse('mouseReleased', b.x, b.y);
const box = await waitBox(true);
console.log('MARQUEE_BOX', JSON.stringify(box), 'ppp', ppp);
check('a marquee in the middle of the page detects the object', !!box, box ? `${box.w}x${box.h}px` : 'no box');
if (box) {
  const want = imgs.map((im) => ({ w: Math.round((im.bounds[2] - im.bounds[0]) * ppp), h: Math.round((im.bounds[3] - im.bounds[1]) * ppp) }));
  const ok = want.some((w) => Math.abs(w.w - box.w) <= 8 && Math.abs(w.h - box.h) <= 8);
  check('the detected box matches a real placement', ok, `${box.w}x${box.h}px vs ${JSON.stringify(want)}`);
  check('the detected object is fully movable (4 handles + toolbar)', box.handles === 4 && box.toolbar, `handles=${box.handles} toolbar=${box.toolbar}`);
}

/* Move it: +30pt right, +20pt up, and read the committed bytes back. */
if (box) {
  const before = JSON.parse((await ev(`__it.bounds(${PAGE}).then(JSON.stringify)`)) || '[]');
  const center = { x: box.left + box.w / 2, y: box.top + box.h / 2 };
  console.log('ELEM_AT_CENTER', await ev(`(function(){ var e = document.elementFromPoint(${Math.round(center.x)}, ${Math.round(center.y)}); return e ? e.tagName + '.' + (e.getAttribute && e.getAttribute('class') || '') : 'null'; })()`));
  await ev(`(function(){ var b = document.querySelector('.img-edit-box'); window.__log = []; if (!b) return 'nobox';
    window.__boxEl = b; window.__doc = { move: 0, up: 0 };
    window.__stacks = [];
    window.__obs = [];
    var NL = String.fromCharCode(10);
    if (!window.__patched) {
      window.__patched = true;
      var orig = Node.prototype.appendChild;
      Node.prototype.appendChild = function (n) {
        if (n && n.classList && n.classList.contains('img-edit-box') && window.__stacks) {
          window.__stacks.push(String(new Error().stack || '').split(NL).slice(1, 8).join(' <- '));
        }
        return orig.apply(this, arguments);
      };
      var mo = new MutationObserver(function (recs) {
        if (!window.__obs) return;
        for (var r of recs) {
          var added = [].map.call(r.addedNodes, function (n) { return (n.className || n.nodeName); });
          var removed = [].map.call(r.removedNodes, function (n) { return (n.className || n.nodeName); });
          if (added.length || removed.length) window.__obs.push('+' + added.join(',') + ' / -' + removed.join(','));
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('pointermove', function(){ window.__doc.move++; }, true);
    window.addEventListener('pointerup', function(){ window.__doc.up++; }, true);
    ['pointerdown','pointermove','pointerup','pointercancel'].forEach(function(t){ b.addEventListener(t, function(e){ window.__log.push(t + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)); }, true); });
    return 'hooked'; })()`);
  await mouse('mousePressed', center.x, center.y);
  await sleep(60);
  for (let s = 1; s <= 5; s++) { await mouse('mouseMoved', center.x + (30 * ppp * s) / 5, center.y - (20 * ppp * s) / 5); await sleep(45); }
  console.log('MID_DRAG', await ev(`(function(){ var b = document.querySelector('.img-edit-box');
    return JSON.stringify({ boxes: document.querySelectorAll('.img-edit-box').length, sameEl: b === window.__boxEl, left: b ? b.style.left : 'gone', doc: window.__doc }); })()`));
  await mouse('mouseReleased', center.x + 30 * ppp, center.y - 20 * ppp);
  console.log('EVENT_LOG', await ev(`JSON.stringify(window.__log || [])`));
  console.log('REDRAW_STACKS', await ev(`JSON.stringify(window.__stacks || [])`));
  console.log('MUTATIONS', await ev(`JSON.stringify((window.__obs || []).slice(0, 25))`));
  await sleep(3000);
  console.log('TOASTS', await ev(`[...document.querySelectorAll('.toast')].map(function(t){ return t.className + ':' + t.textContent; }).join(' || ')`));
  const after = JSON.parse((await ev(`__it.bounds(${PAGE}).then(JSON.stringify)`)) || '[]');
  console.log('BEFORE', JSON.stringify(before.map((x) => x.bounds)));
  console.log('AFTER ', JSON.stringify(after.map((x) => x.bounds)));
  const movedOne = after.find((im, k) => {
    const p = before[k];
    return p && Math.abs(im.bounds[0] - (p.bounds[0] + 30)) < 3 && Math.abs(im.bounds[1] - (p.bounds[1] + 20)) < 3;
  });
  check('dragging moves the detected object by +30,+20 pt', !!movedOne, JSON.stringify(after.map((x) => x.bounds)));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const out = path.join(ROOT, '.smoke', 'real-marquee.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('SHOT', out);
}
console.log('ORIGINAL UNTOUCHED', String(fs.statSync(SRC).size));
console.log('ERRORS', JSON.stringify(errs));
console.log(problems ? `REAL_FAIL ${problems} problem(s)` : 'REAL_PASS all checks green');
ws.close(); child.kill();
process.exit(problems ? 1 : 0);
