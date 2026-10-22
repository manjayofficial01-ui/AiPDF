import { activeDoc, pushHistory, emit, pushStructUndo, canUndoStructure, canRedoStructure } from './store.js';
import { loadPdfBytes, buildPages, relayout, applyLayoutToDom, scrollToPage, renderVisible } from './viewer.js';
import { loadFileAnnotations, loadAttachments } from './annots.js';
import { buildPdf, buildExtract, buildMerge } from './pdfwrite.js';
import { openNativeImagePage, applyNativeImageEdit, applyNativeAreaLayer, closeNativeImageSession } from './image-pdf-browser.mjs';
import { toast, el } from './util.js';
import { showModal, formRow } from './dialog.js';
import { loadFormFields, renderFormFields } from './forms.js';

function ensureOps(doc) {
  if (!doc.pageOps) {
    doc.pageOps = { items: Array.from({ length: doc.numPages }, (_, i) => ({ t: 'src', i })) };
  }
  return doc.pageOps.items;
}

/**
 * Replace the document with an already-built byte stream and rebuild every
 * derived index (annotations, fields, page sizes, DOM). This is the single
 * place a structural change becomes user-visible, so it is also the natural
 * seam for undoing one. */
export async function reloadDocFromBytes(doc, bytes, message = null) {
  const pdf = await loadPdfBytes(bytes.slice(0));
  try { doc.pdf.destroy(); } catch { /* ignore */ }
  doc.bytes = bytes;
  doc.pdf = pdf;
  doc.numPages = pdf.numPages;
  doc.pageOps = null;
  doc.textEdits = [];
  doc.stamps = [];
  doc.newFields = [];
  doc.pageRotate = {};
  // Crops are baked into the file as CropBoxes by buildPdf, so the model must
  // not carry stale crop state across a reload — otherwise structural undo
  // "remembers" a crop whose bytes are already gone.
  doc.crops = {};
  // A structural save can add layers (Area Direct Edit does). The panel's
  // cached optional-content config would otherwise hide the new group.
  doc.ocgConfig = null;
  doc.ocgConfigPromise = null;
  doc.pageSizes = new Array(pdf.numPages);
  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const vp = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
    doc.pageSizes[i] = { w: vp.width, h: vp.height };
  }
  await loadFileAnnotations();
  await loadAttachments();
  await loadFormFields(doc);
  await buildPages(pdf);
  applyLayoutToDom();
  relayout(true);
  renderVisible();
  for (let i = 0; i < pdf.numPages; i++) renderFormFields(i);
  doc.history = [];
  doc.hIndex = -1;
  pushHistory(message || 'structured');
  emit('structure');
  emit('annots');
  if (message) toast(message, 'ok');
}

/**
 * Structural changes are committed by rebuilding the file and reloading it.
 * Annotations survive because they are written into the PDF first. The
 * pre-change bytes are pushed onto the structural-undo stack so Ctrl+Z can
 * walk the document back an operation at a time. */
async function commitStructure(doc, { toastMsg } = {}) {
  const before = doc.bytes;
  const bytes = await buildPdf(doc, {});
  await reloadDocFromBytes(doc, bytes, null);
  pushStructUndo(before);
  if (toastMsg) toast(toastMsg, 'ok');
}

/* ── Native objects on a page ─────────────────────────────────────────────── */

/** Resolve the same object across revisions. IDs are session-scoped, so a
 *  fresh session after a commit must find the object by kind and name
 *  first, then by nearest centre (the same image can be drawn more than
 *  once, and a group keeps its name). */
function pickObject(objects, target) {
  const cx = (target.bounds[0] + target.bounds[2]) / 2;
  const cy = (target.bounds[1] + target.bounds[3]) / 2;
  let best = null, bestScore = Infinity;
  for (const o of objects) {
    if (o.singular) continue;
    if (target.kind && o.kind !== target.kind) continue;
    const b = o.bounds;
    const d = Math.hypot((b[0] + b[2]) / 2 - cx, (b[1] + b[3]) / 2 - cy);
    const score = d + (o.name === target.name ? 0 : 10000);
    if (score < bestScore) { best = o; bestScore = score; }
  }
  return best;
}

/** Every object drawn on the exported bytes of one page — placed images,
 *  inline images and Form XObject groups — so hit-testing sees exactly what
 *  a save would contain (pending edits included). */
export async function listNativeObjects(pageIndex) {
  const doc = activeDoc();
  if (!doc) return [];
  const bytes = await buildPdf(doc, {});
  const session = await openNativeImagePage(bytes, pageIndex);
  try { return session.objects.filter((o) => !o.singular); }
  finally { closeNativeImageSession(session); }
}

/** Apply one edit to an object and commit it through the same rebuild +
 *  structural-undo path as every other document structure change. */
export async function commitNativeObjectEdit(pageIndex, target, change) {
  const doc = activeDoc();
  if (!doc) return { ok: false, error: 'No document open' };
  const before = doc.bytes;
  let bytes, session;
  try { bytes = await buildPdf(doc, {}); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
  try { session = await openNativeImagePage(bytes, pageIndex); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
  try {
    const ob = pickObject(session.objects, target);
    if (!ob) return { ok: false, error: 'That object can no longer be edited on this page' };
    const candidate = await applyNativeImageEdit(session, ob.id, change);
    await reloadDocFromBytes(doc, candidate, null);
    pushStructUndo(before);
    let next = null;
    if (!change.delete) {
      const after = await openNativeImagePage(candidate, pageIndex);
      try {
        const ob2 = pickObject(after.objects, { kind: ob.kind, name: ob.name, bounds: ob.bounds });
        if (ob2) next = ob2;
      } finally { closeNativeImageSession(after); }
    }
    return { ok: true, object: next };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    closeNativeImageSession(session);
  }
}

/** Lift the selected area of a placed image into a real PDF layer. The
 *  adapter extracts the pixels (as a PNG), registers an optional-content
 *  group, and cuts a matching hole in the source placement so the layer can
 *  actually be shown and hidden. Committed through the same rebuild + undo
 *  path as every other object edit. */
export async function commitNativeAreaLayer(pageIndex, target, { area, pngBytes, layerBase } = {}) {
  const doc = activeDoc();
  if (!doc) return { ok: false, error: 'No document open' };
  const before = doc.bytes;
  let bytes, session;
  try { bytes = await buildPdf(doc, {}); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
  try { session = await openNativeImagePage(bytes, pageIndex); }
  catch (e) { return { ok: false, error: String(e?.message || e) }; }
  try {
    const result = await applyNativeAreaLayer(session, target.id, { area, pngBytes, layerBase });
    await reloadDocFromBytes(doc, result.bytes, null);
    pushStructUndo(before);
    const after = await openNativeImagePage(result.bytes, pageIndex);
    let next = null;
    try { next = after.objects.find((o) => o.name === result.image.name && !o.clipped) || null; }
    finally { closeNativeImageSession(after); }
    return { ok: true, object: next, layer: result.layer, image: result.image };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  } finally {
    closeNativeImageSession(session);
  }
}

export async function undoStructure() {
  const doc = activeDoc();
  if (!doc || !canUndoStructure()) return false;
  const prev = doc.structUndoStack.pop();
  doc.structRedoStack = (doc.structRedoStack || []).concat([doc.bytes]).slice(-12);
  await reloadDocFromBytes(doc, prev, 'Structure undone');
  return true;
}

export async function redoStructure() {
  const doc = activeDoc();
  if (!doc || !canRedoStructure()) return false;
  const next = doc.structRedoStack.pop();
  doc.structUndoStack = (doc.structUndoStack || []).concat([doc.bytes]).slice(-12);
  await reloadDocFromBytes(doc, next, 'Structure redone');
  return true;
}

export async function deletePages(indices) {
  const doc = activeDoc();
  if (!doc) return;
  const items = ensureOps(doc);
  const kill = new Set(indices);
  doc.pageOps.items = items.filter((it) => !(it.t === 'src' && kill.has(it.i)));
  if (!doc.pageOps.items.length) {
    toast('Cannot delete every page.', 'err');
    doc.pageOps.items = items;
    return;
  }
  await commitStructure(doc, { toastMsg: `Deleted ${indices.length} page(s)` });
}

export async function rotatePages(indices, delta) {
  const doc = activeDoc();
  if (!doc) return;
  for (const i of indices) {
    doc.pageRotate[i] = ((doc.pageRotate[i] || 0) + delta + 360) % 360;
  }
  pushHistory('rotate');
  const keep = doc.currentPage ?? 0;
  relayout(true);
  renderVisible();
  scrollToPage(keep, { smooth: false });
  emit('annots');
}

export async function insertBlankAt(index) {
  const doc = activeDoc();
  if (!doc) return;
  const items = ensureOps(doc);
  items.splice(index, 0, { t: 'blank', w: 595.28, h: 841.89 });
  await commitStructure(doc, { toastMsg: 'Blank page inserted' });
  scrollToPage(index);
}

export async function insertFromPdfAt(index) {
  const doc = activeDoc();
  if (!doc) return;
  const paths = await window.api.openDialog({ title: 'Choose a PDF to insert' });
  if (!paths || !paths[0]) return;
  const r = await window.api.readFile(paths[0]);
  if (!r.ok) return toast('Could not read that file.', 'err');
  const pages = await choosePagesDialog(r.data, paths[0]);
  if (!pages) return;
  const items = ensureOps(doc);
  items.splice(index, 0, { t: 'file', bytes: r.data, pages });
  await commitStructure(doc, { toastMsg: 'Pages inserted' });
  scrollToPage(index);
}

async function choosePagesDialog(bytes, path) {
  const pdf = await loadPdfBytes(bytes);
  const n = pdf.numPages;
  let mode = 'all';
  let range = `1-${n}`;
  const ok = await showModal({
    title: 'Insert pages',
    width: 'narrow',
    body: (b) => {
      b.appendChild(el('div', { class: 'hint', text: `${path.split(/[\\/]/).pop()} — ${n} page(s)` }));
      const sel = el('select', {});
      sel.append(
        el('option', { value: 'all', text: 'All pages' }),
        el('option', { value: 'range', text: 'Custom range' }),
      );
      const rangeInput = el('input', { type: 'text', value: range, style: { display: 'none' } });
      b.appendChild(formRow('Pages', el('div', { class: 'fr-c' }, [sel, rangeInput])).row);
      b.appendChild(el('div', { class: 'hint', text: 'Ranges look like 1-3,5,8-10' }));
      sel.onchange = () => { mode = sel.value; rangeInput.style.display = mode === 'range' ? '' : 'none'; };
      rangeInput.oninput = () => { range = rangeInput.value; };
    },
  });
  try { pdf.destroy(); } catch { /* ignore */ }
  if (!ok) return null;
  if (mode === 'all') return Array.from({ length: n }, (_, i) => i);
  const set = new Set();
  for (const part of range.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= n) set.add(i - 1);
  }
  return Array.from(set).sort((a, b) => a - b);
}

export async function extractPages(indices) {
  const doc = activeDoc();
  if (!doc) return;
  const bytes = await buildExtract(doc, indices.slice().sort((a, b) => a - b));
  const name = (doc.name || 'document').replace(/\.pdf$/i, '') + '-extract.pdf';
  const path = await window.api.saveDialog({ defaultPath: name });
  if (!path) return;
  const res = await window.api.writeFile(path, bytes);
  if (res.ok) toast(`Extracted ${indices.length} page(s) to ${path.split(/[\\/]/).pop()}`, 'ok');
  else toast('Save failed: ' + res.error, 'err');
}

export async function mergeDocuments() {
  const doc = activeDoc();
  if (!doc) return;
  const paths = await window.api.openDialog({ multiSelections: true, title: 'Choose PDFs to merge' });
  if (!paths || !paths.length) return;
  const lists = [];
  try {
    const cur = await buildPdf(doc, {});
    lists.push(cur);
  } catch {
    lists.push(doc.bytes);
  }
  for (const p of paths) {
    const r = await window.api.readFile(p);
    if (r.ok) lists.push(r.data);
  }
  const merged = await buildMerge(lists);
  const path = await window.api.saveDialog({ defaultPath: 'merged.pdf' });
  if (!path) return;
  const res = await window.api.writeFile(path, merged);
  if (res.ok) toast(`Merged ${lists.length} documents`, 'ok');
  else toast('Save failed: ' + res.error, 'err');
}

export async function splitDocument() {
  const doc = activeDoc();
  if (!doc) return;
  let mode = 'every';
  let every = 1;
  let ranges = '';
  const ok = await showModal({
    title: 'Split document',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {});
      sel.append(
        el('option', { value: 'every', text: 'Every N pages' }),
        el('option', { value: 'ranges', text: 'Custom ranges' }),
      );
      const n = el('input', { type: 'number', value: '1', min: '1', style: { width: '66px' } });
      const r = el('input', { type: 'text', placeholder: '1-3,4-9', style: { display: 'none' } });
      b.appendChild(formRow('Split by', el('div', { class: 'fr-c' }, [sel, n, r])).row);
      b.appendChild(el('div', { class: 'hint', text: `Document has ${doc.numPages} pages. Each part is saved as a separate file.` }));
      sel.onchange = () => { mode = sel.value; n.style.display = mode === 'every' ? '' : 'none'; r.style.display = mode === 'ranges' ? '' : 'none'; };
      n.oninput = () => { every = Number(n.value) || 1; };
      r.oninput = () => { ranges = r.value; };
    },
  });
  if (!ok) return;
  const parts = [];
  if (mode === 'every') {
    for (let s = 0; s < doc.numPages; s += every) {
      parts.push(Array.from({ length: Math.min(every, doc.numPages - s) }, (_, k) => s + k));
    }
  } else {
    for (const part of ranges.split(';')) {
      const set = [];
      for (const p of part.split(',')) {
        const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(p);
        if (!m) continue;
        const a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) if (i >= 1 && i <= doc.numPages) set.push(i - 1);
      }
      if (set.length) parts.push(set);
    }
  }
  if (!parts.length) return toast('Nothing to split.', 'warn');
  const dir = await window.api.openDialog({ title: 'Choose a folder for the parts (pick any file inside it)' });
  if (!dir || !dir[0]) return;
  const base = dir[0].replace(/[^\\/]+$/, '');
  const stem = (doc.name || 'document').replace(/\.pdf$/i, '');
  let n = 0;
  for (const part of parts) {
    const bytes = await buildExtract(doc, part);
    const p = `${base}${stem}-part${String(++n).padStart(2, '0')}.pdf`;
    const res = await window.api.writeFile(p, bytes);
    if (!res.ok) { toast('Split failed: ' + res.error, 'err'); return; }
  }
  toast(`Split into ${parts.length} file(s)`, 'ok');
}

export async function reorderPages(fromIndex, toIndex) {
  const doc = activeDoc();
  if (!doc) return;
  const items = ensureOps(doc);
  const moved = items.splice(fromIndex, 1)[0];
  items.splice(toIndex, 0, moved);
  await commitStructure(doc, { toastMsg: 'Pages reordered' });
}

/* ── Foxit Organize: duplicate / replace / reverse / crop ────────────────── */

export async function duplicatePages(indices) {
  const doc = activeDoc();
  if (!doc || !indices.length) return;
  const items = ensureOps(doc);
  const copies = indices.map((i) => ({ ...(items[i] || {}) }));
  items.splice(Math.max(...indices) + 1, 0, ...copies);
  await commitStructure(doc, { toastMsg: `Duplicated ${indices.length} page(s)` });
}

export async function reversePages() {
  const doc = activeDoc();
  if (!doc || doc.numPages < 2) return;
  const items = ensureOps(doc);
  items.reverse();
  await commitStructure(doc, { toastMsg: 'Page order reversed' });
}

/** Replace one page (or a run) in this document with pages from another file. */
export async function replacePageAt(index) {
  const doc = activeDoc();
  if (!doc) return;
  const paths = await window.api.openDialog({ title: 'Choose a PDF to take the replacement pages from' });
  if (!paths || !paths[0]) return;
  const r = await window.api.readFile(paths[0]);
  if (!r.ok) return toast('Could not read that file.', 'err');
  const pages = await choosePagesDialog(r.data, paths[0]);
  if (!pages || !pages.length) return;
  const items = ensureOps(doc);
  items.splice(index, 1, ...[]);           // drop the target page
  items.splice(index, 0, { t: 'file', bytes: r.data, pages });
  await commitStructure(doc, { toastMsg: `Page ${index + 1} replaced` });
}

/** Crop: the rectangle is kept, everything outside is hidden via the page's
 *  CropBox. Applied immediately by rebuilding the file so the view, thumbnails
 *  and saved output all agree. */
export async function cropPages(indices, rect) {
  const doc = activeDoc();
  if (!doc || !indices.length) return;
  doc.crops = doc.crops || {};
  for (const i of indices) doc.crops[i] = rect.slice();
  await commitStructure(doc, { toastMsg: `Cropped ${indices.length} page(s)` });
}

/** Split by top-level outline entries — Foxit's "split by bookmark". */
export async function splitByBookmarks() {
  const doc = activeDoc();
  if (!doc) return 0;
  const outline = doc.outline || [];
  const tops = outline.filter((o) => !o.dest && typeof o.page === 'number');
  // Fall back to every entry that carries a page number at level 0.
  const marks = outline.filter((o) => (o.level === 0 || o.depth === 0) && typeof o.page === 'number');
  const cuts = (marks.length ? marks : tops).map((o) => o.page).sort((a, b) => a - b);
  if (cuts.length < 2) {
    toast('This document has no top-level bookmarks to split on.', 'warn');
    return 0;
  }
  const parts = [];
  for (let k = 0; k < cuts.length; k++) {
    const from = cuts[k];
    const to = k + 1 < cuts.length ? cuts[k + 1] : doc.numPages;
    if (to > from) parts.push(Array.from({ length: to - from }, (_, j) => from + j));
  }
  return writeSplitParts(doc, parts);
}

/** Split into a file per run of non-blank pages separated by blank pages. */
export async function splitByBlankPages() {
  const doc = activeDoc();
  if (!doc) return 0;
  const parts = [];
  let run = [];
  for (let i = 0; i < doc.numPages; i++) {
    if (isBlankPage(doc, i)) {
      if (run.length) { parts.push(run); run = []; }
    } else run.push(i);
  }
  if (run.length) parts.push(run);
  if (parts.length < 2) { toast('No blank page breaks found to split on.', 'warn'); return 0; }
  return writeSplitParts(doc, parts);
}

/** A page counts as blank when it has no text and no non-trivial drawing ops. */
function isBlankPage(doc, i) {
  const o = doc.textSparse || null;
  if (o && o[i] === false) return false;
  const hasText = doc.pageHasText && doc.pageHasText[i];
  if (hasText === false) return true;
  return false;
}

async function writeSplitParts(doc, parts) {
  const dir = await window.api.openDialog({ title: 'Choose a folder for the parts (pick any file inside it)' });
  if (!dir || !dir[0]) return 0;
  const base = dir[0].replace(/[^\\/]+$/, '');
  const stem = (doc.name || 'document').replace(/\.pdf$/i, '');
  let n = 0;
  for (const part of parts) {
    const bytes = await buildExtract(doc, part);
    const p = `${base}${stem}-part${String(++n).padStart(2, '0')}.pdf`;
    const res = await window.api.writeFile(p, bytes);
    if (!res.ok) { toast('Split failed: ' + res.error, 'err'); return 0; }
  }
  toast(`Split into ${parts.length} file(s)`, 'ok');
  return parts.length;
}
