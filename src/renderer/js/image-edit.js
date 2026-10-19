/** Edit Image tool: select an image that is already drawn on the page, then
 *  move/resize it with handles or rotate/flip/fade/replace/delete it from the
 *  floating toolbar. Every mutation goes through the native content-stream
 *  adapter and the structural-undo reload path (see pages.js), so a save
 *  contains exactly what the preview showed.
 *
 *  Deliberately out of scope for this first UI: multi-select, arrow-key nudges,
 *  editing images nested inside Form XObjects, and inline images (the core
 *  refuses both by design). */
import { state, activeDoc, on } from './store.js';
import { listNativeImages, commitNativeImageEdit } from './pages.js';
import { toast } from './util.js';

const MIN_SIZE = 4;          // PDF points
const MAX_REPLACE = 8 * 1024 * 1024;

let active = false;
let busy = false;
let pageIndex = -1;
let target = null;           // { name, bounds, corners, matrix }
let vp = null;
let ui = null;               // { page, box, bar, canvas }
let images = [];
let cacheKey = '';
let listPage = -1;

export function initImageEdit() {
  on('tool', (t) => {
    active = t === 'editImage';
    document.body.classList.toggle('tool-editImage', active);
    if (!active) clearSelection();
  });
  on('doc', () => { dropCache(); clearSelection(); });
  on('structure', () => { dropCache(); clearSelection(); });
  on('zoom', () => { if (target) refreshViewport(); });
  on('layout', () => { if (target) refreshViewport(); });
  window.addEventListener('resize', () => { if (target) refreshViewport(); });
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('keydown', (e) => {
    if (active && e.key === 'Escape' && target) {
      e.preventDefault();
      e.stopPropagation();
      clearSelection();
    }
  }, true);
  if (state.tool === 'editImage') {
    active = true;
    document.body.classList.add('tool-editImage');
  }
}

function dropCache() { images = []; cacheKey = ''; listPage = -1; }

function clearSelection() {
  target = null;
  vp = null;
  pageIndex = -1;
  removeUi();
}

function removeUi() {
  document.querySelectorAll('.img-edit-ui').forEach((n) => n.remove());
  ui = null;
}

function pageFor(i) { return document.querySelector(`.page[data-i="${i}"]`); }

async function viewportFor(i) {
  const doc = activeDoc();
  if (!doc?.pdf) return null;
  const page = await doc.pdf.getPage(i + 1);
  const rotation = (page.rotate || 0) + (doc.pageRotate?.[i] || 0) + state.view.rotation;
  return page.getViewport({ scale: 1, rotation });
}

function toPdf(v, canvas, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return v.convertToPdfPoint(
    ((clientX - r.left) / r.width) * v.width,
    ((clientY - r.top) / r.height) * v.height,
  );
}

function boundsToCss(v, canvas, bounds) {
  const a = v.convertToViewportPoint(bounds[0], bounds[1]);
  const b = v.convertToViewportPoint(bounds[2], bounds[3]);
  const sx = canvas.clientWidth / v.width, sy = canvas.clientHeight / v.height;
  const x0 = Math.min(a[0], b[0]) * sx, x1 = Math.max(a[0], b[0]) * sx;
  const y0 = Math.min(a[1], b[1]) * sy, y1 = Math.max(a[1], b[1]) * sy;
  return { left: x0, top: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

function insideQuad(corners, pt) {
  let hit = false;
  for (let i = 0, j = corners.length - 1; i < corners.length; j = i++) {
    const [xi, yi] = corners[i], [xj, yj] = corners[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

async function onPointerDown(e) {
  if (!active || busy || e.button !== 0) return;
  if (e.target.closest('.img-edit-ui')) return;
  const page = e.target.closest('.page');
  if (!page) { clearSelection(); return; }
  const i = Number(page.dataset.i);
  const canvas = page.querySelector('canvas.pdf');
  if (!Number.isFinite(i) || !canvas) { clearSelection(); return; }
  e.preventDefault();
  try {
    const v = await viewportFor(i);
    if (!v) return;
    const pt = toPdf(v, canvas, e.clientX, e.clientY);
    const list = await ensureImages(i);
    if (!pt) return;
    const hit = list.find((im) => insideQuad(im.corners, pt));
    if (!hit) { clearSelection(); return; }
    pageIndex = i;
    target = hit;
    vp = v;
    drawSelection();
  } catch (err) {
    toast(String(err?.message || err), 'err', 6500);
  }
}

async function ensureImages(i) {
  const doc = activeDoc();
  const key = `${doc?.id || ''}|${i}|${doc?.bytes?.length || 0}`;
  if (key === cacheKey && listPage === i) return images;
  busy = true;
  document.body.classList.add('img-edit-busy');
  try {
    images = await listNativeImages(i);
    listPage = i;
    cacheKey = key;
    return images;
  } finally {
    busy = false;
    document.body.classList.remove('img-edit-busy');
  }
}

async function refreshViewport() {
  if (!target || pageIndex < 0) return;
  try {
    vp = await viewportFor(pageIndex);
    drawSelection();
  } catch { /* page changed under us */ }
}

function drawSelection() {
  const page = pageFor(pageIndex);
  const canvas = page?.querySelector('canvas.pdf');
  if (!page || !canvas || !target || !vp) return;
  removeUi();
  const rect = boundsToCss(vp, canvas, target.bounds);
  const box = document.createElement('div');
  box.className = 'img-edit-ui img-edit-box';
  box.style.left = rect.left + 'px';
  box.style.top = rect.top + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';
  box.title = `${target.name} — drag to move`;
  for (const corner of ['nw', 'ne', 'se', 'sw']) {
    const handle = document.createElement('div');
    handle.className = `img-edit-ui img-handle img-handle-${corner}`;
    handle.dataset.corner = corner;
    handle.addEventListener('pointerdown', (e) => startResize(e, corner));
    box.appendChild(handle);
  }
  box.addEventListener('pointerdown', startMove);
  page.appendChild(box);

  const bar = buildToolbar();
  bar.style.left = Math.max(0, rect.left) + 'px';
  bar.style.top = (rect.top > 38 ? rect.top - 32 : rect.top + rect.height + 6) + 'px';
  page.appendChild(bar);

  ui = { page, box, bar, canvas };
}

function buildToolbar() {
  const bar = document.createElement('div');
  bar.className = 'img-edit-ui img-toolbar';
  const button = (label, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', fn);
    bar.appendChild(b);
    return b;
  };
  button('↺', 'Rotate left 90°', () => apply({ rotation: -90 }));
  button('↻', 'Rotate right 90°', () => apply({ rotation: 90 }));
  button('⇋', 'Flip horizontally', () => apply({ flipX: true }));
  button('⇵', 'Flip vertically', () => apply({ flipY: true }));
  const opacity = document.createElement('select');
  opacity.title = 'Opacity';
  for (const v of [100, 75, 50, 25]) {
    const o = document.createElement('option');
    o.value = String(v);
    o.textContent = `${v}%`;
    opacity.appendChild(o);
  }
  opacity.addEventListener('change', () => apply({ opacity: Number(opacity.value) / 100 }));
  bar.appendChild(opacity);
  button('Replace', 'Replace this image file', replaceImage);
  button('Delete', 'Remove this image from the page', () => apply({ delete: true }));
  return bar;
}

function setBoxBounds(bounds) {
  if (!ui?.box || !ui.canvas || !vp) return;
  const rect = boundsToCss(vp, ui.canvas, bounds);
  ui.box.style.left = rect.left + 'px';
  ui.box.style.top = rect.top + 'px';
  ui.box.style.width = rect.width + 'px';
  ui.box.style.height = rect.height + 'px';
  if (ui.bar) ui.bar.style.display = 'none';
}

async function startMove(e) {
  if (e.button !== 0 || busy || !ui) return;
  e.preventDefault();
  e.stopPropagation();
  const { canvas, box } = ui;
  let v = vp;
  try { v = v || await viewportFor(pageIndex); } catch { return; }
  if (!v) return;
  vp = v;
  const start = toPdf(v, canvas, e.clientX, e.clientY);
  if (!start) return;
  const b0 = target.bounds.slice();
  try { box.setPointerCapture(e.pointerId); } catch { /* not critical */ }
  const onMove = (ev) => {
    const p = toPdf(v, canvas, ev.clientX, ev.clientY);
    if (!p) return;
    const dx = p[0] - start[0], dy = p[1] - start[1];
    setBoxBounds([b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy]);
  };
  const finish = async (ev) => {
    box.removeEventListener('pointermove', onMove);
    box.removeEventListener('pointerup', finish);
    box.removeEventListener('pointercancel', finish);
    const p = toPdf(v, canvas, ev.clientX, ev.clientY);
    if (!p) return drawSelection();
    const dx = p[0] - start[0], dy = p[1] - start[1];
    if (Math.hypot(dx, dy) < 0.5) drawSelection();
    else await apply({ dx, dy });
  };
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', finish);
  box.addEventListener('pointercancel', finish);
}

async function startResize(e, corner) {
  if (e.button !== 0 || busy || !ui) return;
  e.preventDefault();
  e.stopPropagation();
  const { canvas, box } = ui;
  let v = vp;
  try { v = v || await viewportFor(pageIndex); } catch { return; }
  if (!v) return;
  vp = v;
  const b0 = target.bounds.slice();
  let next = null;
  try { box.setPointerCapture(e.pointerId); } catch { /* not critical */ }
  const onMove = (ev) => {
    const p = toPdf(v, canvas, ev.clientX, ev.clientY);
    if (!p) return;
    next = resizedBounds(b0, corner, p);
    setBoxBounds(next);
  };
  const finish = async () => {
    box.removeEventListener('pointermove', onMove);
    box.removeEventListener('pointerup', finish);
    box.removeEventListener('pointercancel', finish);
    if (!next) return drawSelection();
    const change = resizeChange(b0, next, target.matrix);
    if (!change) return drawSelection();
    await apply(change);
  };
  box.addEventListener('pointermove', onMove);
  box.addEventListener('pointerup', finish);
  box.addEventListener('pointercancel', finish);
}

function resizedBounds(b, corner, p) {
  let [x0, y0, x1, y1] = b;
  if (corner.includes('w')) x0 = Math.min(p[0], x1 - MIN_SIZE);
  else x1 = Math.max(p[0], x0 + MIN_SIZE);
  if (corner.includes('s')) y0 = Math.min(p[1], y1 - MIN_SIZE);
  else y1 = Math.max(p[1], y0 + MIN_SIZE);
  return [x0, y0, x1, y1];
}

function resizeChange(b0, b1, matrix) {
  const w0 = Math.max(1e-6, b0[2] - b0[0]), h0 = Math.max(1e-6, b0[3] - b0[1]);
  const scaleX = Math.max(1e-3, (b1[2] - b1[0]) / w0);
  const scaleY = Math.max(1e-3, (b1[3] - b1[1]) / h0);
  // The core scales about the image centre. For an axis-aligned placement we
  // can keep the opposite corner pinned by moving the centre by half the size
  // delta; a rotated placement falls back to centre scaling.
  if (Math.abs(matrix[1]) > 1e-6 || Math.abs(matrix[2]) > 1e-6) return { scaleX, scaleY };
  return {
    scaleX, scaleY,
    dx: (b1[0] + b1[2] - b0[0] - b0[2]) / 2,
    dy: (b1[1] + b1[3] - b0[1] - b0[3]) / 2,
  };
}

function replaceImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg';
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_REPLACE) { toast('Replacement image must be under 8 MB', 'warn'); return; }
    const type = file.type === 'image/png' || /\.png$/i.test(file.name) ? 'png' : 'jpeg';
    await apply({ replacementBytes: new Uint8Array(await file.arrayBuffer()), replacementType: type });
  });
  input.click();
}

async function apply(change) {
  if (!target || busy) return;
  const pi = pageIndex;
  const sel = target;
  busy = true;
  document.body.classList.add('img-edit-busy');
  try {
    const result = await commitNativeImageEdit(pi, sel, change);
    dropCache();
    if (!result.ok) {
      toast(result.error || 'Image edit failed', 'err', 6500);
      return;
    }
    if (change.delete) { clearSelection(); toast('Image removed', 'ok'); return; }
    target = result.image;
    pageIndex = pi;
    vp = await viewportFor(pi);
    drawSelection();
  } catch (err) {
    toast(String(err?.message || err), 'err', 6500);
  } finally {
    busy = false;
    document.body.classList.remove('img-edit-busy');
  }
}