#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * PDF → Word (AI) — the converter ported from `pdf2word-max`.
 *
 * Three layers are checked, in order of how much they can lie:
 *
 *   1. The OOXML writer, headlessly: the ZIP really is a ZIP, it carries the
 *      seven parts Word expects, `[Content_Types].xml` comes first, and the
 *      body has heading styles, bold/italic runs, a table, a page break, list
 *      bullets and escaped ampersands.
 *   2. The bytes on disk: we build a .docx in the renderer, write it out and
 *      unzip it in Node, then check the XML actually contains the content.
 *   3. The whole flow with the model swapped for a stub: real page rendering →
 *      real JPEG encoding → the real options dialog → the real packer → a real
 *      file on disk. Only the network call is faked.
 *
 *   node scripts/pdf2word-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');

if (!fs.existsSync(ELECTRON)) { console.log('P2W_FAIL missing electron ' + ELECTRON); process.exit(1); }

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const PORT = await freePort();
// A per-run profile: the user's installed app holds a single-instance lock on
// the default one, which would make this second instance exit immediately.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-p2w-ud-'));
const OUT = path.join(UD, 'out.docx');
const OUT2 = path.join(UD, 'out-gem.docx');
const OUT3 = path.join(UD, 'out-tbl.docx');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`];
if (fs.existsSync(FIXTURE)) args.splice(1, 0, FIXTURE);
const child = spawn(ELECTRON, args, { cwd: ROOT, env });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch { /* gone */ } process.exit(2); }, 240000);
bail.unref?.();

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!target) await sleep(400);
}
if (!target) { console.log('P2W_FAIL no renderer target'); child.kill(); process.exit(1); }

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
const info = (name, detail = '') => console.log(`INFO  ${name}${detail ? `  — ${detail}` : ''}`);

for (let i = 0; i < 120; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
await sleep(900);
check('app booted with the converter wired', !!(await ev('typeof window.__aipdfDocxSelfTest === "function" && typeof window.__aipdfConvertToWord === "function"')));

/* ── 1. OOXML writer ─────────────────────────────────────────────────────── */

const st = await evJson('JSON.stringify(window.__aipdfDocxSelfTest())');
if (!st || !st.ok) {
  console.log('P2W_FAIL self-test threw: ' + JSON.stringify(st).slice(0, 400));
  child.kill();
  process.exit(1);
}
const PARTS = [
  '[Content_Types].xml', '_rels/.rels', 'word/document.xml',
  'word/_rels/document.xml.rels', 'word/styles.xml', 'word/settings.xml', 'docProps/core.xml',
];
check('docx starts with the ZIP local-header magic', st.magic === true, `bytes=${st.bytes}`);
check('docx carries all seven OOXML parts, [Content_Types].xml first',
  JSON.stringify(st.names) === JSON.stringify(PARTS), st.names.join(' '));
check('heading, bold and italic survive the HTML walk',
  st.hasHeadingStyle && st.hasBold && st.hasItalic);
check('table becomes a real w:tbl with w:tc cells', st.hasTable);
check('each PDF page starts on a new Word page', st.hasPageBreak);
check('list items keep a bullet marker and a hanging tab', st.hasBullet && st.hasTab);
check('ampersands are XML-escaped, not emitted raw', st.escapedAmp);
check('document.xml parses as XML', st.xmlWellFormed);
check('blank page still yields one paragraph', st.blankBlocks >= 1, `blocks=${st.blankBlocks}`);
check('markdown answer is salvaged into headings/lists',
  st.mdHeading && st.mdBlocks >= 3, `blocks=${st.mdBlocks}`);
check('code fences are stripped from the model answer', st.fencedClean);
info('block kinds from the sample page', st.kinds.join(', '));

/* ── 2. The bytes on disk are a readable .docx ───────────────────────────── */

const b64 = await ev(`(async function(){
  const m = await import('/js/pdf2word.js');
  const bytes = m.buildDocxFromPages([
    '<h1>Quarterly Report</h1><p>Revenue rose <strong>12%</strong>.</p><table><tr><th>Region</th><th>Q1</th></tr><tr><td>North</td><td>1200</td></tr></table>',
    '<p>Second page body.</p>',
  ], { title: 'Fixture & Co', creator: 'AiPDF Editor' });
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
})()`);
check('renderer returned the document bytes', typeof b64 === 'string' && b64.length > 1000, `${b64 ? b64.length : 0} b64 chars`);

let entries = null;
try { entries = unzipSync(new Uint8Array(Buffer.from(b64, 'base64'))); } catch (e) { entries = null; }
check('the bytes unzip cleanly (a real container)', !!entries && Object.keys(entries).length === 7,
  entries ? Object.keys(entries).join(' ') : 'unzip failed');

if (entries) {
  const dec = new TextDecoder();
  const doc = dec.decode(entries['word/document.xml'] || new Uint8Array());
  const styles = dec.decode(entries['word/styles.xml'] || new Uint8Array());
  const types = dec.decode(entries['[Content_Types].xml'] || new Uint8Array());
  check('content types declare the WordprocessingML main part',
    types.includes('wordprocessingml.document.main+xml'));
  check('body text is present and correctly escaped', doc.includes('Quarterly Report') && doc.includes('Revenue rose'));
  check('table cells carry both values', doc.includes('>North<') && doc.includes('>1200<'));
  check('header cell is shaded', doc.includes('w:fill="EFEFEF"'));
  check('page two is a separate Word page', doc.includes('Second page body.') && doc.includes('<w:br w:type="page"/>'));
  check('styles.xml defines Heading1..6 and TableGrid',
    styles.includes('w:styleId="Heading1"') && styles.includes('w:styleId="Heading6"') && styles.includes('w:styleId="TableGrid"'));
  check('document declares the A4 section it writes into', doc.includes('w:pgSz w:w="11906"'));
}

/* ── 3. Whole flow with a stubbed model ──────────────────────────────────── */

// Point settings at a provider so aiReady() is true and no setup dialog opens.
await ev(`(function(){
  window.__aipdfSettings.ai = {
    provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    authMode: 'bearer', apiKey: 'sk-test-not-used', temperature: 0.2, customHeaders: [],
  };
  return 'ok';
})()`);

const kicked = await ev(`(function(){
  window.__p2wCalls = [];
  const stub = async (prompt, dataUrl) => {
    window.__p2wCalls.push({ jpeg: dataUrl.slice(0, 22), bytes: dataUrl.length, prompt: prompt.slice(0, 40) });
    return '<h1>Stub heading</h1><p>Stubbed <strong>body</strong> text.</p>';
  };
  window.__p2wResult = null;
  window.__p2wDone = false;
  window.__aipdfConvertToWord({
    busy: () => {},
    vision: stub,
    pages: [0, 1],
    mode: 'standard',
    api: { saveDialog: async () => ${JSON.stringify(OUT)}, writeFile: (p, d) => window.api.writeFile(p, d) },
  }).then((r) => { window.__p2wResult = r; window.__p2wDone = true; })
    .catch((e) => { window.__p2wResult = { ok: false, error: String(e && e.message || e) }; window.__p2wDone = true; });
  return 'started';
})()`);
check('conversion started', kicked === 'started');

for (let i = 0; i < 200; i++) { if (await ev('!!window.__p2wDone')) break; await sleep(300); }
const res = await evJson('JSON.stringify(window.__p2wResult)');
check('conversion finished without throwing', !!res && res.ok === true, JSON.stringify(res).slice(0, 200));

const calls = await evJson('JSON.stringify(window.__p2wCalls)');
check('the model was called once per page, with a real JPEG', Array.isArray(calls) && calls.length === 2
  && calls.every((c) => c.jpeg.startsWith('data:image/jpeg') && c.bytes > 5000),
  Array.isArray(calls) ? calls.map((c) => c.bytes).join(',') + ' chars' : 'no calls');

check('a .docx was written to disk', fs.existsSync(OUT), OUT);
if (fs.existsSync(OUT)) {
  const written = fs.readFileSync(OUT);
  check('the saved file is a ZIP of plausible size', written[0] === 0x50 && written[1] === 0x4b && written.length > 3000,
    `${written.length} bytes`);
  let out = null;
  try { out = unzipSync(new Uint8Array(written)); } catch { out = null; }
  check('the saved file unzips and has document.xml', !!out && !!out['word/document.xml']);
  if (out) {
    const doc = new TextDecoder().decode(out['word/document.xml']);
    check('stubbed page content reached the Word file', doc.includes('Stub heading') && doc.includes('Stubbed'));
    check('two pages → two headings and one page break',
      (doc.match(/Stub heading/g) || []).length === 2 && doc.includes('<w:br w:type="page"/>'));
    check('bold from the stub survived', doc.includes('<w:b/>'));
  }
}

/* ── 3b. Gemini reads a native PDF, not a raster (this is what keeps tables) ─ */
// pdf2word-max sends the raw PDF to Gemini; we must do the same, otherwise the
// model only sees an image of the page and collapses tables into paragraphs.
await ev(`(function(){
  window.__aipdfSettings.ai = {
    provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash', authMode: 'x-goog-api-key', apiKey: 'test-not-used',
    temperature: 0.2, customHeaders: [],
  };
  return 'ok';
})()`);

const gemKicked = await ev(`(function(){
  window.__p2wNative = [];
  const stub = async (prompt, dataUrl) => {
    window.__p2wNative.push(dataUrl.slice(0, 24));
    return '<h1>Gemini heading</h1><p>Native <strong>PDF</strong> text.</p>';
  };
  window.__p2wGemResult = null; window.__p2wGemDone = false;
  window.__aipdfConvertToWord({
    busy: () => {},
    vision: stub,
    pages: [0, 1],
    mode: 'standard',
    api: { saveDialog: async () => ${JSON.stringify(OUT2)}, writeFile: (p, d) => window.api.writeFile(p, d) },
  }).then((r) => { window.__p2wGemResult = r; window.__p2wGemDone = true; })
    .catch((e) => { window.__p2wGemResult = { ok: false, error: String(e && e.message || e) }; window.__p2wGemDone = true; });
  return 'started';
})()`);
check('gemini conversion started', gemKicked === 'started');

for (let i = 0; i < 200; i++) { if (await ev('!!window.__p2wGemDone')) break; await sleep(300); }
const gemRes = await evJson('JSON.stringify(window.__p2wGemResult)');
check('gemini conversion finished', !!gemRes && gemRes.ok === true, JSON.stringify(gemRes).slice(0, 200));
const nativeCalls = await evJson('JSON.stringify(window.__p2wNative)');
check('Gemini receives a native PDF per page (not a JPEG)',
  Array.isArray(nativeCalls) && nativeCalls.length === 2 && nativeCalls.every((c) => c.startsWith('data:application/pdf')),
  Array.isArray(nativeCalls) ? nativeCalls.join(' ') : 'no calls');
check('gemini wrote a .docx', fs.existsSync(OUT2), OUT2);

/* ── 3c. Every page converts, and tables survive across the whole file ────── */
// Same provider-agnostic path: the model (stubbed) returns a table on every
// page; the packer must emit one w:tbl per page plus a page break between them.
await ev(`(function(){
  window.__aipdfSettings.ai = {
    provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini',
    authMode: 'bearer', apiKey: 'sk-test-not-used', temperature: 0.2, customHeaders: [],
  };
  return 'ok';
})()`);

const tblKicked = await ev(`(function(){
  window.__p2wTbl = 0;
  const stub = async () => {
    window.__p2wTbl++;
    return '<h2>Page ' + window.__p2wTbl + '</h2>' +
      '<table><tr><th>Item</th><th>Value</th></tr>' +
      '<tr><td>Alpha</td><td>10</td></tr><tr><td>Beta</td><td>20</td></tr></table>';
  };
  window.__p2wTblResult = null; window.__p2wTblDone = false;
  window.__aipdfConvertToWord({
    busy: () => {},
    vision: stub,
    pages: [0, 1, 2],
    mode: 'standard',
    api: { saveDialog: async () => ${JSON.stringify(OUT3)}, writeFile: (p, d) => window.api.writeFile(p, d) },
  }).then((r) => { window.__p2wTblResult = r; window.__p2wTblDone = true; })
    .catch((e) => { window.__p2wTblResult = { ok: false, error: String(e && e.message || e) }; window.__p2wTblDone = true; });
  return 'started';
})()`);
check('multi-page table conversion started', tblKicked === 'started');

for (let i = 0; i < 200; i++) { if (await ev('!!window.__p2wTblDone')) break; await sleep(300); }
const tblRes = await evJson('JSON.stringify(window.__p2wTblResult)');
check('multi-page table conversion finished', !!tblRes && tblRes.ok === true, JSON.stringify(tblRes).slice(0, 200));
check('the model was called once per requested page', (await ev('window.__p2wTbl')) === 3);
if (fs.existsSync(OUT3)) {
  const out = unzipSync(new Uint8Array(fs.readFileSync(OUT3)));
  const doc = new TextDecoder().decode(out['word/document.xml']);
  const tables = (doc.match(/<w:tbl>/g) || []).length;
  check('all three pages kept their table (whole file, tables retained)',
    tables === 3, `w:tbl count = ${tables}`);
  check('three pages are separated by two page breaks',
    (doc.match(/<w:br w:type="page"\/>/g) || []).length === 2);
  check('table cell values reached the Word file', doc.includes('>Alpha<') && doc.includes('>Beta<'));
}

/* ── 3d. Blocked endpoint (Cloudflare HTML) → diagnosis, not a junk doc ──── */

const helpers = await evJson(`(async function(){
  const m = await import('/js/ai.js');
  return JSON.stringify({
    htmlDoc: m.looksLikeHtml('<!DOCTYPE html><html class="no-js ie6 oldie"><head><title>Attention Required! | Cloudflare</title></head></html>'),
    htmlJson: m.looksLikeHtml('{"candidates":[]}'),
    desc: m.describeHttpFailure(403, '<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head></html>', 'https://aistudio.google.com/models/gemini-2.5-flash:generateContent'),
    webBase: m.geminiBase({ baseUrl: 'https://aistudio.google.com/' }),
    okBase: m.geminiBase({ baseUrl: 'https://generativelanguage.googleapis.com' }),
  });
})()`);
check('HTML bodies are detected as non-JSON', !!helpers && helpers.htmlDoc === true && helpers.htmlJson === false);
check('a pasted Gemini web URL is redirected to the API root',
  !!helpers && helpers.webBase === 'https://generativelanguage.googleapis.com/v1beta', helpers && helpers.webBase);
check('the bare API host gains its /v1beta segment',
  !!helpers && helpers.okBase === 'https://generativelanguage.googleapis.com/v1beta', helpers && helpers.okBase);
check('the diagnosis names the host and is tag-free',
  !!helpers && typeof helpers.desc === 'string' && helpers.desc.includes('aistudio.google.com')
  && !/[<>]/.test(helpers.desc) && helpers.desc.includes('generativelanguage'),
  helpers && helpers.desc ? helpers.desc.slice(0, 90) : 'none');

// A raw HTML error (as the old code surfaced it) must not become the document.
const rawRes = await evJson(`(async function(){
  const stub = async () => { throw new Error('<!DOCTYPE html><html class="no-js ie6 oldie" lang="en-US"><body>blocked</body></html>'); };
  return JSON.stringify(await window.__aipdfConvertToWord({
    busy: () => {}, vision: stub, pages: [0, 1], mode: 'standard',
    api: { saveDialog: async () => ${JSON.stringify(path.join(UD, 'out-html.docx'))}, writeFile: (p, d) => window.api.writeFile(p, d) },
  }));
})()`);
check('raw HTML from a failed page does not leak into the result',
  !!rawRes && rawRes.ok === false && typeof rawRes.error === 'string' && !/[<>]/.test(rawRes.error),
  rawRes && rawRes.error ? rawRes.error.slice(0, 100) : 'none');
check('no junk .docx is written when every page fails', !fs.existsSync(path.join(UD, 'out-html.docx')));

// A diagnosis-style error is fatal: abort after the first page, don't hammer.
const fatal = await evJson(`(async function(){
  window.__fatalCalls = 0;
  const stub = async () => {
    window.__fatalCalls++;
    throw new Error('The AI endpoint (aistudio.google.com) returned an HTML page instead of JSON (HTTP 403). For Google Gemini use Base URL https://generativelanguage.googleapis.com/v1beta.');
  };
  const r = await window.__aipdfConvertToWord({
    busy: () => {}, vision: stub, pages: [0, 1, 2], mode: 'standard',
    api: { saveDialog: async () => ${JSON.stringify(path.join(UD, 'out-fatal.docx'))}, writeFile: (p, d) => window.api.writeFile(p, d) },
  });
  return JSON.stringify({ r, calls: window.__fatalCalls });
})()`);
check('a blocked endpoint aborts after the first page (reason: endpoint)',
  !!fatal && fatal.r && fatal.r.ok === false && fatal.r.reason === 'endpoint' && fatal.calls === 1,
  fatal ? `reason=${fatal.r && fatal.r.reason} calls=${fatal.calls}` : 'none');

/* ── 3e. Progress overlay is visible during the run and clears afterwards ── */
const prog = await evJson(`(async function(){
  let release, resume;
  const seen = new Promise((r) => { release = r; });
  const hold = new Promise((r) => { resume = r; });
  // Hold the model call open until the test has inspected the overlay, so the
  // conversion cannot finish (and clear it) before we look.
  const stub = async () => { release(); await hold; return '<p>progress page</p>'; };
  const p = window.__aipdfConvertToWord({
    busy: () => {}, vision: stub, pages: [0], mode: 'standard',
    api: { saveDialog: async () => ${JSON.stringify(path.join(UD, 'out-prog.docx'))}, writeFile: (p, d) => window.api.writeFile(p, d) },
  });
  await seen;
  const during = !!document.querySelector('.p2w-overlay');
  const label = (document.querySelector('.p2w-label') || {}).textContent || '';
  resume();
  const r = await p;
  const after = !!document.querySelector('.p2w-overlay');
  return JSON.stringify({ during, after, label, ok: !!(r && r.ok) });
})()`);
check('progress overlay is shown while converting',
  !!prog && prog.during === true, prog ? `during=${prog.during}` : 'none');
check('progress overlay names the page being read',
  !!prog && /page/i.test(prog.label), prog ? prog.label : 'none');
check('progress overlay is removed after the run',
  !!prog && prog.after === false && prog.ok === true, JSON.stringify(prog).slice(0, 160));

/* ── 4. The gate: no provider configured → setup dialog, not a crash ─────── */

const gate = await evJson(`(async function(){
  window.__aipdfSettings.ai = { provider: 'openai', baseUrl: '', model: '', apiKey: '', authMode: 'bearer' };
  const p = window.__aipdfConvertToWord({ busy: () => {}, vision: async () => '<p>x</p>', pages: [0] });
  // The setup dialog is modal; close it so the promise settles.
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const btn = document.querySelector('.modal-head button, .modal button[aria-label="Close"]');
    if (btn) { btn.click(); break; }
  }
  const r = await p;
  return JSON.stringify({ opened: true, reason: r && r.reason });
})()`);
check('without a provider it asks for one instead of converting',
  !!gate && gate.reason === 'no-ai', JSON.stringify(gate));

/* ── Result ─────────────────────────────────────────────────────────────── */

if (errs.length) info('renderer errors seen', errs.slice(0, 4).join(' | '));
try { child.kill(); } catch { /* gone */ }
clearTimeout(bail);
console.log(problems ? `\nP2W_FAIL ${problems} problem(s)` : '\nP2W_PASS pdf2word: writer, container, flow and gate all green');
process.exit(problems ? 1 : 0);
