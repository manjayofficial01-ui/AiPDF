#!/usr/bin/env node
/**
 * Keep .fixtures/fixture.pdf canonical before any CDP suite opens it.
 *
 * A saved-over fixture silently changes the app's text blocks and annotation
 * layers; Direct Editor suites then fail for reasons that look like product
 * regressions. The canonical fixture from make-fixtures.mjs is a 3-page PDF
 * with one Highlight annotation and one AcroForm text field. Structural
 * checks are used instead of a byte hash because pdf-lib embeds timestamps.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PL from '@cantoo/pdf-lib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');

async function isCanonical(bytes) {
  try {
    const doc = await PL.PDFDocument.load(bytes, { updateMetadata: false });
    const pages = doc.getPages();
    let annots = 0;
    for (const page of pages) {
      const list = page.node.Annots();
      annots += list ? list.size() : 0;
    }
    return pages.length === 3 && annots === 2 && doc.getForm().getFields().length === 1;
  } catch {
    return false;
  }
}

let ok = fs.existsSync(FIXTURE) && await isCanonical(fs.readFileSync(FIXTURE));
if (!ok) {
  await import('./make-fixtures.mjs');
  ok = fs.existsSync(FIXTURE) && await isCanonical(fs.readFileSync(FIXTURE));
  if (!ok) {
    console.error('FIXTURE_FAIL could not regenerate the canonical fixture');
    process.exit(1);
  }
  console.log('FIXTURE_REGENERATED canonical .fixtures/fixture.pdf');
} else {
  console.log('FIXTURE_OK canonical .fixtures/fixture.pdf');
}
