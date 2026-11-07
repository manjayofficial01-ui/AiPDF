/**
 * Generates a fixture PDF used by the headless functional test.
 * It contains: 3 pages of extractable text, a real Highlight annotation
 * (with appearance stream), and a text form field. The third page keeps the
 * PDF-to-Word multi-page regression honest: it converts pages [0,1,2].
 * Run: node scripts/make-fixtures.mjs
 */
import * as PL from '@cantoo/pdf-lib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(dir, '..', '.fixtures');
fs.mkdirSync(out, { recursive: true });

const {
  PDFDocument, StandardFonts, PDFName, PDFNumber, PDFString, PDFHexString,
  PDFRawStream, degrees, rgb,
} = PL;

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);

const page1 = doc.addPage([595.28, 841.89]);
page1.drawText('AiPDF Editor functional test fixture.', { x: 50, y: 760, size: 16, font, color: rgb(0, 0, 0) });
page1.drawText('This sentence on page one must be extractable by pdf.js.', { x: 50, y: 730, size: 12, font, color: rgb(0, 0, 0) });

// Highlight annotation over the second line (Rect + QuadPoints + AP stream).
const x0 = 50, y0 = 720, x1 = 470, y1 = 744;
const hl = doc.context.obj({
  Type: 'Annot', Subtype: 'Highlight',
  Rect: [x0, y0, x1, y1],
  F: 4,
  C: [1, 0.9, 0.2],
  M: PDFString.of('D:20260101000000Z'),
  T: PDFHexString.fromText('Reviewer'),
});
hl.set(PDFName.of('QuadPoints'), doc.context.obj([
  x0, y0, x1, y0, x0, y1, x1, y1,
]));
const ap = doc.context.obj({
  Type: 'XObject', Subtype: 'Form', BBox: [x0, y0, x1, y1],
  Resources: {}, FormType: 1,
});
const apStream = PDFRawStream.of(ap, new TextEncoder().encode(
  `q 0.2 0.4 1 RG 1 0.9 0.2 rg ${x0} ${y0} ${x1 - x0} ${y1 - y0} re f Q`,
));
const apRef = doc.context.register(apStream);
hl.set(PDFName.of('AP'), doc.context.obj({ N: apRef }));
const hlRef = doc.context.register(hl);
page1.node.set(PDFName.of('Annots'), doc.context.obj([hlRef]));

// Text form field (Widget) on page 1.
const form = doc.getForm();
const tf = form.createTextField('fullname');
tf.addToPage(page1, { x: 50, y: 650, width: 240, height: 22 });
tf.setText('Ada Lovelace');

// Page 2
const page2 = doc.addPage([595.28, 841.89]);
page2.drawText('Second page content for extraction.', { x: 50, y: 760, size: 14, font, color: rgb(0, 0, 0) });

// Page 3 — required by the PDF-to-Word whole-file conversion test, which
// requests three pages and asserts one table plus two page breaks.
const page3 = doc.addPage([595.28, 841.89]);
page3.drawText('Third page content for multi-page conversion.', { x: 50, y: 760, size: 14, font, color: rgb(0, 0, 0) });

const bytes = await doc.save({ useObjectStreams: true });
const fixturePath = path.join(out, 'fixture.pdf');
fs.writeFileSync(fixturePath, bytes);
console.log('Wrote fixture:', fixturePath, `(${bytes.length} bytes)`);
