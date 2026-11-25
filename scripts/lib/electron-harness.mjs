import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const activeChildren = new Set();
const rawKill = Symbol('rawKill');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function electronPath(override) {
  return override ? path.resolve(override) : require('electron');
}

export function rootSandboxArgs({ platform = process.platform, uid = process.getuid?.() } = {}) {
  return platform !== 'win32' && uid === 0 ? ['--no-sandbox'] : [];
}

export function managedEnvironment(base = process.env, { removeElectronRunAsNode = false } = {}) {
  const env = { ...base };
  if (removeElectronRunAsNode) delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

export function managedArgs(args, options = {}) {
  return [...rootSandboxArgs(options), ...args.map(String)];
}

function exists(file) {
  return !!file && fs.existsSync(file);
}

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

export function chromePath(override) {
  const explicit = override || process.env.AIPDF_CHROME || process.env.CHROME_PATH || process.env.CHROMIUM_PATH
    || process.env.GOOGLE_CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (explicit && exists(explicit)) return explicit;
  if (explicit) throw new Error(`Chrome path from environment does not exist: ${explicit}`);
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
  return candidates.find(exists) || onPath(process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : ['google-chrome', 'chromium', 'chromium-browser']);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export function stopProcessTree(child, signal = 'SIGTERM') {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (process.platform === 'win32' && child.pid) {
    const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (result.status === 0) return;
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error?.code !== 'ESRCH') {
        killChild(child, signal);
        return;
      }
    }
  }
  killChild(child, signal);
}

function killChild(child, signal) {
  try {
    const kill = child[rawKill] || child.kill.bind(child);
    kill(signal);
  } catch { /* already gone */ }
}

function launchManaged(command, args, options = {}, { electron = false } = {}) {
  const child = spawn(command, managedArgs(args), {
    ...options,
    env: managedEnvironment(options.env || process.env, { removeElectronRunAsNode: electron }),
    detached: process.platform !== 'win32',
  });
  child[rawKill] = child.kill.bind(child);
  child.kill = (signal = 'SIGTERM') => {
    stopProcessTree(child, signal);
    return true;
  };
  activeChildren.add(child);
  child.once('exit', () => activeChildren.delete(child));
  return child;
}

export function launchElectron(args, options = {}) {
  const { executable, ...spawnOptions } = options;
  return launchManaged(electronPath(executable), args, spawnOptions, { electron: true });
}

export function launchChromium(executable, args, options = {}) {
  return launchManaged(chromePath(executable), args, options);
}

export async function waitForDevTools(profile, child, timeoutMs = 30000) {
  const file = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null || child?.signalCode != null) {
      throw new Error(`browser exited early (${child.exitCode ?? child.signalCode})`);
    }
    if (exists(file)) {
      try {
        const lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0 && lines[1]?.startsWith('/')) {
          return { port, wsPath: lines[1] };
        }
      } catch (error) {
        if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
      }
    }
    await delay(100);
  }
  throw new Error('browser DevTools endpoint did not appear');
}

export async function waitForExit(child, timeoutMs = 3000) {
  if (child?.exitCode != null || child?.signalCode != null) return;
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode == null && child.signalCode == null && Date.now() < deadline) await delay(100);
}

process.once('exit', () => {
  for (const child of activeChildren) stopProcessTree(child, 'SIGKILL');
});
