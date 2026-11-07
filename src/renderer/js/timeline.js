/**
 * timeline.js — local, multi-version document history.
 *
 * AiPDF previously kept exactly one `.pdf.bak` per file: one save erased the
 * only recovery point. This replaces that with a bounded, offline version
 * timeline stored in IndexedDB (no cloud, no account, no extra files beside
 * the document). Every save records a version; the user can also name a
 * checkpoint before a risky edit. Any version can be restored or exported.
 *
 * Nothing here can overwrite the file on disk — restore swaps the bytes of the
 * OPEN document, and the user still has to Save. Deliberate, so a mis-click is
 * never a destructive act.
 */

import { activeDoc, settings } from './store.js';
import { el, toast, uid } from './util.js';
import { svgIcon } from './icons.js';
import { showModal, confirmDialog, promptDialog } from './dialog.js';
import { reloadDocFromBytes } from './pages.js';
import { logAudit } from './assurance.js';

const DB_NAME = 'aipdf-timeline';
const DB_VERSION = 1;
const STORE = 'snapshots';
const MAX_PER_DOC = 30;
const MAX_BYTES = 160 * 1024 * 1024;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('docKey', 'docKey', { unique: false });
        store.createIndex('at', 'at', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'));
  });
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    try { result = fn(store); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error || new Error('Timeline transaction failed'));
    t.onabort = () => reject(t.error || new Error('Timeline transaction aborted'));
  }));
}

export function docKey(doc) {
  return doc && (doc.path || `unsaved:${doc.id}`) || 'unknown';
}

/** List snapshots for a document, newest first. */
export async function listSnapshots(doc = activeDoc()) {
  if (!doc) return [];
  try {
    const all = await tx('readonly', (s) => s.index('docKey').getAll(docKey(doc)));
    return (all || []).sort((a, b) => b.at - a.at);
  } catch { return []; }
}

async function totalBytes() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).reduce((n, r) => n + (r.size || 0), 0);
  } catch { return 0; }
}

async function prune(key) {
  const rows = (await listSnapshotsForKey(key)).slice(MAX_PER_DOC);
  for (const r of rows) {
    try { await tx('readwrite', (s) => s.delete(r.id)); } catch { /* ignore */ }
  }
  if (await totalBytes() > MAX_BYTES) {
    const all = await tx('readonly', (s) => s.getAll());
    const ordered = (all || []).sort((a, b) => a.at - b.at);
    for (const r of ordered.slice(0, Math.ceil(ordered.length / 3))) {
      try { await tx('readwrite', (s) => s.delete(r.id)); } catch { /* ignore */ }
    }
  }
}

async function listSnapshotsForKey(key) {
  try {
    const all = await tx('readonly', (s) => s.index('docKey').getAll(key));
    return (all || []).sort((a, b) => b.at - a.at);
  } catch { return []; }
}

/**
 * Record a version. Called from saveDoc / saveDocAs and by manual checkpoints.
 * Fire-and-forget by design: a history failure must never block a save.
 */
/** Exact byte comparison for consecutive-snapshot de-duplication. */
function sameBytes(a, b) {
  const x = a instanceof Uint8Array ? a : new Uint8Array(a || []);
  const y = b instanceof Uint8Array ? b : new Uint8Array(b || []);
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

export async function recordSnapshot(doc, bytes, label = 'Saved', kind = 'auto') {
  if (!doc || !bytes || !bytes.length) return null;
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // Store a copy — the caller may reuse or mutate its buffer after the write.
  const copy = data.slice();
  // Re-opening the same file (or saving with no changes) must not pile up
  // identical automatic versions until the 30-slot cap is nothing but
  // duplicates. Named checkpoints are explicit user actions and always kept.
  if (kind === 'auto') {
    const prev = (await listSnapshotsForKey(docKey(doc)))[0];
    if (prev && prev.kind === 'auto' && prev.size === copy.byteLength && sameBytes(prev.bytes, copy)) {
      return prev;
    }
  }
  const rec = {
    id: uid('v'),
    docKey: docKey(doc),
    name: doc.name || 'Untitled.pdf',
    at: Date.now(),
    label: String(label).slice(0, 80),
    kind,
    size: copy.byteLength,
    pages: doc.numPages || 0,
    bytes: copy,
  };
  try {
    await tx('readwrite', (s) => s.put(rec));
    await prune(rec.docKey);
    logAudit(kind === 'auto' ? 'version-save' : 'checkpoint', `${rec.name} · ${label} · ${(rec.size / 1024).toFixed(0)} KB`);
    window.dispatchEvent(new CustomEvent('aipdf:timeline', { detail: { id: rec.id } }));
    return rec;
  } catch (e) {
    console.warn('[timeline] snapshot skipped:', e.message);
    return null;
  }
}

/** Convenience hook used from app.js after a successful save. */
export function snapshotOnSave(doc, bytes) {
  if (!settings.timelineEnabled) return;
  recordSnapshot(doc, bytes, 'Saved', 'auto').catch(() => {});
}

/* Baseline snapshots: one per opened FILE, so the first Save never leaves the
 * timeline with only the post-edit version. Unsaved/blank documents are skipped
 * (their key changes every time and they have no on-disk history to protect). */
const opened = new Set();

export function snapshotOnOpen(doc) {
  if (!settings.timelineEnabled || !doc || !doc.path || !doc.bytes) return;
  if (opened.has(doc.id)) return;
  opened.add(doc.id);
  recordSnapshot(doc, doc.bytes, 'Opened', 'auto').catch(() => {});
}

/** Manual named checkpoint of the CURRENT working state (may be unsaved). */
export async function createCheckpoint() {
  const doc = activeDoc();
  if (!doc) return toast('Open a PDF first.', 'warn');
  const label = await promptDialog('Name this checkpoint so you can find it later.', `Before editing · ${new Date().toLocaleTimeString()}`, { title: 'New checkpoint', okLabel: 'Save checkpoint' });
  if (label === null || label === undefined) return;
  try {
    const { buildDocBytes } = await import('./app.js');
    const bytes = await buildDocBytes(doc);
    const rec = await recordSnapshot(doc, bytes, String(label).trim() || 'Checkpoint', 'manual');
    toast(rec ? 'Checkpoint saved to the local timeline' : 'Could not save checkpoint', rec ? 'ok' : 'err');
    if (rec) openTimeline();
  } catch (e) {
    toast('Checkpoint failed: ' + e.message, 'err');
  }
}

export async function deleteSnapshot(id) {
  try { await tx('readwrite', (s) => s.delete(id)); return true; }
  catch { return false; }
}

export async function restoreSnapshot(id) {
  const rows = await tx('readonly', (s) => s.getAll());
  const rec = (rows || []).find((r) => r.id === id);
  if (!rec) return toast('That version is no longer available.', 'warn');
  const ok = await confirmDialog(
    `Restore “${rec.label}” (${new Date(rec.at).toLocaleString()}, ${(rec.size / 1024).toFixed(0)} KB)?\n\nThis replaces the OPEN document in the editor. The file on disk is not touched until you Save, so you can still close without saving to back out.`,
    { title: 'Restore version', okLabel: 'Restore into editor' });
  if (!ok) return;
  const doc = activeDoc();
  if (!doc) return toast('Open a PDF first.', 'warn');
  try {
    const bytes = rec.bytes instanceof Uint8Array ? rec.bytes.slice() : new Uint8Array(rec.bytes);
    await reloadDocFromBytes(doc, bytes, `Restored version: ${rec.label}`);
    logAudit('restore', `${doc.name} · ${rec.label}`);
  } catch (e) {
    toast('Restore failed: ' + e.message, 'err', 6000);
  }
}

function downloadSnapshot(rec) {
  try {
    const bytes = rec.bytes instanceof Uint8Array ? rec.bytes : new Uint8Array(rec.bytes);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = rec.name.replace(/\.pdf$/i, '') + `-${new Date(rec.at).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Version exported', 'ok');
  } catch (e) { toast('Export failed: ' + e.message, 'err'); }
}

function ago(t) {
  const d = Math.max(0, Date.now() - t);
  if (d < 60e3) return 'just now';
  if (d < 3600e3) return `${Math.floor(d / 60e3)} min ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)} h ago`;
  return `${Math.floor(d / 86400e3)} d ago`;
}

function versionRow(rec, refresh) {
  const row = el('div', { class: `tl-row ${rec.kind}` }, [
    el('div', { class: 'tl-dot' }),
    el('div', { class: 'tl-main' }, [
      el('strong', { text: rec.label }),
      el('span', { class: 'tl-meta', text: `${new Date(rec.at).toLocaleString()} · ${ago(rec.at)} · ${(rec.size / 1024).toFixed(0)} KB · ${rec.pages || '?'} pages` }),
    ]),
    el('span', { class: `tl-kind ${rec.kind}`, text: rec.kind === 'manual' ? 'Checkpoint' : 'Auto' }),
  ]);
  const btns = el('div', { class: 'tl-btns' });
  const restore = el('button', { class: 'mini-btn', text: 'Restore', title: 'Load this version into the editor' });
  restore.onclick = () => restoreSnapshot(rec.id);
  const exp = el('button', { class: 'mini-btn', text: 'Export', title: 'Download this version as a PDF' });
  exp.onclick = () => downloadSnapshot(rec);
  const del = el('button', { class: 'mini-btn', text: 'Delete', title: 'Remove this version' });
  del.onclick = async () => {
    if (await confirmDialog(`Delete “${rec.label}” from the local timeline?`, { title: 'Delete version', okLabel: 'Delete', danger: true })) {
      await deleteSnapshot(rec.id);
      toast('Version deleted', 'info');
      refresh();
    }
  };
  btns.append(restore, exp, del);
  row.appendChild(btns);
  return row;
}

/** Build the shared timeline body into `host`. */
async function drawTimeline(host, doc) {
  host.innerHTML = '';
  if (!doc) {
    host.appendChild(el('div', { class: 'asr-empty', text: 'Open a PDF to see its version timeline.' }));
    return;
  }
  const rows = await listSnapshots(doc);
  const head = el('div', { class: 'tl-head' }, [
    el('div', {}, [
      el('h3', { text: doc.name }),
      el('p', { text: `${rows.length} local version${rows.length === 1 ? '' : 's'} · stored on this device only · newest first` }),
    ]),
  ]);
  const add = el('button', { class: 'primary', html: svgIcon('plus', 15) + '<span>New checkpoint</span>' });
  add.onclick = () => createCheckpoint();
  head.appendChild(add);
  host.appendChild(head);

  if (!rows.length) {
    host.appendChild(el('div', { class: 'tl-empty' }, [
      el('div', { class: 'tl-empty-ic', html: svgIcon('clock', 24) }),
      el('strong', { text: 'No versions yet' }),
      el('span', { text: 'A version is recorded automatically each time you Save, or you can create a named checkpoint now.' }),
    ]));
    return;
  }
  const list = el('div', { class: 'tl-list' });
  host.appendChild(list);
  const refresh = async () => {
    const next = await listSnapshots(doc);
    list.innerHTML = '';
    next.forEach((r) => list.appendChild(versionRow(r, refresh)));
    head.querySelector('p').textContent = `${next.length} local version${next.length === 1 ? '' : 's'} · stored on this device only · newest first`;
  };
  rows.forEach((r) => list.appendChild(versionRow(r, refresh)));
  host.appendChild(el('div', { class: 'tl-foot', text: 'Restoring loads bytes into the editor only. Nothing is written to disk until you Save.' }));
}

/** Sidebar variant — used by the rail panel registry. */
export function renderTimelinePanel(body, tools) {
  body.innerHTML = ''; tools.innerHTML = '';
  const add = el('button', { class: 'mini-btn', text: '+ Checkpoint' });
  add.onclick = () => createCheckpoint();
  tools.appendChild(add);
  const host = el('div', { class: 'tl compact' });
  body.appendChild(host);
  drawTimeline(host, activeDoc()).catch(() => {
    host.appendChild(el('div', { class: 'asr-empty', text: 'Timeline unavailable in this profile.' }));
  });
}

/** Modal entry point (draw before showing, so content is present on open). */
export async function openTimeline() {
  const host = el('div', { class: 'tl' });
  await drawTimeline(host, activeDoc());
  await showModal({
    title: 'Version Timeline — local history', width: 'wide',
    body: (b) => { b.appendChild(host); },
    buttons: [{ label: 'Done', value: true, kind: 'primary', default: true }],
  });
}
