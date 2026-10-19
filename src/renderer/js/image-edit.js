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
let cropMode = false;
let cropRect = null;
let cropEl = null;
let cropBar = null;
// Visible rect of placements already cropped in this session. The adapter
// reports the full image footprint (the clip is in the content stream), so
// remember the kept section to draw and hit-test the real visible area.
const cropVisible = new Map();

function cropKey(i, name) {
  const doc = activeDoc();
  return `${doc?.id || ''}|${i}|${name}`;
}

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
    if (!active) return;
    if (e.key === 'Escape' && cropMode) {
      e.preventDefault();
      e.stopPropagation();
      cancelCrop();
      return;
    }
    if (e.key === 'Escape' && target) {
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
  cancelCrop();
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
  if (cropMode) {
    if (e.target.closest('.img-toolbar')) return;
    const page = e.target.closest('.page');
    if (!page || Number(page.dataset.i) !== pageIndex) return;
    e.preventDefault();
    e.stopPropagation();
    beginCropDrag(e, page);
    return;
  }
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
    let hit = list.find((im) => insideQuad(im.corners, pt));
    if (!hit) { clearSelection(); return; }
    const key = cropKey(i, hit.name);
    if (!hit.clipped) cropVisible.delete(key);
    else if (cropVisible.has(key)) hit = { ...hit, bounds: cropVisible.get(key).slice() };
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
  if (cropMode) cancelCrop();
  removeUi();
  const rect = boundsToCss(vp, canvas, target.bounds);
  const readOnly = !!target.clipped;
  const box = document.createElement('div');
  box.className = `img-edit-ui img-edit-box${readOnly ? ' img-readonly' : ''}`;
  box.style.left = rect.left + 'px';
  box.style.top = rect.top + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';
  box.title = readOnly
    ? `${target.name} — cropped section (delete, or undo to restore)`
    : `${target.name} — drag to move`;
  if (!readOnly) {
    for (const corner of ['nw', 'ne', 'se', 'sw']) {
      const handle = document.createElement('div');
      handle.className = `img-edit-ui img-handle img-handle-${corner}`;
      handle.dataset.corner = corner;
      handle.addEventListener('pointerdown', (e) => startResize(e, corner));
      box.appendChild(handle);
    }
    box.addEventListener('pointerdown', startMove);
  }
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
  if (target?.clipped) {
    const note = document.createElement('span');
    note.className = 'img-crop-note';
    note.textContent = 'Cropped';
    bar.appendChild(note);
    button('Delete', 'Remove this image from the page', () => apply({ delete: true }));
    return bar;
  }
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
  button('Crop', 'Keep only a section of this image', startCrop);
  button('Replace', 'Replace this image file', replaceImage);
  button('Delete', 'Remove this image from the page', () => apply({ delete: true }));
  return bar;
}

/* ── Crop: keep one section of the placement ─────────────────────────────
 *  The adapter clips the Do invocation to the chosen normalized rectangle,
 *  so the kept section stays where it was drawn and everything outside it is
 *  hidden. A clipped placement refuses further native edits, so the UI marks
 *  it read-only afterwards (undo restores the uncropped image). */
function startCrop() {
  if (!target || busy) return;
  if (target.clipped) { toast('This image is already cropped — undo to change the section.', 'warn'); return; }
  if (Math.abs(target.matrix[1]) > 1e-6 || Math.abs(target.matrix[2]) > 1e-6) {
    toast('Cropping a rotated image is not supported yet — undo the rotation first.', 'warn', 6000);
    return;
  }
  cropMode = true;
  cropRect = null;
  if (ui) {
    if (ui.bar) ui.bar.style.display = 'none';
    ui.box.classList.add('img-crop-armed');
  }
  document.body.classList.add('img-crop-mode');
  toast('Drag over the section of the image to keep.', 'info', 3600);
}

function exitCrop() {
  cropMode = false;
  cropRect = null;
  document.body.classList.remove('img-crop-mode');
  cropEl?.remove(); cropEl = null;
  cropBar?.remove(); cropBar = null;
}

function cancelCrop() {
  const wasCropping = cropMode;
  exitCrop();
  if (wasCropping && ui) {
    ui.box?.classList.remove('img-crop-armed');
    if (ui.bar) ui.bar.style.display = '';
  }
}

async function beginCropDrag(e, page) {
  const canvas = page.querySelector('canvas.pdf');
  let v = vp;
  try { v = v || await viewportFor(pageIndex); } catch { return; }
  if (!v) return;
  vp = v;
  const start = toPdf(v, canvas, e.clientX, e.clientY);
  if (!start) return;
  cropEl?.remove();
  cropEl = document.createElement('div');
  cropEl.className = 'img-edit-ui img-crop-rect';
  page.appendChild(cropEl);
  const onMove = (ev) => {
    const p = toPdf(v, canvas, ev.clientX, ev.clientY);
    if (!p) return;
    cropRect = [
      Math.min(start[0], p[0]), Math.min(start[1], p[1]),
      Math.max(start[0], p[0]), Math.max(start[1], p[1]),
    ];
    positionCrop();
  };
  const finish = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    if (!cropRect || cropRect[2] - cropRect[0] < 3 || cropRect[3] - cropRect[1] < 3) return cancelCrop();
    showCropBar(page);
  };
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

function positionCrop() {
  const page = pageFor(pageIndex);
  const canvas = page?.querySelector('canvas.pdf');
  if (!cropEl || !canvas || !vp || !cropRect) return;
  const r = boundsToCss(vp, canvas, cropRect);
  cropEl.style.left = r.left + 'px';
  cropEl.style.top = r.top + 'px';
  cropEl.style.width = r.width + 'px';
  cropEl.style.height = r.height + 'px';
}

function showCropBar(page) {
  cropBar?.remove();
  const bar = document.createElement('div');
  bar.className = 'img-edit-ui img-toolbar img-crop-bar';
  const ok = document.createElement('button');
  ok.type = 'button'; ok.textContent = 'Apply crop'; ok.title = 'Keep only this section';
  ok.addEventListener('click', applyCrop);
  const no = document.createElement('button');
  no.type = 'button'; no.textContent = 'Cancel'; no.title = 'Cancel cropping';
  no.addEventListener('click', cancelCrop);
  bar.append(ok, no);
  const canvas = page.querySelector('canvas.pdf');
  if (canvas && vp && cropRect) {
    const r = boundsToCss(vp, canvas, cropRect);
    bar.style.left = Math.max(0, r.left) + 'px';
    bar.style.top = (r.top > 38 ? r.top - 32 : r.top + r.height + 6) + 'px';
  }
  page.appendChild(bar);
  cropBar = bar;
}

async function applyCrop() {
  if (!cropRect || !target || busy) return;
  const m = target.matrix;
  if (Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6 || !m[0] || !m[3]) {
    toast('Cropping a rotated image is not supported yet.', 'warn', 6000);
    return cancelCrop();
  }
  const nx0 = (Math.min(cropRect[0], cropRect[2]) - m[4]) / m[0];
  const nx1 = (Math.max(cropRect[0], cropRect[2]) - m[4]) / m[0];
  const ny0 = (Math.min(cropRect[1], cropRect[3]) - m[5]) / m[3];
  const ny1 = (Math.max(cropRect[1], cropRect[3]) - m[5]) / m[3];
  const l = clamp01(Math.min(nx0, nx1)), r = clamp01(Math.max(nx0, nx1));
  const b = clamp01(Math.min(ny0, ny1)), t = clamp01(Math.max(ny0, ny1));
  if (r - l < 0.01 || t - b < 0.01) { toast('Select a larger section.', 'warn'); return; }
  const visibleBounds = [
    Math.max(target.bounds[0], Math.min(cropRect[0], cropRect[2])),
    Math.max(target.bounds[1], Math.min(cropRect[1], cropRect[3])),
    Math.min(target.bounds[2], Math.max(cropRect[0], cropRect[2])),
    Math.min(target.bounds[3], Math.max(cropRect[1], cropRect[3])),
  ];
  exitCrop();
  await apply({ crop: [l, b, r, t] }, { visibleBounds });
}

function clamp01(n) { return Math.max(0, Math.min(1, n)); }

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

async function apply(change, opts = {}) {
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
    if (change.crop) {
      if (result.image) {
        const bounds = (opts.visibleBounds || result.image.bounds).slice();
        target = { ...result.image, bounds };
        pageIndex = pi;
        vp = await viewportFor(pi);
        cropVisible.set(cropKey(pi, target.name), bounds.slice());
        drawSelection();
      } else {
        clearSelection();
      }
      toast('Section kept. This placement is now cropped — undo to restore the full image.', 'ok', 7000);
      return;
    }
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