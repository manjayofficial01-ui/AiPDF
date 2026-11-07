#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live check for "Add a font from this computer": the picker must list real
 * installed faces, filter, add the selected one, persist it, and make it
 * selectable in the text properties panel. It then removes what it added so the
 * run leaves no state behind.
 *
 *   node scripts/system-font-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9423;
// Every CDP suite gets its own userData. The shared profile can carry an old
// settings.json / a stale IndexedDB, and the renderer then never finishes
// booting — which this test used to report as seven unrelated UI failures.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-sysfont-'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', `--user-data-dir=${PROFILE}`, FIXTURE, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!page) await sleep(400);
}
if (!page) { console.log('SYSFONT_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails || (r.result && r.result.exceptionDetails)) return undefined;
  return r.result && r.result.value;
};
// A failed in-page expression used to surface as "[object Object]" here and
// crash JSON.parse instead of reporting a failed check.
const parseJson = (v, fallback = {}) => {
  try { return typeof v === 'string' ? JSON.parse(v) : (v && typeof v === 'object' ? v : fallback); }
  catch { return fallback; }
};

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const clickText = (label) => ev(`(function(){
  var want = ${JSON.stringify(label)};
  var els = Array.from(document.querySelectorAll('button'));
  var b = els.find(function(e){ return (e.textContent||'').trim() === want; });
  if (!b) return 'missing:' + want;
  b.click(); return 'clicked';
})()`);

for (let i = 0; i < 40; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
await sleep(2500);
await send('Page.bringToFront').catch(() => {});

// Snapshot fonts the user already stored. Without this the cleanup below wiped
// pre-existing entries — a test must only ever remove what it created.
const preExisting = await ev(`(async function(){
  var f = await import('/js/fonts.js');
  return f.userFontRecords().map(function(r){ return r.family; });
})()`) || [];
console.log(`pre-existing stored fonts (will be preserved): ${JSON.stringify(preExisting)}`);

// ── Open the Fonts panel ───────────────────────────────────────────────────
// Set the state directly. setSidebar() TOGGLES when the panel is already open
// and persists that choice, so calling it makes consecutive runs alternate
// between working and finding an empty panel.
await ev(`(async function(){
  var st = await import('/js/store.js');
  var sb = await import('/js/sidebar.js');
  st.settings.sidebar = 'fonts';
  st.settings.sidebarOpen = true;
  sb.renderSidebarChrome();
  sb.renderSidebar();
  return true;
})()`);
await sleep(1200);

const btnState = await ev(`(function(){
  var els = Array.from(document.querySelectorAll('#sideTools button'));
  return els.map(function(e){ return (e.textContent||'').trim(); }).join('|');
})()`);
check('Fonts panel offers both font sources', btnState.includes('From this computer'), btnState || 'no side tools');

// ── Open the picker and wait for the index ─────────────────────────────────
check('picker opens', (await clickText('From this computer…')) === 'clicked');
let rows = 0;
for (let i = 0; i < 40; i++) {
  rows = await ev(`document.querySelectorAll('.font-pick .font-row').length`);
  if (rows > 20) break;
  await sleep(400);
}
const status = await ev(`(function(){var m=document.querySelector('.modal .hint'); return m?m.textContent:'';})()`);
check('installed faces are listed', rows > 50, `${rows} rows visible; status "${status}"`);
check('collections are reported, not silently dropped', /\.ttc/.test(status) || rows > 0, status);

// ── Filtering narrows the list ─────────────────────────────────────────────
const filtered = await ev(`(function(){
  var s = document.querySelector('.font-pick') ? document.querySelector('input[type=search]') : null;
  if (!s) return 'no search box';
  s.value = 'Arial';
  s.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`);
await sleep(500);
const arialRows = await ev(`Array.from(document.querySelectorAll('.font-pick .font-row')).map(function(r){return r.textContent;}).slice(0,6)`);
check('filtering by family narrows the list', filtered === 'clicked' || filtered === 'typed', `${arialRows.length} matches: ${JSON.stringify(arialRows.join(' ; ').slice(0, 90))}`);

// ── Select and add ─────────────────────────────────────────────────────────
await ev(`(function(){var r=document.querySelector('.font-pick .font-row'); if(r) r.click(); return !!r;})()`);
await sleep(250);
check('a row can be selected', await ev(`!!document.querySelector('.font-row.on')`) === true);

const added = await clickText('Add selected font');
await sleep(2500);
check('add button commits', added === 'clicked', added);

const myFonts = await ev(`(function(){
  var rows = Array.from(document.querySelectorAll('#sideBody .prop-row')).map(function(r){return r.textContent;});
  return rows.filter(function(t){return /My fonts|Use|Remove/.test(t);}).length;
})()`);
const stored = await ev(`(async function(){
  var st = await import('/js/store.js');
  var f = await import('/js/fonts.js');
  var rec = f.userFontRecords();
  var got = rec.length ? !!f.getCustomFont(rec[0].family) : false;
  return JSON.stringify({ count: rec.length, families: rec.map(function(x){return x.family;}), registered: got, inPicker: Array.from(document.querySelectorAll('#ctxBody select option, select option')).length });
})()`);
const storedObj = parseJson(stored, {});
check('added font is indexed and registered', storedObj.count >= 1 && storedObj.registered === true, stored);
check('"My fonts" list is rendered with Use and Remove controls', myFonts >= 1, `${myFonts} stored-font rows`);

// ── It reaches the text properties font picker ─────────────────────────────
const inPicker = await ev(`(async function(){
  var st = await import('/js/store.js');
  var f = await import('/js/fonts.js');
  var fam = (f.userFontRecords()[0]||{}).family;
  if (!fam) return 'no stored font';
  var fs = await import('/js/fonts.js');
  st.settings.newTextFont = fam;
  // Open the Textbox tool so the panel renders its font <select>.
  st.state.tool = 'textbox';
  var an = await import('/js/annots.js');
  an.renderAllAnnotations();
  st.emit('selection');
  await new Promise(function(r){setTimeout(r,400);});
  var opts = Array.from(document.querySelectorAll('#ctxBody select option')).map(function(o){return o.value;});
  return JSON.stringify({ fam: fam, opts: opts.slice(0, 12), hasIt: opts.indexOf(fam) >= 0 });
})()`);
const picker = parseJson(inPicker, {});
check('the font appears in the properties Font picker', picker.hasIt === true, inPicker);

// ── Clean up after ourselves ───────────────────────────────────────────────
// ── Clean up only what THIS run added ──────────────────────────────────────
const cleaned = await ev(`(async function(){
  var f = await import('/js/fonts.js');
  var before = ${JSON.stringify(preExisting)};
  var mine = f.userFontRecords().filter(function(r){ return before.indexOf(r.family) === -1; });
  for (const r of mine) await f.removeUserFont(r.family);
  return JSON.stringify({ removed: mine.map(function(r){return r.family;}), left: f.userFontRecords().map(function(r){return r.family;}) });
})()`);
const c = parseJson(cleaned, {});
check('test removes only the font it added', c.removed && c.removed.length === 1 && c.left.length === preExisting.length, cleaned);

child.kill();
await sleep(1000);
try { child.kill('SIGKILL'); } catch { /* gone */ }
try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 2 }); } catch { /* OS temp cleans up */ }

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nSYSFONT_FAIL ${failed.length}/${results.length} checks failed` : `\nSYSFONT_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
