/**
 * forensics.js — local, dependency-free PDF assurance analysis.
 *
 * Two independent audits over the raw file bytes:
 *
 *   inspectDocument()      security / privacy forensics (the "Action Inspector")
 *   auditAccessibility()   PDF/UA + WCAG structural checks
 *
 * Why byte-level? A PDF is an append-only object store. Saving a redaction in
 * most editors appends a new revision instead of removing the old one — the
 * "deleted" text is still physically in the file and recoverable with a text
 * editor. A DOM/annotation-level check cannot see that. Reading the bytes is
 * the only way to tell the truth, and it works fully offline with no upload.
 *
 * This module has ZERO imports so it can be unit-tested directly in Node
 * (scripts/forensics-test.mjs) and reused by an agent/MCP surface later.
 */

/* ── Byte helpers ───────────────────────────────────────────────────────── */

/** Decode bytes as Latin-1 without blowing the argument-list stack on big
 *  files. `String.fromCharCode(...bytes)` fails above ~120 KB. */
export function toLatin1(bytes) {
  const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < src.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, src.subarray(i, Math.min(i + CHUNK, src.length)));
  }
  return out;
}

function count(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/** Count regex matches. Used where a plain substring would over-count: the key
 *  `/JavaScript` literally contains `/JS`, so counting both as plain strings
 *  reports every script action twice. `\b` excludes that longer name. */
function countRe(hay, re) {
  const m = hay.match(re);
  return m ? m.length : 0;
}

function has(hay, ...needles) { return needles.some((n) => hay.indexOf(n) !== -1); }

/** Find every offset of a literal marker. Used to split incremental revisions. */
function offsets(hay, needle) {
  const out = [];
  let i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { out.push(i); i += needle.length; }
  return out;
}

/** Pull printable PDF literal strings `( ... )` out of a byte slice. Bounded,
 *  because a big binary stream can contain millions of accidental matches. */
function literalStrings(segment, cap = 4000) {
  const out = [];
  const re = /\((?:\\.|[^\\()])*\)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    if (out.length >= cap) break;
    const raw = m[0].slice(1, -1);
    if (raw.length < 4 || raw.length > 160) continue;
    if (!/[A-Za-z]{3}/.test(raw)) continue;
    if (/[^\x20-\x7e]/.test(raw)) continue;
    const text = raw.replace(/\\([nrtbf()\\])/g, (_, c) => (
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c
    )).replace(/\\[0-7]{1,3}/g, ' ').trim();
    if (text.length >= 4) out.push(text);
  }
  return out;
}

/** Decode a PDF metadata literal minimally for display. */
function metaValue(text, key) {
  const i = text.indexOf(key);
  if (i < 0) return '';
  const tail = text.slice(i + key.length, i + key.length + 240);
  const m = tail.match(/\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>/);
  if (!m) return '';
  if (m[1]) {
    const hex = m[1].replace(/\s/g, '');
    let s = '';
    for (let k = 2; k + 1 < hex.length; k += 4) s += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16) || 32);
    return s.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 90);
  }
  return m[0].slice(1, -1).replace(/\\([()\\])/g, '$1').replace(/[^\x20-\x7e]/g, '').trim().slice(0, 90);
}

const SEV = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
const PENALTY = { critical: 32, high: 16, medium: 7, low: 2, info: 0 };

function summarise(findings) {
  const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: findings.length };
  let penalty = 0;
  for (const f of findings) { summary[f.severity]++; penalty += PENALTY[f.severity]; }
  return { summary, score: Math.max(0, 100 - penalty) };
}

function finding(id, severity, category, title, detail, extra = {}) {
  return { id, severity, category, title, detail, ...extra };
}

/* ── 1. Security / privacy forensics ─────────────────────────────────────── */

/**
 * Inspect a PDF for active content, hidden data and recoverable old revisions.
 * @param {Uint8Array} bytes
 * @returns {{ok:boolean, size:number, score:number, summary:object,
 *            findings:Array, facts:object, error?:string}}
 */
export function inspectDocument(bytes) {
  const empty = { ok: false, size: 0, score: 0, summary: {}, findings: [], facts: {}, error: 'No data' };
  if (!bytes || !bytes.length) return empty;
  const text = toLatin1(bytes);
  if (text.slice(0, 1024).indexOf('%PDF-') < 0) {
    return { ...empty, size: bytes.length, error: 'Not a PDF (missing %PDF- header)' };
  }

  const findings = [];
  const eofAt = offsets(text, '%%EOF');
  const xrefAt = offsets(text, 'startxref');
  const header = (text.match(/%PDF-(\d\.\d)/) || [])[1] || 'unknown';
  const lastEof = eofAt.length ? eofAt[eofAt.length - 1] : -1;
  const trailing = lastEof >= 0 ? text.length - (lastEof + 5) : 0;
  const revisions = Math.max(eofAt.length, xrefAt.length);

  const jsKeys = count(text, '/JavaScript') + countRe(text, /\/JS\b/g);
  const hasOpenAction = has(text, '/OpenAction');
  const hasAA = has(text, '/AA');
  const embeddedFiles = count(text, '/EmbeddedFile');
  const fileSpecs = count(text, '/Filespec');
  const launch = count(text, '/Launch');
  const submitForm = count(text, '/SubmitForm');
  const importData = count(text, '/ImportData');
  const goToE = count(text, '/GoToE');
  const uri = count(text, '/URI');
  const ocg = count(text, '/OCG');
  const ocProps = has(text, '/OCProperties');
  const redactMarks = count(text, '/Redact');
  const signatures = count(text, '/ByteRange');
  const xfa = has(text, '/XFA');
  const richMedia = count(text, '/RichMedia') + count(text, '/3D') + count(text, '/Movie') + count(text, '/Sound');
  const objStm = count(text, '/ObjStm');
  const encrypted = has(text, '/Encrypt');
  const linearized = has(text, '/Linearized');
  const xmp = has(text, '/Metadata') || has(text, 'xpacket');
  const hasInfo = has(text, '/Info');
  const annotationContents = count(text, '/Contents');
  const freeText = count(text, '/FreeText');

  /* ── Incremental-update history: the redaction-leak detector ──────────── */
  let recovered = [];
  if (revisions > 1 && eofAt.length > 1) {
    const finalStart = eofAt[eofAt.length - 2] + 5;
    const finalSegment = text.slice(finalStart);
    const older = text.slice(0, finalStart);
    const oldStrings = literalStrings(older, 12000);
    const seen = new Set();
    for (const s of oldStrings) {
      if (seen.has(s)) continue;
      seen.add(s);
      if (finalSegment.indexOf(s) === -1) recovered.push(s);
      if (recovered.length >= 8) break;
    }
    const severity = redactMarks > 0 ? 'critical' : 'high';
    findings.push(finding(
      'incremental-history', severity, 'Hidden data',
      `${revisions} saved revisions remain inside this file`,
      `The file contains ${eofAt.length} end-of-file markers. PDFs are append-only: each save adds a new cross-reference section while leaving every earlier object in place. Text that was "deleted" in a previous save is still physically present and readable with a plain text editor.${redactMarks ? ' This file also contains redaction annotations — treat the redaction as potentially reversible.' : ''} Rebuilding the file (Save As, or Flatten & Sanitize here) is the only way to remove the old objects.`,
      { evidence: recovered.length ? `Older-revision strings not present in the final revision: ${recovered.map((s) => `"${s}"`).join(', ')}` : 'Earlier object generations are retained before the last cross-reference section.',
        remediation: 'Use "Flatten & Sanitize" to rewrite the document from its current object graph, dropping all prior revisions.',
        standard: 'NIST SP 800-88 · ISO 32000-1 §7.5.6', recovered, revisions }
    ));
  }

  if (trailing > 32) {
    findings.push(finding('trailing-data', 'high', 'Hidden data',
      `${trailing.toLocaleString()} bytes appended after the final %%EOF`,
      'Conforming readers ignore everything after the last end-of-file marker, so appended data is invisible in a viewer but fully recoverable. This is a common way to smuggle content past a visual review.',
      { remediation: 'Rewrite the file so it ends exactly at %%EOF.', standard: 'ISO 32000-1 §7.5.5' }));
  }

  /* ── Active content ───────────────────────────────────────────────────── */
  if (jsKeys > 0) {
    findings.push(finding('embedded-js', 'critical', 'Active content',
      `${jsKeys} embedded JavaScript reference${jsKeys === 1 ? '' : 's'}`,
      'The document contains JavaScript actions. These can execute on open, change what is displayed, submit data or reach the network. Static review of the visible pages is not sufficient for a signed or filed document.',
      { remediation: 'Strip all /JavaScript and /JS entries and rebuild the file.', standard: 'ISO 32000-1 §12.6.4' }));
  }
  if (hasOpenAction || hasAA) {
    findings.push(finding('auto-actions', jsKeys ? 'high' : 'medium', 'Active content',
      'Automatic actions fire without a click',
      `Found /OpenAction${hasOpenAction ? '' : ' (none)'}${hasAA ? ' and /AA (additional actions)' : ''}. These run on open, on page entry/exit, or on form events — before a reviewer can inspect the page.`,
      { remediation: 'Remove /OpenAction and /AA dictionaries before distribution.', standard: 'ISO 32000-1 §12.3 / §12.6' }));
  }
  if (launch > 0) {
    findings.push(finding('launch', 'critical', 'Active content',
      `${launch} /Launch action${launch === 1 ? '' : 's'}`,
      'A /Launch action can start an external program. This is the highest-risk PDF action type and is blocked by most hardened readers.',
      { remediation: 'Remove all /Launch actions.', standard: 'ISO 32000-1 §12.6.4.5' }));
  }
  if (submitForm > 0 || importData > 0 || goToE > 0) {
    findings.push(finding('external-data', 'high', 'Active content',
      'Form / data actions can reach outside the document',
      `Found ${submitForm} /SubmitForm, ${importData} /ImportData and ${goToE} /GoToE actions. These can POST form values to a remote endpoint or pull in external files.`,
      { remediation: 'Remove data-submission actions unless the destination is trusted.', standard: 'ISO 32000-1 §12.7.5' }));
  }
  if (embeddedFiles > 0 || fileSpecs > 0) {
    findings.push(finding('embedded-files', 'medium', 'Attachments',
      `${embeddedFiles} embedded file stream${embeddedFiles === 1 ? '' : 's'} (${fileSpecs} file spec${fileSpecs === 1 ? '' : 's'})`,
      'Embedded files are not visible on the page. They can carry their own metadata, macros or entirely different content from what a reviewer saw.',
      { remediation: 'Detach and inspect every embedded file, or remove /EmbeddedFile streams.', standard: 'ISO 32000-1 §7.11.4' }));
  }
  if (ocProps || ocg > 0) {
    findings.push(finding('optional-content', 'medium', 'Display integrity',
      `${ocg} optional-content layer${ocg === 1 ? '' : 's'} detected`,
      'Optional Content Groups (layers) can be shown on screen but hidden in print, or vice versa. What you see, what prints and what a recipient sees may differ.',
      { remediation: 'Flatten visible layers before filing or signing.', standard: 'ISO 32000-1 §8.11' }));
  }
  if (richMedia > 0) {
    findings.push(finding('rich-media', 'medium', 'Active content',
      `${richMedia} rich-media / 3D / sound object${richMedia === 1 ? '' : 's'}`,
      'Multimedia and 3D annotations can load external resources and are a common vector for reader exploits.',
      { remediation: 'Remove rich-media annotations.', standard: 'ISO 32000-1 §13.6' }));
  }
  if (xfa) {
    findings.push(finding('xfa', 'medium', 'Active content', 'Dynamic XFA form',
      'XFA forms carry their own layout and scripting model and are deprecated in PDF 2.0. Their content is often not covered by a page-level review.',
      { remediation: 'Convert to AcroForm or flatten.', standard: 'ISO 32000-2' }));
  }

  /* ── Metadata & passive exposure ──────────────────────────────────────── */
  const meta = {
    Author: metaValue(text, '/Author'), Creator: metaValue(text, '/Creator'),
    Producer: metaValue(text, '/Producer'), Title: metaValue(text, '/Title'),
    Subject: metaValue(text, '/Subject'), Keywords: metaValue(text, '/Keywords'),
  };
  const metaKeys = Object.entries(meta).filter(([, v]) => v);
  if (metaKeys.length) {
    findings.push(finding('metadata', 'low', 'Metadata',
      `${metaKeys.length} document metadata field${metaKeys.length === 1 ? '' : 's'} present`,
      'Author names, software versions and internal titles routinely leak into distributed PDFs. This is a common source of inadvertent disclosure in legal and HR documents.',
      { evidence: metaKeys.map(([k, v]) => `${k}: ${v}`).join('  ·  '),
        remediation: 'Clear /Info and XMP metadata before sharing.', standard: 'NIST SP 800-88' }));
  }
  if (xmp) {
    findings.push(finding('xmp', 'low', 'Metadata', 'XMP metadata packet present',
      'XMP can carry a full edit history (including previous file names, revision timestamps and software identifiers) that is not shown in the document properties dialog.',
      { remediation: 'Strip the /Metadata stream.', standard: 'ISO 16684-1' }));
  }
  if (freeText > 0 || annotationContents > 4) {
    findings.push(finding('annotation-text', 'info', 'Metadata',
      `${annotationContents} annotation content string${annotationContents === 1 ? '' : 's'}`,
      'Sticky notes, free-text boxes and comment replies store text that is easy to overlook when visually reviewing a page.',
      { remediation: 'Review the Comments panel and clear hidden note text.' }));
  }
  if (uri > 0) {
    findings.push(finding('links', 'info', 'Metadata', `${uri} URI action${uri === 1 ? '' : 's'}`,
      'Links can point to external hosts. Hovering in a hardened reader is the only way to see the real target.',
      { remediation: 'Verify link destinations before distributing.' }));
  }
  if (encrypted) {
    findings.push(finding('encrypted', 'info', 'Protection', 'Document is encrypted',
      'Encryption protects the file at rest but does not remove hidden data; decrypt and inspect before relying on it.',
      {}));
  }
  if (signatures > 0) {
    findings.push(finding('signatures', 'info', 'Protection', `${signatures} digital signature${signatures === 1 ? '' : 's'}`,
      'Rebuilding this file will invalidate existing signatures. Save a copy if the signature must be preserved.',
      {}));
  }

  const facts = {
    header, revisions, eofMarkers: eofAt.length, xrefSections: xrefAt.length,
    trailingBytes: Math.max(0, trailing), jsKeys, embeddedFiles, fileSpecs,
    ocg, redactMarks, signatures, objStm, encrypted, linearized, xmp,
    hasInfo, hasOpenAction, hasAA, metadata: meta,
  };

  findings.sort((a, b) => SEV[a.severity] - SEV[b.severity]);
  const { summary, score } = summarise(findings);
  return { ok: true, size: bytes.length, score, summary, findings, facts };
}

/* ── 2. Accessibility / PDF-UA audit ────────────────────────────────────── */

const A = { fail: 0, warn: 1, pass: 2 };

/**
 * @param {Uint8Array} bytes raw PDF
 * @param {object|null} structure optional precise catalog facts read with a PDF
 *        parser (see readStructure() in assurance.js). Falls back to byte scan.
 */
export function auditAccessibility(bytes, structure = null) {
  const text = bytes ? toLatin1(bytes) : '';
  const s = structure || {};
  const checks = [];
  const add = (id, status, title, detail, standard, weight = 1, fix = '') => {
    checks.push({ id, status, title, detail, standard, weight, fix });
  };
  const value = (k, fallback) => (k in s && s[k] !== undefined && s[k] !== null ? s[k] : fallback);

  const tagged = value('tagged', has(text, '/MarkInfo') && has(text, '/Marked', '/Marked true'));
  const structTree = value('structTreeRoot', has(text, '/StructTreeRoot'));
  const lang = value('lang', (text.match(/\/Lang\s*\(([^)]*)\)/) || [])[1] || '');
  const title = value('title', (text.match(/\/Title\s*\((?:\\.|[^\\()])*\)/) || [])[0] || '');
  const displayTitle = value('displayDocTitle', has(text, '/DisplayDocTitle'));
  const pageCount = value('pageCount', count(text, '/Type /Page') - count(text, '/Type /Pages'));
  const altCount = value('altCount', count(text, '/Alt') + count(text, '/ActualText'));
  const outlines = value('outlines', has(text, '/Outlines'));
  const tabsOrder = value('tabsOrder', has(text, '/Tabs'));
  const headings = value('headings', count(text, '/H1') + count(text, '/H2') + count(text, '/H3'));
  const tableTags = value('tableTags', count(text, '/Table') + count(text, '/TH') + count(text, '/TD'));
  const linkAnnots = value('linkAnnots', count(text, '/Subtype /Link'));
  const toUnicode = value('toUnicode', has(text, '/ToUnicode'));
  const images = value('images', count(text, '/Subtype /Image') + count(text, '/Image'));
  const textOps = count(text, 'Tj') + count(text, 'TJ');
  const encrypted = value('encrypted', has(text, '/Encrypt'));
  const compressedObjects = count(text, '/ObjStm') > 0;
  const scanned = images > 0 && textOps < 2 && !tagged;

  add('tagged', tagged ? 'pass' : 'fail', 'Tagged PDF',
    tagged ? 'The document declares /MarkInfo /Marked true — a logical structure is present.'
      : 'No tagged structure. Screen readers receive an undifferentiated stream of glyphs with no reading order, headings or table semantics. This is the single largest accessibility defect in a PDF.',
    'PDF/UA-1 §7.1 · WCAG 1.3.1', 3, 'Tag the document structure (or re-export from the authoring tool with tagging enabled).');

  add('structure-tree', structTree ? 'pass' : 'fail', 'Structure tree (/StructTreeRoot)',
    structTree ? 'A structure tree root is present.'
      : 'No /StructTreeRoot. Even if tags appear in content streams, without a structure tree there is no navigable document outline for assistive technology.',
    'PDF/UA-1 §7.2 · WCAG 1.3.1', 3, 'Add a structure tree; AiPDF cannot invent semantic roles from an untagged file.');

  add('language', lang ? 'pass' : 'fail', 'Document language (/Lang)',
    lang ? `Language declared: ${String(lang).slice(0, 24)}.` :
      'No /Lang in the catalog. Screen readers cannot choose the right pronunciation rules, so text may be read as nonsense.',
    'PDF/UA-1 §7.3 · WCAG 3.1.1', 2, 'Set the document language — this can be repaired automatically.');

  add('title', title ? 'pass' : 'warn', 'Document title',
    title ? 'A /Title is present in the document information dictionary.' :
      'No document title. The window/tab shows a filename instead of a meaningful name.',
    'PDF/UA-1 §7.4 · WCAG 2.4.2', 1, 'Set the document title — this can be repaired automatically.');

  add('display-title', displayTitle ? 'pass' : 'warn', 'Display document title',
    displayTitle ? '/ViewerPreferences /DisplayDocTitle is true.' :
      'The viewer is not instructed to show the document title in its title bar.',
    'PDF/UA-1 §7.4', 1, 'Set /DisplayDocTitle — this can be repaired automatically.');

  add('alt-text', altCount > 0 ? 'pass' : (images > 0 ? 'warn' : 'pass'), 'Alternative text for images',
    altCount > 0 ? `${altCount} /Alt or /ActualText entr${altCount === 1 ? 'y' : 'ies'} found.` :
      (images > 0 ? `${images} image object${images === 1 ? '' : 's'} and no /Alt or /ActualText. Non-text content has no text alternative.` : 'No image objects detected.'),
    'WCAG 1.1.1 · PDF/UA-1 §7.7', 2, 'Add alternative text to each meaningful figure (requires human judgement).');

  add('headings', headings > 0 ? 'pass' : 'warn', 'Heading structure',
    headings > 0 ? `${headings} heading tags (H1–H3) detected.` :
      'No heading structure tags. Assistive technology cannot navigate by section.',
    'WCAG 1.3.1 / 2.4.6', 1, 'Mark headings in the structure tree.');

  add('tables', tagged && tableTags === 0 ? 'warn' : 'pass', 'Table semantics',
    tableTags > 0 ? `${tableTags} table structure tags found.` :
      (tagged ? 'The document is tagged but no /Table, /TH or /TD structure elements were found. If the document contains data tables, their cell relationships are lost.' : 'No table tagging (document is untagged).'),
    'WCAG 1.3.1 · PDF/UA-1 §7.9', 1, 'Tag tables with row/column headers.');

  add('tab-order', tabsOrder ? 'pass' : 'warn', 'Tab / reading order',
    tabsOrder ? 'Explicit /Tabs order declared on pages.' :
      'No explicit /Tabs entry. Focus order falls back to the order objects were drawn, which is often not visual reading order in multi-column layouts.',
    'PDF/UA-1 §7.10 · WCAG 2.4.3', 1, 'Set /Tabs /S on pages.');

  add('unicode', textOps > 0 && !toUnicode ? 'fail' : 'pass', 'Text-to-Unicode mapping',
    toUnicode || textOps === 0 ? 'Fonts provide /ToUnicode CMaps (or there is no drawn text).' :
      'Text is drawn but no /ToUnicode CMap was found. Copy/paste and screen readers may produce garbage characters for embedded or subset fonts.',
    'PDF/UA-1 §7.21 · WCAG 1.1.1', 2, 'Re-embed fonts with /ToUnicode CMaps.');

  add('scanned', scanned ? 'fail' : 'pass', 'Image-only / scanned content',
    scanned ? 'The document appears to be image-only: image objects are present but almost no text-showing operators were found. It is unreadable to assistive technology until OCR adds a text layer.' :
      'Drawn text operators are present (or no images were detected).',
    'WCAG 1.1.1 / 1.4.5', 3, 'Run local OCR (Edit ▸ OCR) to add a real text layer.');

  add('bookmarks', outlines ? 'pass' : 'warn', 'Bookmarks for long documents',
    outlines ? 'An outline tree is present.' :
      'No bookmarks/outline. Long documents are slow to navigate for keyboard and screen-reader users.',
    'WCAG 2.4.1 / 2.4.5', 1, 'Generate an AI outline or add bookmarks.');

  add('links', linkAnnots > 0 ? 'warn' : 'pass', 'Link purpose',
    linkAnnots > 0 ? `${linkAnnots} link annotation${linkAnnots === 1 ? '' : 's'}. Verify each has a descriptive /Contents so its purpose is clear out of context.` : 'No link annotations detected.',
    'WCAG 2.4.4', 1, 'Add descriptive /Contents to link annotations.');

  add('encryption', encrypted ? 'warn' : 'pass', 'Accessibility permissions',
    encrypted ? 'The file is encrypted. Verify that the permission flags allow content extraction for accessibility; a restrictive /P value can block screen readers.' :
      'No encryption restricting assistive technology.',
    'PDF/UA-1 §7.1 · WCAG 4.1.1', 1, 'Enable "content accessibility" in the security settings.');

  if (compressedObjects && !structure) {
    add('compressed', 'warn', 'Compressed object streams',
      'Catalog dictionaries are inside /ObjStm streams, so a raw byte scan cannot fully confirm /Lang, /MarkInfo and /StructTreeRoot. Open the checker again with the structural reader for definitive results.',
      'ISO 32000-1 §7.5.7', 0, 'Re-run with the built-in structural reader.');
  }

  const summary = { fail: 0, warn: 0, pass: 0 };
  let earned = 0, total = 0;
  for (const c of checks) {
    summary[c.status]++;
    total += c.weight;
    if (c.status === 'pass') earned += c.weight;
    else if (c.status === 'warn') earned += c.weight * 0.5;
  }
  const score = total ? Math.round((earned / total) * 100) : 0;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F';
  checks.sort((a, b) => A[a.status] - A[b.status] || b.weight - a.weight);

  return {
    ok: true, score, grade, summary, checks,
    fixable: ['language', 'title', 'display-title'].filter((id) => checks.some((c) => c.id === id && c.status !== 'pass')),
    facts: { pageCount: Math.max(0, pageCount), tagged, structTree, lang, altCount, images, textOps, scanned, compressedObjects },
  };
}

/** Deterministic, human-readable one-line verdict for the status bar / ledger. */
export function verdict(report) {
  if (!report || !report.ok) return 'No document';
  if (report.summary.critical) return `${report.summary.critical} critical issue${report.summary.critical === 1 ? '' : 's'}`;
  if (report.summary.high) return `${report.summary.high} high-risk finding${report.summary.high === 1 ? '' : 's'}`;
  if (report.summary.medium) return `${report.summary.medium} item${report.summary.medium === 1 ? '' : 's'} to review`;
  return 'Clean — no hidden data found';
}
