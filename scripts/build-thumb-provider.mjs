#!/usr/bin/env node
/**
 * Build resources/AiPdfThumbnailProvider.dll — the native Windows shell
 * extension that gives .pdf files a first-page thumbnail with the AiPDF badge.
 *
 * No Visual Studio is needed: Zig ships MinGW-w64 headers + import libraries,
 * so `zig cc -target x86_64-windows-gnu` produces a real x64 COM DLL. The
 * toolchain is downloaded once into .scratch/zig (gitignored) and the compiled
 * DLL is committed under vendor/thumbnail, so ordinary builds need neither
 * network access nor a compiler.
 *
 *   node scripts/build-thumb-provider.mjs [--force] [--probe]
 */
import './ensure-fixture.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORCE = process.argv.includes('--force');
const PROBE = process.argv.includes('--probe');
const OUT_DIR = path.join(ROOT, 'vendor', 'thumbnail');
const OUT = path.join(OUT_DIR, 'AiPdfThumbnailProvider.dll');
const SRC = path.join(ROOT, 'src', 'native', 'aipdf_thumb.c');
const PROBE_SRC = path.join(ROOT, 'src', 'native', 'thumb_probe.c');
const ZIG_DIR = path.join(ROOT, '.scratch', 'zig');
const ZIG_VER = '0.14.1';
const ZIG_URL = `https://ziglang.org/download/${ZIG_VER}/zig-x86_64-windows-${ZIG_VER}.zip`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts });

/* Zig resolves its compilation cache from the user's AppData, which is not
   always available (service shells, CI). Pinning it into .scratch keeps the
   build hermetic and works everywhere. */
const ZIG_CACHE = path.join(ROOT, '.scratch', 'zig-cache');
const zigEnv = () => ({
  ...process.env,
  ZIG_GLOBAL_CACHE_DIR: process.env.ZIG_GLOBAL_CACHE_DIR || ZIG_CACHE,
  ZIG_LOCAL_CACHE_DIR: process.env.ZIG_LOCAL_CACHE_DIR || ZIG_CACHE,
});

function findZig() {
  if (!fs.existsSync(ZIG_DIR)) return null;
  for (const d of fs.readdirSync(ZIG_DIR)) {
    const p = path.join(ZIG_DIR, d, 'zig.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function ensureZig() {
  const existing = findZig();
  if (existing) return existing;
  fs.mkdirSync(ZIG_DIR, { recursive: true });
  const zip = path.join(ZIG_DIR, `zig-${ZIG_VER}.zip`);
  console.log(`Downloading Zig ${ZIG_VER} (one-time, ~80 MB)…`);
  const res = await fetch(ZIG_URL);
  if (!res.ok) throw new Error(`Zig download failed: HTTP ${res.status}`);
  const out = fs.createWriteStream(zip);
  for await (const chunk of res.body) out.write(chunk);
  await new Promise((resolve) => out.end(resolve));

  const sevenZip = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (fs.existsSync(sevenZip)) {
    run(sevenZip, ['x', '-y', `-o${ZIG_DIR}`, zip]);
  } else {
    run('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${ZIG_DIR}' -Force`]);
  }
  const found = findZig();
  if (!found) throw new Error('Zig extracted but zig.exe was not found');
  return found;
}

/** Read the PE export table so a silently mis-exported DLL never ships. */
function exportsOf(file) {
  const b = fs.readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a PE file');
  const nsec = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const magic = b.readUInt16LE(pe + 24);
  const dir = pe + 24 + (magic === 0x20b ? 112 : 96);
  const expRva = b.readUInt32LE(dir);
  const secOff = pe + 24 + optSize;
  const secs = [];
  for (let i = 0; i < nsec; i++) {
    const s = secOff + i * 40;
    secs.push({ va: b.readUInt32LE(s + 12), raw: b.readUInt32LE(s + 20), size: b.readUInt32LE(s + 16) });
  }
  const r2o = (r) => {
    for (const s of secs) if (r >= s.va && r < s.va + s.size) return s.raw + (r - s.va);
    return -1;
  };
  const e = r2o(expRva);
  if (e < 0) return [];
  const count = b.readUInt32LE(e + 24);
  const names = r2o(b.readUInt32LE(e + 32));
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = r2o(b.readUInt32LE(names + i * 4));
    let z = p;
    while (b[z] !== 0) z++;
    out.push(b.toString('ascii', p, z));
  }
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
if (!FORCE && fs.existsSync(OUT) && fs.statSync(OUT).size > 10000) {
  console.log(`DLL already built: ${path.relative(ROOT, OUT)} (use --force to rebuild)`);
} else {
  const zig = await ensureZig();
  const args = ['cc', '-target', 'x86_64-windows-gnu', '-shared', '-O2',
    '-o', OUT, SRC, '-lole32', '-lshell32', '-lshlwapi', '-luser32', '-lgdi32'];
  console.log('Compiling thumbnail provider…');
  run(zig, args, { env: zigEnv() });
}

const names = exportsOf(OUT);
for (const required of ['DllGetClassObject', 'DllCanUnloadNow']) {
  if (!names.includes(required)) throw new Error(`Missing export ${required} in ${OUT}`);
}
const peBytes = fs.readFileSync(OUT);
const peOff = peBytes.readUInt32LE(0x3c);
if (peBytes.readUInt16LE(peOff + 4) !== 0x8664) {
  throw new Error('Not an x64 DLL');
}
console.log(`THUMB_BUILD_OK ${path.relative(ROOT, OUT)} exports=${names.join(',')}`);

if (PROBE) {
  const zig = await ensureZig();
  const scratch = path.join(ROOT, '.scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const exe = path.join(scratch, 'thumb_probe.exe');
  run(zig, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-municode',
    '-o', exe, PROBE_SRC, '-lole32', '-lgdi32', '-lshell32'], { env: zigEnv() });
  console.log(`Probe built: ${path.relative(ROOT, exe)}`);
}
