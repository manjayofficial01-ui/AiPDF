/**
 * Assemble the web edition of AiPDF Editor into web-dist/.
 *
 * The renderer is already a browser app (ES modules served over HTTP by
 * src/main/server.js); the desktop-only part is the window.api bridge, which
 * src/renderer/js/web-shim.js replaces in the browser. So "building for the
 * web" is a straight copy plus the vendored libraries the local server maps
 * under /v/…:
 *
 *   renderer files        → /
 *   pdf.js + worker       → /v/pdf.min.mjs, /v/pdf.worker.min.mjs
 *   pdf-lib               → /v/pdf-lib.js
 *   tesseract.js          → /v/tesseract.min.js, /v/tesseract-worker.min.js
 *   regenerator-runtime   → /v/regenerator-runtime.js
 *   fontkit               → /v/fontkit.umd.min.js
 *   cmaps / stdfonts      → /v/cmaps/, /v/stdfonts/
 *   tesseract WASM cores  → /v/tesscore/
 *   language packs        → /v/tessdata/
 *
 * Deployed by Vercel (vercel.json runs this script; api/proxy.js rides along
 * as the same-origin relay). `npm run build:web` for a local copy.
 *
 * Run from the repo root: node scripts/build-web.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const NM = path.join(ROOT, 'node_modules');
const TESSDATA = path.join(ROOT, 'vendor', 'tessdata');
const OUT = path.join(ROOT, 'web-dist');

const FILES = [
  ['/v/pdf.min.mjs', path.join(NM, 'pdfjs-dist', 'build', 'pdf.min.mjs')],
  ['/v/pdf.worker.min.mjs', path.join(NM, 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')],
  ['/v/pdf-lib.js', path.join(NM, '@cantoo', 'pdf-lib', 'dist', 'pdf-lib.esm.min.js')],
  ['/v/tesseract.min.js', path.join(NM, 'tesseract.js', 'dist', 'tesseract.min.js')],
  ['/v/tesseract-worker.min.js', path.join(NM, 'tesseract.js', 'dist', 'worker.min.js')],
  ['/v/regenerator-runtime.js', path.join(NM, 'regenerator-runtime', 'runtime.js')],
  ['/v/fontkit.umd.min.js', path.join(NM, '@pdf-lib', 'fontkit', 'dist', 'fontkit.umd.min.js')],
];
const DIRS = [
  ['/v/cmaps/', path.join(NM, 'pdfjs-dist', 'cmaps')],
  ['/v/stdfonts/', path.join(NM, 'pdfjs-dist', 'standard_fonts')],
  // ICC profiles ship with some pdf.js builds only; optional like in server.js.
  ['/v/icc/', path.join(NM, 'pdfjs-dist', 'icc')],
  ['/v/tesscore/', path.join(NM, 'tesseract.js-core')],
  ['/v/tessdata/', TESSDATA],
];

function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : statSync(p).size;
  }
  return total;
}

function main() {
  if (!existsSync(path.join(RENDERER, 'index.html'))) {
    console.error(`build-web: renderer not found at ${RENDERER}`);
    process.exit(1);
  }
  const missing = [
    ...FILES.map(([, src]) => src),
    ...DIRS.filter(([, src]) => !src.includes('icc')).map(([, src]) => src),
  ].filter((src) => !existsSync(src));
  if (missing.length) {
    console.error('build-web: missing sources (run npm install in the repo root):\n  ' + missing.join('\n  '));
    process.exit(1);
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 1. Renderer: html, css, js, the fixture used by the start-page samples.
  cpSync(RENDERER, OUT, { recursive: true });

  // 2. Single-file vendored libraries at their server.js routes.
  for (const [route, src] of FILES) {
    const dest = path.join(OUT, route.replace(/^\//, ''));
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(src, dest);
  }

  // 3. Vendored asset directories.
  for (const [route, src] of DIRS) {
    if (!existsSync(src)) continue;
    cpSync(src, path.join(OUT, route.replace(/^\//, '')), { recursive: true });
  }

  console.log(`build-web: web-dist ready — ${(dirSize(OUT) / 1024 / 1024).toFixed(1)} MB`);
  console.log('  serve it with:  npx serve web-dist   (or deploy: vercel --prod)');
}

main();
