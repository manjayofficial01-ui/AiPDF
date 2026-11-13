/**
 * First-page content thumbnails for PDF files shown inside AiPDF Editor.
 *
 * Windows Explorer can only render a PDF's first page as a *file* thumbnail
 * through a native shell extension. This module provides the in-app version:
 * the Recent lists on the Start page and in the empty workspace show a real
 * raster of page 1 instead of a generic document icon.
 *
 * Rendering uses the same pdf.js build as the viewer, from the local server,
 * so nothing is uploaded anywhere. Results are small JPEG data URLs cached in
 * localStorage under a path + size + mtime key — an edited PDF therefore gets
 * a fresh preview, while an unchanged one is never rendered twice. Rendering
 * is capped at two documents at a time so opening the Start page with many
 * recents never starves the main viewer.
 */
import * as pdfjsLib from '/v/pdf.min.mjs';
import { el } from './util.js';
import { svgIcon } from './icons.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/v/pdf.worker.min.mjs';

const CACHE_KEY = 'aipdf.pdfThumbs.v1';
const MAX_CACHE = 24;                       // small JPEGs, ~10 KB each
const MAX_FILE = 80 * 1024 * 1024;          // never pull a huge PDF for a preview
const MAX_RENDER = 2;

let cache = readCache();
let running = 0;
const waiting = [];

function readCache() {
  try {
    const v = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeCache() {
  const keys = Object.keys(cache);
  while (keys.length > MAX_CACHE) delete cache[keys.shift()];
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Quota exceeded: drop the oldest half and retry once, then give up.
    const half = Object.keys(cache);
    for (const k of half.slice(0, Math.ceil(half.length / 2))) delete cache[k];
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { cache = {}; }
  }
}

/** A tiny semaphore: pdf.js workers are not free, so limit concurrency. */
function withRenderSlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      running++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        running--;
        const next = waiting.shift();
        if (next) next();
      });
    };
    if (running < MAX_RENDER) run();
    else waiting.push(run);
  });
}

/** Render page 1 to a JPEG data URL at roughly `width` CSS pixels. */
async function renderFirstPage(bytes, width) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(0),
    cMapUrl: '/v/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/v/stdfonts/',
    isEvalSupported: false,
    verbosity: 0,
  });
  const pdf = await task.promise;
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, Math.max(0.15, width / Math.max(1, base.width)));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(vp.width));
    canvas.height = Math.max(1, Math.floor(vp.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: ctx,
      viewport: vp,
      background: '#ffffff',
    }).promise;
    return canvas.toDataURL('image/jpeg', 0.72);
  } finally {
    try { await pdf.destroy(); } catch { /* a broken PDF may already be gone */ }
  }
}

/**
 * Cached first-page preview for `path`, or null when the file is missing,
 * encrypted, too large or not a PDF. Never throws.
 */
export async function getPdfThumbnail(path, width = 128) {
  if (!path) return null;
  const stat = window.api && typeof window.api.fileStat === 'function'
    ? await window.api.fileStat(path).catch(() => null)
    : null;
  if (stat && stat.size > MAX_FILE) return null;
  const key = `${path}|${stat ? stat.size : 0}|${stat ? stat.mtimeMs : 0}|${width}`;
  if (cache[key]) return cache[key];

  return withRenderSlot(async () => {
    if (cache[key]) return cache[key];
    const res = await window.api.readFile(path).catch(() => null);
    if (!res || !res.ok || !res.data) return null;
    const bytes = res.data instanceof Uint8Array ? res.data : new Uint8Array(res.data);
    const src = await renderFirstPage(bytes, width).catch(() => null);
    if (src) { cache[key] = src; writeCache(); }
    return src;
  });
}

/** Drop every cached preview for one path (used when Recents are cleared). */
export function forgetPdfThumb(path) {
  const prefix = `${path}|`;
  let changed = false;
  for (const k of Object.keys(cache)) {
    if (k.startsWith(prefix)) { delete cache[k]; changed = true; }
  }
  if (changed) writeCache();
}

/**
 * Build a thumbnail element that shows a generic file icon immediately and
 * swaps in the real page-1 raster once it is ready. `box.isConnected` guards
 * against a Recent list being re-rendered while a render is still in flight.
 */
export function makePdfThumb(path, width = 128, extraClass = '') {
  const box = el('span', {
    class: `pdf-thumb ${extraClass}`.trim(),
    'aria-hidden': 'true',
  });
  box.appendChild(el('span', { class: 'pdf-thumb-ph', html: svgIcon('file', 18) }));
  getPdfThumbnail(path, width).then((src) => {
    if (!src || !box.isConnected) return;
    box.replaceChildren(el('img', { src, alt: '' }));
    box.classList.add('ready');
  }).catch(() => { /* keep the placeholder */ });
  return box;
}
