#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Appearance v2.26 — colour themes + complete native tool catalogue.
 *
 *   node scripts/appearance-test.mjs
 *
 * Static half: prove that EVERY tool in TOOLS (app.js) is reachable from the
 * native menu AND dispatchable, and that every palette in THEMES has a CSS
 * bundle, a View-menu radio, a command-palette row and a dispatch case.
 *
 * Live half: boot the real app, open the gallery, pick a palette, and verify
 * the DOM token, the computed CSS variables, the status-bar chip, persistence
 * and the local agent API. A static-only test would not catch a token bundle
 * that never actually changes a pixel.
 *
 * Profile is per-run in os.tmpdir(): fixed .smoke/ Chromium profiles trip the
 * safe-delete bulk guard once they grow past ~50 files.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const appSrc = read('src/renderer/js/app.js');
const menuSrc = read('src/main/menu.js');
const cssSrc = read('src/renderer/css/premium.css');
const htmlSrc = read('src/renderer/index.html');
const premiumSrc = read('src/renderer/js/premium.js');

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 1. Static: complete tool catalogue ────────────────────────────────── */

const toolsBlock = appSrc.slice(appSrc.indexOf('const TOOLS = ['), appSrc.indexOf('];', appSrc.indexOf('const TOOLS = [')));
const tools = [...toolsBlock.matchAll(/\['([A-Za-z0-9]+)',\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
const sent = new Set([...menuSrc.matchAll(/send\('([a-zA-Z:]+)'\)/g)].map((m) => m[1]));
const cases = new Set([...appSrc.matchAll(/case\s+'([a-zA-Z:]+)'/g)].map((m) => m[1]));

check('the ribbon tool registry parsed', tools.length >= 30, `${tools.length} tools`);
const noMenu = tools.filter(([id]) => !sent.has(`tool:${id}`));
check('every ribbon tool has a native menu entry', noMenu.length === 0, noMenu.map((t) => t[0]).join(', ') || 'all present');
const noDispatch = tools.filter(([id]) => !cases.has(`tool:${id}`));
check('every ribbon tool is dispatchable', noDispatch.length === 0, noDispatch.map((t) => t[0]).join(', ') || 'all wired');
check('the native Tools menu groups the catalogue',
  /label: '&Tools'/.test(menuSrc) && /label: 'Draw && shapes'/.test(menuSrc) && /label: 'Edit && measure'/.test(menuSrc));

/* ── 2. Static: every colour theme is wired end to end ──────────────────── */

const themesBlock = premiumSrc.slice(premiumSrc.indexOf('export const THEMES = ['), premiumSrc.indexOf('];', premiumSrc.indexOf('export const THEMES = [')));
const themeIds = [...themesBlock.matchAll(/id:\s*'([a-z]+)'/g)].map((m) => m[1]);
check('the theme catalogue parsed', themeIds.length >= 8, `${themeIds.length} palettes: ${themeIds.join(', ')}`);
const themeGaps = [];
for (const id of themeIds) {
  const action = `view:theme:${id}`;
  if (id !== 'default' && !cssSrc.includes(`html[data-skin="${id}"]`)) themeGaps.push(`${id}:css`);
  if (!menuSrc.includes(`send('${action}')`)) themeGaps.push(`${id}:menu`);
  if (!cases.has(action)) themeGaps.push(`${id}:dispatch`);
  if (!appSrc.includes(`'${action}'`)) themeGaps.push(`${id}:palette`);
}
check('every palette has CSS + menu + dispatch + command', themeGaps.length === 0, themeGaps.join(', ') || 'all four paths');
check('Aurora uses the shared palette token bundle',
  /html\[data-skin="aurora"\] \{\s*--th-bg:/.test(cssSrc) && /html\[data-skin="aurora"\] \{/.test(cssSrc.slice(cssSrc.indexOf('html[data-skin="ocean"], html[data-skin="forest"]'))),
  'aurora must be in the shared semantic-token mapping');
check('dark palettes darken solid-button fills for white text',
  /color-mix\(in srgb, var\(--th-a\) 55%, #000\)/.test(cssSrc));
check('the gallery action is wired', cases.has('view:themeGallery') && appSrc.includes('Colour themes'));
check('the status-bar picker is in the static shell', htmlSrc.includes('id="stTheme"') && htmlSrc.includes('id="stThemeDot"'));
check('premium.css is still the last stylesheet',
  htmlSrc.indexOf('/css/premium.css') > htmlSrc.indexOf('/css/theme-claude.css'));

/* ── 3. Live: real Electron window ──────────────────────────────────────── */

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const PORT = await freePort();
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-appearance-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up yet */ }
  if (!target) await sleep(350);
}
if (!target) { console.log('APPEARANCE_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const exceptions = [];
ws.addEventListener('message', (e) => {
  let m;
  try { m = JSON.parse(e.data); } catch { return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params && m.params.exceptionDetails;
    exceptions.push((d && (d.exception && d.exception.description || d.text)) || 'unknown');
  }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++mid;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)); }, 20000);
  pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return null;
  return r && r.result ? r.result.value : null;
};

for (let i = 0; i < 100; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(700);
check('the app booted with a document', await ev('!!window.__aipdfBooted'));

const info = await ev(`JSON.stringify(window.aipdf.theme())`);
let themeInfo = null;
try { themeInfo = JSON.parse(info); } catch { /* reported below */ }
check('the agent API exposes the palette catalogue',
  !!themeInfo && themeInfo.available.length === themeIds.length,
  themeInfo && `${themeInfo.available.length} palettes, current=${themeInfo.skin}`);

// Do NOT await the gallery: onMenuAction awaits showModal, which resolves only
// when the dialog closes. Fire it and inspect the DOM while it is open.
await ev(`(function(){ window.aipdf.run('view:themeGallery'); return true; })()`);
await sleep(500);
const cards = await ev(`document.querySelectorAll('.th-card').length`);
check('the gallery renders one card per palette', cards === themeIds.length, `cards=${cards}`);
check('the gallery has a light/dark switch', (await ev(`document.querySelectorAll('.th-mode-btn').length`)) === 2);

// A preview that loses its inline colours (or shrinks to a stripe inside the
// flex card) looks like a blank card, so assert the real rendered geometry and
// background rather than trusting the DOM structure alone.
const prevJson = await ev(`(function(){
  var p = document.querySelector('.th-card .th-preview');
  var bar = p && p.querySelector('.th-prev-bar');
  var rail = p && p.querySelector('.th-prev-rail');
  if (!p || !bar || !rail) return '{}';
  var cs = function(n){ return getComputedStyle(n).backgroundColor; };
  return JSON.stringify({
    h: Math.round(p.getBoundingClientRect().height),
    w: Math.round(p.getBoundingClientRect().width),
    bg: cs(p), bar: cs(bar), rail: cs(rail),
    barH: Math.round(bar.getBoundingClientRect().height),
    ink: cs(p.querySelector('.th-prev-page i')),
  });
})()`);
let preview = null;
try { preview = JSON.parse(prevJson); } catch { /* reported below */ }
const distinct = (o) => o && /^rgba?\(/.test(o) && o !== 'rgba(0, 0, 0, 0)' && o !== 'transparent';
check('the theme previews have real painted colours',
  !!preview && distinct(preview.bg) && distinct(preview.bar) && distinct(preview.rail) && distinct(preview.ink),
  prevJson);
check('the theme previews keep their full height and title bar',
  !!preview && preview.h >= 55 && preview.barH >= 8,
  preview && `preview=${preview.h}px bar=${preview.barH}px`);
// Chromium gives <button> `align-items: flex-start`; without an explicit
// stretch the preview is a 2px sliver and every card looks blank.
check('the theme previews fill the card width',
  !!preview && preview.w >= 100,
  preview && `preview width=${preview.w}px`);

if (process.env.THEME_DIAG) {
  console.log('DIAG', await ev(`(function(){
    var p = document.querySelector('.th-card .th-preview');
    return JSON.stringify([p].concat(Array.from(p.querySelectorAll('*'))).map(function(n){
      var c = getComputedStyle(n), r = n.getBoundingClientRect(), pr = p.getBoundingClientRect();
      return { cls: n.className, x: Math.round(r.x - pr.x), y: Math.round(r.y - pr.y),
        w: Math.round(r.width), h: Math.round(r.height), pos: c.position,
        bg: c.backgroundColor, op: c.opacity, vis: c.visibility, z: c.zIndex };
    }));
  })()`));
}

// The Light/Dark switch reaches app.js through a dynamic import (a static one
// would create a module cycle). Exercise that path and restore light afterwards.
const darkBgBefore = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()`);
await ev(`(function(){
  var b = Array.from(document.querySelectorAll('.th-mode-btn')).find(function(x){ return /Dark/.test(x.textContent); });
  if (b) b.click(); return !!b;
})()`);
await sleep(500);
const darkState = await ev(`JSON.stringify({ mode: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim() })`);
let dark = null;
try { dark = JSON.parse(darkState); } catch { /* reported below */ }
check('the gallery Dark switch flips the whole workspace',
  !!dark && dark.mode === 'dark' && dark.bg !== darkBgBefore, darkState);
await ev(`(function(){
  var b = Array.from(document.querySelectorAll('.th-mode-btn')).find(function(x){ return /Light/.test(x.textContent); });
  if (b) b.click(); return !!b;
})()`);
await sleep(400);
check('the gallery Light switch restores light mode',
  (await ev(`document.documentElement.dataset.theme`)) !== 'dark');

// In dark mode the palette accent is a readable foreground colour, so solid
// buttons must darken it — otherwise every modal's Done button is white text on
// a light accent. Move the workspace into dark mode explicitly, prove the two
// tokens differ, then restore light mode.
await ev(`(function(){
  var b = Array.from(document.querySelectorAll('.th-mode-btn')).find(function(x){ return /Dark/.test(x.textContent); });
  if (b) b.click(); return !!b;
})()`);
await sleep(400);
const accentDark = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()`);
const solidDark = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--accent-solid').trim()`);
check('dark palettes keep solid buttons readable',
  accentDark !== solidDark && /[\d,]/.test(solidDark), `{ accent=${accentDark}, solid=${solidDark} }`);
await ev(`(function(){
  var b = Array.from(document.querySelectorAll('.th-mode-btn')).find(function(x){ return /Light/.test(x.textContent); });
  if (b) b.click(); return !!b;
})()`);
await sleep(400);

const beforeBg = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()`);
await ev(`(function(){
  var c = Array.from(document.querySelectorAll('.th-card')).find(function(x){ return /Ocean Teal/.test(x.textContent); });
  if (c) c.click(); return !!c;
})()`);
await sleep(350);
const skin = await ev(`document.documentElement.dataset.skin`);
const afterBg = await ev(`getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim()`);
check('picking a card applies the palette to the DOM', skin === 'ocean', `skin=${skin}`);
check('the palette actually changes rendered tokens', !!afterBg && afterBg !== beforeBg, `${beforeBg} -> ${afterBg}`);
check('the status-bar chip names the active palette',
  (await ev(`document.getElementById('stThemeName').textContent.trim()`)) === 'Ocean Teal');
check('the selection is marked in the gallery', (await ev(`document.querySelectorAll('.th-card.current').length`)) === 1);
check('the choice is persisted in settings',
  (await ev(`(async () => (await import('/js/store.js')).settings.skin)()`)) === 'ocean');

// Screenshot for visual review, then close the dialog through its real button.
try {
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const dir = path.join(ROOT, '.smoke', 'appearance');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'theme-gallery.png'), Buffer.from(shot.data, 'base64'));
  console.log('WROTE .smoke/appearance/theme-gallery.png');
  const box = await ev(`(function(){
    var g = document.querySelector('.th-grid'); if (!g) return '{}';
    var r = g.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 360) });
  })()`);
  const clip = JSON.parse(box);
  if (clip.width) {
    const zoom = await send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: true,
      clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 2 },
    });
    fs.writeFileSync(path.join(dir, 'theme-cards-zoom.png'), Buffer.from(zoom.data, 'base64'));
    console.log('WROTE .smoke/appearance/theme-cards-zoom.png');
  }
} catch { /* screenshot is optional */ }
await ev(`(function(){ var b = document.querySelector('.modal-foot button.primary'); if (b) b.click(); return !!b; })()`);
await sleep(250);

check('dispatching a theme action by id works',
  (await ev(`(async function(){ await window.aipdf.run('view:theme:violet'); return document.documentElement.dataset.skin; })()`)) === 'violet');
check('the agent setTheme helper works',
  (await ev(`(async function(){ window.aipdf.setTheme('graphite'); return document.documentElement.dataset.skin; })()`)) === 'graphite');
check('high contrast restores the previous palette',
  (await ev(`(async function(){
      await window.aipdf.run('view:highContrast');
      var on = document.documentElement.dataset.skin;
      await window.aipdf.run('view:highContrast');
      return JSON.stringify({ on: on, back: document.documentElement.dataset.skin });
    })()`)) === JSON.stringify({ on: 'contrast', back: 'graphite' }));
check('no renderer exceptions', exceptions.length === 0, exceptions.slice(0, 2).join(' | '));

child.kill();
await sleep(400);
console.log(`\nAPPEARANCE_${problems ? 'FAIL' : 'PASS'} ${problems} problem(s)`);
process.exit(problems ? 1 : 0);
