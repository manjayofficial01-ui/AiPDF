#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Redaction integrity in the real app: cover vs. removal, proved on the bytes
 * the writer actually produces.
 *
 * scripts/redact-integrity-test.mjs tests the matching rule against synthetic
 * files. This one drives the application's own pipeline — capture what is under
 * the mark, build the file the way Save would, reopen it with an independent
 * reader, and check — so it proves three things at once:
 *
 *   1. captureRedactionSecrets finds the text under a mark on a real page.
 *   2. The plain Apply path (a black box over live text) is reported as a LEAK.
 *      The checker has to fail here; a check that passes both paths is not a
 *      check.
 *   3. The sanitize path (the page rebuilt as an image) is reported as clean.
 *
 *   node scripts/redact-flow-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9474;
// Fresh profile per run: deleting a fixed .smoke/ Chromium profile trips the
// safe-delete bulk guard once it grows past ~50 files.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-redact-ud-'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
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
  } catch { /* not up */ }
  if (!page) await sleep(400);
}
if (!page) { console.log('REDACT_FAIL no renderer target'); child.kill(); process.exit(1); }

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
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const evJson = async (expression) => { const raw = await ev(expression); try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; } };

for (let i = 0; i < 80; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 80; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2000);
await send('Page.bringToFront').catch(() => {});

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

/* ── 1. A mark is placed on a page that really has the text ─────────────── */

const setup = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var v = await import('/js/viewer.js');
  var r = await import('/js/redaction.js');
  var d = st.activeDoc();
  // Page 1 (0-based 0) of the canonical fixture carries the real, selectable
  // sentence. Older runs used a drifted 4-page save-over file; the fixture
  // guard now restores the generated document, so pin the test to page 1.
  var PAGE = 0;
  var tc = await v.getTextContent(PAGE);
  var item = tc.items.find(function (x) { return /functional test fixture/.test(x.str); }) || tc.items[0];
  var t = item.transform;
  var size = Math.hypot(t[3], t[1]) || 12;
  var rect = [t[4] - 3, t[5] - size * 0.3, t[4] + (item.width || 200) + 3, t[5] + size];
  var secret = await v.textInRect(PAGE, rect);
  var proof = await r.captureRedactionSecrets(d, [{ page: PAGE, rect: rect }]);
  return JSON.stringify({
    rect: rect.map(Math.round), secret: secret.slice(0, 70),
    proofLen: proof.length, proofSecret: (proof[0] || {}).secret || '', native: !!(proof[0] || {}).native,
  });
})()`);
check('the text under a mark is captured before anything changes',
  setup && /functional test fixture/.test(setup.proofSecret) && setup.native === true,
  setup && typeof setup.proofSecret === 'string' ? setup.proofSecret.slice(0, 60) : 'no proof captured');

/* ── 2. The cover path is reported as a leak, not as a redaction ────────── */

const covered = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var r = await import('/js/redaction.js');
  var d = st.activeDoc();
  var PAGE = 0;
  var tc = await (await import('/js/viewer.js')).getTextContent(PAGE);
  var item = tc.items.find(function (x) { return /functional test fixture/.test(x.str); }) || tc.items[0];
  var t = item.transform; var size = Math.hypot(t[3], t[1]) || 12;
  var rect = [t[4] - 3, t[5] - size * 0.3, t[4] + (item.width || 200) + 3, t[5] + size];
  var proof = await r.captureRedactionSecrets(d, [{ page: PAGE, rect: rect }]);
  // What Apply (without sanitize) does: the mark is flagged applied and the
  // writer paints a black box. No operator is removed.
  var a = { id: 'redact-test-1', type: 'redact', page: PAGE, rect: rect, applied: true, text: 'Redacted', color: [0.08, 0.08, 0.08] };
  d.annots.push(a);
  var bytes = await window.__aipdfBuildBytes(d);
  var v = await r.verifyRedactions(bytes, proof);
  d.annots = d.annots.filter(function (x) { return x.id !== 'redact-test-1'; });
  return JSON.stringify({ ok: v.ok, checked: v.checked, leaks: v.leaks.length, verdict: r.redactionVerdict(v), bytes: bytes.length });
})()`);
check('a black box over live text FAILS the integrity check',
  covered && covered.ok === false && covered.leaks === 1, JSON.stringify(covered && covered.verdict));

/* ── 3. Sanitize removes it, and the check says so ──────────────────────── */

const sanitized = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var r = await import('/js/redaction.js');
  var d = st.activeDoc();
  var PAGE = 0;
  var tc = await (await import('/js/viewer.js')).getTextContent(PAGE);
  var item = tc.items.find(function (x) { return /functional test fixture/.test(x.str); }) || tc.items[0];
  var t = item.transform; var size = Math.hypot(t[3], t[1]) || 12;
  var rect = [t[4] - 3, t[5] - size * 0.3, t[4] + (item.width || 200) + 3, t[5] + size];
  var proof = await r.captureRedactionSecrets(d, [{ page: PAGE, rect: rect }]);
  // What Apply & Sanitize does: the page is rebuilt as an image.
  var items = Array.from({ length: d.numPages }, function (_, i) { return { t: 'src', i: i }; });
  d.pageOps = { items: items.map(function (it) { return it.i === PAGE ? { t: 'raster', i: PAGE, rects: [rect], dpi: 200 } : it; }) };
  var bytes = await window.__aipdfBuildBytes(d);
  var v = await r.verifyRedactions(bytes, proof);
  return JSON.stringify({ ok: v.ok, checked: v.checked, leaks: v.leaks.length, unverifiable: v.unverifiable, verdict: r.redactionVerdict(v), bytes: bytes.length });
})()`);
check('a sanitized page PASSES the integrity check',
  sanitized && sanitized.ok === true && sanitized.leaks === 0 && sanitized.checked === 1,
  JSON.stringify(sanitized && sanitized.verdict));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
child.kill();
await sleep(300);
process.exit(failed.length ? 1 : 0);
