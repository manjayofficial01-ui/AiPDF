#!/usr/bin/env node
/**
 * Signature detection: does the app know a file is signed before it overwrites
 * it? Saving rebuilds every byte, which invalidates an applied /ByteRange
 * signature — so the first requirement is noticing one.
 *
 * Checks the detector the save guard is built on, against files the app itself
 * writes: one carrying a real signature dictionary, one carrying an *empty*
 * signature field (which costs nothing to overwrite and must not warn), and one
 * with no signature at all.
 *
 *   node scripts/signature-guard-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9476;
const UD = path.join(ROOT, '.smoke', 'signature-guard-ud');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.rmSync(UD, { recursive: true, force: true });
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
if (!page) { console.log('SIGUARD_FAIL no renderer target'); child.kill(); process.exit(1); }

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
await sleep(1500);
await send('Page.bringToFront').catch(() => {});

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const r = await evJson(`(async function(){
  var PL = await import('/v/pdf-lib.js');
  var fs = await import('/js/pdfwrite.js');
  var name = PL.PDFName;

  async function build(kind) {
    var d = await PL.PDFDocument.create();
    var p = d.addPage([300, 200]);
    var ctx = d.context;
    if (kind !== 'none') {
      var sig = PL.PDFDict.withContext(ctx);
      sig.set(name.of('Type'), name.of('Sig'));
      sig.set(name.of('Name'), PL.PDFString.of('Signed by AiPDF test'));
      if (kind === 'applied') {
        // An applied signature covers the file in two byte ranges; that key is
        // what makes it a signature rather than a field waiting to be signed.
        var br = PL.PDFArray.withContext(ctx);
        [0, 10, 200, 40].forEach(function (n) { br.push(PL.PDFNumber.of(n)); });
        sig.set(name.of('ByteRange'), br);
      }
      var ref = ctx.register(sig);
      var arr = PL.PDFArray.withContext(ctx);
      arr.push(ref);
      p.node.set(name.of('Annots'), arr);
    }
    return await d.save();
  }

  var signed = await build('applied');
  var empty = await build('field');
  var plain = await build('none');
  return JSON.stringify({
    signed: await fs.countSignatures(signed),
    empty: await fs.countSignatures(empty),
    plain: await fs.countSignatures(plain),
    garbage: await fs.countSignatures(new Uint8Array([1,2,3,4,5])),
  });
})()`);

check('an applied /ByteRange signature is detected', r && r.signed >= 1, `count=${r && r.signed}`);
check('an empty signature field is not mistaken for a signature', r && r.empty === 0, `count=${r && r.empty}`);
check('an unsigned file reports no signatures', r && r.plain === 0, `count=${r && r.plain}`);
check('an unreadable file does not crash the check', r && r.garbage === 0, `count=${r && r.garbage}`);

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
child.kill();
await sleep(300);
process.exit(failed.length ? 1 : 0);
