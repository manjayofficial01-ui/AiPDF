#!/usr/bin/env node
/**
 * Aidocs test gate — AI Smart Redact + Contract Intelligence + AI JSON layer.
 *
 * The doc-AI features lean on two pure modules (aijson.js, pii.js). This gate
 * exercises every one of their exports, then runs a real round-trip: a PDF
 * seeded with personal data is built with pdf-lib, its text content is read
 * back with pdf.js, and the same pageTextMap → scanForPii → findRects pipeline
 * the Smart Redact dialog uses must locate every seeded item inside the page.
 *
 *   node scripts/aidocs-test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument as PdfLibDoc, StandardFonts, rgb } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  extractJson, completionText, normalizeFollowups, normalizeOutline, normalizeContract, normalizePiiCandidates,
} from '../src/renderer/js/aijson.js';
import {
  PII_TYPES, DEFAULT_CATEGORIES, luhn, scanForPii, mergePii, pageTextMap, findRects,
} from '../src/renderer/js/pii.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let n = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { n++; console.log(`PASS  ${name}`); })
    .catch((e) => { console.log(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; });
}

/* ── aijson: JSON recovery from messy model output ──────────────────────── */

await t('completionText: accepts legacy strings and current chat completion objects', () => {
  assert.equal(completionText('plain reply'), 'plain reply');
  assert.equal(completionText({ text: '{"ok":true}', toolCalls: [] }), '{"ok":true}');
  assert.equal(completionText({ content: 'content reply' }), 'content reply');
  assert.equal(completionText(null), '');
  assert.equal(completionText({ text: 42 }), '');
});

await t('extractJson: plain array', () => {
  assert.deepEqual(extractJson('[1,2,3]', 'array'), [1, 2, 3]);
});

await t('extractJson: fenced + prefaced array', () => {
  const raw = 'Here you go:\n```json\n["a","b"]\n```\nDone.';
  assert.deepEqual(extractJson(raw, 'array'), ['a', 'b']);
});

await t('extractJson: object with braces inside strings', () => {
  const raw = 'Sure! {"summary": "use { and } freely", "page": 2}';
  assert.deepEqual(extractJson(raw, 'object'), { summary: 'use { and } freely', page: 2 });
});

await t('extractJson: kind mismatch and garbage return null', () => {
  assert.equal(extractJson('{"a":1}', 'array'), null);
  assert.equal(extractJson('[1]', 'object'), null);
  assert.equal(extractJson('no json at all'), null);
  assert.equal(extractJson(null), null);
});

await t('extractJson: truncated JSON stays null', () => {
  assert.equal(extractJson('{"a": {"b": [1,2', 'object'), null);
});

await t('normalizeFollowups: cleans, dedupes, caps at 3', () => {
  const out = normalizeFollowups([
    'Question 1: What is the termination notice period?',
    'what is the termination notice period?',
    'ok',
    { question: 'Who are the parties?' },
    'What is the payment amount?',
    'When does it renew?',
    'Extra beyond the cap',
  ]);
  assert.equal(out.length, 3);
  assert.equal(out[0], 'What is the termination notice period?');
  assert.equal(out[1], 'Who are the parties?');
  assert.equal(out[2], 'What is the payment amount?');
});

await t('normalizeOutline: clamps pages, levels, dedupes', () => {
  const out = normalizeOutline([
    { level: 1, text: 'Introduction', page: 1 },
    { level: 9, text: 'Terms', page: 99 },
    { level: 0, text: 'Introduction', page: 1 },
    { text: 'No page given', page: 0 },
  ], 10);
  assert.deepEqual(out, [
    { level: 1, text: 'Introduction', page: 1 },
    { level: 3, text: 'Terms', page: 10 },
    { level: 1, text: 'No page given', page: 1 },
  ]);
});

await t('normalizeContract: full payload passes through shaped', () => {
  const r = normalizeContract({
    documentType: 'Non-Disclosure Agreement', isContract: true, confidence: 1.7,
    summary: 'A mutual NDA.', parties: [{ name: 'Acme Ltd (Provider)' }, 'Beta LLC (Receiver)'],
    keyTerms: [{ label: 'Term', value: '2 years', page: 1 }, { label: 'Renewal', value: 'auto' }],
    risks: [{ severity: 'catastrophic', title: 'Auto-renewal', detail: 'Renews forever', page: 3 },
      { severity: 'high', title: 'Uncapped liability', detail: 'No cap', page: 2 }],
    actionItems: ['Clarify the notice period'],
  }, 5);
  assert.equal(r.documentType, 'Non-Disclosure Agreement');
  assert.equal(r.isContract, true);
  assert.equal(r.confidence, 1);
  assert.deepEqual(r.parties, ['Acme Ltd (Provider)', 'Beta LLC (Receiver)']);
  assert.equal(r.keyTerms[1].page, 1);
  assert.deepEqual(r.risks.map((x) => x.severity), ['high', 'medium']);
});

await t('normalizeContract: garbage → null, non-contract inferred', () => {
  assert.equal(normalizeContract(null), null);
  assert.equal(normalizeContract([1, 2]), null);
  assert.equal(normalizeContract({ documentType: 'Invoice' }).isContract, false);
  assert.equal(normalizeContract({}).isContract, false);
  assert.equal(normalizeContract({}).confidence, 0.3);
});

await t('normalizePiiCandidates: filters types, clamps pages, maps synonyms', () => {
  const out = normalizePiiCandidates([
    { page: 2, text: 'jane@acme.com', type: 'email address' },
    { page: 0, text: 'Jane Doe', type: 'person' },
    { page: 3, text: 'x', type: 'email' },
    { text: 'no page' },
  ], 4, new Set(['email', 'name', 'other']), (t2) => ({ person: 'name', emailaddress: 'email' }[t2] || t2));
  assert.deepEqual(out, [
    { page: 2, text: 'jane@acme.com', type: 'email', reason: '' },
    { page: 1, text: 'Jane Doe', type: 'name', reason: '' },
    { page: 1, text: 'no page', type: 'other', reason: '' },
  ]);
});

/* ── pii: detection + geometry ──────────────────────────────────────────── */

await t('luhn: accepts real card numbers, rejects others', () => {
  assert.equal(luhn('4532015112830366'), true);
  assert.equal(luhn('5555555555554444'), true);
  assert.equal(luhn('4532015112830367'), false);
  assert.equal(luhn('123456'), false);
});

await t('scanForPii: finds the seeded personal data', () => {
  const text = [
    'Contact: jane.doe@acme.com or +1 (555) 123-4567.',
    'SSN: 545-12-3456 Card: 4532 0151 1283 0366',
    'IBAN: GB29 NWBK 6016 1331 9268 19',
    'DOB: 14 March 1985',
    'Address: 742 Evergreen Terrace, Springfield',
    'Passport No: X1234567',
    'Order ref: 4532015112830367 (not a card)',
  ].join('\n');
  const out = scanForPii([{ page: 1, text }]);
  const types = Object.fromEntries(out.map((c) => [c.type, c.text]));
  assert.equal(types.email, 'jane.doe@acme.com');
  // The SSN string also matches the phone pattern — the more specific type
  // must win, so the phone hit is the real phone number only.
  assert.ok(types.phone.includes('555') && types.phone.includes('123'));
  assert.equal(types.ssn, '545-12-3456');
  // Kept in the exact form it appears in the document — that is the string
  // findRects must locate for the redaction mark.
  assert.equal(types.creditcard, '4532 0151 1283 0366');
  assert.ok(types.iban.startsWith('GB29'));
  assert.equal(types.dob, '14 March 1985');
  assert.ok(types.address.includes('742 Evergreen Terrace'));
  assert.ok(types.idnum.includes('X1234567'));
  // The Luhn-failing order ref must NOT be treated as a credit card.
  assert.ok(!out.some((c) => c.type === 'creditcard' && c.text === '4532015112830367'));
});

await t('scanForPii: category filter honours the selection', () => {
  const out = scanForPii(
    [{ page: 1, text: 'a@b.com and 545-12-3456' }],
    ['email'],
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'email');
});

await t('mergePii: AI wins, regex dupes (any type) dropped', () => {
  const ai = [{ page: 1, text: 'Jane Doe', type: 'name', reason: 'person name', source: 'ai' }];
  const regex = [
    { page: 1, text: 'Jane Doe', type: 'other', reason: 'Pattern match', source: 'regex' },
    { page: 1, text: 'a@b.com', type: 'email', source: 'regex' },
  ];
  const out = mergePii(ai, regex);
  assert.equal(out.length, 2);
  assert.equal(out[0].source, 'ai');
  assert.equal(out[1].type, 'email');
});

await t('pageTextMap + findRects: every occurrence, sane geometry', () => {
  const items = [
    { str: 'Call ', transform: [10, 0, 0, 10, 72, 700], width: 20 },
    { str: '555-123-4567', transform: [10, 0, 0, 10, 92, 700], width: 60 },
    { str: ' or ', transform: [10, 0, 0, 10, 152, 700], width: 18 },
    { str: '555-123-4567', transform: [10, 0, 0, 10, 170, 400], width: 60 },
  ];
  const mapped = pageTextMap(items);
  assert.equal(mapped.joined, 'Call 555-123-4567 or 555-123-4567');
  const rects = findRects(mapped, '555-123-4567');
  assert.equal(rects.length, 2);
  const [r1, r2] = rects;
  // First hit spans the item at y=700, second at y=400 (PDF space, y grows up).
  assert.ok(r1[0] >= 92 && r1[2] <= 152 + 1);
  assert.ok(Math.abs(r1[1] - 698) < 3 && Math.abs(r1[3] - 710) < 3);
  assert.ok(Math.abs(r2[3] - 410) < 3);
  assert.deepEqual(findRects(mapped, 'not present'), []);
  assert.deepEqual(findRects(mapped, ''), []);
});

/* ── Real round-trip: pdf-lib → pdf.js → the Smart Redact pipeline ──────── */

const STD_FONT_DATA_URL = path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep;

async function makePiiPdf() {
  const doc = await PdfLibDoc.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([400, 400]);
  const lines = [
    'Consultancy Agreement',
    'Contact: jane.doe@acme.com',
    'Phone: +1 (555) 123-4567',
    'SSN: 545-12-3456',
    'Card: 4532 0151 1283 0366',
  ];
  lines.forEach((line, i) => {
    p.drawText(line, { x: 40, y: 340 - i * 24, size: 12, font, color: rgb(0.1, 0.1, 0.1) });
  });
  return doc.save();
}

await t('round-trip: seeded PII located as redactable rects in a real PDF', async () => {
  const bytes = await makePiiPdf();
  const pdf = await pdfjs.getDocument({
    data: Uint8Array.from(bytes),
    useSystemFonts: false,
    standardFontDataUrl: STD_FONT_DATA_URL,
  }).promise;
  assert.equal(pdf.numPages, 1);
  const page = await pdf.getPage(1);
  const tc = await page.getTextContent();
  const mapped = pageTextMap(tc.items);

  // Detection runs on the newline-joined lines (as the dialog does); location
  // runs on the geometry-faithful raw join.
  const scan = scanForPii([{ page: 1, text: mapped.lines }]);
  const types = new Set(scan.map((c) => c.type));
  for (const want of ['email', 'phone', 'ssn', 'creditcard']) {
    assert.ok(types.has(want), `expected a ${want} candidate`);
  }

  let located = 0;
  for (const cand of scan) {
    for (const r of findRects(mapped, cand.text)) {
      assert.ok(r[0] < r[2] && r[1] < r[3], `degenerate rect for ${cand.text}`);
      assert.ok(r[0] >= 0 && r[2] <= 400 && r[1] >= 0 && r[3] <= 400, `rect out of page for ${cand.text}`);
      located++;
    }
  }
  assert.ok(located >= 4, `expected at least 4 located marks, got ${located}`);

  // The email must sit near its draw position: x≈40 (left margin), and it is
  // the second drawn line, i.e. y ≈ 400 − 340 − 24 in PDF space → upper half.
  const emailRect = findRects(mapped, 'jane.doe@acme.com')[0];
  assert.ok(emailRect, 'email located');
  assert.ok(emailRect[0] >= 35 && emailRect[0] <= 60, 'email x0 near left margin');
  assert.ok(emailRect[1] > 250 && emailRect[3] < 380, 'email on the upper half of the page');
});

console.log(process.exitCode ? `\n${n} passed, with failures` : `\nAll ${n} aidocs tests passed.`);
process.exit(process.exitCode || 0);
