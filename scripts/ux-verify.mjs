#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Rendered regression gate for the 2026-11-11 UI/UX audit fixes.
 *
 * ux-audit.mjs measures element rectangles; this probe checks the things a
 * rectangle cannot prove: that the minimum-size controls are actually
 * clickable, that the mode row really scrolls, that the expanded hit boxes
 * receive pointer hits, and that colour skins are no longer shadowed by the
 * legacy body.dark token bundle on body descendants.
 *
 *   node scripts/ux-verify.mjs
 *
 * Exits 0 only when every assertion passes. Uses a per-run os.tmpdir()
 * profile, never mutates source, and writes one clipped screenshot.
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
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-ux-verify-'));
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
if (!target) { console.log('UX_VERIFY_FAIL no renderer target'); child.kill(); process.exit(1); }

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
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
  return r && r.result ? r.result.value : null;
};
const viewport = async (w, h) => {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(420);
};

for (let i = 0; i < 100; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 100; i++) { if (await ev("document.querySelectorAll('#pages .page').length > 0")) break; await sleep(300); }
await sleep(700);

/* ── Page-side helpers ───────────────────────────────────────────────────── */
await ev(`(function(){
  function parse(s){
    s = String(s || '').trim();
    if (!s || s === 'transparent') return [0,0,0,0];
    var p;
    if (s.indexOf('rgb(') === 0 || s.indexOf('rgba(') === 0) {
      p = s.slice(s.indexOf('(') + 1, -1).split(',').map(Number);
      return [p[0],p[1],p[2], p.length > 3 ? p[3] : 1];
    }
    if (s.indexOf('color(srgb') === 0) {
      p = s.slice(s.indexOf('srgb') + 4, -1).trim().split(/[\\s\\/]+/).filter(Boolean).map(Number);
      return [p[0]*255, p[1]*255, p[2]*255, p.length > 3 ? p[3] : 1];
    }
    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
      return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16), 1];
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
  function ratio(a,b){
    function lum(c){ var v = c.map(function(x){ x=x/255; return x<=0.03928?x/12.92:Math.pow((x+0.055)/1.055,2.4); }); return .2126*v[0]+.7152*v[1]+.0722*v[2]; }
    var l1 = lum(a), l2 = lum(b);
    return (Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05);
  }
  window.__uxv = {
    parse: parse, bgOf: bgOf, ratio: ratio,
    hitTest: function(sel, dx, dy){
      var el = document.querySelector(sel);
      if (!el) return { ok:false, why:'missing' };
      var r = el.getBoundingClientRect();
      var x = r.left + dx, y = r.top + dy;
      var hit = document.elementFromPoint(x, y);
      return { ok: !!(hit && (hit === el || el.contains(hit))), hit: hit ? hit.tagName.toLowerCase()+'.'+(hit.className||'') : null, at:[Math.round(x),Math.round(y)] };
    }
  };
  return true;
})()`);

const checks = [];
const check = (name, value, detail = '') => {
  const ok = value === true || (typeof value === 'number' && !Number.isNaN(value));
  checks.push({ name, ok, value, detail });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  ' + detail : ''));
};

/* ── 1. Minimum window: pinned controls, scrollable tab row, wider canvas ── */
await viewport(940, 620);
const min = await ev(`(function(){
  var mb = document.querySelector('.menubar'), modes = document.querySelector('.modes');
  var right = document.querySelector('.mb-right');
  /* The findbar lives inside .mb-right but is display:none until opened. */
  var btns = Array.prototype.slice.call(right.querySelectorAll('button')).filter(function(b){
    var r = b.getBoundingClientRect(); return r.width > 2 && r.height > 2;
  });
  var hits = btns.map(function(b){
    var r = b.getBoundingClientRect();
    var h = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return { id: b.id || b.className, right: Math.round(r.right), clickable: !!(h && (h===b || b.contains(h))) };
  });
  return {
    menubarScrollW: mb.scrollWidth, menubarClientW: mb.clientWidth,
    bodyScrollW: document.body.scrollWidth, innerW: innerWidth,
    modesOverflowX: getComputedStyle(modes).overflowX,
    modesScrollW: modes.scrollWidth, modesClientW: modes.clientWidth,
    canvasW: Math.round(document.querySelector('.canvas-wrap').getBoundingClientRect().width),
    rightButtons: hits
  };
})()`);
console.log('MIN ' + JSON.stringify(min));
check('menubar fits viewport', min.menubarScrollW <= min.menubarClientW + 1, `${min.menubarScrollW}/${min.menubarClientW}`);
check('body has no horizontal overflow', min.bodyScrollW <= min.innerW + 1, `${min.bodyScrollW}/${min.innerW}`);
check('mode row scrolls horizontally', min.modesOverflowX === 'auto' && min.modesScrollW > min.modesClientW, `${min.modesScrollW}/${min.modesClientW}`);
check('all right-side controls on screen', min.rightButtons.every((b) => b.right <= 940), JSON.stringify(min.rightButtons.map((b) => b.right)));
check('all right-side controls hit-testable', min.rightButtons.length > 0 && min.rightButtons.every((b) => b.clickable), JSON.stringify(min.rightButtons));
check('document canvas >= 450px at minimum', min.canvasW >= 450, `${min.canvasW}px`);

const scrollEnd = await ev(`(function(){
  var m = document.querySelector('.modes');
  m.scrollLeft = m.scrollWidth;
  var last = m.querySelector('.mode-tab:last-child');
  var r = last.getBoundingClientRect(), mr = m.getBoundingClientRect();
  return { scrollLeft: Math.round(m.scrollLeft), lastRight: Math.round(r.right), modesRight: Math.round(mr.right), visible: r.right <= mr.right + 2 && r.left >= mr.left - 2 };
})()`);
console.log('SCROLL_END ' + JSON.stringify(scrollEnd));
check('last mode tab reachable by scrolling', scrollEnd.visible);

const clip = await send('Page.captureScreenshot', {
  format: 'png', captureBeyondViewport: false,
  clip: { x: 690, y: 0, width: 250, height: 76, scale: 2 },
});
fs.writeFileSync(path.join(OUT, '16-verify-menubar-min.png'), Buffer.from(clip.data, 'base64'));

/* ── 2. Hit-target expansion (pseudo-element pointer boxes) ─────────────── */
/* Probe well INSIDE the expanded box: a point exactly on the pseudo's edge
   is boundary-ambiguous in Chromium and resolves to the underlying ancestor. */
const pseudo = await ev(`(function(){
  var el = document.querySelector('.qbtn');
  var c = getComputedStyle(el), a = getComputedStyle(el, '::after');
  return { buttonPosition: c.position, content: a.content, afterPosition: a.position, afterTop: a.top };
})()`);
console.log('PSEUDO ' + JSON.stringify(pseudo));
const hitTop = await ev(`JSON.stringify(window.__uxv.hitTest('.qbtn', 15, -1))`);
const hitLeft = await ev(`JSON.stringify(window.__uxv.hitTest('.qbtn', -0.5, 14))`);
const hitClose = await ev(`JSON.stringify(window.__uxv.hitTest('.tab .t-close', 12, -2))`);
for (const [label, raw] of [['icon button 1px above rect', hitTop], ['icon button 0.5px left of rect', hitLeft], ['tab close 2px above rect', hitClose]]) {
  const h = JSON.parse(raw);
  check(label + ' receives the hit', h.ok, JSON.stringify(h));
}

/* ── 3. --text-4 contrast on the smallest chrome label ──────────────────── */
const smallText = await ev(`(function(){
  var el = document.querySelector('.rtitle');
  if (!el) return null;
  var fg = window.__uxv.parse(getComputedStyle(el).color), bg = window.__uxv.bgOf(el);
  return { ratio: +window.__uxv.ratio(fg.slice(0,3), bg).toFixed(2), size: getComputedStyle(el).fontSize, color: getComputedStyle(el).color };
})()`);
console.log('RTITLE ' + JSON.stringify(smallText));
check('9px ribbon group title >= 4.5:1', !!smallText && smallText.ratio >= 4.5, JSON.stringify(smallText));

/* ── 4. Dark mode: thumbnail badge ink + skin cascade ───────────────────── */
await ev(`document.getElementById('btnTheme').click()`);
await sleep(700);
await viewport(1440, 900);
const pnum = await ev(`(function(){
  var el = document.querySelector('.thumb .pnum');
  if (!el) return null;
  var fg = window.__uxv.parse(getComputedStyle(el).color), bg = window.__uxv.bgOf(el);
  return { ratio: +window.__uxv.ratio(fg.slice(0,3), bg).toFixed(2), color: getComputedStyle(el).color };
})()`);
console.log('PNUM ' + JSON.stringify(pnum));
check('dark thumbnail page number >= 4.5:1', !!pnum && pnum.ratio >= 4.5, JSON.stringify(pnum));

const contrastSkin = await ev(`(function(){
  window.aipdf.setTheme('contrast');
  return true;
})()`);
await sleep(600);
const cskin = await ev(`(function(){
  var cs = function(sel){ var e = document.querySelector(sel); return e ? getComputedStyle(e).backgroundColor : null; };
  return {
    htmlSurface: getComputedStyle(document.documentElement).getPropertyValue('--surface').trim(),
    bodySurface: getComputedStyle(document.body).getPropertyValue('--surface').trim(),
    bodyText4: getComputedStyle(document.body).getPropertyValue('--text-4').trim(),
    sidebar: cs('.sidebar'), context: cs('.context'), statusbar: cs('.statusbar'),
    rtitleColor: getComputedStyle(document.querySelector('.rtitle')).color
  };
})()`);
console.log('CONTRAST_SKIN ' + JSON.stringify(cskin));
const isBlack = (s) => /^(rgb\(0,\s*0,\s*0\)|#000000|rgba\(0,\s*0,\s*0,\s*1\))$/i.test(String(s).trim());
check('contrast dark skin reaches body token', /^(#000000|rgb\(0,\s*0,\s*0\))$/i.test(cskin.bodySurface), cskin.bodySurface);
check('contrast dark skin panels are pure black', [cskin.sidebar, cskin.context, cskin.statusbar].every(isBlack), JSON.stringify([cskin.sidebar, cskin.context, cskin.statusbar]));
check('contrast dark secondary text is white', /^(#ffffff|rgb\(255,\s*255,\s*255\))$/i.test(cskin.bodyText4), cskin.bodyText4);

const ewLogo = await ev(`(function(){
  var probe = document.createElement('div');
  probe.className = 'ew-logo'; probe.style.position = 'absolute'; probe.style.left = '-9999px';
  document.body.appendChild(probe);
  var c = getComputedStyle(probe);
  var fg = window.__uxv.parse(c.color), bg = window.__uxv.bgOf(probe);
  var r = window.__uxv.ratio(fg.slice(0,3), bg);
  var res = { ratio: +r.toFixed(2), color: c.color, background: c.backgroundColor };
  probe.remove();
  return res;
})()`);
console.log('EW_LOGO ' + JSON.stringify(ewLogo));
check('empty-workspace logo >= 3:1 in contrast dark', ewLogo.ratio >= 3, JSON.stringify(ewLogo));

const ocean = await ev(`(function(){ window.aipdf.setTheme('ocean'); return true; })()`);
await sleep(600);
const oceanTokens = await ev(`(function(){
  return {
    htmlAccent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    bodyAccent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
    htmlBg: getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
    bodyBg: getComputedStyle(document.body).getPropertyValue('--bg-app').trim()
  };
})()`);
console.log('OCEAN_DARK ' + JSON.stringify(oceanTokens));
check('hue skin accent reaches body in dark mode', oceanTokens.htmlAccent === oceanTokens.bodyAccent && !!oceanTokens.bodyAccent, JSON.stringify(oceanTokens));
check('hue skin background reaches body in dark mode', oceanTokens.htmlBg === oceanTokens.bodyBg, JSON.stringify(oceanTokens));

/* ── 5. Comment avatar ink on a bright annotation swatch ────────────────── */
await ev(`window.aipdf.setTheme('default')`);
await sleep(400);
await ev(`document.getElementById('btnTheme').click()`);
await sleep(500);
await ev(`(function(){ var b = document.querySelector('.rail-btn[data-panel="comments"]'); if (b) b.click(); return true; })()`);
await sleep(700);
const avatar = await ev(`(function(){
  var el = document.querySelector('.cmt-ic');
  if (!el) return null;
  var fg = window.__uxv.parse(getComputedStyle(el).color), bg = window.__uxv.bgOf(el);
  return { ratio: +window.__uxv.ratio(fg.slice(0,3), bg).toFixed(2), color: getComputedStyle(el).color, background: getComputedStyle(el).backgroundColor };
})()`);
console.log('AVATAR ' + JSON.stringify(avatar));
check('comment initial >= 4.5:1 on annotation swatch', !!avatar && avatar.ratio >= 4.5, JSON.stringify(avatar));

const failed = checks.filter((c) => !c.ok);
fs.writeFileSync(path.join(OUT, 'verify.json'), JSON.stringify({ passed: checks.length - failed.length, failed: failed.length, checks }, null, 2));
console.log(`UX_VERIFY ${failed.length ? 'FAIL' : 'PASS'} ${checks.length - failed.length}/${checks.length}`);
ws.close();
child.kill();
process.exit(failed.length ? 1 : 0);
