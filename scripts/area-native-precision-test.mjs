#!/usr/bin/env node
/**
 * Area Direct Edit — pin-point precision on NATIVE (vector) PDF text.
 *
 *   node scripts/area-native-precision-test.mjs
 *
 * The user-visible bug: pdf.js returns ONE TextItem for a whole drawn line.
 * The old marquee filter kept an item when its CENTRE fell inside the box, so
 * a box over the middle of a line made the ENTIRE line editable — the words to
 * the left and right of the selection ("nearest text in line with the area").
 *
 * This suite drives the real app over a real Chrome-generated PDF:
 *   1. draws a marquee over the MIDDLE 20% of one long line;
 *   2. asserts the editable text is a strict fragment of that line, that every
 *      block rect and on-screen hit target stops at the box, and that the
 *      block is flagged as a partial source;
 *   3. commits an edit and SAVES, then re-extracts the file's text to prove
 *      the unselected words of that line were not excised. That last check is
 *      what forces the writer to fall back to a cover instead of cutting the
 *      whole show-text operator.
 *
 * No mocks: real pdf.js text content, real marquee pointer events, real save.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'real-chrome.pdf');
const PAGE = 0;

if (!fs.existsSync(FIXTURE)) { console.log('AREA_NATIVE_FAIL missing fixture ' + FIXTURE); process.exit(1); }
if (!fs.existsSync(ELECTRON)) { console.log('AREA_NATIVE_FAIL missing electron ' + ELECTRON); process.exit(1); }

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

const PORT = await freePort();
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-area-native-ud-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 300000);
bail.unref?.();

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!target) await sleep(400);
}
if (!target) { console.log('AREA_NATIVE_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const errs = [];
const send = (method, params) => new Promise((res, rej) => {
  const id = ++mid;
  pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails?.exception?.description || '').slice(0, 220));
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push((m.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 220));
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');

async function ev(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!r || r.exceptionDetails) {
    console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 400));
    return undefined;
  }
  return r.result ? r.result.value : undefined;
}
const evJson = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch { return null; } };

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1,
  buttons: type === 'mouseMoved' ? 1 : undefined,
});
const finish = (label) => {
  clearTimeout(bail);
  try { ws.close(); } catch { /* gone */ }
  try { child.kill(); } catch { /* gone */ }
  console.log(`${label}${problems ? ` ${problems} problem(s)` : ' all checks green'}`);
  process.exit(problems ? 1 : 0);
};

for (let i = 0; i < 120; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2000);
await ev(`document.querySelector('#emptyWorkspace')?.classList.add('hidden')`);

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
  async source(i) {
    const te = await import('/js/textedit.js');
    const s = await te.editableSource(i);
    return { source: s.source, blocks: s.blocks.map(function (b) {
      return { text: b.text, r: b.coverRect, own: b.ownRect, key: b.key,
        partial: !!b.partialSource, region: !!b.regionRect, items: b.itemIndices };
    }) };
  },
  async line() {
    const v = await import('/js/viewer.js');
    const tc = await v.getTextContent(${PAGE});
    const li = tc.items.findIndex(function (it) { return String(it.str || '').split(' ').length > 12; });
    const it = tc.items[li];
    return { index: li, str: it.str, x: it.transform[4], y: it.transform[5], w: it.width };
  },
  async dom() {
    const box = document.querySelector('.edit-region-box');
    const br = box ? box.getBoundingClientRect() : null;
    const hits = Array.from(document.querySelectorAll('.editable-text-block')).map(function (h) {
      const r = h.getBoundingClientRect();
      return { x0: r.left, y0: r.top, x1: r.right, y1: r.bottom };
    });
    return { box: br ? { x0: br.left, y0: br.top, x1: br.right, y1: br.bottom } : null, hits: hits };
  }
}; 'ok'`);

/* ── 0. The fixture really has one long line in ONE pdf.js TextItem ──────── */
const line = await evJson('(async () => JSON.stringify(await __it.line()))()');
check('the fixture has a whole line in one native TextItem',
  line && line.index >= 0 && line.w > 300,
  line ? `index=${line.index} words=${String(line.str).split(' ').length} width=${Math.round(line.w)}pt` : 'none');
if (!line) finish('AREA_NATIVE_FAIL');
const words = String(line.str).split(/\s+/u).filter(Boolean);
const firstWord = words[0];

const before = await evJson(`(async () => JSON.stringify(await __it.source(${PAGE})))()`);
const beforeText = (before?.blocks || []).map((b) => b.text).join('\n');
check('without a marquee the WHOLE line is editable (the old behaviour)',
  beforeText.includes(String(line.str)), JSON.stringify(beforeText.slice(0, 60)));

/* ── 1. Draw a marquee over the MIDDLE 20% of that one line ──────────────── */
const REGION = [line.x + line.w * 0.40, line.y - 5, line.x + line.w * 0.60, line.y + 12];
const armed = await ev(`(function(){ var b = Array.from(document.querySelectorAll('#ribbon .rbtn')).find(function(x){ return /area direct edit/i.test((x.getAttribute('aria-label') || x.title || '')); }); if (b) b.click(); return !!b; })()`);
check('the Area Direct Edit tool can be armed', armed === true);
await sleep(600);
check('Area Direct Edit is the active tool', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editArea')()`));

await ev(`(async () => { const v = await import('/js/viewer.js'); v.setZoom('fitPage'); return 'ok'; })()`);
await sleep(1600);
const a = await evJson(`__it.point(${PAGE}, ${REGION[0]}, ${REGION[3]}).then(JSON.stringify)`);
const b = await evJson(`__it.point(${PAGE}, ${REGION[2]}, ${REGION[1]}).then(JSON.stringify)`);
const win = await evJson(`JSON.stringify({ w: innerWidth, h: innerHeight })`);
const onScreen = (p) => p && p.x >= 0 && p.x < win.w && p.y >= 0 && p.y < win.h;
check('the marquee drag is fully on screen', onScreen(a) && onScreen(b),
  `a=(${Math.round(a?.x)},${Math.round(a?.y)}) b=(${Math.round(b?.x)},${Math.round(b?.y)}) in ${win.w}x${win.h}`);
if (!onScreen(a) || !onScreen(b)) finish('AREA_NATIVE_FAIL');

await mouse('mouseMoved', a.x, a.y);
await mouse('mousePressed', a.x, a.y);
await sleep(80);
for (let s = 1; s <= 8; s++) {
  await mouse('mouseMoved', a.x + ((b.x - a.x) * s) / 8, a.y + ((b.y - a.y) * s) / 8);
  await sleep(40);
}
await mouse('mouseReleased', b.x, b.y);

let drawn = null;
for (let i = 0; i < 80; i++) {
  drawn = await evJson(`(async () => JSON.stringify((await import('/js/store.js')).state.editRegion))()`);
  if (drawn?.rect) break;
  await sleep(250);
}
check('the drag recorded a marquee region', !!drawn?.rect,
  JSON.stringify(drawn?.rect?.map((v) => Math.round(v * 10) / 10)));
if (!drawn?.rect) finish('AREA_NATIVE_FAIL');
const BOX = drawn.rect;
await sleep(1200);

/* ── 2. Only the characters inside the box may be editable ───────────────── */
const after = await evJson(`(async () => JSON.stringify(await __it.source(${PAGE})))()`);
const area = after?.blocks || [];
const areaText = area.map((x) => x.text).join('\n');
console.log('BOX', JSON.stringify(BOX.map((v) => Math.round(v * 10) / 10)), '=>', JSON.stringify(areaText.slice(0, 90)));
check('the area uses the exact native text layer', after?.source === 'native', after?.source);
check('a partial marquee still finds text', area.length >= 1, `blocks=${area.length}`);
check('the first word of the line (to the LEFT) is not editable',
  !new RegExp(`\\b${firstWord}\\b`, 'iu').test(areaText), JSON.stringify(areaText.slice(0, 60)));
check('no tail word of the line (to the RIGHT) is editable',
  !/\b(content|stream|enough|operators)\b/iu.test(areaText), JSON.stringify(areaText.slice(0, 60)));
check('the editable text is a strict fragment of that source line',
  String(line.str).includes(areaText.trim()) && areaText.trim().length > 0
  && areaText.trim() !== String(line.str).trim(), JSON.stringify(areaText.slice(0, 60)));
check('no neighbouring line joined the area',
  !/wrap across|operators rather|Sans-serif/iu.test(areaText), JSON.stringify(areaText.slice(0, 60)));
check('every block rect stops at the marquee',
  area.every((x) => x.r[0] >= BOX[0] - 1.5 && x.r[1] >= BOX[1] - 1.5
    && x.r[2] <= BOX[2] + 1.5 && x.r[3] <= BOX[3] + 1.5),
  JSON.stringify(area.map((x) => x.r.map((v) => Math.round(v)))));
check('the owned source rect also stops at the marquee',
  area.every((x) => !x.own || (x.own[0] >= BOX[0] - 1.5 && x.own[2] <= BOX[2] + 1.5)));
check('blocks are marked as partial sources with region-scoped identity',
  area.every((x) => x.partial && x.region && String(x.key).startsWith('r:') && x.items?.length > 0),
  JSON.stringify(area.map((x) => ({ p: x.partial, r: x.region, k: x.key, i: x.items }))));

const dom = await evJson('(async () => JSON.stringify(await __it.dom()))()');
check('the app took over with the Direct Editor', await ev(`(async () => (await import('/js/store.js')).state.tool === 'editText')()`));
check('the on-screen hit targets match the area blocks',
  (dom?.hits || []).length === area.length, `dom=${dom?.hits?.length} blocks=${area.length}`);
check('no hit target reaches outside the drawn box',
  !!dom?.box && (dom.hits || []).every((h) => h.x0 >= dom.box.x0 - 6 && h.y0 >= dom.box.y0 - 6
    && h.x1 <= dom.box.x1 + 6 && h.y1 <= dom.box.y1 + 6),
  JSON.stringify({ box: dom?.box, hits: dom?.hits }));

/* ── 3. Commit + SAVE: unselected words of that line must survive ────────── */
const commit = await evJson(`(async function(){
  const te = await import('/js/textedit.js');
  const st = await import('/js/store.js');
  const s = await te.editableSource(${PAGE});
  const ok = await te.commitBlockEdit(${PAGE}, s.blocks[0], 'PRECISION');
  const e = st.activeDoc().textEdits[0];
  return JSON.stringify({ ok: ok, partial: !!e?.partialSource, region: !!e?.regionRect,
    key: e?.key, cover: e?.coverRect, bg: e?.bg });
})()`);
check('the area edit commits', commit?.ok === true, JSON.stringify(commit));
check('the committed edit keeps the partial-source flag and region identity',
  commit?.partial === true && commit?.region === true && String(commit?.key).startsWith('r:'),
  JSON.stringify(commit));
check('the committed cover stays inside the marquee',
  Array.isArray(commit?.cover) && commit.cover[0] >= BOX[0] - 1.5 && commit.cover[2] <= BOX[2] + 1.5,
  JSON.stringify(commit?.cover));
check('a real backdrop colour was sampled for the cover',
  Array.isArray(commit?.bg) && commit.bg.length === 3 && commit.bg.every(Number.isFinite),
  JSON.stringify(commit?.bg));

const save = await evJson(`(async function(){
  const st = await import('/js/store.js');
  const pw = await import('/js/pdfwrite.js');
  // buildPdf returns the Uint8Array itself (not a { bytes } wrapper).
  const bytes = await pw.buildPdf(st.activeDoc());
  const pdfjs = await import('/v/pdf.min.mjs');
  const d = await pdfjs.getDocument({ data: bytes, useSystemFonts: true }).promise;
  const tc = await (await d.getPage(1)).getTextContent();
  const text = tc.items.map(function (i) { return i.str; }).join(' ');
  await d.destroy();
  return JSON.stringify({ text: text, warnings: pw.drainExportWarnings() });
})()`);
const savedText = String(save?.text || '');
console.log('SAVED_LINE', JSON.stringify(savedText.slice(0, 130)));
check('after save the words to the LEFT of the box still exist in the file',
  savedText.includes('This paragraph exists'), JSON.stringify(savedText.slice(0, 90)));
check('after save the words to the RIGHT of the box still exist in the file',
  /content stream/.test(savedText) && /long enough/.test(savedText),
  JSON.stringify(savedText.slice(0, 160)));
check('the export reports the cover fallback instead of silently excising',
  (save?.warnings || []).some((w) => w.kind === 'cover-fallback' && w.reason === 'partial-text-item'),
  JSON.stringify(save?.warnings));
check('no console errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

finish(problems ? 'AREA_NATIVE_FAIL' : 'AREA_NATIVE_PASS');
