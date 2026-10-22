import { state, activeDoc, settings, saveSettings, on, emit } from './store.js';
import {
  renderThumb, thumbSize, scrollToPage, scrollToRectOnPage,
} from './viewer.js';
import { renderPageAnnotations, loadAttachments } from './annots.js';
import { svgIcon } from './icons.js';
import { $, el, escapeHtml, toast, formatBytes } from './util.js';
import { confirmDialog, showModal } from './dialog.js';
import { goToMatch } from './search.js';
import { deletePages, rotatePages, extractPages, insertBlankAt, insertFromPdfAt, reorderPages } from './pages.js';
import { OCR_LANGS, OCR_ENGINES, ocrPage, isScanned, resolveOcrEngine, ocrEngineLabel } from './ocr.js';
import { extractFontInfo, pickFontFile, registerCustomFont, setActiveNewTextFont, newTextFont, userFontRecords, removeUserFont, addSystemFont, listSystemFonts } from './fonts.js';
import { openAIDock, ask } from './ai.js';
import { rerenderAllPages } from './viewer.js';
import { signatureDialog } from './stamps.js';

let thumbObserver = null;
let selMode = false;
const selectedPages = new Set();

export function initSidebar() {
  const sideBody = $('#sideBody');
  thumbObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const i = Number(e.target.dataset.i);
      const cv = e.target.querySelector('canvas');
      if (cv && !cv.dataset.done) { cv.dataset.done = '1'; renderThumb(i, cv).catch(() => {}); }
    }
  }, { root: sideBody, rootMargin: '400px 0px' });

  $('#sideClose').onclick = () => setSidebar(null);
  on('annots', () => { if (settings.sidebar === 'comments') renderSidebar(); });
  on('page', () => { if (settings.sidebar === 'pages') updateCurrentThumb(); });
  on('dirty', () => { if (settings.sidebar === 'comments') renderSidebar(); });
}

export function setSidebar(which) {
  if (which === null) { settings.sidebarOpen = false; }
  else {
    if (settings.sidebar === which && settings.sidebarOpen) { settings.sidebarOpen = false; }
    else { settings.sidebar = which; settings.sidebarOpen = true; }
  }
  // Persisted so the panel you left open is the one you get back. loadSettings
  // restores these, but nothing ever wrote them.
  saveSettings();
  renderSidebarChrome();
  renderSidebar();
  emit('layout');
}

export function renderSidebarChrome() {
  const sidebar = $('#sidebar');
  sidebar.classList.toggle('hidden', !settings.sidebarOpen);
  document.querySelectorAll('.rail-btn').forEach((b) => {
    b.classList.toggle('active', settings.sidebarOpen && b.dataset.panel === settings.sidebar);
  });
  const titles = { pages: 'Pages', bookmarks: 'Bookmarks', comments: 'Comments', search: 'Search', forms: 'Form fields', ocr: 'OCR — scanned pages', fonts: 'Document fonts', attachments: 'Attachments', signatures: 'Signatures', layers: 'Layers' };
  $('#sideTitle').textContent = titles[settings.sidebar] || 'Panel';
}

export function renderSidebar() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  if (thumbObserver) thumbObserver.disconnect();
  body.innerHTML = '';
  tools.innerHTML = '';
  if (!doc || !settings.sidebarOpen) { renderSidebarChrome(); return; }
  renderSidebarChrome();
  ({ pages: renderThumbs, bookmarks: renderBookmarks, comments: renderComments, search: renderSearchPanel, forms: renderFormsPanel, ocr: renderOcrPanel, fonts: renderFontsPanel, attachments: renderAttachments, signatures: renderSignatures, layers: renderLayers }[settings.sidebar] || renderThumbs)();
}

function updateCurrentThumb() {
  const doc = activeDoc();
  if (!doc) return;
  document.querySelectorAll('.thumb').forEach((t) => {
    t.classList.toggle('cur', Number(t.dataset.i) === (doc.currentPage ?? 0));
  });
}

/* ── Thumbnails ─────────────────────────────────────────────────────────── */

function renderThumbs() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  const wrap = el('div', { class: 'thumbs' });

  const mkBtn = (label, title, fn, cls = '') => {
    const b = el('button', { class: `mini-btn ${cls}`, text: label, title });
    b.onclick = fn;
    return b;
  };
  tools.append(
    mkBtn('Select', 'Select pages for delete / extract / rotate', () => {
      selMode = !selMode;
      selectedPages.clear();
      renderSidebar();
    }, selMode ? 'primary' : ''),
    mkBtn('Insert', 'Insert a blank page after the current page', () => insertBlankAt((doc.currentPage ?? 0) + 1)),
    mkBtn('From PDF…', 'Insert pages from another PDF', () => insertFromPdfAt((doc.currentPage ?? 0) + 1)),
  );
  if (selMode) {
    tools.append(
      mkBtn('Rotate', 'Rotate selected pages 90°', async () => {
        if (!selectedPages.size) return toast('Select pages first', 'warn');
        await rotatePages(Array.from(selectedPages), 90);
        selMode = false; selectedPages.clear(); renderSidebar();
      }),
      mkBtn('Extract', 'Extract selected pages to a new document', async () => {
        if (!selectedPages.size) return toast('Select pages first', 'warn');
        await extractPages(Array.from(selectedPages));
        selMode = false; selectedPages.clear(); renderSidebar();
      }),
      mkBtn('Delete', 'Delete selected pages', async () => {
        if (!selectedPages.size) return toast('Select pages first', 'warn');
        const ok = await confirmDialog(`Delete ${selectedPages.size} page(s)?`, { okLabel: 'Delete', danger: true });
        if (!ok) return;
        await deletePages(Array.from(selectedPages));
        selMode = false; selectedPages.clear(); renderSidebar();
      }),
    );
  }

  for (let i = 0; i < doc.numPages; i++) {
    const { w, h } = thumbSize(i);
    const t = el('div', { class: 'thumb', dataset: { i: String(i) }, style: { width: w + 'px', height: h + 'px' }, draggable: 'true' });
    t.appendChild(el('canvas'));
    t.appendChild(el('span', { class: 'pnum', text: String(i + 1) }));
    t.appendChild(el('span', { class: 'tcheck', text: '✓' }));
    if (isScanned(doc, i)) t.appendChild(el('span', { class: 'scanbadge', title: 'No selectable text — likely scanned/flattened. Run OCR.', text: 'OCR' }));
    if (doc.ocr && doc.ocr[i]) t.appendChild(el('span', { class: 'ocrdone', title: 'OCR text available', text: 'Aa' }));
    if (selectedPages.has(i)) t.classList.add('sel');
    if (i === (doc.currentPage ?? 0)) t.classList.add('cur');
    t.onclick = (e) => {
      if (selMode || e.shiftKey || e.ctrlKey || e.metaKey) {
        if (selectedPages.has(i)) selectedPages.delete(i); else selectedPages.add(i);
        t.classList.toggle('sel', selectedPages.has(i));
        return;
      }
      scrollToPage(i);
    };
    // Drag to reorder — the same page organisation the leaders ship.
    t.addEventListener('dragstart', (e) => {
      dragThumb = i;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(i)); } catch { /* ignore */ }
    });
    t.addEventListener('dragend', () => { dragThumb = null; clearDropMarks(); });
    t.addEventListener('dragover', (e) => {
      if (dragThumb == null || dragThumb === i) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      clearDropMarks();
      const r = t.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      t.classList.add(after ? 'drop-below' : 'drop-above');
    });
    t.addEventListener('drop', async (e) => {
      if (dragThumb == null) return;
      e.preventDefault();
      const r = t.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      const from = dragThumb;
      let to = i + (after ? 1 : 0);
      if (from < to) to -= 1;
      dragThumb = null;
      clearDropMarks();
      if (to !== from) await reorderPages(from, to);
    });
    wrap.appendChild(t);
    thumbObserver.observe(t);
  }
  body.appendChild(wrap);
}

let dragThumb = null;
function clearDropMarks() {
  document.querySelectorAll('.thumb.drop-above, .thumb.drop-below').forEach((t) => t.classList.remove('drop-above', 'drop-below'));
}

/* ── Bookmarks ──────────────────────────────────────────────────────────── */

async function renderBookmarks() {
  const doc = activeDoc();
  const body = $('#sideBody');
  if (!doc.outline) {
    try { doc.outline = await doc.pdf.getOutline() || []; } catch { doc.outline = []; }
  }
  if (!doc.outline.length) {
    body.appendChild(el('div', { class: 'empty-state', html: svgIcon('bookmark', 26) + '<div>This document has no bookmarks.<br/>Bookmarks (the PDF outline) are created by the generating application.</div>' }));
    return;
  }
  const container = el('div', {});
  const build = async (items, depth = 0) => {
    const wrap = el('div', { class: depth ? 'bm-children' : '' });
    for (const item of items) {
      const row = el('div', { class: 'bm' });
      row.appendChild(el('span', { class: 'bm-arrow', html: item.items && item.items.length ? svgIcon('chevronRight', 12) : '' }));
      row.appendChild(el('span', { class: 'bmi', html: svgIcon('bookmark', 13) }));
      row.appendChild(el('span', { class: 'bmt', text: item.title || '(untitled)' }));
      const pageSpan = el('span', { class: 'bmp', text: '' });
      row.appendChild(pageSpan);
      row.onclick = async () => {
        const idx = await resolveDest(doc, item.dest);
        if (idx != null) {
          scrollToPage(idx);
          if (Array.isArray(item.dest) && item.dest.length >= 5) {
            const [, , , x, y] = item.dest.slice(0, 5);
            if (typeof x === 'number' && typeof y === 'number') {
              setTimeout(() => scrollToRectOnPage(idx, [x - 40, y - 40, x + 120, y + 40]), 60);
            }
          }
        }
      };
      wrap.appendChild(row);
      resolveDest(doc, item.dest).then((idx) => { pageSpan.textContent = idx != null ? String(idx + 1) : ''; });
      if (item.items && item.items.length) wrap.appendChild(await build(item.items, depth + 1));
    }
    return wrap;
  };
  container.appendChild(await build(doc.outline));
  body.appendChild(container);
}

const destCache = new Map();
async function resolveDest(doc, dest) {
  if (!dest) return null;
  const key = typeof dest === 'string' ? dest : JSON.stringify(dest).slice(0, 200);
  if (destCache.has(key)) return destCache.get(key);
  try {
    const explicit = typeof dest === 'string' ? await doc.pdf.getDestination(dest) : dest;
    const ref = Array.isArray(explicit) ? explicit[0] : explicit;
    const idx = await doc.pdf.getPageIndex(ref);
    destCache.set(key, idx);
    return idx;
  } catch {
    return null;
  }
}

/* ── Attachments (Foxit panel) ──────────────────────────────────────────── */

async function renderAttachments() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  body.appendChild(el('div', { class: 'empty-state', html: svgIcon('font', 26) + '<div>Loading attachments…</div>' }));
  await loadAttachments();
  if (activeDoc() !== doc) return;               // switched docs while loading
  body.innerHTML = '';
  tools.innerHTML = '';

  let selIdx = -1;
  const draw = () => {
    body.innerHTML = '';
    const list = (activeDoc()?.attachments || []);
    if (!list.length) {
      body.appendChild(el('div', {
        class: 'empty-state',
        html: svgIcon('attach', 26) + '<div>This document has no attachments.<br/>Use “Add…” to embed a file.</div>',
      }));
      return;
    }
    list.forEach((att, i) => {
      const row = el('div', { class: 'cmt', dataset: { i: String(i) } }, [
        el('div', { class: 'cmt-ic', style: { background: 'var(--accent, #4a7)' }, text: 'A' }),
        el('div', { class: 'cmt-main' }, [
          el('div', { class: 'cmt-top' }, [
            el('span', { class: 'cmt-author', text: att.filename }),
            el('span', { class: 'cmt-page', text: formatBytes(att.data.length) }),
          ]),
          el('div', { class: 'cmt-text', text: att.description || 'Embedded file' }),
        ]),
      ]);
      body.appendChild(row);
    });
  };

  const addBtn = el('button', { class: 'mini-btn', text: 'Add…' });
  addBtn.onclick = async () => {
    const d = activeDoc();
    if (!d) return;
    const paths = await window.api.openDialog({ title: 'Choose a file to attach' });
    if (!paths || !paths[0]) return;
    const r = await window.api.readFile(paths[0]);
    if (!r.ok) return toast('Could not read that file.', 'err');
    const name = paths[0].split(/[\\/]/).pop();
    if ((d.attachments || []).some((a) => a.filename === name)) {
      return toast(`“${name}” is already attached.`, 'warn');
    }
    d.attachments = (d.attachments || []).concat([{ filename: name, data: r.data, description: '' }]);
    d.dirty = true;
    emit('dirty', d);
    toast('Added — written into the file on save', 'ok');
    draw();
  };
  const saveBtn = el('button', { class: 'mini-btn', text: 'Save…' });
  saveBtn.onclick = async () => {
    const d = activeDoc();
    const att = d?.attachments?.[selIdx];
    if (!att) return toast('Select an attachment first', 'warn');
    const path = await window.api.saveDialog({
      defaultPath: att.filename,
      filters: [{ name: 'All files', extensions: ['*'] }],
    });
    if (!path) return;
    const res = await window.api.writeFile(path, att.data);
    toast(res.ok ? 'Attachment saved' : 'Save failed: ' + res.error, res.ok ? 'ok' : 'err');
  };
  const delBtn = el('button', { class: 'mini-btn', text: 'Delete' });
  delBtn.onclick = async () => {
    const d = activeDoc();
    const att = d?.attachments?.[selIdx];
    if (!att) return toast('Select an attachment first', 'warn');
    const ok = await confirmDialog(`Remove the attachment “${att.filename}”?`, { title: 'Delete attachment', danger: true });
    if (!ok) return;
    d.attachments = d.attachments.filter((_, i) => i !== selIdx);
    selIdx = -1;
    d.dirty = true;
    emit('dirty', d);
    draw();
  };
  tools.append(addBtn, saveBtn, delBtn);

  body.onclick = (e) => {
    const row = e.target.closest('.cmt');
    body.querySelectorAll('.cmt.sel').forEach((r) => r.classList.remove('sel'));
    if (!row) { selIdx = -1; return; }
    row.classList.add('sel');
    selIdx = Number(row.dataset.i);
  };
  draw();
}

/* ── Signatures (Foxit panel) ───────────────────────────────────────────── */

function renderSignatures() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  const sigFields = (doc.fields || []).filter((f) => String(f.type || '').toLowerCase() === 'signature');
  const drawn = (doc.annots || []).filter((a) => a.type === 'signature');

  const signBtn = el('button', { class: 'mini-btn', text: 'Sign…' });
  signBtn.onclick = () => signatureDialog();
  tools.append(signBtn);

  const rows = [];
  sigFields.forEach((f) => rows.push({
    title: f.name || 'Signature field',
    sub: `Form field · page ${(f.page ?? 0) + 1}`,
    page: f.page ?? 0,
    rect: f.rect,
  }));
  drawn.forEach((a) => rows.push({
    title: 'Signed image',
    sub: `Drawn signature · page ${a.page + 1}`,
    page: a.page,
    rect: a.rect,
  }));

  if (!rows.length) {
    body.appendChild(el('div', {
      class: 'empty-state',
      html: svgIcon('signature', 26) + '<div>No signatures in this document.<br/>Place a signature field in Forms mode, or press “Sign…” to draw one.</div>' + (doc.hasSignature ? '<div style="margin-top:8px;opacity:.7">This file carries a cryptographic signature; it is preserved as-is on save.</div>' : ''),
    }));
    return;
  }
  if (doc.hasSignature) {
    body.appendChild(el('div', { class: 'hint', style: { padding: '6px 8px' }, text: 'This file carries a cryptographic (PKI) signature. The signature itself is preserved as-is; AiPDF does not issue certificates.' }));
  }
  for (const r of rows) {
    const row = el('div', { class: 'cmt' }, [
      el('div', { class: 'cmt-ic', style: { background: 'var(--accent, #4a7)' }, text: 'S' }),
      el('div', { class: 'cmt-main' }, [
        el('div', { class: 'cmt-top' }, [
          el('span', { class: 'cmt-author', text: r.title }),
          el('span', { class: 'cmt-page', text: `p. ${r.page + 1}` }),
        ]),
        el('div', { class: 'cmt-text', text: r.sub }),
      ]),
    ]);
    row.onclick = () => {
      scrollToPage(r.page);
      if (r.rect) setTimeout(() => scrollToRectOnPage(r.page, r.rect), 120);
    };
    body.appendChild(row);
  }
}

/* ── Layers / optional content (Foxit panel) ────────────────────────────── */

async function renderLayers() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  body.appendChild(el('div', { class: 'empty-state', text: 'Loading layers…' }));
  let cfg = doc.ocgConfig;
  if (!cfg) {
    try { cfg = await doc.pdf.getOptionalContentConfig(); } catch { cfg = null; }
    doc.ocgConfig = cfg;
  }
  if (activeDoc() !== doc) return;
  body.innerHTML = '';
  tools.innerHTML = '';

  // pdf.js returns the groups either as a Map or a plain object keyed by the
  // group's ref string ("7R"); there is no .id on the group itself — the key
  // IS the id setVisibility() wants.
  const raw = cfg && typeof cfg.getGroups === 'function' ? cfg.getGroups() : null;
  const entries = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw || {});
  if (!entries.length) {
    body.appendChild(el('div', {
      class: 'empty-state',
      html: svgIcon('layers', 26) + '<div>This document has no layers.<br/>Layers (optional content) are created by the generating application.</div>',
    }));
    return;
  }

  const draw = () => {
    body.innerHTML = '';
    for (const [gid, g] of entries) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = g.visible !== false;
      cb.onchange = () => {
        // pdf.js exposes `visible` as a getter; setVisibility() is the only
        // supported way to change it. Assigning it threw and aborted the rest
        // of this handler (the re-render never ran).
        if (cfg.setVisibility) cfg.setVisibility(gid, cb.checked);
        // Re-render every page with the modified optional-content config.
        doc.ocgConfigPromise = Promise.resolve(cfg);
        rerenderAllPages();
      };
      const row = el('label', { class: 'layer-row', style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '5px 8px', cursor: 'pointer' } }, [
        cb,
        el('span', { text: g.name || gid }),
      ]);
      body.appendChild(row);
    }
    body.appendChild(el('div', { class: 'hint', style: { padding: '6px 8px' }, text: 'Visibility changes how pages render in AiPDF. Hidden layers reappear when you check them again.' }));
  };
  draw();
}

function renderComments() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  const list = doc.annots.slice().sort((a, b) => a.page - b.page);
  const filter = el('select', { style: { width: 'auto', height: '26px' } }, [
    el('option', { value: 'all', text: 'All comments' }),
    el('option', { value: 'note', text: 'Notes only' }),
    el('option', { value: 'markup', text: 'Highlights & text markup' }),
    el('option', { value: 'shapes', text: 'Shapes & drawings' }),
    el('option', { value: 'redact', text: 'Redactions' }),
  ]);
  const exportBtn = el('button', { class: 'mini-btn', text: 'Export…' });
  exportBtn.onclick = () => emit('comments:export');
  tools.append(filter, exportBtn);

  const box = el('div', {});
  const draw = () => {
    box.innerHTML = '';
    const f = filter.value;
    const shown = list.filter((a) => {
      if (f === 'all') return true;
      if (f === 'note') return a.type === 'note' || a.type === 'textbox' || a.type === 'callout';
      if (f === 'markup') return ['highlight', 'underline', 'strikeout', 'squiggly'].includes(a.type);
      if (f === 'shapes') return ['rect', 'ellipse', 'line', 'arrow', 'ink', 'stamp', 'image', 'signature', 'measure'].includes(a.type);
      if (f === 'redact') return a.type === 'redact';
      return true;
    });
    if (!shown.length) {
      box.appendChild(el('div', { class: 'empty-state', html: svgIcon('comments', 26) + '<div>No comments yet.<br/>Pick a tool from the Comment tab and click on the page.</div>' }));
      return;
    }
    shown.forEach((a) => {
      const iconColor = a.color || [1, 0.85, 0.2];
      const c = el('div', { class: 'cmt', dataset: { id: a.id } }, [
        el('div', {
          class: 'cmt-ic',
          style: { background: `rgb(${Math.round(iconColor[0] * 255)},${Math.round(iconColor[1] * 255)},${Math.round(iconColor[2] * 255)})` },
          text: (a.type || '?')[0].toUpperCase(),
        }),
        el('div', { class: 'cmt-main' }, [
          el('div', { class: 'cmt-top' }, [
            el('span', { class: 'cmt-author', text: a.author || 'User' }),
            el('span', { class: 'cmt-page', text: `p. ${a.page + 1}` }),
          ]),
          a.text ? el('div', { class: 'cmt-text', text: a.text }) : el('div', { class: 'cmt-text', text: `(${a.type})` }),
          a.quote ? el('div', { class: 'cmt-quote', text: a.quote }) : null,
        ]),
      ]);
      c.onclick = () => {
        state.selection = [a.id];
        scrollToPage(a.page);
        setTimeout(() => { renderPageAnnotations(a.page); emit('selection'); }, 80);
      };
      box.appendChild(c);
    });
  };
  filter.onchange = draw;
  draw();
  body.appendChild(box);
}

/* ── Search results panel ───────────────────────────────────────────────── */

function renderSearchPanel() {
  const body = $('#sideBody');
  const box = el('div', {});
  const m = state.search.matches || [];
  if (!state.search.query) {
    box.appendChild(el('div', { class: 'empty-state', html: svgIcon('search', 26) + '<div>Use Find (Ctrl+F) to search the document.</div>' }));
  } else if (!m.length) {
    box.appendChild(el('div', { class: 'empty-state', html: svgIcon('search', 26) + `<div>No results for “${escapeHtml(state.search.query)}”.</div>` }));
  } else {
    const groups = new Map();
    for (const r of m) {
      if (!groups.has(r.page)) groups.set(r.page, []);
      groups.get(r.page).push(r);
    }
    for (const [page, list] of groups) {
      const head = el('div', { class: 'sr', style: { cursor: 'default' } }, [
        el('div', { class: 'srp', text: `Page ${page + 1} — ${list.length} match${list.length > 1 ? 'es' : ''}` }),
      ]);
      box.appendChild(head);
      list.forEach((r) => {
        const before = r.context.slice(Math.max(0, r.start - 28), r.start);
        const after = r.context.slice(r.end, r.end + 42);
        const item = el('div', { class: 'sr' }, [
          el('div', { class: 'srt', html: `${escapeHtml(before)}<mark>${escapeHtml(r.match)}</mark>${escapeHtml(after)}` }),
        ]);
        item.onclick = () => { goToMatch(m.indexOf(r)); };
        box.appendChild(item);
      });
    }
  }
  body.appendChild(box);
}

/* ── Form fields panel ──────────────────────────────────────────────────── */

function renderFormsPanel() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  const exportBtn = el('button', { class: 'mini-btn', text: 'Export data…' });
  exportBtn.onclick = () => emit('forms:export');
  tools.append(exportBtn);

  if (!doc.fields || !doc.fields.length) {
    body.appendChild(el('div', { class: 'empty-state', html: svgIcon('form', 26) + '<div>This document has no interactive form fields.<br/>Use the Forms tab to add them.</div>' }));
    return;
  }
  const box = el('div', {});
  doc.fields.forEach((f) => {
    const row = el('div', { class: 'cmt' }, [
      el('div', { class: 'cmt-ic', style: { background: 'var(--accent)' }, text: (f.type || '?')[0] }),
      el('div', { class: 'cmt-main' }, [
        el('div', { class: 'cmt-top' }, [
          el('span', { class: 'cmt-author', text: f.name || '(unnamed)' }),
          el('span', { class: 'cmt-page', text: f.type || '' }),
        ]),
        el('div', { class: 'cmt-text', text: String(f.value ?? '') || '—' }),
      ]),
    ]);
    row.onclick = () => { if (f.page != null) scrollToPage(f.page); };
    box.appendChild(row);
  });
  body.appendChild(box);
}

/* ── OCR panel (scanned / flattened pages) ──────────────────────────────── */

let ocrBusy = false;

function renderOcrPanel() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  if (!doc) return;

  const langSel = el('select', { style: { width: 'auto', flex: '1', height: '26px' } });
  OCR_LANGS.forEach((l) => langSel.appendChild(el('option', { value: l.id, text: l.label })));
  const saved = settings.ocrLang || 'eng';
  if ([...langSel.options].some((o) => o.value === saved)) langSel.value = saved;
  langSel.onchange = () => { settings.ocrLang = langSel.value; };

  /* Engine picker — AI vision (Gemini / OpenAI-compatible), local Tesseract
     or the hybrid of the two. Persisted in settings.ocr.engine. */
  const engineSel = el('select', { style: { width: 'auto', flex: '1', height: '26px' }, title: 'Which OCR engine to use' });
  OCR_ENGINES.forEach((e) => engineSel.appendChild(el('option', { value: e.id, text: e.label })));
  engineSel.value = (settings.ocr && settings.ocr.engine) || 'hybrid';
  engineSel.onchange = () => {
    settings.ocr = settings.ocr || {};
    settings.ocr.engine = engineSel.value;
    saveSettings();
    renderSidebar();
  };

  let engineHint = null;
  try {
    const { engine } = resolveOcrEngine();
    engineHint = engine === 'ai'
      ? `AI engine: ${settings.ai.model || 'vision model'}`
      : 'Local Tesseract — offline, no key needed';
  } catch (e) {
    engineHint = String(e.message || e).slice(0, 120);
  }
  const engineLabel = el('span', { class: 'hint', text: engineHint, style: { flexBasis: '100%', marginTop: '2px' } });

  const aiSetupBtn = el('button', { class: 'mini-btn', text: 'AI setup…', title: 'Configure the AI provider used for AI-vision OCR and the agent' });
  aiSetupBtn.onclick = () => import('./ai.js').then((m) => m.configureAI());

  const hintInput = el('input', {
    type: 'text', placeholder: 'Language hint for AI OCR (optional), e.g. "Nepali + English"',
    style: { flexBasis: '100%', height: '26px', fontSize: '11px', marginTop: '4px' },
  });
  hintInput.value = (settings.ocr && settings.ocr.langHint) || '';
  hintInput.onchange = () => { settings.ocr = settings.ocr || {}; settings.ocr.langHint = hintInput.value; saveSettings(); };

  const runBtn = el('button', { class: 'mini-btn primary', text: 'OCR page' });
  const allBtn = el('button', { class: 'mini-btn', text: `All scanned (${(doc.scanned ? doc.scanned.size : 0)})` });
  const prog = el('div', { class: 'ocr-progress' }, [el('div', { class: 'bar' }), el('span', { class: 'lbl', text: '' })]);
  const setProg = (status, p) => {
    prog.classList.toggle('on', ocrBusy);
    prog.querySelector('.bar').style.setProperty('--p', Math.round((p || 0) * 100) + '%');
    prog.querySelector('.lbl').textContent = status || '';
  };

  runBtn.onclick = async () => {
    if (ocrBusy) return;
    ocrBusy = true;
    runBtn.disabled = allBtn.disabled = true;
    try {
      setProg('Preparing…', 0.02);
      await ocrPage(doc.currentPage ?? 0, langSel.value, (m) => setProg(`${m.status}…`, m.progress));
      toast('OCR finished — text is searchable now', 'ok');
      renderSidebar();
    } catch (e) {
      toast('OCR failed: ' + (e.message || e), 'err', 6000);
      console.error(e);
    } finally {
      ocrBusy = false;
      runBtn.disabled = allBtn.disabled = false;
      setProg('', 0);
    }
  };
  allBtn.onclick = async () => {
    if (ocrBusy) return;
    const pages = [...(doc.scanned || [])].sort((a, b) => a - b);
    if (!pages.length) return toast('No scanned pages were detected — everything already has a text layer.', 'info', 5000);
    ocrBusy = true;
    runBtn.disabled = allBtn.disabled = true;
    try {
      for (let k = 0; k < pages.length; k++) {
        setProg(`Page ${pages[k] + 1} (${k + 1}/${pages.length})…`, k / pages.length);
        await ocrPage(pages[k], langSel.value, (m) => setProg(`Page ${pages[k] + 1} — ${m.status}…`, (k + (m.progress || 0)) / pages.length));
      }
      toast(`OCR finished on ${pages.length} page(s)`, 'ok');
      renderSidebar();
    } catch (e) {
      toast('OCR failed: ' + (e.message || e), 'err', 6000);
      console.error(e);
    } finally {
      ocrBusy = false;
      runBtn.disabled = allBtn.disabled = false;
      setProg('', 0);
    }
  };
  tools.append(engineSel, langSel, runBtn, allBtn, aiSetupBtn, engineLabel, hintInput);
  body.appendChild(prog);

  const scannedCount = doc.scanned ? doc.scanned.size : null;
  const results = Object.keys(doc.ocr || {}).map(Number).sort((a, b) => a - b);

  if (scannedCount != null && scannedCount > 0 && !results.length) {
    body.appendChild(el('div', { class: 'ocr-note warn', text: `${scannedCount} page(s) have no selectable text — they are probably scans or flattened exports. Run OCR to make them searchable.` }));
  }

  if (!results.length) {
    body.appendChild(el('div', { class: 'empty-state', html: svgIcon('scan', 26) + '<div>No OCR results yet.<br/>Pick a language and run OCR on the current page — English, Hindi and Nepali/Devanagari are supported.</div>' }));
    return;
  }

  const list = el('div', {});
  for (const p of results) {
    const rec = doc.ocr[p];
    const head = el('div', { class: 'ocr-head' }, [
      el('b', { text: `Page ${p + 1}` }),
      el('span', { class: 'conf', text: rec.engine === 'ai'
        ? ocrEngineLabel(rec) + (rec.langs && rec.langs !== 'eng' ? ` · ${rec.langs}` : '')
        : `${rec.confidence != null ? rec.confidence + '%' : 'ocr'} · ${rec.langs}` }),
    ]);
    const ta = el('textarea', { class: 'ocr-text', spellcheck: 'false' });
    ta.value = rec.text || '';
    ta.oninput = () => { rec.text = ta.value; };
    const copy = el('button', { class: 'mini-btn', text: 'Copy' });
    copy.onclick = async () => { try { await navigator.clipboard.writeText(rec.text || ''); toast('Copied', 'ok', 1400); } catch { toast('Copy failed', 'err'); } };
    const askBtn = el('button', { class: 'mini-btn', text: 'Ask AI' });
    askBtn.onclick = () => { openAIDock(); ask(`This page was recognised with OCR. Summarise it and list the key facts.`, 'page'); scrollToPage(p); };
    const box = el('div', { class: 'ocr-result' }, [head, ta, el('div', { class: 'flex' }, [copy, askBtn])]);
    head.onclick = () => scrollToPage(p);
    list.appendChild(box);
  }
  body.appendChild(list);
}

/**
 * Pick a font already installed on this machine and copy it into the app's own
 * font store, so it then persists and embeds exactly like an uploaded file.
 *
 * Selection is explicit (click a row, then Add) rather than closing on click,
 * because showModal only resolves through its buttons — there is no programmatic
 * close, and reaching for the footer button in the DOM to fake one would break
 * focus restoration.
 */
async function openSystemFontPicker() {
  let picked = null;
  let cache = null;

  const search = el('input', { type: 'search', placeholder: 'Filter by family or style…', 'aria-label': 'Filter fonts' });
  const status = el('div', { class: 'hint', text: 'Reading installed fonts…' });
  const list = el('div', { class: 'font-pick', role: 'listbox', 'aria-label': 'Installed fonts' });
  const rescan = el('button', { class: 'mini-btn', type: 'button', text: 'Rescan', title: 'Re-read the font folders, e.g. after installing a font' });
  const body = el('div', {}, [el('div', { class: 'flex' }, [search, rescan]), status, list]);

  const paint = () => {
    if (!cache) return;
    const q = search.value.trim().toLowerCase();
    const rows = cache.faces.filter((f) => !q || f.family.toLowerCase().includes(q) || (f.style || '').toLowerCase().includes(q));
    list.innerHTML = '';
    for (const f of rows.slice(0, 500)) {
      const b = el('button', { class: 'font-row' + (picked && picked.file === f.file ? ' on' : ''), type: 'button', role: 'option' });
      b.appendChild(el('span', { text: f.family }));
      b.appendChild(el('span', { class: 'hint', text: f.style }));
      b.onclick = () => { picked = f; paint(); };
      list.appendChild(b);
    }
    const skipped = cache.skippedCollections ? ` · ${cache.skippedCollections} collection file(s) not listed (.ttc)` : '';
    status.textContent = cache.unsupported
      ? 'Scanning installed fonts is not available on this platform.'
      : `${rows.length} face${rows.length === 1 ? '' : 's'}${rows.length > 500 ? ' (showing first 500)' : ''}${skipped}`;
  };

  const load = async (refresh) => {
    status.textContent = 'Reading installed fonts…';
    cache = await listSystemFonts(refresh);
    paint();
  };

  search.oninput = paint;
  rescan.onclick = () => load(true);
  const loading = load(false);

  const ok = await showModal({
    title: 'Add a font from this computer',
    width: 'wide',
    body: (host) => host.appendChild(body),
    buttons: [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: 'Add selected font', value: true, kind: 'primary' },
    ],
  });

  if (!ok) return null;
  await loading;
  if (!picked) { toast('Pick a font from the list first.', 'warn'); return null; }
  const res = await addSystemFont(picked);
  if (!res.ok) { toast(res.error || 'Could not add that font.', 'error'); return null; }
  toast(`“${res.family}” added — it will be used for new text`, 'ok');
  return res;
}

/* ── Fonts panel ────────────────────────────────────────────────────────── */

async function renderFontsPanel() {
  const doc = activeDoc();
  const body = $('#sideBody');
  const tools = $('#sideTools');
  if (!doc) return;

  const loadBtn = el('button', { class: 'mini-btn', text: 'Load font file…', title: 'Register a TTF/OTF from disk as the font used for new text boxes' });
  loadBtn.onclick = async () => {
    const name = await pickFontFile();
    if (name) { settings.newTextFont = name; toast(`“${name}” will be used for new text`, 'ok'); renderSidebar(); }
  };
  tools.append(loadBtn);
  const sysBtn = el('button', { class: 'mini-btn', text: 'From this computer…', title: 'Pick from the fonts already installed on this machine' });
  sysBtn.onclick = async () => {
    const res = await openSystemFontPicker();
    if (res) renderSidebar();
  };
  tools.append(sysBtn);
  const active = newTextFont();
  if (active) {
    tools.appendChild(el('div', { class: 'hint', style: { width: '100%' }, text: `New text uses: ${active}` }));
  }

  // Uploaded fonts are app-level, not document-level: they stay registered across
  // restarts until the user removes them, so they get their own list with a way
  // to do that. Rendered before the per-document scan below, which returns early.
  const stored = userFontRecords();
  if (stored.length) {
    const box = el('div', { class: 'prop-group' });
    box.appendChild(el('div', { class: 'prop-title', text: 'My fonts' }));
    for (const rec of stored) {
      const use = el('button', { class: 'mini-btn', text: 'Use', title: `Use “${rec.family}” for new text boxes` });
      use.onclick = () => {
        setActiveNewTextFont(rec.family);
        toast(`“${rec.family}” will be used for new text`, 'ok');
        renderSidebar();
      };
      const del = el('button', { class: 'mini-btn', text: 'Remove', title: `Delete “${rec.family}” from this computer` });
      del.onclick = async () => {
        const ok = await confirmDialog(`Delete “${rec.family}” from this computer? You can upload it again later.`, { title: 'Remove font', danger: true, okLabel: 'Remove' });
        if (!ok) return;
        await removeUserFont(rec.family);
        toast(`“${rec.family}” removed`, 'ok');
        renderSidebar();
      };
      box.appendChild(el('div', { class: 'prop-row' }, [
        el('label', { text: rec.family }),
        el('div', { class: 'pr-c' }, [el('div', { class: 'flex' }, [use, del])]),
      ]));
    }
    body.appendChild(box);
  }

  if (!doc.fontInfo) {
    body.appendChild(el('div', { class: 'empty-state', html: svgIcon('font', 26) + '<div>Scanning embedded fonts…</div>' }));
    try {
      doc.fontInfo = await extractFontInfo(doc.bytes);
      window.__aipdfFontsReady = true;
      if (settings.sidebar === 'fonts') renderSidebar();
    } catch (e) {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'empty-state', text: 'Could not read font information: ' + (e.message || e) }));
      console.error(e);
    }
    return;
  }

  const { all, perPage } = doc.fontInfo;
  const cur = doc.currentPage ?? 0;
  const curNames = new Set((perPage[cur] || []).map((f) => f.rawName));

  if (!all.length) {
    body.appendChild(el('div', { class: 'empty-state', html: svgIcon('font', 26) + '<div>No named fonts found — this document may be fully rasterised. Run OCR to work with its text.</div>' }));
    return;
  }

  body.appendChild(el('div', { class: 'hint', style: { padding: '2px 4px 8px' }, text: `${all.length} font(s) in this document · page ${cur + 1} uses ${perPage[cur].length}` }));

  const list = el('div', {});
  for (const f of all) {
    const onCur = curNames.has(f.rawName);
    const row = el('div', { class: `font-row${onCur ? ' cur' : ''}` }, [
      el('div', { class: 'fr-top' }, [
        el('span', { class: 'fname mono', text: f.name }),
        el('span', { class: 'fpages', text: f.pages.size === 1 ? `p.${[...f.pages][0] + 1}` : `${f.pages.size} pages` }),
      ]),
      el('div', { class: 'fr-badges' }, [
        el('span', { class: 'fbadge' + (f.embedded ? ' ok' : ' warn'), text: f.embedded ? 'embedded' : 'not embedded' }),
        f.subset ? el('span', { class: 'fbadge', text: 'subset' }) : null,
        el('span', { class: 'fbadge', text: f.type }),
      ]),
    ]);
    if (f.program) {
      const use = el('button', {
        class: `mini-btn${active === f.name ? ' primary' : ''}`,
        text: active === f.name ? '✓ Used for new text' : 'Use for new text',
        title: 'Reuse this embedded font when adding text boxes, notes or stamps',
      });
      use.onclick = () => {
        registerCustomFont(f.name, f.program.bytes, 'embedded');
        settings.newTextFont = f.name;
        toast(`“${f.name}” will be used for new text`, 'ok');
        renderSidebar();
      };
      row.appendChild(use);
    } else if (f.embedded) {
      row.appendChild(el('div', { class: 'hint', style: { marginTop: '4px' }, text: 'Embedded in a format that cannot be safely reused — install the font on this system to edit with it.' }));
    }
    list.appendChild(row);
  }
  body.appendChild(list);
}
