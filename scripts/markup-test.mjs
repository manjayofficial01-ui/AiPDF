#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live verification of the text-markup tools (Highlight, Underline, StrikeOut,
 * Squiggly). These are text-selection tools: arm from the ribbon, drag across
 * text, the markup is applied to the browser selection on mouseup.
 *
 *   node scripts/markup-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9548;
/* A per-run user-data dir in the OS temp area. A fixed dir in the repo has to
 * be bulk-deleted on every run, and a recursive delete of a user-data tree
 * trips the environment's bulk-delete guard once it passes ~50 files — the
 * suite then passes once and refuses to start afterwards. */
const UD = path.join(os.tmpdir(), `aipdf-markup-${process.pid}-${Date.now()}`);
mkdirSync(path.dirname(UD), { recursive: true });
mkdirSync(path.dirname(UD), { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/list`); page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null; } catch {}
  if (!page) await sleep(400);
}
if (!page) { console.log('MARKUP_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) { return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }); }
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

for (let i = 0; i < 60; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev('document.querySelectorAll("#pages .page").length > 0')) break; await sleep(300); }
await sleep(2000);
await send('Page.bringToFront').catch(() => {});

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

async function click(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(260);
}

// Tools -> their ribbon button label. The button is a `.rbtn` with
// aria-label/title set to the human label.
const LABEL = { highlight: 'Highlight', underline: 'Underline', strikeout: 'Strike', squiggly: 'Squiggly' };

async function armTool(tool) {
  const label = LABEL[tool];
  const info = await ev(`(function(){
    var btns = Array.from(document.querySelectorAll('#ribbon .rbtn'));
    var b = btns.find(function(x){ return (x.getAttribute('aria-label')||x.getAttribute('title')||'') === ${JSON.stringify(label)}; });
    if (!b) return { found: false, total: btns.length, labels: btns.map(function(x){return x.getAttribute('aria-label')||x.getAttribute('title');}).slice(0,30) };
    var r = b.getBoundingClientRect();
    return { found: true, x: r.left + r.width/2, y: r.top + r.height/2, active: b.classList.contains('active') };
  })()`);
  if (!info.found) return { ok: false, why: 'no button', info };
  await click(info.x, info.y);
  const st = await ev(`(async function(){ var s = await import('/js/store.js'); return s.state ? s.state.tool : null; })()`);
  const active = await ev(`document.querySelectorAll('#ribbon .rbtn.active').length`);
  const textPE = await ev(`(function(){ var rec = document.querySelector('#pages .page'); if(!rec) return null; return rec.querySelector('.textLayer') ? getComputedStyle(rec.querySelector('.textLayer')).pointerEvents : 'no-textLayer'; })()`);
  return { ok: st === tool, info, st, activeCount: active, textPointerEvents: textPE };
}

async function applyMarkupOnSelection(tool) {
  return await ev(`(async function(){
    var span = document.querySelector('.textLayer span');
    if (!span) return { ok: false, why: 'no text span' };
    var range = document.createRange();
    range.selectNodeContents(span);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    var st = await import('/js/store.js');
    var doc = st.activeDoc();
    if (!doc) return { ok: false, why: 'no doc' };
    var before = (doc.annots || []).length;
    var beforeTypes = (doc.annots || []).map(function(a){return a.type;}).join(',');
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    await new Promise(function(r){ setTimeout(r, 250); });
    var after = (doc.annots || []);
    var newOnes = after.slice(before);
    var found = newOnes.find(function(a){ return a.type === ${JSON.stringify(tool)}; });
    return {
      ok: !!found,
      before: before, after: after.length,
      found: found ? { type: found.type, quads: (found.quads||[]).length, rect: found.rect } : null,
      selText: sel.toString().slice(0,40),
      newTypes: newOnes.map(function(a){return a.type;}).join(','),
    };
  })()`);
}

for (const tool of ['highlight', 'underline', 'strikeout', 'squiggly']) {
  console.log(`\n--- ${tool} (${LABEL[tool]}) ---`);
  const arm = await armTool(tool);
  if (!arm.info) {
    check('ribbon button present', false, JSON.stringify(arm));
    continue;
  }
  check('ribbon button present', arm.info.found);
  if (!arm.info.found) {
    check('labels on the ribbon', false, JSON.stringify(arm.info.labels || arm.info));
    continue;
  }
  check('click arms the tool', arm.ok, `state.tool=${arm.st} active=${arm.activeCount} textLayer.pointerEvents=${arm.textPointerEvents}`);
  if (arm.ok) {
    const r = await applyMarkupOnSelection(tool);
    check('text selection → markup annotation', r.ok, JSON.stringify(r));
  }
}

child.kill();
await sleep(300);
console.log(`\n${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
