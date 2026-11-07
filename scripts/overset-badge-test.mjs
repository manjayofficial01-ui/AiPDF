#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Live verification of the story model's UI surface.
 *
 * The research makes overset a FIRST-CLASS result: a layout that cannot hold its
 * whole story must say so, rather than leaving the user to discover a viewer
 * quietly clipping the text. Two pieces of UI carry that:
 *
 *   1. the overset badge drawn on the edit (`g.overset-badge`), and
 *   2. the Story / Composition readout on the Direct Editor properties panel
 *      (`On save`, `Mode`, `Frames`, `Placed N of M characters`, `Overset`).
 *
 * It also covers the three explicit actions the research asks for — "Make
 * paragraph" with a user-chosen separator, and "Link frames" / "Unlink frames" —
 * because they are the only way to author a multi-frame story.
 *
 * Asserted against the REAL app over CDP: the badge is an SVG element the writer
 * never produces, and the panel is built by renderContext from live state, so
 * neither exists outside a rendered window.
 *
 *   node scripts/overset-badge-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9548;

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-overset-badge-test-'));

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
if (!page) { console.log('OB_FAIL no renderer target'); child.kill(); process.exit(1); }

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

const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
  return r.result ? r.result.value : undefined;
};

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

/** Click a ribbon button by its tooltip title. */
const ribbon = (title) => ev(`(function(){
  var b = Array.from(document.querySelectorAll('.rbtn')).find(function(x){ return x.title === ${JSON.stringify(title)}; });
  if (!b) return false;
  b.click();
  return true;
})()`);

/** Replace the inline editor's text with `text`. */
async function retype(text) {
  await ev(`(function(){
    var s = document.querySelector('.direct-editor-surface');
    if (!s) return false;
    s.focus();
    var r = document.createRange(); r.selectNodeContents(s);
    var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    return true;
  })()`);
  for (const ch of text) await send('Input.dispatchKeyEvent', { type: 'char', text: ch, key: ch });
  await sleep(250);
}

/* ══ 1. Arm the Direct Editor and open a block ═══════════════════════════ */

// The renderer target appears before app.js has finished booting, so the ribbon
// buttons may not exist yet. Wait for the boot flag AND the buttons, or the very
// first click lands on nothing and every later step fails for the wrong reason.
{
  const bootDeadline = Date.now() + 30000;
  let ready = false;
  while (!ready && Date.now() < bootDeadline) {
    ready = await ev(`!!window.__aipdfBooted && document.querySelectorAll('.rbtn').length > 0 && document.querySelectorAll('.page').length > 0`);
    if (ready !== true) await sleep(300);
  }
  check('the app finished booting and painted the ribbon', ready === true);
}

const armed = await ribbon('Direct Editor');
check('the Direct Editor can be armed from the ribbon', armed === true);
await sleep(900);

const block = await ev(`(function(){
  var n = document.querySelectorAll('.editable-text-block');
  if (!n.length) return null;
  var b = n[0].getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
})()`);
if (!block) { console.log('OB_FAIL no editable block on the fixture'); child.kill(); process.exit(1); }
await click(block.x, block.y);
await sleep(300);

// The click asks for the text first (prefilled with the detected text). This
// suite retypes the block afterwards, so accept the detected text and continue.
if (await ev(`!!document.querySelector('.de-ask-text')`)) {
  await ev(`document.querySelector('.de-ask-text').focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(500);
}
check('answering the text question opens the editor',
  (await ev(`!!document.querySelector('.direct-editor-surface')`)) === true);

/* ══ 2. A story that cannot fit must be reported, not silently clipped ════ */

// Long enough to need several lines inside a one-line-tall block, so the frame
// genuinely cannot hold it and overset is unavoidable.
const LONG = 'This replacement sentence is deliberately far too long to fit inside a single line text block so the layout model must report the leftover lines as overset instead of quietly clipping them away.';
await retype(LONG);
await sleep(200);

const away = await ev(`(function(){
  var p = document.querySelector('.page'); var b = p.getBoundingClientRect();
  return { x: Math.round(b.left + 12), y: Math.round(b.bottom - 12) };
})()`);
await click(away.x, away.y);
await sleep(700);

const badge = await ev(`(function(){
  var g = document.querySelector('g.overset-badge');
  return { n: document.querySelectorAll('g.overset-badge').length, text: g ? g.textContent : null };
})()`);
check('an overset edit paints an overset badge on the page', badge.n >= 1, `badges=${badge.n}`);
check('the badge names the leftover lines', /^\+\d+\s*lines?$/i.test(String(badge.text || '').trim()),
  `badge=${JSON.stringify(badge.text)}`);

/* ══ 3. The properties panel reads the same story ════════════════════════ */

// The commit leaves the edit's own box selected, and selecting a Direct Editor
// box must open the EDIT's panel — the box is the on-screen handle for the
// story, not just a typewriter box.

const panel = await ev(`(function(){
  var title = document.getElementById('ctxTitle').textContent;
  var groups = {};
  Array.from(document.querySelectorAll('#ctxBody .prop-group')).forEach(function(g){
    var t = g.querySelector('.prop-title');
    var rows = {};
    Array.from(g.querySelectorAll('.kv')).forEach(function(kv){
      var b = kv.querySelector('b'); var s = kv.querySelector('span');
      if (b && s) rows[b.textContent.trim()] = s.textContent.trim();
    });
    var hint = g.querySelector('.hint');
    groups[t ? t.textContent.trim() : '?'] = { rows: rows, hint: hint ? hint.textContent.trim() : null };
  });
  return { title: title, groups: groups };
})()`);

check('selecting the edit box opens the text edit panel, not a plain box panel',
  /Text block/i.test(panel.title || ''), `title=${panel.title}`);
check('the box keeps its own appearance controls alongside the story',
  !!(panel.groups && (panel.groups.Box || panel.groups.Appearance)), JSON.stringify(Object.keys(panel.groups || {})));
const story = panel.groups && panel.groups.Story;
check('the panel shows a Story group', !!story, JSON.stringify(Object.keys(panel.groups || {})));
check('the Story group names the composition mode', !!story && !!story.rows.Mode, story && JSON.stringify(story.rows));
check('the Story group counts the frames', !!story && /1 \(in place\)|linked/.test(story.rows.Frames || ''), story && story.rows.Frames);
check('the Story group warns that the text is overset',
  !!story && !!story.hint && /overset/i.test(story.hint), story && story.hint);

const comp = panel.groups && panel.groups.Composition;
check('the panel shows a Composition readout', !!comp, JSON.stringify(Object.keys(panel.groups || {})));
check('the Composition readout counts placed vs total characters',
  !!comp && /^\d+ of \d+ characters$/.test(comp.rows.Placed || ''), comp && comp.rows.Placed);
check('the Composition readout says the story is overset',
  !!comp && /^yes/.test(comp.rows.Overset || ''), comp && comp.rows.Overset);

/* ══ 4. The three explicit actions: Make paragraph, Link, Unlink ═════════ */

const makeBtn = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('#ctxBody button')).find(function(x){ return x.textContent === 'Make paragraph with next block'; });
  return !!b;
})()`);
check('the panel offers "Make paragraph with next block"', makeBtn === true);

const sepCount = await ev(`(function(){
  var g = Array.from(document.querySelectorAll('#ctxBody .prop-group')).find(function(x){
    var t = x.querySelector('.prop-title'); return t && t.textContent.trim() === 'Make paragraph';
  });
  if (!g) return null;
  return Array.from(g.querySelectorAll('select option')).map(function(o){ return o.textContent; });
})()`);
check('the separator is an explicit user choice, never guessed',
  Array.isArray(sepCount) && sepCount.length === 3, JSON.stringify(sepCount));

const linkOk = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('#ctxBody button')).find(function(x){ return x.textContent === 'Continue on next page'; });
  if (!b || b.disabled) return 'missing';
  b.click();
  return 'clicked';
})()`);
check('"Continue on next page" is offered for a story with a following page', linkOk === 'clicked', linkOk);
await sleep(700);

const frames0 = await ev(`document.querySelectorAll('.story-frame').length`);
check('linking frames draws the story frame on the page', frames0 >= 1, `frames=${frames0}`);

// Threading drops the single box, so the frame outline is now the story's only
// handle. Clicking it must re-open the story's panel.
const frameHit = await ev(`(function(){
  var r = document.querySelector('.story-frame');
  if (!r) return null;
  var b = r.getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + Math.min(6, b.height / 2)) };
})()`);
check('the frame outline is present as a click target', !!frameHit);
if (frameHit) await click(frameHit.x, frameHit.y);
await sleep(400);

const threaded = await ev(`(function(){
  var rows = {};
  Array.from(document.querySelectorAll('#ctxBody .kv')).forEach(function(kv){
    var b = kv.querySelector('b'); var s = kv.querySelector('span');
    if (b && s) rows[b.textContent.trim()] = s.textContent.trim();
  });
  var unlink = Array.from(document.querySelectorAll('#ctxBody button')).find(function(x){ return x.textContent === 'Unlink frames'; });
  return { title: document.getElementById('ctxTitle').textContent, frames: document.querySelectorAll('.story-frame').length,
    rows: rows, unlinkDisabled: unlink ? unlink.disabled : null };
})()`);
check('clicking a frame re-opens the story panel', /Text block/i.test(threaded.title || ''), `title=${threaded.title}`);
check('the Story group now reports 2 linked frames', /2 linked/.test(threaded.rows.Frames || ''), threaded.rows.Frames);
check('the mode flips to a flowing paragraph', /Flowing paragraph/.test(threaded.rows.Mode || ''), threaded.rows.Mode);
check('"Unlink frames" becomes available once there are two', threaded.unlinkDisabled === false, `disabled=${threaded.unlinkDisabled}`);

const unlinked = await ev(`(function(){
  var b = Array.from(document.querySelectorAll('#ctxBody button')).find(function(x){ return x.textContent === 'Unlink frames'; });
  if (!b || b.disabled) return 'missing';
  b.click();
  return 'clicked';
})()`);
check('"Unlink frames" is offered for a threaded story', unlinked === 'clicked', unlinked);
await sleep(700);

const back = await ev(`(function(){
  return { frames: document.querySelectorAll('.story-frame').length,
    framesTxt: (function(){ var kv = Array.from(document.querySelectorAll('#ctxBody .kv')).find(function(k){ var b = k.querySelector('b'); return b && b.textContent.trim() === 'Frames'; }); return kv ? kv.querySelector('span').textContent.trim() : null; })() };
})()`);
check('unlinking collapses the story back to one frame', back.frames === 0 && /1 \(in place\)/.test(back.framesTxt || ''),
  `frames=${back.frames} txt=${back.framesTxt}`);

console.log(`\nOB_RESULT pass=${pass} fail=${fail}`);
child.kill();
process.exit(fail ? 1 : 0);
