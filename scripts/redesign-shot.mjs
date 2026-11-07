#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Capture the redesigned UI surfaces as PNGs for visual verification.
 *
 * A CSS diff cannot tell you whether the redesign actually looks right. This
 * launches the real app over CDP, opens the fixture, drives the new surfaces
 * the way a user would, and saves one PNG per surface.
 *
 *   node scripts/redesign-shot.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const OUT = path.resolve(ROOT, process.argv[2] || '.smoke/redesign');
const PORT = 9421;
// Fresh profile per run: chrome visibility, ribbon tab, theme, tool AND the
// local version timeline all persist, so a reused profile photographs the
// previous run's state. A fixed `.smoke/*` dir is also a trap — the safe-delete
// shim refuses to remove trees past ~50 files. os.tmpdir() avoids both.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-redesign-'));

fs.mkdirSync(OUT, { recursive: true });

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
// windowsHide must NOT be set: a hidden window produces no frames to capture.
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, FIXTURE], { cwd: ROOT, env: childEnv });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

const list = await (async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* port not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();

if (!list) { console.log('SHOT_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(list.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));

const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 80; i++) {
  if (await ev('!!window.__aipdfBooted')) break;
  await sleep(300);
}
await sleep(2500);

// Force light: the theme choice persists between runs.
for (let i = 0; i < 3; i++) {
  if ((await ev(`document.documentElement.dataset.theme`)) === 'light') break;
  await ev(`document.getElementById('btnTheme').click()`);
  await sleep(700);
}
await sleep(600);

/* ── 0. Reset the chrome to a known state ───────────────────────────────────
   The ribbon, the toolbars and the theme all persist between sessions, so a
   previous run can leave the window in a state that hides what we came to
   photograph. Reset, then reload so the boot path re-reads the settings. */
await ev(`(async function(){
  var s = await import('/js/store.js');
  s.settings.chromeHidden = false;
  s.settings.ribbonMode = 'expanded';
  s.settings.theme = 'light';
  s.settings.density = 'comfortable';
  s.settings.ribbonLabels = 'auto';
  s.settings.lastRibbonTab = 'Home';
  s.settings.restoreRibbonTab = false;
  s.settings.tool = 'select';
  s.settings.pinnedTools = ['hand','select','highlight','note','textbox'];
  s.saveSettings();
  return true;
})()`);
await sleep(400);
await ev(`location.reload()`);
await sleep(6000);
for (let i = 0; i < 60; i++) {
  if (await ev('!!window.__aipdfBooted')) break;
  await sleep(300);
}
await sleep(2500);
console.log('RESET ' + await ev(`JSON.stringify({
  chromeHidden: document.body.classList.contains('chrome-hidden'),
  ribbonCollapsed: document.body.classList.contains('ribbon-collapsed'),
  density: document.body.className,
  ribbonButtons: document.querySelectorAll('#ribbon .rbtn').length,
  tabs: [...document.querySelectorAll('#modeTabs .mode-tab')].map(function(b){return b.textContent.trim();}),
})`));

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  console.log(`WROTE ${file} (${fs.statSync(file).size} bytes)`);
}

/** Click a ribbon tab by its visible label. */
const clickTab = async (label) => {
  await ev(`(function(){
    var b = [...document.querySelectorAll('#modeTabs .mode-tab')].find(function(x){ return x.textContent.trim() === ${JSON.stringify(label)}; });
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(500);
};

/* ── 1. Home: labelled primary tools ─────────────────────────────────────── */
await clickTab('Home');
await sleep(400);
console.log('HOME ' + await ev(`JSON.stringify({
  tabs: [...document.querySelectorAll('#modeTabs .mode-tab')].map(function(b){return b.textContent.trim();}),
  large: document.querySelectorAll('#ribbon .rbtn.large').length,
  labelled: document.querySelectorAll('#ribbon .rbtn.large .rlabel').length,
  chips: document.querySelectorAll('#ribbon .rbtn.large .rkey').length,
  groups: [...document.querySelectorAll('#ribbon .rtitle')].map(function(t){return t.textContent;}),
})`));
await shot('01-home-ribbon.png');

/* ── 2. Documents tab ────────────────────────────────────────────────────── */
await clickTab('Documents');
await sleep(400);
console.log('DOCUMENTS ' + await ev(`JSON.stringify({
  buttons: [...document.querySelectorAll('#ribbon .rbtn')].map(function(b){ return b.getAttribute('aria-label'); }),
})`));
await shot('02-documents-tab.png');

/* ── 3. Properties panel with the scope strip ───────────────────────────── */
await clickTab('Home');
await sleep(300);
await ev(`(function(){ var t = document.querySelector('#rail .rail-btn'); if (t) t.click(); return !!t; })()`);
await sleep(700);
console.log('PROPS ' + await ev(`JSON.stringify({
  scopeVisible: !!document.querySelector('#ctxScope') && !document.querySelector('#ctxScope').hidden,
  scopeName: (document.querySelector('.ctx-scope-name')||{}).textContent || '',
  scopeSub: (document.querySelector('.ctx-scope-sub')||{}).textContent || '',
  sections: document.querySelectorAll('#ctxBody .prop-group.collapsible').length,
  carets: document.querySelectorAll('#ctxBody .prop-title .caret').length,
})`));
await shot('03-properties-scope.png');

/* ── 4. Tabbed Settings dialog ──────────────────────────────────────────── */
await ev(`document.getElementById('btnPrefs').click()`);
await sleep(900);
console.log('SETTINGS ' + await ev(`JSON.stringify({
  open: !!document.querySelector('.settings-shell'),
  nav: [...document.querySelectorAll('.settings-nav button')].map(function(b){return b.textContent.trim();}),
  rows: document.querySelectorAll('.settings-pane .set-row').length,
})`));
await shot('04-settings-general.png');

// Switch to the Appearance section so the new density / ribbon-label
// preferences are visible in the shot.
await ev(`(function(){
  var b = [...document.querySelectorAll('.settings-nav button')].find(function(x){ return /appearance/i.test(x.textContent); });
  if (b) b.click();
  return !!b;
})()`);
await sleep(600);
await shot('05-settings-appearance.png');

await ev(`(function(){
  var b = [...document.querySelectorAll('.settings-nav button')].find(function(x){ return /markup/i.test(x.textContent); });
  if (b) b.click();
  return !!b;
})()`);
await sleep(600);
await shot('06-settings-markup.png');

await ev(`document.querySelector('.modal-head .icon-btn').click()`);
await sleep(500);

/* ── 5. Quick access with pinned tools ───────────────────────────────────── */
await ev(`document.getElementById('btnQuickCustomize').click()`);
await sleep(900);
console.log('QUICK ' + await ev(`JSON.stringify({
  pinned: [...document.querySelectorAll('#quickPinned .qbtn')].map(function(b){return b.getAttribute('aria-label');}),
  customiser: !!document.querySelector('.qa-list'),
  rows: document.querySelectorAll('.qa-row').length,
})`));
await shot('07-quick-access-customiser.png');

await ev(`document.querySelector('.modal-head .icon-btn').click()`);
await sleep(500);
await shot('08-quick-access-pinned.png');

/* ── 6. Command palette ──────────────────────────────────────────────────── */
await ev(`document.getElementById('btnPalette').click()`);
await sleep(700);
await ev(`(function(){ var i = document.querySelector('.palette input'); if (i) { i.value='note'; i.dispatchEvent(new Event('input')); } return !!i; })()`);
await sleep(600);
console.log('PALETTE ' + await ev(`JSON.stringify({
  groups: [...document.querySelectorAll('.palette .pgroup')].map(function(g){return g.textContent;}),
  rows: document.querySelectorAll('.palette .pitem').length,
  chips: document.querySelectorAll('.palette .pitem .plk').length,
})`));
await shot('09-command-palette.png');

await ev(`(function(){ var i = document.querySelector('.palette input'); if (i) { i.value='zzzz'; i.dispatchEvent(new Event('input')); } return !!i; })()`);
await sleep(500);
await shot('10-palette-empty-state.png');

/* ── 7. Assurance surfaces (v2.25) ─────────────────────────────────────────
   Reload first: the palette overlay must not cover the ribbon in these shots.
   Dialog-opening actions are fired without awaiting them (they resolve when
   the modal closes, so awaiting would hang the CDP evaluation). */
await ev(`location.reload()`);
await sleep(6000);
for (let i = 0; i < 60; i++) {
  if (await ev('!!window.__aipdfBooted')) break;
  await sleep(300);
}
await sleep(2200);

await clickTab('Assurance');
await sleep(500);
console.log('ASSURANCE_TAB ' + await ev(`JSON.stringify({
  active: (document.querySelector('#modeTabs .mode-tab.active')||{}).textContent,
  groups: [...document.querySelectorAll('#ribbon .rtitle')].map(function(t){return t.textContent;}),
  buttons: document.querySelectorAll('#ribbon .rbtn').length,
})`));
await shot('11-assurance-ribbon.png');

const openShot = async (expr, label, file) => {
  await ev(expr);
  await sleep(1500);
  console.log(label + ' ' + await ev(`JSON.stringify({
    title: (document.querySelector('.modal-backdrop .modal-head h3')||{}).textContent || '',
    body: !!document.querySelector('.modal-backdrop .modal-body .asr, .modal-backdrop .modal-body .tl'),
  })`));
  await shot(file);
  await ev(`(function(){ var b=document.querySelector('.modal-backdrop .modal-head .icon-btn'); if(b) b.click(); return !!b; })()`);
  await sleep(500);
};

await openShot(`window.aipdf.run('assurance:inspect'); 'started'`, 'INSPECTOR', '12-security-inspector.png');
await openShot(`window.aipdf.run('assurance:accessibility'); 'started'`, 'A11Y', '13-accessibility-checker.png');
await openShot(`document.getElementById('stLocal').click(); 'clicked'`, 'TRUST', '14-trust-center.png');
await openShot(`window.aipdf.run('assurance:timeline'); 'started'`, 'TIMELINE', '15-version-timeline.png');

await ev(`window.aipdf.run('view:highContrast'); 'ok'`);
await sleep(600);
await shot('16-high-contrast.png');
await ev(`(async function(){
  var s = await import('/js/store.js');
  s.settings.skin = 'default'; s.saveSettings();
  document.documentElement.dataset.skin = 'default';
  document.body.classList.remove('hc');
  return true;
})()`);

ws.close();
child.kill();
await sleep(1500);
// Remove only the temp profile this run created. Failure is harmless: the next
// run allocates a brand-new directory.
try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }
console.log('SHOTS_DONE');
process.exit(0);
