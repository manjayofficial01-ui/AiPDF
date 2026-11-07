/**
 * Stirling-PDF integration pack — pure document-tool engines.
 *
 * Every function here is DOM-free so it runs in plain Node
 * (scripts/stirling-test.mjs) and in the Electron renderer. The UI layer
 * (app.js dialogs + pdfwrite.js builders) consumes these planners; nothing
 * here touches the viewer, IPC, or the network.
 *
 * Mapping to Stirling-Tools/Stirling-PDF controllers (~60 tools):
 *
 * | Stirling controller(s)                          | Engine here                    |
 * |-------------------------------------------------|--------------------------------|
 * | CompressController                              | COMPRESS_PRESETS/planCompress  |
 * | FlattenController                               | flattenPlan                    |
 * | SanitizeController, ShowJavascript              | sanitizePlan/applySanitizeModel|
 * | GetInfoOnPDF (AllTextLineExtractor)             | docInfoSummary                 |
 * | ExtractImagesController / RemoveImagesController| extractImagesPlan/stripImages  |
 * | Remove Annotations (FilterController)           | removeAnnotationsPlan          |
 * | MultiPageLayoutController (N-up)                | nupPlan                        |
 * | BookletImpositionController                     | bookletOrder                   |
 * | PosterPdfController                             | posterTiles                    |
 * | ToSinglePageController                          | singlePagePlan                 |
 * | SplitPdfBySizeController                        | splitBySizePlan                |
 * | AutoRenameController                            | autoRenameSuggest              |
 * | RepairController / DecompressPdfController      | repairCheck                    |
 * | pipeline (Automate)                             | PIPELINE_STEPS/runPipelineModel|
 * | PageNumbersController                           | pageNumberPlan                 |
 * | AutoRotateController                            | autoRotatePlan                 |
 * | AttachmentController / PortfolioController      | attachmentOps                  |
 * | UnlockPDFFormsController                        | unlockFormsPlan                |
 *
 * Already covered elsewhere in AiPDF (not duplicated here):
 * merge/split/rotate/extract (pages.js), overlay/scale/blank-pages/
 * adjust-colors (docxtools.js), compare (compare.js), OCR (ocr.js),
 * watermark/header/bates (stamps.js + pdfwrite.js), encrypt (pdfwrite.js),
 * redact (tools.js + pdfwrite.js), AI assistant + agent (ai.js/agent.js).
 */

export const PAPER_SIZES = {
  A4: [595.28, 841.89],
  Letter: [612, 792],
  Legal: [612, 1008],
  A3: [841.89, 1191.86],
  A5: [419.53, 595.28],
};

/* ── Compress (Stirling CompressController) ───────────────────────────── */

export const COMPRESS_PRESETS = [
  { id: 'web', label: 'Web / email (≈100 dpi, small)', dpi: 100, quality: 0.62, filter: '' },
  { id: 'balanced', label: 'Balanced (≈150 dpi)', dpi: 150, quality: 0.78, filter: '' },
  { id: 'print', label: 'Print-safe (≈200 dpi, light)', dpi: 200, quality: 0.88, filter: '' },
  { id: 'grayscale', label: 'Grayscale + compress', dpi: 150, quality: 0.75, filter: 'grayscale(1)' },
  { id: 'scan', label: 'Scanned docs (contrast + compress)', dpi: 150, quality: 0.75, filter: 'grayscale(0.85) contrast(1.35) brightness(1.05)' },
];

export function compressPresetById(id) {
  return COMPRESS_PRESETS.find((p) => p.id === id) || null;
}

function clampDpi(dpi) {
  const d = Number(dpi);
  if (!Number.isFinite(d)) return 150;
  return Math.min(300, Math.max(72, Math.round(d)));
}

function clampQuality(q) {
  const v = Number(q);
  if (!Number.isFinite(v)) return 0.78;
  return Math.min(0.95, Math.max(0.3, v));
}

/**
 * Plan a compress run. Returns { dpi, quality, filter, pages, stripMeta }.
 * `pages` is a sorted 0-based index list; empty means nothing to do.
 */
export function planCompress({ presetId = 'balanced', dpi, quality, filter = '', pageCount = 0, range = null, stripMeta = true } = {}) {
  const preset = compressPresetById(presetId) || compressPresetById('balanced');
  const out = {
    dpi: dpi != null ? clampDpi(dpi) : preset.dpi,
    quality: quality != null ? clampQuality(quality) : preset.quality,
    filter: String(filter || preset.filter || ''),
    stripMeta: stripMeta !== false,
    pages: [],
  };
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  if (!n) return out;
  if (Array.isArray(range) && range.length) {
    const set = new Set();
    for (const i of range) {
      const k = Math.floor(Number(i));
      if (Number.isFinite(k) && k >= 0 && k < n) set.add(k);
    }
    out.pages = Array.from(set).sort((a, b) => a - b);
  } else {
    out.pages = Array.from({ length: n }, (_, i) => i);
  }
  return out;
}

/** Rough pre-run estimate shown in the dialog (bytes are approximate). */
export function estimateCompress(originalBytes, pageCount, dpi = 150, quality = 0.78) {
  const px = clampDpi(dpi) / 150;
  const q = clampQuality(quality) / 0.78;
  // A rasterised page scales ~quadratically with DPI and ~linearly with JPEG q.
  const perPageFactor = px * px * (0.55 + 0.45 * q);
  const est = Math.round((originalBytes || 0) * 0.35 + (originalBytes || 0) * 0.65 * Math.min(1.6, Math.max(0.25, perPageFactor)));
  return { estimateBytes: est, pages: Math.max(0, Math.floor(pageCount || 0)) };
}

/* ── Flatten (Stirling FlattenController) ─────────────────────────────── */

/**
 * Flatten = burn annotations + form values into page content so the file has
 * no interactive layer left. The writer rasterises the listed pages; this
 * planner just decides which pages need it (any page carrying annots or
 * widgets counts) and reports what will be lost.
 */
export function flattenPlan({ pageCount = 0, annots = [], hasForm = false } = {}) {
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  const withAnnots = new Set();
  let annotCount = 0;
  for (const a of annots || []) {
    const p = Math.floor(Number(a?.page));
    if (Number.isFinite(p) && p >= 0 && p < n) {
      withAnnots.add(p);
      annotCount++;
    }
  }
  const pages = hasForm ? Array.from({ length: n }, (_, i) => i) : Array.from(withAnnots).sort((a, b) => a - b);
  return { pages, annotCount, formFlatten: !!hasForm, rasterizes: pages.length > 0 };
}

/* ── Sanitize (Stirling SanitizeController + ShowJavascript) ──────────── */

/**
 * What sanitize removes. AiPDF never executes embedded JS, but files can
 * carry it; attachments, metadata and thumbnail caches are the other
 * exfiltration/malware vectors Stirling strips.
 */
export function sanitizePlan(doc = {}) {
  const attachments = (doc.attachments || []).length;
  const annots = (doc.annots || []).length;
  const hasMeta = !!(doc.meta && (doc.meta.title || doc.meta.author || doc.meta.subject || doc.meta.keywords));
  const hasFields = (doc.fields || []).length + (doc.newFields || []).length;
  return {
    attachments, annots, hasMeta, formFields: hasFields,
    removes: [
      ...(attachments ? [`${attachments} embedded file(s)`] : []),
      ...(hasMeta ? ['document metadata (title/author/subject/keywords)'] : []),
      ...(hasFields ? [`${hasFields} form field value(s)`] : []),
      'embedded JavaScript actions (if present)',
      'thumbnail caches',
    ],
  };
}

/** Pure model mutation: strip the sanitizable layers. Returns a report. */
export function applySanitizeModel(doc) {
  if (!doc || typeof doc !== 'object') return { removed: 0, details: [] };
  const details = [];
  const att = (doc.attachments || []).length;
  if (att) { doc.attachments = []; details.push(`${att} attachment(s)`); }
  if (doc.meta && (doc.meta.title || doc.meta.author || doc.meta.subject || doc.meta.keywords)) {
    doc.meta = { ...(doc.meta || {}), title: '', author: '', subject: '', keywords: '' };
    details.push('metadata');
  }
  if (Array.isArray(doc.fields) && doc.fields.length) {
    const k = doc.fields.length;
    doc.fields = [];
    details.push(`${k} form value(s)`);
  }
  if (Array.isArray(doc.newFields) && doc.newFields.length) {
    const k = doc.newFields.length;
    doc.newFields = [];
    details.push(`${k} pending field(s)`);
  }
  // Writer-level JS stripping happens in buildPdf (see opts.sanitize); the
  // model carries no JS of its own, so record the intent for the report.
  details.push('embedded JavaScript (writer pass)');
  return { removed: details.length, details };
}

/* ── Document info (Stirling GetInfoOnPDF) ────────────────────────────── */

export function fmtBytesStirling(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Summarise a document model + raw bytes into the "All info" rows Stirling
 * shows. `extra` carries writer-known facts (version, linearized, …) when
 * the caller parsed them; everything else derives from the model.
 */
export function docInfoSummary(doc = {}, bytesLength = 0, extra = {}) {
  const sizes = doc.pageSizes || [];
  const uniqSizes = new Map();
  for (const s of sizes) {
    if (!s) continue;
    const key = `${Math.round(s.w || 0)}×${Math.round(s.h || 0)}`;
    uniqSizes.set(key, (uniqSizes.get(key) || 0) + 1);
  }
  return {
    name: doc.name || 'document.pdf',
    pages: doc.numPages || sizes.length || 0,
    fileSize: fmtBytesStirling(bytesLength || doc.bytes?.length || 0),
    pageSizes: Array.from(uniqSizes.entries()).map(([size, count]) => ({ size, count })),
    annotCount: (doc.annots || []).length,
    attachmentCount: (doc.attachments || []).length,
    fieldCount: (doc.fields || []).length + (doc.newFields || []).length,
    hasTextEdits: (doc.textEdits || []).length > 0,
    hasOcr: !!(doc.ocr && Object.keys(doc.ocr).length),
    encrypted: !!doc.passwordProtected,
    version: extra.version || '—',
    producer: extra.producer || '—',
    title: doc.meta?.title || '—',
    author: doc.meta?.author || '—',
  };
}

/* ── Bulk removal (Stirling FilterController family) ──────────────────── */

export function removeAnnotationsPlan(doc = {}, types = null) {
  const list = doc.annots || [];
  const want = types && types.length ? new Set(types) : null;
  const ids = list.filter((a) => !want || want.has(a.type)).map((a) => a.id);
  const byType = {};
  for (const a of list) {
    if (want && !want.has(a.type)) continue;
    byType[a.type] = (byType[a.type] || 0) + 1;
  }
  return { ids, count: ids.length, byType };
}

/** Pages whose images should be dropped (Stirling RemoveImages): the writer
 *  rasterises-then-strips; this planner validates the range. */
export function stripImagesPlan(pageCount, range) {
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  if (!n) return { pages: [], note: 'empty document' };
  if (!range || range === 'all') return { pages: Array.from({ length: n }, (_, i) => i) };
  const set = new Set();
  for (const i of range || []) {
    const k = Math.floor(Number(i));
    if (Number.isFinite(k) && k >= 0 && k < n) set.add(k);
  }
  return { pages: Array.from(set).sort((a, b) => a - b) };
}

export function extractImagesPlan(pageCount, range) {
  return stripImagesPlan(pageCount, range);
}

/* ── Page layout: N-up / booklet / poster / single page ───────────────── */

const NUP_GRIDS = {
  '2-up': [2, 1],
  '4-up': [2, 2],
  '6-up': [3, 2],
  '9-up': [3, 3],
  '16-up': [4, 4],
};

export function nupGrids() {
  return Object.keys(NUP_GRIDS);
}

/**
 * Map source pages onto sheets. Returns { cols, rows, perSheet, sheets }
 * where each sheet is an array of source indices (or -1 for blank filler).
 */
export function nupPlan(pageCount, layout = '4-up') {
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  const [cols, rows] = NUP_GRIDS[layout] || NUP_GRIDS['4-up'];
  const perSheet = cols * rows;
  const sheets = [];
  for (let s = 0; s < n; s += perSheet) {
    const sheet = [];
    for (let k = 0; k < perSheet; k++) sheet.push(s + k < n ? s + k : -1);
    sheets.push(sheet);
  }
  return { cols, rows, perSheet, sheets, totalSheets: sheets.length };
}

/**
 * Booklet imposition order (Stirling BookletImpositionController).
 * Returns an array of sheets; each sheet is { front: [left, right], back: [left, right] }
 * with -1 = blank. Input page count is padded up to a multiple of 4.
 */
export function bookletOrder(pageCount) {
  let n = Math.max(0, Math.floor(Number(pageCount) || 0));
  const padded = Math.ceil(n / 4) * 4;
  const sheets = [];
  let lo = 0, hi = padded - 1;
  while (lo < hi) {
    sheets.push({
      front: [hi, lo],
      back: [lo + 1, hi - 1],
    });
    lo += 2;
    hi -= 2;
  }
  const blanks = padded - n;
  return { padded, blanks, sheets, totalSheets: sheets.length };
}

/**
 * Split one page into poster tiles (Stirling PosterPdfController).
 * Returns tile rects in PDF points for a page of (w,h) split cols×rows.
 */
export function posterTiles(w, h, cols = 2, rows = 2) {
  const W = Number(w), H = Number(h);
  const c = Math.min(8, Math.max(1, Math.floor(Number(cols) || 2)));
  const r = Math.min(8, Math.max(1, Math.floor(Number(rows) || 2)));
  if (!Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return [];
  const tw = W / c, th = H / r;
  const out = [];
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < c; x++) {
      out.push({ col: x, row: y, rect: [x * tw, y * th, (x + 1) * tw, (y + 1) * th] });
    }
  }
  return out;
}

/**
 * Join all pages into one long strip (Stirling ToSinglePageController).
 * Returns { width, height, placements: [{ page, y }] } in PDF points.
 */
export function singlePagePlan(sizes = [], gap = 0) {
  const list = (sizes || []).filter((s) => s && Number.isFinite(s.w) && Number.isFinite(s.h));
  if (!list.length) return { width: 0, height: 0, placements: [] };
  const width = Math.max(...list.map((s) => s.w));
  const g = Math.max(0, Number(gap) || 0);
  const placements = [];
  let y = 0;
  // Stack top-first: first page ends up at the top of the strip.
  const total = list.reduce((a, s) => a + s.h, 0) + g * Math.max(0, list.length - 1);
  for (let i = 0; i < list.length; i++) {
    const h = list[i].h;
    y += i === 0 ? 0 : g;
    placements.push({ page: i, y: total - y - h, h, w: list[i].w });
    y += h;
  }
  return { width, height: total, placements };
}

/* ── Split by size / auto-rename / repair ─────────────────────────────── */

/**
 * Chunk page indices so each chunk stays under targetMB (Stirling
 * SplitPdfBySizeController). Uses average bytes/page as the estimator —
 * exact per-page sizes need a full re-encode per page.
 */
export function splitBySizePlan(totalBytes, pageCount, targetMB = 5) {
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  const target = Math.max(0.25, Number(targetMB) || 5) * 1024 * 1024;
  if (!n) return { chunks: [], avgPerPage: 0 };
  const avg = (Number(totalBytes) || 0) / n;
  if (!(avg > 0)) {
    return { chunks: [Array.from({ length: n }, (_, i) => i)], avgPerPage: 0 };
  }
  const perChunk = Math.max(1, Math.floor(target / avg));
  const chunks = [];
  for (let s = 0; s < n; s += perChunk) {
    chunks.push(Array.from({ length: Math.min(perChunk, n - s) }, (_, k) => s + k));
  }
  return { chunks, avgPerPage: Math.round(avg) };
}

export function chunkByCount(pageCount, perChunk = 10) {
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  const size = Math.max(1, Math.floor(Number(perChunk) || 10));
  const chunks = [];
  for (let s = 0; s < n; s += size) {
    chunks.push(Array.from({ length: Math.min(size, n - s) }, (_, k) => s + k));
  }
  return chunks;
}

function slugify(s, max = 60) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim() || '';
}

/**
 * Suggest a filename from document content (Stirling AutoRenameController):
 * title metadata first, then the first non-empty text line.
 */
export function autoRenameSuggest({ title = '', firstLines = [], fallback = 'document.pdf' } = {}) {
  const t = slugify(title);
  if (t) return t.endsWith('.pdf') ? t : `${t}.pdf`;
  for (const line of firstLines || []) {
    const s = slugify(String(line || '').replace(/^[#*\-\d.\s]+/, ''));
    if (s.length >= 3) return s.endsWith('.pdf') ? s : `${s}.pdf`;
  }
  return fallback;
}

/**
 * Cheap structural health check (Stirling RepairController, read-only half).
 * Returns { ok, issues[] }. The writer's repair path re-encodes via
 * copyPages, which drops dangling references.
 */
export function repairCheck(bytes) {
  const issues = [];
  const arr = bytes instanceof Uint8Array ? bytes : null;
  if (!arr || arr.length < 9) return { ok: false, issues: ['file is empty or unreadable'] };
  const head = String.fromCharCode(...arr.slice(0, 8));
  if (!head.startsWith('%PDF-')) issues.push('missing %PDF- header');
  const tail = String.fromCharCode(...arr.slice(Math.max(0, arr.length - 64)));
  if (!/%%EOF/.test(tail)) issues.push('missing %%EOF trailer (truncated download?)');
  // xref / object sanity: count indirect object definitions.
  let objects = 0;
  try {
    const text = new TextDecoder('latin1').decode(arr.slice(0, Math.min(arr.length, 4 * 1024 * 1024)));
    const m = text.match(/\d+ \d+ obj/g);
    objects = m ? m.length : 0;
    if (!objects) issues.push('no PDF objects found');
    if (!/trailer|startxref/.test(text.slice(-200000))) issues.push('no trailer/startxref found');
  } catch { issues.push('could not scan objects'); }
  return { ok: issues.length === 0, issues, objects };
}

/* ── Page numbers (Stirling PageNumbersController) ────────────────────── */

export const PAGE_NUMBER_FORMATS = [
  { id: 'n', label: '1, 2, 3 …', sample: (p) => `${p}` },
  { id: 'n-of-N', label: 'Page 1 of N', sample: (p, n) => `Page ${p} of ${n}` },
  { id: 'n/N', label: '1 / N', sample: (p, n) => `${p} / ${n}` },
  { id: 'roman', label: 'i, ii, iii …', sample: (p) => toRoman(p).toLowerCase() },
  { id: 'ROMAN', label: 'I, II, III …', sample: (p) => toRoman(p) },
];

function toRoman(num) {
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let n = Math.max(1, Math.floor(Number(num) || 1));
  let out = '';
  for (const [v, s] of table) while (n >= v) { out += s; n -= v; }
  return out;
}

export function pageNumberPlan({ formatId = 'n-of-N', from = 1, to = null, pageCount = 0, start = 1 } = {}) {
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  const f = PAGE_NUMBER_FORMATS.find((x) => x.id === formatId) || PAGE_NUMBER_FORMATS[1];
  const a = Math.min(n, Math.max(1, Math.floor(Number(from) || 1)));
  const b = to == null ? n : Math.min(n, Math.max(1, Math.floor(Number(to) || n)));
  const s0 = Math.max(0, Math.floor(Number(start) || 1));
  const pages = [];
  for (let p = a; p <= b; p++) pages.push({ page: p - 1, text: f.sample(s0 + (p - a), n) });
  return { formatId: f.id, pages };
}

/* ── Auto-rotate (Stirling AutoRotateController) ──────────────────────── */

/**
 * Heuristic deskew suggestion from text-line geometry: given per-page
 * { angle, confidence } observations (e.g. from OCR OSD or long-line
 * slope analysis), return the rotation delta to apply per page.
 * Pure so the detector (viewer/OCR side) stays injectable.
 */
export function autoRotatePlan(observations = []) {
  return (observations || []).map((o, i) => {
    const angle = Number(o?.angle) || 0;
    const conf = Number(o?.confidence) || 0;
    if (conf < 0.5) return { page: i, delta: 0, reason: 'low confidence' };
    const snap = Math.round(angle / 90) * 90;
    const delta = ((360 - (snap % 360)) % 360);
    return { page: i, delta: delta === 360 ? 0 : delta, reason: conf >= 0.9 ? 'confident' : 'uncertain' };
  });
}

/* ── Attachments / portfolio (Stirling AttachmentController) ──────────── */

export const attachmentOps = {
  add(list = [], file) {
    if (!file || !file.filename || !file.data) return list;
    if (list.some((a) => a.filename === file.filename)) return list;
    return [...list, file];
  },
  remove(list = [], filename) {
    return (list || []).filter((a) => a.filename !== filename);
  },
  rename(list = [], oldName, newName) {
    if (!newName || /[\\/:*?"<>|]/.test(newName)) return list;
    if ((list || []).some((a) => a.filename === newName)) return list;
    return (list || []).map((a) => (a.filename === oldName ? { ...a, filename: newName } : a));
  },
};

/** Unlock forms (Stirling UnlockPDFFormsController): clear read-only flags. */
export function unlockFormsPlan(fields = []) {
  return (fields || []).map((f) => ({ ...f, readOnly: false }));
}

/* ── Automate: batch pipelines (Stirling Automate / Processor) ───────── */

export const PIPELINE_STEPS = [
  { id: 'compress', label: 'Compress', needsDoc: true, param: 'presetId' },
  { id: 'removeBlanks', label: 'Remove blank pages', needsDoc: true },
  { id: 'sanitize', label: 'Sanitize (strip attachments/metadata)', needsDoc: true },
  { id: 'flatten', label: 'Flatten annotations', needsDoc: true },
  { id: 'addPageNumbers', label: 'Add page numbers', needsDoc: true, param: 'formatId' },
  { id: 'watermark', label: 'Add watermark text', needsDoc: true, param: 'text' },
  { id: 'grayscale', label: 'Convert to grayscale', needsDoc: true },
  { id: 'splitSize', label: 'Split by size (export)', needsDoc: true, param: 'targetMB' },
];

export function validatePipeline(steps = []) {
  const issues = [];
  const known = new Set(PIPELINE_STEPS.map((s) => s.id));
  (steps || []).forEach((s, i) => {
    if (!s || !known.has(s.id)) issues.push(`step ${i + 1}: unknown tool “${s?.id}”`);
  });
  return { ok: issues.length === 0, issues };
}

/**
 * Apply pipeline steps to a document model in order. Only pure model ops
 * run here (sanitize); every other step records its intent — including its
 * parameters — on `doc.pipelineFlags` for app.js to execute in one pass.
 * Returns { applied[], skipped[] }.
 */
export function runPipelineModel(doc, steps = []) {
  const applied = [];
  const skipped = [];
  for (const s of steps || []) {
    try {
      if (!s || !s.id) { skipped.push('(empty step)'); continue; }
      if (s.id === 'sanitize' && doc) {
        const r = applySanitizeModel(doc);
        applied.push(`sanitize (${r.details.join(', ') || 'clean'})`);
      } else if (s.id === 'removeBlanks' && doc) {
        // Flag-only: detection needs the viewer; app.js resolves it.
        (doc.pipelineFlags = doc.pipelineFlags || {}).removeBlanks = true;
        applied.push('remove blank pages (queued)');
      } else if (s.id === 'compress' && doc) {
        (doc.pipelineFlags = doc.pipelineFlags || {}).compress = s.params || { presetId: 'balanced' };
        applied.push('compress (queued)');
      } else if (s.id === 'flatten' && doc) {
        (doc.pipelineFlags = doc.pipelineFlags || {}).flatten = true;
        applied.push('flatten (queued)');
      } else if (s.id === 'grayscale' && doc) {
        (doc.pipelineFlags = doc.pipelineFlags || {}).grayscale = true;
        applied.push('grayscale (queued)');
      } else if (s.id === 'addPageNumbers' && doc) {
        (doc.pipelineFlags = doc.pipelineFlags || {}).pageNumbers = s.params || { formatId: 'n-of-N' };
        applied.push('page numbers (queued)');
      } else if (s.id === 'watermark' && doc) {
        (doc.pipelineFlags = doc.pipelineFlags || {}).watermark = s.params || { text: 'DRAFT' };
        applied.push(`watermark “${(s.params || {}).text || 'DRAFT'}” (queued)`);
      } else if (s.id === 'splitSize' && doc) {
        (doc.pipelineFlags = doc.pipelineFlags || {}).splitSize = s.params || { targetMB: 5 };
        applied.push('split by size (queued for export)');
      } else {
        skipped.push(s.id);
      }
    } catch (e) {
      skipped.push(`${s?.id}: ${e?.message || e}`);
    }
  }
  if (doc) doc.pipeline = (steps || []).map((s) => s?.id).filter(Boolean);
  return { applied, skipped };
}

/**
 * Stamp descriptors for the pipeline steps that write real PDF text. Pure:
 * app.js temporarily appends these to `doc.stamps` for the single buildPdf()
 * pass that commits the whole pipeline, so nothing is left queued and nothing
 * is written twice on a later save.
 *
 * Page numbers need ONE stamp per page — a single stamp carries one `text`,
 * so a whole-document stamp would print "Page 1 of N" on every page.
 */
export function pipelineStamps(flags = {}, pageCount = 0) {
  const out = [];
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  const bounded = (v, lo, hi, fallback) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : fallback;
  };
  const pn = flags?.pageNumbers;
  if (pn && pages > 0) {
    const plan = pageNumberPlan({ formatId: pn.formatId || 'n-of-N', pageCount: pages });
    const kind = pn.scope === 'header' ? 'header' : 'footer';
    const align = pn.align || 'center';
    const fontSize = bounded(pn.fontSize, 7, 24, 10);
    for (const p of plan.pages) {
      out.push({
        id: `pipeline-pn-${p.page + 1}`, kind, text: p.text, align, fontSize,
        color: [0.4, 0.4, 0.4], behind: false,
        from: p.page + 1, to: p.page + 1, odd: 'all',
      });
    }
  }
  const wm = flags?.watermark;
  if (wm && pages > 0) {
    const text = String(wm.text ?? '').trim().slice(0, 120) || 'DRAFT';
    out.push({
      id: 'pipeline-watermark', kind: 'watermark', text, image: null,
      fontSize: bounded(wm.fontSize, 12, 160, 56),
      color: [0.54, 0.56, 0.61],
      opacity: bounded(wm.opacity, 0.02, 1, 0.16),
      angle: bounded(wm.angle, -90, 90, -45),
      scale: 60, behind: true, from: 1, to: pages, odd: 'all',
    });
  }
  return out;
}
