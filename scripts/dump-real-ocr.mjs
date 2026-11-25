#!/usr/bin/env node
import { electronPath, launchElectron, freePort } from './lib/electron-harness.mjs';
/**
 * Dump the OCR lines the app recognises for the real tender PDF to
 * .fixtures/real-ocr-lines.json — so the pure table-split pipeline can be
 * iterated in Node without booting the app each time.
 *
 *   node scripts/dump-real-ocr.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = electronPath();
const FILE = 'D:\\Advertisement\\ad\\Ok\\3\\Sunmoon Media 4x12 Gorakha sadak yojana.pdf';
const OUT = path.join(ROOT, '.fixtures', 'real-ocr-lines.json');
const PORT = await freePort();
const UD = path.join(ROOT, '.smoke', 'table-ocr-ud');

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;
const child = launchElectron(['.', FILE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env: childEnv });
child.stderr.on('data', () => {});
setTimeout(() => { console.log('DUMP_FAIL watchdog'); try { child.kill(); } catch {} process.exit(2); }, 300000).unref?.();

const target = await (async () => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!target) { console.log('DUMP_FAIL no renderer'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

for (let i = 0; i < 70; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 40; i++) { if ((await ev('window.__aipdfState.docs[0]?.numPages || 0')) > 0) break; await sleep(500); }
console.log('doc open, running OCR…');
const run = ev(`window.__aipdfRunOcrTest ? window.__aipdfRunOcrTest() : null`);
let result = null;
for (let i = 0; i < 60; i++) {
  result = await Promise.race([Promise.resolve(run).catch((e) => ({ execError: e.message })), sleep(5000).then(() => null)]);
  if (result) break;
}
console.log('ocr: ' + JSON.stringify(result).slice(0, 150));

const data = await ev(`JSON.stringify({
  dpi: window.__aipdfState.docs[0]?.ocr?.[0]?.dpi || 200,
  pageW: window.__aipdfState.docs[0]?.pageSizes?.[0]?.w,
  pageH: window.__aipdfState.docs[0]?.pageSizes?.[0]?.h,
  lines: (window.__aipdfState.docs[0]?.ocr?.[0]?.lines || []).map((l) => ({
    text: l.text, bbox: l.bbox, confidence: l.confidence,
    words: (l.words || []).map((w) => ({ text: w.text, bbox: w.bbox })),
  })),
})`);
fs.writeFileSync(OUT, data);
console.log('WROTE ' + OUT + ' (' + fs.statSync(OUT).size + ' bytes)');
ws.close();
child.kill();
process.exit(0);
