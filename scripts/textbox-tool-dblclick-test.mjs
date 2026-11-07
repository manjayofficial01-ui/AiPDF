#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Double-clicking the Text box tool re-opens the selected box for typing.
 *
 * The ribbon re-renders on every click, so the button that takes the first
 * click is gone before the second lands — the gesture is detected at the
 * ribbon level on pointerdown. This suite proves the real behaviour:
 *
 *   - create a text box, select it, double-click the Text box tool → the
 *     inline editor re-opens with the box's text, caret ready;
 *   - with nothing selected, double-click → the tool arms an I-beam writing
 *     cursor (state.textWriteMode + cursor:text);
 *   - switching to another tool drops the writing cursor.
 *
 *   node scripts/textbox-tool-dblclick-test.mjs
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

if (!fs.existsSync(ELECTRON)) { console.log('TBDBL_FAIL missing electron'); process.exit(1); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

const PORT = await freePort();
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-tbdbl-ud-'));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`];
if (fs.existsSync(FIXTURE)) args.splice(1, 0, FIXTURE);
const child = spawn(ELECTRON, args, { cwd: ROOT, env });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 180000);
bail.unref?.();

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!target) await sleep(400);
}
if (!target) { console.log('TBDBL_FAIL no renderer target'); child.kill(); process.exit(1); }

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
  if (!r || r.exceptionDetails) { console.log('EV_EXC', JSON.stringify(r?.exceptionDetails || {}).slice(0, 400)); return undefined; }
  return r.result ? r.result.value : undefined;
}
const evJson = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch { return null; } };

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};

const press = (x, y) => send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 });
const release = (x, y) => send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 0 });
const click = async (x, y) => { await press(x, y); await sleep(50); await release(x, y); };
/** Two presses inside the double-click window, at the same spot. */
const dblclick = async (x, y) => {
  await press(x, y); await release(x, y);
  await sleep(90);
  await press(x, y); await release(x, y);
  await sleep(350);
};

for (let i = 0; i < 120; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 100; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(1500);

/** Centre of a ribbon button whose tooltip matches `re`. */
const ribbonPoint = (re) => evJson(`(function(){
  var b = Array.from(document.querySelectorAll('#ribbon .rbtn'))
    .find(function(x){ return ${re}.test((x.getAttribute('aria-label') || x.title || '').trim()); });
  if (!b) return null;
  var r = b.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`);

// The canonical fixture ships an AcroForm text field, which forms.js renders
// as a <textarea> inside .formLayer on the page. Ignore those widgets: the
// suite is counting inline TEXT BOX editors, not form inputs.
const pageEditors = `Array.from(document.querySelectorAll('#pages textarea')).filter(function(t){ return !t.closest('.formLayer'); })`;

const toolState = () => evJson(`(async function(){
  var st = await import('/js/store.js');
  var tas = ${pageEditors};
  return JSON.stringify({
    tool: st.state.tool,
    writeMode: !!st.state.textWriteMode,
    cursor: document.getElementById('pages').style.cursor,
    selection: st.state.selection.slice(),
    editors: tas.length,
    editorText: (tas[0] || {}).value || null,
  });
})()`);

/* ── 1. Create a text box and commit its text ──────────────────────────── */
const tbBtn = await ribbonPoint(`/^text box$/i`);
check('the Text box tool is on the ribbon', !!tbBtn, JSON.stringify(tbBtn));
await click(tbBtn.x, tbBtn.y);
await sleep(400);
let s = await toolState();
check('clicking the Text box tool arms it', s && s.tool === 'textbox', s && `tool=${s.tool}`);

// Click a clear spot on the first page to place the box.
const pagePt = await evJson(`(function(){
  var c = document.querySelector('.page canvas.pdf');
  var r = c.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width * 0.35, y: r.top + r.height * 0.3 });
})()`);
await click(pagePt.x, pagePt.y);
await sleep(600);
s = await toolState();
check('a page click creates a box and opens its editor', s && s.editors === 1, s && `editors=${s.editors}`);

await ev(`(function(){ var t = (${pageEditors})[0]; if (!t) return false; t.value = 'Box one'; t.dispatchEvent(new Event('input', { bubbles: true })); t.blur(); return true; })()`);
await sleep(500);
const boxInfo = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var a = (st.activeDoc().annots || []).find(function(x){ return x.type === 'textbox'; });
  if (!a) return null;
  var el = document.querySelector('.ann[data-id="' + a.id + '"]');
  var r = el && el.getBoundingClientRect();
  return JSON.stringify({ id: a.id, text: a.text, x: r && (r.left + r.width / 2), y: r && (r.top + r.height / 2) });
})()`);
check('the box committed its text', !!boxInfo && boxInfo.text === 'Box one', JSON.stringify(boxInfo && { text: boxInfo.text }));

/* ── 2. Select it, then double-click the Text box tool ─────────────────── */
const selBtn = await ribbonPoint(`/^select$/i`);
await click(selBtn.x, selBtn.y);
await sleep(300);
await click(boxInfo.x, boxInfo.y);
await sleep(300);
s = await toolState();
check('the text box is selected', s && s.selection.includes(boxInfo.id), s && JSON.stringify(s.selection));

await dblclick(tbBtn.x, tbBtn.y);
s = await toolState();
check('double-clicking the Text box tool re-opens the selected box', s && s.editors === 1, s && `editors=${s.editors}`);
check('the re-opened editor carries the box text', s && s.editorText === 'Box one', s && JSON.stringify(s.editorText));

// Close it (blur commits).
await ev(`(function(){ var t = (${pageEditors})[0]; if (t) t.blur(); return true; })()`);
await sleep(400);

/* ── 3. Nothing selected: double-click arms the writing cursor ──────────── */
await click(selBtn.x, selBtn.y);
await sleep(200);
// Click empty page space to clear any selection.
await click(pagePt.x + 200, pagePt.y + 240);
await sleep(250);
await ev(`(async function(){ var st = await import('/js/store.js'); st.state.selection = []; return true; })()`);
await sleep(150);

await dblclick(tbBtn.x, tbBtn.y);
s = await toolState();
check('with nothing selected, double-click arms the writing cursor', s && s.tool === 'textbox' && s.writeMode === true, s && JSON.stringify({ tool: s.tool, writeMode: s.writeMode }));
check('the page shows an I-beam while writing', s && s.cursor === 'text', s && `cursor=${s.cursor}`);

/* ── 4. Another tool drops the writing cursor ──────────────────────────── */
await click(selBtn.x, selBtn.y);
await sleep(250);
s = await toolState();
check('switching tools clears the writing mode', s && s.writeMode === false, s && `writeMode=${s.writeMode}`);
check('the cursor returns to the select default', s && s.cursor === 'default', s && `cursor=${s.cursor}`);

check('no console errors', errs.length === 0, JSON.stringify(errs.slice(0, 3)));
clearTimeout(bail);
console.log(problems ? `TBDBL_FAIL ${problems} problem(s)` : 'TBDBL_PASS all checks green');
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
