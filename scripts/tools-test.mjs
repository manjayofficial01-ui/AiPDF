#!/usr/bin/env node
/**
 * Unit tests for the new batch-document tools:
 *   - src/renderer/js/compare.js   (LCS page/text diff, report)
 *   - src/renderer/js/docxtools.js (range parsing, blank-page rule, colour adjust)
 *   - src/renderer/js/textblocks.js (cover + free-move geometry for text edits)
 *
 * Pure Node, no Electron, no DOM.
 *
 *   node scripts/tools-test.mjs
 */
import assert from 'node:assert/strict';
import {
  toLines, normalizeLine, diffPages, buildComparison, comparisonReport, countWords,
} from '../src/renderer/js/compare.js';
import {
  parsePageRange, allPages, findBlankPages, isBlankPage,
  filterSpecToFactors, applyColorAdjust, colorPresetById, COLOR_PRESETS, fmtSize,
  scalePages, removeBlankPages, rasterizePages, clearRasterFilter, pageIndices,
} from '../src/renderer/js/docxtools.js';
import {
  translateTextEdit, textEditDrawBox, textEditWashes,
} from '../src/renderer/js/textblocks.js';

let n = 0;
function t(name, fn) {
  try { fn(); n++; console.log(`PASS  ${name}`); }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

/* ── compare: line handling ─────────────────────────────────────────────── */

t('toLines trims and drops blanks', () => {
  assert.deepEqual(toLines('  a  \n\n b\nc  '), ['a', 'b', 'c']);
});

t('normalizeLine collapses whitespace and case', () => {
  assert.equal(normalizeLine('  The   QUICK  brown '), 'the quick brown');
});

t('diffPages finds an added line', () => {
  const d = diffPages('alpha\nbeta', 'alpha\ngamma\nbeta');
  assert.equal(d.changed, true);
  assert.deepEqual(d.added, ['gamma']);
  assert.deepEqual(d.removed, []);
  assert.equal(d.matched, 2);
});

t('diffPages finds a removed line', () => {
  const d = diffPages('a\nb\nc', 'a\nc');
  assert.deepEqual(d.removed, ['b']);
  assert.deepEqual(d.added, []);
});

t('diffPages is order-sensitive (reordering is a change)', () => {
  const d = diffPages('a\nb', 'b\na');
  assert.equal(d.changed, true);
});

t('diffPages ignores blank/formatting noise by default', () => {
  const d = diffPages('Hello   World', 'hello world');
  assert.equal(d.changed, false);
});

t('diffPages honours normalize:false for strict comparison', () => {
  const d = diffPages('Hello World', 'hello world', { normalize: false });
  assert.equal(d.changed, true);
});

t('a single word change is a small diff, not a page rewrite', () => {
  const base = Array.from({ length: 40 }, (_, i) => `sentence number ${i}`);
  const edited = base.slice();
  edited[12] = 'sentence number thirteen';
  const d = diffPages(base.join('\n'), edited.join('\n'));
  // matched counts LCS pairs: the one changed line matches nothing, the
  // other 39 lines are common — that is what keeps the diff small.
  assert.equal(d.matched, 39);
  assert.deepEqual(d.added, ['sentence number thirteen']);
  assert.deepEqual(d.removed, ['sentence number 12']);
});

/* ── compare: document-level ────────────────────────────────────────────── */

t('buildComparison matches pages pairwise', () => {
  const cmp = buildComparison(['p1 v1', 'p2', 'p3'], ['p1 v1', 'p2', 'p3']);
  assert.equal(cmp.summary.changed, 0);
  assert.equal(cmp.summary.identical, 3);
});

t('buildComparison handles different page counts', () => {
  const cmp = buildComparison(['only in a', ''], ['', 'only in b', 'extra']);
  assert.equal(cmp.summary.pages, 3);
});

t('comparisonReport lists +/- lines per changed page', () => {
  const cmp = buildComparison(['keep', 'gone'], ['keep', 'new']);
  const r = comparisonReport(cmp, 'OLD.pdf', 'NEW.pdf');
  assert.match(r, /Comparison of OLD\.pdf vs NEW\.pdf/);
  assert.match(r, /1 changed · 1 identical/);
  assert.match(r, /Page 2/);
  assert.match(r, /- gone/);
  assert.match(r, /\+ new/);
  // The report prints the typographic minus (U+2212) for the removed-word count.
  assert.match(r, /\u22121 words/);
});

t('countWords counts words across lines', () => {
  assert.equal(countWords(['two words', 'one']), 3);
});

/* ── docxtools: ranges ──────────────────────────────────────────────────── */

t('parsePageRange parses mixes of ranges and singletons', () => {
  assert.deepEqual(parsePageRange('1-3,5,8-10', 10), [0, 1, 2, 4, 7, 8, 9]);
});

t('parsePageRange clamps out-of-range and dedupes', () => {
  assert.deepEqual(parsePageRange('0,1,1,2,99', 2), [0, 1]);
});

t('parsePageRange reverses reversed ranges', () => {
  assert.deepEqual(parsePageRange('5-3', 10), [2, 3, 4]);
});

t('parsePageRange tolerates junk', () => {
  assert.deepEqual(parsePageRange('abc, ,2', 3), [1]);
});

t('allPages is 0-based and complete', () => {
  assert.deepEqual(allPages(3), [0, 1, 2]);
});

/* ── docxtools: blank pages ─────────────────────────────────────────────── */

t('findBlankPages flags pages with no text and no ops', () => {
  const list = [{ hasText: true, hasOps: false }, { hasText: false, hasOps: false }, { hasText: false, hasOps: true }];
  assert.deepEqual(findBlankPages(list), [1]);
});

t('a page with text only is not blank', () => {
  assert.equal(isBlankPage({ hasText: true, hasOps: false }), false);
});

/* ── docxtools: colour adjustment ───────────────────────────────────────── */

t('filterSpecToFactors parses CSS filters', () => {
  const f = filterSpecToFactors('brightness(1.18) contrast(1.2)');
  assert.equal(f.brightness, 1.18);
  assert.equal(f.contrast, 1.2);
  assert.equal(f.invert, 0);
});

t('filterSpecToFactors returns null when nothing changes', () => {
  assert.equal(filterSpecToFactors(''), null);
  assert.equal(filterSpecToFactors('blur(3px)'), null);
});

t('applyColorAdjust inverts an opaque pixel', () => {
  const px = new Uint8ClampedArray([10, 20, 30, 255]);
  const out = applyColorAdjust(px, filterSpecToFactors('invert(1)'));
  assert.deepEqual([out[0], out[1], out[2], out[3]], [245, 235, 225, 255]);
});

t('applyColorAdjust brightens', () => {
  const px = new Uint8ClampedArray([100, 100, 100, 255]);
  const out = applyColorAdjust(px, filterSpecToFactors('brightness(2)'));
  assert.equal(out[0], 200);
});

t('applyColorAdjust preserves alpha and length', () => {
  const px = new Uint8ClampedArray([100, 40, 0, 128]);
  const out = applyColorAdjust(px, filterSpecToFactors('contrast(2)'));
  assert.equal(out.length, 4);
  assert.equal(out[3], 128);
});

t('every colour preset maps to factors', () => {
  for (const p of COLOR_PRESETS) {
    assert.ok(filterSpecToFactors(p.filter), `preset ${p.id}`);
    assert.ok(colorPresetById(p.id), `lookup ${p.id}`);
  }
});

t('scanner preset is grayscale + contrast', () => {
  const f = filterSpecToFactors(colorPresetById('scan').filter);
  assert.equal(f.grayscale, 0.85);
  assert.ok(f.contrast > 1);
});

/* ── docxtools: formatting ─────────────────────────────────────────────── */

t('fmtSize renders B / KB / MB', () => {
  assert.equal(fmtSize(512), '512 B');
  assert.equal(fmtSize(2048), '2.0 KB');
  assert.equal(fmtSize(5 * 1024 * 1024), '5.00 MB');
});

/* ── docxtools: page-op model mutators ─────────────────────────────────── */

function opModel(n) {
  return { numPages: n, pageOps: { items: Array.from({ length: n }, (_, i) => ({ t: 'src', i })) } };
}

t('pageIndices is 0-based and matches numPages', () => {
  assert.deepEqual(pageIndices(opModel(3)), [0, 1, 2]);
});

t('scalePages wraps every op with its scale factor', () => {
  const m = opModel(3);
  const n = scalePages(m, 0.5);
  assert.equal(n, 3);
  assert.equal(m.pageOps.items.length, 3);
  assert.deepEqual(m.pageOps.items[0], { t: 'scaled', i: 0, sx: 0.5, sy: 0.5 });
  assert.equal(m.pageOps.items[2].sx, 0.5);
});

t('scalePages keeps blank pages in place as scaled blanks', () => {
  const m = opModel(1);
  m.pageOps.items[0] = { t: 'blank', w: 400, h: 400 };
  scalePages(m, 2);
  assert.deepEqual(m.pageOps.items[0], { t: 'scaled-blank', sx: 2, sy: 2, w: 800, h: 800 });
});

t('scalePages ignores a no-op factor', () => {
  const m = opModel(2);
  const before = JSON.stringify(m.pageOps.items);
  assert.equal(scalePages(m, 1), 0);
  assert.equal(JSON.stringify(m.pageOps.items), before);
});

t('scalePages rejects nonsense', () => {
  const m = opModel(2);
  const before = JSON.stringify(m.pageOps.items);
  assert.equal(scalePages(m, 0), 0);
  assert.equal(scalePages(m, -3), 0);
  assert.equal(scalePages(null, 2), 0);
  assert.equal(JSON.stringify(m.pageOps.items), before);
});

t('scalePages builds the op list for a document with no ops', () => {
  const m = { numPages: 2 };
  // A fresh document has no pageOps yet; ensureOps() creates one from the
  // page count, so every page is scaled — 0 would mean "nothing to do".
  assert.equal(scalePages(m, 2), 2);
  assert.deepEqual(m.pageOps.items.map((x) => x.t), ['scaled', 'scaled']);
});

t('removeBlankPages drops the flagged pages', () => {
  const m = opModel(4);
  const r = removeBlankPages(m, [false, true, false, true]);
  assert.deepEqual(r, { removed: 2, remaining: 2 });
  assert.deepEqual(m.pageOps.items.map((x) => x.i), [0, 2]);
});

t('removeBlankPages refuses to empty the document', () => {
  const m = opModel(2);
  const r = removeBlankPages(m, [true, true]);
  assert.equal(r.removed, 0);
  assert.equal(m.pageOps.items.length, 2);
});

t('removeBlankPages leaves the model alone when nothing is blank', () => {
  const m = opModel(3);
  const before = JSON.stringify(m.pageOps.items);
  const r = removeBlankPages(m, [false, false, false]);
  assert.equal(r.removed, 0);
  assert.equal(r.remaining, 3);
  assert.equal(JSON.stringify(m.pageOps.items), before);
});

t('removeBlankPages never drops a non-src op (inserted/blank/file)', () => {
  const m = opModel(3);
  m.pageOps.items[1] = { t: 'file', bytes: new Uint8Array([1, 2, 3]), pages: [0] };
  const r = removeBlankPages(m, [true, true, true]);
  assert.equal(r.removed, 2);
  assert.equal(m.pageOps.items.length, 1);
  assert.equal(m.pageOps.items[0].t, 'file');
});

t('rasterizePages converts the requested pages and carries the filter', () => {
  const m = opModel(3);
  const n = rasterizePages(m, [1], 'invert(1)', 200);
  assert.equal(n, 1);
  assert.equal(m.pageOps.items[0].t, 'src');
  assert.equal(m.pageOps.items[1].t, 'raster');
  assert.equal(m.pageOps.items[1].filter, 'invert(1)');
  assert.equal(m.pageOps.items[1].dpi, 200);
});

t('rasterizePages skips an empty page list', () => {
  const m = opModel(2);
  assert.equal(rasterizePages(m, [], 'invert(1)'), 0);
  assert.equal(m.pageOps.items[0].t, 'src');
});

t('clearRasterFilter restores plain rasterisation', () => {
  const m = opModel(2);
  rasterizePages(m, [0, 1], 'grayscale(1)');
  assert.equal(clearRasterFilter(m), 2);
  assert.equal('filter' in m.pageOps.items[0], false);
});

/* ── textblocks: cover + free-move geometry ───────────────────────────── */

t('translateTextEdit moves the text box but never the cover', () => {
  const e = {
    rect: [10, 20, 110, 40], baseline: [10, 36], coverRect: [10, 20, 110, 40],
    exciseRect: [10, 20, 110, 40],
  };
  translateTextEdit(e, 50, -15);
  assert.deepEqual(e.rect, [60, 5, 160, 25]);
  assert.deepEqual(e.baseline, [60, 21]);
  assert.deepEqual(e.coverRect, [10, 20, 110, 40]);
  assert.deepEqual(e.exciseRect, [10, 20, 110, 40]);
});

t('translateTextEdit tolerates missing geometry and zero deltas', () => {
  const e = { rect: [0, 0, 10, 10] };
  translateTextEdit(e, 0, 0);
  assert.deepEqual(e.rect, [0, 0, 10, 10]);
  translateTextEdit(e, 5, 5);
  assert.deepEqual(e.rect, [5, 5, 15, 15]);
  assert.equal(e.baseline, undefined);
  assert.equal(translateTextEdit(null, 1, 1), null);
});

t('textEditDrawBox follows the baseline for block edits', () => {
  const e = { itemIndices: [3, 4], baseline: [100, 500], size: 12, maxWidth: 200, maxHeight: 30 };
  const b = textEditDrawBox(e);
  assert.equal(b[0], 100);
  assert.ok(b[1] < 500 && b[3] > 500);
  assert.equal(b[2], 300);
});

t('textEditDrawBox falls back to rect for single-run edits', () => {
  const e = { rect: [1, 2, 3, 4] };
  assert.deepEqual(textEditDrawBox(e), [1, 2, 3, 4]);
  assert.equal(textEditDrawBox(null), null);
});

t('textEditWashes covers the original, prior boxes and the current box', () => {
  const e = {
    coverRect: [0, 0, 100, 20],
    priorBoxes: [[0, 0, 100, 20], [200, 200, 300, 230]],
    itemIndices: [1], baseline: [200, 220], size: 12, maxWidth: 100, maxHeight: 20,
  };
  const w = textEditWashes(e);
  assert.ok(w.some((r) => r[0] === 0 && r[1] === 0));
  assert.ok(w.some((r) => r[0] === 200 && r[1] === 200));
  // The duplicate cover in priorBoxes is deduped, not painted twice.
  assert.equal(w.filter((r) => r[0] === 0 && r[1] === 0).length, 1);
  assert.ok(w.length >= 3);
});

t('a moved edit keeps its cover while its washes travel', () => {
  const e = {
    coverRect: [10, 20, 110, 40], rect: [10, 20, 110, 40], baseline: [10, 36],
    itemIndices: [7], size: 11, maxWidth: 100, maxHeight: 20, priorBoxes: [],
  };
  e.priorBoxes.push(textEditDrawBox(e));
  translateTextEdit(e, 0, -100);
  const w = textEditWashes(e);
  // Old box still washed (no ghost), new box washed, cover unmoved.
  assert.ok(w.some((r) => Math.abs(r[1] - (36 - 11 * 0.3 - 20)) < 1));
  assert.ok(w.some((r) => Math.abs(r[1] - (36 - 100 - 11 * 0.3 - 20)) < 1));
  assert.deepEqual(e.coverRect, [10, 20, 110, 40]);
});

console.log(`\n${n} checks passed`);
