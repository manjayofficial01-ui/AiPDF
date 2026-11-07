#!/usr/bin/env node
/**
 * App-icon packaging guard.
 *
 * The "icon not showing" class of bug: the app ships with the generic Electron
 * icon (or none at all) because the icon never reached the executable.
 *
 * Three independent ways that happens, all of which this test pins down:
 *   1. `package.json` `build` has no `icon` field   -> electron-builder embeds
 *      the DEFAULT Electron icon into the exe, installer and every shortcut.
 *   2. `build.files` omits `assets/icon.ico`        -> the runtime lookup
 *      `app.getAppPath()/assets/icon.ico` misses inside app.asar, so the
 *      BrowserWindow silently gets no icon (main.js guards with `hasIcon`).
 *   3. `nsis` has no `installerIcon`/`uninstallerIcon` -> the installer UI
 *      shows the Electron icon.
 *
 * Static checks always run. Packed checks run when a build directory exists —
 * they compare the EXE's real RT_ICON byte-sizes against our .ico frames, which
 * is the only proof the icon is genuinely embedded (a filename or a config key
 * proves nothing about what the linker wrote).
 *
 *   node scripts/icon-pack-test.mjs [buildDir]     (default: dist-build)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Builds are written to fresh `dist-buildN` directories (a locked app.asar
   in a reused output dir silently ships stale bytes). With no explicit
   argument, verify the newest one that actually contains a built exe —
   otherwise this gate would skip its only real proof on every release. */
function newestBuildDir() {
  const dirs = fs.readdirSync(ROOT)
    .filter((n) => /^dist-build\d*$/.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(ROOT, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const d of dirs) {
    if (fs.existsSync(path.join(ROOT, d.n, 'win-unpacked', 'AiPDF Editor.exe'))) {
      return path.join(ROOT, d.n);
    }
  }
  return null;
}
const BUILD_DIR = process.argv[2]
  ? path.resolve(ROOT, process.argv[2])
  : (newestBuildDir() || path.resolve(ROOT, 'dist-build'));

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  — ' + detail : '')); }
}

/* ── .ico parser: returns the byte-size of each frame ───────────────────── */
function icoFrameSizes(file) {
  const b = fs.readFileSync(file);
  const count = b.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    sizes.push(b.readUInt32LE(o + 8));
  }
  return sizes;
}

/* ── PE resource parser: RT_ICON(3) frame sizes from an .exe ────────────── */
function exeIconFrameSizes(file) {
  const b = fs.readFileSync(file);
  const e_lfanew = b.readUInt32LE(0x3c);
  if (b.toString('ascii', e_lfanew, e_lfanew + 4) !== 'PE\0\0') return null;
  const numSections = b.readUInt16LE(e_lfanew + 6);
  const optSize = b.readUInt16LE(e_lfanew + 20);
  const optOff = e_lfanew + 24;
  const magic = b.readUInt16LE(optOff);
  const ddOff = optOff + (magic === 0x20b ? 112 : 96);
  const rsrcRva = b.readUInt32LE(ddOff + 2 * 8);
  const secOff = e_lfanew + 24 + optSize;
  let rsrcFileOff = 0;
  for (let i = 0; i < numSections; i++) {
    const o = secOff + i * 40;
    const vsize = b.readUInt32LE(o + 8), vaddr = b.readUInt32LE(o + 12);
    const rawSize = b.readUInt32LE(o + 16), rawPtr = b.readUInt32LE(o + 20);
    if (vaddr <= rsrcRva && rsrcRva < vaddr + Math.max(vsize, rawSize)) rsrcFileOff = rawPtr + (rsrcRva - vaddr);
  }
  if (!rsrcFileOff) return null;
  const base = rsrcFileOff;
  const dirEntries = (off) => {
    const n = b.readUInt16LE(off + 12) + b.readUInt16LE(off + 14);
    const out = [];
    for (let i = 0; i < n; i++) {
      const e = off + 16 + i * 8;
      out.push({ id: b.readUInt32LE(e), off2: b.readUInt32LE(e + 4) });
    }
    return out;
  };
  const types = {};
  for (const t of dirEntries(base)) {
    const id = t.id & 0x7fffffff;
    if (!(t.off2 & 0x80000000)) continue;
    types[id] = dirEntries(base + (t.off2 & 0x7fffffff)).map((s) => {
      let off3 = s.off2 & 0x7fffffff;
      if (s.off2 & 0x80000000) off3 = dirEntries(base + (s.off2 & 0x7fffffff))[0].off2 & 0x7fffffff;
      return b.readUInt32LE(base + off3 + 4); // Size field of IMAGE_RESOURCE_DATA_ENTRY
    });
  }
  return types[3] || [];
}

/* ── Static: the source config actually asks for the icon ───────────────── */
console.log('icon-pack-test  (build dir: ' + path.relative(ROOT, BUILD_DIR) + ')');
console.log('\n[static] package.json build config');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const build = pkg.build || {};
check('build.icon is set', !!build.icon, 'electron-builder would embed the default Electron icon');
check('build.win.icon is set', !!(build.win && build.win.icon), 'Windows exe/shortcut icon');
check('build.icon points at an existing file',
  !!build.icon && fs.existsSync(path.join(ROOT, build.icon)), build.icon);
check('build.files packages assets/icon.ico',
  Array.isArray(build.files) && build.files.some((f) => /assets\/icon\.ico$/.test(f)),
  'runtime app.getAppPath()/assets/icon.ico would miss inside app.asar');
check('nsis.installerIcon is set', !!(build.nsis && build.nsis.installerIcon), 'installer UI icon');
check('nsis.uninstallerIcon is set', !!(build.nsis && build.nsis.uninstallerIcon), 'uninstaller UI icon');

const ico = path.join(ROOT, 'assets', 'icon.ico');
if (!fs.existsSync(ico)) { check('assets/icon.ico exists', false); }
else {
  const frames = icoFrameSizes(ico);
  check('assets/icon.ico parses with frames', frames.length > 0, frames.join(','));
  check('assets/icon.ico has a 256px frame', frames.length >= 7, 'frames: ' + frames.length);

  /* ── Packed: the icon is really inside the built artefacts ───────────── */
  const exe = path.join(BUILD_DIR, 'win-unpacked', 'AiPDF Editor.exe');
  const asar = path.join(BUILD_DIR, 'win-unpacked', 'resources', 'app.asar');
  const setup = fs.existsSync(BUILD_DIR)
    ? fs.readdirSync(BUILD_DIR).find((f) => /setup\.exe$/.test(f))
    : null;

  if (!fs.existsSync(exe)) {
    console.log('\n[packed] skipped — no build at ' + path.relative(ROOT, exe) +
      '\n         (run `electron-builder --win --x64` first to verify the packaged icon)');
  } else {
    console.log('\n[packed] ' + path.relative(ROOT, exe));
    const exeFrames = exeIconFrameSizes(exe) || [];
    check('exe embeds an icon group', exeFrames.length > 0);
    const ours = new Set(frames);
    const allOurs = exeFrames.length > 0 && exeFrames.every((s) => ours.has(s));
    check('exe RT_ICON frames match assets/icon.ico', allOurs,
      'exe=[' + exeFrames.join(',') + ']  ico=[' + frames.join(',') + ']' +
      (allOurs ? '' : '  <- default Electron icon is still embedded'));

    if (fs.existsSync(asar)) {
      const list = require('@electron/asar').listPackage(asar);
      check('app.asar contains assets/icon.ico',
        list.some((f) => /assets[\\/]icon\.ico$/.test(f)),
        'window/taskbar icon would be missing at runtime');
    } else {
      check('app.asar exists', false, path.relative(ROOT, asar));
    }

    if (setup) {
      const setupPath = path.join(BUILD_DIR, setup);
      const setupFrames = exeIconFrameSizes(setupPath) || [];
      const setupOurs = setupFrames.length > 0 && setupFrames.every((s) => ours.has(s));
      check('installer .exe embeds our icon', setupOurs,
        'installer=[' + setupFrames.join(',') + ']');
    } else {
      console.log('  note  no *setup.exe in the build dir — installer icon not verified');
    }
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
