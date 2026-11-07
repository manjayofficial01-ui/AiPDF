#!/usr/bin/env node
/**
 * Unit tests for the Stirling integration pack (src/renderer/js/stirling.js).
 * Pure Node, no Electron, no DOM.
 *
 *   node scripts/stirling-test.mjs
 */
import assert from 'node:assert/strict';
import {
  COMPRESS_PRESETS, compressPresetById, planCompress, estimateCompress,
  flattenPlan, sanitizePlan, applySanitizeModel, docInfoSummary, fmtBytesStirling,
  removeAnnotationsPlan, stripImagesPlan, nupPlan, nupGrids, bookletOrder,
  posterTiles, singlePagePlan, splitBySizePlan, chunkByCount, autoRenameSuggest,
  repairCheck, PAGE_NUMBER_FORMATS, pageNumberPlan, autoRotatePlan,
  attachmentOps, unlockFormsPlan, PIPELINE_STEPS, validatePipeline, runPipelineModel,
  pipelineStamps,
} from '../src/renderer/js/stirling.js';

let n = 0;
function t(name, fn) {
  try { fn(); n++; console.log(`PASS  ${name}`); }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

/* ── compress ── */
t('compress presets cover web/balanced/print', () => {
  assert.ok(compressPresetById('web'));
  assert.ok(compressPresetById('balanced'));
  assert.ok(compressPresetById('print'));
  assert.equal(COMPRESS_PRESETS.length >= 4, true);
});
t('planCompress defaults to balanced and selects all pages', () => {
  const p = planCompress({ pageCount: 5 });
  assert.equal(p.dpi, 150);
  assert.deepEqual(p.pages, [0, 1, 2, 3, 4]);
});
t('planCompress honours explicit range + clamps dpi/quality', () => {
  const p = planCompress({ presetId: 'web', dpi: 9999, quality: 99, pageCount: 4, range: [0, 9, -1, 2] });
  assert.equal(p.dpi, 300);
  assert.ok(p.quality <= 0.95);
  assert.deepEqual(p.pages, [0, 2]);
});
t('planCompress empty doc yields no pages', () => {
  assert.deepEqual(planCompress({ pageCount: 0 }).pages, []);
});
t('estimateCompress shrinks with lower dpi', () => {
  const hi = estimateCompress(10_000_000, 10, 200, 0.9);
  const lo = estimateCompress(10_000_000, 10, 100, 0.6);
  assert.ok(lo.estimateBytes < hi.estimateBytes);
});

/* ── flatten / sanitize ── */
t('flattenPlan targets only annotated pages', () => {
  const p = flattenPlan({ pageCount: 4, annots: [{ page: 1 }, { page: 1 }, { page: 3 }] });
  assert.deepEqual(p.pages, [1, 3]);
  assert.equal(p.annotCount, 3);
});
t('flattenPlan with form flag covers every page', () => {
  assert.deepEqual(flattenPlan({ pageCount: 3, annots: [], hasForm: true }).pages, [0, 1, 2]);
});
t('sanitizePlan lists what will be removed', () => {
  const p = sanitizePlan({ attachments: [{}, {}], meta: { title: 'x' }, fields: [{ name: 'a' }] });
  assert.ok(p.removes.join(' ').includes('embedded file'));
  assert.equal(p.attachments, 2);
});
t('applySanitizeModel strips attachments/meta/fields', () => {
  const doc = { attachments: [{ filename: 'a' }], meta: { title: 'T', author: 'A' }, fields: [{ name: 'f' }], newFields: [{ name: 'g' }] };
  const r = applySanitizeModel(doc);
  assert.equal(doc.attachments.length, 0);
  assert.equal(doc.meta.title, '');
  assert.equal(doc.fields.length, 0);
  assert.ok(r.removed >= 3);
});

/* ── info ── */
t('fmtBytesStirling renders B/KB/MB', () => {
  assert.equal(fmtBytesStirling(512), '512 B');
  assert.equal(fmtBytesStirling(2048), '2.0 KB');
});
t('docInfoSummary aggregates page sizes and counts', () => {
  const s = docInfoSummary({ name: 'a.pdf', numPages: 2, pageSizes: [{ w: 595, h: 842 }, { w: 595, h: 842 }], annots: [1, 2], attachments: [], fields: [] }, 1000);
  assert.equal(s.pages, 2);
  assert.equal(s.annotCount, 2);
  assert.equal(s.pageSizes[0].count, 2);
});

/* ── bulk removal ── */
t('removeAnnotationsPlan filters by type', () => {
  const doc = { annots: [{ id: 'a', type: 'highlight' }, { id: 'b', type: 'note' }] };
  assert.equal(removeAnnotationsPlan(doc).count, 2);
  assert.deepEqual(removeAnnotationsPlan(doc, ['note']).ids, ['b']);
});
t('stripImagesPlan all vs range', () => {
  assert.deepEqual(stripImagesPlan(3).pages, [0, 1, 2]);
  assert.deepEqual(stripImagesPlan(3, [2, 9]).pages, [2]);
});

/* ── layout ── */
t('nup grids exist and 4-up sheets fill blanks with -1', () => {
  assert.ok(nupGrids().includes('4-up'));
  const p = nupPlan(5, '4-up');
  assert.equal(p.totalSheets, 2);
  assert.deepEqual(p.sheets[1], [4, -1, -1, -1]);
});
t('bookletOrder pads to multiple of 4', () => {
  const b = bookletOrder(5);
  assert.equal(b.padded, 8);
  assert.equal(b.blanks, 3);
  assert.equal(b.totalSheets, 2);
  assert.deepEqual(b.sheets[0], { front: [7, 0], back: [1, 6] });
});
t('posterTiles yields cols*rows rects', () => {
  const tiles = posterTiles(600, 800, 2, 2);
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles[0].rect, [0, 0, 300, 400]);
});
t('singlePagePlan stacks heights', () => {
  const p = singlePagePlan([{ w: 600, h: 800 }, { w: 600, h: 400 }]);
  assert.equal(p.height, 1200);
  assert.equal(p.placements.length, 2);
  assert.ok(p.placements[0].y > p.placements[1].y);
});

/* ── split / rename / repair ── */
t('splitBySizePlan chunks by average', () => {
  const r = splitBySizePlan(20 * 1024 * 1024, 10, 5);
  assert.ok(r.chunks.length >= 3);
  assert.ok(r.avgPerPage > 0);
});
t('chunkByCount splits evenly', () => {
  assert.deepEqual(chunkByCount(25, 10), [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19], [20, 21, 22, 23, 24]]);
});
t('autoRenameSuggest prefers title then first line', () => {
  assert.equal(autoRenameSuggest({ title: 'My Report' }), 'My Report.pdf');
  assert.equal(autoRenameSuggest({ title: '', firstLines: ['', '  Q3 results  '] }), 'Q3 results.pdf');
  assert.equal(autoRenameSuggest({}), 'document.pdf');
});
t('repairCheck flags empty and accepts minimal header', () => {
  assert.equal(repairCheck(new Uint8Array(0)).ok, false);
  const good = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\nstartxref\n0\n%%EOF');
  const r = repairCheck(good);
  assert.equal(r.ok, true);
});

/* ── page numbers / rotate / attachments / forms ── */
t('pageNumberPlan formats n-of-N across range', () => {
  const p = pageNumberPlan({ formatId: 'n-of-N', pageCount: 5 });
  assert.equal(p.pages.length, 5);
  assert.equal(p.pages[0].text, 'Page 1 of 5');
});
t('pageNumberPlan supports roman numerals', () => {
  const p = pageNumberPlan({ formatId: 'roman', pageCount: 3 });
  assert.equal(p.pages[0].text, 'i');
  assert.ok(PAGE_NUMBER_FORMATS.length >= 4);
});
t('autoRotatePlan snaps confident angles', () => {
  const r = autoRotatePlan([{ angle: 92, confidence: 0.95 }, { angle: 10, confidence: 0.2 }]);
  assert.equal(r[0].delta, 270);
  assert.equal(r[1].delta, 0);
});
t('attachmentOps add/remove/rename', () => {
  let list = attachmentOps.add([], { filename: 'a.txt', data: new Uint8Array([1]) });
  assert.equal(list.length, 1);
  list = attachmentOps.add(list, { filename: 'a.txt', data: new Uint8Array([2]) });
  assert.equal(list.length, 1);
  list = attachmentOps.rename(list, 'a.txt', 'b.txt');
  assert.equal(list[0].filename, 'b.txt');
  list = attachmentOps.remove(list, 'b.txt');
  assert.equal(list.length, 0);
});
t('unlockFormsPlan clears read-only', () => {
  const out = unlockFormsPlan([{ name: 'f', readOnly: true }]);
  assert.equal(out[0].readOnly, false);
});

/* ── pipeline ── */
t('pipeline steps are known and validate', () => {
  assert.ok(PIPELINE_STEPS.length >= 6);
  assert.equal(validatePipeline([{ id: 'compress' }]).ok, true);
  assert.equal(validatePipeline([{ id: 'nope' }]).ok, false);
});
t('runPipelineModel queues writer steps and runs sanitize', () => {
  const doc = { attachments: [{ filename: 'x' }], meta: { title: 't' } };
  const r = runPipelineModel(doc, [{ id: 'sanitize' }, { id: 'compress', params: { presetId: 'web' } }, { id: 'bogus' }]);
  assert.equal(doc.attachments.length, 0);
  assert.equal(doc.pipelineFlags.compress.presetId, 'web');
  assert.ok(r.applied.length >= 2);
  assert.ok(r.skipped.length >= 1);
});
t('every pipeline step has an executable flag or a pure effect', () => {
  const doc = { attachments: [], meta: {} };
  const r = runPipelineModel(doc, PIPELINE_STEPS.map((s) => ({ id: s.id })));
  assert.equal(r.skipped.length, 0, `skipped: ${r.skipped.join(', ')}`);
  const f = doc.pipelineFlags || {};
  for (const id of ['compress', 'removeBlanks', 'flatten', 'grayscale', 'addPageNumbers', 'watermark', 'splitSize']) {
    const key = id === 'addPageNumbers' ? 'pageNumbers' : id;
    assert.ok(f[key], `${id} produced no ${key} flag`);
  }
  assert.deepEqual(doc.pipeline, PIPELINE_STEPS.map((s) => s.id));
});
t('pipeline params are carried through, not replaced by defaults', () => {
  const doc = { attachments: [], meta: {} };
  runPipelineModel(doc, [
    { id: 'addPageNumbers', params: { formatId: 'ROMAN' } },
    { id: 'watermark', params: { text: 'CONFIDENTIAL' } },
    { id: 'splitSize', params: { targetMB: 2 } },
  ]);
  assert.equal(doc.pipelineFlags.pageNumbers.formatId, 'ROMAN');
  assert.equal(doc.pipelineFlags.watermark.text, 'CONFIDENTIAL');
  assert.equal(doc.pipelineFlags.splitSize.targetMB, 2);
});
t('pipelineStamps makes one numbered stamp per page', () => {
  const stamps = pipelineStamps({ pageNumbers: { formatId: 'n-of-N' } }, 3);
  assert.equal(stamps.length, 3);
  assert.deepEqual(stamps.map((s) => s.text), ['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
  assert.deepEqual(stamps.map((s) => s.from), [1, 2, 3]);
  assert.ok(stamps.every((s) => s.kind === 'footer' && s.align === 'center'));
});
t('pipelineStamps honours the format and header placement', () => {
  const stamps = pipelineStamps({ pageNumbers: { formatId: 'ROMAN', scope: 'header', align: 'right', fontSize: 14 } }, 2);
  assert.deepEqual(stamps.map((s) => s.text), ['I', 'II']);
  assert.ok(stamps.every((s) => s.kind === 'header' && s.align === 'right' && s.fontSize === 14));
});
t('pipelineStamps builds a real diagonal watermark', () => {
  const stamps = pipelineStamps({ watermark: { text: 'INTERNAL' } }, 4);
  assert.equal(stamps.length, 1);
  const w = stamps[0];
  assert.equal(w.kind, 'watermark');
  assert.equal(w.text, 'INTERNAL');
  assert.equal(w.from, 1);
  assert.equal(w.to, 4);
  assert.equal(w.behind, true);
  assert.equal(w.opacity, 0.16);
});
t('pipelineStamps clamps bad params and never writes an empty watermark', () => {
  const flags = { watermark: { text: '  ', angle: 900, opacity: 99 }, pageNumbers: { fontSize: 999 } };
  const stamps = pipelineStamps(flags, 1);
  const w = stamps.find((s) => s.kind === 'watermark');
  const p = stamps.find((s) => s.kind === 'footer');
  assert.equal(w.text, 'DRAFT');
  assert.equal(w.angle, 90);
  assert.equal(w.opacity, 1);
  assert.equal(p.fontSize, 24);
  assert.deepEqual(pipelineStamps({}, 0), []);
  assert.deepEqual(pipelineStamps(null, 5), []);
});
t('both text-writing steps can be combined in one build pass', () => {
  const stamps = pipelineStamps({ pageNumbers: {}, watermark: { text: 'DRAFT' } }, 2);
  assert.equal(stamps.length, 3);
  assert.equal(new Set(stamps.map((s) => s.id)).size, 3, 'stamp ids must be unique');
});

console.log(`\n${n} checks passed`);
