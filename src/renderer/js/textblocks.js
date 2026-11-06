/* Geometric text grouping for the Direct Editor.
 *
 * Two sources feed it, and both must produce the same shape:
 *
 *  1. native PDF text  — pdf.js TextItem runs, grouped into lines then blocks.
 *  2. OCR results      — Tesseract lines (already recognised), same grouping.
 *
 * The grouping is deliberately conservative: TextItem boundaries reflect
 * drawing operations, not authoring paragraphs, and a wrong merge is far more
 * destructive than a wrong split — merging across a column gutter makes an
 * edit swallow the neighbouring column.
 */

/** Style identity used for merging. Comparing pdf.js font *names* is wrong:
 *  producers emit a fresh name per subset/encoding, so the same visual style
 *  arrives as several names and every line becomes its own block. */
const styleKey = (family, size) => `${String(family || 'Helvetica').toLowerCase()}@${(size || 10).toFixed(1)}`;

/** A whitespace-only run far wider than a normal space is a POSITIONING
 *  artifact: producers bridge a table gutter with a stretched space or a TJ
 *  offset, and the run is then technically contiguous with the next cell. Left
 *  alone it glues two cells into one editable block, which a cell edit would
 *  then delete as a unit. A normal space is ~0.25em; anything over 2em is a
 *  gutter, not a word space. */
const wideSpace = (r) => /^\s+$/.test(r.text || '') && (r.width || 0) > (r.size || 10) * 2;

/** Rotation bucket in whole degrees, snapped to the quadrant. Text at 89.7°
 *  and 90.3° is the same rotation as far as reading order is concerned. */
const rotBucket = (rad) => (Math.round((rad * 180) / Math.PI / 90) * 90 + 360) % 360;

const clampNum = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);

/** True when `r`'s CENTRE lies inside `box`.
 *
 *  Kept for the OCR line gate (a neighbouring line that only grazes the box
 *  must not join the area). It is NOT the Area Direct Edit text test any more:
 *  whole pdf.js runs and whole OCR rows used to pass this and take their
 *  outside words with them. Native text is now clipped glyph-by-glyph by
 *  `clipTextContentToRegion`, and OCR rows word-by-word by
 *  `flatOcrLinesInRegion`. */
export function rectCentreInside(r, box) {
  if (!Array.isArray(r) || r.length !== 4 || !Array.isArray(box) || box.length !== 4) return false;
  const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2;
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3];
}

/* ── Area Direct Edit: glyph-precise marquee clipping ─────────────────────
 *
 * pdf.js emits ONE TextItem per drawn run, and for most producers that run is
 * a whole line ("This paragraph exists to be found …"). Testing the item's
 * CENTRE against the marquee therefore makes the entire line editable as soon
 * as the box covers its middle — the words to the left and right of the box
 * included. That is the precision bug: "nearest text in line with the area".
 *
 * `clipTextContentToRegion` rebuilds the text content record so every item is
 * either wholly inside the rectangle (kept verbatim, so truthful excision is
 * still possible) or cut down to the CHARACTERS whose own glyph boxes are
 * wholly inside it. Nothing outside the box reaches `groupTextBlocks`, so no
 * block text, hit target or source operator can escape the marquee.
 */

/** True when `r` lies wholly inside `box`, with `tol` points of slack. */
export function rectFullyInside(r, box, tol = 0) {
  if (!Array.isArray(r) || r.length !== 4 || !Array.isArray(box) || box.length !== 4) return false;
  if (!r.every(Number.isFinite) || !box.every(Number.isFinite)) return false;
  return r[0] >= box[0] - tol && r[1] >= box[1] - tol
    && r[2] <= box[2] + tol && r[3] <= box[3] + tol;
}

/** A rectangle `r` clipped to `box`, or null when they do not overlap. */
export function rectClip(r, box) {
  const c = [Math.max(r[0], box[0]), Math.max(r[1], box[1]),
    Math.min(r[2], box[2]), Math.min(r[3], box[3])];
  return (c[2] - c[0] > 0.25 && c[3] - c[1] > 0.25) ? c : null;
}

/** Axis-aligned bounds of a stretch of a text run, in the run's own rotated
 *  frame. `from`/`to` are distances along the baseline, `low`/`high` offsets
 *  along the stacking normal. */
function runQuad(x, y, u, n, from, to, low, high) {
  const p = (d, o) => [x + d * u[0] + o * n[0], y + d * u[1] + o * n[1]];
  const pts = [p(from, low), p(to, low), p(to, high), p(from, high)];
  return [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])),
    Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
}

/* One measuring canvas for the whole page — creating one per text item made
 * region repaints visibly slow on text-heavy pages. */
let regionMeasureCtx = null;
function charWidths(str, width, size, family, measure) {
  const chars = Array.from(str);
  let ws;
  if (typeof measure === 'function') {
    ws = chars.map((ch) => Math.max(0, Number(measure(ch, size, family)) || 0));
  } else {
    if (!regionMeasureCtx && typeof document !== 'undefined') {
      try { regionMeasureCtx = document.createElement('canvas').getContext('2d'); } catch { /* Node: uniform fallback */ }
    }
    if (regionMeasureCtx) {
      regionMeasureCtx.font = `${size}px ${family || 'Helvetica'}, Arial, sans-serif`;
      ws = chars.map((ch) => Math.max(0.01, regionMeasureCtx.measureText(ch).width));
    } else ws = chars.map(() => 1);
  }
  const sum = ws.reduce((a, b) => a + b, 0);
  const k = sum > 0 ? width / sum : 0;
  return { chars, ws: ws.map((w) => w * k) };
}

/**
 * Rebuild `tc` so only glyphs inside `region` survive.
 *
 * Returns `{ tc, originMap, partial }`. `originMap[clippedIndex]` is the
 * ORIGINAL item index (identity for excision and `editForBlock`); `partial[i]`
 * means item `i` is a fragment of a longer source run, so the writer must use
 * a cover rather than excising the operator — cutting the operator would erase
 * the characters OUTSIDE the marquee that this edit does not own.
 *
 * `opts.measure(ch, size, family)` is an injection seam for offline tests; in
 * the app the canvas measures with the run's own font and the result is scaled
 * to the exact width pdf.js reported for the whole item.
 */
export function clipTextContentToRegion(tc, region, opts = {}) {
  const items = [], originMap = [], partial = [];
  const empty = { tc: { items, styles: tc?.styles || {} }, originMap, partial };
  if (!tc || !Array.isArray(tc.items) || !Array.isArray(region) || region.length !== 4
    || !region.every(Number.isFinite) || region[2] <= region[0] || region[3] <= region[1]) return empty;

  const add = (item, src, isPartial) => {
    items.push(item); originMap.push(src); partial.push(!!isPartial);
  };

  for (let index = 0; index < tc.items.length; index++) {
    const it = tc.items[index];
    if (!it || !it.str || !Array.isArray(it.transform) || it.transform.length < 6) continue;
    if (it.dir === 'ttb') continue;                       // vertical writing: out of scope
    const t = it.transform;
    if (!Number.isFinite(t[4]) || !Number.isFinite(t[5])) continue;
    const size = Math.hypot(t[2], t[3]);
    if (!Number.isFinite(size) || size < 1.5) continue;  // invisible OCR layers
    const angle = Math.atan2(t[1], t[0]);
    const u = [Math.cos(angle), Math.sin(angle)];
    const n = [-Math.sin(angle), Math.cos(angle)];
    const x = t[4], y = t[5];
    let width = Math.max(0, Number(it.width) || 0);
    if (width < size * 0.08) {
      const nChars = Array.from(it.str).filter((c) => !/\s/u.test(c)).length || 1;
      width = nChars * size * 0.5;
    }
    const st = tc.styles?.[it.fontName] || {};
    const asc = Number.isFinite(st.ascent) ? clampNum(st.ascent, 0.1, 1.6) : 0.9;
    const desc = Number.isFinite(st.descent) ? clampNum(st.descent, -1.6, 0) : -0.21;
    /* The INK band, a little tighter than the font's full ascent/descent: a
     * marquee drawn snugly around visible glyphs must still count them as
     * inside, while a box that only grazes the line above must not. */
    const low = desc * size * 0.8, high = asc * size * 0.82;
    const tol = Math.max(0.75, size * 0.08);
    const whole = runQuad(x, y, u, n, 0, width, low, high);

    if (rectFullyInside(whole, region, tol)) { add(it, index, false); continue; }
    // RTL and single-glyph runs cannot be split by visual order. Keep them only
    // when the whole run fits — never drag their outside half into the area.
    if (it.dir === 'rtl' || Array.from(it.str).length < 2) continue;

    const { chars, ws } = charWidths(it.str, width, size, st.fontFamily, opts.measure);
    const starts = [];
    let at = 0;
    for (let c = 0; c < chars.length; c++) { starts[c] = at; at += ws[c]; }
    const inside = chars.map((_ch, c) => rectFullyInside(
      runQuad(x, y, u, n, starts[c], starts[c] + ws[c], low, high), region, tol));

    // Consecutive inside characters form one fragment. Trim the whitespace at
    // its edges so a cut through a gutter never creates a phantom " " block.
    let c = 0;
    while (c < chars.length) {
      if (!inside[c]) { c++; continue; }
      const s0 = c;
      while (c < chars.length && inside[c]) c++;
      let s = s0, e = c - 1;
      while (e >= s && /^\s$/u.test(chars[e])) e--;
      while (s <= e && /^\s$/u.test(chars[s])) s++;
      /* A box drawn THROUGH a word leaves half a word inside it ("und," from
       * "found,"). Half a word is not text the user selected — the region OCR
       * path drops such fragments too — so snap both ends to whole words.
       * Punctuation is deliberately NOT a word boundary: a box around "Hello"
       * in "(Hello)" must keep the word. */
      const isWord = (ch) => /[\p{L}\p{N}]/u.test(ch || '');
      const rawS = s, rawE = e;
      if (s <= e && s > 0 && isWord(chars[s - 1]) && isWord(chars[s])) {
        while (s <= e && !/^\s$/u.test(chars[s])) s++;
        while (s <= e && /^\s$/u.test(chars[s])) s++;
      }
      if (s <= e && e < chars.length - 1 && isWord(chars[e]) && isWord(chars[e + 1])) {
        while (e >= s && !/^\s$/u.test(chars[e])) e--;
        while (e >= s && /^\s$/u.test(chars[e])) e--;
      }
      while (e >= s && /^\s$/u.test(chars[e])) e--;
      while (s <= e && /^\s$/u.test(chars[s])) s++;
      // A very tight box can sit entirely INSIDE one word. Snapping would then
      // leave nothing at all, which reads as a broken tool. In that case keep
      // the literal characters the box covers — they are still strictly inside.
      if (s > e) { s = rawS; e = rawE; }
      if (s > e) continue;
      const text = chars.slice(s, e + 1).join('');
      const w = starts[e] + ws[e] - starts[s];
      if (!text.trim() || !(w > 0)) continue;
      const nt = t.slice();
      nt[4] = x + starts[s] * u[0];
      nt[5] = y + starts[s] * u[1];
      add({ ...it, str: text, width: w, transform: nt, hasEOL: false,
        __sourceIndex: index, __clip: [s, e + 1] }, index, true);
    }
  }
  return { tc: { items, styles: tc.styles || {} }, originMap, partial };
}

/**
 * Turn pdf.js text items into geometric blocks.
 *
 * Returns blocks whose `coverRect` is axis-aligned in PDF space, with
 * `baseline`, `size`, `fontFamily`, `maxWidth`, `maxHeight`, `lineHeight`,
 * `itemIndices` and a stable `key`.
 */
/**
 * pdf.js text items → positioned runs, in reading order.
 *
 * `only` restricts the result to a set of item indices while KEEPING each run's
 * original page-level index — that is what lets a table cell regroup just its
 * own items and still produce blocks whose `itemIndices` point at the real page
 * items (so excision and `key` stay correct).
 */
export function textRuns(tc, only = null) {
  if (!tc || !Array.isArray(tc.items)) return [];
  const runs = [];
  for (let index = 0; index < tc.items.length; index++) {
    if (only && !only.has(index)) continue;
    const it = tc.items[index];
    if (!it || !it.str || !it.transform) continue;
    if (it.dir === 'ttb') continue;               // vertical writing: out of scope
    const t = it.transform;
    if (!Number.isFinite(t[4]) || !Number.isFinite(t[5])) continue;
    const size = Math.hypot(t[2], t[3]);
    if (!Number.isFinite(size) || size < 1) continue;
    // Invisible/near-zero-height text (OCR layers, hidden fields) is not
    // editable and would otherwise create phantom hit targets over the page.
    if (size < 1.5) continue;

    const angle = Math.atan2(t[1], t[0]);
    const rot = rotBucket(angle);
    const u = [Math.cos(angle), Math.sin(angle)];     // advance direction
    const n = [-Math.sin(angle), Math.cos(angle)];    // line-stacking direction

    // Width fallback: per-character producers, Type3 fonts and some Word
    // exports report width 0, which collapses every run onto its own origin
    // and shreds each line into one block per glyph. A rough advance estimate
    // keeps those documents groupable.
    let width = Math.max(0, Number(it.width) || 0);
    if (width < size * 0.08) {
      const chars = String(it.str).replace(/\s+/g, '').length || 1;
      width = chars * size * 0.5;
    }

    runs.push({
      index, text: it.str, x: t[4], y: t[5], end: t[4] + width * u[0], endY: t[5] + width * u[1],
      width, size, angle, rot, u, n,
      font: it.fontName,
      family: tc.styles?.[it.fontName]?.fontFamily || 'Helvetica',
      eol: !!it.hasEOL,
    });
  }
  /* A gutter-bridging space is a positioning artifact, not content, so drop it
   * before grouping. Left in the stream it does one of two wrong things: it
   * glues two cells into a single editable block, or — once the merge guards
   * below refuse to attach it — it becomes a stray " " block of its own that
   * sits over the gutter and destroys the column boundary. */
  for (let i = runs.length - 1; i >= 0; i--) if (wideSpace(runs[i])) runs.splice(i, 1);

  // Reading order: top-to-bottom, then left-to-right, within a rotation group.
  runs.sort((a, b) => b.y - a.y || a.x - b.x);
  return runs;
}

/**
 * One axis-aligned box per text item, in PDF space — the item-level geometry a
 * table needs to decide which CELL a piece of text belongs to. Block-level
 * geometry cannot answer that when a producer emits a whole row as one run.
 */
export function textItemBoxes(tc) {
  return textRuns(tc)
    .filter((r) => r.rot === 0)
    .map((r) => ({
      index: r.index,
      text: r.text,
      size: r.size,
      rect: [Math.min(r.x, r.end), r.y - r.size * 0.28, Math.max(r.x, r.end), r.y + r.size * 1.08],
    }));
}

export function groupTextBlocks(tc, pageWidth = 595, only = null) {
  const runs = textRuns(tc, only);
  if (!runs.length) return [];

  /* ── Runs → lines ──────────────────────────────────────────────────── */
  const lines = [];
  for (const run of runs) {
    const prev = lines[lines.length - 1];
    const last = prev?.runs[prev.runs.length - 1];
    if (prev && last) {
      // Offset from the end of the previous run, in the line's own frame.
      const dx = run.x - last.end;
      const dy = run.y - last.endY;
      const gap = dx * last.u[0] + dy * last.u[1];          // along the baseline
      const drift = dx * last.n[0] + dy * last.n[1];        // across it
      const styleSame = styleKey(run.family, run.size) === styleKey(prev.family, prev.size);
      if (!last.eol
        && !wideSpace(last)
        && !wideSpace(run)
        && run.rot === prev.rot
        && styleSame
        && Math.abs(drift) < Math.max(1.2, run.size * 0.35)
        && gap > -run.size * 0.35 && gap < run.size * 1.5) {
        prev.runs.push(run);
        prev.end = run.end;
        prev.endY = run.endY;
        continue;
      }
    }
    lines.push({
      runs: [run], x: run.x, y: run.y, end: run.end, endY: run.endY,
      size: run.size, rot: run.rot, u: run.u, n: run.n,
      family: run.family, style: styleKey(run.family, run.size),
    });
  }

  /* ── Lines → blocks ────────────────────────────────────────────────── */
  const groups = [];
  for (const line of lines) {
    const prev = groups[groups.length - 1];
    const last = prev?.lines[prev.lines.length - 1];
    if (prev && last) {
      // Distance from the previous line measured along the stacking normal.
      const dy = line.y - last.y;
      const leading = dy * last.n[1] !== 0 ? Math.abs(dy) : Math.abs(dy);
      const indent = Math.abs(line.x - prev.x);
      if (line.rot === prev.rot
        && line.style === prev.style
        && leading > line.size * 0.6 && leading < line.size * 2.0
        && indent < line.size * 2.5) {
        prev.lines.push(line);
        prev.end = Math.max(prev.end, line.end);
        prev.right = Math.max(prev.right, line.end);
        continue;
      }
    }
    groups.push({
      lines: [line], x: line.x, end: line.end, right: line.end,
      style: line.style, family: line.family, size: line.size, rot: line.rot,
    });
  }

  return groups.map((g) => finishBlock(g, pageWidth, 'n', g.lines.flatMap((l) => l.runs.map((r) => r.index))));
}

/**
 * Build the same block shape from OCR lines.
 *
 * `lines` come from Tesseract: { text, bbox:{x0,y0,x1,y1}, confidence, words }.
 * bbox is in canvas pixels at `dpi`; the page is `pageHeight` points tall.
 * PDF space has y increasing upward, canvas has it downward — hence the flip.
 */
export function blocksFromOcrLines(lines, pageWidth, pageHeight, dpi = 200, pageIndex = 0, regionRect = null) {
  const flat = regionRect
    ? flatOcrLinesInRegion(lines, pageHeight, dpi, regionRect)
    : flatOcrLines(lines, pageHeight, dpi);
  return blocksFromFlatOcrLines(flat, pageWidth, pageIndex);
}

/** Group an already-flattened (and possibly region-clipped) OCR line list into
 *  editable blocks. Shared with the per-cell table split so both consume the
 *  SAME word-trimmed lines — one path cannot quietly re-add outside words. */
export function blocksFromFlatOcrLines(flat, pageWidth, pageIndex = 0) {
  if (!flat.length) return [];

  /* Snapping the raw estimates to the page's modal size is the difference
   * between "looks like the original" and "letters sized 11 / 15 / 19
   * alternating on a single body paragraph". Tesseract's per-line bbox is
   * a few percent off depending on which letters happen to be in the line,
   * so the within-paragraph jitter is real, and a human editor would
   * normalise it by hand. A wide tolerance (anything within 0.7x–1.4x of the
   * mode) keeps genuine headings and footnotes apart from body text. */
  const sizes = flat.map((l) => l.size);
  const rounded = sizes.map((s) => Math.round(s * 2) / 2);
  const counts = new Map();
  rounded.forEach((s) => counts.set(s, (counts.get(s) || 0) + 1));
  let mode = rounded[0] || 10;
  let modeCount = 0;
  for (const [s, c] of counts) if (c > modeCount) { mode = s; modeCount = c; }
  const snap = (s) => (s >= mode * 0.72 && s <= mode * 1.4) ? mode : s;
  for (const l of flat) l.size = snap(l.size);

  /* Group OCR lines into paragraphs with the same geometry test as native. */
  const groups = [];
  for (const line of flat) {
    const prev = groups[groups.length - 1];
    const last = prev?.lines[prev.lines.length - 1];
    if (prev && last) {
      const leading = last.bottom - line.bottom;      // next line sits lower
      const indent = Math.abs(line.x - prev.x);
      if (Math.abs(line.size - last.size) < Math.max(1.2, last.size * 0.35)
        && leading > line.size * 0.5 && leading < line.size * 2.1
        && indent < line.size * 2.5) {
        prev.lines.push(line);
        prev.right = Math.max(prev.right, line.end);
        continue;
      }
    }
    groups.push({ lines: [line], x: line.x, end: line.end, right: line.end,
      style: line.style, family: line.family, size: line.size, rot: 0 });
  }

  return groups.map((g) => finishBlock(g, pageWidth, 'o', null, g.lines.map((l) => l.li), pageIndex));
}

/**
 * px → pt conversion for OCR lines (shared by blocksFromOcrLines and the
 * table-aware OCR split in textedit.js). `li` is the index in the GIVEN array;
 * callers that subset the lines must map ids back to the original themselves.
 * Word boxes are kept so a line that spans several table columns can be cut
 * at the gutters.
 */
export function flatOcrLines(lines, pageHeight, dpi = 200) {
  if (!Array.isArray(lines) || !lines.length) return [];
  const s = 72 / (dpi || 200);                      // px → pt
  const flat = [];
  for (let li = 0; li < lines.length; li++) {
    const ln = lines[li];
    const text = String(ln.text || '').trim();
    if (!text) continue;
    const words = Array.isArray(ln.words) ? ln.words : [];

    // Lines recognised on a rotated page already carry their true PDF-space
    // rect (converted through the render viewport's inverse) — use it as-is.
    if (Array.isArray(ln.pdfRect) && ln.pdfRect.length === 4 && ln.pdfRect.every(Number.isFinite)) {
      const [px0, py0, px1, py1] = ln.pdfRect;
      const wHs = words.map((w) => (w.pdfRect ? w.pdfRect[3] - w.pdfRect[1] : 0)).filter((h) => h > 0.5).sort((a, b) => a - b);
      const med = wHs.length ? wHs[Math.floor(wHs.length / 2)] : (py1 - py0);
      const size = clampNum(med / 0.72, 4, 96) || clampNum(py1 - py0, 4, 96);
      flat.push({
        li, text,
        x: px0, end: px1,
        top: py1, bottom: py0,
        baseline: py0 + 0.23 * (py1 - py0),
        size, rot: 0, style: styleKey('Helvetica', Math.round(size)),
        family: 'Helvetica',
        confidence: ln.confidence ?? null,
        words,
      });
      continue;
    }

    const bb = ln.bbox || {};
    const x0 = Number(bb.x0) || 0, x1 = Number(bb.x1) || 0;
    const y0 = Number(bb.y0) || 0, y1 = Number(bb.y1) || 0;
    if (x1 <= x0 || y1 <= y0) continue;

    // Median word height is the most reliable size signal Tesseract gives.
    const hs = words.map((w) => (w.bbox?.y1 || 0) - (w.bbox?.y0 || 0)).filter((h) => h > 1).sort((a, b) => a - b);
    const med = hs.length ? hs[Math.floor(hs.length / 2)] : (y1 - y0);
    const boxH = (y1 - y0) * s;
    const size = clampNum((med * s) / 0.72, 4, 96) || clampNum(boxH * 1.05, 4, 96);

    const top = pageHeight - y0 * s;                // topmost y in PDF space
    const bottom = pageHeight - y1 * s;
    flat.push({
      li, text,
      x: x0 * s, end: x1 * s,
      top, bottom,
      baseline: bottom + 0.23 * boxH,
      size, rot: 0, style: styleKey('Helvetica', Math.round(size)),
      family: 'Helvetica',
      confidence: ln.confidence ?? null,
      words,
    });
  }
  return flat;
}

/** Word boxes of a flattened OCR line, in PDF points, left to right.
 *
 *  Region reads carry `pdfRect` on each word (converted through the render
 *  viewport's inverse); whole-page Tesseract reads carry pixel `bbox`, which
 *  is rescaled onto the line's own point span. Lines with no usable word boxes
 *  (AI-vision OCR emits one line per cell) are treated as a single word — they
 *  can only be kept whole, never silently widened. */
function ocrWordRects(line) {
  const raw = Array.isArray(line.words) ? line.words : [];
  const pdf = raw.filter((w) => w && Array.isArray(w.pdfRect) && w.pdfRect.length === 4
    && String(w.text || '').trim());
  if (pdf.length) {
    return pdf.sort((a, b) => a.pdfRect[0] - b.pdfRect[0]).map((w) => ({
      x0: w.pdfRect[0], x1: w.pdfRect[2], text: String(w.text).trim(), raw: w,
    }));
  }
  const bb = raw.filter((w) => w && w.bbox && String(w.text || '').trim());
  if (bb.length) {
    const minX = Math.min(...bb.map((w) => Number(w.bbox.x0) || 0));
    const maxX = Math.max(...bb.map((w) => Number(w.bbox.x1) || 0));
    const k = (line.end - line.x) / Math.max(1, maxX - minX);
    return bb.sort((a, b) => a.bbox.x0 - b.bbox.x0).map((w) => ({
      x0: line.x + ((Number(w.bbox.x0) || 0) - minX) * k,
      x1: line.x + ((Number(w.bbox.x1) || 0) - minX) * k,
      text: String(w.text).trim(), raw: w,
    }));
  }
  return [{ x0: line.x, x1: line.end, text: String(line.text || '').trim(), raw: null }];
}

/**
 * Flatten an OCR result for ONE marquee, at WORD precision.
 *
 * The line gate is the established centre-inside test (so a neighbouring line
 * that only grazes the box never joins). What changes here is horizontal:
 * a whole recognised line used to become editable as soon as its centre was
 * inside, taking every word past the box edge with it. Now only words whose
 * boxes are FULLY inside survive, and the line's text and geometry are rebuilt
 * from exactly those words. A line with no word left in the box is dropped.
 */
export function flatOcrLinesInRegion(lines, pageHeight, dpi, region, tol = 1) {
  if (!Array.isArray(region) || region.length !== 4) return flatOcrLines(lines, pageHeight, dpi);
  const out = [];
  for (const line of flatOcrLines(lines, pageHeight, dpi)) {
    if (!rectCentreInside([line.x, line.bottom, line.end, line.top], region)) continue;
    const kept = ocrWordRects(line).filter((w) => w.x1 > w.x0
      && w.x0 >= region[0] - tol && w.x1 <= region[2] + tol);
    if (!kept.length) continue;
    const x = Math.max(region[0], Math.min(...kept.map((w) => w.x0)));
    const end = Math.min(region[2], Math.max(...kept.map((w) => w.x1)));
    const text = kept.map((w) => w.text).join(' ').replace(/\s+/gu, ' ').trim();
    if (!text) continue;
    out.push({
      ...line, x, end, right: end, text,
      words: kept.map((w) => w.raw).filter(Boolean),
      // Geometry stops at the box, so a hit target can never sit outside it.
      top: Math.min(line.top, region[3]), bottom: Math.max(line.bottom, region[1]),
    });
  }
  return out;
}

/**
 * Cut OCR lines into column-candidate segments.
 *
 * Tesseract happily reads straight across a table row, so one "line" can
 * contain several cells. Two boundary signals cut it apart:
 *  - standalone "|" glyphs: the table RULES themselves survive OCR as pipes,
 *    exactly on the column boundaries — split there and drop the pipe;
 *  - word gaps clearly wider than normal spacing (≥ ~1.8 em) for borderless
 *    tables.
 * Lines without word boxes (AI-vision OCR) pass through as single segments.
 */
export function ocrSplitSegments(flat) {
  const RULE_GLYPH = /^[|｜│︱︲]+$/;
  const out = [];
  for (const line of flat) {
    // Words already carrying PDF-space rects (converted by the caller) cut
    // straight at rule glyphs and wide gaps — no dpi rescale needed.
    const pdfWords = (line.words || []).filter((w) => w && w.pdfRect && String(w.text || '').trim());
    if (pdfWords.length >= 2) {
      const ordered = pdfWords.slice().sort((a, b) => a.pdfRect[0] - b.pdfRect[0]);
      const threshold = Math.max(line.size * 1.8, 9);
      let cur = null;
      const segs = [];
      const push = () => {
        if (cur && cur.words.length) {
          const text = cur.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
          if (text) segs.push({
            x0: Math.min(...cur.words.map((w) => w.pdfRect[0])),
            x1: Math.max(...cur.words.map((w) => w.pdfRect[2])),
            text,
          });
        }
        cur = null;
      };
      for (const w of ordered) {
        const rule = RULE_GLYPH.test(String(w.text || '').trim());
        if (rule) { push(); continue; }
        if (cur && w.pdfRect[0] - cur.lastX1 >= threshold) push();
        if (!cur) cur = { words: [], lastX1: w.pdfRect[0] };
        cur.words.push(w);
        cur.lastX1 = w.pdfRect[2];
      }
      push();
      if (segs.length > 1) {
        for (const seg of segs) {
          out.push({ i: out.length, li: line.li, rect: [seg.x0, line.bottom, seg.x1, line.top], text: seg.text, size: line.size });
        }
        continue;
      }
    }
    const words = (line.words || []).filter((w) => w && w.bbox && String(w.text || '').trim());
    if (words.length < 2) {
      out.push({ i: out.length, li: line.li, rect: [line.x, line.bottom, line.end, line.top], text: line.text, size: line.size });
      continue;
    }
    // Rescale word boxes onto the line's own pt span so the segmentation is
    // dpi-independent, then cut at rule glyphs and wide gaps.
    const wLine = Math.min(...words.map((w) => w.bbox.x0));
    const wMax = Math.max(...words.map((w) => w.bbox.x1));
    const k = (line.end - line.x) / Math.max(1, wMax - wLine); // px → pt for this line
    const scaled = words.map((w) => ({
      x0: line.x + (w.bbox.x0 - wLine) * k,
      x1: line.x + (w.bbox.x1 - wLine) * k,
      text: String(w.text || '').trim(),
      rule: RULE_GLYPH.test(String(w.text || '').trim()),
    }));
    const threshold = Math.max(line.size * 1.8, 9);
    let cur = null;
    const segs = [];
    const push = () => {
      if (cur && cur.words.length) {
        const text = cur.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
        if (text) {
          segs.push({
            x0: Math.min(...cur.words.map((w) => w.x0)),
            x1: Math.max(...cur.words.map((w) => w.x1)),
            text,
          });
        }
      }
      cur = null;
    };
    for (const w of scaled) {
      if (w.rule) { push(); continue; }         // a rule glyph is a boundary, not text
      if (cur && w.x0 - cur.lastX1 >= threshold) push();
      if (!cur) cur = { words: [], lastX1: w.x0 };
      cur.words.push(w);
      cur.lastX1 = w.x1;
    }
    push();
    if (segs.length <= 1) {
      out.push({ i: out.length, li: line.li, rect: [line.x, line.bottom, line.end, line.top], text: line.text, size: line.size });
      continue;
    }
    for (const seg of segs) {
      out.push({ i: out.length, li: line.li, rect: [seg.x0, line.bottom, seg.x1, line.top], text: seg.text, size: line.size });
    }
  }
  return out;
}

/**
 * Build the OCR line list from a structured AI-vision response.
 *
 * The vision model sees table rules directly, so (as in the user's proven
 * PDF→Word flow) it returns every TABLE CELL explicitly — row, col, text and
 * its pixel bbox. Cell entries become ordinary lines (one per cell), and any
 * freeform line whose centre falls inside a cell is dropped, since the model
 * already emitted that text as the cell. Output matches the Tesseract line
 * shape ({text, bbox, confidence}) so every downstream consumer — editable
 * blocks, the per-cell table split, the Direct Editor — works unchanged.
 * Returns [] when the payload holds nothing usable (caller falls back).
 */
export function buildStructuredOcrLines(ai) {
  const raw = ai && typeof ai === 'object' ? ai : null;
  const normBbox = (b) => {
    const bb = b || {};
    const x0 = Number(bb.x0), y0 = Number(bb.y0), x1 = Number(bb.x1), y1 = Number(bb.y1);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
    return { x0, y0, x1, y1 };
  };
  const cells = [];
  for (const table of Array.isArray(raw?.tables) ? raw.tables : []) {
    for (const cell of Array.isArray(table?.cells) ? table.cells : []) {
      const bbox = normBbox(cell?.bbox);
      const text = String(cell?.text ?? '').trim();
      if (!bbox || !text) continue; // an empty cell is a place to type, not a line
      cells.push({ text, bbox, confidence: null, words: [] });
    }
  }
  const freeform = [];
  for (const ln of Array.isArray(raw?.lines) ? raw.lines : []) {
    const bbox = normBbox(ln?.bbox);
    const text = String(ln?.text ?? '').trim();
    if (!bbox || !text) continue;
    freeform.push({ text, bbox, confidence: ln.confidence ?? null, words: [] });
  }
  // Drop freeform lines the cell grid already accounts for.
  const kept = freeform.filter((ln) => {
    const cx = (ln.bbox.x0 + ln.bbox.x1) / 2, cy = (ln.bbox.y0 + ln.bbox.y1) / 2;
    return !cells.some((c) => cx >= c.bbox.x0 && cx <= c.bbox.x1 && cy >= c.bbox.y0 && cy <= c.bbox.y1);
  });
  const out = [...kept, ...cells]
    .sort((a, b) => (a.bbox.y0 - b.bbox.y0) || (a.bbox.x0 - b.bbox.x0));
  return out;
}

/**
 * Build ONE editable block for a table cell from the OCR line subset that
 * lives in it. Geometry mirrors blocksFromOcrLines (same finishBlock step);
 * `lineIds` keeps the ORIGINAL OCR line ids so the editor's identity/wash
 * machinery keeps working, and `cellRect` clamps the ownership rectangle so
 * an edit in this cell never excises the neighbour's text.
 */
export function ocrCellBlock(segments, flatByLi, cellRect, pageWidth, pageIndex = 0) {
  const byLi = new Map();
  for (const seg of segments) if (!byLi.has(seg.li)) byLi.set(seg.li, []);
  for (const seg of segments) byLi.get(seg.li).push(seg);
  const lineIds = [...byLi.keys()].sort((a, b) => a - b);
  const g = { lines: [], x: Infinity, end: -Infinity, right: -Infinity };
  for (const li of lineIds) {
    const flat = flatByLi.get(li);
    if (!flat) continue;
    const segs = byLi.get(li);
    const x0 = Math.min(...segs.map((s) => s.rect[0]));
    const x1 = Math.max(...segs.map((s) => s.rect[2]));
    g.lines.push({
      li, text: segs.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(),
      x: x0, end: x1, top: flat.top, bottom: flat.bottom, baseline: flat.baseline,
      size: flat.size, style: flat.style, family: flat.family, rot: 0,
    });
    g.x = Math.min(g.x, x0);
    g.end = Math.max(g.end, x1);
    g.right = Math.max(g.right, x1);
  }
  if (!g.lines.length) return null;
  g.size = g.lines[0].size;
  g.family = g.lines[0].family;
  g.style = g.lines[0].style;
  g.rot = 0;
  const block = finishBlock(g, pageWidth, 'o', null, lineIds, pageIndex);
  const own = [
    Math.max(block.coverRect[0], cellRect[0]),
    Math.max(block.coverRect[1], cellRect[1]),
    Math.min(block.coverRect[2], cellRect[2]),
    Math.min(block.coverRect[3], cellRect[3]),
  ];
  block.ownRect = (own[2] - own[0] > 0.5 && own[3] - own[1] > 0.5) ? own : block.coverRect.slice();
  return block;
}

/** Shared finishing step: text, geometry and the stable identity key. */
function finishBlock(g, pageWidth, kind, itemIndices, lineIds, pageIndex = 0) {
  const isOcr = kind === 'o';
  const text = isOcr
    ? g.lines.map((l) => l.text).join('\n')
    : g.lines.map((line) => line.runs.map((r, j) => {
      if (!j) return r.text;
      const previous = line.runs[j - 1];
      const gap = r.x - previous.end;
      return gap > line.size * 0.16 && !/\s$/.test(previous.text) && !/^\s/.test(r.text) ? ' ' + r.text : r.text;
    }).join('')).join('\n');

  const indices = isOcr ? [] : (itemIndices || []).slice().sort((a, b) => a - b);

  let low, high, baseline, angle = 0;
  if (isOcr) {
    const first = g.lines[0], last = g.lines[g.lines.length - 1];
    low = last.bottom;
    high = first.top;
    baseline = [first.x, first.baseline];
  } else {
    const last = g.lines[g.lines.length - 1];
    const first = g.lines[0];
    low = last.y - last.size * 0.28;
    high = first.y + first.size * 1.08;
    baseline = [first.x, first.y];
    angle = first.rot || 0;
  }

  const left = Math.min(...g.lines.map((l) => l.x));
  const right = Math.max(...g.lines.map((l) => (isOcr ? l.end : l.end)));
  const coverRect = [left - 0.7, Math.min(low, high), right + 0.7, Math.max(low, high)];

  const key = isOcr
    ? `o:${pageIndex}:${(lineIds || []).join('.')}`
    : `n:${indices.join('.')}`;

  return {
    key, kind,
    itemIndices: indices,
    lineIds: isOcr ? (lineIds || []) : undefined,
    text, size: g.size, fontFamily: g.family,
    baseline, color: [0, 0, 0],
    coverRect, rect: coverRect.slice(),
    angle,
    maxWidth: Math.max(10, Math.min(Math.max(10, (pageWidth || 595) - left - 3), right - left + 3)),
    maxHeight: Math.abs(coverRect[3] - coverRect[1]),
    lineHeight: g.lines.length > 1
      ? Math.abs((isOcr ? g.lines[0].top : g.lines[0].y) - (isOcr ? g.lines[g.lines.length - 1].top : g.lines[g.lines.length - 1].y)) / (g.lines.length - 1)
      : g.size * 1.2,
  };
}

/** Find the pending edit that owns a block.
 *
 *  OCR blocks have no text-item indices, so identity comes from `key`. Native
 *  blocks match on `key` too when it exists, and fall back to index overlap
 *  for edits recorded before keys were introduced. */
export function editForBlock(doc, page, block) {
  const list = doc?.textEdits || [];
  if (!list.length) return undefined;
  // An area edit owns a FRAGMENT of a source run; a whole-page edit owns the
  // run. Their item indices overlap, so without this guard re-selecting an area
  // would resolve to the whole-page edit (and vice versa) and wash the wrong box.
  // Two DIFFERENT areas are separate scopes too: a marquee over the middle of
  // a line and one over its end both clip down to "one item" and would share a
  // key if the rectangle were not part of the identity.
  const scopeKey = (o) => Array.isArray(o?.regionRect)
    ? o.regionRect.map((v) => Number(v).toFixed(1)).join(',') : '';
  const sameScope = (e) => e.page === page && scopeKey(e) === scopeKey(block);
  if (block.key) {
    const byKey = list.find((e) => e.key === block.key && sameScope(e));
    if (byKey) return byKey;
  }
  /* The item-index fallback is a fuzzy identity for whole-page blocks only.
   * Area blocks are fragments: several of them can map back to the SAME
   * original show-text operator, so an index match here would resolve them
   * all to whichever edit was committed first. Their key is exact. */
  if (Array.isArray(block.regionRect) || !block.itemIndices?.length) return undefined;
  const ids = new Set(block.itemIndices);
  return list.find((e) => e.page === page && !e.regionRect
    && e.itemIndices?.some((i) => ids.has(i)));
}

/* ── Cover + free-move model ─────────────────────────────────────────────
 *
 * A committed Direct Editor edit owns TWO footprints in PDF space:
 *
 *  - coverRect: fixed over the ORIGINAL text. The writer always paints it
 *    opaque, so the old glyphs never show through. It never moves — moving
 *    it would uncover the original.
 *  - the text box (rect + baseline): where the replacement is drawn. The
 *    user can drag it anywhere on the page; the cover stays behind.
 *
 * translateTextEdit moves the text box only. Pure (no DOM): unit-tested in
 * scripts/tools-test.mjs alongside the other planners. */

export function translateTextEdit(edit, dx, dy) {
  if (!edit || !Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return edit;
  const shiftRect = (r) => (Array.isArray(r) && r.length === 4
    ? [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] : r);
  if (Array.isArray(edit.rect)) edit.rect = shiftRect(edit.rect);
  if (Array.isArray(edit.baseline)) edit.baseline = [edit.baseline[0] + dx, edit.baseline[1] + dy];
  // coverRect and exciseRect deliberately untouched: the cover must keep
  // hiding the original text no matter where the replacement travels.
  return edit;
}

/** PDF-space box the replacement text is drawn in. The on-screen preview
 *  (annots.js) and the writer (pdfwrite.js) share it so the background wash
 *  behind moved text matches what the saved file paints. Falls back to the
 *  edit's rect for single-run edits, which carry no baseline box. */
export function textEditDrawBox(e) {
  if (!e) return null;
  if (e.itemIndices?.length && Array.isArray(e.baseline) && e.baseline.length === 2) {
    const size = Number(e.size) || 11;
    return [
      e.baseline[0],
      e.baseline[1] - size * 0.3 - (Number(e.maxHeight) || 0),
      e.baseline[0] + (Number(e.maxWidth) || 10),
      e.baseline[1] + size * 1.1,
    ];
  }
  return Array.isArray(e.rect) ? e.rect.slice() : null;
}

const sameRect = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === 4 && b.length === 4
  && a.every((v, k) => Math.abs(v - b[k]) < 1e-6);

/**
 * Every rect the writer must wash before drawing the replacement: the fixed
 * cover over the original, every box a previous save drew into (so
 * move → save → move → save cannot leave ghost copies in the file), and the
 * current draw box. The preview paints the same list — screen and file agree.
 */
export function textEditWashes(e) {
  const out = [];
  const push = (r) => {
    if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isFinite)) return;
    if (!out.some((o) => sameRect(o, r))) out.push(r.slice());
  };
  push(e?.coverRect);
  for (const b of e?.priorBoxes || []) push(b);
  push(textEditDrawBox(e));
  return out;
}

export function blockText(doc, page, block) {
  return editForBlock(doc, page, block)?.text ?? block.text;
}

/* Shared wrapping policy for preview and writer; caller supplies actual font
 * metrics. Explicit newlines are kept; a word longer than the box is split. */
export function wrapBlockText(text, maxWidth, measure) {
  const out = [];
  for (const paragraph of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!paragraph) { out.push(''); continue; }
    let line = '';
    for (const part of paragraph.match(/\S+\s*|\s+/gu) || []) {
      if (line && measure(line + part) > maxWidth) { out.push(line.trimEnd()); line = part.trimStart(); }
      else line += part;
      while (line.length > 1 && measure(line) > maxWidth) {
        let cut = 1;
        while (cut < line.length && measure(line.slice(0, cut + 1)) <= maxWidth) cut++;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
