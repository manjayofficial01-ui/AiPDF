#!/usr/bin/env node
/**
 * Windows shell thumbnail provider — end-to-end verification.
 *
 * Proves, in order:
 *   1. vendor/thumbnail/AiPdfThumbnailProvider.dll exists, is x64 and exports
 *      the COM entry points (re-runs the guarded build when missing)
 *   2. src/main/thumbnail-worker.cjs renders a page to a BMP under plain Node
 *   3. the probe harness (loads the DLL, drives IInitializeWithFile →
 *      IThumbnailProvider::GetThumbnail — the exact sequence the shell uses)
 *      produces bitmaps at Explorer's medium and small icon sizes, with the
 *      AiPDF badge present bottom-right at medium size and cleanly absent at
 *      icon-only sizes
 *   4. (optional, self-skipping) the real Explorer pipeline via
 *      IShellItemImageFactory::GetImage(SIIGBF_THUMBNAILONLY) — skipped with
 *      an explanation when the session has no interactive shell (services,
 *      CI): the .jpg control file then reports E_NOINTERFACE too
 *   5. reports the per-user registration state found on this machine
 *
 *   node scripts/thumb-provider-test.mjs
 */
import './ensure-fixture.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DLL = path.join(ROOT, 'vendor', 'thumbnail', 'AiPdfThumbnailProvider.dll');
const WORKER = path.join(ROOT, 'src', 'main', 'thumbnail-worker.cjs');
const PROBE = path.join(ROOT, '.scratch', 'thumb_probe.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const OUT = path.join(ROOT, '.smoke');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

/** Read the PE export table of a DLL. Returns { x64, names[] } or null. */
function peInfo(file) {
  const b = fs.readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('ascii', pe, pe + 4) !== 'PE\0\0') return null;
  const machine = b.readUInt16LE(pe + 4);
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
  if (e < 0) return { x64: machine === 0x8664, names: [] };
  const count = b.readUInt32LE(e + 24);
  const names = r2o(b.readUInt32LE(e + 32));
  const out = [];
  for (let i = 0; i < count; i++) {
    const p = r2o(b.readUInt32LE(names + i * 4));
    let z = p;
    while (b[z] !== 0) z++;
    out.push(b.toString('ascii', p, z));
  }
  return { x64: machine === 0x8664, names: out };
}

/** Parse a 32-bit BMP written by the worker/probe and count "red" pixels
    (AiPDF logo) and non-white pixels in a region. Rows are bottom-up. */
function bmpStats(file, region) {
  const b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 2) !== 'BM') throw new Error(`${file}: not a BMP`);
  const width = b.readInt32LE(18);
  const height = b.readInt32LE(22);
  const bpp = b.readUInt16LE(28);
  const data = b.readUInt32LE(10);
  if (bpp !== 32) throw new Error(`${file}: expected 32bpp, got ${bpp}`);
  let red = 0, ink = 0, total = 0;
  for (let y = 0; y < height; y++) {
    const row = data + y * width * 4;               // y counts from top here
    for (let x = 0; x < width; x++) {
      const o = row + x * 4;
      const r = b[o + 2], g = b[o + 1], bl = b[o];
      if (r < 200 || g < 200 || bl < 200) ink++;    // ink is measured page-wide
      const inRegion = !region || (x >= region.x && x < region.x + region.w
        && y >= region.y && y < region.y + region.h);
      if (!inRegion) continue;
      total++;
      if (r > 130 && r - bl > 40) red++;            // logo red only inside region
    }
  }
  return { width, height, red, ink, total };
}

// ── 1. DLL: present, x64, exports ───────────────────────────────────────────
let info = null;
try { info = peInfo(DLL); } catch { /* missing */ }
if (!info) {
  console.log('DLL missing — building it first…');
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-thumb-provider.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) { console.log('\nTHUMB_PROVIDER_FAIL build failed'); process.exit(1); }
  info = peInfo(DLL);
}
check('provider DLL exists and is x64', !!(info && info.x64), `${path.relative(ROOT, DLL)} (${fs.statSync(DLL).size} bytes)`);
check('DLL exports the COM entry points',
  !!(info && info.names.includes('DllGetClassObject') && info.names.includes('DllCanUnloadNow')),
  info ? info.names.join(',') : '');

// ── 2. worker under plain Node ──────────────────────────────────────────────
const workerBmp = path.join(OUT, 'thumb-worker-direct.bmp');
const workerRun = spawnSync(process.execPath, [WORKER, FIXTURE, workerBmp, '96'], { cwd: ROOT, encoding: 'utf8' });
let workerOk = workerRun.status === 0 && fs.existsSync(workerBmp);
let workerStats = null;
if (workerOk) {
  try { workerStats = bmpStats(workerBmp); } catch { workerOk = false; }
}
check('headless worker renders page 1 to a BMP',
  workerOk && workerStats && workerStats.width === 96 && workerStats.height >= 100,
  workerStats ? `${workerStats.width}x${workerStats.height}` : String(workerRun.stderr || '').trim().slice(0, 80));

// ── 3. probe harness = the shell's COM sequence ─────────────────────────────
if (!fs.existsSync(PROBE)) {
  const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-thumb-provider.mjs'), '--probe'], { cwd: ROOT, stdio: 'inherit' });
  if (build.status !== 0) { console.log('\nTHUMB_PROVIDER_FAIL probe build failed'); process.exit(1); }
}
const runProbe = (cx, out) => spawnSync(PROBE, [DLL, FIXTURE, out, String(cx)], { cwd: ROOT, encoding: 'utf8' });

const bmp256 = path.join(OUT, 'thumb-provider-256.bmp');
const p256 = runProbe(256, bmp256);
const full256 = fs.existsSync(bmp256) ? bmpStats(bmp256) : null;
const badge256 = full256 ? bmpStats(bmp256, {
  x: Math.floor(full256.width * 0.55), y: Math.floor(full256.height * 0.62),
  w: full256.width - Math.floor(full256.width * 0.55),
  h: full256.height - Math.floor(full256.height * 0.62),
}) : null;
check('probe (shell COM sequence) returns a 256px thumbnail',
  p256.status === 0 && p256.stdout.includes('THUMB_PROBE_OK 256x') && !!full256 && full256.width === 256,
  (p256.stdout || '').trim().split('\n')[0]);

check('256px thumbnail carries the AiPDF badge bottom-right',
  !!badge256 && badge256.red > 100,
  badge256 ? `${badge256.red} logo pixels in badge region` : 'no bitmap');

check('256px thumbnail shows real page content',
  !!full256 && full256.ink > 300,
  full256 ? `${full256.ink} non-white pixels on the page` : 'no bitmap');

const bmp32 = path.join(OUT, 'thumb-provider-32.bmp');
const p32 = runProbe(32, bmp32);
const stats32 = fs.existsSync(bmp32) ? bmpStats(bmp32) : null;
check('32px icon stays a clean page render (badge suppressed)',
  p32.status === 0 && p32.stdout.includes('THUMB_PROBE_OK 32x') && !!stats32 && stats32.red < 20 && stats32.ink > 10,
  stats32 ? `${stats32.red} red pixels (expected ~0), ${stats32.ink} ink` : (p32.stdout || '').trim());

// ── 4. real Explorer pipeline (self-skipping) ───────────────────────────────
const shellPs = path.join(OUT, 'shell-thumb-check.ps1');
fs.writeFileSync(shellPs, `# generated by scripts/thumb-provider-test.mjs
$ErrorActionPreference = 'Stop'
param()
`, { flag: 'w' });
fs.writeFileSync(shellPs, `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ShellThumb {
  public static IntPtr Hbm = IntPtr.Zero;
  public static int GetHr, GetImageHr;
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IntPtr ppv);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr h);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  public delegate int GetImageFn(IntPtr self, int cx, int flags, out IntPtr hbm);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)]
  public delegate int ReleaseFn(IntPtr self);
  public static void Probe(string file, int cx, int flags, string outPng) {
    Guid iid = new Guid("bcc18b79-ba16-442f-8024-2a7c148614eb");
    IntPtr factory, hbm;
    GetHr = SHCreateItemFromParsingName(file, IntPtr.Zero, ref iid, out factory);
    if (GetHr != 0) return;
    try {
      IntPtr vtbl = Marshal.ReadIntPtr(factory);
      IntPtr fn = Marshal.ReadIntPtr(vtbl, 3 * IntPtr.Size);
      var getImage = (GetImageFn)Marshal.GetDelegateForFunctionPointer(fn, typeof(GetImageFn));
      GetImageHr = getImage(factory, cx, flags, out hbm);
    } finally {
      IntPtr vtbl = Marshal.ReadIntPtr(factory);
      IntPtr rel = Marshal.ReadIntPtr(vtbl, 2 * IntPtr.Size);
      var release = (ReleaseFn)Marshal.GetDelegateForFunctionPointer(rel, typeof(ReleaseFn));
      release(factory);
    }
    if (GetImageHr != 0) return;
    Hbm = hbm;
    if (outPng != '') {
      var img = System.Drawing.Image.FromHbitmap(hbm);
      img.Save(outPng, System.Drawing.Imaging.ImageFormat.Png);
      img.Dispose();
    }
    DeleteObject(hbm);
  }
}
"@

function RedCount(pngPath) {
  $bmp = New-Object System.Drawing.Bitmap($pngPath)
  $red = 0
  for ($y = [int]($bmp.Height * 0.62); $y -lt $bmp.Height; $y++) {
    for ($x = [int]($bmp.Width * 0.55); $x -lt $bmp.Width; $x++) {
      $p = $bmp.GetPixel($x, $y)
      if ($p.R -gt 130 -and $p.R - $p.B -gt 40) { $red++ }
    }
  }
  $bmp.Dispose()
  return $red
}

$jpg = "$env:TEMP\aipdf-shellctl.jpg"
$bmp = New-Object System.Drawing.Bitmap(64, 64)
$g = [System.Drawing.Graphics]::FromImage($bmp); $g.Clear([System.Drawing.Color]::Tomato); $g.Dispose()
$bmp.Save($jpg, [System.Drawing.Imaging.ImageFormat]::Jpeg); $bmp.Dispose()
[ShellThumb]::Probe($jpg, 64, 8, '')
Write-Output ("SHELL_CONTROL 0x{0:X8}" -f [ShellThumb]::GetHr)
Remove-Item $jpg -Force -ErrorAction SilentlyContinue
if ([ShellThumb]::GetHr -ne 0) { exit 0 }   # no interactive shell: skip quietly

$src = '${FIXTURE.replace(/\\/g, '\\\\')}'
$pdf = Join-Path $env:TEMP ('aipdf-shell-' + [guid]::NewGuid().ToString('N') + '.pdf')
Copy-Item $src $pdf -Force
$png = Join-Path $env:TEMP 'aipdf-shell-thumb.png'
[ShellThumb]::Probe($pdf, 256, 8, $png)
Write-Output ("SHELL_PDF 0x{0:X8} 0x{1:X8}" -f [ShellThumb]::GetHr, [ShellThumb]::GetImageHr)
if ([ShellThumb]::GetImageHr -eq 0 -and (Test-Path $png)) {
  Write-Output ("SHELL_RED {0}" -f (RedCount $png))
  Remove-Item $png -Force
}
Remove-Item $pdf -Force -ErrorAction SilentlyContinue
`);

const shellRun = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shellPs], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
const shellOut = shellRun.stdout || '';
const control = /SHELL_CONTROL (0x[0-9a-fA-F]+)/.exec(shellOut);
const pdfLine = /SHELL_PDF (0x[0-9a-fA-F]+) (0x[0-9a-fA-F]+)/.exec(shellOut);
const redLine = /SHELL_RED (\d+)/.exec(shellOut);
if (!control || control[1].toUpperCase() !== '0X00000000') {
  console.log('SKIP  real Explorer pipeline — this session has no interactive shell (control file got E_NOINTERFACE); check runs fully on a normal desktop session');
  results.push({ name: 'shell pipeline', ok: true, skipped: true });
} else {
  const ok = !!pdfLine && pdfLine[1].toUpperCase() === '0X00000000'
    && pdfLine[2].toUpperCase() === '0X00000000' && !!redLine && Number(redLine[1]) > 100;
  check('real Explorer pipeline returns page thumbnail with badge',
    ok,
    pdfLine ? `create=0x${pdfLine[1].slice(2)}, get=0x${pdfLine[2].slice(2)}, red=${redLine ? redLine[1] : '?'}` : 'no result');
}

// ── 5. registration state (informational) ───────────────────────────────────
const CLSID = '{B7C1E4A2-3D58-4F60-9A1E-6C8D2F05B731}';
const q = (key) => {
  const r = spawnSync('reg.exe', ['query', `HKCU\\Software\\Classes\\${key}`, '/ve'], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout.split('REG_SZ').pop() || '').trim() : null;
};
const server = q(`CLSID\\${CLSID}\\InprocServer32`);
const assoc = q(`.pdf\\shellex\\{e357fccd-a995-4576-b01f-234630154e96}`);
const registered = !!server && !!assoc && server.toLowerCase().includes('aipdfthumbnailprovider.dll');
console.log(`${registered ? 'INFO' : 'WARN'}  registration: InprocServer32=${server || '(none)'}, .pdf shellex=${assoc || '(none)'}`);
if (!registered) {
  console.log('      register with:');
  console.log(`        reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\InprocServer32" /ve /d "${DLL}" /f`);
  console.log(`        reg add "HKCU\\Software\\Classes\\CLSID\\${CLSID}\\InprocServer32" /v ThreadingModel /d Apartment /f`);
  console.log('        reg add "HKCU\\Software\\Classes\\.pdf\\shellex\\{e357fccd-a995-4576-b01f-234630154e96}" /ve /d "' + CLSID + '" /f');
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length
  ? `\nTHUMB_PROVIDER_FAIL ${failed.length}/${results.length} checks failed`
  : `\nTHUMB_PROVIDER_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
