#!/usr/bin/env node
/**
 * Diagnostic probe for the local OCR engine loading path.
 *
 * Boots the real app with the image-only fixture, then — from inside the real
 * renderer — fetches every asset the Tesseract worker needs and reports the
 * HTTP status, size and content-type each one actually returns. Then runs the
 * real recognition call and reports the verbatim progress log + error.
 *
 *   node scripts/ocr-diag.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Newest packaged build (`dist-build`, `dist-build29`, …). */
function packagedExe() {
  const dirs = fs.readdirSync(ROOT)
    .filter((n) => /^dist-build\d*$/.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(ROOT, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const d of dirs) {
    const exe = path.join(ROOT, d.n, 'win-unpacked', 'AiPDF Editor.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return '';
}
const PACKAGED_EXE = packagedExe();
const ELECTRON = PACKAGED_EXE && process.env.AIPDF_TARGET === 'packaged'
  ? PACKAGED_EXE
  : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const EXTRA_ARGS = ELECTRON === PACKAGED_EXE ? [] : ['.'];
const FIXTURE = path.join(ROOT, '.fixtures', 'scan.pdf');
const PORT = 9471;
const UD = path.join(ROOT, '.smoke', `ocr-diag-ud${ELECTRON === PACKAGED_EXE ? '-pkg' : ''}`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.rmSync(UD, { recursive: true, force: true });

const child = spawn(ELECTRON, [...EXTRA_ARGS, FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
console.log(`DIAG target: ${ELECTRON === PACKAGED_EXE ? 'PACKAGED' : 'DEV'} -> ${ELECTRON}`);
child.stdout.on('data', (d) => process.stdout.write(`[main] ${d}`));
child.stderr.on('data', (d) => process.stdout.write(`[main!] ${d}`));
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
if (!page) { console.log('DIAG_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
const logs = [];
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); return; }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[console:${m.params.type}] ${txt}`);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push(`[exception] ${m.params.exceptionDetails.text} ${m.params.exceptionDetails.exception?.description || ''}`);
  }
  if (m.method === 'Log.entryAdded') {
    logs.push(`[log:${m.params.entry.level}] ${m.params.entry.text} (${m.params.entry.url || ''})`);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable').catch(() => {});
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

for (let i = 0; i < 60; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 60; i++) { if (await ev('document.querySelectorAll("#pages .page").length > 0')) break; await sleep(300); }
await sleep(2000);

// 1. What is the app's origin, and does each OCR asset resolve over it?
const probe = await ev(`(async function(){
  var out = { origin: location.origin, assets: [] };
  var names = [
    '/v/tesseract.min.js',
    '/v/tesseract-worker.min.js',
    '/v/tesscore/',
    '/v/tesscore/tesseract-core-simd-lstm.wasm.js',
    '/v/tesscore/tesseract-core-simd.wasm.js',
    '/v/tesscore/tesseract-core.wasm.js',
    '/v/tesscore/tesseract-core-simd-lstm.wasm',
    '/v/tessdata/eng.traineddata.gz',
    '/v/tessdata/osd.traineddata.gz'
  ];
  for (var name of names) {
    try {
      var r = await fetch(name);
      var b = await r.arrayBuffer();
      out.assets.push({ name: name, status: r.status, size: b.byteLength, type: r.headers.get('content-type') });
    } catch (e) { out.assets.push({ name: name, error: String(e && e.message || e) }); }
  }
  return out;
})()`);
console.log('=== ORIGIN:', probe.origin, '===');
for (const a of probe.assets) {
  console.log(`  ${a.status || 'ERR'}  ${String(a.size).padStart(9)}  ${a.type || ''}  ${a.name}${a.error ? '  -> ' + a.error : ''}`);
}

// 2. What does the main process say about the bundled OCR assets?
const health = await ev(`(async function(){ var r = await fetch('/__ocr-health'); return await r.json(); })()`);
console.log('\n=== /__ocr-health ===');
console.log('  ok=' + health.ok, 'corePresent=' + health.tesscorePresent, 'tessdataExists=' + health.tessdataExists);
console.log('  tesscore=' + health.tesscore, '\n  tessdata=' + health.tessdata);

// 3. Run the real recognition call and capture verbatim progress.
console.log('\n=== RUN recognizePageForEditing ===');
const run = await send('Runtime.evaluate', {
  expression: `(async function(){
    var te = await import('/js/textedit.js');
    var progress = [];
    try {
      var res = await te.recognizePageForEditing(0, { langs: 'eng', onProgress: function(m){ progress.push(m.status + ':' + Math.round((m.progress||0)*100) + '%'); } });
      return { ok: res.ok === true, blocks: res.blocks, confidence: res.confidence, progress: progress.slice(-14) };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), progress: progress.slice(-14) };
    }
  })()`,
  returnByValue: true,
  awaitPromise: true,
});
console.log(JSON.stringify(run.result.value, null, 2));

/* ------------------------------------------------------------ assertions */

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

check('health endpoint reports OCR assets ok', health.ok === true,
  `core=${health.tesscorePresent} tessdata=${health.tessdataExists}`);

const byName = Object.fromEntries(probe.assets.map((a) => [a.name, a]));
const must200 = [
  '/v/tesseract.min.js',
  '/v/tesseract-worker.min.js',
  '/v/tesscore/tesseract-core-simd-lstm.wasm.js',
  '/v/tesscore/tesseract-core-simd.wasm.js',
  '/v/tesscore/tesseract-core.wasm.js',
  '/v/tesscore/tesseract-core-simd-lstm.wasm',
  '/v/tessdata/eng.traineddata.gz',
  '/v/tessdata/osd.traineddata.gz',
];
for (const name of must200) {
  const a = byName[name];
  check(`${name} returns 200`, a && a.status === 200, a ? `${a.status} ${a.size}` : 'no response');
}

const rec = run.result.value || {};
check('recognizePageForEditing succeeds', rec.ok === true, rec.error || `blocks=${rec.blocks}`);
check('recognised at least 4 blocks', (rec.blocks || 0) >= 4, `blocks=${rec.blocks}`);
check('confidence reported', typeof rec.confidence === 'number' && rec.confidence > 50, `confidence=${rec.confidence}`);

child.kill();
await sleep(300);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
