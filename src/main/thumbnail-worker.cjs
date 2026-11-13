/**
 * Headless first-page renderer for the Windows Explorer thumbnail provider.
 *
 * Spawned by resources/AiPdfThumbnailProvider.dll through electron.exe with
 * ELECTRON_RUN_AS_NODE=1. There is no BrowserWindow, no local server and no
 * Chromium process: pdf.js renders into an @napi-rs/canvas surface entirely
 * in Node. Output is a 32-bit BMP (GDI's LoadImageW can turn that straight
 * into an HBITMAP without GDI+ or WIC in the shell extension).
 *
 * argv: [electron.exe, this-file, <pdf path>, <out .bmp>, <requested width>]
 *
 * The AiPDF app icon is composited at the bottom-right of the page preview,
 * the same way Acrobat / Foxit badge their PDF thumbnails in Explorer.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const canvas = require('@napi-rs/canvas');

// pdf.js expects these DOM-ish globals when there is no browser.
for (const key of ['DOMMatrix', 'Path2D', 'ImageData', 'Image']) {
  if (canvas[key]) globalThis[key] = canvas[key];
}

const ROOT = path.resolve(__dirname, '..', '..');           // …/app.asar
const PDFJS = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
const WORKER = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.worker.mjs');
const ICON = path.join(ROOT, 'assets', 'icon.png');

/** Encode an RGBA ImageData as a bottom-up 32-bit BI_RGB BMP. */
function toBmp(imageData, width, height) {
  const rowBytes = width * 4;
  const pixels = Buffer.allocUnsafe(rowBytes * height);
  const src = imageData.data;
  for (let y = 0; y < height; y++) {
    const from = (height - 1 - y) * width * 4;   // BMP rows are bottom-up
    const to = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const s = from + x * 4, d = to + x * 4;
      pixels[d] = src[s + 2];       // B
      pixels[d + 1] = src[s + 1];   // G
      pixels[d + 2] = src[s];       // R
      pixels[d + 3] = 255;          // opaque
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'ascii');
  head.writeUInt32LE(54 + pixels.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);          // BITMAPINFOHEADER
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  head.writeUInt16LE(1, 26);           // planes
  head.writeUInt16LE(32, 28);          // bpp
  head.writeUInt32LE(0, 30);           // BI_RGB
  head.writeUInt32LE(pixels.length, 34);
  return Buffer.concat([head, pixels]);
}

async function main() {
  const [pdfPath, outPath, sizeArg] = process.argv.slice(2);
  if (!pdfPath || !outPath) throw new Error('usage: worker <pdf> <out.bmp> <width>');
  const W = Math.max(32, Math.min(512, parseInt(sizeArg, 10) || 256));
  const H = Math.round(W * 1.28);
  const pad = Math.max(3, Math.round(W * 0.055));

  const pdfjs = await import(pathToFileURL(PDFJS).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(WORKER).href;
  const bytes = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    disableWorker: true,
    useSystemFonts: true,
    verbosity: 0,
  }).promise;

  let pageCanvas = null;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const boxW = W - pad * 2, boxH = H - pad * 2;
    const scale = Math.min(boxW / Math.max(1, base.width), boxH / Math.max(1, base.height));
    const vp = page.getViewport({ scale });
    const pw = Math.max(1, Math.floor(vp.width)), ph = Math.max(1, Math.floor(vp.height));
    pageCanvas = canvas.createCanvas(pw, ph);
    const pctx = pageCanvas.getContext('2d');
    pctx.fillStyle = '#ffffff';
    pctx.fillRect(0, 0, pw, ph);
    await page.render({ canvasContext: pctx, viewport: vp, background: '#ffffff' }).promise;

    const out = canvas.createCanvas(W, H);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    const px = Math.round((W - pw) / 2), py = Math.round((H - ph) / 2);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.12)';
    ctx.fillRect(px + 3, py + 3, pw, ph);
    ctx.drawImage(pageCanvas, px, py);
    ctx.strokeStyle = 'rgba(15, 23, 42, 0.20)';
    ctx.lineWidth = 1;
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // AiPDF badge, bottom-right — the visual signature the user asked for.
    // Only from medium icon sizes up: at 16–32 px a badge would cover the
    // whole preview, so tiny icons stay clean page renders.
    const badgePx = Math.round(W * 0.26);
    const badge = badgePx >= 10 ? badgePx : 0;
    if (badge) {
      const bx = W - badge - pad, by = H - badge - pad;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(bx - 3, by - 3, badge + 6, badge + 6);
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.16)';
      ctx.strokeRect(bx - 2.5, by - 2.5, badge + 5, badge + 5);
      try {
        const icon = await canvas.loadImage(fs.readFileSync(ICON));
        ctx.drawImage(icon, bx, by, badge, badge);
      } catch { /* a missing icon must not lose the page preview */ }
    }

    fs.writeFileSync(outPath, toBmp(ctx.getImageData(0, 0, W, H), W, H));
  } finally {
    await doc.destroy().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((err) => {
  try { fs.writeSync(2, `[AiPDF thumb] ${err && err.message ? err.message : err}\n`); } catch { /* ignore */ }
  process.exit(1);
});
