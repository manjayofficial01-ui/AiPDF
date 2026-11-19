/**
 * Assemble the Anna App edition of AiPDF Editor into
 * anna-app/aipdf-editor/bundle/ from web-dist/ plus a quota-fitting subset of
 * the vendored OCR assets.
 *
 * Why not just copy web-dist/? The Anna App bundle pipeline enforces hard
 * quotas (https://anna.partners/developers/apps/app-ui-bundle):
 *
 *   total bundle ≤ 50 MB, ≤ 2,000 files, ≤ 10 MB per file,
 *   every path must match ^[A-Za-z0-9_./-]+$
 *
 * web-dist vendors every Tesseract WASM core (43 MB across nine variants) and
 * the best-quality English pack (eng.traineddata.gz, 10.4 MB — over the
 * per-file cap). The Anna edition therefore ships the three LSTM-only cores
 * (the renderer always creates Tesseract workers with OEM 1, so the full-model
 * cores are dead weight) and the tessdata_fast English pack, which is exactly
 * the quality tier the web edition's CDN fallback serves.
 *
 * Run from the repo root:  npm run build:web && node scripts/build-anna.mjs
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web-dist');
const APP = path.join(ROOT, 'anna-app', 'aipdf-editor');
const OUT = path.join(APP, 'bundle');
const TESSCORE = path.join(ROOT, 'node_modules', 'tesseract.js-core');
const TESSDATA_BEST = path.join(ROOT, 'vendor', 'tessdata');
const TESSDATA_FAST = path.join(ROOT, 'vendor', 'tessdata-fast');

/** OEM 1 (LSTM-only) cores only — see the renderer's ocr.js createWorker call. */
const TESSCORE_KEEP = [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-relaxedsimd-lstm.wasm',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm',
  'tesseract-core-lstm.wasm.js',
  'tesseract-core-lstm.wasm',
];

/** eng from tessdata-fast (the vendored best pack busts the 10 MB/file cap);
 *  hin/nep keep the vendored packs. osd is not selectable in the OCR UI. */
const TESSDATA_MAP = [
  [path.join(TESSDATA_FAST, 'eng.traineddata.gz'), 'eng.traineddata.gz'],
  [path.join(TESSDATA_BEST, 'hin.traineddata.gz'), 'hin.traineddata.gz'],
  [path.join(TESSDATA_BEST, 'nep.traineddata.gz'), 'nep.traineddata.gz'],
];

const LIMITS = {
  totalBytes: 50 * 1024 * 1024,
  maxFiles: 2000,
  fileBytes: 10 * 1024 * 1024,
  pathRe: /^[A-Za-z0-9_./-]+$/,
};

/**
 * The renderer is served from the site root in the desktop build and on
 * Vercel, so it addresses assets root-absolutely (/v/…, /js/…, /css/…). An
 * Anna bundle lives at /anna-apps/{slug}/{version}/, where those URLs would
 * escape the bundle directory and 404. Rewrite the known patterns to
 * bundle-relative ones: module-relative for ES imports made from js/*.js
 * (one level deep), document-relative for everything else (worker paths,
 * loadScript, fetch, HTML attributes).
 */
function relativize(text) {
  return text
    .replace(/import\('(\/v\/)/g, "import('../v/")       // dynamic imports from js/*.js
    .replace(/(from\s+')(\/v\/)/g, '$1../v/')            // static imports from js/*.js
    .replace(/origin \+ '\/v\//g, "'./v/")               // ocr.js runtime asset URLs
    .replace(/origin \+ '\//g, "'./")                    // ocr.js /__ocr-health probe
    .replace(/origin \+ TESSDATA_LOCAL/g, 'TESSDATA_LOCAL')
    .replace(/'(\/v\/)/g, "'./v/")                       // remaining document-relative strings
    .replace(/"(\/v\/)/g, '"./v/')
    .replace(/=\s*"\/(css\/|js\/)/g, '="./$1')          // index.html attributes
    .replace(/=\s*'\/(css\/|js\/)/g, "='./$1");
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p, base));
    else out.push({ rel: path.relative(base, p).replace(/\\/g, '/'), size: statSync(p).size });
  }
  return out;
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + ' MB';

function main() {
  if (!existsSync(path.join(WEB, 'index.html'))) {
    console.error('build-anna: web-dist/ is missing — run `npm run build:web` first.');
    process.exit(1);
  }
  const missing = [
    ...TESSCORE_KEEP.map((f) => path.join(TESSCORE, f)),
    ...TESSDATA_MAP.map(([s]) => s),
  ].filter((s) => !existsSync(s));
  if (missing.length) {
    console.error('build-anna: missing OCR assets:\n  ' + missing.join('\n  '));
    process.exit(1);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 1. The web edition, minus the two vendored OCR directories we replace.
  cpSync(WEB, OUT, {
    recursive: true,
    filter: (src) => !(src.includes(`${path.sep}tesscore`) || src.includes(`${path.sep}tessdata`)),
  });

  // 2. Curated Tesseract cores.
  mkdirSync(path.join(OUT, 'v', 'tesscore'), { recursive: true });
  for (const f of TESSCORE_KEEP) copyFileSync(path.join(TESSCORE, f), path.join(OUT, 'v', 'tesscore', f));

  // 3. Curated language packs.
  mkdirSync(path.join(OUT, 'v', 'tessdata'), { recursive: true });
  for (const [src, name] of TESSDATA_MAP) copyFileSync(src, path.join(OUT, 'v', 'tessdata', name));

  // 3b. Rewrite root-absolute asset URLs to bundle-relative ones.
  let rewritten = 0;
  for (const f of walk(OUT)) {
    if (!/\.(html|js|mjs|css)$/.test(f.rel)) continue;
    const p = path.join(OUT, f.rel);
    const before = readFileSync(p, 'utf8');
    const after = relativize(before);
    if (after !== before) { writeFileSync(p, after); rewritten++; }
  }

  // 4. Quota audit — fail loudly before an upload is attempted.
  const files = walk(OUT);
  const total = files.reduce((s, f) => s + f.size, 0);
  const biggest = files.slice().sort((a, b) => b.size - a.size).slice(0, 5);
  const badPaths = files.filter((f) => !LIMITS.pathRe.test(f.rel)).map((f) => f.rel);

  console.log(`build-anna: ${files.length} files, ${mb(total)} total (web-dist baseline: 67.3 MB), ${rewritten} files rewritten to relative paths`);
  for (const f of biggest) console.log(`  ${mb(f.size).padStart(9)}  ${f.rel}`);

  const problems = [];
  if (total > LIMITS.totalBytes) problems.push(`total bundle ${mb(total)} exceeds the 50 MB quota`);
  if (files.length > LIMITS.maxFiles) problems.push(`${files.length} files exceed the 2,000-file quota`);
  for (const f of files) if (f.size > LIMITS.fileBytes) problems.push(`${f.rel} (${mb(f.size)}) exceeds the 10 MB per-file cap`);
  for (const p of badPaths) problems.push(`unsafe bundle path: ${p}`);

  if (problems.length) {
    console.error('build-anna: QUOTA FAILURES\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
  console.log('build-anna: all Anna bundle quotas pass (≤50 MB total, ≤2,000 files, ≤10 MB/file, safe paths)');
}

main();
