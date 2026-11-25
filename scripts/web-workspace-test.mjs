#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_ROOT = path.join(ROOT, 'web-dist');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-web-workspace-'));
const profile = path.join(temp, 'profile');

const build = spawnSync(process.execPath, ['scripts/build-web.mjs'], { cwd: ROOT, encoding: 'utf8' });
if (build.status !== 0) {
  console.error(build.stderr || build.stdout);
  fs.rmSync(temp, { recursive: true, force: true });
  process.exit(1);
}

const mime = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream',
};
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(WEB_ROOT, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(WEB_ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const webPort = server.address().port;

function discoverChrome() {
  const explicit = process.env.AIPDF_CHROME || process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function freePort() {
  const sock = net.createServer();
  await new Promise((resolve, reject) => sock.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = sock.address().port;
  await new Promise((resolve) => sock.close(resolve));
  return port;
}

const chromePath = discoverChrome();
if (!chromePath) {
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
  console.error('WEB_WORKSPACE_FAIL Chrome not found');
  process.exit(1);
}
const debugPort = await freePort();
const chrome = spawn(chromePath, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-pings',
  `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=*',
  `--user-data-dir=${profile}`, '--window-size=1440,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
chrome.stdout.on('data', () => {});
chrome.stderr.on('data', () => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let target = null;
const deadline = Date.now() + 30000;
while (!target && Date.now() < deadline) {
  try {
    const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
    target = (await response.json()).find((item) => item.type === 'page') || null;
  } catch { /* not ready */ }
  if (!target) await delay(100);
}
if (!target) {
  chrome.kill(); server.close(); fs.rmSync(temp, { recursive: true, force: true });
  console.error('WEB_WORKSPACE_FAIL no renderer target');
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  pending.set(requestId, { resolve, reject });
  ws.send(JSON.stringify({ id: requestId, method, params }));
});
ws.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.id != null && pending.has(message.id)) {
    const record = pending.get(message.id);
    pending.delete(message.id);
    message.error ? record.reject(new Error(message.error.message)) : record.resolve(message.result || {});
  }
});
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label) => {
  for (let i = 0; i < 200; i++) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fixtureBase64 = fs.readFileSync(FIXTURE).toString('base64');

try {
  await send('Page.navigate', { url: `http://127.0.0.1:${webPort}/` });
  await waitFor('!!window.__aipdfBooted', 'web app boot');
  const stored = await evaluate(`(async () => {
    await window.api.storeSet('settings', { webWorkspace: true });
    const bytes = Uint8Array.from(atob(${JSON.stringify(fixtureBase64)}), function (c) { return c.charCodeAt(0); });
    const file = new File([bytes], 'fixture.pdf', { type: 'application/pdf' });
    const path = window.api.pathForFile(file);
    await window.api.grantDroppedFile(path);
    const list = await window.api.workspaceList();
    const usage = await window.api.workspaceUsage();
    return JSON.stringify({ path: path, list: list, usage: usage });
  })()`);
  const first = JSON.parse(stored);
  check('web workspace persists an opened PDF with metadata', first.list.length === 1
    && first.list[0].name === 'fixture.pdf' && first.list[0].path === first.path, JSON.stringify(first.list));
  check('web workspace reports browser storage usage and quota', first.usage
    && Number.isFinite(first.usage.usage) && Number.isFinite(first.usage.quota), JSON.stringify(first.usage));

  await send('Page.reload', { ignoreCache: true });
  await waitFor('!!window.__aipdfBooted', 'web app reload');
  const restored = await evaluate(`(async () => {
    const list = await window.api.workspaceList();
    const entry = list[0];
    if (!entry) return JSON.stringify({ list: list });
    const file = await window.api.readFile(entry.path);
    await window.__aipdfOpenPath(entry.path);
    const state = window.__aipdfState;
    const doc = state.docs.find(function (item) { return item.id === state.activeId; });
    return JSON.stringify({ list: list, readOk: !!file.ok, bytes: file.data?.length || 0,
      name: doc?.name, pages: doc?.numPages });
  })()`);
  const reopened = JSON.parse(restored);
  check('stored PDF survives reload and reopens with its bytes and pages', reopened.readOk
    && reopened.bytes > 0 && reopened.name === 'fixture.pdf' && reopened.pages === 3, JSON.stringify(reopened));

  const removed = await evaluate(`(async () => {
    const before = await window.api.workspaceList();
    const result = await window.api.workspaceDelete(before[0].path);
    const after = await window.api.workspaceList();
    const read = await window.api.readFile(before[0].path);
    const raw = await new Promise(function (resolve, reject) {
      const request = indexedDB.open('aipdf-user-files', 1);
      request.onsuccess = function () {
        const db = request.result;
        const get = db.transaction('files', 'readonly').objectStore('files').get(before[0].path);
        get.onsuccess = function () { resolve(get.result == null ? null : get.result.length); };
        get.onerror = function () { reject(get.error); };
      };
      request.onerror = function () { reject(request.error); };
    });
    return JSON.stringify({ result: result, after: after.length, readOk: read.ok, raw: raw });
  })()`);
  const deletion = JSON.parse(removed);
  check('workspace deletion removes metadata and stored bytes', deletion.result === true
    && deletion.after === 0 && deletion.readOk === false, JSON.stringify(deletion));
} finally {
  send('Browser.close').catch(() => {});
  try { ws.close(); } catch { /* already closed */ }
  chrome.kill();
  server.close();
  await delay(300);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
