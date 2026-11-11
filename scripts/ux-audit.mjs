#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * UI/UX rendered audit — evidence harness.
 *
 * Boots the real Electron app over CDP with a per-run profile, then measures
 * the ACTUAL rendered interface at wide / ultrawide / minimum window sizes:
 * text contrast, type sizes, hit targets, spacing rhythm, layout overflow,
 * keyboard focus, reduced motion, theme gallery, panels and the five data
 * states. Screenshots and a JSON evidence file land in .smoke/ux-audit/.
 *
 *   node scripts/ux-audit.mjs
 *
 * This is a measurement tool, not a pass/fail gate: it never mutates source
 * and it restores every temporary DOM tweak it makes.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const OUT = path.join(ROOT, '.smoke', 'ux-audit');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const PORT = await freePort();
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-ux-audit-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
process.on('exit', () => { try { child.kill(); } catch {} });

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up yet */ }
  if (!target) await sleep(350);
}
if (!target) { console.log('UX_AUDIT_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++mid;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 25000);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  try {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r && r.exceptionDetails) return { __error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
    return r && r.result ? r.result.value : null;
  } catch (e) { return { __error: String(e) }; }
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const p = path.join(OUT, name);
  fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('SHOT ' + name + ' ' + fs.statSync(p).size + ' bytes');
  return name;
};
const viewport = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(420);
};
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(120);
};

/* ── Page-side measurement library ─────────────────────────────────────── */
const LIB = `
(function(){
  var CHROME = '.titlebar,.menubar,.ribbon,.rail,.sidebar,.context,.statusbar,.welcome,.empty-workspace,.modal,.palette,.toast-root,.focus-exit';
  function parse(s){
    s = String(s || '').trim();
    if (!s || s === 'transparent') return [0,0,0,0];
    var inner, p;
    if (s.indexOf('rgb(') === 0 || s.indexOf('rgba(') === 0) {
      inner = s.slice(s.indexOf('(') + 1, -1);
      p = inner.split(',').map(Number);
      return [p[0],p[1],p[2], p.length > 3 ? p[3] : 1];
    }
    if (s.indexOf('color(srgb') === 0) {
      inner = s.slice(s.indexOf('srgb') + 4, -1).trim();
      p = inner.split(/[\\s\\/]+/).filter(Boolean).map(Number);
      return [p[0]*255, p[1]*255, p[2]*255, p.length > 3 ? p[3] : 1];
    }
    return null;
  }
  function bgOf(el){
    var layers = [], n = el;
    while (n) {
      var c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] >= 1) break;
      n = n.parentElement;
    }
    var out = [255,255,255];
    for (var i = layers.length - 1; i >= 0; i--) {
      var c = layers[i], a = c[3];
      out = [c[0]*a + out[0]*(1-a), c[1]*a + out[1]*(1-a), c[2]*a + out[2]*(1-a)];
    }
    return out;
  }
  function lum(c){
    var v = c.map(function(x){ x = x/255; return x <= 0.03928 ? x/12.92 : Math.pow((x+0.055)/1.055, 2.4); });
    return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2];
  }
  function ratio(a,b){ var l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); }
  function visible(el){
    var c = getComputedStyle(el), r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && c.visibility !== 'hidden' && c.display !== 'none' && Number(c.opacity) > 0;
  }
  function name(el){
    var cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).slice(0,2).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  }
  function chromeRoots(){
    return Array.prototype.slice.call(document.querySelectorAll(CHROME)).filter(visible);
  }
  function leaves(){
    var out = [];
    chromeRoots().forEach(function(root){
      var all = [root].concat(Array.prototype.slice.call(root.querySelectorAll('*')));
      all.forEach(function(el){
        if (!visible(el)) return;
        if (el.closest('.page, .pages, canvas, svg, .textLayer, .annLayer')) return;
        var t = '';
        for (var i = 0; i < el.childNodes.length; i++) {
          var n = el.childNodes[i];
          if (n.nodeType === 3) t += n.nodeValue;
        }
        t = t.replace(/\\s+/g, ' ').trim();
        if (!t) return;
        out.push({ el: el, text: t.slice(0, 44) });
      });
    });
    return out;
  }
  window.__ux = {
    meta: function(){
      return {
        viewport: [innerWidth, innerHeight],
        dpr: devicePixelRatio,
        theme: document.documentElement.dataset.theme,
        skin: document.documentElement.dataset.skin || 'default',
        version: (document.getElementById('brandVer') || {}).textContent,
        booted: !!window.__aipdfBooted,
        pages: document.querySelectorAll('#pages .page').length,
        tabs: document.querySelectorAll('.tab').length,
        modeTabs: document.querySelectorAll('.mode-tab').length,
        ribbonButtons: document.querySelectorAll('.ribbon button').length
      };
    },
    text: function(){
      var rows = leaves(), total = 0, small = 0, tiny = 0, fails = [], groups = {}, sizes = {};
      rows.forEach(function(o){
        var el = o.el, c = getComputedStyle(el), size = parseFloat(c.fontSize), weight = parseInt(c.fontWeight, 10) || 400;
        var fg = parse(c.color), bg = bgOf(el);
        if (!fg) return;
        var r = ratio(fg.slice(0,3), bg);
        var need = (size >= 24 || (size >= 18.66 && weight >= 700)) ? 3 : 4.5;
        total++;
        sizes[size] = (sizes[size] || 0) + 1;
        if (size < 12) small++;
        if (size < 11) tiny++;
        if (r < need) {
          var k = c.color + '|' + Math.round(bg[0]) + ',' + Math.round(bg[1]) + ',' + Math.round(bg[2]) + '|' + size + '|' + r.toFixed(2);
          if (!groups[k]) groups[k] = { color: c.color, bg: 'rgb(' + Math.round(bg[0]) + ',' + Math.round(bg[1]) + ',' + Math.round(bg[2]) + ')', size: size, ratio: +r.toFixed(2), need: need, count: 0, examples: [] };
          groups[k].count++;
          if (groups[k].examples.length < 3) groups[k].examples.push(name(el) + ' "' + o.text + '"');
          if (fails.length < 80) fails.push({ sel: name(el), text: o.text, size: size, weight: weight, ratio: +r.toFixed(2), need: need, color: c.color });
        }
      });
      var gl = Object.keys(groups).map(function(k){ return groups[k]; }).sort(function(a,b){ return b.count - a.count; });
      return { total: total, smallUnder12: small, tinyUnder11: tiny, failCount: fails.length, groups: gl.slice(0, 18), examples: fails.slice(0, 25), sizes: sizes };
    },
    hits: function(){
      var rows = [], small = [];
      chromeRoots().forEach(function(root){
        Array.prototype.slice.call(root.querySelectorAll('button, [role="button"], select, input[type="checkbox"]')).forEach(function(b){
          if (!visible(b)) return;
          var r = b.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height);
          rows.push([w,h]);
          if (w < 32 || h < 32) small.push({ sel: name(b), w: w, h: h, label: (b.getAttribute('aria-label') || b.title || '').slice(0, 38) });
        });
      });
      var bySize = {};
      rows.forEach(function(x){ var k = x[0] + 'x' + x[1]; bySize[k] = (bySize[k] || 0) + 1; });
      return { total: rows.length, under32: small.length, bySize: bySize, examples: small.slice(0, 28) };
    },
    spacing: function(){
      var vals = {};
      chromeRoots().forEach(function(root){
        Array.prototype.slice.call(root.querySelectorAll('*')).forEach(function(el){
          if (!visible(el)) return;
          var c = getComputedStyle(el);
          ['gap','rowGap','columnGap','paddingTop','paddingRight','paddingBottom','paddingLeft'].forEach(function(prop){
            var v = parseFloat(c[prop]);
            if (!isFinite(v) || v <= 0 || v % 4 === 0) return;
            var k = prop + ':' + v;
            if (!vals[k]) vals[k] = { prop: prop, value: v, count: 0, example: name(el) };
            vals[k].count++;
          });
        });
      });
      return Object.keys(vals).map(function(k){ return vals[k]; }).sort(function(a,b){ return b.count - a.count; }).slice(0, 22);
    },
    layout: function(){
      var sels = ['.titlebar','.menubar','.quick','.modes','.mb-right','.ribbon','.rail','.sidebar','.context','.statusbar','.canvas-wrap','.modal','.modal-body','.palette'];
      var out = {};
      sels.forEach(function(s){
        var el = document.querySelector(s);
        if (!el || !visible(el)) return;
        var c = getComputedStyle(el), r = el.getBoundingClientRect();
        var kids = Array.prototype.slice.call(el.children).filter(visible).map(function(k){
          var kr = k.getBoundingClientRect();
          return { sel: name(k), right: Math.round(kr.right), w: Math.round(kr.width) };
        });
        out[s] = {
          w: Math.round(r.width), h: Math.round(r.height),
          scrollW: el.scrollWidth, clientW: el.clientWidth,
          scrollH: el.scrollHeight, clientH: el.clientHeight,
          overflowX: c.overflowX, overflowY: c.overflowY,
          overflowing: el.scrollWidth > el.clientWidth + 1,
          beyondViewport: kids.filter(function(k){ return k.right > innerWidth + 1; }).slice(0, 8)
        };
      });
      var body = document.body;
      out.__body = { scrollW: body.scrollWidth, clientW: body.clientWidth, scrollH: body.scrollHeight, clientH: body.clientHeight };
      return out;
    },
    statusOverlap: function(){
      var bar = document.querySelector('.statusbar');
      if (!bar) return null;
      var items = Array.prototype.slice.call(bar.children).filter(function(n){ var r = n.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
      var pairs = [];
      for (var i = 0; i < items.length; i++) for (var j = i+1; j < items.length; j++) {
        var a = items[i].getBoundingClientRect(), b = items[j].getBoundingClientRect();
        var ox = Math.min(a.right,b.right) - Math.max(a.left,b.left);
        var oy = Math.min(a.bottom,b.bottom) - Math.max(a.top,b.top);
        if (ox > 2 && oy > 2) pairs.push(name(items[i]) + ' <-> ' + name(items[j]) + ' (' + Math.round(ox) + 'px)');
      }
      return { items: items.length, overlapping: pairs.length, examples: pairs.slice(0, 12) };
    },
    states: function(){
      var vis = function(s){ var e = document.querySelector(s); return !!e && visible(e); };
      return {
        skeleton: document.querySelectorAll('.skeleton, [class*="skeleton"], [aria-busy="true"]').length,
        progress: document.querySelectorAll('progress, .ocr-progress, .spin').length,
        emptyWorkspace: vis('.empty-workspace'),
        emptyText: (document.querySelector('.ew-hint') || {}).textContent || '',
        emptyCTA: document.querySelectorAll('.ew-actions button').length,
        emptyIcon: vis('.ew-logo'),
        emptyState: document.querySelectorAll('.empty-state, .asr-empty, .tl-empty').length,
        toast: document.querySelectorAll('.toast').length,
        toastText: Array.prototype.slice.call(document.querySelectorAll('.toast')).map(function(n){ return n.textContent.slice(0,70); }),
        stErr: (document.getElementById('stErr') || {}).textContent || '',
        pages: document.querySelectorAll('#pages .page').length,
        canvasInk: Array.prototype.slice.call(document.querySelectorAll('.page canvas')).some(function(c){ return c.width > 0; })
      };
    },
    surfaces: function(){
      var pick = function(s){ var e = document.querySelector(s); return e ? getComputedStyle(e).backgroundColor : null; };
      return {
        body: pick('body'), app: pick('.app'), titlebar: pick('.titlebar'), menubar: pick('.menubar'),
        ribbon: pick('.ribbon'), sidebar: pick('.sidebar'), context: pick('.context'),
        statusbar: pick('.statusbar'), canvas: pick('.canvas-wrap'), modal: pick('.modal'),
        card: pick('.th-card'), text1: getComputedStyle(document.documentElement).getPropertyValue('--text-1').trim(),
        text4: getComputedStyle(document.documentElement).getPropertyValue('--text-4').trim()
      };
    },
    focus: function(){
      var a = document.activeElement;
      if (!a) return null;
      var c = getComputedStyle(a);
      return {
        sel: name(a), focusVisible: a.matches(':focus-visible'),
        outline: c.outlineWidth + ' ' + c.outlineStyle + ' ' + c.outlineColor,
        offset: c.outlineOffset, inModal: !!a.closest('.modal-backdrop')
      };
    },
    modal: function(){
      var m = document.querySelector('.modal'), g = document.querySelector('.th-grid');
      if (!m) return null;
      var r = m.getBoundingClientRect();
      return {
        rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        withinViewport: r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
        cards: document.querySelectorAll('.th-card').length,
        grid: g ? { h: Math.round(g.getBoundingClientRect().height), scrollH: g.scrollHeight, clientH: g.clientHeight, scrolls: g.scrollHeight > g.clientHeight + 2 } : null,
        cardRect: (function(){ var c = document.querySelector('.th-card'); if (!c) return null; var q = c.getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; })(),
        previewRect: (function(){ var c = document.querySelector('.th-preview'); if (!c) return null; var q = c.getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; })(),
        focusables: document.querySelectorAll('.modal-backdrop button, .modal-backdrop input, .modal-backdrop select').length,
        labelled: !!m.getAttribute('aria-labelledby'), ariaModal: m.getAttribute('aria-modal')
      };
    },
    motion: function(){
      var sels = ['.modal','.th-card','.qbtn','.tab','.toast'];
      var out = {};
      sels.forEach(function(s){
        var e = document.querySelector(s);
        if (!e) return;
        var c = getComputedStyle(e);
        out[s] = { transition: c.transitionDuration, animation: c.animationDuration, transform: c.transform };
      });
      return { reduced: matchMedia('(prefers-reduced-motion: reduce)').matches, computed: out };
    },
    longLabel: function(){
      var t = document.querySelector('.tab .t-name');
      if (!t) return { skipped: 'no tab' };
      var old = t.textContent;
      t.textContent = 'Quarterly consolidated financial statements and appendices — final review copy (region EMEA) 2026-11-11.pdf';
      var tab = t.closest('.tab').getBoundingClientRect();
      var strip = document.getElementById('tabStrip');
      var c = getComputedStyle(t), r = t.getBoundingClientRect();
      var res = {
        tabW: Math.round(tab.width), nameW: Math.round(r.width),
        overflow: c.overflow, textOverflow: c.textOverflow, whiteSpace: c.whiteSpace,
        stripScrollW: strip.scrollWidth, stripClientW: strip.clientWidth,
        bodyScrollW: document.body.scrollWidth
      };
      t.textContent = old;
      return res;
    }
  };
  return true;
})()
`;
const LIB_RESULT = await ev(LIB);
console.log('LIB ' + JSON.stringify(LIB_RESULT));

const E = {};
const step = async (name, fn) => {
  try { E[name] = await fn(); console.log('STEP ' + name + ' ok'); }
  catch (e) { E[name] = { __error: String(e) }; console.log('STEP ' + name + ' FAILED ' + e); }
};
const scan = async (tag) => {
  const r = {};
  r.meta = await ev('JSON.stringify(window.__ux.meta())');
  r.text = await ev('JSON.stringify(window.__ux.text())');
  r.hits = await ev('JSON.stringify(window.__ux.hits())');
  r.spacing = await ev('JSON.stringify(window.__ux.spacing())');
  r.layout = await ev('JSON.stringify(window.__ux.layout())');
  r.statusOverlap = await ev('JSON.stringify(window.__ux.statusOverlap())');
  r.states = await ev('JSON.stringify(window.__ux.states())');
  r.surfaces = await ev('JSON.stringify(window.__ux.surfaces())');
  for (const k of Object.keys(r)) { try { r[k] = JSON.parse(r[k]); } catch { /* keep raw */ } }
  return r;
};

for (let i = 0; i < 100; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 100; i++) { if (await ev("document.querySelectorAll('#pages .page').length > 0")) break; await sleep(300); }
await sleep(900);
// Install AFTER the renderer has settled: an early context can be discarded
// by a late navigation, which silently drops window.__ux.
const LIB_RETRY = await ev(LIB);
console.log('LIB_RETRY ' + JSON.stringify(LIB_RETRY));
E.__lib = LIB_RESULT;
E.__boot = await ev('JSON.stringify(window.__ux.meta())');
console.log('BOOT ' + E.__boot);

await step('wideLight', async () => { await viewport(1440, 900); await shot('01-wide-light.png'); return scan(); });
await step('ultrawide', async () => { await viewport(1920, 1080); await shot('02-ultrawide.png'); return scan(); });
await step('minLight', async () => { await viewport(940, 620); await shot('03-min-light.png'); return scan(); });
await step('wideDark', async () => {
  await viewport(1440, 900);
  await ev("document.getElementById('btnTheme').click()");
  await sleep(900);
  await shot('04-wide-dark.png');
  return scan();
});
await step('darkSurfaces', async () => ev('JSON.stringify(window.__ux.surfaces())'));

await step('backToLight', async () => {
  await ev("document.getElementById('btnTheme').click()");
  await sleep(700);
  await ev("window.aipdf.setTheme('default')");
  await sleep(400);
  return ev('JSON.stringify(window.__ux.meta())');
});

await step('galleryWide', async () => {
  await ev("(function(){ window.aipdf.run('view:themeGallery'); return true; })()");
  await sleep(750);
  await shot('05-gallery-wide.png');
  return { modal: await ev('JSON.stringify(window.__ux.modal())'), text: await ev('JSON.stringify(window.__ux.text())'), layout: await ev('JSON.stringify(window.__ux.layout())') };
});

await step('galleryFocus', async () => {
  const initial = await ev('JSON.stringify(window.__ux.focus())');
  const seq = [];
  for (let i = 0; i < 6; i++) { await key('Tab', 'Tab', 9); seq.push(await ev('JSON.stringify(window.__ux.focus())')); }
  await key('Escape', 'Escape', 27);
  await sleep(250);
  return { initial, seq, closed: await ev("!document.querySelector('.modal-backdrop')") };
});

await step('galleryMin', async () => {
  await ev("(function(){ window.aipdf.run('view:themeGallery'); return true; })()");
  await sleep(600);
  await viewport(940, 620);
  await shot('06-gallery-min.png');
  const m = await ev('JSON.stringify(window.__ux.modal())');
  const text = await ev('JSON.stringify(window.__ux.text())');
  await key('Escape', 'Escape', 27);
  await sleep(250);
  return { modal: m, text };
});

await step('reducedMotion', async () => {
  await viewport(1440, 900);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await ev("(function(){ window.aipdf.run('view:themeGallery'); return true; })()");
  await sleep(600);
  await shot('07-gallery-reduced.png');
  const m = await ev('JSON.stringify(window.__ux.motion())');
  await key('Escape', 'Escape', 27);
  await send('Emulation.setEmulatedMedia', { features: [] });
  await sleep(250);
  return m;
});

await step('palette', async () => {
  await ev("document.getElementById('btnPalette').click()");
  await sleep(600);
  await shot('08-palette.png');
  const r = { text: await ev('JSON.stringify(window.__ux.text())'), layout: await ev('JSON.stringify(window.__ux.layout())') };
  await key('Escape', 'Escape', 27);
  await sleep(250);
  return r;
});

await step('panelsMin', async () => {
  await viewport(940, 620);
  const panels = await ev("JSON.stringify(Array.prototype.slice.call(document.querySelectorAll('.rail-btn')).map(function(b){return b.dataset.panel;}))");
  await ev("(function(){var b=document.querySelector('.rail-btn[data-panel=\"pages\"]'); if(b) b.click(); return true;})()");
  await sleep(650);
  await shot('09-min-pages-panel.png');
  const a = { panels, layout: await ev('JSON.stringify(window.__ux.layout())'), states: await ev('JSON.stringify(window.__ux.states())'), text: await ev('JSON.stringify(window.__ux.text())') };
  await ev("(function(){var b=document.querySelector('.rail-btn[data-panel=\"comments\"]'); if(b) b.click(); return true;})()");
  await sleep(650);
  await shot('10-min-comments-panel.png');
  a.comments = { states: await ev('JSON.stringify(window.__ux.states())'), text: await ev('JSON.stringify(window.__ux.text())') };
  return a;
});

await step('longLabel', async () => {
  await viewport(1440, 900);
  const before = await ev('JSON.stringify(window.__ux.layout())');
  const r = await ev('JSON.stringify(window.__ux.longLabel())');
  await shot('11-long-label-restored.png');
  return { before: before && before['.titlebar'], measured: r };
});

await step('errorToast', async () => {
  await ev("import('/js/util.js').then(function(m){ m.toast('Could not open: the PDF is damaged or encrypted', 'err', 8000); })");
  await sleep(500);
  await shot('12-error-toast.png');
  const r = { states: await ev('JSON.stringify(window.__ux.states())'), text: await ev('JSON.stringify(window.__ux.text())') };
  return r;
});

await step('emptyState', async () => {
  await ev("window.aipdf.run('file:close')");
  await sleep(900);
  await shot('13-empty-light.png');
  const light = { states: await ev('JSON.stringify(window.__ux.states())'), text: await ev('JSON.stringify(window.__ux.text())'), layout: await ev('JSON.stringify(window.__ux.layout())') };
  await ev("document.getElementById('btnTheme').click()");
  await sleep(800);
  await shot('14-empty-dark.png');
  const dark = { states: await ev('JSON.stringify(window.__ux.states())'), text: await ev('JSON.stringify(window.__ux.text())') };
  return { light, dark };
});

await step('contrastSkin', async () => {
  await ev("window.aipdf.setTheme('contrast')");
  await sleep(500);
  await shot('15-contrast-skin.png');
  const r = { text: await ev('JSON.stringify(window.__ux.text())'), surfaces: await ev('JSON.stringify(window.__ux.surfaces())') };
  await ev("window.aipdf.setTheme('default')");
  return r;
});

fs.writeFileSync(path.join(OUT, 'evidence.json'), JSON.stringify(E, null, 2));
console.log('EVIDENCE ' + path.join(OUT, 'evidence.json'));
ws.close();
child.kill();
process.exit(0);
