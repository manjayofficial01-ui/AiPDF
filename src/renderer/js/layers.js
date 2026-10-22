/* Layer (optional-content group) management — the session model.
 *
 * The saved FILE is the source of truth between sessions; doc.layers mirrors
 * the file's OCGs and extends them with layers the user created before the
 * next save. The layer NAME is the durable id: pdf.js's group ids are ref
 * strings that change between sessions, names do not.
 *
 * doc.activeLayer (a name, or null for un-layered base content) decides where
 * new annotations and Direct Editor text land — makeAnnot() reads it, and the
 * context panel lets a selection be moved to another layer.
 *
 * Rendering has two halves that must agree with this model:
 *   - page content already in the file is hidden/shown by pdf.js through
 *     doc.ocgConfigPromise (the viewer passes it to every page render);
 *   - model content (annotations) is hidden here, by layerVisible(), in
 *     annots.js renderPageAnnotations().
 */

import { activeDoc, emit } from './store.js';

/** The doc's layer list, created on first use. */
export function layersOf(doc) {
  if (!doc) return [];
  if (!Array.isArray(doc.layers)) doc.layers = [];
  return doc.layers;
}

export function findLayer(doc, name) {
  if (!name) return null;
  return layersOf(doc).find((l) => l.name === name) || null;
}

/** False only when the named layer exists and is hidden — unknown and
 *  un-layered content is always visible. */
export function layerVisible(doc, name) {
  const l = findLayer(doc, name);
  return l ? l.visible !== false : true;
}

export function activeLayerName(doc) {
  const d = doc || activeDoc();
  return (d && d.activeLayer) || null;
}

/** First free "Name", "Name 2", "Name 3" … in the doc's layer list. */
export function uniqueLayerName(doc, base) {
  const base2 = String(base || '').trim() || 'Layer';
  const used = new Set(layersOf(doc).map((l) => l.name));
  if (!used.has(base2)) return base2;
  let n = 2;
  while (used.has(base2 + ' ' + n)) n++;
  return base2 + ' ' + n;
}

export function addLayer(doc, name, { visible = true, activate = true } = {}) {
  const nm = uniqueLayerName(doc, name);
  layersOf(doc).push({ name: nm, visible });
  if (activate) doc.activeLayer = nm;
  emit('layers', doc);
  return nm;
}

/** Rename a layer and carry every piece of content that references the old
 *  name across — annotations and Direct Editor edits point at layers by
 *  name, so a rename that did not rewrite them would orphan them. */
export function renameLayer(doc, oldName, newName) {
  const l = findLayer(doc, oldName);
  if (!l) return null;
  const nm = String(newName || '').trim();
  if (!nm || (nm !== oldName && findLayer(doc, nm))) return null;
  l.name = nm;
  for (const a of doc.annots || []) if (a.layer === oldName) a.layer = nm;
  for (const e of doc.textEdits || []) if (e.layer === oldName) e.layer = nm;
  if (doc.activeLayer === oldName) doc.activeLayer = nm;
  emit('layers', doc);
  return nm;
}

/** Remove the layer. Content assigned to it stays on the page and becomes
 *  un-layered (always visible) — deleting a layer never deletes the user's
 *  work; the panel's toast says so. */
export function deleteLayer(doc, name) {
  const list = layersOf(doc);
  const idx = list.findIndex((l) => l.name === name);
  if (idx < 0) return false;
  list.splice(idx, 1);
  for (const a of doc.annots || []) if (a.layer === name) delete a.layer;
  for (const e of doc.textEdits || []) if (e.layer === name) delete e.layer;
  if (doc.activeLayer === name) doc.activeLayer = null;
  emit('layers', doc);
  return true;
}

export function setActiveLayer(doc, name) {
  doc.activeLayer = name || null;
  emit('layers', doc);
}

export function setLayerVisible(doc, name, visible) {
  const l = findLayer(doc, name);
  if (!l) return;
  l.visible = visible !== false;
  emit('layers', doc);
}

/** The pdf.js optional-content group id (a ref string like "7R") for a layer
 *  name, so page content already in the file can be toggled through
 *  cfg.setVisibility(). Returns null when the config has no such group. */
export function cfgGidByName(cfg, name) {
  if (!cfg || typeof cfg.getGroups !== 'function') return null;
  const raw = cfg.getGroups();
  const entries = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw || {});
  for (const [gid, g] of entries) if (String(g && g.name) === String(name)) return gid;
  return null;
}

/**
 * Build doc.layers from the freshly loaded document and keep session-only
 * layers (created since the last save) alive across the reload a commit
 * triggers. pdf.js's config is cached on the doc either way, so the viewer
 * renders hidden file content hidden from the first paint.
 */
export async function loadDocLayers(doc) {
  if (!doc || !doc.pdf) return;
  let entries = [];
  try {
    const cfg = await doc.pdf.getOptionalContentConfig();
    const raw = cfg && typeof cfg.getGroups === 'function' ? cfg.getGroups() : null;
    entries = raw instanceof Map ? Array.from(raw.values()) : Object.values(raw || {});
    doc.ocgConfig = cfg;
  } catch { /* no optional content support in this document */ }

  // File layers keep their names; the model disambiguates duplicates that
  // arbitrary producers may have written (the writer renames the OCG dicts
  // on the next save, so the file ends up consistent with the panel).
  const used = new Set();
  const model = [];
  for (const g of entries) {
    let nm = String(g && g.name || '').trim() || 'Layer';
    if (used.has(nm)) {
      let n = 2;
      while (used.has(nm + ' ' + n)) n++;
      nm = nm + ' ' + n;
    }
    used.add(nm);
    model.push({ name: nm, visible: (g && g.visible) !== false });
  }
  // Layers added in this session but not yet written to the file.
  for (const l of layersOf(doc)) {
    if (!model.some((m) => m.name === l.name)) model.push({ name: l.name, visible: l.visible !== false });
  }
  doc.layers = model;
  if (doc.activeLayer && !findLayer(doc, doc.activeLayer)) doc.activeLayer = null;
  // No emit here: callers (afterLoad, reloadDocFromBytes) re-render anyway,
  // and the Layers panel itself awaits this on first open — an emit would
  // re-enter the panel render.
}
