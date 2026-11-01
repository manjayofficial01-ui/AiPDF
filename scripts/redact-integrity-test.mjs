#!/usr/bin/env node
/**
 * Redaction integrity — does the file actually stop giving the content up?
 *
 * Two claims are tested, and the first one is the important one:
 *
 *   1. A cover box is NOT a redaction. Drawing black over text leaves the text
 *      operators in the content stream, so the checker must report a leak. If
 *      this test ever passes by accident, the check is rubber-stamping.
 *   2. Removing the content (what the sanitize path does by rebuilding the page
 *      as an image) makes the string unextractable, and the checker says so.
 *
 * Reading is done by pdf.js, a different codebase from the writer, so "it is
 * gone" is not this code marking its own homework.
 *
 *   node scripts/redact-integrity-test.mjs
 */
import * as PL from '@cantoo/pdf-lib';
import { matchRedactions, normalizeExtracted, redactionVerdict } from '../src/renderer/js/redactproof.js';

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const SECRET = 'ACCT 5590 1234 9876';

async function extract(buf) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const d = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false }).promise;
  const pages = new Map();
  for (let i = 0; i < d.numPages; i++) {
    const tc = await (await d.getPage(i + 1)).getTextContent();
    pages.set(i, tc.items.map((it) => it.str).join(' '));
  }
  await d.destroy?.();
  return pages;
}

/* ── Case 1: the page is covered, not emptied ───────────────────────────── */

const covered = await PL.PDFDocument.create();
const cFont = await covered.embedFont(PL.StandardFonts.Helvetica);
const cPage = covered.addPage([595, 842]);
cPage.drawText(`Customer account ${SECRET} balance due`, { x: 50, y: 700, size: 14, font: cFont });
// What the plain Apply path writes: a black rectangle, nothing removed.
cPage.drawRectangle({ x: 40, y: 690, width: 320, height: 24, color: PL.rgb(0, 0, 0) });
const coveredBytes = await covered.save();
const coveredText = await extract(coveredBytes);
check('the covered page still exposes the account number (so a cover is not a redaction)',
  normalizeExtracted(coveredText.get(0)).includes(SECRET), JSON.stringify(normalizeExtracted(coveredText.get(0))));

const proof = [{ page: 0, secret: SECRET, native: true }];
const leak = matchRedactions(coveredText, proof);
check('the checker FAILS a covered redaction', leak.leaks.length === 1 && leak.ok === false,
  `${leak.leaks.length} leak(s): ${redactionVerdict(leak)}`);

/* ── Case 2: the content is genuinely gone ──────────────────────────────── */

// The sanitize outcome, modelled honestly: the page carries an image and no text
// operators for that region, so the string cannot be extracted.
const raster = await PL.PDFDocument.create();
const rPage = raster.addPage([595, 842]);
const tinyJpeg = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==',
  'base64',
);
rPage.drawImage(await raster.embedJpg(tinyJpeg), { x: 40, y: 690, width: 320, height: 24 });
const rasterBytes = await raster.save();
const rasterText = await extract(rasterBytes);
const clean = matchRedactions(rasterText, proof);
check('the checker PASSES a redaction whose content is really gone', clean.ok === true && clean.leaks.length === 0,
  redactionVerdict(clean));

/* ── Case 3: a mark over ink cannot be proven by text extraction ────────── */

const inkOnly = matchRedactions(rasterText, [{ page: 0, secret: '', native: false }]);
check('a mark on a page with no text layer is reported unverifiable, not passed',
  inkOnly.ok === false && inkOnly.unverifiable.includes(1) && inkOnly.checked === 0,
  redactionVerdict(inkOnly));

/* ── Case 4: the matching rule itself ───────────────────────────────────── */

check('extraction whitespace is not mistaken for a difference',
  matchRedactions(new Map([[0, 'ACCT  5590\t1234 9876 here']]), [{ page: 0, secret: 'ACCT 5590 1234 9876', native: true }]).leaks.length === 1);
check('a soft hyphen inside the extracted text does not hide a leak',
  matchRedactions(new Map([[0, 'ACCT 5590\u00AD1234 9876 due']]), [{ page: 0, secret: SECRET, native: true }]).leaks.length === 1);
check('a different page is not searched',
  matchRedactions(new Map([[0, 'nothing here'], [1, SECRET]]), [{ page: 0, secret: SECRET, native: true }]).leaks.length === 0);
check('a one-character target is too short to prove anything and is skipped',
  matchRedactions(new Map([[0, 'x y']]), [{ page: 0, secret: 'x', native: true }]).checked === 1);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
