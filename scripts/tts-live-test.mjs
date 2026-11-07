#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * TTS + local-fonts live check — boots the real app over CDP and verifies:
 *   1. Read Aloud (local provider) shows the floating player bar with
 *      play/pause, stop and speed controls
 *   2. the same menu item stops it (Acrobat parity, __aipdfReadAloud flag)
 *   3. Read Aloud Settings opens with every provider + Fetch voices + Test
 *   4. the Direct Editor font dropdown gains a "Local fonts" group from the
 *      machine's installed faces
 *   5. screenshots the player bar and the settings dialog for visual review
 *
 *   node scripts/tts-live-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const OUT = path.join(ROOT, '.smoke');
const PORT = 9418;
fs.mkdirSync(OUT, { recursive: true });

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-tts-live-test-'));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, FIXTURE], { cwd: ROOT, env: childEnv });
child.stderr.on('data', () => {});

const target = await (async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!target) { console.log('TTS_LIVE_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
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
// Watchdog: nothing in this script should take 90s — a hang must report, not stall.
setTimeout(() => { console.log('TTS_LIVE_FAIL watchdog timeout (a step hung)'); try { child.kill(); } catch {} process.exit(2); }, 90000).unref?.();
const ev = async (expression, tag = '') => {
  let timedOut = false;
  const res = await Promise.race([
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
    sleep(15000).then(() => { timedOut = true; return null; }),
  ]);
  if (timedOut) { console.log(`STUCK evaluate ${tag} — continuing`); return null; }
  return res && res.result ? res.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const __log = (...a) => console.log(new Date().toISOString().slice(17, 23), ...a);

for (let i = 0; i < 70; i++) {
  if (await ev('!!window.__aipdfBooted')) break;
  await sleep(300);
}
__log('booted');
await sleep(2200);
const errors = [];
send('Runtime.enable');
send('Log.enable');
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {};
    errors.push((d.exception?.description || d.text || 'exception').slice(0, 300));
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push(m.params.args?.map((a) => a.description || a.value).join(' ').slice(0, 300) || 'console.error');
  }
});

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};

/* 1 — start reading: the player bar must appear with its controls. */
__log('start read aloud');
await ev(`window.__aipdfAction('view:readAloud')`, 'readAloud-start');
await sleep(1400);
__log('inspect bar');
const bar = await ev(`(function(){
  const b = document.querySelector('.tts-bar');
  if (!b) return null;
  return JSON.stringify({
    present: true,
    playPause: !!b.querySelector('.tts-btn.primary'),
    stop: [...b.querySelectorAll('.tts-btn')].length >= 2,
    speed: !!b.querySelector('.tts-speed'),
    speedValue: (b.querySelector('.tts-speed') || {}).value,
    info: (b.querySelector('.tts-info') || {}).textContent,
    page: (b.querySelector('.tts-page') || {}).textContent,
  });
})()`);
check('player bar appears with play/pause, stop and speed', !!bar && JSON.parse(bar).playPause && JSON.parse(bar).stop && JSON.parse(bar).speed, bar || 'no .tts-bar');
check('__aipdfReadAloud flag set while reading', await ev('window.__aipdfReadAloud === true'));
await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(OUT, 'tts-player.png'), Buffer.from(r.data, 'base64')));

/* 2 — the same menu item stops it (parity behaviour). */
__log('stop read aloud');
await ev(`window.__aipdfAction('view:readAloud')`, 'readAloud-stop');
await sleep(500);
__log('stopped; checking flag');
check('same menu item stops reading, bar removed', await ev('window.__aipdfReadAloud === false') && !(await ev(`!!document.querySelector('.tts-bar')`)));

/* 3 — settings dialog: providers + fetch/test buttons. */
__log('open tts settings');
await ev(`window.__aipdfAction('view:ttsSettings')`, 'ttsSettings');
await sleep(500);
__log('inspect dialog');
const dlg = await ev(`(function(){
  const m = document.querySelector('.modal');
  if (!m) return null;
  const labels = [...m.querySelectorAll('select option')].map((o) => o.textContent);
  return JSON.stringify({
    providers: [...m.querySelectorAll('select')][0] ? [...[...m.querySelectorAll('select')][0].options].map((o) => o.value) : [],
    fetchVoices: [...m.querySelectorAll('button')].some((b) => /fetch voices/i.test(b.textContent)),
    testVoice: [...m.querySelectorAll('button')].some((b) => /test voice/i.test(b.textContent)),
    hasKey: !!m.querySelector('input[type="password"]'),
  });
})()`);
const d = dlg ? JSON.parse(dlg) : null;
check('settings dialog opens with all six providers', !!d && ['local', 'elevenlabs', 'fish', 'mistral', 'gemini', 'custom'].every((p) => d.providers.includes(p)), dlg || 'no modal');
check('Fetch voices and Test voice controls present', !!d && d.fetchVoices && d.testVoice && d.hasKey);

/* 3b — selecting a provider auto-fills its official base URL. */
const autofill = await ev(`(function(){
  const m = document.querySelector('.modal');
  if (!m) return null;
  const sel = [...m.querySelectorAll('select')][0];
  const inputs = [...m.querySelectorAll('input')];
  const baseUrl = inputs.find((i) => i.type === 'text');
  const read = () => { sel.dispatchEvent(new Event('change')); return baseUrl.value; };
  sel.value = 'elevenlabs'; const eleven = read();
  sel.value = 'fish'; const fish = read();
  sel.value = 'mistral'; const mistral = read();
  sel.value = 'gemini'; const gemini = read();
  sel.value = 'custom'; const custom = read();
  sel.value = 'local'; const local = read();
  return JSON.stringify({ eleven, fish, mistral, gemini, custom, local });
})()`);
const af = autofill ? JSON.parse(autofill) : {};
check('selecting a provider auto-fills its base URL',
  af.eleven === 'https://api.elevenlabs.io/v1'
  && af.fish === 'https://api.fish.audio'
  && af.mistral === 'https://api.mistral.ai/v1'
  && /generativelanguage\.googleapis\.com/.test(af.gemini || '')
  && af.custom === ''
  && af.local === '', autofill || 'no modal');
await send('Page.captureScreenshot', { format: 'png' }).then((r) => fs.writeFileSync(path.join(OUT, 'tts-settings.png'), Buffer.from(r.data, 'base64')));
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(300);

/* 4 — Direct Editor font dropdown: LAZY local fonts.
      Escape the settings dialog first, then arm the Direct Editor so its
      property panel (with the font select) is rendered. The check targets the
      panel's own font select — the one whose options include Helvetica. By
      default the Local fonts group must be LAZY (a single "Show all fonts…"
      item — no machine-wide scan); picking that item expands the full list. */
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(300);
await ev(`window.__aipdfAction('tool:editText')`, 'armEditor');
await sleep(900);
const fontSel = await ev(`(function(){
  const sels = [...document.querySelectorAll('select')].filter((s) =>
    [...s.options].some((o) => o.value === 'Helvetica') && [...s.options].some((o) => o.value === 'Times'));
  const s = sels.find((x) => !!x.offsetParent) || sels[0];
  if (!s) return null;
  const group = [...s.children].find((c) => c.tagName === 'OPTGROUP' && /local fonts/i.test(c.label || ''));
  return JSON.stringify({ found: !!group, lazyItem: group ? group.children[0]?.textContent : '', n: group ? group.children.length : 0, selIndex: sels.indexOf(s) });
})()`, 'fontSel');
const fd = (() => { try { return JSON.parse(fontSel); } catch { return null; } })();
check('font dropdown is lazy by default (Show all fonts…, no full scan)',
  !!fd && fd.found && /show all fonts/i.test(fd.lazyItem || '') && fd.n === 1, fontSel || 'no select');

/* Expand: pick the "Show all fonts…" item and fire the change. */
await ev(`(function(){
  const sels = [...document.querySelectorAll('select')].filter((s) =>
    [...s.options].some((o) => o.value === 'Helvetica') && [...s.options].some((o) => o.value === 'Times'));
  const s = sels.find((x) => !!x.offsetParent) || sels[0];
  const opt = [...s.options].find((o) => o.value === '__showAll__');
  if (!opt) return;
  s.value = '__showAll__';
  s.dispatchEvent(new Event('change'));
})()`);
await sleep(1200);
const fonts = await ev(`(function(){
  const sels = [...document.querySelectorAll('select')].filter((s) =>
    [...s.options].some((o) => o.value === 'Helvetica') && [...s.options].some((o) => o.value === 'Times'));
  const detail = sels.map((s) => {
    const g = [...s.children].find((c) => c.tagName === 'OPTGROUP' && /local fonts/i.test(c.label || ''));
    return { visible: !!s.offsetParent, total: s.options.length,
      group: g ? { faces: g.children.length, first: g.children[0] ? g.children[0].textContent : '' } : null };
  });
  return JSON.stringify(detail);
})()`, 'fontExpand');
const fdx = (() => { try { return JSON.parse(fonts); } catch { return []; } })();
check('Show all fonts… expands the Local fonts group with the machine faces',
  Array.isArray(fdx) && fdx.some((x) => x.group && x.group.faces > 50),
  JSON.stringify(fdx));

/* 5 — View ribbon: rulers + read-aloud buttons, real icons. */
await ev(`(function(){ const b=[...document.querySelectorAll('#modeTabs .mode-tab')].find((x) => x.textContent.trim()==='View'); if(b) b.click(); })()`);
await sleep(400);
const viewTab = await ev(`(function(){
  const titles = [...document.querySelectorAll('#ribbon .rbtn')].map((b) => b.title || '');
  return JSON.stringify({
    titles,
    rulers: titles.some((t) => /ruler/i.test(t)),
    aloud: titles.some((t) => /^read aloud$/i.test(t.trim())),
    aloudSettings: titles.some((t) => /read aloud settings/i.test(t)),
  });
})()`, 'viewTab');
const vt = (() => { try { return JSON.parse(viewTab); } catch { return {}; } })();
check('View ribbon exposes Show rulers, Read aloud and its settings', !!(vt.rulers && vt.aloud && vt.aloudSettings), viewTab || 'no ribbon');
await send('Page.captureScreenshot', { format: 'png' }).then((r) => {
  if (r?.data) fs.writeFileSync(path.join(OUT, 'view-ribbon.png'), Buffer.from(r.data, 'base64'));
});

check('no renderer exceptions during the run', errors.length === 0, errors.slice(0, 2).join(' | '));

console.log(problems ? `\nTTS_LIVE_FAIL ${problems} problem(s)` : `\nTTS_LIVE_PASS all checks green`);
ws.close();
child.kill();
process.exit(problems ? 1 : 0);
