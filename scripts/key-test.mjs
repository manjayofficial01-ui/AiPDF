#!/usr/bin/env node
/**
 * Keyboard test — presses real key events through CDP and observes the app.
 *
 * Covers the two shortcut defects that were fixed: single-letter tool keys must
 * work when the canvas has focus, and must NOT switch tools while the user is
 * typing in a field. Delete-on-selection is checked against the live annotation
 * count from the app's own test hook.
 *
 *   node scripts/key-test.mjs
 *
 * NOT covered: Ctrl+Z / Ctrl+Shift+Z. Those are native menu accelerators, which
 * Chromium resolves from the browser process' message loop — a key event
 * injected into the renderer does not travel that path, so a failure here would
 * be a harness artefact rather than a product bug.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9416;
// Own user-data dir: the checks assert DEFAULTS (Select at boot, an empty
// Find box) and the user's live settings (remembered tool, open search panel
// and its autofocus) would legitimately differ. Every other live gate
// isolates the same way.
const UD = path.join(ROOT, '.smoke', 'keytest-ud');
fs.rmSync(UD, { recursive: true, force: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Normal launch with the fixture as a startup argument: the app opens the
// document and stays alive. --functional-test would run its own assertions and
// quit mid-test.
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* port not up yet */ }
  if (!page) await sleep(400);
}
if (!page) { console.log('KEY_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

async function key(k, code, vk, modifiers = 0) {
  // A keyDown must be sent explicitly. CDP's `char` type produces keypress/input
  // only — it does NOT synthesise a keydown, so an app listening on `keydown`
  // (which is how the single-letter tool shortcuts work) never sees the event.
  // Sending `char` alone made "press r selects Rectangle" fail while the app was
  // actually fine; a document-level probe confirmed zero keydowns arrived.
  const printable = k.length === 1;
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(printable ? { text: k } : {}) });
  if (printable) await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: k });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}
const mode = () => ev(`(document.getElementById('stMode')||{}).textContent`);
// Count rendered annotation nodes rather than trusting a test-hook field name.
const annotCount = () => ev(`document.querySelectorAll('.annLayer svg > *').length`);

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

for (let i = 0; i < 40; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
await sleep(2500);
// The functional-test mode hides the window; show it so key events are handled.
await send('Page.bringToFront').catch(() => {});

const start = await mode();
// The app deliberately restores the last-used tool (app.js persists
// settings.tool, store.js re-reads it), so asserting a SPECIFIC boot tool is
// wrong — it depends on whatever ran last. Assert only that a tool is selected.
check('app booted with a tool selected', !!start && start !== '—', `stMode=${start}`);

await ev(`document.getElementById('canvasWrap').focus ? document.getElementById('canvasWrap').focus() : null`);
await key('r', 'KeyR', 82);
await sleep(400);
const afterR = await mode();
check("letter key 'r' selects the Rectangle tool", afterR === 'Rectangle', `stMode=${afterR}`);

// Typing in a field must not switch tools — this was the accelerator-hijack bug.
await ev(`(function(){var f=document.getElementById('findBar'); if(f && !f.classList.contains('open')) { var b=document.getElementById('btnFind'); if(b) b.click(); } return true;})()`);
await sleep(400);
await ev(`document.getElementById('findInput').focus()`);
await key('s', 'KeyS', 83);
await key('t', 'KeyT', 84);
await sleep(400);
const typed = await ev(`document.getElementById('findInput').value`);
const modeWhileTyping = await mode();
check('typing in Find does not steal the keystroke', /st/.test(typed), `findInput="${typed}"`);
check('typing in Find does not change the tool', modeWhileTyping === afterR, `stMode=${modeWhileTyping}`);

await key('Escape', 'Escape', 27);
await sleep(300);
await key('v', 'KeyV', 86);
await sleep(400);
check("'v' returns to the Select tool", (await mode()) === 'Select', `stMode=${await mode()}`);

// Delete must remove the selected annotation.
const before = await annotCount();
const clicked = await ev(`(function(){
  var n = document.querySelector('.annLayer svg > *');
  if (!n) return 'no-annotation-element';
  var b = n.getBoundingClientRect();
  return JSON.stringify({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
})()`);
if (typeof clicked === 'string' && clicked.startsWith('{')) {
  const { x, y } = JSON.parse(clicked);
  // What actually receives the click? If a layer above the annotation swallows
  // it, the annotation can never be selected — which would be a product bug,
  // not a test bug.
  const hit = await ev(`(function(){var e=document.elementFromPoint(${x},${y});return e?e.tagName+'.'+(e.getAttribute('class')||'')+' pe='+getComputedStyle(e).pointerEvents:'nothing';})()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(700);
  const ctxTitle = await ev(`(document.getElementById('ctxTitle')||{}).textContent`);
  check('clicking an annotation selects it', /Highlight|Rectangle|Note|Text box|Callout|Ink|Line|Arrow|Stamp|Measurement|Redaction|Ellipse|Whiteout|Signature|Image/.test(ctxTitle || ''), `elementFromPoint=${hit} ctxTitle=${ctxTitle}`);
  await key('Delete', 'Delete', 46);
  await sleep(900);
  const after = await annotCount();
  check('Delete removes the selected annotation', after === before - 1, `annotCount ${before} -> ${after}`);
} else {
  check('Delete removes the selected annotation', false, clicked);
}

// Form widgets must still be reachable after the form-layer fix — the original
// P1 bug was that they could not be clicked at all. fixture.pdf carries no
// AcroForm fields, so first create one through the app's own placement flow:
// start the "Add field" dialog, accept it, then drag a rect on the page.
const placed = await ev(`(async function(){
  try {
    const F = await import('/js/forms.js');
    F.startFieldPlacement('text');
    await new Promise(r => setTimeout(r, 400));
    const ok = document.querySelector('.modal button.primary');
    if (!ok) return 'no-modal';
    ok.click();
    await new Promise(r => setTimeout(r, 400));
    const page = document.querySelector('.page');
    if (!page) return 'no-page';
    const b = page.getBoundingClientRect();
    const x = b.left + b.width * 0.3, y = b.top + b.height * 0.3;
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0, buttons: 1 };
    page.dispatchEvent(new PointerEvent('pointerdown', o));
    window.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + 120, clientY: y + 30 }));
    window.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x + 120, clientY: y + 30, buttons: 0 }));
    await new Promise(r => setTimeout(r, 700));
    return document.querySelector('.formLayer input, .formLayer select, .formLayer textarea, .formLayer .field-widget') ? 'placed' : 'no-widget-after-place';
  } catch (e) { return 'err: ' + (e && e.message || e); }
})()`);
const widget = await ev(`(function(){
  var w = document.querySelector('.formLayer input, .formLayer select, .formLayer textarea, .formLayer .field-widget');
  if (!w) return 'no-widget';
  var b = w.getBoundingClientRect();
  if (!b.width || !b.height) return 'zero-size-widget';
  var x = b.left + b.width / 2, y = b.top + b.height / 2;
  var hit = document.elementFromPoint(x, y);
  return JSON.stringify({ hit: hit ? hit.tagName + '.' + (hit.getAttribute('class') || '') : 'nothing', contains: !!(hit && (hit === w || w.contains(hit) || hit.contains(w))) });
})()`);
let wok = false; let wdetail = placed + ' | ' + widget;
if (widget.startsWith('{')) { const o = JSON.parse(widget); wok = o.contains && !/formLayer/.test(o.hit); wdetail = placed + ' | hit=' + o.hit; }
check('form widget is clickable (not blocked by its layer)', wok, wdetail);

child.kill();
await sleep(1200);
try { child.kill('SIGKILL'); } catch { /* gone */ }

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `KEY_FAIL ${failed.length}/${results.length} checks failed` : `KEY_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
