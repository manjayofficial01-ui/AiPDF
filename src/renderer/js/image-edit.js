/** Edit Object tool: pick an object that is already drawn on the page and
 *  move, resize, rotate, flip, fade, crop, replace or delete it.
 *
 *  Objects are found by READING the page — its content stream and the
 *  resources that stream names — not by looking at a rendered picture. That
 *  is why a page which looks flat still yields its separate objects, and why
 *  a logo drawn inside a Form XObject is still one selectable object.
 *
 *  Three gestures share one press: a drag that encloses an object picks that
 *  object whole; a drag INSIDE an image selects only the image content in the
 *  box (Area Direct Edit) with white margins trimmed away; a press that never
 *  moves stays an ordinary click, which picks the TOP-MOST object under the
 *  pointer (the one painted last is the one the reader sees). Every mutation
 *  goes through the native content-stream adapter and the structural-undo
 *  reload path (see pages.js), so a save contains exactly what the preview
 *  showed.
 *
 *  What this tool deliberately does NOT do: invent structure. A page that is
 *  one bitmap has one object in it; the picture inside that bitmap is not an
 *  object, and the tool says so instead of pretending otherwise.
 */
import { state, settings, activeDoc, on } from './store.js';
import { listNativeObjects, commitNativeObjectEdit, commitNativeAreaLayer } from './pages.js';
import { toast } from './util.js';

const MIN_SIZE = 4;          // PDF points
const MAX_REPLACE = 8 * 1024 * 1024;
const MAX_LAYER_PNG = 8 * 1024 * 1024;
const WHITE_CUTOFF = 244;    // any channel below this is content, not paper
const ENCLOSE_COVERAGE = 0.9; // a marquee covering this much of an object picks it whole
const AREA_MIN = 2;          // PDF points — below this a "content" hit is a speck

let active = false;
let busy = false;
let pageIndex = -1;
let target = null;           // { id, kind, name, bounds, corners, matrix, … }
let vp = null;               // { page, box, bar, canvas }
let ui = null;
let objects = [];
let cacheKey = '';
let listPage = -1;
let cropMode = false;
let cropRect = null;
let cropEl = null;
let cropBar = null;
// Live bounds of an in-flight move/resize. A re-render can replace the
// selection box mid-gesture — a large page re-lays out while you drag — so the
// gesture, not the DOM, has to own the position it is showing.
let dragBounds = null;
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
    else hintOnce();   // the gesture changed: say what the drag does
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

function dropCache() { objects = []; cacheKey = ''; listPage = -1; }

// Shown the first time the tool is armed in a session: the marquee is only
// discoverable if the app says so.
let hinted = false;
function hintOnce() {
  if (hinted) return;
  hinted = true;
  toast('Edit object: click an object or box it to select all of it; drag inside an image to select just that area (white margins are ignored). Alt+click picks the object underneath.', 'info', 8000);
}

function clearSelection() {
  cancelCrop();
  target = null;
  vp = null;
  pageIndex = -1;
  dragBounds = null;
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

/* ── What a page actually holds ────────────────────────────────────────────
 *  The difference matters: an image that IS in the file can be moved, and a
 *  picture that is only PIXELS inside one bitmap cannot. Saying so is more
 *  useful than a silent selection that behaves like something else. */

/** One object covering (almost) the whole page is the page itself. */
function isFullPage(o, v) {
  if (!o || !v) return false;
  const pw = v.width, ph = v.height;
  if (!pw || !ph) return false;
  const b = o.bounds;
  const area = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const covers = b[0] <= pw * 0.02 && b[1] <= ph * 0.02 && b[2] >= pw * 0.98 && b[3] >= ph * 0.98;
  return area >= pw * ph * 0.95 || covers;
}

/** A plain-language name for the selected object. */
function labelOf(o) {
  if (!o) return 'object';
  if (o.kind === 'form') return o.children > 1 ? `group ${o.name} (${o.children} objects)` : `group ${o.name}`;
  if (o.kind === 'inline') return 'inline image';
  return `image ${o.name}`;
}

/** What the page holds, in plain words — so a miss is explained rather than
 *  silent. A page that is one full-page bitmap is named by the selection
 *  itself (see the "Page image" note), because such a page is never a miss. */
function describePage(list) {
  if (!list.length) return 'This page has no image objects — it holds text and vector content only.';
  return '';
}

/* ── Marquee pick: detect the object inside the dragged rectangle ───────────
 *  Hit-testing uses the real placement quad, not its bounding box, so a
 *  rotated image is only picked where it actually is. Overlap is measured as
 *  a fraction of the SMALLER of the two areas, which is what "the object
 *  inside the marquee" means in practice: a tight marquee round a small logo
 *  wins over a background photo it barely touches. A marquee INSIDE one big
 *  image does not select the image; it becomes Area Direct Edit.
 */
const PICK_DRAG_MIN = 6;       // screen px before a press becomes a marquee
const PICK_MIN_SCORE = 0.05;   // below this the marquee only grazed something

function polyArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  }
  return Math.abs(s / 2);
}

/** Sutherland–Hodgman: clip the (convex) placement quad by an axis-aligned
 *  rectangle and return the intersection polygon, so its area is exact. */
function clipQuadToRect(corners, rect) {
  const [x0, y0, x1, y1] = rect;
  const cut = (poly, inside, at) => {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ia = inside(a), ib = inside(b);
      if (ia) out.push(a);
      if (ia !== ib) {
        const p = at(a, b);
        if (p) out.push(p);
      }
    }
    return out;
  };
  const vertical = (x) => (a, b) => {
    const d = b[0] - a[0];
    if (!d) return null;
    const t = (x - a[0]) / d;
    const y = a[1] + t * (b[1] - a[1]);
    return Number.isFinite(y) ? [x, y] : null;
  };
  const horizontal = (y) => (a, b) => {
    const d = b[1] - a[1];
    if (!d) return null;
    const t = (y - a[1]) / d;
    const x = a[0] + t * (b[0] - a[0]);
    return Number.isFinite(x) ? [x, y] : null;
  };
  let poly = corners.map((p) => p.slice());
  poly = cut(poly, (p) => p[0] >= x0, vertical(x0));
  poly = cut(poly, (p) => p[0] <= x1, vertical(x1));
  poly = cut(poly, (p) => p[1] >= y0, horizontal(y0));
  poly = cut(poly, (p) => p[1] <= y1, horizontal(y1));
  return poly;
}

/** Corners to hit-test: a placement cropped in this session is only pickable
 *  over the section that is still visible, not the full image footprint. */
function hitQuad(i, o) {
  if (o.kind === 'form' || !o.clipped) return o.corners;
  const visible = cropVisible.get(cropKey(i, o.name));
  if (!visible) return o.corners;
  return [
    [visible[0], visible[1]], [visible[2], visible[1]],
    [visible[2], visible[3]], [visible[0], visible[3]],
  ];
}

/** The part of an object that is actually visible: a section cropped earlier
 *  in this session keeps its real visible rect, not the full image footprint. */
function visibleBoundsOf(i, o) {
  if (o.kind !== 'form' && o.clipped && cropVisible.has(cropKey(i, o.name))) {
    return cropVisible.get(cropKey(i, o.name));
  }
  return o.bounds;
}

/** Render one page into a detached canvas at `density` pixels per PDF point.
 *  The viewer's own canvas is never touched; the result is rotation-aware and
 *  capped so a huge page cannot exhaust memory. */
async function renderPageRegion(i, density) {
  const doc = activeDoc();
  if (!doc?.pdf) return null;
  const page = await doc.pdf.getPage(i + 1);
  const rotation = (page.rotate || 0) + (doc.pageRotate?.[i] || 0) + state.view.rotation;
  const base = page.getViewport({ scale: 1, rotation });
  const wanted = Math.max(0.2, Math.min(8, density));
  const fit = Math.min(1, 4096 / Math.max(1, base.width * wanted, base.height * wanted));
  const v = page.getViewport({ scale: wanted * fit, rotation });
  const cw = Math.max(1, Math.ceil(v.width));
  const ch = Math.max(1, Math.ceil(v.height));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = ch;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cw, ch);
  await page.render({
    canvasContext: ctx, viewport: v,
    optionalContentConfigPromise: doc.ocgConfigPromise || undefined,
  }).promise;
  return { page, v, ctx, cw, ch };
}

/**
 * Tight bounds of real ink inside `area` (PDF points), read from a fresh page
 * render so the result does not depend on the current zoom or the device pixel
 * ratio. White — page paper and the white margin inside a scan — is not
 * content, so a box dragged over blank paper has no area at all.
 *
 * This is what makes Area Direct Edit mean "only the image in this box":
 * the selection hugs the picture and leaves the whitespace behind.
 */
async function contentBounds(i, area) {
  const shot = await renderPageRegion(i, 3);
  if (!shot) return null;
  const { v, ctx, cw, ch } = shot;

  const corners = [
    [area[0], area[1]], [area[2], area[1]],
    [area[2], area[3]], [area[0], area[3]],
  ].map(([x, y]) => v.convertToViewportPoint(x, y));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const px0 = clamp(Math.floor(Math.min(...corners.map((p) => p[0]))), 0, cw - 1);
  const px1 = clamp(Math.ceil(Math.max(...corners.map((p) => p[0]))), px0 + 1, cw);
  const py0 = clamp(Math.floor(Math.min(...corners.map((p) => p[1]))), 0, ch - 1);
  const py1 = clamp(Math.ceil(Math.max(...corners.map((p) => p[1]))), py0 + 1, ch);
  const w = px1 - px0, h = py1 - py0;
  const data = ctx.getImageData(px0, py0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o] < WHITE_CUTOFF || data[o + 1] < WHITE_CUTOFF || data[o + 2] < WHITE_CUTOFF) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  // One source pixel of breathing room, so anti-aliased edges are not shaved.
  const a = v.convertToPdfPoint(px0 + Math.max(0, minX - 1), py0 + Math.max(0, minY - 1));
  const b = v.convertToPdfPoint(px0 + Math.min(w, maxX + 2), py0 + Math.min(h, maxY + 2));
  return [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]),
    Math.max(a[0], b[0]), Math.max(a[1], b[1]),
  ];
}

/** Area Direct Edit: the target is the image content inside the marquee, not
 *  the whole placement. `areaOf` keeps the original object so "Whole image"
 *  can step back to ordinary object selection. */
function selectArea(i, o, bounds, v) {
  pageIndex = i;
  target = { ...o, area: true, areaOf: o, bounds: bounds.slice() };
  vp = v;
  drawSelection();
}

function selectTarget(i, o, v) {
  const key = cropKey(i, o.name);
  // A placement that is no longer clipped must stop using a stale visible rect.
  if (o.kind !== 'form' && !o.clipped) cropVisible.delete(key);
  const chosen = o.kind !== 'form' && o.clipped && cropVisible.has(key)
    ? { ...o, bounds: cropVisible.get(key).slice() }
    : o;
  pageIndex = i;
  target = chosen;
  vp = v;
  drawSelection();
}

/**
 * A click picks the TOP-MOST object under the pointer: the PDF paints later
 * objects over earlier ones, so the last one drawn is the one the reader
 * actually sees. Picking the bottom-most one is the classic "why did it
 * select the background" bug.
 *
 * Alt+click steps DOWN through the objects stacked under the pointer, so a
 * logo drawn inside a Form XObject can still be reached as the whole group.
 */
function pickAtPoint(i, v, pt, list, cycle = false) {
  const hits = [];
  for (const o of list) {
    if (insideQuad(hitQuad(i, o), pt)) hits.push(o);
  }
  if (!hits.length) {
    clearSelection();
    const note = describePage(list);
    if (note) toast(note, 'info', 5200);
    return;
  }
  hits.sort((a, b) => b.order - a.order);          // topmost first
  let chosen = hits[0];
  if (cycle && target && pageIndex === i) {
    const at = hits.findIndex((o) => o.id === target.id);
    if (at >= 0) chosen = hits[(at + 1) % hits.length];
  }
  chosen = { ...chosen, underneath: Math.max(0, hits.length - 1) };
  selectTarget(i, chosen, v);
}

async function pickInRect(i, v, rect, list) {
  const marqueeArea = Math.max(1e-6, (rect[2] - rect[0]) * (rect[3] - rect[1]));
  let best = null, bestScore = 0, bestOverlap = 0, bestOrder = -1, found = 0;
  let enclosed = null, enclosedOverlap = 0;
  for (const o of list) {
    const quad = hitQuad(i, o);
    const overlap = polyArea(clipQuadToRect(quad, rect));
    if (overlap <= 1e-6) continue;
    found++;
    const objectArea = Math.max(1e-6, polyArea(quad));
    // Boxing an object almost completely still means "this object", not
    // "a piece of it" — that is the gesture people already know.
    if (!o.clipped && overlap / objectArea >= ENCLOSE_COVERAGE
      && (!enclosed || overlap > enclosedOverlap || (overlap === enclosedOverlap && o.order > enclosed.order))) {
      enclosed = o;
      enclosedOverlap = overlap;
    }
    const score = overlap / Math.max(1e-6, Math.min(objectArea, marqueeArea));
    const better = score > bestScore + 1e-6
      || (Math.abs(score - bestScore) <= 1e-6 && overlap > bestOverlap + 1e-6)
      || (Math.abs(score - bestScore) <= 1e-6 && Math.abs(overlap - bestOverlap) <= 1e-6 && o.order > bestOrder);
    if (better) { best = o; bestScore = score; bestOverlap = overlap; bestOrder = o.order; }
  }
  if (enclosed) {
    selectTarget(i, enclosed, v);
    if (found > 1) toast(`${found} objects in that area — selected the best match; click one to be certain.`, 'info', 4200);
    return;
  }
  if (!best || bestScore < PICK_MIN_SCORE) {
    clearSelection();
    // A marquee is a deliberate gesture, so answer it. Many pages (text-only
    // PDFs) have no editable object at all and silence would look like the
    // tool is broken.
    const note = describePage(list);
    toast(note || (list.length ? 'No object in that area.' : 'This page has no editable object.'), 'info', 4200);
    return;
  }
  // A group or an already-cropped placement cannot be edited by area; fall
  // back to selecting the whole thing rather than pretending otherwise.
  if (best.kind === 'form' || best.clipped) {
    selectTarget(i, best, v);
    if (found > 1) toast(`${found} objects in that area — selected the best match; click one to be certain.`, 'info', 4200);
    return;
  }

  const visible = visibleBoundsOf(i, best);
  const box = [
    Math.max(rect[0], visible[0]), Math.max(rect[1], visible[1]),
    Math.min(rect[2], visible[2]), Math.min(rect[3], visible[3]),
  ];
  let content = null;
  busy = true;
  document.body.classList.add('img-edit-busy');
  try {
    content = await contentBounds(i, box);
  } catch {
    clearSelection();
    toast('Could not measure the image content in that area — try a different box.', 'err', 5000);
    return;
  } finally {
    busy = false;
    document.body.classList.remove('img-edit-busy');
  }
  if (!content) {
    clearSelection();
    toast('No image content in that area — white background is not selected.', 'info', 5000);
    return;
  }
  const area = [
    Math.max(box[0], content[0]), Math.max(box[1], content[1]),
    Math.min(box[2], content[2]), Math.min(box[3], content[3]),
  ];
  if (area[2] - area[0] < AREA_MIN || area[3] - area[1] < AREA_MIN) {
    clearSelection();
    toast('No image content in that area — white background is not selected.', 'info', 5000);
    return;
  }
  selectArea(i, best, area, v);
  if (found > 1) toast(`${found} objects in that area — selected the best match; click one to be certain.`, 'info', 4200);
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
  if (e.target.closest('.img-toolbar')) return;
  // The selection box sits on top of the object it marks, so an ordinary
  // press there belongs to the box (it starts a move). Alt+press is a
  // request to pick the object UNDERNEATH, so it falls through to the pick.
  if (e.target.closest('.img-edit-ui') && !e.altKey) return;
  const page = e.target.closest('.page');
  if (!page) { clearSelection(); return; }
  const i = Number(page.dataset.i);
  const canvas = page.querySelector('canvas.pdf');
  if (!Number.isFinite(i) || !canvas) { clearSelection(); return; }
  e.preventDefault();
  try {
    // Register pointerup synchronously before the await below, so a fast
    // release (CDP sends mouseReleased just 40ms after mousePressed) cannot
    // arrive while we are paused on viewportFor() and be missed forever.
    let alreadyUp = false;
    const onUp = () => { alreadyUp = true; };
    // Listen for both pointerup and mouseup. CDP's mouseReleased always
    // dispatches mouseup; pointerup is synthesized from it but may be missed
    // in some Electron/Chromium versions. Registering synchronously before the
    // await below guarantees a fast release (40ms after mousePressed) cannot
    // arrive while we are paused on viewportFor() and be missed forever.
    document.addEventListener('pointerup', onUp, true);
    document.addEventListener('mouseup', onUp, true);
    document.addEventListener('pointercancel', onUp, true);
    const v = await viewportFor(i);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
    if (!v) return;
    const start = toPdf(v, canvas, e.clientX, e.clientY);
    if (!start) return;
    beginPickDrag(e, i, canvas, v, start, alreadyUp);
  } catch (err) {
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('mouseup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
    toast(String(err?.message || err), 'err', 6500);
  }
}

/**
 * One press serves both gestures. It starts as a possible marquee, and only
 * crosses over to a marquee once the pointer has actually moved; a press that
 * never moves is resolved as a click, so the older "click the image to select
 * it" gesture keeps working unchanged.
 */
async function beginPickDrag(e, i, canvas, v, start, alreadyUp = false) {
  const origin = { x: e.clientX, y: e.clientY };
  const cycle = !!e.altKey;

  // The pointer was already released before we could listen for it: this is a
  // plain click, not the start of a drag. Pick the object under the pointer.
  if (alreadyUp) {
    try {
      const list = await ensureObjects(i);
      pickAtPoint(i, v, start, list, cycle);
    } catch (err) {
      toast(String(err?.message || err), 'err', 6500);
    }
    return;
  }

  let moved = false;
  let preview = null;

  const onMove = (ev) => {
    if (!moved && Math.hypot(ev.clientX - origin.x, ev.clientY - origin.y) < PICK_DRAG_MIN) return;
    if (!moved) {
      moved = true;
      preview = document.createElement('div');
      preview.className = 'img-edit-ui img-marquee';
      preview.style.position = 'fixed';
      preview.style.zIndex = '95';
      document.body.appendChild(preview);
    }
    preview.style.left = `${Math.min(origin.x, ev.clientX)}px`;
    preview.style.top = `${Math.min(origin.y, ev.clientY)}px`;
    preview.style.width = `${Math.abs(ev.clientX - origin.x)}px`;
    preview.style.height = `${Math.abs(ev.clientY - origin.y)}px`;
  };

  const finish = async (ev) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    preview?.remove();
    try {
      const list = await ensureObjects(i);
      if (!moved) return pickAtPoint(i, v, start, list, cycle);
      const end = ev?.clientX == null ? null : toPdf(v, canvas, ev.clientX, ev.clientY);
      if (!end) return;
      await pickInRect(i, v, [
        Math.min(start[0], end[0]), Math.min(start[1], end[1]),
        Math.max(start[0], end[0]), Math.max(start[1], end[1]),
      ], list);
    } catch (err) {
      toast(String(err?.message || err), 'err', 6500);
    }
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
}

async function ensureObjects(i) {
  const doc = activeDoc();
  const key = `${doc?.id || ''}|${i}|${doc?.bytes?.length || 0}`;
  if (key === cacheKey && listPage === i) return objects;
  busy = true;
  document.body.classList.add('img-edit-busy');
  try {
    objects = await listNativeObjects(i);
    listPage = i;
    cacheKey = key;
    return objects;
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
  // While a gesture is running the box shows the dragged position, not the
  // committed one: the page may have re-rendered underneath the pointer.
  const rect = boundsToCss(vp, canvas, dragBounds || target.bounds);
  const isArea = !!target.area;
  const readOnly = isArea || (!!target.clipped && target.kind !== 'form');
  const box = document.createElement('div');
  box.className = `img-edit-ui img-edit-box${readOnly ? ' img-readonly' : ''}${isArea ? ' img-edit-area' : ''}`;
  box.style.left = rect.left + 'px';
  box.style.top = rect.top + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';
  box.title = isArea
    ? `${labelOf(target)} — Area Direct Edit: only the image inside this box is selected`
    : readOnly
      ? `${labelOf(target)} — cropped section (delete, or undo to restore)`
      : `${labelOf(target)} — ${isFullPage(target, vp) ? 'this page is one image; ' : ''}drag to move${target.underneath ? ' (Alt+click for the object underneath)' : ''}`;
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
  if (target?.area) {
    const note = document.createElement('span');
    note.className = 'img-crop-note img-area-note';
    note.textContent = 'Area Direct Edit';
    bar.appendChild(note);
    const m = target.matrix || [];
    const rotated = Math.abs(m[1] || 0) > 1e-6 || Math.abs(m[2] || 0) > 1e-6 || !m[0] || !m[3];
    const inline = target.kind === 'inline';
    const nested = Array.isArray(target.container) && target.container.length > 0;
    const layer = button('New layer', inline
      ? 'An inline image cannot be lifted into a layer'
      : nested
        ? 'An image inside a form cannot be lifted into a page layer'
        : 'Place only this area in a new PDF layer; white background is removed', placeAreaLayerAction);
    layer.disabled = inline || nested;
    const keep = button('Keep area', rotated
      ? 'A rotated image cannot be cropped yet — undo the rotation first'
      : 'Keep only the image in this area; the rest of the placement is hidden', applyAreaCrop);
    keep.disabled = rotated;
    button('Whole image', 'Select the whole image instead', () => selectTarget(
      pageIndex,
      { ...(target.areaOf || target), underneath: target.underneath },
      vp,
    ));
    button('Cancel', 'Cancel the area selection', clearSelection);
    return bar;
  }
  const isGroup = target?.kind === 'form';
  const isInline = target?.kind === 'inline';
  if (target?.clipped && !isGroup) {
    const note = document.createElement('span');
    note.className = 'img-crop-note';
    note.textContent = 'Cropped';
    bar.appendChild(note);
    button('Delete', 'Remove this image from the page', () => apply({ delete: true }));
    return bar;
  }
  if (target?.container?.length) {
    // The object lives inside a Form XObject. The form is copied before it is
    // edited, so other pages that share it are not affected.
    const note = document.createElement('span');
    note.className = 'img-crop-note';
    note.textContent = 'In form';
    bar.appendChild(note);
  } else if (isFullPage(target, vp)) {
    // The page is ONE bitmap. The picture inside it is not an object, so the
    // only thing that can be moved is the whole image.
    const note = document.createElement('span');
    note.className = 'img-crop-note';
    note.textContent = 'Page image';
    bar.appendChild(note);
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
  if (!isGroup) {
    button('Crop', 'Keep only a section of this image', startCrop);
    if (!isInline) button('Replace', 'Replace this image file', replaceImage);
  }
  button('Delete', isGroup ? 'Remove this group from the page' : 'Remove this image from the page', () => apply({ delete: true }));
  return bar;
}

/* ── Crop: keep one section of the placement ─────────────────────────────
 *  The adapter clips the Do invocation to the chosen normalized rectangle,
 *  so the kept section stays where it was drawn and everything outside it is
 *  hidden. A clipped placement refuses further native edits, so the UI marks
 *  it read-only afterwards (undo restores the uncropped image). */
function startCrop() {
  if (!target || busy) return;
  if (target.kind === 'form') { toast('A group cannot be cropped — crop the images inside it.', 'warn'); return; }
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

/**
 * Extract the selected area as a PNG with white made transparent. The render
 * density is taken from the source image's own pixels-per-point, so the new
 * layer carries the picture at the resolution it already had — not a blurry
 * screen-sized copy. Clamped for very small or very large sources.
 */
async function extractAreaPng() {
  if (!target?.area || !target.resource) throw new Error('The image resolution could not be read');
  const b = target.bounds;
  const full = target.areaOf?.bounds || b;
  const fullW = Math.max(1e-6, full[2] - full[0]);
  const fullH = Math.max(1e-6, full[3] - full[1]);
  const densityX = target.resource.width > 0 ? target.resource.width / fullW : 4;
  const densityY = target.resource.height > 0 ? target.resource.height / fullH : 4;
  const shot = await renderPageRegion(pageIndex, Math.max(0.5, Math.min(6, Math.min(densityX, densityY))));
  if (!shot) throw new Error('The page could not be rendered');
  const { v, ctx, cw, ch } = shot;

  const corners = [
    [b[0], b[1]], [b[2], b[1]],
    [b[2], b[3]], [b[0], b[3]],
  ].map(([x, y]) => v.convertToViewportPoint(x, y));
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  const px0 = clamp(Math.floor(Math.min(...corners.map((p) => p[0]))), 0, cw - 1);
  const px1 = clamp(Math.ceil(Math.max(...corners.map((p) => p[0]))), px0 + 1, cw);
  const py0 = clamp(Math.floor(Math.min(...corners.map((p) => p[1]))), 0, ch - 1);
  const py1 = clamp(Math.ceil(Math.max(...corners.map((p) => p[1]))), py0 + 1, ch);
  const w = px1 - px0, h = py1 - py0;
  if (w < 2 || h < 2) throw new Error('Select a larger area');

  const src = ctx.getImageData(px0, py0, w, h).data;
  const out = ctx.createImageData(w, h);
  const d = out.data;
  for (let p = 0; p < src.length; p += 4) {
    // Keep the sampled colour; turn paper-white pixels transparent so the new
    // layer is the picture, not a white rectangle around it.
    const white = src[p] >= WHITE_CUTOFF && src[p + 1] >= WHITE_CUTOFF && src[p + 2] >= WHITE_CUTOFF;
    d[p] = src[p];
    d[p + 1] = src[p + 1];
    d[p + 2] = src[p + 2];
    d[p + 3] = white ? 0 : 255;
  }
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  cv.getContext('2d').putImageData(out, 0, 0);
  const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The selected area could not be encoded');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length > MAX_LAYER_PNG) throw new Error('The selected area is too large to lift into a layer — select a smaller area.');
  return bytes;
}

/** Put the selected pixels in their own real PDF layer: the area is filled
 *  white under the layer, the extract is embedded with transparency, and an
 *  OCG is registered so the Layers panel (and any PDF reader) can show or
 *  hide it. */
async function placeAreaLayerAction() {
  if (!target?.area || busy) return;
  const pi = pageIndex;
  const area = target.bounds.slice();
  busy = true;
  document.body.classList.add('img-edit-busy');
  try {
    const png = await extractAreaPng();
    const result = await commitNativeAreaLayer(pi, target, { area, pngBytes: png, layerBase: 'Image area' });
    if (!result.ok) {
      toast(result.error || 'Could not create the layer', 'err', 6500);
      return;
    }
    dropCache();
    pageIndex = pi;
    vp = await viewportFor(pi);
    if (!result.object) {
      clearSelection();
      toast('The layer was created but its image could not be re-selected.', 'warn', 6000);
      return;
    }
    target = { ...result.object, underneath: 0 };
    drawSelection();
    if (result.layer) {
      toast(`Placed in new layer "${result.layer.name}" — open Layers to show or hide it.`, 'ok', 7500);
      // setSidebar toggles when the same panel is already open, so only ask
      // for Layers when it is not the visible panel.
      if (!(settings.sidebar === 'layers' && settings.sidebarOpen)) {
        try { window.__aipdfAction?.('view:layers'); } catch { /* the panel is optional */ }
      }
    }
  } catch (err) {
    toast(String(err?.message || err), 'err', 6500);
  } finally {
    busy = false;
    document.body.classList.remove('img-edit-busy');
  }
}

/** Area Direct Edit's crop path: keep exactly the selected content. It reuses
 *  the native crop path, so the kept area stays where it is and undo restores
 *  the full image. */
async function applyAreaCrop() {
  if (!target?.area || busy) return;
  const m = target.matrix;
  if (!m || Math.abs(m[1]) > 1e-6 || Math.abs(m[2]) > 1e-6 || !m[0] || !m[3]) {
    toast('Cropping a rotated image is not supported yet — undo the rotation first.', 'warn', 6000);
    return;
  }
  const rect = target.bounds;
  const nx0 = (rect[0] - m[4]) / m[0];
  const nx1 = (rect[2] - m[4]) / m[0];
  const ny0 = (rect[1] - m[5]) / m[3];
  const ny1 = (rect[3] - m[5]) / m[3];
  const l = clamp01(Math.min(nx0, nx1)), r = clamp01(Math.max(nx0, nx1));
  const b = clamp01(Math.min(ny0, ny1)), t = clamp01(Math.max(ny0, ny1));
  if (r - l < 0.01 || t - b < 0.01) { toast('Select a larger area.', 'warn'); return; }
  await apply({ crop: [l, b, r, t] }, { visibleBounds: rect.slice(), area: true });
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

/**
 * A move is tracked on the WINDOW, not on the selection box. The box is
 * rebuilt whenever the page re-renders — and a big page re-lays out while you
 * drag it — so a gesture bound to the box would lose its pointerup and the
 * object would silently stay where it was.
 */
async function startMove(e) {
  if (e.button !== 0 || busy || !ui || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  const { canvas } = ui;
  let v = vp;
  try { v = v || await viewportFor(pageIndex); } catch { return; }
  if (!v) return;
  vp = v;
  const start = toPdf(v, canvas, e.clientX, e.clientY);
  if (!start) return;
  const b0 = target.bounds.slice();
  const onMove = (ev) => {
    const p = toPdf(v, canvas, ev.clientX, ev.clientY);
    if (!p) return;
    const dx = p[0] - start[0], dy = p[1] - start[1];
    dragBounds = [b0[0] + dx, b0[1] + dy, b0[2] + dx, b0[3] + dy];
    setBoxBounds(dragBounds);
  };
  const finish = async (ev) => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', finish, true);
    const p = toPdf(v, canvas, ev.clientX, ev.clientY);
    dragBounds = null;
    if (!p) return drawSelection();
    const dx = p[0] - start[0], dy = p[1] - start[1];
    if (Math.hypot(dx, dy) < 0.5) drawSelection();
    else await apply({ dx, dy });
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
}

async function startResize(e, corner) {
  if (e.button !== 0 || busy || !ui || e.altKey) return;
  e.preventDefault();
  e.stopPropagation();
  const { canvas } = ui;
  let v = vp;
  try { v = v || await viewportFor(pageIndex); } catch { return; }
  if (!v) return;
  vp = v;
  const b0 = target.bounds.slice();
  let next = null;
  const onMove = (ev) => {
    const p = toPdf(v, canvas, ev.clientX, ev.clientY);
    if (!p) return;
    next = resizedBounds(b0, corner, p);
    dragBounds = next;
    setBoxBounds(next);
  };
  const finish = async () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', finish, true);
    window.removeEventListener('pointercancel', finish, true);
    dragBounds = null;
    if (!next) return drawSelection();
    const change = resizeChange(b0, next, target.matrix);
    if (!change) return drawSelection();
    await apply(change);
  };
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', finish, true);
  window.addEventListener('pointercancel', finish, true);
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
  // The core scales about the object centre. For an axis-aligned placement we
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
  if (target?.kind === 'inline') { toast('An inline image cannot be replaced by a file.', 'warn'); return; }
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
    const result = await commitNativeObjectEdit(pi, sel, change);
    dropCache();
    if (!result.ok) {
      toast(result.error || 'Object edit failed', 'err', 6500);
      return;
    }
    if (change.delete) { clearSelection(); toast('Object removed', 'ok'); return; }
    if (change.crop) {
      if (result.object) {
        const bounds = (opts.visibleBounds || result.object.bounds).slice();
        target = { ...result.object, bounds, underneath: sel.underneath };
        pageIndex = pi;
        vp = await viewportFor(pi);
        cropVisible.set(cropKey(pi, target.name), bounds.slice());
        drawSelection();
      } else {
        clearSelection();
      }
      toast(opts.area
        ? 'Area kept — only the selected part of the image remains. Undo restores the full image.'
        : 'Section kept. This placement is now cropped — undo to restore the full image.', 'ok', 7000);
      return;
    }
    if (!result.object) { clearSelection(); toast('That object can no longer be found on this page.', 'warn', 5000); return; }
    target = { ...result.object, underneath: sel.underneath };
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
