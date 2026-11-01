/**
 * Redaction integrity — the matching half, with no browser in it.
 *
 * Kept separate from the PDF reading so the rule "a redacted string must not be
 * extractable from the file" can be asserted directly, in plain Node, against
 * text extracted by an independent reader. See scripts/redact-integrity-test.mjs.
 */

/** Whitespace and soft hyphens are extraction noise, not content: pdf.js emits
 *  one item per glyph run, so a phrase can come back with or without a space
 *  where the layout happened to break. */
export function normalizeExtracted(s) {
  return String(s ?? '').replace(/[\u00ad\u200b\ufeff]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The same text with every gap removed.
 *
 * `ACCT 5590&#xad;1234` extracts as `ACCT 55901234`. Spacing alone would call
 * that a different string and report the redaction as clean while the account
 * number sits there unchanged. For a security check the cost of a false alarm
 * (the user is asked whether to keep going) is far below the cost of a false
 * pass, so both forms are searched and either hit counts.
 */
function squash(s) {
  return String(s ?? '').replace(/[\u00ad\u200b\ufeff\s]/g, '');
}

/**
 * @param {Map<number,string>|Array<string>} pageTexts  page index → extracted text
 * @param {Array<{page:number, secret:string, native?:boolean}>} proof
 * @returns {{checked:number, leaks:Array, unverifiable:Array, ok:boolean}}
 */
export function matchRedactions(pageTexts, proof) {
  const at = (i) => (typeof pageTexts.get === 'function' ? pageTexts.get(i) : pageTexts[i]) || '';
  const rows = (proof || []);
  // A mark over a raster page has no text layer to destroy: ink in an image is
  // out of reach of text extraction, so it is reported as unverifiable rather
  // than passed. Claiming "removed" without evidence is the failure this
  // whole check exists to avoid.
  const wanted = rows.filter((p) => p.secret && p.native !== false);
  const unverifiable = [...new Set(rows.filter((p) => !p.secret || p.native === false).map((p) => p.page + 1))];
  const leaks = [];
  for (const p of wanted) {
    const needle = normalizeExtracted(p.secret);
    if (needle.length < 2) continue;
    const hay = at(p.page);
    const spaced = normalizeExtracted(hay).includes(needle);
    // A soft hyphen or a line break inside the middle of a reference number
    // makes the spaced form miss it, so the gapless form is searched too.
    const tight = needle.length > 3 && squash(hay).includes(squash(p.secret));
    if (spaced || tight) leaks.push({ page: p.page, secret: p.secret });
  }
  return { checked: wanted.length, leaks, unverifiable, ok: leaks.length === 0 && unverifiable.length === 0 };
}

/** One-line verdict for a toast, a report, or a test log. */
export function redactionVerdict(v) {
  if (!v) return 'Redaction check did not run.';
  if (v.ok) return `Redaction verified — ${v.checked} target(s) confirmed gone from the file.`;
  const bits = [];
  if (v.leaks.length) bits.push(`${v.leaks.length} still extractable`);
  if (v.unverifiable.length) bits.push(`${v.unverifiable.length} page(s) not checkable by text`);
  return `Redaction NOT verified: ${bits.join(', ')}.`;
}
