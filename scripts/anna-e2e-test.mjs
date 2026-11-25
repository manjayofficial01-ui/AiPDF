#!/usr/bin/env node
/**
 * Anna fresh-install end-to-end gate.
 *
 * Drives the real Anna dev dispatcher and its production SDK iframe in a fresh
 * Chromium profile. Only the host LLM is mocked, through the official CLI's
 * JSONL fixture mechanism. No Playwright/Puppeteer dependency is used.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { chromePath as discoverChromePath, launchChromium } from './lib/electron-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'anna-app', 'aipdf-editor');
const MANIFEST = path.join(APP_DIR, 'manifest.json');
const BUNDLE = path.join(APP_DIR, 'bundle');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const REPLIES = path.join(APP_DIR, 'fixtures', 'replies.jsonl');
const TITLE = 'AiPDF Editor functional test fixture.';
const COLOR_HEX = '#1d4ed8';
const COLOR_RGB = [29 / 255, 78 / 255, 216 / 255];
const SUMMARY = 'This synthetic three-page fixture verifies AiPDF Editor: page 1 has the native title and extractable sentence, page 2 has second-page content, and page 3 has multi-page conversion content. [p.1] [p.2] [p.3]';
const NUMBER_TEXTS = ['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3'];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let passed = 0;
let tempRoot = null;
let anna = null;
let proxyServer = null;
let chrome = null;
let cdp = null;
let annaPort = null;
let appSessionId = null;
let appContextId = null;
const violations = [];
const harnessErrors = [];
const aiCallTrace = [];
let mockReplies = [];
const frameContexts = new Map();
const childOutput = { anna: '', chrome: '' };

class TestFailure extends Error {}
function check(name, ok, detail = '') {
  if (!ok) throw new TestFailure(`${name}${detail ? ` — ${detail}` : ''}`);
  passed++;
  console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
}
function safeText(value) {
  return String(value ?? '')
    .replace(/([?&](?:t|token|access_token|session_id)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(authorization|cookie|set-cookie|bearer|pat)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/AiPDF Editor (?:functional|verified) test fixture\./g, '[synthetic fixture title]')
    .replace(/This sentence on page one must be extractable by pdf\.js\./g, '[synthetic fixture sentence]')
    .replace(/Second page content for extraction\./g, '[synthetic page-two text]')
    .replace(/Third page content for multi-page conversion\./g, '[synthetic page-three text]')
    .slice(0, 1000);
}
function appendLimited(target, chunk) {
  target += String(chunk);
  return target.slice(-65536);
}
function runNode(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new TestFailure(`${path.basename(script)} failed (exit ${result.status ?? 'signal'}) — ${safeText(result.stderr || result.stdout)}`);
  }
}
function exists(file) { return !!file && fs.existsSync(file); }
function firstExisting(files) { return files.find((file) => exists(file)); }
function onPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}
function discoverChrome() {
  const explicit = process.env.AIPDF_CHROME || process.env.CHROME_PATH || process.env.CHROMIUM_PATH
    || process.env.GOOGLE_CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && exists(explicit)) return explicit;
  if (explicit) throw new TestFailure(`Chrome path from environment does not exist: ${explicit}`);
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Chromium', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Chromium', 'Application', 'chrome.exe'),
    ]
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return firstExisting(candidates) || onPath(process.platform === 'win32' ? ['chrome.exe', 'chromium.exe'] : ['google-chrome', 'chromium', 'chromium-browser']);
}
function discoverAnnaCli() {
  const explicit = process.env.ANNA_APP_CLI;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'anna-app.cmd'));
    candidates.push(path.join(process.env.APPDATA, 'npm', 'anna-app'));
  }
  const found = firstExisting(candidates) || onPath(process.platform === 'win32'
    ? ['anna-app.cmd', 'anna-app.exe', 'anna-app']
    : ['anna-app']);
  if (!found) throw new TestFailure('anna-app CLI not found. Install @anna-ai/cli globally or set ANNA_APP_CLI.');
  const real = fs.realpathSync(found);
  const siblingJs = path.join(path.dirname(real), 'node_modules', '@anna-ai', 'cli', 'dist', 'cli.js');
  if (exists(siblingJs)) return { command: process.execPath, prefix: [siblingJs] };
  if (real.endsWith('.js')) return { command: process.execPath, prefix: [real] };
  return { command: real, prefix: [] };
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitForHttp(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (anna?.exitCode != null) throw new TestFailure(`anna-app dev exited early (${anna.exitCode}) — ${safeText(childOutput.anna)}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* not listening yet */ }
    await delay(150);
  }
  throw new TestFailure(`anna-app dev did not become ready — ${safeText(childOutput.anna)}`);
}
async function startAnnaProxy(backendPort, publicPort) {
  proxyServer = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      if (req.method === 'POST' && req.url === '/api/session/call') {
        try {
          const parsed = JSON.parse(body.toString('utf8'));
          if (parsed.ns === 'llm' && parsed.method === 'complete' && Array.isArray(parsed.args?.messages) && parsed.args.content == null) {
            parsed.args.content = parsed.args.messages.map(messageContent).join('\n');
            const matched = mockReplies.findIndex((entry) => entry.ns === 'llm' && entry.method === 'complete'
              && (!entry.match?.contentIncludes || parsed.args.content.includes(entry.match.contentIncludes)));
            aiCallTrace.push({ fixture: matched + 1, content: safeText(parsed.args.content).slice(0, 240) });
            body = Buffer.from(JSON.stringify(parsed));
          }
        } catch { /* forward malformed or unrelated requests unchanged */ }
      }
      const headers = { ...req.headers, host: `127.0.0.1:${backendPort}` };
      delete headers['content-length'];
      if (body.length) headers['content-length'] = String(body.length);
      const upstream = http.request({
        hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers,
      }, (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('Anna dev proxy upstream failed');
      });
      upstream.end(body);
    });
  });
  await new Promise((resolve, reject) => proxyServer.once('error', reject).listen(publicPort, '127.0.0.1', resolve));
}

async function waitForDevTools(profile, timeoutMs = 30000) {
  const file = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (chrome?.exitCode != null) throw new TestFailure(`Chrome exited early (${chrome.exitCode}) — ${safeText(childOutput.chrome)}`);
    if (exists(file)) {
      try {
        const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
        if (lines[0] && lines[1]) return { port: Number(lines[0]), wsPath: lines[1] };
      } catch (error) {
        if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
      }
    }
    await delay(100);
  }
  throw new TestFailure(`Chrome DevTools endpoint did not appear — ${safeText(childOutput.chrome)}`);
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id != null && this.pending.has(message.id)) {
        const record = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(record.timer);
        if (message.error) record.reject(new TestFailure(`CDP ${message.error.message || 'error'}`));
        else record.resolve(message.result || {});
        return;
      }
      for (const entry of this.handlers.get(message.method) || []) {
        try {
          const result = entry.handler(message.params || {}, message.sessionId);
          if (result && typeof result.catch === 'function') result.catch((error) => harnessErrors.push(error));
        } catch (error) { harnessErrors.push(error); }
      }
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new TestFailure('CDP WebSocket connection timed out')), 15000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new TestFailure('CDP WebSocket connection failed')); }, { once: true });
    });
    return new CdpConnection(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TestFailure(`CDP ${method} timed out`));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(method, handler, sessionId) {
    const list = this.handlers.get(method) || [];
    list.push({ handler, sessionId });
    this.handlers.set(method, list);
  }
  waitForEvent(method, predicate = () => true, timeoutMs = 15000, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.handlers.set(method, (this.handlers.get(method) || []).filter((entry) => entry.handler !== handler));
        reject(new TestFailure(`Timed out waiting for CDP ${method}`));
      }, timeoutMs);
      const handler = (params, incomingSession) => {
        if ((sessionId && incomingSession !== sessionId) || !predicate(params)) return;
        clearTimeout(timer);
        this.handlers.set(method, (this.handlers.get(method) || []).filter((entry) => entry.handler !== handler));
        resolve(params);
      };
      this.handlers.set(method, (this.handlers.get(method) || []).concat([{ handler, sessionId }]));
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

function isAllowedUrl(raw) {
  if (/^(?:data|blob|about):/i.test(raw)) return true;
  try {
    const url = new URL(raw);
    return ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && Number(url.port) === annaPort;
  } catch { return false; }
}
function safeUrl(raw) {
  try { const url = new URL(raw); return `${url.origin}${url.pathname}`; }
  catch { return '[invalid URL]'; }
}
function recordViolation(type, detail) {
  violations.push({ type, detail: safeText(detail) });
}
function messageContent(message) {
  if (typeof message?.content === 'string') return message.content;
  if (typeof message?.content?.text === 'string') return message.content.text;
  if (Array.isArray(message?.content)) {
    return message.content.map((part) => typeof part === 'string' ? part : part?.text || '').join('\n');
  }
  return '';
}

async function evaluate(sessionId, expression, useAppContext = true) {
  const reply = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true, userGesture: true,
    ...(useAppContext && appContextId ? { contextId: appContextId } : {}),
  }, sessionId || appSessionId);
  if (reply.exceptionDetails) {
    const description = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'evaluation failed';
    throw new TestFailure(`Renderer evaluation failed — ${safeText(description)}`);
  }
  return reply.result?.value;
}
async function waitFor(sessionId, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(sessionId, expression)) return;
    await delay(100);
  }
  const diagnostic = await evaluate(sessionId, `(() => {
    const state = window.__aipdfState;
    const last = Array.from(document.querySelectorAll('.msg.ai')).at(-1);
    const frame = document.getElementById('app')?.getBoundingClientRect();
    return JSON.stringify({ busy: state?.ai?.busy, provider: window.__aipdfSettings?.ai?.provider,
      baseUrl: window.__aipdfSettings?.ai?.baseUrl, lastMessage: last?.innerText || '',
      viewport: [innerWidth, innerHeight], frame: frame ? [frame.width, frame.height] : null });
  })()`).catch(() => null);
  const trace = aiCallTrace.length ? `; aiCalls=${safeText(JSON.stringify(aiCallTrace))}` : '';
  throw new TestFailure(`Timed out waiting for ${label}${diagnostic ? ` — ${safeText(diagnostic)}` : ''}${trace}`);
}
async function locate(sessionId, selector, text = null, last = false) {
  return evaluate(sessionId, `(() => {
    const root = ${last ? `Array.from(document.querySelectorAll('.msg.ai')).at(-1)` : 'document'};
    if (!root) return null;
    const nodes = Array.from(root.querySelectorAll(${JSON.stringify(selector)}));
    const el = ${text == null ? (last ? 'nodes.at(-1)' : 'nodes[0]') : `nodes.filter((node) => node.textContent.trim() === ${JSON.stringify(text)})${last ? '.at(-1)' : '[0]'}`};
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
      disabled: !!el.disabled, right: rect.right, bottom: rect.bottom };
  })()`);
}
async function click(sessionId, selector, text = null, last = false) {
  const point = await locate(sessionId, selector, text, last);
  if (!point || !point.visible || point.disabled) throw new TestFailure(`Control is unavailable: ${selector}${text ? ` (${text})` : ''}`);
  if (appContextId) {
    const frame = await evaluate(sessionId, `(() => {
      const rect = document.getElementById('app').getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    })()`, false);
    point.x += frame.left;
    point.y += frame.top;
  }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1,
    }, sessionId);
  }
}
async function fill(sessionId, selector, text) {
  await evaluate(sessionId, `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.focus(); el.select(); return true; })()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, sessionId);
  await cdp.send('Input.insertText', { text }, sessionId);
}
async function upload(sessionId, file, openSelector) {
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
  const chooser = cdp.waitForEvent('Page.fileChooserOpened', () => true, 10000, sessionId);
  await click(sessionId, openSelector);
  const opened = await chooser;
  if (Number.isInteger(opened.backendNodeId)) {
    await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: opened.backendNodeId }, sessionId);
    return;
  }
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 }, sessionId);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type="file"]' }, sessionId);
  if (!nodeId) throw new TestFailure('Upload file input was not created');
  await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId }, sessionId);
}

async function fixtureEvidence() {
  const bytes = fs.readFileSync(FIXTURE);
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  try {
    const page = await pdf.getPage(1);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
    return { pages: pdf.numPages, hasTitle: text.includes(TITLE) };
  } finally { await pdf.destroy(); }
}
function readReplies() {
  if (!exists(REPLIES)) throw new TestFailure(`Missing deterministic Anna mock fixture: ${REPLIES}`);
  return fs.readFileSync(REPLIES, 'utf8').split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).map((line) => JSON.parse(line));
}
function validateReplies(replies) {
  const plans = replies.filter((entry) => entry.ns === 'llm' && entry.method === 'complete'
    && typeof entry.result?.content?.text === 'string' && entry.result.content.text.trim().startsWith('{'))
    .map((entry) => JSON.parse(entry.result.content.text));
  const numbers = plans.find((plan) => plan.operations?.some((op) => op.op === 'add_page_numbers'));
  const color = plans.find((plan) => plan.operations?.some((op) => op.op === 'format_text_color'));
  check('mock page-number plan targets all three 1-based pages', numbers?.operations?.[0]?.from === 1
    && numbers.operations[0].to === 3 && numbers.operations[0].start === 1);
  check('mock title-color plan uses the exact canonical fixture title', color?.operations?.[0]?.page === 1
    && color.operations[0].find === TITLE && color.operations[0].color === COLOR_HEX);
}

async function modelSummary(sessionId) {
  return evaluate(sessionId, `(() => {
    const state = window.__aipdfState;
    const doc = state.docs.find((entry) => entry.id === state.activeId);
    if (!doc) return null;
    return { pages: doc.numPages, name: doc.name, dirty: !!doc.dirty, revision: doc.revision,
      historyLength: doc.history.length, hIndex: doc.hIndex, docCount: state.docs.length,
      numbers: doc.stamps.filter((stamp) => String(stamp.id || '').startsWith('ai-page-numbers-'))
        .map((stamp) => ({ id: stamp.id, page: stamp.from - 1, text: stamp.text })),
      titleEdits: doc.textEdits.filter((edit) => edit.text === ${JSON.stringify(TITLE)})
        .map((edit) => ({ page: edit.page, color: edit.color })) };
  })()`);
}
function fingerprint(summary) {
  return JSON.stringify({ pages: summary.pages, dirty: summary.dirty, revision: summary.revision,
    historyLength: summary.historyLength, hIndex: summary.hIndex, numbers: summary.numbers, titleEdits: summary.titleEdits });
}
function numbersMatch(summary) {
  return summary.numbers.length === 3 && summary.numbers.every((entry, index) =>
    entry.id === `ai-page-numbers-${index + 1}` && entry.page === index && entry.text === NUMBER_TEXTS[index]);
}
function titleColorMatches(summary) {
  return summary.titleEdits.length === 1 && summary.titleEdits[0].page === 0
    && summary.titleEdits[0].color.every((value, index) => Math.abs(value - COLOR_RGB[index]) < 1e-9);
}
async function reopenedTextEvidence(sessionId) {
  return evaluate(sessionId, `(async () => {
    const state = window.__aipdfState;
    const doc = state.docs.find((entry) => entry.id === state.activeId);
    if (!doc?.pdf) return null;
    const texts = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const content = await (await doc.pdf.getPage(pageNumber)).getTextContent();
      texts.push(content.items.map((item) => item.str || '').join(' ').replace(/\\s+/g, ' ').trim());
    }
    const count = (text, needle) => text.split(needle).length - 1;
    return { pages: doc.numPages, titlePages: texts.map((text) => count(text, ${JSON.stringify(TITLE)})),
      numbers: texts.map((text, index) => count(text, ${JSON.stringify(NUMBER_TEXTS)}[index])),
      wrongNumbers: texts.map((text, index) => ${JSON.stringify(NUMBER_TEXTS)}.filter((_, other) => other !== index)
        .reduce((total, needle) => total + count(text, needle), 0)) };
  })()`);
}

function colorBeforeText(list) {
  const stack = [];
  let fill = [0, 0, 0];
  let fillSerial = 0;
  let renderMode = 0;
  let formDepth = 0;
  let annotationDepth = 0;
  let segment = '';
  let fillAt = -1;
  const capture = () => ({ fill: fill?.slice() || null, fillSerial, renderMode, formDepth, annotationDepth });
  const restore = (saved) => {
    if (!saved) return false;
    ({ fill, fillSerial, renderMode, formDepth, annotationDepth } = saved);
    return true;
  };
  const rgb = (args) => Array.from(args || []).slice(0, 3).map((value) => Number(value) / 255);
  const wanted = TITLE.replace(/\s+/g, '');
  for (let index = 0; index < (list?.fnArray?.length || 0); index++) {
    const fn = list.fnArray[index];
    const args = list.argsArray[index];
    if (fn === OPS.save) stack.push(capture());
    else if (fn === OPS.restore) restore(stack.pop());
    else if (fn === OPS.setFillRGBColor) { fill = rgb(args); fillSerial++; }
    else if (fn === OPS.setFillGrayColor) {
      const gray = Number(args?.[0]) / 255;
      fill = Number.isFinite(gray) ? [gray, gray, gray] : null;
      fillSerial++;
    } else if (fn === OPS.setFillCMYKColor) {
      const c = Number(args?.[0]) / 255, m = Number(args?.[1]) / 255;
      const y = Number(args?.[2]) / 255, k = Number(args?.[3]) / 255;
      fill = [c, m, y, k].every(Number.isFinite) ? [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)] : null;
      fillSerial++;
    } else if (fn === OPS.setGState) { fill = null; fillSerial++; }
    else if (fn === OPS.setTextRenderMode) renderMode = Number(args?.[0]);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(capture()); formDepth++; }
    else if (fn === OPS.paintFormXObjectEnd) { if (!restore(stack.pop())) formDepth = Math.max(0, formDepth - 1); }
    else if (fn === OPS.beginAnnotation) { stack.push(capture()); annotationDepth++; }
    else if (fn === OPS.endAnnotation) { if (!restore(stack.pop())) annotationDepth = Math.max(0, annotationDepth - 1); }
    else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const text = (Array.isArray(args?.[0]) ? args[0] : []).map((glyph) => String(glyph?.unicode || '')).join('');
      const matching = fill && fillSerial > 0 && renderMode === 0 && !formDepth && !annotationDepth
        && fill.every((value, channel) => Math.abs(value - COLOR_RGB[channel]) <= 1 / 510);
      if (!matching) { segment = ''; fillAt = -1; continue; }
      if (!segment) fillAt = index;
      segment += text;
      if (segment.replace(/\s+/g, '').includes(wanted)) return { ok: true, fillAt, textAt: index };
    }
  }
  return { ok: false, fillAt: -1, textAt: -1 };
}
async function inspectSavedPdf(file) {
  const bytes = fs.readFileSync(file);
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  try {
    const texts = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      texts.push(content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim());
    }
    const list = await (await pdf.getPage(1)).getOperatorList();
    const paint = colorBeforeText(list);
    return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      header: bytes.subarray(0, 5).toString('ascii'), trailer: bytes.subarray(-6).toString('ascii'),
      pages: pdf.numPages, texts, paint };
  } finally { await pdf.destroy(); }
}

async function responsiveEvidence(sessionId, width, height) {
  return evaluate(sessionId, `(() => {
    const selectors = ['[data-act="file:open"]', '[data-act="file:save"]', '[data-act="edit:undo"]',
      '[data-act="edit:redo"]', '[data-act="view:ai"]', '.ai-mode-btn.agent',
      '.ai-input .mini-btn.primary', '#zpOut', '#zpIn'];
    const controls = selectors.map((selector) => {
      const el = document.querySelector(selector);
      if (!el) return { selector, present: false, visible: false, inside: false };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      return { selector, present: true, visible,
        inside: rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1 };
    });
    const input = document.querySelector('.ai-input');
    return { width: innerWidth, height: innerHeight, controls,
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1 && document.body.scrollWidth <= innerWidth + 1,
      inputFits: !!input && input.scrollWidth <= input.clientWidth + 1 };
  })()`);
}

async function stopProcess(child, label) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  child.kill('SIGTERM');
  const deadline = Date.now() + 3000;
  while (child.exitCode == null && child.signalCode == null && Date.now() < deadline) await delay(100);
  if (child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
async function cleanup() {
  if (cdp) {
    try { await cdp.send('Browser.close').catch(() => {}); } catch { /* browser already gone */ }
    cdp.close();
  }
  await stopProcess(chrome, 'Chrome');
  if (proxyServer) {
    proxyServer.closeAllConnections?.();
    await new Promise((resolve) => proxyServer.close(resolve));
    proxyServer = null;
  }
  await stopProcess(anna, 'anna-app dev');
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    check('cleanup removes only the temporary profile and download directory', !exists(tempRoot));
  }
}

async function main() {
  if (typeof WebSocket !== 'function') throw new TestFailure('Node global WebSocket is unavailable; use Node 22 or newer.');
  const fixture = await fixtureEvidence();
  check('canonical synthetic fixture has three pages and its native title', fixture.pages === 3 && fixture.hasTitle,
    `pages=${fixture.pages}, title=${fixture.hasTitle}`);
  const replies = readReplies();
  mockReplies = replies;
  validateReplies(replies);
  const chromePath = discoverChromePath();
  const annaCli = discoverAnnaCli();
  runNode(path.join(ROOT, 'scripts', 'build-web.mjs'));
  runNode(path.join(ROOT, 'scripts', 'build-anna.mjs'));
  check('Anna bundle built from the current renderer', exists(path.join(BUNDLE, 'index.html')));

  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-anna-e2e-'));
  const profile = path.join(tempRoot, 'chromium-profile');
  const downloads = path.join(tempRoot, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  check('fresh temporary Chromium profile path does not pre-exist', !exists(profile));

  const backendPort = await freePort();
  annaPort = await freePort();
  anna = spawn(annaCli.command, annaCli.prefix.concat([
    'dev', '--manifest', MANIFEST, '--bundle', BUNDLE, '--slug', 'aipdf-editor',
    '--port', String(backendPort), '--mock-llm', REPLIES, '--no-watch', '--storage', 'legacy', '--web', 'local',
  ]), { cwd: ROOT, env: { ...process.env, UV_SYSTEM_CERTS: 'true' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  anna.stdout.on('data', (chunk) => { childOutput.anna = appendLimited(childOutput.anna, chunk); });
  anna.stderr.on('data', (chunk) => { childOutput.anna = appendLimited(childOutput.anna, chunk); });
  await startAnnaProxy(backendPort, annaPort);
  const config = await waitForHttp(`http://127.0.0.1:${annaPort}/api/config`);
  const configBody = await config.json();
  check('real Anna dev dispatcher serves the aipdf-editor session', configBody.app_slug === 'aipdf-editor');

  chrome = launchChromium(chromePath, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-domain-reliability', '--disable-sync', '--metrics-recording-only', '--no-pings',
    '--disable-features=Translate,MediaRouter,OptimizationHints', '--disable-popup-blocking',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=*',
    `--user-data-dir=${profile}`, '--window-size=1440,900', '--force-device-scale-factor=1',
    '--allow-downloads', 'about:blank',
  ], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  chrome.stdout.on('data', (chunk) => { childOutput.chrome = appendLimited(childOutput.chrome, chunk); });
  chrome.stderr.on('data', (chunk) => { childOutput.chrome = appendLimited(childOutput.chrome, chunk); });
  const devtools = await waitForDevTools(profile);
  const profileDeadline = Date.now() + 15000;
  while (!exists(path.join(profile, 'Default', 'Preferences')) && Date.now() < profileDeadline) await delay(100);
  check('Chromium created a fresh default profile', exists(path.join(profile, 'Default'))
    && exists(path.join(profile, 'Default', 'Preferences')), `profile=${path.basename(profile)}`);

  cdp = await CdpConnection.connect(`ws://127.0.0.1:${devtools.port}${devtools.wsPath}`);
  const targets = new Map();
  cdp.on('Target.attachedToTarget', async ({ sessionId, targetInfo, waitingForDebuggerOnStart }) => {
    targets.set(targetInfo.targetId, { ...targetInfo, sessionId });
    try {
      if (['page', 'iframe', 'worker'].includes(targetInfo.type)) {
        await cdp.send('Network.enable', {}, sessionId);
        await cdp.send('Runtime.enable', {}, sessionId);
        await cdp.send('Log.enable', {}, sessionId);
      }
      if (['page', 'iframe'].includes(targetInfo.type)) {
        await cdp.send('Page.enable', {}, sessionId);
        await cdp.send('Security.enable', {}, sessionId);
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
      }
      if (waitingForDebuggerOnStart) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    } catch (error) { harnessErrors.push(error); }
  });
  cdp.on('Target.targetInfoChanged', ({ targetInfo }) => {
    if (targets.has(targetInfo.targetId)) targets.set(targetInfo.targetId, { ...targets.get(targetInfo.targetId), ...targetInfo });
  });
  cdp.on('Target.targetDestroyed', ({ targetId }) => targets.delete(targetId));
  cdp.on('Runtime.executionContextCreated', ({ context }) => {
    if (context.auxData?.frameId) frameContexts.set(context.auxData.frameId, context.id);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    for (const [frameId, contextId] of frameContexts) if (contextId === executionContextId) frameContexts.delete(frameId);
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    recordViolation('renderer-exception', params.exceptionDetails?.exception?.className || params.exceptionDetails?.text || 'exception');
  });
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error' || params.type === 'assert') recordViolation('renderer-console-error', params.type);
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error' && entry.source !== 'network') recordViolation('renderer-log-error', entry.source || 'unknown');
  });
  cdp.on('Security.contentSecurityPolicyViolation', (params) => {
    recordViolation('csp-violation', `${params.violatedDirective || 'csp'} ${safeUrl(params.blockedURI || params.sourceFile || '')}`);
  });
  cdp.on('Network.requestWillBeSent', (params) => {
    if (!isAllowedUrl(params.request?.url || '')) recordViolation('external-network', safeUrl(params.request?.url || ''));
  });
  cdp.on('Network.responseReceived', (params) => {
    const pathname = (() => { try { return new URL(params.response?.url || '').pathname; } catch { return ''; } })();
    if (pathname === '/favicon.ico') return;
    if (params.response?.status >= 400 && isAllowedUrl(params.response.url)) recordViolation('http-error', `${params.response.status} ${safeUrl(params.response.url)}`);
  });
  cdp.on('Network.loadingFailed', (params) => {
    if (!params.canceled && !String(params.errorText || '').includes('ERR_ABORTED')) recordViolation('network-failed', params.errorText || 'failed');
  });
  cdp.on('Network.webSocketCreated', async (params, sessionId) => {
    if (!isAllowedUrl(params.url)) {
      recordViolation('external-websocket', safeUrl(params.url));
      await cdp.send('Network.closeWebSocket', { requestId: params.requestId }, sessionId).catch(() => {});
    }
  });
  cdp.on('Fetch.requestPaused', async ({ requestId, request }, sessionId) => {
    const raw = request.url || '';
    if (!isAllowedUrl(raw)) {
      recordViolation('external-network-blocked', safeUrl(raw));
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId);
      return;
    }
    await cdp.send('Fetch.continueRequest', { requestId }, sessionId);
  });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
  let top = targets.get(created.targetId);
  const deadline = Date.now() + 10000;
  while (!top && Date.now() < deadline) { await delay(50); top = targets.get(created.targetId); }
  if (!top) throw new TestFailure('Could not attach to the dashboard target');
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${annaPort}/` }, top.sessionId);
  await waitFor(top.sessionId, `!!document.getElementById('app')?.contentWindow?.__aipdfBooted`, 'Anna dashboard app iframe boot');
  appSessionId = top.sessionId;
  const contextDeadline = Date.now() + 10000;
  while (!appContextId && Date.now() < contextDeadline) {
    appContextId = await evaluate(top.sessionId, `(() => {
      const frame = document.getElementById('app');
      return frame?.contentWindow?.__aipdfBooted ? window.__aipdfFrameContextId || null : null;
    })()`);
    if (!appContextId) {
      const tree = await cdp.send('Page.getFrameTree', {}, top.sessionId);
      const frameId = tree.frameTree.childFrames?.find((child) => child.frame.url.includes('/anna-apps/aipdf-editor/dev/index.html'))?.frame.id;
      appContextId = frameId ? frameContexts.get(frameId) || null : null;
    }
    if (!appContextId) await delay(50);
  }
  if (!appContextId) throw new TestFailure('Could not resolve the Anna iframe execution context');
  const frameEval = async (expression) => evaluate(top.sessionId, expression);
  const frameClick = async (selector, text = null, last = false) => {
    const point = await frameEval(`(() => {
      const root = ${last ? `Array.from(document.querySelectorAll('.msg.ai')).at(-1)` : 'document'};
      if (!root) return null;
      const nodes = Array.from(root.querySelectorAll(${JSON.stringify(selector)}));
      const el = ${text == null ? (last ? 'nodes.at(-1)' : 'nodes[0]') : `nodes.filter((node) => node.textContent.trim() === ${JSON.stringify(text)})${last ? '.at(-1)' : '[0]'}`};
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const outer = window.frameElement.getBoundingClientRect();
      return { x: outer.left + rect.left + rect.width / 2, y: outer.top + rect.top + rect.height / 2,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none', disabled: !!el.disabled };
    })()`);
    if (!point || !point.visible || point.disabled) throw new TestFailure(`Control is unavailable: ${selector}${text ? ` (${text})` : ''}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y,
        button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 }, top.sessionId);
    }
  };
  const frameUpload = async (file, openSelector) => {
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true }, top.sessionId);
    const chooser = cdp.waitForEvent('Page.fileChooserOpened', () => true, 10000, top.sessionId);
    const clicked = await frameEval(`(() => { const el = document.querySelector(${JSON.stringify(openSelector)}); if (!el) return false; el.click(); return true; })()`);
    if (!clicked) throw new TestFailure(`Upload control is unavailable: ${openSelector}`);
    const opened = await chooser;
    if (Number.isInteger(opened.backendNodeId)) {
      await cdp.send('DOM.setFileInputFiles', { files: [file], backendNodeId: opened.backendNodeId }, top.sessionId);
      return;
    }
    const object = await cdp.send('Runtime.evaluate', {
      expression: `document.getElementById('app').contentDocument.querySelector('input[type="file"]')`,
      returnByValue: false,
    }, top.sessionId);
    if (!object.result?.objectId) throw new TestFailure('Could not resolve the upload file input');
    const { nodeId } = await cdp.send('DOM.requestNode', { objectId: object.result.objectId }, top.sessionId);
    await cdp.send('DOM.setFileInputFiles', { files: [file], nodeId }, top.sessionId);
  };
  const sessionId = top.sessionId;
  await cdp.send('Page.bringToFront', {}, sessionId);
  await frameEval(`window.AIPDF_ANNA === true && !!window.ANNA_RUNTIME && window.__aipdfBooted === true
    && window.__aipdfState.docs.length === 0 && window.__aipdfSettings.recents.length === 0`);
  check('fresh Anna install has AIPDF_ANNA, connected ANNA_RUNTIME, and __aipdfBooted', true);

  await frameUpload(FIXTURE, '#ewOpen');
  await waitFor(sessionId, `(() => { const s = window.__aipdfState; const d = s.docs.find((x) => x.id === s.activeId); return !!d && d.numPages === 3 && document.querySelectorAll('#pages .page').length === 3; })()`, 'three-page upload');
  const opened = await modelSummary(sessionId);
  const nativeTitle = await evaluate(sessionId, `(async () => { const s = window.__aipdfState; const d = s.docs.find((x) => x.id === s.activeId); const tc = await (await d.pdf.getPage(1)).getTextContent(); return tc.items.map((x) => x.str || '').join(' ').replace(/\\s+/g, ' ').includes(${JSON.stringify(TITLE)}); })()`);
  check('real upload opens the canonical three-page PDF with native title text', opened.pages === 3 && nativeTitle);

  await click(sessionId, '[data-act="view:ai"]');
  await waitFor(sessionId, `!!document.querySelector('.ai-dock')`, 'AI dock');
  await evaluate(sessionId, `(() => { const select = document.querySelector('.ai-input select'); if (!select) return false; select.value = 'doc'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await fill(sessionId, '.ai-input textarea', 'E2E summary request: give a concise overview with page citations.');
  await click(sessionId, '.ai-input .mini-btn.primary');
  await waitFor(sessionId, `!!document.querySelector('.modal')`, 'AI egress consent');
  await click(sessionId, '.modal-foot button', 'Allow this session');
  await waitFor(sessionId, `(() => { const last = Array.from(document.querySelectorAll('.msg.ai')).at(-1); return !!last && last.textContent.includes(${JSON.stringify(SUMMARY)}) && !window.__aipdfState.ai.busy; })()`, 'deterministic summary answer');
  check('summary Q&A receives the deterministic mock answer with page citations', true);
  await waitFor(sessionId, `document.querySelectorAll('.ai-followups .ai-chip').length === 3`, 'deterministic follow-up suggestions');
  check('summary answer renders three deterministic follow-up suggestions', true);

  await click(sessionId, '.ai-mode-btn.agent');
  const beforeNumbers = fingerprint(await modelSummary(sessionId));
  await click(sessionId, '.ai-chip', 'Add page numbers');
  await waitFor(sessionId, `!!Array.from(document.querySelectorAll('.msg.ai')).at(-1)?.querySelector('.plan-head')`, 'page-number plan');
  const pendingNumbers = await modelSummary(sessionId);
  check('page-number plan appears without changing the document', fingerprint(pendingNumbers) === beforeNumbers);
  await click(sessionId, '.plan-actions .mini-btn.primary', null, true);
  await waitFor(sessionId, `!!Array.from(document.querySelectorAll('.msg.ai')).at(-1)?.querySelector('.plan-verdict.pass')`, 'page-number approval verification');
  const afterNumbers = await modelSummary(sessionId);
  check('approved page-number plan writes exactly one number per page', numbersMatch(afterNumbers), 'numbers=3');

  const beforeReject = fingerprint(await modelSummary(sessionId));
  await click(sessionId, '.ai-chip', 'Make the title blue');
  await waitFor(sessionId, `(() => {
    const last = Array.from(document.querySelectorAll('.msg.ai')).at(-1);
    return !!last && !last.querySelector('.ai-thinking') && !!last.querySelector('.plan-head')
      && /Recolour only the exact native title/i.test(last.textContent || '');
  })()`, 'title-color plan');
  const pendingColor = await modelSummary(sessionId);
  check('title-color plan appears without changing the document', fingerprint(pendingColor) === beforeReject);
  const cancelDiagnostic = await evaluate(sessionId, `(() => {
    const root = Array.from(document.querySelectorAll('.msg.ai')).at(-1);
    const button = Array.from(root.querySelectorAll('.plan-actions .mini-btn')).find(function (item) {
      return item.textContent.trim() === 'Cancel — change nothing';
    });
    if (!button) return JSON.stringify({ present: false });
    button.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = button.getBoundingClientRect();
    return JSON.stringify({ present: true, disabled: button.disabled, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      viewport: [innerWidth, innerHeight] });
  })()`);
  check('title-color cancel control is visible before rejection', JSON.parse(cancelDiagnostic).present
    && !JSON.parse(cancelDiagnostic).disabled && JSON.parse(cancelDiagnostic).width > 0, cancelDiagnostic);
  await click(sessionId, '.plan-actions .mini-btn', 'Cancel — change nothing', true);
  await waitFor(sessionId, `!!Array.from(document.querySelectorAll('.msg.ai')).at(-1)?.querySelector('.plan-cancelled')`, 'title-color rejection');
  check('rejecting the title-color plan leaves the document unchanged', fingerprint(await modelSummary(sessionId)) === beforeReject);

  await click(sessionId, '.ai-chip', 'Make the title blue');
  await waitFor(sessionId, `(() => {
    const last = Array.from(document.querySelectorAll('.msg.ai')).at(-1);
    return !!last && !last.querySelector('.ai-thinking') && !!last.querySelector('.plan-head')
      && /Recolour only the exact native title/i.test(last.textContent || '');
  })()`, 'second title-color plan');
  await click(sessionId, '.plan-actions .mini-btn.primary', null, true);
  await waitFor(sessionId, `!!Array.from(document.querySelectorAll('.msg.ai')).at(-1)?.querySelector('.plan-verdict.pass')`, 'title-color approval verification');
  const afterColor = await modelSummary(sessionId);
  check('approved exact title-color plan changes only the title color', titleColorMatches(afterColor) && numbersMatch(afterColor), 'color=#1d4ed8');

  await click(sessionId, '[data-act="edit:undo"]');
  await waitFor(sessionId, `window.__aipdfState.docs.find((x) => x.id === window.__aipdfState.activeId).textEdits.every((edit) => edit.text !== ${JSON.stringify(TITLE)})`, 'title-color undo');
  const undone = await modelSummary(sessionId);
  check('undo removes the approved title-color plan and preserves page numbers', undone.titleEdits.length === 0 && numbersMatch(undone));
  const redoHit = await evaluate(sessionId, `(() => {
    const button = document.querySelector('[data-act="edit:redo"]');
    const doc = window.__aipdfState.docs.find((entry) => entry.id === window.__aipdfState.activeId);
    if (!button) return { present: false };
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return { present: true, disabled: button.disabled, hIndex: doc.hIndex, historyLength: doc.history.length,
      hit: hit === button || button.contains(hit), hitClass: hit?.className || '' };
  })()`);
  check('redo control is enabled and unobstructed after undo', redoHit.present && !redoHit.disabled && redoHit.hit, JSON.stringify(redoHit));
  await click(sessionId, '[data-act="edit:redo"]');
  await waitFor(sessionId, `window.__aipdfState.docs.find((x) => x.id === window.__aipdfState.activeId).textEdits.some((edit) => edit.text === ${JSON.stringify(TITLE)})`, 'title-color redo');
  check('redo restores the approved title-color plan', titleColorMatches(await modelSummary(sessionId)));

  await evaluate(sessionId, `Object.defineProperty(window, 'showSaveFilePicker', { value: undefined, writable: true, configurable: true }); true`);
  check('Save As test forces the browser download fallback', await evaluate(sessionId, `typeof window.showSaveFilePicker === 'undefined'`));
  let downloadTimer = null;
  const download = new Promise((resolve, reject) => {
    let guid = null;
    let downloadName = '';
    downloadTimer = setTimeout(() => reject(new TestFailure('Timed out waiting for Save As download')), 30000);
    cdp.on('Browser.downloadWillBegin', (params) => {
      guid = params.guid;
      downloadName = params.suggestedFilename || '';
    });
    cdp.on('Browser.downloadProgress', (params) => {
      if (params.guid !== guid) return;
      if (params.state === 'completed') { clearTimeout(downloadTimer); resolve(downloadName || path.basename(downloads)); }
      else if (params.state === 'canceled') { clearTimeout(downloadTimer); reject(new TestFailure('Save As download was canceled')); }
    });
  });
  download.catch(() => {});
  try {
    await click(sessionId, '.plan-foot button', 'Save As…', true);
    await waitFor(sessionId, `!!Array.from(document.querySelectorAll('.modal button')).find((button) => /Continue to save/i.test(button.textContent || ''))`, 'Trust Preview');
    await click(sessionId, '.modal-foot button', 'Continue to save');
  } catch (error) {
    clearTimeout(downloadTimer);
    throw error;
  }
  const downloadedName = await download;
  const downloaded = path.join(downloads, downloadedName);
  check('real Save As footer action captures a PDF download', exists(downloaded) && fs.statSync(downloaded).size > 0,
    `file=${path.basename(downloaded)}`);
  const saved = await inspectSavedPdf(downloaded);
  check('saved bytes are a different, complete three-page PDF', saved.header === '%PDF-'
    && saved.trailer.includes('%%EOF') && saved.pages === 3 && saved.bytes !== fs.statSync(FIXTURE).size,
    `bytes=${saved.bytes}, sha256=${saved.sha256.slice(0, 16)}…`);
  check('saved bytes preserve the exact native title on page 1', saved.texts[0].includes(TITLE)
    && saved.texts.slice(1).every((text) => !text.includes(TITLE)));
  check('saved bytes contain exactly one correct page number on each page', NUMBER_TEXTS.every((needle, index) =>
    saved.texts[index].split(needle).length - 1 === 1
    && NUMBER_TEXTS.filter((_, other) => other !== index).every((wrong) => !saved.texts[index].includes(wrong))));
  check('saved PDF operators paint the exact title in #1d4ed8 before its text', saved.paint.ok,
    `fillAt=${saved.paint.fillAt}, textAt=${saved.paint.textAt}`);

  await frameUpload(downloaded, '[data-act="file:open"]');
  await waitFor(sessionId, `window.__aipdfState.docs.length === 2 && window.__aipdfState.docs.find((x) => x.id === window.__aipdfState.activeId).numPages === 3`, 'downloaded PDF reopen');
  const reopened = await reopenedTextEvidence(sessionId);
  check('reopened download retains title text and one correct number per page', reopened.pages === 3
    && reopened.titlePages[0] === 1 && reopened.titlePages.slice(1).every((count) => count === 0)
    && reopened.numbers.every((count) => count === 1) && reopened.wrongNumbers.every((count) => count === 0));

  await click(sessionId, '[data-act="view:ai"]');
  await waitFor(sessionId, `!!document.querySelector('.ai-dock')`, 'AI controls for responsive checks');
  for (const [width, height] of [[1000, 600], [1092, 614]]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1000, deviceScaleFactor: 1, mobile: false }, top.sessionId);
    await evaluate(top.sessionId, `(() => {
      const frame = document.getElementById('frame');
      const titlebar = frame.querySelector('.titlebar');
      frame.style.width = '${width}px';
      frame.style.height = (${height} + titlebar.offsetHeight) + 'px';
      return true;
    })()`, false);
    await waitFor(sessionId, `innerWidth === ${width} && innerHeight === ${height}`, `${width}x${height} iframe viewport`);
    const evidence = await responsiveEvidence(sessionId, width, height);
    check(`${width}x${height} primary controls are visible and not clipped`, evidence.controls.every((control) =>
      control.present && control.visible && control.inside) && evidence.noHorizontalOverflow && evidence.inputFits,
      JSON.stringify({ controls: `${evidence.controls.filter((control) => control.inside).length}/${evidence.controls.length}`,
        noHorizontalOverflow: evidence.noHorizontalOverflow, inputFits: evidence.inputFits }));
  }

  await delay(300);
  check('no renderer errors, CSP violations, or unexpected external network requests', violations.length === 0 && harnessErrors.length === 0,
    violations.length || harnessErrors.length ? JSON.stringify({ violations: violations.slice(0, 5), harnessErrors: harnessErrors.map((error) => safeText(error.message)) }) : 'clean');
  console.log(`ANNA_E2E_PASS ${passed} checks`);
}

try {
  await main();
} catch (error) {
  console.error(`ANNA_E2E_FAIL ${safeText(error instanceof TestFailure ? error.message : error.stack || error.message)}`);
  if (violations.length) console.error(`ANNA_E2E_VIOLATIONS ${JSON.stringify(violations.slice(0, 10))}`);
  process.exitCode = 1;
} finally {
  try { await cleanup(); }
  catch (error) {
    console.error(`ANNA_E2E_CLEANUP_FAIL ${safeText(error.message)}`);
    process.exitCode = 1;
  }
}
