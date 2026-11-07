#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Document Assurance — end-to-end integration suite (Electron + CDP).
 *
 *   node scripts/assurance-test.mjs
 *
 * `forensics-test.mjs` proves the pure analysis engine. This proves the engine
 * is actually WIRED INTO THE RUNNING APP: the ribbon tab, the side panels, the
 * three dialogs, the local agent API, the offline timeline and the premium
 * view state. It opens a real fixture PDF in a real Electron window.
 *
 * Notes:
 *  - Uses a per-run profile in os.tmpdir(). Fixed `.smoke/*` profiles are a
 *    trap: the safe-delete shim refuses to remove trees past ~50 files.
 *  - Dialog-opening actions are dispatched WITHOUT awaiting them: the action
 *    resolves when the modal closes, so awaiting would deadlock the probe.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9431;
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-assurance-'));
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── CDP harness (one persistent socket, id-matched replies) ───────────── */

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const exceptions = [];
  let nextId = 0;
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(p.timer);
      p.resolve(m);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params && m.params.exceptionDetails;
      exceptions.push((d && (d.exception && d.exception.description || d.text)) || 'unknown');
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 25000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      const d = r.result.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || 'evaluation failed');
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ready, send, ev, exceptions, close: () => ws.close() };
}

async function findPageTarget() {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch { /* devtools port not up yet */ }
    await sleep(400);
  }
  return null;
}

/** Repeat a DOM probe until it is truthy or the deadline expires. */
async function until(cdp, expression, ms = 6000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { const v = await cdp.ev(expression); if (v) return v; } catch { /* probe not ready */ }
    await sleep(250);
  }
  return null;
}

/** Read the open modal's title, then dismiss it through its real close button. */
async function modalTitle(cdp) {
  return until(cdp, `(function(){ var m=document.querySelector('.modal-backdrop .modal'); return m && m.querySelector('.modal-head h3') ? m.querySelector('.modal-head h3').textContent : null; })()`, 10000);
}
async function closeModal(cdp) {
  await cdp.ev(`(function(){ var b=document.querySelector('.modal-backdrop .modal-head .icon-btn'); if(b) b.click(); return !!b; })()`);
  await until(cdp, `!document.querySelector('.modal-backdrop')`, 5000);
}

/* ── Launch ────────────────────────────────────────────────────────────── */

if (!fs.existsSync(FIXTURE)) {
  console.log('ASSURANCE_FAIL fixture missing: ' + FIXTURE);
  process.exit(1);
}
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, [
  '.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, FIXTURE,
], { cwd: ROOT, env: childEnv, windowsHide: false });
child.stdout.on('data', (d) => process.stdout.write(String(d)));
child.stderr.on('data', (d) => process.stderr.write(String(d)));
let earlyExit = null;
child.on('exit', (code) => { earlyExit = code; });

let cdp = null;
try {
  const page = await findPageTarget();
  check('renderer CDP target is reachable', !!page, page ? '' : `child exit=${earlyExit}`);
  if (!page) throw new Error('no CDP page target');

  cdp = connect(page.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  const booted = await until(cdp, `!!window.__aipdfBooted && typeof window.aipdf === 'object'`, 25000);
  check('renderer booted with the local agent API installed', !!booted,
    booted ? '' : `child exit=${earlyExit}`);
  if (!booted) throw new Error('renderer did not boot');

  // Give the startup file open + baseline snapshot a moment to land.
  await sleep(1200);

  console.log('── wiring / boot state ──────────────────────────────────────────');

  const state = await cdp.ev(`(function(){
    return {
      version: window.aipdf.version,
      brand: (document.getElementById('brandVer') || {}).textContent,
      css: [].map.call(document.styleSheets, function(s){ return (s.href||'').split('/').pop(); }),
      panels: Object.keys(window.__aipdfSidePanels || {}),
      tabs: [].map.call(document.querySelectorAll('#modeTabs .mode-tab'), function(b){ return b.textContent.trim(); }),
      stLocal: !!document.getElementById('stLocal'),
      stLocalIcon: !!(document.getElementById('stLocalIc') || {}).innerHTML,
      doc: window.aipdf.info(),
    };
  })()`);

  check('agent reports the real running build', state.version === APP_VERSION,
    `${state.version} vs package ${APP_VERSION}`);
  check('title bar version chip matches', state.brand === `v${APP_VERSION}`, String(state.brand));
  check('premium.css is loaded and is the final stylesheet',
    state.css.includes('premium.css') && state.css[state.css.length - 1] === 'premium.css',
    state.css.join(','));
  check('both new side panels are registered',
    state.panels.includes('assurance') && state.panels.includes('timeline'), state.panels.join(','));
  check('Assurance ribbon tab is present', state.tabs.includes('Assurance'), state.tabs.join('|'));
  check('local-first trust chip is rendered with its icon', state.stLocal && state.stLocalIcon);
  check('fixture PDF is open in the editor', state.doc.open === true && state.doc.pages > 0,
    JSON.stringify(state.doc));

  console.log('── offline analysis through the agent API ──────────────────────');

  const sec = await cdp.ev(`window.aipdf.inspect()`);
  check('inspect() returns a real forensic report',
    !!(sec && sec.ok && sec.size > 0 && Array.isArray(sec.findings)),
    sec ? `score=${sec.score} findings=${sec.findings.length} bytes=${sec.size}` : 'null');
  check('inspect() reports the PDF header', !!(sec && sec.facts && /^1\./.test(sec.facts.header)),
    sec && sec.facts && sec.facts.header);

  const a11y = await cdp.ev(`window.aipdf.accessibility()`);
  check('accessibility() returns a PDF/UA report',
    !!(a11y && a11y.ok && a11y.checks && a11y.checks.length >= 14 && a11y.grade),
    a11y ? `score=${a11y.score} grade=${a11y.grade} checks=${a11y.checks.length}` : 'null');

  const actions = await cdp.ev(`window.aipdf.actions()`);
  const actionIds = (actions || []).map((a) => a.action);
  const needed = ['assurance:inspect', 'assurance:accessibility', 'assurance:sanitize',
    'assurance:a11yFix', 'assurance:timeline', 'assurance:checkpoint', 'assurance:trust',
    'view:focus', 'view:cycleSkin', 'view:highContrast', 'view:assurance', 'view:timeline'];
  const missing = needed.filter((a) => !actionIds.includes(a));
  check('every new command is enumerated by actions()', missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : `${actions.length} commands total`);

  console.log('── Assurance ribbon tab ─────────────────────────────────────────');

  await cdp.ev(`(function(){
    var b = [].slice.call(document.querySelectorAll('#modeTabs .mode-tab'))
      .find(function(x){ return x.textContent.trim() === 'Assurance'; });
    if (b) b.click(); return !!b;
  })()`);
  await sleep(350);
  // Non-"large" ribbon buttons are intentionally icon-only; their accessible
  // name lives in `title` (wiring-test.mjs locks that convention).
  const ribbon = await cdp.ev(`(function(){
    return { titles: [].map.call(document.querySelectorAll('#ribbon .rbtn'), function(b){ return b.title; }),
             active: (document.querySelector('#modeTabs .mode-tab.active') || {}).textContent };
  })()`);
  const expectLabels = ['Security Inspector', 'Accessibility Checker', 'Flatten & Sanitize',
    'Apply safe a11y fixes', 'Version Timeline', 'New checkpoint', 'Trust Center',
    'Assurance panel', 'Timeline panel'];
  const absent = expectLabels.filter((l) => !ribbon.titles.includes(l));
  check('Assurance ribbon renders every tool', absent.length === 0,
    absent.length ? `missing ${absent.join(', ')}; got ${ribbon.titles.join(', ')}` : `${ribbon.titles.length} buttons`);
  check('Assurance tab is the active mode', ribbon.active === 'Assurance', String(ribbon.active));

  console.log('── dialogs ──────────────────────────────────────────────────────');

  // Do NOT await: onMenuAction resolves when showModal closes.
  await cdp.ev(`window.aipdf.run('assurance:inspect'); 'started'`);
  const t1 = await modalTitle(cdp);
  check('Security Inspector opens', /Security Inspector/.test(t1 || ''), String(t1));
  const inspector = await cdp.ev(`(function(){
    return { findings: document.querySelectorAll('.modal .asr-find').length,
             ring: !!document.querySelector('.modal .asr-ring'),
             actions: document.querySelectorAll('.modal .asr-actions button').length };
  })()`);
  check('Security Inspector renders score ring and actions',
    inspector.ring && inspector.actions >= 3, JSON.stringify(inspector));
  await closeModal(cdp);

  await cdp.ev(`window.aipdf.run('assurance:accessibility'); 'started'`);
  const t2 = await modalTitle(cdp);
  check('Accessibility Checker opens', /Accessibility Checker/.test(t2 || ''), String(t2));
  const checker = await cdp.ev(`document.querySelectorAll('.modal .asr-find').length`);
  check('Accessibility Checker lists all checks', checker >= 14, `${checker} rows`);
  await closeModal(cdp);

  await cdp.ev(`document.getElementById('stLocal').click(); 'clicked'`);
  const t3 = await modalTitle(cdp);
  check('Trust Center opens from the status-bar chip', /Trust Center/.test(t3 || ''), String(t3));
  const trust = await cdp.ev(`document.querySelectorAll('.modal .trust-row').length`);
  check('Trust Center shows the egress posture rows', trust >= 6, `${trust} rows`);
  await closeModal(cdp);

  await cdp.ev(`window.aipdf.run('assurance:timeline'); 'started'`);
  const t4 = await modalTitle(cdp);
  check('Version Timeline dialog opens', /Version Timeline/.test(t4 || ''), String(t4));
  const timelineDom = await cdp.ev(`(function(){
    return { host: !!document.querySelector('.modal .tl'),
             rows: document.querySelectorAll('.modal .tl-row').length };
  })()`);
  check('Timeline renders its version list', timelineDom.host, JSON.stringify(timelineDom));
  await closeModal(cdp);

  console.log('── local version timeline ─────────────────────────────────────');

  const versions = await until(cdp, `(async function(){
    var v = await window.aipdf.versions(); return v.length ? v : null;
  })()`, 8000);
  check('opening a file records a baseline version', !!(versions && versions.length >= 1),
    versions ? `${versions.length}: ${versions.map((v) => v.label).join(', ')}` : 'none');
  check('snapshots carry size and never expose raw bytes in the agent API',
    !!(versions && versions.every((v) => typeof v.size === 'number' && !('bytes' in v))));

  console.log('── side panels ─────────────────────────────────────────────────');

  await cdp.ev(`window.aipdf.run('view:assurance'); 'ok'`);
  const ap = await until(cdp, `document.querySelector('#sideBody .asr-panel-score') ? true : null`, 8000);
  check('Assurance rail panel renders a live trust score', !!ap);
  const links = await cdp.ev(`document.querySelectorAll('#sideBody .asr-link').length`);
  check('Assurance panel exposes its action links', links >= 5, String(links));

  await cdp.ev(`window.aipdf.run('view:timeline'); 'ok'`);
  const tp = await until(cdp, `document.querySelector('#sideBody .tl') ? true : null`, 8000);
  check('Version Timeline rail panel renders', !!tp);

  console.log('── premium view state ──────────────────────────────────────────');

  await cdp.ev(`window.aipdf.run('view:focus'); 'ok'`);
  const focusOn = await cdp.ev(`(function(){
    return { cls: document.body.classList.contains('focus-mode'),
             exit: !!document.querySelector('.focus-exit:not([hidden])') };
  })()`);
  check('focus mode hides chrome and shows an exit control', focusOn.cls && focusOn.exit,
    JSON.stringify(focusOn));
  await cdp.ev(`window.aipdf.run('view:focus'); 'ok'`);
  const focusOff = await cdp.ev(`!document.body.classList.contains('focus-mode')`);
  check('focus mode toggles back off', focusOff === true);

  // The palette catalogue grew from two skins to nine; derive the expected
  // "next" id from the live API instead of hardcoding one, so adding a theme
  // never turns this into a false regression.
  const skin = await cdp.ev(`(async function(){
    var before = window.aipdf.theme();
    var next = before.available[1] && before.available[1].id;
    await window.aipdf.run('view:cycleSkin');
    return { skin: document.documentElement.dataset.skin, expected: next,
             before: before.skin, count: before.available.length };
  })()`);
  check('appearance cycling applies a skin token',
    !!skin.expected && skin.skin === skin.expected && skin.count >= 8, JSON.stringify(skin));

  // onMenuAction is async: without awaiting, the assertion can run before the
  // body class is toggled. Await it, and also prove the new restore behaviour.
  const hc = await cdp.ev(`(async function(){
    await window.aipdf.run('view:highContrast');
    var on = { skin: document.documentElement.dataset.skin,
               cls: document.body.classList.contains('hc') };
    await window.aipdf.run('view:highContrast');
    return { on: on, back: document.documentElement.dataset.skin };
  })()`);
  check('high contrast skin is applied', hc.on && hc.on.skin === 'contrast' && hc.on.cls, JSON.stringify(hc));
  check('high contrast restores the previous palette', hc.back === skin.skin, JSON.stringify(hc));

  // Restore defaults so a reused profile never looks broken.
  await cdp.ev(`(async function(){
    var s = await import('/js/store.js');
    s.settings.skin = 'default'; s.settings.focusMode = false;
    s.saveSettings();
    document.documentElement.dataset.skin = 'default';
    document.body.classList.remove('hc','focus-mode');
    return true;
  })()`);

  const errors = cdp.exceptions.filter((e) => !/ResizeObserver loop/i.test(e));
  check('no uncaught renderer exceptions during the run', errors.length === 0,
    errors.slice(0, 3).join(' | '));
} catch (e) {
  check('integration suite completed without a harness error', false, e && e.message);
} finally {
  if (cdp) { try { cdp.close(); } catch { /* ignore */ } }
  try { child.kill(); } catch { /* ignore */ }
  await sleep(1500);
  try { if (!child.killed) child.kill('SIGKILL'); } catch { /* ignore */ }
  // This profile was created by this run, in the OS temp directory. Failure is
  // harmless — the next run uses a brand-new directory.
  try { fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 2 }); } catch { /* ignore */ }
}

console.log(problems ? `ASSURANCE_FAIL ${problems} check(s) red` : 'ASSURANCE_PASS all checks green');
process.exit(problems ? 1 : 0);
