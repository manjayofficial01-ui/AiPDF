#!/usr/bin/env node
/**
 * Asar integrity check — every packaged file must be byte-identical to its
 * source.
 *
 * Why this exists (v2.22.1): a build shipped an `app.asar` in which exactly one
 * entry, `src/renderer/js/zip.js`, had a correct header size but the wrong data
 * offset. `fs.statSync` reported 3556 bytes, `fs.readFileSync` returned 3556
 * bytes of *shifted* content, and `fs.createReadStream` — the call the renderer
 * server uses — threw `ENOENT … not found in app.asar`. The HTTP layer answered
 * with an empty response, `app.js`'s module graph failed on the import, `boot()`
 * never ran, and the user got a window with an empty ribbon and no tab labels.
 *
 * Nothing in the build log hinted at it, and the installer copied the bad asar
 * faithfully. A size check would not have caught it either — sizes matched. Only
 * comparing bytes does.
 *
 *   node scripts/asar-check.mjs                  # newest dist-buildN/win-unpacked
 *   node scripts/asar-check.mjs --installed      # the installed app
 *   node scripts/asar-check.mjs <path-to.asar>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALLED = 'C:/Program Files/AiPDF Editor/resources/app.asar';

function newestBuildAsar() {
  const dirs = fs.readdirSync(ROOT)
    .filter((n) => /^dist-build\d*$/.test(n))
    .map((n) => ({ n, t: fs.statSync(path.join(ROOT, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const d of dirs) {
    const p = path.join(ROOT, d.n, 'win-unpacked', 'resources', 'app.asar');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const args = process.argv.slice(2);
const target = args.includes('--installed') ? INSTALLED : (args.find((a) => a.endsWith('.asar')) || newestBuildAsar());
if (!target || !fs.existsSync(target)) {
  console.log(`ASAR_FAIL no archive found (${target || 'none'})`);
  process.exit(1);
}

const buf = fs.readFileSync(target);
if (buf.length < 32 || buf.readUInt32LE(0) !== 4) {
  console.log('ASAR_FAIL not an asar archive (bad pickle header)');
  process.exit(1);
}
const jsonLen = buf.readUInt32LE(12);
let header;
try { header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8')); }
catch (e) { console.log('ASAR_FAIL header JSON unreadable: ' + e.message); process.exit(1); }

/* Collect every real file entry, remembering its archive-relative offset. */
const entries = [];
(function walk(node, prefix) {
  for (const [name, v] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (v.files) { walk(v, p); continue; }
    if (v.link || v.unpacked) continue;      // symlink / stored outside the asar
    entries.push({ path: p, offset: Number(v.offset), size: Number(v.size) });
  }
})(header, '');

/* The data section starts after the header, 4-byte aligned. Rather than trust
   one formula, calibrate against a file we can also read from the repo — if the
   archive is shifted as a whole, calibration fails loudly instead of comparing
   everything against the wrong window. */
const aligned = (n) => Math.ceil(n / 4) * 4;
const candidates = [16 + aligned(jsonLen), 16 + jsonLen, 8 + aligned(jsonLen + 8)];
const calibration = entries.find((e) => e.path === 'src/renderer/js/icons.js')
  || entries.find((e) => fs.existsSync(path.join(ROOT, e.path)));
let dataStart = null;
let calibPath = null;
if (calibration) {
  const disk = path.join(ROOT, calibration.path);
  if (fs.existsSync(disk)) {
    const src = fs.readFileSync(disk);
    calibPath = calibration.path;
    for (const c of candidates) {
      const slice = buf.subarray(c + calibration.offset, c + calibration.offset + calibration.size);
      if (slice.length === src.length && Buffer.compare(slice, src) === 0) { dataStart = c; break; }
    }
  }
}
if (dataStart === null) {
  // Every candidate window failed, so the header and the data section disagree:
  // the archive is misaligned or truncated. Say so instead of dumping hundreds
  // of misleading byte-0 mismatches.
  const last = entries.reduce((a, b) => (a.offset > b.offset ? a : b), entries[0]);
  const tail = candidates[0] + last.offset + last.size;
  console.log(`archive  ${target}`);
  console.log(`entries  ${entries.length}`);
  console.log(`calib    FAILED against ${calibPath || 'no readable reference file'}`);
  console.log(`  header claims ${buf.length} bytes; the last entry (${last.path}) needs ${tail - buf.length} more`);
  console.log('\nASAR_FAIL archive data section does not match its header (truncated or misaligned)');
  process.exit(1);
}

let bad = 0;
let checked = 0;
const problems = [];
for (const e of entries) {
  const start = dataStart + e.offset;
  const end = start + e.size;
  if (start < 0 || end > buf.length) {
    bad++; problems.push(`${e.path}: offset ${e.offset}+${e.size} runs past the archive (${buf.length} bytes)`);
    continue;
  }
  checked++;
  // electron-builder rewrites package.json files (strips scripts/devDeps), so
  // byte equality only holds for our own sources and assets.
  if (!/^(src|assets)\//.test(e.path)) continue;
  const disk = path.join(ROOT, e.path);
  if (!fs.existsSync(disk)) continue;          // generated: range check only
  const src = fs.readFileSync(disk);
  const slice = buf.subarray(start, end);
  if (slice.length !== src.length || Buffer.compare(slice, src) !== 0) {
    bad++;
    let at = 0;
    while (at < Math.min(slice.length, src.length) && slice[at] === src[at]) at++;
    problems.push(`${e.path}: content differs (archive ${e.size}B vs source ${src.length}B, first difference at byte ${at})`);
  }
}

console.log(`archive  ${target}`);
console.log(`entries  ${entries.length} (${checked} in range)`);
console.log(`calib    ${calibPath || 'none — size-only check'}  dataStart=${dataStart}`);
if (problems.length) {
  for (const p of problems.slice(0, 20)) console.log('  BAD ' + p);
  console.log(`\nASAR_FAIL ${bad} unreadable or mismatched entr${bad === 1 ? 'y' : 'ies'}`);
  process.exit(1);
}
console.log(`\nASAR_PASS all ${entries.length} entries match their source`);
