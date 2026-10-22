import { state, settings, saveSettings, activeDoc, updateAnnot, pushHistory, emit, on } from './store.js';
import {
  pageEl, getTextContent, toPdf, toCss, currentScale,
} from './viewer.js';
import { el, rgbToCss, hexToRgb, rgbToHex, clamp, toast, uid } from './util.js';
import { renderPageAnnotations } from './annots.js';
import { groupTextBlocks, editForBlock, blockText, wrapBlockText, blocksFromOcrLines, flatOcrLines, ocrSplitSegments, ocrCellBlock, textEditDrawBox, textItemBoxes } from './textblocks.js';
import { rectUnion } from './textops.js';
import { detectTables, tablesFromSegmentItems, tableForBlock, tableLabel } from './tables.js';
import {
  SCHEMA_VERSION, mergeStories, threadStory, storyFromEdit, layoutStory, fitCount, makeFrame, normRect,
} from './story.js';
import { isUserFont, listSystemFonts } from './fonts.js';
import { resolveFontFor } from './fontresolve.js';
import { confirmDialog, showModal } from './dialog.js';

let activeEditor = null;

/* Font stacks shared by the on-page editor and the measuring canvas, so the
 * preview, the block's own wrapping and the saved file all agree. */
const cssFontStack = (family) => `${family || 'Helvetica'}, Helvetica, Arial, sans-serif`;
const cssFont = (size, family) => `${size}px ${cssFontStack(family)}`;

export function initTextEditing() {
  const root = document.getElementById('pages');
  onEditorRefresh();
  // Marquee area select (Direct Editor): with the mode armed, a drag on a page
  // limits the editable blocks to that rectangle only — recognition runs first
  // when the page is a scan. Capture phase: the marquee must win over the
  // block buttons and the text layer beneath it.
  root.addEventListener('pointerdown', onMarqueeDown, true);
  // Double-click on a text run opens the inline editor — from any tool where
  // the text layer is interactive (Select, Edit Text, and the text-markup
  // tools). Drawing tools disable the text layer entirely, so they cannot
  // reach this handler. This is the "directly edit on the PDF" path: the
  // user never has to find a separate Edit Text tool to type into a page.
  root.addEventListener('dblclick', (e) => {
    const pageDiv = e.target.closest('.page');
    if (!pageDiv) return;
    const i = Number(pageDiv.dataset.i);
    // A committed block that was dragged elsewhere still re-opens: resolve it
    // back to its source block rather than requiring a click on the (covered)
    // original position.
    const teHit = e.target.closest ? e.target.closest('.textedit') : null;
    if (teHit && teHit.dataset.eid) { e.preventDefault(); void openEditorForEdit(i, teHit.dataset.eid, { clientX: e.clientX, clientY: e.clientY }); return; }
    const hit = e.target.closest('.editable-text-block');
    if (hit) { e.preventDefault(); void openDirectEditor(i, Number(hit.dataset.block), { clientX: e.clientX, clientY: e.clientY }); return; }
    const span = e.target.closest('.textLayer span');
    if (span) { e.preventDefault(); startTextEdit(i, span, { clientX: e.clientX, clientY: e.clientY }); return; }
    const ann = e.target.closest('.ann');
    if (ann) {
      const doc = activeDoc();
      const a = doc && doc.annots.find((x) => x.id === ann.dataset.id);
      if (a && ['textbox', 'callout', 'note', 'stamp'].includes(a.type)) {
        e.preventDefault();
        openInlineTextbox(a.id);
      }
    }
  });

  // Click-to-edit when the Edit Text tool is armed. Kept as a single-click
  // shortcut because the tool is explicitly a "type into the page" mode.
  root.addEventListener('click', (e) => {
    if (state.tool !== 'editText') return;
    const pageDiv = e.target.closest('.page');
    if (!pageDiv) return;
    if (activeEditor) return;
    const teHit = e.target.closest ? e.target.closest('.textedit') : null;
    if (teHit && teHit.dataset.eid) { void openEditorForEdit(Number(pageDiv.dataset.i), teHit.dataset.eid, { clientX: e.clientX, clientY: e.clientY }); return; }
    const hit = e.target.closest('.editable-text-block');
    if (hit) { void openDirectEditor(Number(pageDiv.dataset.i), Number(hit.dataset.block), { clientX: e.clientX, clientY: e.clientY }); return; }
    const span = e.target.closest('.textLayer span');
    if (span) startTextEdit(Number(pageDiv.dataset.i), span, { clientX: e.clientX, clientY: e.clientY });
  });
}

function onEditorRefresh() {
  on('pageRendered', (page) => { if (state.tool === 'editText') void renderEditableBlocks(page); });
  on('annots', () => { if (state.tool === 'editText') void renderEditableBlocks(); });
  on('change', () => { if (state.tool === 'editText') void renderEditableBlocks(); });
  on('tool', () => void renderEditableBlocks());
  // Zoom changes the CSS scale the block rects are drawn at — without this the
  // overlays keep the old scale's pixels and drift off the text ("the blocks
  // are offset from the text").
  on('zoom', () => { if (state.tool === 'editText') void renderEditableBlocks(); });
}

/* ── Marquee area select (region-limited direct edit) ───────────────────── */

let marqueeDrag = null;   // { page, x0, y0, previewEl }
let marqueeSeq = 0;

/** Arm/disarm the marquee: the next page drag selects the editable area. */
export function toggleRegionMode() {
  state.editRegionMode = !state.editRegionMode;
  if (state.editRegionMode) {
    toast('Drag a rectangle over the text you want to edit — only that area becomes editable.', 'info', 5000);
  }
  emit('selection');
}

export function clearEditRegion() {
  state.editRegion = null;
  state.editRegionMode = false;
  void renderEditableBlocks();
  emit('selection');
}

function onMarqueeDown(e) {
  // Armed two ways: the Direct Editor panel's "Select area" toggle, or the
  // dedicated Area Direct Edit tool on the ribbon (next to Direct Editor).
  if ((!state.editRegionMode && state.tool !== 'editArea') || e.button !== 0) return;
  const pageDiv = e.target.closest ? e.target.closest('.page') : null;
  if (!pageDiv) return;
  e.preventDefault();
  e.stopPropagation();
  const page = Number(pageDiv.dataset.i);
  marqueeDrag = { page, x0: e.clientX, y0: e.clientY };
  const preview = el('div', { class: 'edit-marquee' });
  preview.style.position = 'fixed';
  preview.style.zIndex = '95';
  document.body.appendChild(preview);
  marqueeDrag.previewEl = preview;

  const onMove = (ev) => {
    if (!marqueeDrag) return;
    const x = Math.min(marqueeDrag.x0, ev.clientX);
    const y = Math.min(marqueeDrag.y0, ev.clientY);
    preview.style.left = `${x}px`;
    preview.style.top = `${y}px`;
    preview.style.width = `${Math.abs(ev.clientX - marqueeDrag.x0)}px`;
    preview.style.height = `${Math.abs(ev.clientY - marqueeDrag.y0)}px`;
  };
  const onUp = async (ev) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const { x0, y0 } = marqueeDrag;
    const x1 = ev.clientX, y1 = ev.clientY;
    preview.remove();
    marqueeDrag = null;
    state.editRegionMode = false;
    if (Math.abs(x1 - x0) < 8 || Math.abs(y1 - y0) < 8) { emit('selection'); return; } // a click is not a marquee
    // toPdf expects PAGE-LOCAL CSS coordinates — the marquee corners are
    // viewport-absolute, so they must be rebased onto the page wrap first
    // (passing client-absolute values shifted the region by the page offset).
    const wrap = document.querySelector(`.page[data-i="${page}"]`).getBoundingClientRect();
    const a = toPdf(page, Math.min(x0, x1) - wrap.left, Math.min(y0, y1) - wrap.top);
    const b = toPdf(page, Math.max(x0, x1) - wrap.left, Math.max(y0, y1) - wrap.top);
    // App rect convention: [x0, yBottom, x1, yTop] with yBottom < yTop — the
    // viewport flip makes toPdf's first corner carry the LARGER y, so sort.
    state.editRegion = {
      page,
      rect: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)],
    };
    // The Area Direct Edit tool hands off to the Direct Editor itself: the
    // region's blocks are on screen and clickable the moment the marquee closes.
    if (state.tool === 'editArea' && window.__aipdfAction) {
      window.__aipdfAction('tool:editText');
    }
    const doc = activeDoc();
    // A scan that has not been recognised yet: recognition runs on the whole
    // page once (Tesseract needs the full render), but only the marquee's
    // blocks become editable — which is the point.
    if (doc?.pdf && !doc.ocr?.[page]) {
      const native = await (async () => { try { return await getTextContent(page); } catch { return null; } })();
      if (!native || !native.items.some((it) => it.str && it.str.trim())) {
        toast('Recognising the selected area…', 'info', 2000);
        try { await recognizePageForEditing(page); } catch { /* the empty notice offers a retry */ }
      }
    }
    void renderEditableBlocks(page);
    emit('selection');
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
}

/**
 * Where a page's editable text comes from.
 *
 * Native PDF text wins when it exists — it is exact. When it does not, the
 * page is a scan and the only route to editing is OCR, so a previous
 * recognition result is used instead. `source` is reported so the UI can say
 * which one it is showing, and offer to recognise when there is neither.
 */
export async function editableSource(pageIndex) {
  const doc = activeDoc();
  if (!doc?.pdf || pageIndex < 0 || pageIndex >= doc.numPages) return { blocks: [], source: 'none' };
  const width = doc.pageSizes?.[pageIndex]?.w || 595;
  try {
    const tc = await getTextContent(pageIndex);
    const native = groupTextBlocks(tc, width).filter((b) => (b.text || '').trim().length > 0);
    if (native.length) {
      /* Tables are recognised HERE, before anything consumes the block list, so
       * that every consumer — the hit targets, the Direct Editor, replace-all,
       * the agent — agrees on what an editable unit is: one block per CELL. */
      const pageH = doc.pageSizes?.[pageIndex]?.h || 842;
      const paths = await pageRules(doc, pageIndex);
      const found = detectTables(native, { page: pageIndex, pageW: width, pageH, ...(paths ? { paths } : {}) });
      const split = splitBlocksByCells(tc, native, found, width);
      tablesByBlocks.set(split.blocks, split.tables);
      return { blocks: filterByRegion(pageIndex, split.blocks), source: 'native' };
    }
  } catch { /* fall through to OCR — an unreadable page is not an empty one */ }

  const rec = doc.ocr?.[pageIndex];
  if (rec?.lines?.length) {
    const height = doc.pageSizes?.[pageIndex]?.h || 842;
    const ocr = blocksFromOcrLines(rec.lines, width, height, rec.dpi || 200, pageIndex)
      .filter((b) => (b.text || '').trim().length > 0);
    if (ocr.length) {
      /* Tables live on scans too — the tender-sheet case: one OCR "line"
       * reads straight across several cells, so paragraph grouping fuses the
       * whole table into a handful of row blocks. Detect the grid from OCR
       * column segments and rebuild ONE block per cell, exactly like the
       * native-text path does. */
      const split = splitOcrBlocksByCells(rec, ocr, width, height, pageIndex);
      tablesByBlocks.set(split.blocks, split.tables);
      return { blocks: filterByRegion(pageIndex, split.blocks), source: 'ocr' };
    }
    return { blocks: [], source: 'ocr-empty' };
  }
  return { blocks: [], source: 'none' };
}

/**
 * One editable block per CELL for recognised (scanned) pages.
 *
 * Scans have no vector rules, so the grid comes from the OCR text itself:
 * lines are cut into column-candidate segments at word gutters
 * (textblocks.ocrSplitSegments), the recurring gutters across rows give the
 * grid (tables.tablesFromSegmentItems), and each cell's segments rebuild an
 * independent block whose lineIds stay the ORIGINAL OCR line ids — the
 * editor's identity/wash machinery depends on them. Blocks with no segment
 * inside any table pass through untouched; a block whose text all lands in
 * table cells is replaced by its per-cell pieces.
 */
function splitOcrBlocksByCells(rec, blocks, pageWidth, pageHeight, pageIndex) {
  const dpi = rec.dpi || 200;
  const flat = flatOcrLines(rec.lines, pageHeight, dpi);       // li = index into rec.lines
  if (!flat.length) return { blocks, tables: [] };
  const flatByLi = new Map(flat.map((l) => [l.li, l]));
  const segments = ocrSplitSegments(flat);
  const tables = tablesFromSegmentItems(segments, { page: pageIndex });
  if (!tables.length) return { blocks, tables };

  const inCell = (rect, cell) => {
    const cx = (rect[0] + rect[2]) / 2, cy = (rect[1] + rect[3]) / 2;
    return cx >= cell.rect[0] && cx <= cell.rect[2] && cy >= cell.rect[1] && cy <= cell.rect[3];
  };
  const cellKey = (t, c) => `${t.id}|${c.row}|${c.col}`;

  /* Pass 1 — per table, attribute every fully-inside block's line segments to
   * cells. Segments pool ACROSS blocks: page-level grouping may have split one
   * cell's lines into several blocks, and the cell is the editable unit. */
  const segsByCell = new Map();      // cellKey → { table, cell, segs: [] }
  const consumed = new Set();
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const lineIds = block.lineIds || [];
    const table = tables.find((t) => {
      const [x0, y0, x1, y1] = t.bbox;
      const r = block.coverRect;
      const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
      return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
    });
    if (!table || !lineIds.length) continue;

    const ownSegs = segments.filter((s) => lineIds.includes(s.li));
    if (!ownSegs.length) continue;
    let mapped = 0;
    for (const seg of ownSegs) {
      const cell = table.cells.find((c) => inCell(seg.rect, c));
      if (!cell) continue;
      mapped++;
      const k = cellKey(table, cell);
      if (!segsByCell.has(k)) segsByCell.set(k, { table, cell, segs: [] });
      segsByCell.get(k).segs.push(seg);
    }
    // Nothing attributable, or the block carries text OUTSIDE the table too
    // (splitting would orphan the outside part): keep it whole.
    if (!mapped || mapped < ownSegs.length) continue;
    consumed.add(bi);
  }

  /* Pass 2 — wrapped cells: the text-cluster grid has one ROW per OCR line
   * band, so a 3-line cell lands in 3 stacked cells. Coalesce consecutive
   * bands in the same column when they sit at wrapped-line pitch (gap well
   * under half the band height) — the user's cell, not the detector's line
   * band, is the editable unit. Real row separations carry more space (or a
   * rule) and stay apart. */
  const groups = [];
  for (const [k, rec] of segsByCell) {
    groups.push({ k, ...rec, merged: [rec] });
  }
  const absorb = new Set();
  for (const [table, list] of [...new Set([...segsByCell.values()].map((r) => r.table))].map((t) => [t, [...segsByCell.values()].filter((r) => r.table === t)])) {
    const byCol = new Map();
    for (const rec of list) {
      if (!byCol.has(rec.cell.col)) byCol.set(rec.cell.col, []);
      byCol.get(rec.cell.col).push(rec);
    }
    for (const col of [...byCol.keys()].sort((a, b) => a - b)) {
      const colRecs = byCol.get(col).sort((a, b) => b.cell.row - a.cell.row); // top first (rows are y-ascending bands)
      for (let i = 0; i < colRecs.length; i++) {
        const chain = [colRecs[i]];
        for (let j = i + 1; j < colRecs.length; j++) {
          const above = chain[chain.length - 1];
          const below = colRecs[j];
          // tableFromRun rows are y-ordered top-first, so the band below on
          // the page is row + 1.
          if (below.cell.row !== above.cell.row + 1) break;   // only the immediate next band
          const gap = above.cell.rect[1] - below.cell.rect[3]; // above.bottom − below.top
          const hMin = Math.min(above.cell.rect[3] - above.cell.rect[1], below.cell.rect[3] - below.cell.rect[1]);
          if (gap > hMin * 0.5) break;                        // real row separation
          chain.push(below);
        }
        if (chain.length > 1) {
          const idx = groups.findIndex((g) => g.k === cellKey(table, chain[0].cell));
          const head = groups[idx];
          head.cell = {
            ...head.cell,
            row: Math.min(...chain.map((c) => c.cell.row)),
            rect: [
              Math.min(...chain.map((c) => c.cell.rect[0])),
              Math.min(...chain.map((c) => c.cell.rect[1])),
              Math.max(...chain.map((c) => c.cell.rect[2])),
              Math.max(...chain.map((c) => c.cell.rect[3])),
            ],
          };
          for (const c of chain.slice(1)) { head.segs.push(...c.segs); absorb.add(cellKey(table, c.cell)); }
        }
      }
    }
  }

  const entries = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    if (!consumed.has(bi)) entries.push({ block: blocks[bi], from: bi });
  }
  for (const rec of groups) {
    if (absorb.has(rec.k)) continue;
    const piece = ocrCellBlock(rec.segs, flatByLi, rec.cell.rect, pageWidth, pageIndex);
    if (piece && String(piece.text || '').trim()) entries.push({ block: piece, cell: rec.cell, table: rec.table });
  }

  const out = [];
  const piecesByCell = new Map();
  for (const e of entries) {
    const at = out.length;
    out.push(e.block);
    if (e.cell) {
      const k = cellKey(e.table, e.cell);
      if (!piecesByCell.has(k)) piecesByCell.set(k, []);
      piecesByCell.get(k).push(at);
    }
  }
  for (const t of tables) {
    for (const cell of t.cells) {
      cell.blocks = piecesByCell.get(cellKey(t, cell)) || [];
    }
  }
  return { blocks: out, tables };
}

export async function editableBlocks(pageIndex) {
  return (await editableSource(pageIndex)).blocks;
}

/** Table structure for a page. Detection is geometry-only and cheap; the block
 *  array is rebuilt on every repaint, so a reference cache would never hit.
 *
 *  The pairing matters: `splitBlocksByCells` decides which blocks belong to
 *  which cell, so the tables returned here must be the ones it patched — a
 *  fresh detection would report cell.blocks indices into the ORIGINAL array,
 *  which no longer line up with the split one. The WeakMap keeps the pairing
 *  exact without a cache that could go stale. */
const tablesByBlocks = new WeakMap();
function pageTables(pageIndex, blocks) {
  const known = tablesByBlocks.get(blocks);
  if (known) return known;
  return detectTables(blocks, tableDetectOptions(pageIndex));
}

/** Marquee filter: when an edit region is armed for this page, only blocks
 *  whose cover intersects the rectangle survive — "edit this area only". */
function filterByRegion(pageIndex, blocks) {
  const region = state.editRegion && state.editRegion.page === pageIndex ? state.editRegion.rect : null;
  if (!region || !blocks.length) return blocks;
  const hit = (r) => r[0] < region[2] && r[2] > region[0] && r[1] < region[3] && r[3] > region[1];
  return blocks.filter((b) => hit(b.coverRect || b.rect));
}

/** Rules are read from the ORIGINAL bytes, which never change for an open
 *  document (every export rebuilds from them), so the extraction is cached per
 *  document rather than per repaint. */
const ruleCache = new WeakMap();
async function pageRules(doc, pageIndex) {
  if (!doc) return null;
  let byPage = ruleCache.get(doc);
  if (!byPage) { byPage = new Map(); ruleCache.set(doc, byPage); }
  if (byPage.has(pageIndex)) return byPage.get(pageIndex);
  let paths = null;
  try {
    const { pageRulePaths } = await import('./pdfwrite.js');
    paths = await pageRulePaths(doc, pageIndex);
  } catch { paths = null; }
  byPage.set(pageIndex, paths);
  return paths;
}

function tableDetectOptions(pageIndex, paths = null) {
  const doc = activeDoc();
  const pageW = doc?.pageSizes?.[pageIndex]?.w || 595;
  const pageH = doc?.pageSizes?.[pageIndex]?.h || 842;
  return { page: pageIndex, pageW, pageH, ...(paths ? { paths } : {}) };
}

/**
 * Rebuild the blocks inside a table so there is ONE block per CELL.
 *
 * Two ways a producer can bury the cell structure, and both are handled:
 *  - a whole row emitted as one text run (one block spanning every column);
 *  - each cell line emitted separately (page-level grouping keeps stacked
 *    cell lines apart, because the row's first line sets the indent baseline).
 * The grid is authoritative either way: every item of every block that sits
 * inside a table is attributed to the cell containing its centre, and each
 * cell's union of items is regrouped ONCE (`groupTextBlocks` with an item
 * subset, which keeps the page-level item indices so excision and keys stay
 * correct). A cell therefore ends up with exactly one editable block no
 * matter how its text arrived.
 *
 * A block only participates when ALL of its items land in the table — one
 * that straddles the table edge stays whole, or its outside text would be
 * orphaned. Cells that end up with no text are left empty rather than
 * inheriting a neighbour's run — an empty cell is a place to type, not a
 * duplicate.
 */
function splitBlocksByCells(tc, blocks, tables, pageWidth) {
  if (!tables.length || !tc?.items?.length) return { blocks, tables };

  const boxByIndex = new Map(textItemBoxes(tc).map((b) => [b.index, b]));
  const contains = (r, cell) => {
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
    return cx >= cell[0] && cx <= cell[2] && cy >= cell[1] && cy <= cell[3];
  };
  const cellKey = (t, c) => `${t.id}|${c.row}|${c.col}`;

  /* Pass 1 — per table, attribute every fully-inside block's items to cells. */
  const itemsByCell = new Map();     // cellKey → Set of tc item indices
  const consumed = new Set();        // block indices replaced by per-cell pieces
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const box = block.coverRect;
    const table = tables.find((t) => contains(box, t.bbox));
    if (!table || !block.itemIndices?.length) continue;

    const perCell = new Map();
    let mapped = 0;
    for (const idx of block.itemIndices) {
      const b = boxByIndex.get(idx);
      if (!b) continue;
      const cell = table.cells.find((c) => contains(b.rect, c.rect));
      if (!cell) continue;
      mapped++;
      const k = cellKey(table, cell);
      if (!itemsByCell.has(k)) itemsByCell.set(k, { table, cell, idxs: new Set() });
      itemsByCell.get(k).idxs.add(idx);
    }
    // Nothing attributable (text on a rule line, rotated, …): keep the block
    // whole rather than dropping its text from the editable set.
    if (!mapped) continue;
    // Straddler: some items have no cell here — keep the block whole so its
    // outside text is not orphaned.
    if (mapped < block.itemIndices.length) continue;
    consumed.add(bi);
  }

  /* Pass 2 — one regrouped block per cell, then the survivors. */
  const entries = [];
  const cellPieceIndex = new Map();
  for (let bi = 0; bi < blocks.length; bi++) {
    if (!consumed.has(bi)) { entries.push({ block: blocks[bi], from: bi }); continue; }
  }
  for (const { table, cell, idxs } of itemsByCell.values()) {
    for (const piece of groupTextBlocks(tc, pageWidth, idxs)) {
      if (!String(piece.text || '').trim()) continue;
      /* Ownership stops at the cell boundary. A cell's text can overflow its
       * column by a point or two, and the block rect follows the glyphs — so
       * an unclamped rect reaches into the neighbouring cell and the writer
       * then excises that neighbour's text too ("I edited one cell and lost
       * the one next to it"). The CELL is authoritative about what belongs to
       * it. `coverRect` is left alone so the wash still covers the overflow. */
      const own = [
        Math.max(piece.coverRect[0], cell.rect[0]),
        Math.max(piece.coverRect[1], cell.rect[1]),
        Math.min(piece.coverRect[2], cell.rect[2]),
        Math.min(piece.coverRect[3], cell.rect[3]),
      ];
      piece.ownRect = (own[2] - own[0] > 0.5 && own[3] - own[1] > 0.5) ? own : piece.coverRect.slice();
      entries.push({ block: piece, cell, table });
    }
  }

  /* Pass 2 — flatten, recording final indices so cell.blocks can be rebuilt. */
  const out = [];
  const origToFinal = new Map();
  const piecesByCell = new Map();
  for (const e of entries) {
    const at = out.length;
    out.push(e.block);
    if (e.from != null) origToFinal.set(e.from, at);
    if (e.cell) {
      const k = cellKey(e.table, e.cell);
      if (!piecesByCell.has(k)) piecesByCell.set(k, []);
      piecesByCell.get(k).push(at);
    }
  }

  for (const t of tables) {
    for (const cell of t.cells) {
      const kept = (cell.blocks || []).map((bi) => origToFinal.get(bi)).filter((x) => x != null);
      const split = piecesByCell.get(cellKey(t, cell)) || [];
      cell.blocks = [...split, ...kept].sort((a, b) => a - b);
    }
  }
  return { blocks: out, tables };
}

/**
 * Run OCR on a page so its text becomes editable, then repaint the hit targets.
 *
 * This is Acrobat's "Recognize Text" reached from inside Edit PDF: on a scan
 * there is nothing to select until the page has been read.
 */
export async function recognizePageForEditing(pageIndex, opts = {}) {
  const doc = activeDoc();
  if (!doc) return { ok: false, error: 'No document open' };
  const { recognizePageForEditing: run } = await import('./ocr.js');
  try {
    const rec = await run(pageIndex, opts.langs || settings.ocrLang || 'eng', (m) => {
      emit('ocrProgress', { page: pageIndex, status: m.status, progress: m.progress });
    });
    // Marks this page for the writer: the recognised text is saved back into
    // the file as an invisible, searchable layer.
    if (doc.ocr?.[pageIndex]) doc.ocr[pageIndex].forEditing = true;
    await renderEditableBlocks(pageIndex);
    const blocks = (await editableSource(pageIndex)).blocks.length;
    toast(`Recognised ${blocks} text block${blocks === 1 ? '' : 's'} on page ${pageIndex + 1}${rec.confidence ? ` · ${rec.confidence}% confidence` : ''}`, 'info');
    return { ok: blocks > 0, blocks, confidence: rec.confidence };
  } catch (e) {
    const msg = String(e?.message || e);
    toast(`OCR failed: ${msg.slice(0, 160)}`, 'error');
    return { ok: false, error: msg };
  }
}

/** Only the Edit Text mode exposes paragraph hit targets; the existing text
 * layer remains selectable and other tools keep their usual pointer routing.
 *
 * Gated on `rendered`, NOT `textBuilt`: groupTextBlocks() works off pdf.js's
 * text content (see editableBlocks), so the DOM text layer is irrelevant here.
 * Requiring it made the Direct Editor silently dead whenever the text layer had
 * not been built — which happens whenever the scale drifts between the page's
 * render and its text-layer build. */

/** Per-page repaint generation, so an older in-flight repaint cannot append a
 *  second hit-target layer over a newer one. */
const renderGen = new Map();

export async function renderEditableBlocks(pageIndex = null) {
  const records = pageIndex == null ? Array.from(document.querySelectorAll('#pages .page')).map((p) => Number(p.dataset.i)) : [pageIndex];
  for (const i of records) {
    /* Repaints overlap: editableSource() awaits the text content (and the page's
     * ruling lines), so two repaints can be in flight for one page. Without a
     * generation stamp the later one appends a SECOND hit-target layer on top of
     * the first — duplicate buttons, and every click lands on the stale copy.
     * Stamp the run and let only the newest one draw. */
    const gen = (renderGen.get(i) || 0) + 1;
    renderGen.set(i, gen);
    const rec = pageEl(i);
    if (!rec) continue;
    rec.wrap.querySelectorAll('.editable-text-layer').forEach((n) => n.remove());
    if (state.tool !== 'editText' || !rec.rendered) continue;
    const doc = activeDoc();
    const { blocks, source } = await editableSource(i);
    if (renderGen.get(i) !== gen) continue;              // superseded
    if (!doc || doc !== activeDoc() || state.tool !== 'editText' || !rec.wrap.isConnected) continue;
    const layer = el('div', { class: 'editable-text-layer' });
    // Recognise tables once per repaint: the grid is drawn under the hit
    // targets, and each block inside a cell carries its row/column so a click
    // opens a CELL-scoped edit rather than the whole line.
    const tables = blocks.length ? pageTables(i, blocks) : [];
    const cellByBlock = new Map();
    for (const t of tables) {
      for (const row of t.rows) {
        for (const cell of row.cells) {
          for (const bi of cell.blocks) cellByBlock.set(bi, { table: t, cell });
        }
      }
    }
    const grid = tableGridLayer(i, tables);
    if (grid) layer.appendChild(grid);
    // The active marquee region: dashed outline + tag, so "edit this area
    // only" is always visible while it lasts.
    if (state.editRegion && state.editRegion.page === i) {
      const rg = state.editRegion.rect;
      const ra = toCss(i, rg[0], rg[3]);
      const rb = toCss(i, rg[2], rg[1]);
      const regionBox = el('div', { class: 'edit-region-box' }, [
        el('span', { class: 'edit-region-tag', text: 'Editing area' }),
      ]);
      regionBox.style.left = Math.min(ra.x, rb.x) + 'px';
      regionBox.style.top = Math.min(ra.y, rb.y) + 'px';
      regionBox.style.width = Math.abs(rb.x - ra.x) + 'px';
      regionBox.style.height = Math.abs(rb.y - ra.y) + 'px';
      layer.appendChild(regionBox);
    }
    if (!blocks.length) {
      // Silence is what made this tool look broken: with no block to click the
      // page simply appeared dead. Say why, and offer the way out.
      layer.appendChild(emptyNotice(i, source));
      rec.wrap.appendChild(layer);
      continue;
    }
    // A committed Direct Editor edit is represented on screen by its text-box
    // annotation, not by the clickable block affordance. Any block whose button
    // would sit on top of that box (or its resize handles) must be dropped,
    // otherwise the box can never be grabbed, selected, moved or resized — the
    // button would eat the pointer. Test by geometry so it covers both the
    // edited block itself and neighbours the box overlaps; the margin reaches
    // the handles, which sit just outside the box's own footprint.
    const committedBoxes = [];
    for (const e of doc.textEdits || []) {
      if (e.page === i && e.boxId && doc.annots.some((a) => a.id === e.boxId)) {
        committedBoxes.push(doc.annots.find((a) => a.id === e.boxId).rect);
      }
      // A threaded story carries no text box — its ordered frames ARE the
      // committed region. Without this the block affordance reappears the moment
      // "Link frames" drops the box, and every click on the story is eaten by a
      // button that is meant to be gone.
      if (Array.isArray(e.frames) && e.frames.length > 1) {
        for (const f of e.frames) if (f.page === i) committedBoxes.push(f.rect);
      }
    }
    const HANDLE_MARGIN = 12;
    const overlapsBox = (rect) => committedBoxes.some((b) =>
      rect[0] - HANDLE_MARGIN < b[2] && rect[2] + HANDLE_MARGIN > b[0] &&
      rect[1] - HANDLE_MARGIN < b[3] && rect[3] + HANDLE_MARGIN > b[1]);
    for (let n = 0; n < blocks.length; n++) {
      const block = blocks[n];
      const prior = editForBlock(doc, i, block);
      if (overlapsBox(block.coverRect) || (prior && prior.boxId && doc.annots.some((a) => a.id === prior.boxId))) continue;
      const inCell = cellByBlock.get(n);
      const r = inCell ? inCell.cell.rect : block.coverRect;
      const a = toCss(i, r[0], r[3]);
      const b = toCss(i, r[2], r[1]);
      const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      const hit = el('button', { type: 'button', class: 'editable-text-block',
        title: `${source === 'ocr' ? 'Recognised' : 'Edit'} text: ${blockText(doc, i, block).slice(0, 90)}`,
        'aria-label': `Edit text block ${n + 1}`, dataset: { block: String(n) },
        style: { left: (x - 2) + 'px', top: (y - 2) + 'px',
          width: Math.max(12, Math.abs(b.x - a.x) + 4) + 'px',
          height: Math.max(12, Math.abs(b.y - a.y) + 4) + 'px' } });
      // Source-order number. The order is the page's own text order, so two
      // visually similar runs can be told apart before a merge is confirmed —
      // the research is emphatic that a merge must be an explicit decision.
      hit.appendChild(el('span', { class: 'block-order', text: String(n + 1), 'aria-hidden': 'true' }));
      if (inCell) {
        hit.dataset.table = inCell.table.id;
        hit.dataset.row = String(inCell.cell.row);
        hit.dataset.col = String(inCell.cell.col);
        hit.classList.add('in-table');
        hit.title += ` · ${tableLabel(inCell.table, inCell.cell, tables.indexOf(inCell.table))}`;
      }
      if (source === 'ocr') hit.classList.add('from-ocr');
      layer.appendChild(hit);
    }
    rec.wrap.appendChild(layer);
  }
}

/** "Nothing to edit here — and here is what to do about it." */
function emptyNotice(pageIndex, source) {
  const recognised = source === 'ocr-empty';
  const box = el('div', { class: 'editable-empty', role: 'status' });
  box.appendChild(el('b', { text: recognised ? 'Nothing readable was found on this page' : 'This page has no editable text' }));
  box.appendChild(el('p', { text: recognised
    ? 'OCR ran but recognised no words here. Try another language, or a higher scan resolution.'
    : 'It looks like a scan or an image. Recognise it first, then every word becomes editable.' }));
  const btn = el('button', { type: 'button', class: 'mini-btn primary', text: 'Recognize Text…' });
  btn.onclick = (e) => { e.stopPropagation(); void recognizePageForEditing(pageIndex); };
  const row = el('div', { class: 'editable-empty-row' }, [btn]);
  box.appendChild(row);
  box.addEventListener('pointerdown', (e) => e.stopPropagation());
  return box;
}

/** Draw the recognised table structure under the hit targets: a dashed region
 *  per table, a solid outline per cell, and a small "Table 1 · 3×4" tag. The
 *  layer is pointer-events:none so it never eats a click meant for a cell. */
function tableGridLayer(pageIndex, tables) {
  if (!tables.length) return null;
  const layer = el('div', { class: 'table-grid', 'aria-hidden': 'true' });
  for (let ti = 0; ti < tables.length; ti++) {
    const t = tables[ti];
    const a = toCss(pageIndex, t.bbox[0], t.bbox[3]);
    const b = toCss(pageIndex, t.bbox[2], t.bbox[1]);
    const left = Math.min(a.x, b.x);
    const top = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    const region = el('div', { class: 'table-region', style: {
      left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px' } });
    region.appendChild(el('div', { class: 'table-tag', text: `Table ${ti + 1} · ${t.rows.length}×${t.cols.length}` }));
    for (const row of t.rows) {
      for (const cell of row.cells) {
        const ca = toCss(pageIndex, cell.rect[0], cell.rect[3]);
        const cb = toCss(pageIndex, cell.rect[2], cell.rect[1]);
        region.appendChild(el('div', { class: 'table-cell', style: {
          left: (Math.min(ca.x, cb.x) - left) + 'px',
          top: (Math.min(ca.y, cb.y) - top) + 'px',
          width: Math.abs(cb.x - ca.x) + 'px',
          height: Math.abs(cb.y - ca.y) + 'px' } }));
      }
    }
    layer.appendChild(region);
  }
  return layer;
}

/** The fields a Direct Editor commit can change. Anything listed here makes an
 *  otherwise-identical edit count as a change, so re-applying the same text
 *  with a different alignment is not silently dropped. */
const BLOCK_FIELDS = ['text', 'size', 'color', 'maxWidth', 'maxHeight', 'align',
  'bold', 'italic', 'underline', 'lineHeight', 'charSpacing', 'hScale', 'fontFamily',
  'mode', 'frames'];

/** Replaces an entire geometric block, so an AI change to a few words never
 * whites out the rest of a run without redrawing it. One block has one pending
 * edit, updated in place. Undo still records each commit separately. */
export async function commitBlockEdit(pageIndex, block, nextText, options = {}) {
  const doc = activeDoc();
  // OCR blocks have no pdf.js item indices — they are identified by `key` and
  // their own line ids, so requiring indices here silently dropped every edit
  // made on a recognised page.
  const isOcr = block?.kind === 'o';
  if (!doc || !block || (!isOcr && !block.itemIndices?.length)) return false;
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.numPages) return false;
  const existing = editForBlock(doc, pageIndex, block);
  const text = String(nextText ?? '');
  // Explicit `undefined` checks throughout: 0pt character spacing and a false
  // `bold` are both legitimate values that `||` would discard.
  const pick = (k, fallback) => (options[k] !== undefined ? options[k]
    : (existing && existing[k] !== undefined ? existing[k] : fallback));
  const edit = {
    ...block, ...existing,
    id: existing?.id || uid('te'), page: pageIndex,
    // The authoring model's identity for this record. `schemaVersion` lets a
    // future change migrate old projects instead of guessing at their shape.
    schemaVersion: SCHEMA_VERSION,
    // 'line' keeps the block a single line and rejects wrapping; 'flow' permits
    // paragraph wrapping and frame threading. A record with more than one frame
    // is always a flow story.
    mode: options.mode || existing?.mode
      || (options.frames && options.frames.length > 1 ? 'flow' : 'line'),
    key: block.key, kind: block.kind || 'n',
    itemIndices: (block.itemIndices || []).slice(), original: existing?.original ?? block.text, text,
    // Explicit source ownership: the exact source objects this story owns. The
    // writer may remove these and only these. A selection is a proposal until
    // it is recorded here.
    sourceRefs: {
      itemIndices: (block.itemIndices || []).slice(),
      lineIds: (block.lineIds || []).slice(),
    },
    sourceRects: (options.sourceRects && options.sourceRects.length
      ? options.sourceRects
      // `ownRect` is a table cell's clamped ownership box: the block rect minus
      // anything that spilled past the cell boundary.
      : [(existing?.ownRect || existing?.coverRect || block.ownRect || block.coverRect).slice()]).map(normRect).filter(Boolean),
    // Ordered destination frames. One frame is the ordinary in-place edit; two
    // or more is a threaded story that continues across pages.
    frames: (options.frames && options.frames.length ? options.frames.map((f) => makeFrame(f.page ?? pageIndex, f.rect || f))
      : existing?.frames || null),
    // What will draw the text and what it cannot draw — recorded so the report
    // describes the file, not the request.
    fontPolicy: options.fontPolicy || existing?.fontPolicy || null,
    // The recognised table cell this story belongs to, when authored inside one.
    // The frame carries the geometry that constrains the text; this records the
    // structure (table/row/column) for the panel and for re-opening the cell.
    table: options.table || existing?.table || null,
    // Cover model: the cover stays over the ORIGINAL footprint forever, while
    // the replacement text box travels with the user. On re-edit, keep the
    // moved geometry — resetting to the block would teleport a dragged block
    // back to where its original text was.
    coverRect: (existing?.coverRect || block.coverRect).slice(),
    rect: (existing?.rect || block.rect).slice(),
    baseline: (existing?.baseline || block.baseline).slice(),
    // On a scan the old glyphs are pixels in an image, so the replacement has
    // to paint over them with whatever is actually behind the words — a fixed
    // white would leave a bright patch on a tinted or grey scan.
    bg: isOcr ? sampleBackdrop(pageIndex, block.coverRect) : [1, 1, 1],
    angle: block.angle || 0,
    size: pick('size', block.size),
    color: pick('color', block.color),
    fontFamily: pick('fontFamily', block.fontFamily),
    maxWidth: pick('maxWidth', block.maxWidth),
    maxHeight: pick('maxHeight', block.maxHeight),
    // Format-panel defaults fall back to the persisted house style, so a block
    // inherits whatever the user last chose on the Direct Editor panel.
    align: pick('align', settings.textAlign || 'left'),
    bold: pick('bold', !!settings.textBold),
    italic: pick('italic', !!settings.textItalic),
    underline: pick('underline', !!settings.textUnderline),
    lineHeight: pick('lineHeight', block.lineHeight),
    charSpacing: pick('charSpacing', settings.textCharSpacing || 0),
    hScale: pick('hScale', settings.textHScale || 100),
  };
  // The region this edit's replacement occupies once the writer draws it: it
  // starts at the baseline and steps down by `leading` per line, and runs no
  // wider than maxWidth. Derived here rather than measured, because its only job
  // is to widen the excision rect on the NEXT edit so re-editing your own edit
  // cannot leave the previous replacement behind.
  const base = existing?.baseline || block.baseline;
  // Every story owns at least one destination frame: an ordinary in-place edit
  // is a ONE-frame story and only a threaded story carries more. Deriving the
  // frame here — rather than leaving `frames` null — keeps the record one shape
  // whether it was authored in place or threaded across pages, so the writer,
  // the layout preview and the inspector all read the same field.
  if (!edit.frames || !edit.frames.length) {
    const fs = edit.size || 11;
    const fh = edit.maxHeight || block.maxHeight || fs * 1.25;
    // The geometry must agree with the overset computation below. The layout
    // model seats the first baseline one font-size below the frame top, so the
    // frame top is `baseline + size` and the frame height is exactly the box
    // height — anything else and the live badge would contradict the readout.
    edit.frames = [makeFrame(pageIndex, [
      base[0],
      base[1] + fs - fh,
      base[0] + (edit.maxWidth || block.maxWidth || 10),
      base[1] + fs,
    ])];
  }
  const leading0 = edit.lineHeight || block.lineHeight || edit.size;
  const boxH = edit.maxHeight || block.maxHeight || edit.size * 1.25;
  const lines0 = Math.max(1, Math.round((boxH - edit.size) / leading0) + 1);
  const drawnFootprint = [
    base[0],
    base[1] - (lines0 - 1) * leading0 - edit.size * 0.3,
    base[0] + (edit.maxWidth || block.maxWidth || 10),
    base[1] + edit.size * 1.1,
  ];
  // Frozen at the first commit, widened on every later commit to cover what this
  // edit drew. The original text's footprint is the region we are allowed to
  // delete from; the replacement's own lines must go with it or the file ends up
  // holding both strings.
  edit.exciseRect = existing
    ? rectUnion(existing.exciseRect || block.coverRect, drawnFootprint)
    : block.coverRect.slice();

  // Overset, computed from the same wrapping the writer will use. A frame is an
  // outer ink constraint: if the story needs more lines than the frame can hold,
  // that is reported here rather than discovered as text silently clipped out of
  // view in some other reader.
  //
  // This must mirror pdfwrite.js applyTextEdit exactly. The writer hard-wraps
  // EVERY block at its box width — line mode included, because "rejects
  // wrapping" only means the user cannot author a soft wrap, it does not license
  // the writer to run text off the page. Computing overset any other way here
  // would let the live badge and the Composition readout disagree with the file
  // they are describing. (At save time the writer overwrites these three fields
  // with its own font-accurate numbers; this is the on-screen estimate.)
  const overMeasure = measureFor({ fontFamily: edit.fontFamily }, edit.size || 11);
  const overLines = wrapBlockText(text, edit.maxWidth || block.maxWidth || 10, overMeasure);
  const overBoxH = edit.maxHeight || block.maxHeight || (edit.size || 11) * 1.25;
  const fitN = fitCount(overLines, overBoxH, edit.size || 11, edit.lineHeight || (edit.size || 11) * 1.2);
  edit.consumed = fitN;
  edit.total = overLines.length;
  edit.overset = fitN < overLines.length
    ? { text: overLines.slice(fitN).join('\n'), lines: overLines.length - fitN }
    : null;

  if (existing && !BLOCK_FIELDS.some((k) => JSON.stringify(edit[k]) !== JSON.stringify(existing[k]))) return false;
  // New edits land on the active layer; a re-edit keeps the layer its edit
  // already belongs to (the context panel can move it explicitly).
  if (existing) edit.layer = existing.layer || edit.layer || null;
  else edit.layer = doc.activeLayer || null;
  if (existing) Object.assign(existing, edit);
  else doc.textEdits.push(edit);
  pushHistory(options.label || 'direct edit');
  // A Direct Editor commit IS a text box laid over the original text — never a
  // removal of the model record. The edit record keeps the mapping back to the
  // original run (so text extraction, search and re-editing still resolve it),
  // while the box becomes the thing on screen and in the file: selectable,
  // movable, restylable, deletable, and saved as a real /FreeText annotation.
  //
  // A THREADED story (two or more frames) is the exception: it is composed by
  // the writer into its frame chain, so it carries no single box — one box could
  // not express text continuing onto another page.
  const boxId = (edit.frames && edit.frames.length > 1) ? null : syncEditBox(doc, edit, pageIndex);
  if (boxId) state.selection = [boxId];
  renderPageAnnotations(pageIndex);
  emit('annots');
  emit('selection');
  return true;
}

/**
 * "Make paragraph" — declare several source selections ONE logical text
 * sequence in one frame.
 *
 * The reading order is the order of `blockIndices`, and `opts.separators[i]` is
 * what joins item i to item i+1: `' '` for a soft source wrap, `'\n'` for an
 * intentional break, `''` for a fragment the producer split rather than the
 * author. This function obeys that decision — it never invents one, and it never
 * strips a final hyphen on its own, because a discretionary split may be
 * rejoined while a genuine compound word must keep its hyphen, and only the user
 * can tell which is which.
 *
 * The frame is the union of the original ink bounds: a PROPOSAL, not
 * necessarily the paragraph width the user wants, and adjustable afterwards.
 */
export async function mergeBlocksIntoParagraph(pageIndex, blockIndices, opts = {}) {
  const doc = activeDoc();
  if (!doc) return false;
  const blocks = await editableBlocks(pageIndex);
  const picks = (blockIndices || []).map((i) => blocks[i]).filter(Boolean);
  if (!picks.length) return false;
  if (picks.length === 1) {
    const b = picks[0];
    return commitBlockEdit(pageIndex, b, opts.text ?? blockText(doc, pageIndex, b), { ...opts, mode: 'flow' });
  }
  const items = picks.map((b) => {
    const prior = editForBlock(doc, pageIndex, b);
    return {
      text: prior ? prior.text : b.text,
      page: pageIndex,
      coverRect: b.coverRect,
      itemIndices: b.itemIndices,
      lineIds: b.lineIds,
      style: {
        size: prior?.size || b.size, leading: prior?.lineHeight || b.lineHeight,
        fontFamily: prior?.fontFamily || b.fontFamily, color: prior?.color || b.color,
      },
      original: b.text,
    };
  });
  let rect = picks[0].coverRect.slice();
  for (const b of picks.slice(1)) rect = rectUnion(rect, b.coverRect);
  const story = mergeStories(items, {
    frame: { page: pageIndex, rect },
    separators: opts.separators || [],
    text: opts.text ?? null,
    align: opts.align,
  });
  const first = picks[0];
  // A synthetic block carries the whole merged selection through the ordinary
  // commit path: every source item's indices are in it, so re-opening the
  // paragraph from ANY of its original lines resolves back to this one story.
  const synthetic = {
    ...first,
    key: `p:${pageIndex}:${story.sourceRefs.itemIndices.join('.')}`,
    itemIndices: story.sourceRefs.itemIndices.slice(),
    lineIds: story.sourceRefs.lineIds.slice(),
    coverRect: rect,
    rect: rect.slice(),
    text: story.text,
    maxWidth: Math.max(10, rect[2] - rect[0]),
    maxHeight: Math.max(10, rect[3] - rect[1]),
    lineHeight: story.style.leading,
    size: story.style.size,
    fontFamily: story.style.fontFamily,
  };
  return commitBlockEdit(pageIndex, synthetic, story.text, {
    ...opts, mode: 'flow',
    frames: [{ page: pageIndex, rect: rect.slice() }],
    // Excise each source rect separately, never one big union: the user may have
    // selected lines 1 and 3 and skipped line 2, and a union would delete a line
    // the replacement does not contain.
    sourceRects: picks.map((b) => b.coverRect.slice()),
    label: opts.label || 'make paragraph',
  });
}

/**
 * "Link frames" — give a committed story an explicitly ordered chain of
 * destination frames. Text composes into frame 1, then continues from the exact
 * logical position into frame 2, and so on; the frames may sit on different
 * pages and are never merged into one rectangle.
 *
 * A threaded story stops carrying a text box: one box cannot express text that
 * continues onto another page, so the writer composes it into the frame chain
 * instead.
 */
export async function threadEditFrames(eid, frames, opts = {}) {
  const doc = activeDoc();
  const ed = doc?.textEdits.find((x) => x.id === eid);
  if (!ed) return false;
  const story = threadStory(storyFromEdit(ed), frames);
  if (!story || !story.frames.length) return false;
  ed.frames = story.frames.map((f) => ({ page: f.page, rect: f.rect.slice() }));
  ed.mode = 'flow';
  if (ed.frames.length > 1 && ed.boxId) {
    // Drop the single-frame box so the writer takes the framed path.
    const boxId = ed.boxId;
    doc.annots = doc.annots.filter((a) => a.id !== boxId);
    ed.boxId = null;
    state.selection = state.selection.filter((id) => id !== boxId);
  } else if (ed.frames.length === 1 && !ed.boxId) {
    // Collapsing back to one frame restores the in-place representation: a
    // single-frame edit is drawn by its own text box, so without this the story
    // would have nothing on screen and no way back into its panel.
    syncEditBox(doc, ed, ed.page);
  }
  // Keep the story selected across the change, so the panel that carries the
  // Link / Unlink controls does not vanish the instant it is used.
  state.selection = [ed.id];
  pushHistory(opts.label || 'link frames');
  for (const f of ed.frames) renderPageAnnotations(f.page);
  emit('annots');
  return true;
}

/** Compose a committed edit without mutating anything — the "preview" step the
 *  research insists the UI must show before an export. */
export function previewEditLayout(eid) {
  const doc = activeDoc();
  const ed = doc?.textEdits.find((x) => x.id === eid);
  if (!ed) return null;
  const story = storyFromEdit(ed);
  const measure = measureFor({ fontFamily: ed.fontFamily }, ed.size || 11);
  return layoutStory(story, measure);
}

/** Keep the text box that represents an edit in step with the edit itself.
 *
 *  One box per block: the id is stored on the edit, so re-editing the same
 *  block updates that box instead of stacking a second one over it. Additive
 *  agent text (`bg: null`) is deliberately excluded — it is new text on blank
 *  page, not a replacement, and has no original to sit on. */
function syncEditBox(doc, edit, pageIndex) {
  if (!edit.bg) return null;
  const rect = textEditDrawBox(edit);
  if (!rect) return null;
  const patch = {
    type: 'textbox',
    page: pageIndex,
    rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]),
      Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])],
    text: edit.text || '',
    fontFamily: edit.fontFamily || 'Helvetica',
    fontSize: edit.size || 11,
    textColor: edit.color || [0, 0, 0],
    align: edit.align || 'left',
    bold: !!edit.bold, italic: !!edit.italic, underline: !!edit.underline,
    charSpacing: edit.charSpacing || 0,
    hScale: edit.hScale || 100,
    lineHeight: edit.lineHeight || (edit.size || 11) * 1.2,
    // No border and no fill: the box is the TEXT, sitting on the wash that
    // hides the original. A filled card here would put a second opaque patch
    // on the page and a border would draw a frame nobody asked for.
    borderWidth: 0,
    fill: null,
    opacity: 1,
    // /C is mandatory for every annotation dict, border or not — without it
    // the writer throws and the box never reaches the file.
    color: [0, 0, 0],
    directEdit: edit.id,
  };
  let box = edit.boxId ? doc.annots.find((a) => a.id === edit.boxId) : null;
  if (box) { Object.assign(box, patch); return box.id; }
  box = {
    id: uid('an'), author: settings.author || 'User', date: new Date().toISOString(),
    created: new Date().toISOString(), fromFile: false, flags: 4, ...patch,
  };
  doc.annots.push(box);
  edit.boxId = box.id;
  return box.id;
}

/** Shared wrapping policy: the block's own width, the block's own font. */
function measureFor(block, size) {
  const canvas = document.createElement('canvas').getContext('2d');
  canvas.font = cssFont(size, block.fontFamily);
  return (s) => canvas.measureText(s).width;
}

/**
 * What will actually draw this block's text, and what it cannot draw.
 *
 * Replaces the old name-existence check. Knowing that a family is installed
 * says nothing about whether it holds the glyphs, and that gap is exactly how
 * non-WinAnsi text reached the saved file as literal 0x3F: the editor reported
 * the font as fine, then Standard-14 quietly substituted question marks.
 *
 * `missing` is the list the user has to see before committing, not after.
 */
async function probeFontCapability(family, text, bytes) {
  const resolved = await resolveFontFor(family, text, bytes);
  let installed = /^(helvetica|times|courier|symbol|zapfdingbats)/i.test(String(family || '')) || isUserFont(family);
  if (!installed) {
    try {
      const list = await listSystemFonts(false);
      const faces = (list && list.faces) || [];
      installed = faces.some((x) => String(x.family || '').toLowerCase() === String(family || '').toLowerCase());
    } catch { /* no font index — coverage is the signal that matters */ }
  }
  return { ...resolved, installed };
}

/** Renders a missing-glyph list as something a person can read, capped so a
 *  whole paragraph of unsupported script does not flood the dialog. */
function describeMissing(missing) {
  const shown = missing.slice(0, 12).map((c) => `"${c}" U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  const rest = missing.length - shown.length;
  return shown.join(', ') + (rest > 0 ? `, and ${rest} more` : '');
}

/**
 * Direct Editor — edit a text block in place, on the page.
 *
 * The surface is positioned over the block and styled to match it, so what you
 * type appears where the text actually is. This replaces the old floating
 * textarea: that was a box *next to* the text, which is not how Acrobat edits
 * and forces the user to keep looking back and forth.
 *
 * opts.clientX/clientY put the caret where the user clicked, so clicking the
 * middle of a word lands the caret in the middle of that word.
 */
/**
 * Ask what the text should say, before any editing starts.
 *
 * The editor used to open with the caret sitting inside the text the detector
 * had guessed at, so the very first keystroke silently threw that guess away —
 * and with a table cell, "that guess" is a whole cell's contents. When the text
 * IS detected there is something concrete to confirm, so show it, let the user
 * correct it or accept it, and only then open the editor. A block whose text
 * cannot be detected has nothing to confirm and goes straight to the editor.
 *
 * Resolves to the confirmed string, or `null` if the user cancelled — a
 * cancelled ask must leave the document completely untouched, not open an
 * editor the user has already backed out of.
 */
function askEditText({ text, where, multiline }) {
  let value = text;
  return showModal({
    title: 'Edit text',
    width: 'narrow',
    body: (b) => {
      b.appendChild(el('div', { class: 'hint', text: where, style: { marginBottom: '8px' } }));
      const ta = el('textarea', {
        class: 'de-ask-text', rows: multiline ? 4 : 1, spellcheck: 'false',
        style: { width: '100%', resize: 'vertical', font: 'inherit', lineHeight: '1.45' },
      });
      ta.value = text;
      ta.addEventListener('input', () => { value = ta.value; });
      // Enter means "apply" for a single line. For multi-line text Enter has to
      // stay a newline, exactly as it does in the editor itself, so applying
      // there is Ctrl+Enter (handled by the modal).
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !multiline) {
          e.preventDefault();
          e.stopPropagation();
          b.closest('.modal')?.querySelector('button.primary')?.click();
        }
      });
      b.appendChild(ta);
      b.appendChild(el('div', {
        class: 'hint',
        text: multiline ? 'Enter starts a new line · Ctrl+Enter applies' : 'Enter applies · Esc cancels',
        style: { marginTop: '6px' },
      }));
      setTimeout(() => { ta.focus(); ta.select(); }, 30);
    },
    buttons: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Edit', value: true, kind: 'primary', default: true },
    ],
  }).then((ok) => (ok ? value : null));
}

export async function openDirectEditor(pageIndex, blockIndex, opts = {}) {
  closeActive();
  const doc = activeDoc(), rec = pageEl(pageIndex);
  if (!doc || !rec) return null;
  const blocks = await editableBlocks(pageIndex);
  const block = blocks[blockIndex];
  if (!block || doc !== activeDoc()) return null;

  // A block inside a recognised table is edited as a CELL: the editor and the
  // written frame use the cell rect, so text wraps inside the cell and the
  // overset model reports a too-small cell instead of spilling into the next.
  const tables = pageTables(pageIndex, blocks);
  const cellHit = tableForBlock(tables, blockIndex);
  const cell = cellHit?.cell || null;

  const existing = editForBlock(doc, pageIndex, block);

  /* Confirm the text before editing it. Only for a block that is still the
   * ORIGINAL source: once an edit exists its text was authored by the user, so
   * asking again would be asking them to confirm their own typing. */
  const detected = blockText(doc, pageIndex, block);
  let seeded = detected;
  if (!existing && String(detected).trim() && opts.askText !== false) {
    const where = cell
      ? `Detected text on page ${pageIndex + 1}, ${tableLabel(cellHit.table, cell, tables.indexOf(cellHit.table))}. Change it, or apply it as it is.`
      : `Detected text on page ${pageIndex + 1}. Change it, or apply it as it is.`;
    const asked = await askEditText({ text: detected, where, multiline: String(detected).includes('\n') });
    if (asked == null) return null;                 // cancelled — touch nothing
    if (doc !== activeDoc()) return null;           // document swapped under us
    seeded = asked;
  }

  const s = currentScale();
  // A block the user dragged away edits where it NOW is, not where its
  // original text was — otherwise committing would teleport it back.
  const movedBox = existing?.baseline && block.baseline
    && (existing.baseline[0] !== block.baseline[0] || existing.baseline[1] !== block.baseline[1])
    ? textEditDrawBox(existing) : null;
  const r = cell ? cell.rect : (movedBox || block.coverRect);
  const a = toCss(pageIndex, r[0], r[3]);
  const b = toCss(pageIndex, r[2], r[1]);
  const left = Math.min(a.x, b.x), top = Math.min(a.y, b.y);

  // Mutable box, in points — the handles below edit these. In a table the box
  // starts as the cell, so the editor's footprint and the written frame agree.
  let width = cell ? (cell.rect[2] - cell.rect[0]) : (existing?.maxWidth || block.maxWidth);
  let height = cell ? (cell.rect[3] - cell.rect[1]) : (existing?.maxHeight || block.maxHeight);
  const size = existing?.size || block.size;
  const family = existing?.fontFamily || block.fontFamily;
  const color = existing?.color || block.color;
  const align = existing?.align || 'left';
  const lineHeight = existing?.lineHeight || block.lineHeight;
  const charSpacing = existing?.charSpacing || 0;
  const hScale = existing?.hScale || 100;

  pendingFormat = null;
  const spacing = (existing?.lineHeight || block.lineHeight) / size;
  const overlay = el('div', { class: 'direct-editor',
    dataset: {
      size: String(size), lineSpacing: String(+spacing.toFixed(3)),
      ...(cell ? { table: cellHit.table.id, row: String(cell.row), col: String(cell.col) } : {}),
    },
    style: { left: left + 'px', top: top + 'px',
      width: Math.max(24, width * s) + 'px', minHeight: Math.max(16, height * s) + 'px' } });
  const surface = el('div', { class: 'direct-editor-surface', contenteditable: 'plaintext-only',
    spellcheck: 'false',
    style: { fontFamily: cssFontStack(family), fontSize: (size * s) + 'px',
      lineHeight: (lineHeight * s) + 'px', color: rgbToCss(color, 1),
      textAlign: align, letterSpacing: (charSpacing * s) + 'px' } });
  if (hScale !== 100) surface.style.transform = `scaleX(${hScale / 100})`;
  surface.textContent = seeded;
  overlay.appendChild(surface);
  if (cell) {
    overlay.appendChild(el('div', { class: 'de-table-tag',
      text: tableLabel(cellHit.table, cell, tables.indexOf(cellHit.table)) }));
  }

  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    overlay.appendChild(el('div', { class: `de-handle ${corner}`, dataset: { corner }, title: 'Drag to resize the block' }));
  }

  const note = el('div', { class: 'direct-editor-note' });
  overlay.appendChild(note);
  const say = (msg, kind) => { note.textContent = msg; note.dataset.kind = kind || ''; };
  say('Typing directly on the page · Enter = new line · Esc = cancel · Ctrl+Enter or click away = apply');

  // Acrobat's font guard, but based on glyph coverage rather than on whether a
  // family of that name happens to be installed. Said once, when the editor
  // opens, rather than discovered in the saved file.
  let fontCap = await probeFontCapability(family, surface.textContent, doc.bytes);
  if (fontCap.missing.length) {
    say(`"${family}" cannot draw ${describeMissing(fontCap.missing)} — they would be saved as "?" characters. Choose a font in the panel on the right, or keep the original text.`, 'warn');
  } else if (!fontCap.installed && fontCap.source === 'standard14') {
    say(`"${family}" is not available on this machine — a substitute will be used. Pick a font in the panel on the right to choose one yourself.`, 'warn');
  }

  rec.wrap.appendChild(overlay);
  activeEditor = overlay;
  // Tell the shell a Direct Editor session started, so the properties panel
  // switches to the Format list rather than whatever object was selected.
  emit('directEditor', true);

  surface.focus();
  placeCaret(surface, opts);

  /* ── Resize handles ─────────────────────────────────────────────────── */
  let drag = null;
  overlay.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.de-handle');
    if (!h) return;
    e.preventDefault();
    e.stopPropagation();
    drag = { corner: h.dataset.corner, x: e.clientX, y: e.clientY, w: width, h: height };
    h.setPointerCapture?.(e.pointerId);
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = (e.clientX - drag.x) / s, dy = (e.clientY - drag.y) / s;
    width = Math.max(20, drag.w + (/e$/.test(drag.corner) ? dx : -dx));
    height = Math.max(size * 1.1, drag.h + (/^s/.test(drag.corner) ? dy : -dy));
    overlay.style.width = (width * s) + 'px';
    overlay.style.minHeight = (height * s) + 'px';
  });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    e?.stopPropagation?.();
  };
  overlay.addEventListener('pointerup', endDrag);
  overlay.addEventListener('pointercancel', endDrag);

  /* ── Commit / cancel ────────────────────────────────────────────────── */
  const readText = () => {
    // innerText, not textContent: textContent drops the line breaks Enter
    // creates, while innerText keeps them and — unlike a plain textarea — does
    // not invent breaks at soft wrap points.
    return String(surface.innerText || '').replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  };

  let committing = false;

  const commit = async () => {
    // commit() is also fired by the document-level pointerdown that applies the
    // edit on a click-away. The coverage dialog below is not inside `overlay`,
    // so its own clicks would re-enter commit and stack dialogs.
    if (committing) return;
    committing = true;
    try {
      await commitInner();
    } finally {
      committing = false;
    }
  };

  const commitInner = async () => {
    const text = readText();
    const fmt = pendingFormat || {};
    // The panel may have changed the font, and coverage is a property of the
    // font that will actually draw the text — so resolve it first and probe
    // that one, not the family the block opened with.
    const finalFamily = fmt.fontFamily || family;
    // Re-probe against the text being committed, not the text the block opened
    // with: the user may have typed a character the original never contained.
    fontCap = await probeFontCapability(finalFamily, text, doc.bytes);
    if (fontCap.missing.length) {
      const proceed = await confirmDialog(
        `"${finalFamily}" has no glyph for ${describeMissing(fontCap.missing)}.`
        + '\n\nSaving now would write those characters into the file as "?" — they cannot be recovered afterwards.'
        + '\n\nPick a different font in the panel on the right to keep them, or continue and accept the loss.',
        { okLabel: 'Save with "?" replacements', cancelLabel: 'Keep editing', danger: true },
      );
      if (!proceed) { surface.focus(); return; }
    }
    const finalSize = fmt.size != null ? fmt.size : size;
    const spacing = fmt.lineSpacing != null ? Number(fmt.lineSpacing) : Number(overlay.dataset.lineSpacing || 1.2);
    const leading = leadingFor(finalSize, spacing);
    // Measure with the font that will be written, or a substituted face wraps
    // at the wrong widths and the saved lines disagree with the preview.
    const measure = (t) => measureFor({ fontFamily: finalFamily }, finalSize)(t) * ((fmt.hScale != null ? fmt.hScale : hScale) / 100);
    const lines = wrapBlockText(text, width, measure);
    // Acrobat lets a block grow as you type instead of refusing the edit, so
    // take the larger of the measured box and what the text now needs. Only the
    // *excision* rect stays frozen — see commitBlockEdit.
    const needed = (lines.length - 1) * leading + finalSize * 1.25;
    const maxHeight = Math.max(height, needed);
    const anchorX = (existing?.baseline || block.baseline)[0];
    const maxWidth = clamp(width, 20, Math.max(20, doc.pageSizes[pageIndex].w - anchorX));
    await commitBlockEdit(pageIndex, block, text, {
      size: finalSize, color: fmt.color || color, maxWidth, maxHeight, fontFamily: finalFamily,
      align: fmt.align, bold: fmt.bold, italic: fmt.italic, underline: fmt.underline,
      lineHeight: leading, charSpacing: fmt.charSpacing, hScale: fmt.hScale,
      // A cell is a one-frame flow story: the frame IS the cell, so the writer
      // wraps inside it and reports overset when the text cannot fit.
      ...(cell ? {
        mode: 'flow',
        frames: [{ page: pageIndex, rect: cell.rect }],
        table: {
          id: cellHit.table.id, row: cell.row, col: cell.col,
          rows: cellHit.table.rows.length, cols: cellHit.table.cols.length,
        },
      } : {}),
    });
    closeActive();
  };

  surface.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeActive(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void commit(); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Let the browser insert the line break, but keep it a plain one:
      // contenteditable would otherwise wrap it in a <div> and lose the
      // paragraph semantics on the way back out through innerText.
      e.preventDefault();
      insertNewline(surface);
    }
  });

  // Clicking anywhere else applies the edit, which is Acrobat's behaviour.
  // Deferred by a tick so the click that opened the editor cannot close it.
  //
  // "Anywhere else" means the PAGE, not the whole window. This listener used to
  // take every pointerdown that was not inside `overlay`, so reaching for the
  // Font / Size / Colour control in the properties panel committed the edit and
  // tore the editor down before the control could act — the panel then wrote to
  // the persisted defaults via applyDirectFormat's no-editor branch, and the
  // block on screen never changed. That is the whole "in Direct Editor I can
  // only type and move" symptom. Chrome (ribbon, menubar, panels, dialogs) is
  // not a click-away; only the document surface is.
  const onDocDown = (e) => {
    if (overlay.contains(e.target)) return;
    if (isChrome(e.target)) return;
    void commit();
  };
  setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
  activeEditorCleanup = () => document.removeEventListener('pointerdown', onDocDown, true);

  return { commit, cancel: closeActive, el: overlay };
}

/** Re-open the Direct Editor from a committed (possibly moved) text block. */
export async function openEditorForEdit(pageIndex, eid, opts = {}) {
  const doc = activeDoc();
  const ed = doc?.textEdits.find((x) => x.id === eid);
  if (!ed) return null;
  const blocks = await editableBlocks(pageIndex);
  let bi = ed.key ? blocks.findIndex((b) => b.key === ed.key) : -1;
  if (bi < 0 && ed.itemIndices?.length) {
    const ids = new Set(ed.itemIndices);
    bi = blocks.findIndex((b) => b.itemIndices?.some((k) => ids.has(k)));
  }
  if (bi < 0) {
    toast('That block\u2019s original text is gone — the block can still be dragged or deleted.', 'warn');
    return null;
  }
  return openDirectEditor(pageIndex, bi, opts);
}

/** Put the caret where the pointer went down, so clicking mid-word works. */
function placeCaret(surface, opts) {
  const sel = window.getSelection();
  if (!sel) return;
  let range = null;
  if (opts.clientX != null && document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(opts.clientX, opts.clientY);
    if (r && surface.contains(r.startContainer)) range = r;
  }
  if (!range) {
    // No usable hit point: select the whole block, which is what Acrobat does
    // when you click a block without aiming inside it.
    range = document.createRange();
    range.selectNodeContents(surface);
  }
  sel.removeAllRanges();
  sel.addRange(range);
  if (range.collapsed) surface.focus();
}

function insertNewline(surface) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const br = document.createElement('br');
  range.insertNode(br);
  range.setStartAfter(br);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

/* ── Format panel bridge ───────────────────────────────────────────────────
 * Acrobat's Format list acts on the selection; with nothing selected it sets
 * the style that new text will use. Same rule here: while Direct Editor is open
 * the panel retypes the live surface, and otherwise it edits the persisted
 * defaults that the next block inherits. */

let pendingFormat = null;

/** True while a Direct Editor session is on screen. Deliberately specific: the
 *  legacy per-span editor shares `activeEditor` but has no Format surface, and
 *  the panel must not switch to the Direct Editor Format list for it. */
export function directEditorOpen() {
  return !!(activeEditor && activeEditor.querySelector('.direct-editor-surface'));
}

/** Shell furniture, not page surface. A pointerdown here must never be read as
 *  "the user clicked away" — see onDocDown in openDirectEditor. Kept as one
 *  list so the ribbon, the panels, the status bar, floating dialogs and the
 *  command palette are all covered by the same rule. */
function isChrome(node) {
  if (!node || typeof node.closest !== 'function') return false;
  return !!node.closest('#ribbon, #context, #sidebar, #rail, .menubar, .statusbar,'
    + ' #overlayRoot, .titlebar, .palette, .modal, .dialog, .toast-root');
}

/** The format the open editor is actually using — the block's own values with
 *  any pending panel changes merged in. The properties panel seeds its controls
 *  from this, so opening a 24pt Times block shows 24pt Times rather than the
 *  house default (which is what made the controls look inert: they read back a
 *  value the block did not have, and changed a block that was not on screen). */
export function directEditorState() {
  if (!directEditorOpen()) return null;
  const surface = activeEditor.querySelector('.direct-editor-surface');
  const spacing = Number(activeEditor.dataset.lineSpacing) || 1.2;
  const size = Number(activeEditor.dataset.size) || 11;
  // The CSS font stack is "<family>, Helvetica, Arial, sans-serif"; take the
  // first entry back out rather than showing the whole stack.
  const family = String(surface.style.fontFamily || '').split(',')[0].trim() || 'Helvetica';
  const hex = (css) => {
    const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(css || '');
    if (!m) return settings.textColor || '#14171f';
    return rgbToHex([Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255]);
  };
  return {
    fontFamily: (pendingFormat && pendingFormat.fontFamily) || family,
    size: (pendingFormat && pendingFormat.size) || size,
    color: (pendingFormat && pendingFormat.color) || hexToRgb(hex(surface.style.color)),
    colorHex: hex(surface.style.color),
    align: (pendingFormat && pendingFormat.align) || surface.style.textAlign || 'left',
    bold: (pendingFormat && pendingFormat.bold) != null
      ? !!pendingFormat.bold : (surface.style.fontWeight === '700' || surface.style.fontWeight === 'bold'),
    italic: (pendingFormat && pendingFormat.italic) != null
      ? !!pendingFormat.italic : surface.style.fontStyle === 'italic',
    underline: (pendingFormat && pendingFormat.underline) != null
      ? !!pendingFormat.underline : /underline/.test(surface.style.textDecoration || ''),
    lineSpacing: (pendingFormat && pendingFormat.lineSpacing) || spacing,
    charSpacing: (pendingFormat && pendingFormat.charSpacing) || Number.parseFloat(surface.style.letterSpacing) || 0,
    hScale: (pendingFormat && pendingFormat.hScale) || 100,
  };
}

/** Line spacing is edited as a multiple of the font size, which is what both
 *  Acrobat and CSS line-height expose; the model stores it as a pt leading. */
const leadingFor = (size, spacing) => size * (spacing || 1.2);

export function applyDirectFormat(patch) {
  const surface = activeEditor && activeEditor.querySelector('.direct-editor-surface');
  if (!surface) {
    // No open editor: persist as the house style for the next block.
    if (patch.align != null) settings.textAlign = patch.align;
    if (patch.bold != null) settings.textBold = !!patch.bold;
    if (patch.italic != null) settings.textItalic = !!patch.italic;
    if (patch.underline != null) settings.textUnderline = !!patch.underline;
    if (patch.lineSpacing != null) settings.textLineSpacing = Number(patch.lineSpacing);
    if (patch.charSpacing != null) settings.textCharSpacing = Number(patch.charSpacing);
    if (patch.hScale != null) settings.textHScale = Number(patch.hScale);
    if (patch.size != null) settings.textSize = Number(patch.size);
    if (patch.color != null) settings.textColor = rgbToHex(patch.color);
    if (patch.fontFamily != null) settings.textFont = patch.fontFamily;
    saveSettings();
    return false;
  }
  const s = currentScale();
  const size = patch.size != null ? patch.size : Number(activeEditor.dataset.size || 11);
  if (patch.fontFamily != null) surface.style.fontFamily = cssFontStack(patch.fontFamily);
  if (patch.align != null) surface.style.textAlign = patch.align;
  if (patch.bold != null) surface.style.fontWeight = patch.bold ? '700' : '';
  if (patch.italic != null) surface.style.fontStyle = patch.italic ? 'italic' : '';
  if (patch.underline != null) surface.style.textDecoration = patch.underline ? 'underline' : '';
  if (patch.charSpacing != null) surface.style.letterSpacing = (Number(patch.charSpacing) * s) + 'px';
  if (patch.hScale != null) surface.style.transform = Number(patch.hScale) === 100 ? '' : `scaleX(${Number(patch.hScale) / 100})`;
  if (patch.size != null) { surface.style.fontSize = (patch.size * s) + 'px'; activeEditor.dataset.size = String(patch.size); }
  if (patch.color != null) surface.style.color = rgbToCss(patch.color, 1);
  if (patch.lineSpacing != null) {
    activeEditor.dataset.lineSpacing = String(patch.lineSpacing);
    surface.style.lineHeight = (leadingFor(size, patch.lineSpacing) * s) + 'px';
  }
  pendingFormat = { ...pendingFormat, ...patch };
  return true;
}

let activeEditorCleanup = null;

function closeActive() {
  if (!activeEditor) return;
  const wasDirect = !!activeEditor.querySelector('.direct-editor-surface');
  if (activeEditorCleanup) { try { activeEditorCleanup(); } catch { /* already gone */ } }
  activeEditorCleanup = null;
  activeEditor.remove();
  activeEditor = null;
  if (wasDirect) emit('directEditor', false);
}

/* ── In-place editing of existing PDF text ──────────────────────────────── */

export async function startTextEdit(pageIndex, span, opts = {}) {
  closeActive();
  const doc = activeDoc();
  const rec = pageEl(pageIndex);
  if (!doc || !rec) return;

  const idx = Number(span.dataset.item);
  const blockIndex = (await editableBlocks(pageIndex)).findIndex((b) => b.itemIndices.includes(idx));
  // A click that lands inside a detected block edits the whole block in place;
  // only runs that resist grouping fall through to the single-run editor.
  if (blockIndex >= 0) return openDirectEditor(pageIndex, blockIndex, { clientX: opts.clientX, clientY: opts.clientY });
  const tc = await getTextContent(pageIndex);
  const item = tc.items[idx];
  if (!item) return;
  const style = tc.styles[item.fontName] || {};
  const tx = item.transform;
  const size = Math.hypot(tx[2], tx[3]);
  const angleDeg = (Math.atan2(tx[1], tx[0]) * 180) / Math.PI;
  const baseline = [tx[4], tx[5]];
  const family = style.fontFamily || 'Helvetica';
  const sampled = sampleTextColor(pageIndex, span.getBoundingClientRect(), rec.wrap.getBoundingClientRect());

  // CSS-space box of the run (page-local)
  const wrapRect = rec.wrap.getBoundingClientRect();
  const sr = span.getBoundingClientRect();
  const cssRect = [sr.left - wrapRect.left, sr.top - wrapRect.top, sr.right - wrapRect.left, sr.bottom - wrapRect.top];
  const s = currentScale();

  // PDF-space axis-aligned cover rect
  const c0 = toPdf(pageIndex, cssRect[0], cssRect[1]);
  const c1 = toPdf(pageIndex, cssRect[2], cssRect[3]);
  const pad = 1 / s;
  const rect = [Math.min(c0.x, c1.x) - pad, Math.min(c0.y, c1.y) - pad, Math.max(c0.x, c1.x) + pad, Math.max(c0.y, c1.y) + pad];

  const overlay = el('div', {
    style: {
      position: 'absolute',
      left: cssRect[0] + 'px', top: cssRect[1] + 'px',
      width: Math.max(30, cssRect[2] - cssRect[0]) + 'px',
      minHeight: Math.max(14, cssRect[3] - cssRect[1]) + 'px',
      zIndex: 'var(--z-float)',
    },
  });

  const input = el('textarea', {
    spellcheck: 'false',
    style: {
      width: '100%', minWidth: '120px', minHeight: '100%', padding: '0', margin: '0',
      border: '1px solid var(--accent)', borderRadius: '2px', outline: 'none', resize: 'none',
      background: '#fff', overflow: 'hidden',
      fontFamily: `${family}, Helvetica, Arial, sans-serif`,
      fontSize: (size * s) + 'px',
      lineHeight: '1.15',
      color: rgbToCss(sampled, 1),
      boxSizing: 'border-box',
    },
  });
  input.value = item.str;
  overlay.appendChild(input);

  const bar = el('div', {
    style: {
      position: 'absolute', left: '0', top: '100%', marginTop: '4px',
      display: 'flex', gap: '4px', alignItems: 'center',
      background: 'var(--panel)', border: '1px solid var(--border)',
      borderRadius: '6px', padding: '4px', boxShadow: 'var(--shadow-2)', zIndex: 'var(--z-float)',
    },
  });
  const sizeInput = el('input', { type: 'number', value: (size).toFixed(1), step: '0.5', style: { width: '52px', height: '24px' } });
  const colorInput = el('input', { type: 'color', value: rgbToHex(sampled), style: { width: '26px', height: '24px', padding: '0' } });
  const ok = el('button', { class: 'mini-btn primary', text: 'Apply' });
  const cancel = el('button', { class: 'mini-btn', text: 'Cancel' });
  bar.append(el('span', { class: 'hint', text: 'pt' }), sizeInput, colorInput, ok, cancel);
  overlay.appendChild(bar);

  rec.wrap.appendChild(overlay);
  activeEditor = overlay;
  setTimeout(() => { input.focus(); input.select(); }, 10);

  const autosize = () => {
    input.style.height = 'auto';
    input.style.height = Math.max(cssRect[3] - cssRect[1], input.scrollHeight) + 'px';
  };
  input.oninput = autosize;
  autosize();

  const commit = () => {
    const newText = input.value;
    closeActive();
    if (newText === item.str) return;
    const fontSize = parseFloat(sizeInput.value) || size;
    doc.textEdits.push({
      id: 'te' + Math.random().toString(36).slice(2, 8),
      page: pageIndex,
      layer: doc.activeLayer || null,
      rect,
      baseline,
      size: fontSize,
      angle: angleDeg,
      fontFamily: family,
      color: hexToRgb(colorInput.value),
      bg: [1, 1, 1],
      text: newText,
      original: item.str,
    });
    pushHistory('edit text');
    renderPageAnnotations(pageIndex);
    emit('annots');
  };
  ok.onclick = commit;
  cancel.onclick = () => { closeActive(); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); closeActive(); }
  };
}

/** Guess the glyph colour by sampling the rendered canvas under the run. */
function sampleTextColor(pageIndex, spanRect, wrapRect) {
  const rec = pageEl(pageIndex);
  if (!rec || !rec.canvas || !rec.canvas.width) return [0, 0, 0];
  const cw = rec.canvas.width, ch = rec.canvas.height;
  const sx = cw / wrapRect.width, sy = ch / wrapRect.height;
  const x = Math.max(0, Math.floor((spanRect.left - wrapRect.left) * sx));
  const y = Math.max(0, Math.floor((spanRect.top - wrapRect.top) * sy));
  const w = Math.max(1, Math.min(cw - x, Math.floor(spanRect.width * sx)));
  const h = Math.max(1, Math.min(ch - y, Math.floor(spanRect.height * sy)));
  try {
    const data = rec.canvas.getContext('2d').getImageData(x, y, w, h).data;
    const counts = new Map();
    for (let k = 0; k < data.length; k += 4) {
      const r = data[k], g = data[k + 1], b = data[k + 2];
      if (r > 235 && g > 235 && b > 235) continue;
      const key = `${r >> 4},${g >> 4},${b >> 4}`;
      const cur = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++; cur.r += r; cur.g += g; cur.b += b;
      counts.set(key, cur);
    }
    let best = null;
    for (const v of counts.values()) if (!best || v.n > best.n) best = v;
    if (!best) return [0, 0, 0];
    return [best.r / best.n / 255, best.g / best.n / 255, best.b / best.n / 255];
  } catch {
    return [0, 0, 0];
  }
}

/**
 * Sample the dominant light colour behind a PDF-space rectangle.
 *
 * Replacing recognised text on a scan means painting over the original pixels,
 * and paper is not always white — a grey or yellowed scan, a tinted panel or a
 * form field would show a bright rectangle if the cover were hardcoded white.
 */
function sampleBackdrop(pageIndex, rect) {
  const rec = pageEl(pageIndex);
  if (!rec || !rec.canvas || !rec.canvas.width || !Array.isArray(rect)) return [1, 1, 1];
  const wrapRect = rec.wrap.getBoundingClientRect();
  const a = toCss(pageIndex, rect[0], rect[3]);
  const b = toCss(pageIndex, rect[2], rect[1]);
  const cw = rec.canvas.width, ch = rec.canvas.height;
  const sx = cw / (wrapRect.width || 1), sy = ch / (wrapRect.height || 1);
  const x = Math.max(0, Math.floor(Math.min(a.x, b.x) * sx));
  const y = Math.max(0, Math.floor(Math.min(a.y, b.y) * sy));
  const wpx = Math.max(1, Math.min(cw - x, Math.floor(Math.abs(b.x - a.x) * sx)));
  const hpx = Math.max(1, Math.min(ch - y, Math.floor(Math.abs(b.y - a.y) * sy)));
  try {
    const data = rec.canvas.getContext('2d').getImageData(x, y, wpx, hpx).data;
    const counts = new Map();
    for (let k = 0; k < data.length; k += 4) {
      const r = data[k], g = data[k + 1], bl = data[k + 2];
      const key = `${r >> 4},${g >> 4},${bl >> 4}`;
      const cur = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n++; cur.r += r; cur.g += g; cur.b += bl;
      counts.set(key, cur);
    }
    if (!counts.size) return [1, 1, 1];
    let max = 0;
    for (const v of counts.values()) if (v.n > max) max = v.n;
    // Among the colours that genuinely dominate, take the lightest: that is
    // the paper, not the ink or a dark margin.
    let best = null;
    for (const v of counts.values()) {
      if (v.n < max * 0.35) continue;
      const lum = v.r + v.g + v.b;
      if (!best || lum > best.lum) best = { ...v, lum };
    }
    if (!best) return [1, 1, 1];
    return [best.r / best.n / 255, best.g / best.n / 255, best.b / best.n / 255];
  } catch {
    return [1, 1, 1];
  }
}

/* ─‑ Editing the text of an annotation ──────────────────────────────────── */

export function openInlineTextbox(annotId, opts = {}) {
  closeActive();
  const doc = activeDoc();
  const a = doc && doc.annots.find((x) => x.id === annotId);
  if (!a) return;
  const rec = pageEl(a.page);
  if (!rec) return;
  const s = currentScale();
  const c = [toCss(a.page, a.rect[0], a.rect[3]), toCss(a.page, a.rect[2], a.rect[1])];
  const box = [Math.min(c[0].x, c[1].x), Math.min(c[0].y, c[1].y), Math.max(c[0].x, c[1].x), Math.max(c[0].y, c[1].y)];

  if (opts.note) {
    // Sticky notes: a floating composer next to the icon.
    const panel = el('div', {
      style: {
        position: 'fixed', left: clamp(opts.clientX || 200, 8, window.innerWidth - 280) + 'px',
        top: clamp(opts.clientY || 200, 8, window.innerHeight - 220) + 'px',
        width: '260px', background: 'var(--panel)', border: '1px solid var(--border)',
        borderRadius: '8px', boxShadow: 'var(--shadow-3)', padding: '8px', zIndex: 'var(--z-popover)',
      },
    });
    const ta = el('textarea', { placeholder: 'Type a comment…', style: { minHeight: '84px' } });
    ta.value = a.text || '';
    const row = el('div', { style: { display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '6px' } });
    const ok = el('button', { class: 'mini-btn primary', text: 'Save' });
    const cancel = el('button', { class: 'mini-btn', text: 'Cancel' });
    row.append(cancel, ok);
    panel.append(ta, row);
    document.getElementById('overlayRoot').appendChild(panel);
    activeEditor = panel;
    setTimeout(() => ta.focus(), 10);
    ok.onclick = () => {
      updateAnnot(a.id, { text: ta.value });
      pushHistory('note text');
      renderPageAnnotations(a.page);
      emit('annots');
      closeActive();
    };
    cancel.onclick = () => { closeActive(); renderPageAnnotations(a.page); };
    ta.onkeydown = (e) => { if (e.key === 'Escape') closeActive(); };
    return;
  }

  const overlay = el('div', {
    style: {
      position: 'absolute', left: box[0] + 'px', top: box[1] + 'px',
      width: Math.max(40, box[2] - box[0]) + 'px', height: Math.max(20, box[3] - box[1]) + 'px',
      zIndex: 'var(--z-float)',
    },
  });
  const ta = el('textarea', {
    spellcheck: 'false',
    style: {
      width: '100%', height: '100%', margin: '0', padding: '1px 3px', boxSizing: 'border-box',
      border: '1px solid var(--accent)', borderRadius: '2px', outline: 'none', resize: 'none',
      background: a.fill ? rgbToCss(a.fill, 1) : '#fff',
      fontFamily: `${a.fontFamily || 'Helvetica'}, Helvetica, Arial, sans-serif`,
      fontSize: ((a.fontSize || 11) * s) + 'px',
      lineHeight: '1.25',
      color: rgbToCss(a.textColor || [0.08, 0.09, 0.12], 1),
    },
  });
  ta.value = a.text || '';
  overlay.appendChild(ta);
  rec.wrap.appendChild(overlay);
  activeEditor = overlay;
  setTimeout(() => { ta.focus(); ta.select(); }, 10);

  const commit = () => {
    updateAnnot(a.id, { text: ta.value });
    pushHistory('annotation text');
    closeActive();
    renderPageAnnotations(a.page);
    emit('annots');
  };
  ta.onblur = () => setTimeout(commit, 0);
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeActive(); renderPageAnnotations(a.page); }
  };
}

/**
 * Replace the currently selected document text with `newText`.
 * Used by the AI rewrite flow; returns true when a text edit was recorded.
 */
export async function createTextEditFromSelection(newText) {
  const doc = activeDoc();
  const sel = window.getSelection();
  if (!doc || !sel || sel.isCollapsed || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  const pageDiv = range.commonAncestorContainer?.nodeType === 1
    ? range.commonAncestorContainer.closest('.page')
    : range.commonAncestorContainer.parentElement?.closest('.page');
  if (!pageDiv) return false;
  const i = Number(pageDiv.dataset.i);
  const rec = pageEl(i);
  if (!rec) return false;

  const spans = Array.from(rec.textLayer.querySelectorAll('span'))
    .filter((s) => range.intersectsNode(s));
  if (!spans.length) return false;

  const tc = await getTextContent(i);
  const first = spans[0];
  const idx = Number(first.dataset.item);
  const item = tc.items[idx];
  if (!item) return false;

  const wrapRect = rec.wrap.getBoundingClientRect();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of spans) {
    const r = s.getBoundingClientRect();
    x0 = Math.min(x0, r.left - wrapRect.left); y0 = Math.min(y0, r.top - wrapRect.top);
    x1 = Math.max(x1, r.right - wrapRect.left); y1 = Math.max(y1, r.bottom - wrapRect.top);
  }
  const s = currentScale();
  const p0 = toPdf(i, x0, y0);
  const p1 = toPdf(i, x1, y1);
  const pad = 1 / s;
  const rect = [Math.min(p0.x, p1.x) - pad, Math.min(p0.y, p1.y) - pad, Math.max(p0.x, p1.x) + pad, Math.max(p0.y, p1.y) + pad];
  const t = item.transform;
  const style = tc.styles[item.fontName] || {};

  doc.textEdits.push({
    id: 'te' + Math.random().toString(36).slice(2, 8),
    page: i,
    rect,
    baseline: [t[4], t[5]],
    size: Math.hypot(t[2], t[3]),
    angle: (Math.atan2(t[1], t[0]) * 180) / Math.PI,
    fontFamily: style.fontFamily || 'Helvetica',
    color: sampleTextColor(i, spans[0].getBoundingClientRect(), wrapRect),
    bg: [1, 1, 1],
    text: newText,
    original: sel.toString(),
  });
  pushHistory('ai rewrite');
  renderPageAnnotations(i);
  emit('annots');
  window.getSelection().removeAllRanges();
  return true;
}

/* ── Find & Replace ──────────────────────────────────────────────────────── */

/** Read a text span's rendered colour so a replacement matches the original. */
function spanTextColor(span) {
  try {
    const cs = getComputedStyle(span).color;
    const m = /rgba?\(([^)]+)\)/.exec(cs);
    if (m) {
      const p = m[1].split(',').map((v) => (parseFloat(v) || 0) / 255);
      return [p[0] || 0, p[1] || 0, p[2] || 0];
    }
    const h = /^#([0-9a-f]{3,6})$/i.exec(cs);
    if (h) return hexToRgb(h[1]);
  } catch { /* fall through */ }
  return [0, 0, 0];
}

function escapeRx(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countOccurrences(str, query, caseSensitive, wholeWord) {
  const hay = caseSensitive ? str : str.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) return 0;
  let n = 0, from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0) break;
    from = at + needle.length;
    if (wholeWord) {
      const before = at > 0 ? str[at - 1] : ' ';
      const after = str[at + needle.length] || ' ';
      if (/[\wÀ-ɏ]/.test(before) || /[\wÀ-ɏ]/.test(after)) continue;
    }
    n++;
  }
  return n;
}

/**
 * Foxit's Find & Replace "Replace All". pdf.js exposes text as discrete items,
 * so the replacement is applied per text item: the run containing a match is
 * white-boxed and redrawn with every occurrence substituted. Returns how many
 * matches were replaced.
 */
export async function replaceAllInDocument(query, replacement, opts = {}) {
  const doc = activeDoc();
  if (!doc || !query) return 0;
  const cs = opts.caseSensitive ?? state.search.caseSensitive ?? false;
  const ww = opts.wholeWord ?? false;
  const rx = new RegExp(escapeRx(query), cs ? 'g' : 'gi');
  let replaced = 0;
  const touched = new Set();

  for (let i = 0; i < doc.numPages; i++) {
    const tc = await getTextContent(i);
    if (!tc) continue;
    for (let k = 0; k < tc.items.length; k++) {
      const item = tc.items[k];
      if (!item.str) continue;
      const hits = countOccurrences(item.str, query, cs, ww);
      if (!hits) continue;
      const next = item.str.replace(rx, replacement);
      if (next === item.str) continue;
      const t = item.transform;
      const size = Math.hypot(t[2], t[3]);
      const style = tc.styles[item.fontName] || {};
      const rec = pageEl(i);
      const span = rec && rec.textLayer ? rec.textLayer.querySelector(`span[data-item="${k}"]`) : null;
      doc.textEdits = doc.textEdits || [];
      doc.textEdits.push({
        id: 'te' + Math.random().toString(36).slice(2, 8),
        page: i,
        rect: [t[4], t[5] - size * 0.22, t[4] + (item.width || 0), t[5] + size],
        baseline: [t[4], t[5]],
        size,
        angle: (Math.atan2(t[1], t[0]) * 180) / Math.PI,
        fontFamily: style.fontFamily || 'Helvetica',
        color: span ? spanTextColor(span) : [0, 0, 0],
        bg: [1, 1, 1],
        text: next,
        original: item.str,
      });
      replaced += hits;
      touched.add(i);
    }
  }

  if (replaced) {
    pushHistory('find & replace');
    for (const i of touched) renderPageAnnotations(i);
    emit('annots');
  }
  return replaced;
}
