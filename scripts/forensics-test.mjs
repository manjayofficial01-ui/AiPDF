#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Document Assurance — offline forensics regression suite.
 *
 *   node scripts/forensics-test.mjs
 *
 * `src/renderer/js/forensics.js` is deliberately dependency-free so it can be
 * imported straight into Node (the renderer js/ folder carries a
 * `{"type":"module"}` marker for exactly this). Everything here is synthetic
 * Latin-1 byte input plus one checked-in real PDF. No Electron, no CDP, no
 * network, no AI.
 *
 * The contract locked here:
 *   - incremental revisions are detected and older recoverable text is shown;
 *   - `/JavaScript` is NOT double-counted as `/JS` (a real substring bug);
 *   - active content, attachments, layers, metadata and trailing bytes are
 *     each reported with the right severity;
 *   - the accessibility audit honours authoritative catalog facts over the
 *     byte-level fallback, never claims an untagged PDF is tagged, and only
 *     offers fixes it can actually perform;
 *   - all of it stays deterministic and offline.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  toLatin1, inspectDocument, auditAccessibility, verdict,
} from '../src/renderer/js/forensics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const ids = (report) => report.findings.map((f) => f.id);
const byId = (report, id) => report.findings.find((f) => f.id === id);

/** ASCII/Latin-1 → bytes. PDFs are byte streams, not UTF-8 text. */
function bytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** A minimal, genuinely clean single-revision PDF: no scripts, no metadata,
 *  no attachments, no trailing bytes, exactly one %%EOF. */
const CLEAN = [
  '%PDF-1.7\n',
  '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
  '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
  '4 0 obj\n<< /Length 20 >>\nstream\nBT (Hello) Tj ET\nendstream\nendobj\n',
  'xref\n0 5\n0000000000 65535 f \n',
  'trailer\n<< /Root 1 0 R /Size 5 >>\n',
  'startxref\n0\n%%EOF',
].join('');

console.log('── byte helpers ──────────────────────────────────────────────────');

{
  const big = new Uint8Array(220000).fill(65);
  const s = toLatin1(big);
  check('toLatin1 chunks large buffers without a stack overflow',
    s.length === 220000 && s.charCodeAt(219999) === 65, `len=${s.length}`);
  check('toLatin1 accepts a plain array', toLatin1([65, 66, 67]) === 'ABC');
  check('toLatin1 tolerates empty input', toLatin1(null) === '');
}

console.log('── input validation ──────────────────────────────────────────────');

{
  const none = inspectDocument(new Uint8Array(0));
  check('empty input is rejected without throwing', none.ok === false && none.error === 'No data');
  const notPdf = inspectDocument(bytes('This is a Word document, not a PDF.'));
  check('non-PDF input is rejected', notPdf.ok === false && /Not a PDF/.test(notPdf.error || ''));
  check('rejected input has a safe shape',
    Array.isArray(notPdf.findings) && notPdf.findings.length === 0 && notPdf.size > 0);
}

console.log('── clean baseline ─────────────────────────────────────────────────');

{
  const r = inspectDocument(bytes(CLEAN));
  check('clean PDF inspects successfully', r.ok === true);
  check('clean PDF has no findings', r.findings.length === 0, JSON.stringify(ids(r)));
  check('clean PDF scores 100', r.score === 100, `score=${r.score}`);
  check('clean PDF reports one revision', r.facts.revisions === 1 && r.facts.eofMarkers === 1);
  check('clean PDF reports no trailing bytes', r.facts.trailingBytes === 0);
  check('clean PDF header is parsed', r.facts.header === '1.7', r.facts.header);
  check('clean verdict is reassuring', verdict(r) === 'Clean — no hidden data found', verdict(r));
}

console.log('── incremental revisions / redaction leak ────────────────────────');

{
  const rev1 = CLEAN.replace('BT (Hello) Tj ET', 'BT (Confidential Salary Details) Tj ET');
  const rev2 = '\n% incremental update\n5 0 obj\n<< /Type /Page /Redact >>\nendobj\n' +
    'xref\n0 6\ntrailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n500\n%%EOF';
  const r = inspectDocument(bytes(rev1 + rev2));
  const f = byId(r, 'incremental-history');
  check('two %%EOF markers produce a revision finding', !!f);
  check('revision finding is critical when redaction marks exist',
    f && f.severity === 'critical', f && f.severity);
  check('revision count is reported', r.facts.revisions === 2 && r.facts.eofMarkers === 2,
    `revisions=${r.facts.revisions}`);
  check('older text is recovered as evidence',
    !!(f && f.recovered && f.recovered.some((s) => /Confidential Salary/.test(s))),
    JSON.stringify(f && f.recovered));
  check('evidence is quoted in the finding detail',
    !!(f && /Confidential Salary/.test(f.evidence || '')));
  check('remediation points at a rebuild', !!(f && /Flatten/.test(f.remediation || '')));
  check('verdict escalates to critical', /critical issue/.test(verdict(r)), verdict(r));
}

console.log('── trailing bytes ─────────────────────────────────────────────────');

{
  const r = inspectDocument(bytes(CLEAN + ' '.repeat(64)));
  check('appended bytes after %%EOF are detected', !!byId(r, 'trailing-data'));
  check('trailing byte count is exact', r.facts.trailingBytes === 64, String(r.facts.trailingBytes));
  check('trailing data is high severity', byId(r, 'trailing-data').severity === 'high');
  const crlf = inspectDocument(bytes(CLEAN + '\r\n'));
  check('a normal CRLF after %%EOF is not flagged', !byId(crlf, 'trailing-data'));
}

console.log('── active content ─────────────────────────────────────────────────');

{
  // Regression: `/JavaScript` contains `/JS` as a literal substring. Counting
  // both with plain indexOf reported every script action twice.
  const jsOnly = inspectDocument(bytes(CLEAN.replace('/Type /Catalog',
    '/Type /Catalog /Names << /JavaScript (app.alert(1)) >>')));
  check('one /JavaScript is counted exactly once', jsOnly.facts.jsKeys === 1,
    `jsKeys=${jsOnly.facts.jsKeys}`);
  check('one /JavaScript yields one critical finding',
    byId(jsOnly, 'embedded-js') && byId(jsOnly, 'embedded-js').severity === 'critical');
  check('/JavaScript finding title is singular',
    byId(jsOnly, 'embedded-js').title === '1 embedded JavaScript reference',
    byId(jsOnly, 'embedded-js').title);

  const both = inspectDocument(bytes(CLEAN.replace('/Type /Catalog',
    '/Type /Catalog /Names << /JavaScript (a) /JS (b) >>')));
  check('a real /JS key is counted alongside /JavaScript', both.facts.jsKeys === 2,
    `jsKeys=${both.facts.jsKeys}`);

  const active = inspectDocument(bytes(CLEAN.replace('/Type /Catalog', [
    '/Type /Catalog',
    '/OpenAction 9 0 R /AA << /O << /JS (go) >> >>',
    '/Names << /JavaScript (payload) >>',
    '/AcroForm << /XFA 10 0 R >>',
  ].join(' ')).replace('trailer', [
    '/Launch 11 0 R /SubmitForm 12 0 R /ImportData 13 0 R /GoToE 14 0 R',
    '/EmbeddedFile 15 0 R /Filespec 16 0 R /OCProperties << /OCG 17 0 R >>',
    '/RichMedia 18 0 R /URI (https://example.invalid) /Encrypt 19 0 R',
    '/ByteRange [0 1 2 3] /Author (Jane Doe) /Metadata 20 0 R',
    'trailer',
  ].join('\n'))));
  const expected = [
    'embedded-js', 'auto-actions', 'launch', 'external-data', 'embedded-files',
    'optional-content', 'rich-media', 'xfa', 'metadata', 'xmp', 'links',
    'encrypted', 'signatures',
  ];
  const missing = expected.filter((id) => !byId(active, id));
  check('every active-content / exposure class is reported', missing.length === 0,
    missing.length ? `missing ${missing.join(', ')}` : `${expected.length} classes`);
  check('launch action is critical', byId(active, 'launch').severity === 'critical');
  check('external data actions are high', byId(active, 'external-data').severity === 'high');
  check('metadata value is decoded', /Jane Doe/.test(byId(active, 'metadata').evidence || ''));
  check('findings are sorted by severity',
    (() => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return active.findings.every((f, i, a) => i === 0 || rank[a[i - 1].severity] <= rank[f.severity]);
    })());
  check('risky document scores below a clean one', active.score < 100, `score=${active.score}`);
  check('critical verdict wins over high', /critical issue/.test(verdict(active)), verdict(active));
}

console.log('── verdict ────────────────────────────────────────────────────────');

{
  check('null report is handled', verdict(null) === 'No document');
  check('failed report is handled', verdict({ ok: false }) === 'No document');
  check('high-only verdict', verdict({ ok: true, summary: { critical: 0, high: 2, medium: 0 } }) === '2 high-risk findings');
  check('medium-only verdict', verdict({ ok: true, summary: { critical: 0, high: 0, medium: 1 } }) === '1 item to review');
}

console.log('── accessibility audit (byte fallback) ───────────────────────────');

{
  const a = auditAccessibility(bytes(CLEAN));
  check('audit returns a well-formed report', a.ok === true && Array.isArray(a.checks));
  check('all 14 baseline checks are present', a.checks.length === 14, String(a.checks.length));
  const status = (id) => (a.checks.find((c) => c.id === id) || {}).status;
  check('untagged PDF fails the tagged check', status('tagged') === 'fail');
  check('missing structure tree fails', status('structure-tree') === 'fail');
  check('missing language fails', status('language') === 'fail');
  check('drawn text without /ToUnicode fails', status('unicode') === 'fail');
  check('an untagged PDF is never reported as tagged', a.facts.tagged === false);
  check('fixable list only offers metadata-level repairs',
    JSON.stringify(a.fixable) === JSON.stringify(['language', 'title', 'display-title']),
    JSON.stringify(a.fixable));
  check('checks are sorted failures first',
    (() => {
      const rank = { fail: 0, warn: 1, pass: 2 };
      return a.checks.every((c, i, arr) => i === 0 || rank[arr[i - 1].status] <= rank[c.status]);
    })());
  check('score is bounded 0..100', a.score >= 0 && a.score <= 100 && Number.isInteger(a.score));
  check('grade matches the score band',
    (a.score >= 90 ? a.grade === 'A' : a.score >= 75 ? a.grade === 'B' : a.score >= 60 ? a.grade === 'C' : a.score >= 40 ? a.grade === 'D' : a.grade === 'F'));
}

console.log('── accessibility audit (authoritative catalog facts) ─────────────');

{
  const good = {
    tagged: true, structTreeRoot: true, lang: 'en-US', title: 'Annual Report',
    displayDocTitle: true, pageCount: 12, altCount: 4, outlines: true,
    tabsOrder: true, headings: 6, tableTags: 9, linkAnnots: 0,
    toUnicode: true, images: 2, encrypted: false,
  };
  const a = auditAccessibility(bytes(CLEAN), good);
  check('fully tagged document scores 100 / grade A', a.score === 100 && a.grade === 'A',
    `${a.score}/${a.grade}`);
  check('no failures or warnings remain', a.summary.fail === 0 && a.summary.warn === 0,
    JSON.stringify(a.summary));
  check('nothing is offered for automatic repair', a.fixable.length === 0);
  check('page count comes from the parser', a.facts.pageCount === 12);
  check('parser language is honoured', a.facts.lang === 'en-US');

  const partial = auditAccessibility(bytes(CLEAN), { ...good, tagged: false, lang: '', title: '' });
  check('parser facts override optimistic byte heuristics',
    (partial.checks.find((c) => c.id === 'tagged') || {}).status === 'fail');
  check('missing language is fixable', partial.fixable.includes('language'));
}

console.log('── image-only / scanned detection ────────────────────────────────');

{
  const scan = bytes('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n' +
    '2 0 obj\n<< /Subtype /Image /Width 100 /Height 100 >>\nendobj\n' +
    'xref\ntrailer\nstartxref\n0\n%%EOF');
  const a = auditAccessibility(scan);
  check('image-only page is flagged as scanned', a.facts.scanned === true);
  check('scanned check fails with an OCR remedy',
    (a.checks.find((c) => c.id === 'scanned') || {}).status === 'fail' &&
    /OCR/.test((a.checks.find((c) => c.id === 'scanned') || {}).fix || ''));
  check('no text means no /ToUnicode failure',
    (a.checks.find((c) => c.id === 'unicode') || {}).status === 'pass');
}

console.log('── compressed object streams ─────────────────────────────────────');

{
  const compressed = bytes(CLEAN.replace('trailer', '/ObjStm 30 0 R\ntrailer'));
  const fallback = auditAccessibility(compressed);
  check('compressed catalogs add an honesty warning in byte-only mode',
    fallback.checks.some((c) => c.id === 'compressed' && c.status === 'warn'));
  const precise = auditAccessibility(compressed, { tagged: true, structTreeRoot: true, lang: 'en-US' });
  check('warning disappears when the structural reader supplies facts',
    !precise.checks.some((c) => c.id === 'compressed'));
}

console.log('── real PDF fixture ───────────────────────────────────────────────');

{
  const p = path.join(ROOT, '.fixtures', 'fixture.pdf');
  if (!fs.existsSync(p)) {
    console.log('SKIP  real fixture not present (.fixtures/fixture.pdf)');
  } else {
    const raw = new Uint8Array(fs.readFileSync(p));
    const s = inspectDocument(raw);
    const a = auditAccessibility(raw);
    check('real PDF inspects without throwing', s.ok === true, s.error || `${raw.length} bytes`);
    check('real PDF size is reported verbatim', s.size === raw.length);
    check('real PDF produces a bounded score', s.score >= 0 && s.score <= 100);
    check('real PDF accessibility audit is well formed',
      a.ok === true && a.checks.length >= 14 && a.summary.fail + a.summary.warn + a.summary.pass === a.checks.length);
    check('repeated analysis is deterministic',
      JSON.stringify(inspectDocument(raw)) === JSON.stringify(s));
  }
}

console.log(problems ? `FORENSICS_FAIL ${problems} check(s) red` : 'FORENSICS_PASS all checks green');
process.exit(problems ? 1 : 0);
