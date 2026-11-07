#!/usr/bin/env node
/**
 * End-to-end check for the Automate pipeline's writer steps.
 *
 * The queue used to record `pageNumbers`, `watermark` and `splitSize` as
 * "queued" and never execute them. This test runs the same pure queue the UI
 * uses, feeds its stamp descriptors into the real buildPdf(), and re-reads the
 * resulting bytes with pdf.js — an independent extractor — so a step that
 * silently does nothing cannot pass.
 *
 *   node scripts/automate-pipeline-test.mjs
 */
import assert from 'node:assert/strict';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { loadRenderer } from './lib/loadRenderer.mjs';
import { runPipelineModel, pipelineStamps, splitBySizePlan } from '../src/renderer/js/stirling.js';

const { buildPdf } = await loadRenderer('pdfwrite.js', { fresh: true });

let n = 0;
async function t(name, fn) {
  try { await fn(); n++; console.log(`PASS  ${name}`); }
  catch (e) { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
}

async function makeBase() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([400, 400]);
    p.drawText(`BASE PAGE ${i + 1}`, { x: 40, y: 320, size: 18, font, color: rgb(0.1, 0.1, 0.1) });
  }
  return doc.save();
}
const BASE = await makeBase();

function model() {
  return {
    bytes: BASE, numPages: 3, password: null,
    pageOps: null, pageRotate: {}, crops: {}, stamps: [], annots: [],
    textEdits: [], newFields: [], ocr: null,
  };
}

async function pagesOf(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => it.str).join(' '));
  }
  await doc.destroy?.();
  return out;
}

await t('the queue produces flags for every text/export step', async () => {
  const doc = model();
  const r = runPipelineModel(doc, [
    { id: 'addPageNumbers', params: { formatId: 'n-of-N' } },
    { id: 'watermark', params: { text: 'INTERNAL' } },
    { id: 'splitSize', params: { targetMB: 2 } },
  ]);
  assert.equal(r.skipped.length, 0);
  assert.equal(doc.pipelineFlags.pageNumbers.formatId, 'n-of-N');
  assert.equal(doc.pipelineFlags.watermark.text, 'INTERNAL');
  assert.equal(doc.pipelineFlags.splitSize.targetMB, 2);
});

await t('stamps are temporarily appended, never left on the model', async () => {
  const doc = model();
  const flags = (runPipelineModel(doc, [
    { id: 'addPageNumbers' }, { id: 'watermark', params: { text: 'INTERNAL' } },
  ]), doc.pipelineFlags);
  const stamps = pipelineStamps(flags, doc.numPages);
  const keep = doc.stamps;
  doc.stamps = [...keep, ...stamps];
  let out;
  try { out = await buildPdf(doc, {}); } finally { doc.stamps = keep; }
  assert.ok(out.length > 1000);
  assert.equal(doc.stamps.length, 0, 'a later save must not write the stamps twice');
});

await t('page numbers land once per page, with the right number', async () => {
  const doc = model();
  runPipelineModel(doc, [{ id: 'addPageNumbers', params: { formatId: 'n-of-N' } }]);
  doc.stamps = pipelineStamps(doc.pipelineFlags, doc.numPages);
  const pages = await pagesOf(await buildPdf(doc, {}));
  assert.equal(pages.length, 3);
  assert.match(pages[0], /BASE PAGE 1/);
  assert.match(pages[0], /Page 1 of 3/);
  assert.match(pages[1], /Page 2 of 3/);
  assert.match(pages[2], /Page 3 of 3/);
  assert.ok(!/Page 2 of 3/.test(pages[0]), 'a whole-document stamp would repeat page 2');
  assert.ok(!/Page 1 of 3/.test(pages[1]), 'a whole-document stamp would repeat page 1');
});

await t('the chosen page-number format reaches the bytes', async () => {
  const doc = model();
  runPipelineModel(doc, [{ id: 'addPageNumbers', params: { formatId: 'ROMAN' } }]);
  doc.stamps = pipelineStamps(doc.pipelineFlags, doc.numPages);
  const pages = await pagesOf(await buildPdf(doc, {}));
  assert.match(pages[0], /\bI\b/);
  assert.match(pages[1], /\bII\b/);
  assert.match(pages[2], /\bIII\b/);
});

await t('the watermark text is written on every page', async () => {
  const doc = model();
  runPipelineModel(doc, [{ id: 'watermark', params: { text: 'INTERNAL' } }]);
  doc.stamps = pipelineStamps(doc.pipelineFlags, doc.numPages);
  const pages = await pagesOf(await buildPdf(doc, {}));
  for (let i = 0; i < pages.length; i++) {
    assert.match(pages[i], /INTERNAL/, `page ${i + 1} has no watermark`);
    assert.match(pages[i], /BASE PAGE/, `page ${i + 1} lost its original text`);
  }
});

await t('page numbers and a watermark coexist in one build pass', async () => {
  const doc = model();
  runPipelineModel(doc, [
    { id: 'addPageNumbers' }, { id: 'watermark', params: { text: 'DRAFT' } },
  ]);
  doc.stamps = pipelineStamps(doc.pipelineFlags, doc.numPages);
  const pages = await pagesOf(await buildPdf(doc, {}));
  for (let i = 0; i < pages.length; i++) {
    assert.match(pages[i], /DRAFT/);
    assert.match(pages[i], new RegExp(`Page ${i + 1} of 3`));
  }
});

await t('split by size exports a plan built from the rebuilt byte length', async () => {
  const doc = model();
  runPipelineModel(doc, [{ id: 'splitSize', params: { targetMB: 1 } }]);
  const flags = doc.pipelineFlags;
  const bytes = await buildPdf(doc, {});
  const plan = splitBySizePlan(bytes.length, doc.numPages, flags.splitSize.targetMB);
  assert.ok(Array.isArray(plan.chunks) && plan.chunks.length >= 1);
  assert.deepEqual(plan.chunks.flat(), [0, 1, 2], 'chunks must cover every page exactly once');
});

console.log(`\nPIPELINE_${process.exitCode ? 'FAIL' : 'PASS'} ${n} checks green`);
