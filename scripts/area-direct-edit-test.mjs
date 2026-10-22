#!/usr/bin/env node
/**
 * Area Direct Edit — acceptance test on ONE supplied PDF.
 *
 *   node scripts/area-direct-edit-test.mjs "D:/Advertisement/ad/Ok/3/Sunmoon Media 4x12 Gorakha sadak yojana.pdf"
 *
 * The PDF is one full-page scan, so before this feature a marquee selected the
 * entire page image. The contract now:
 *
 *   - a marquee INSIDE an image selects only the image content in that box;
 *   - white margins inside the box are NOT part of the selection;
 *   - a box over blank paper selects nothing and says why;
 *   - "New layer" lifts the selected pixels into a real PDF OCG layer with
 *     white background removed, and fills the page area white underneath;
 *   - hiding the layer leaves the white fill; showing it brings the picture
 *     back, while the rest of the original image is never cropped.
 *
 * The document is opened from a temp copy. The original file is hashed before
 * and after, and must be untouched.
 *
 * Expected content bounds were measured independently from the embedded JPEG
 * (Pillow, threshold 246): the state emblem inside the probe marquee
 * (10,255)-(95,334) occupies [36.54, 280.98, 86.22, 326.34] PDF points.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED = !!process.env.AIPDF_EXE;
const EXE = PACKAGED
  ? path.resolve(process.env.AIPDF_EXE)
  : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const SRC = process.argv[2];
if (!SRC || !fs.existsSync(SRC)) {
  console.log('FAIL missing pdf: node scripts/area-direct-edit-test.mjs <file.pdf>');
  process.exit(1);
}
if (!fs.existsSync(EXE)) {
  console.log('FAIL missing executable: ' + EXE);
  process.exit(1);
}

const PAGE = 0;
const PAGE_W = 453.6;
const PAGE_H = 340.2;
const PROBE = [10, 255, 95, 334];         // PDF marquee around the emblem + white margin
const BLANK = [10, 240, 40, 254];         // all-white patch above the banner
const EXPECT = [36.54, 280.98, 86.22, 326.34]; // independently measured emblem bounds
const P_INSIDE = [59.4, 307.8];           // dark emblem pixel
const P_BANNER = [100, 224];              // dark banner pixel OUTSIDE the probe
const P_BANNER_LEFT = [70, 224];          // same, inside the area's x-range (catches overpaint)
const P_HEADER = [213.84, 329.4];         // dark header glyph OUTSIDE the probe
const P_TABLE = [226.8, 26.5];            // dark table rule OUTSIDE the probe

const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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

const originalHash = sha(SRC);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-area-'));
const COPY = path.join(TMP, path.basename(SRC));
fs.copyFileSync(SRC, COPY);
const copyHash = sha(COPY);
const PORT = await freePort();
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-area-ud-'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const launch = PACKAGED
  ? [COPY, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`]
  : ['.', COPY, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`];
const child = spawn(EXE, launch, { cwd: ROOT, env });
child.stderr.on('data', () => {});
child.stdout.on('data', () => {});
setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 240000).unref?.();

const target = await (async () => {
  for (let i = 0; i < 120; i++) {
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
let mid = 0;
const pending = new Map();
const errs = [];
const send = (method, params) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 220));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 220));
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r || r.exceptionDetails) {
    console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 400));
    return undefined;
  }
  return r.result ? r.result.value : undefined;
}

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1,
  buttons: type === 'mouseMoved' ? 1 : undefined,
});

for (let i = 0; i < 120; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
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
    const out = s.images.map(function (im) { return { name: im.name, bounds: im.bounds, clipped: im.clipped }; });
    closeNativeImageSession(s);
    return out;
  },
  async dialog() {
    return [...document.querySelectorAll('.img-toolbar')].map(function (bar) {
      return {
        text: bar.textContent.replace(/\\s+/g, ' ').trim(),
        buttons: [...bar.querySelectorAll('button')].map(function (b) { return { text: b.textContent.trim(), disabled: b.disabled }; }),
      };
    });
  },
  box() {
    var b = document.querySelector('.img-edit-box');
    if (!b) return null;
    var r = b.getBoundingClientRect();
    return {
      w: Math.round(r.width), h: Math.round(r.height), left: r.left, top: r.top,
      right: r.right, bottom: r.bottom,
      area: b.classList.contains('img-edit-area'),
      readonly: b.classList.contains('img-readonly'),
      handles: document.querySelectorAll('.img-handle').length,
      note: (document.querySelector('.img-area-note') || {}).textContent || '',
    };
  },
  async pixel(i, x, y) {
    const v = await this.vp(i);
    const cv = document.querySelector('.page[data-i="' + i + '"] canvas.pdf');
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const q = v.convertToViewportPoint(x, y);
    const sx = cv.width / v.width, sy = cv.height / v.height;
    const d = ctx.getImageData(
      Math.max(0, Math.min(cv.width - 1, Math.round(q[0] * sx))),
      Math.max(0, Math.min(cv.height - 1, Math.round(q[1] * sy))), 1, 1,
    ).data;
    return [d[0], d[1], d[2]];
  },
  async docHash() {
    const { activeDoc } = await import('/js/store.js');
    const d = await crypto.subtle.digest('SHA-256', activeDoc().bytes);
    return [...new Uint8Array(d)].map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  },
  async layers() {
    const { activeDoc } = await import('/js/store.js');
    const cfg = await activeDoc().pdf.getOptionalContentConfig();
    const raw = cfg && cfg.getGroups ? cfg.getGroups() : null;
    const entries = raw instanceof Map ? [...raw.entries()] : Object.entries(raw || {});
    return entries.map(function (e) { return { id: e[0], name: e[1].name, visible: e[1].visible !== false }; });
  },
  async layerAudit() {
    const { activeDoc } = await import('/js/store.js');
    const PL = await import('/v/pdf-lib.js');
    const d = await PL.PDFDocument.load(activeDoc().bytes);
    const groups = d.getOptionalContentGroups().map(function (g) {
      return { name: g.name, visible: g.visible, ref: String(g.ref) };
    });
    const page = d.getPage(0);
    const resources = page.node.Resources();
    const images = [];
    if (resources) {
      const raw = resources.get(PL.PDFName.of('XObject'));
      const xo = raw ? d.context.lookup(raw) : null;
      if (xo && xo.keys) {
        for (const key of xo.keys()) {
          const obj = d.context.lookup(xo.get(key));
          const dict = obj instanceof PL.PDFDict ? obj : obj && obj.dict;
          const subtype = dict && dict.get(PL.PDFName.of('Subtype'));
          if (subtype && subtype.toString() === '/Image') {
            images.push({ name: key.decodeText(), smask: !!dict.get(PL.PDFName.of('SMask')) });
          }
        }
      }
    }
    return { groups, images };
  }
}; 'ok'`);

const evJson = async (expr) => {
  const s = await ev(expr);
  try { return JSON.parse(s); } catch { return null; }
};
const boxOf = () => evJson('JSON.stringify(__it.box())');
const waitBox = async (want = true, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    const b = await boxOf();
    if (!!b === want) return b;
    await sleep(250);
  }
  return await boxOf();
};
const rectOf = () => ev(`(function(){ var cv=document.querySelector('.page[data-i="${PAGE}"] canvas.pdf'); if(!cv) return ''; var r=cv.getBoundingClientRect(); return [r.left,r.top,r.width,r.height].join(','); })()`);
async function settle() {
  let last = null, same = 0;
  for (let i = 0; i < 40; i++) {
    const now = await rectOf();
    same = now && now === last ? same + 1 : 0;
    if (same >= 3) return true;
    last = now;
    await sleep(200);
  }
  return false;
}
async function point(x, y) {
  await settle();
  return evJson(`__it.point(${PAGE}, ${x}, ${y}).then(JSON.stringify)`);
}
async function marquee(a, b) {
  await mouse('mouseMoved', a.x, a.y);
  await sleep(60);
  await mouse('mousePressed', a.x, a.y);
  await sleep(80);
  for (let s = 1; s <= 8; s++) {
    await mouse('mouseMoved', a.x + ((b.x - a.x) * s) / 8, a.y + ((b.y - a.y) * s) / 8);
    await sleep(40);
  }
  await mouse('mouseReleased', b.x, b.y);
}
async function toastText() {
  return ev(`[...document.querySelectorAll('.toast')].map(function (t) { return t.textContent; }).join(' | ')`);
}
async function lum(x, y) {
  const rgb = await evJson(`__it.pixel(${PAGE}, ${x}, ${y}).then(JSON.stringify)`);
  return rgb ? (rgb[0] + rgb[1] + rgb[2]) / 3 : null;
}
async function waitLum(fn, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  return null;
}

console.log('FILE', SRC);
console.log('BUILD', PACKAGED ? EXE : 'source tree');
if (process.env.AIPDF_EXPECT_VERSION) {
  const shown = await ev(`(document.getElementById('brandVer') || {}).textContent || ''`);
  const expected = 'v' + process.env.AIPDF_EXPECT_VERSION;
  check(`the running build reports ${expected}`, String(shown).trim() === expected, JSON.stringify(shown));
}
console.log('PAGES', await ev(`(async () => (await import('/js/store.js')).activeDoc().numPages)()`));
const imgs0 = (await evJson(`__it.bounds(${PAGE}).then(JSON.stringify)`)) || [];
console.log('PLACEMENTS', JSON.stringify(imgs0));
check('the supplied PDF has one full-page image placement',
  imgs0.length === 1 && Math.abs(imgs0[0].bounds[2] - PAGE_W) < 1 && Math.abs(imgs0[0].bounds[3] - PAGE_H) < 1 && !imgs0[0].clipped,
  JSON.stringify(imgs0));

await ev(`(function(){ var b = document.querySelector('#ribbon button[aria-label="Edit object"]'); if (b) b.click(); return !!b; })()`);
await sleep(400);
check('Edit image tool is armed', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editImage')()`));

await ev(`(async () => { const v = await import('/js/viewer.js'); v.setZoom('fitPage'); return 'ok'; })()`);
await sleep(1800);
await settle();

const win = await evJson(`JSON.stringify({ w: innerWidth, h: innerHeight })`);
const a = await point(PROBE[0], PROBE[1]);
const b = await point(PROBE[2], PROBE[3]);
const onScreen = (p) => p && p.x >= 0 && p.x < win.w && p.y >= 0 && p.y < win.h;
check('the probe marquee is fully on screen', onScreen(a) && onScreen(b),
  `a=(${Math.round(a?.x)},${Math.round(a?.y)}) b=(${Math.round(b?.x)},${Math.round(b?.y)}) in ${win.w}x${win.h}`);

/* 1. The emblem area: a box with white margins on every side. */
await marquee(a, b);
const box = await waitBox(true);
const dialogs = (await evJson('(async () => JSON.stringify(await __it.dialog()))()')) || [];
const buttons = dialogs[0]?.buttons?.map((x) => x.text) || [];
console.log('AREA_BOX', JSON.stringify(box));
console.log('AREA_TOOLBAR', JSON.stringify(dialogs));
check('a marquee inside the image creates an area selection', !!box && box.area && box.handles === 0,
  box ? `area=${box.area} handles=${box.handles}` : 'no box');
check('the area toolbar is the Area Direct Edit toolbar', box?.note === 'Area Direct Edit'
  && ['New layer', 'Keep area', 'Whole image', 'Cancel'].every((t) => buttons.includes(t)),
  `note=${JSON.stringify(box?.note)} buttons=${JSON.stringify(buttons)}`);

const ppp = await ev(`(function(){ var cv = document.querySelector('.page[data-i="${PAGE}"] canvas.pdf'); return cv.getBoundingClientRect().width / ${PAGE_W}; })()`);
const fullPage = { w: PAGE_W * ppp, h: PAGE_H * ppp };
const marqueeRect = {
  left: Math.min(a.x, b.x), top: Math.min(a.y, b.y),
  right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y),
};
console.log('PP PX', ppp, 'FULL', JSON.stringify(fullPage), 'MARQUEE', JSON.stringify(marqueeRect));
check('the selection is not the whole page image',
  !!box && box.w < fullPage.w * 0.3 && box.h < fullPage.h * 0.3,
  box ? `${box.w}x${box.h}px vs page ${Math.round(fullPage.w)}x${Math.round(fullPage.h)}px` : '');
check('white margins are excluded on all four sides',
  !!box && box.left > marqueeRect.left + 6 && box.top > marqueeRect.top + 6
  && box.right < marqueeRect.right - 6 && box.bottom < marqueeRect.bottom - 6,
  box ? `margins L${Math.round(box.left - marqueeRect.left)} T${Math.round(box.top - marqueeRect.top)} R${Math.round(marqueeRect.right - box.right)} B${Math.round(marqueeRect.bottom - box.bottom)}px` : '');
const wantW = (EXPECT[2] - EXPECT[0]) * ppp;
const wantH = (EXPECT[3] - EXPECT[1]) * ppp;
check('the selection hugs the measured emblem (not the marquee)',
  !!box && Math.abs(box.w - wantW) <= 12 && Math.abs(box.h - wantH) <= 12,
  box ? `${box.w}x${box.h}px vs measured ${Math.round(wantW)}x${Math.round(wantH)}px` : '');

const shot1 = await send('Page.captureScreenshot', { format: 'png' });
if (shot1?.data) {
  const out = path.join(ROOT, '.smoke', 'area-direct-edit-before.png');
  fs.writeFileSync(out, Buffer.from(shot1.data, 'base64'));
  console.log('SHOT', out);
}

/* 2. The area edit can step back to the whole object. */
const wholeClicked = await ev(`(function(){ var b = [...document.querySelectorAll('.img-toolbar button')].find(function (x) { return x.textContent.trim() === 'Whole image'; }); if (!b) return false; b.click(); return true; })()`);
check('Whole image was clicked', wholeClicked === true);
const wholeBox = await waitBox(true);
check('Whole image restores the whole-object selection',
  !!wholeBox && !wholeBox.area && wholeBox.handles === 4
  && Math.abs(wholeBox.w - fullPage.w) <= 8 && Math.abs(wholeBox.h - fullPage.h) <= 8,
  wholeBox ? `area=${wholeBox.area} handles=${wholeBox.handles} ${wholeBox.w}x${wholeBox.h}px` : 'no box');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
check('Escape clears the whole-object selection', !(await waitBox(false, 30)));

/* 3. White paper is not content. */
const c = await point(BLANK[0], BLANK[1]);
const d = await point(BLANK[2], BLANK[3]);
await marquee(c, d);
const gone = await waitBox(false, 40);
const blankToast = await toastText();
console.log('BLANK_TOAST', blankToast);
check('a marquee over white paper selects nothing', !gone);
check('and it explains that white background is not selected',
  /white background is not selected/i.test(blankToast), blankToast);

/* 4. Put the emblem area in a new PDF layer. */
await marquee(a, b);
const box2 = await waitBox(true);
check('the area can be selected again after a blank miss', !!box2 && box2.area);

const hashBefore = await ev('__it.docHash()');
const beforePx = {
  inside: await lum(...P_INSIDE), banner: await lum(...P_BANNER),
  bannerLeft: await lum(...P_BANNER_LEFT), header: await lum(...P_HEADER), table: await lum(...P_TABLE),
};
check('the page is dark inside and outside the area before the layer',
  beforePx.inside < 180 && beforePx.banner < 180 && beforePx.bannerLeft < 180
  && beforePx.header < 180 && beforePx.table < 180,
  JSON.stringify(beforePx));

const clicked = await ev(`(function(){ var b = [...document.querySelectorAll('.img-toolbar button')].find(function (x) { return x.textContent.trim() === 'New layer'; }); if (!b) return false; b.click(); return true; })()`);
check('New layer was clicked', clicked === true);

let committed = 0;
for (let i = 0; i < 100; i++) {
  const after = (await evJson(`__it.bounds(${PAGE}).then(JSON.stringify)`)) || [];
  const lifted = after.find((o) => o.name !== imgs0[0].name && !o.clipped);
  if (after.length === 2 && lifted) { committed = after.length; break; }
  await sleep(300);
}
const afterImgs = (await evJson(`__it.bounds(${PAGE}).then(JSON.stringify)`)) || [];
const committedToast = await toastText();
const lifted = afterImgs.find((o) => o.name !== imgs0[0].name && !o.clipped);
const source = afterImgs.find((o) => o.name === imgs0[0].name);
console.log('AFTER_LAYER', JSON.stringify(afterImgs), 'TOAST', committedToast);
check('New layer creates a second image placement at the selected area',
  committed === 2 && !!lifted
  && Math.abs(lifted.bounds[0] - EXPECT[0]) <= 1.5 && Math.abs(lifted.bounds[1] - EXPECT[1]) <= 1.5
  && Math.abs(lifted.bounds[2] - EXPECT[2]) <= 1.5 && Math.abs(lifted.bounds[3] - EXPECT[3]) <= 1.5,
  JSON.stringify(lifted));
check('the source image is left untouched (the area is filled white, not cut)',
  !!source && source.clipped === false && Math.abs(source.bounds[2] - PAGE_W) < 1,
  JSON.stringify(source));
let liftedBox = null;
for (let i = 0; i < 60; i++) {
  const b2 = await boxOf();
  if (b2 && !b2.area && b2.handles === 4 && Math.abs(b2.w - wantW) <= 14 && Math.abs(b2.h - wantH) <= 14) { liftedBox = b2; break; }
  await sleep(250);
}
check('the new layer image is selected and independently editable',
  !!liftedBox && !liftedBox.area && liftedBox.handles === 4,
  liftedBox ? `area=${liftedBox.area} handles=${liftedBox.handles} ${liftedBox.w}x${liftedBox.h}px` : 'not selected');
check('the UI says the area was placed in a layer',
  /Placed in new layer "Image area 1"/i.test(committedToast), committedToast);

const layers = (await evJson('(async () => JSON.stringify(await __it.layers()))()')) || [];
const layer = layers.find((l) => l.name === 'Image area 1');
console.log('LAYERS', JSON.stringify(layers));
check('a real PDF optional-content layer was registered', !!layer && layer.visible !== false, JSON.stringify(layers));
const audit = await evJson('(async () => JSON.stringify(await __it.layerAudit()))()');
console.log('LAYER_AUDIT', JSON.stringify(audit));
check('the saved document lists the new layer', !!audit && audit.groups.some((g) => g.name === 'Image area 1' && g.visible !== false), JSON.stringify(audit?.groups));
check('the layer image carries transparent whitespace',
  !!audit && !!lifted && audit.images.some((i) => i.name === lifted.name && i.smask),
  JSON.stringify(audit?.images));

/* 5. The layer is on: the selected picture shows, the rest of the page is
 *    unchanged because the source image was not cropped. */
const onPx = {
  inside: await lum(...P_INSIDE), banner: await lum(...P_BANNER),
  bannerLeft: await lum(...P_BANNER_LEFT), header: await lum(...P_HEADER), table: await lum(...P_TABLE),
};
console.log('PIXELS_LAYER_ON', JSON.stringify(onPx));
check('the selected picture is visible in the layer', onPx.inside != null && onPx.inside < 180, String(onPx.inside));
check('the rest of the page is unchanged',
  onPx.banner < 180 && onPx.bannerLeft < 180 && onPx.header < 180 && onPx.table < 180, JSON.stringify(onPx));

const shotLayer = await send('Page.captureScreenshot', { format: 'png' });
if (shotLayer?.data) {
  const out = path.join(ROOT, '.smoke', 'area-direct-edit-layer.png');
  fs.writeFileSync(out, Buffer.from(shotLayer.data, 'base64'));
  console.log('SHOT', out);
}

/* 6. The Layers panel really controls it: hide → white hole; show → picture.
 *    Creating the layer opens the panel itself; asking again would toggle it
 *    closed (setSidebar is a toggle), so only inspect it here. */
let layerRow = false;
for (let i = 0; i < 60; i++) {
  layerRow = await ev(`[...document.querySelectorAll('.layer-row')].some(function (r) { return r.textContent.includes('Image area 1'); })`);
  if (layerRow) break;
  await sleep(250);
}
check('the Layers panel lists the new layer', layerRow === true);

const hideClicked = await ev(`(function(){ var r = [...document.querySelectorAll('.layer-row')].find(function (x) { return x.textContent.includes('Image area 1'); }); if (!r) return false; var cb = r.querySelector('input'); if (!cb) return false; cb.click(); return true; })()`);
check('the layer visibility checkbox was clicked', hideClicked === true);
const hiddenPx = await waitLum(async () => {
  const inside = await lum(...P_INSIDE);
  const banner = await lum(...P_BANNER);
  const bannerLeft = await lum(...P_BANNER_LEFT);
  return inside > 240 && banner < 180 && bannerLeft < 180 ? { inside, banner, bannerLeft } : null;
});
console.log('PIXELS_LAYER_OFF', JSON.stringify(hiddenPx));
check('hiding the layer leaves the white background in the hole', !!hiddenPx && hiddenPx.inside > 240, String(hiddenPx?.inside));
check('the rest of the page stays visible while the layer is hidden',
  !!hiddenPx && hiddenPx.banner < 180 && hiddenPx.bannerLeft < 180,
  JSON.stringify(hiddenPx));

if (process.env.AREA_DEBUG) {
  const rows = [];
  for (let y = 268; y <= 336; y += 4) {
    let row = '';
    for (let x = 28; x <= 98; x += 3) {
      const v = await lum(x, y);
      row += v < 100 ? '#' : v < 240 ? '+' : '.';
    }
    rows.push(String(y).padStart(3) + ' ' + row);
  }
  console.log('PIXEL_MAP x=28..98 step3\n' + rows.join('\n'));
  await sleep(2000);
  const rows2 = [];
  for (let y = 268; y <= 336; y += 4) {
    let row = '';
    for (let x = 28; x <= 98; x += 3) {
      const v = await lum(x, y);
      row += v < 100 ? '#' : v < 240 ? '+' : '.';
    }
    rows2.push(String(y).padStart(3) + ' ' + row);
  }
  console.log('PIXEL_MAP_2S x=28..98 step3\n' + rows2.join('\n'));
  const detached = await ev(`(async () => {
    const { activeDoc } = await import('/js/store.js');
    const doc = activeDoc();
    const page = await doc.pdf.getPage(1);
    const vp = page.getViewport({ scale: 3 });
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp, optionalContentConfigPromise: doc.ocgConfigPromise || undefined }).promise;
    const sample = (x, y) => {
      const p = vp.convertToViewportPoint(x, y);
      const d = ctx.getImageData(Math.round(p[0]), Math.round(p[1]), 1, 1).data;
      return Math.round((d[0] + d[1] + d[2]) / 3);
    };
    const map = [];
    for (let y = 268; y <= 336; y += 4) {
      let row = '';
      for (let x = 28; x <= 98; x += 3) {
        const v = sample(x, y);
        row += v < 100 ? '#' : v < 240 ? '+' : '.';
      }
      map.push(String(y).padStart(3) + ' ' + row);
    }
    return map.join(String.fromCharCode(10));
  })()`);
  console.log('DETACHED_MAP_LAYER_OFF\n' + detached);
  console.log('BOX_AFTER_HIDE', JSON.stringify(await boxOf()));
  if (await ev('!!(window.api && window.api.writeFile)')) {
    const saved = await ev(`(async () => { const bytes = (await import('/js/store.js')).activeDoc().bytes; return await window.api.writeFile(${JSON.stringify(path.join(ROOT, '.smoke', 'area-layer-output.pdf'))}, bytes); })()`);
    console.log('SAVE_RESULT', JSON.stringify(saved));
    console.log('SAVED', path.join(ROOT, '.smoke', 'area-layer-output.pdf'));
  }
}

const shotHidden = await send('Page.captureScreenshot', { format: 'png' });
if (shotHidden?.data) {
  const out = path.join(ROOT, '.smoke', 'area-direct-edit-layer-hidden.png');
  fs.writeFileSync(out, Buffer.from(shotHidden.data, 'base64'));
  console.log('SHOT', out);
}

const showClicked = await ev(`(function(){ var r = [...document.querySelectorAll('.layer-row')].find(function (x) { return x.textContent.includes('Image area 1'); }); if (!r) return false; var cb = r.querySelector('input'); if (!cb) return false; cb.click(); return true; })()`);
check('the layer was shown again', showClicked === true);
const shownPx = await waitLum(async () => {
  const inside = await lum(...P_INSIDE);
  return inside < 180 ? { inside } : null;
});
check('showing the layer brings the picture back', !!shownPx && shownPx.inside < 180, String(shownPx?.inside));

const hashAfter = await ev('__it.docHash()');
check('the document bytes changed', !!hashBefore && !!hashAfter && hashBefore !== hashAfter,
  `${String(hashBefore).slice(0, 12)}… -> ${String(hashAfter).slice(0, 12)}…`);
check('the page count survived the commit', await ev(`(async () => (await import('/js/store.js')).activeDoc().numPages)()`) === 1);

const finalSrcHash = sha(SRC);
check('the supplied original is untouched', finalSrcHash === originalHash && sha(COPY) === copyHash,
  `src=${finalSrcHash.slice(0, 12)}… copy=${sha(COPY).slice(0, 12)}…`);

check('no console errors', errs.length === 0, JSON.stringify(errs));
console.log('ERRORS', JSON.stringify(errs));
console.log(problems ? `AREA_TEST_FAIL ${problems} problem(s)` : 'AREA_TEST_PASS all checks green');
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
