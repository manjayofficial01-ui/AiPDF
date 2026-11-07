#!/usr/bin/env node
/**
 * Launch test — proves the app actually becomes *visible*, not just that its
 * renderer boots.
 *
 * A `show:false` window only appears when `ready-to-show` fires, which needs a
 * painted frame. `--boot-test` polls `window.__aipdfBooted`, and that flag is
 * set by JS alone, so a stalled first frame passes it while the user sees
 * nothing. This test closes that hole: it launches the real app, then asserts
 * (a) a visible top-level window exists and (b) requestAnimationFrame fires.
 *
 *   node scripts/launch-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9411;
const results = { cdp: false, booted: null, raf: null, visibleWindows: 0, exitedEarly: null, checks: [] };

function check(name, ok, detail) {
  results.checks.push({ name, ok, detail });
}

async function findPageTarget() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch { /* devtools port not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

async function evaluate(wsUrl, expression) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
  const out = await new Promise((res) => {
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id === 1) res(m);
    });
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  ws.close();
  return out.result && out.result.result ? out.result.result.value : undefined;
}

function visibleWindowCount(pid) {
  return new Promise((res) => {
    const ps = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'win-visible.ps1'), '-Pid2', String(pid)], { windowsHide: true });
    let out = '';
    ps.stdout.on('data', (d) => { out += d; });
    ps.stderr.on('data', (d) => { out += d; });
    ps.on('close', () => {
      const m = out.match(/VISIBLE_WINDOWS=(\d+)/);
      res({ count: m ? Number(m[1]) : -1, detail: out.trim().split('\n').slice(1).join(' / ').trim() });
    });
  });
}

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-launch-test-'));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE; // would make require('electron') return the Node binding
// NOTE: do not pass windowsHide here. It sets STARTUPINFO wShowWindow=SW_HIDE,
// which makes Windows create the child's GUI window hidden and the visibility
// assertion below then measures the harness instead of the app.
const child = spawn(ELECTRON, ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`], { cwd: ROOT, env: childEnv });
let earlyExit = null;
child.stdout.on('data', (d) => process.stdout.write(String(d)));
child.stderr.on('data', (d) => process.stdout.write(String(d)));
child.on('exit', (code) => { earlyExit = code; });

const page = await findPageTarget();
results.cdp = !!page;
if (!page) {
  check('renderer reachable', false, `no index.html CDP target within 30s (child exit=${earlyExit})`);
} else {
  results.booted = null;
  for (let i = 0; i < 25 && results.booted !== true; i++) {
    results.booted = await evaluate(page.webSocketDebuggerUrl, '!!window.__aipdfBooted');
    if (results.booted !== true) await new Promise((r) => setTimeout(r, 400));
  }
  results.raf = await evaluate(page.webSocketDebuggerUrl, 'new Promise((res) => { const t = setTimeout(() => res("NO-RAF"), 4000); requestAnimationFrame(() => { clearTimeout(t); res("rafOK"); }); })');
  // The window is shown from ready-to-show; give the handshake time to land.
  for (let i = 0; i < 20; i++) {
    const w = await visibleWindowCount(child.pid);
    results.visibleWindows = w.count;
    results.windowDetail = w.detail;
    if (w.count > 0) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  check('app window is visible on screen', results.visibleWindows > 0, `visibleWindows=${results.visibleWindows} ${results.windowDetail || ''}`);
  check('renderer produces frames (rAF fires)', results.raf === 'rafOK', `raf=${results.raf}`);
  check('renderer booted without error', results.booted === true, `booted=${results.booted}`);
}

try { child.kill(); } catch { /* already gone */ }
await new Promise((r) => setTimeout(r, 1500));
if (!child.killed) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }

const failed = results.checks.filter((c) => !c.ok);
console.log('LAUNCH_TEST ' + JSON.stringify(results, null, 2));
if (failed.length) {
  console.log('LAUNCH_FAIL ' + failed.map((f) => f.name + ' (' + f.detail + ')').join(' | '));
  process.exit(1);
}
console.log('LAUNCH_PASS all ' + results.checks.length + ' checks green');
process.exit(0);
