#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Throwaway diagnostic: why does pressing 'r' not switch to the Rectangle tool?
 * Separates three possibilities — the keystroke never reaches the listener, the
 * listener runs but setTool does not update the status bar, or the harness is
 * sending an event type that does not produce a keydown at all.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9419;

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-_probe-keys-'));

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
if (!page) { console.log('PROBE_FAIL no target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const events = [];
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') events.push(m.method);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable', {});
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

for (let i = 0; i < 40; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
await sleep(2500);
await send('Page.bringToFront').catch(() => {});

console.log('booted:', await ev('!!window.__aipdfBooted'));
console.log('errors during boot:', events.length ? events.join(',') : 'none');

// Install a probe listener to see what the page actually receives.
await ev(`window.__probe=[]; document.addEventListener('keydown', function(e){ window.__probe.push('kd:'+e.key+' ctrl='+e.ctrlKey+' target='+(e.target.tagName)); }, true);`);
await ev(`document.getElementById('canvasWrap').focus ? document.getElementById('canvasWrap').focus() : null`);

const stMode = () => ev(`(document.getElementById('stMode')||{}).textContent`);
console.log('stMode before:', await stMode());

// A) exactly what key-test.mjs sends: char + keyUp, no keyDown.
await send('Input.dispatchKeyEvent', { type: 'char', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, text: 'r' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82 });
await sleep(400);
console.log('A) char-style  -> stMode:', await stMode(), ' probe:', JSON.stringify(await ev('window.__probe')));

// B) a real keyDown then char.
await ev('window.__probe=[]');
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, text: 'r' });
await send('Input.dispatchKeyEvent', { type: 'char', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, text: 'r' });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82 });
await sleep(400);
console.log('B) keyDown+char-> stMode:', await stMode(), ' probe:', JSON.stringify(await ev('window.__probe')));

// C) does setTool update the status bar at all, bypassing the keyboard?
await ev(`(function(){var b=document.querySelector('#modeTabs .mode-tab');return b?b.textContent:'none';})()`).then((t) => console.log('a mode tab label:', t));
const direct = await ev(`(function(){
  try {
    var el = document.querySelector('.qbtn[data-act="file:open"]');
    return 'qbtn present: ' + !!el;
  } catch (e) { return 'ERR ' + e.message; }
})()`);
console.log('C) chrome check:', direct);

// D) is the ribbon in Rect mode after B? (proves the tool changed even if stMode lags)
console.log('D) active ribbon tool buttons:', await ev(`Array.from(document.querySelectorAll('.rbtn.active')).map(function(b){return b.getAttribute('aria-label');}).join(',') || 'none'`));
console.log('   canvas tool class:', await ev(`(function(){var w=document.getElementById('canvasWrap');return w?w.className:'missing';})()`));

child.kill();
await sleep(800);
try { child.kill('SIGKILL'); } catch { /* gone */ }
process.exit(0);
