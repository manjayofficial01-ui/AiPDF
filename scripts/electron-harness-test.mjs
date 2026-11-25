#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  chromePath,
  electronPath,
  rootSandboxArgs,
  managedEnvironment,
  managedArgs,
  stopProcessTree,
  waitForDevTools,
  waitForExit,
} from './lib/electron-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const checks = [];
const check = (name, fn) => {
  try {
    fn();
    checks.push(true);
    console.log(`PASS  ${name}`);
  } catch (error) {
    checks.push(false);
    console.log(`FAIL  ${name} — ${error.message}`);
  }
};

check('Electron resolves through the installed platform package', () => {
  assert.equal(electronPath(), require('electron'));
  assert.ok(fs.existsSync(electronPath()));
});

check('root sandbox arguments are limited to non-Windows UID 0', () => {
  assert.deepEqual(rootSandboxArgs({ platform: 'linux', uid: 0 }), ['--no-sandbox']);
  assert.deepEqual(rootSandboxArgs({ platform: 'darwin', uid: 0 }), ['--no-sandbox']);
  assert.deepEqual(rootSandboxArgs({ platform: 'linux', uid: 1000 }), []);
  assert.deepEqual(rootSandboxArgs({ platform: 'win32', uid: 0 }), []);
});

check('managed Electron environment removes only ELECTRON_RUN_AS_NODE', () => {
  const env = managedEnvironment({ ELECTRON_RUN_AS_NODE: '1', KEEP_ME: 'yes' }, { removeElectronRunAsNode: true });
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.KEEP_ME, 'yes');
});

check('managed arguments add root flags and preserve explicit debug ports', () => {
  assert.deepEqual(
    managedArgs(['.', `--remote-debugging-port=${'9472'}`], { platform: 'linux', uid: 0 }),
    ['--no-sandbox', '.', `--remote-debugging-port=${'9472'}`],
  );
  assert.deepEqual(
    managedArgs(['--remote-debugging-port=0'], { platform: 'win32', uid: 0 }),
    ['--remote-debugging-port=0'],
  );
});

check('Chrome discovery honors an explicit existing executable', () => {
  assert.equal(chromePath(process.execPath), process.execPath);
});

await checkAsync('DevToolsActivePort rejects an early child exit', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-devtools-test-'));
  try {
    await assert.rejects(
      waitForDevTools(temp, { exitCode: 1, signalCode: null }, 50),
      /exited early/i,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

await checkAsync('process-tree cleanup terminates both parent and child', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-process-tree-test-'));
  const pidFile = path.join(temp, 'pids.json');
  const source = `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(process.argv[1], JSON.stringify({ parent: process.pid, child: child.pid }));
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['-e', source, pidFile], {
    detached: process.platform !== 'win32',
    stdio: 'ignore',
  });
  try {
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(pidFile), 'parent did not write child PID');
    const { child: childPid } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    stopProcessTree(parent, 'SIGKILL');
    await waitForExit(parent, 3000);
    const childDeadline = Date.now() + 3000;
    while (pidAlive(childPid) && Date.now() < childDeadline) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pidAlive(childPid), false, 'child process survived tree cleanup');
  } finally {
    stopProcessTree(parent, 'SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    checks.push(true);
    console.log(`PASS  ${name}`);
  } catch (error) {
    checks.push(false);
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

check('test scripts contain no hardcoded Electron executable names', () => {
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) {
        if (/electron\.exe/i.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  visit(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
});

check('test scripts contain no numeric remote-debugging ports', () => {
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) {
        const source = fs.readFileSync(full, 'utf8');
        if (/--remote-debugging-port=[1-9]\d*/.test(source)) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  visit(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
});

check('Electron and Chrome test launches use managed process helpers', () => {
  const offenders = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.(mjs|cjs|js)$/.test(entry.name)) {
        const source = fs.readFileSync(full, 'utf8');
        if (/\bspawn\((?:ELECTRON|EXE|chromePath|chrome)\b/.test(source)) offenders.push(path.relative(ROOT, full));
      }
    }
  };
  visit(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, []);
});

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
