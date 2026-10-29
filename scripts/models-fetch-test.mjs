#!/usr/bin/env node
/**
 * Model-list fetching — proves the app pulls the *complete* catalogue, not the
 * first page. A local mock provider serves two pages (Gemini nextPageToken and
 * OpenAI has_more/last_id) and the real `ai:models` IPC handler is driven from
 * the renderer, so the pagination code in src/main/main.js is what runs.
 *
 *   node scripts/models-fetch-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(ELECTRON)) { console.log('MF_FAIL missing electron'); process.exit(1); }

let geminiRequests = 0;
let openaiRequests = 0;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (body) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body));
  };
  if (u.pathname === '/v1beta/models') {
    geminiRequests++;
    const token = u.searchParams.get('pageToken');
    if (!token) {
      send({
        models: [
          { name: 'models/gemini-alpha', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/text-embedding-x', supportedGenerationMethods: ['embedContent'] },
        ],
        nextPageToken: 'page2',
      });
    } else {
      send({
        models: [
          { name: 'models/gemini-beta', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-alpha', supportedGenerationMethods: ['generateContent'] }, // duplicate
        ],
      });
    }
    return;
  }
  if (u.pathname === '/openai/v1/models') {
    openaiRequests++;
    const after = u.searchParams.get('after');
    if (!after) send({ data: [{ id: 'm-one' }], has_more: true, last_id: 'm-one' });
    else send({ data: [{ id: 'm-two' }] });
    return;
  }
  res.writeHead(404); res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${server.address().port}`;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}
const PORT = await freePort();
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-mf-ud-'));
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bail = setTimeout(() => { console.log('TIMEOUT'); try { child.kill(); } catch {} process.exit(2); }, 180000);
bail.unref?.();

let target = null;
for (let i = 0; i < 120 && !target; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    target = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!target) await sleep(400);
}
if (!target) { console.log('MF_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
let mid = 0; const pending = new Map();
const send = (m, p) => new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p })); });
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
await new Promise((r) => ws.addEventListener('open', r));
await send('Runtime.enable');
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (!r || r.exceptionDetails) return undefined; return r.result ? r.result.value : undefined; };
const evJson = async (expr) => { const s = await ev(expr); try { return JSON.parse(s); } catch { return null; } };

for (let i = 0; i < 120; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
await sleep(600);

let problems = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); if (!ok) problems++; };

// Gemini-style: nextPageToken, pageSize honoured, embedding filtered, deduped.
const gem = await evJson(`(async function(){
  const r = await window.api.aiModels({ url: ${JSON.stringify(MOCK + '/v1beta/models')}, headers: {} });
  return JSON.stringify(r);
})()`);
check('gemini models request succeeds', !!gem && gem.ok === true, JSON.stringify(gem).slice(0, 160));
check('gemini catalogue is complete across pages',
  !!gem && JSON.stringify(gem.models) === JSON.stringify(['gemini-alpha', 'gemini-beta']),
  gem ? gem.models.join(',') : 'none');
check('gemini pagination made two requests', geminiRequests === 2, `requests=${geminiRequests}`);
check('embedding-only model is filtered out', !!gem && !gem.models.includes('text-embedding-x'));

// OpenAI-style: has_more + last_id → after.
const oa = await evJson(`(async function(){
  const r = await window.api.aiModels({ url: ${JSON.stringify(MOCK + '/openai/v1/models')}, headers: {} });
  return JSON.stringify(r);
})()`);
check('openai models request succeeds', !!oa && oa.ok === true, JSON.stringify(oa).slice(0, 160));
check('openai catalogue is complete across pages',
  !!oa && JSON.stringify(oa.models) === JSON.stringify(['m-one', 'm-two']),
  oa ? oa.models.join(',') : 'none');
check('openai pagination made two requests', openaiRequests === 2, `requests=${openaiRequests}`);

try { child.kill(); } catch { /* gone */ }
server.close();
clearTimeout(bail);
console.log(problems ? `\nMF_FAIL ${problems} problem(s)` : '\nMF_PASS model fetching: complete catalogue across pages');
process.exit(problems ? 1 : 0);
