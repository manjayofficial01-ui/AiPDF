/**
 * PDF → Word (AI) — the converter from the standalone `pdf2word-max` app,
 * rebuilt on AiPDF's own provider stack.
 *
 * How it works, and why it is shaped this way:
 *
 *  1. Every page is rasterised locally (viewer.renderPageToCanvas) and sent to
 *     the model the user already configured — base URL, key, auth mode and
 *     custom headers all come from `settings.ai` via `visionRequest()`. The
 *     original app hard-wired Gemini and `process.env.API_KEY`; here the
 *     provider is whatever the user connected, Gemini or not.
 *  2. The model answers with a semantic HTML fragment per page (headings,
 *     paragraphs, lists, tables). HTML is the interchange format because it is
 *     what a vision model writes most reliably.
 *  3. We assemble those fragments into a real `.docx` — an OOXML ZIP written by
 *     ./zip.js. The original app wrapped the HTML in a Word-HTML header and
 *     saved it as `.doc`, which Word opens with a "format and extension don't
 *     match" warning and which loses real styles. A genuine `.docx` opens
 *     clean and its headings land in the Navigation pane.
 *
 * Everything except the network call is pure and synchronous, so the DOCX
 * writer is testable headlessly (see `docxSelfTest` and scripts/pdf2word-test).
 */

import { activeDoc, settings } from './store.js';
import { aiReady, configureAI, visionRequest, isGemini } from './ai.js';
import { showModal, formRow } from './dialog.js';
import { el, toast, escapeHtml } from './util.js';
import { renderPageToCanvas } from './viewer.js';
import { zipStore } from './zip.js';
import { parsePageRange, allPages } from './docxtools.js';

/* ══ Prompts ═════════════════════════════════════════════════════════════════
   Adapted from pdf2word-max/services/geminiService.ts. Two modes, matching the
   original app: Standard (born-digital pages) and OCR (scans/photos). The
   shared tail keeps the model on a short leash — no wrapper tags, no markdown
   fences, no commentary — because every stray character ends up in Word. */

const HTML_RULES = `
Output rules — follow them exactly:
- Return ONLY the HTML fragment for this page. No <html>, <head>, <body>, <style> or <script> tags.
- Do not wrap the answer in markdown code fences.
- Do not describe the page, add commentary, or apologise.
- Keep the page's reading order, and keep every heading, list and table.
- TABLES ARE CRITICAL. Reproduce every table exactly as <table> with <tr> rows and <td>/<th> cells. Keep ALL columns and ALL rows in their original order — never flatten a table into paragraphs or bullet points, and never drop a column. Use <th> for the header row and set colspan="N" when a cell spans several columns.
- Use <p> for ordinary text, <h1>…<h6> for headings, <ul>/<ol>/<li> for lists, <strong>/<em>/<u> for emphasis.
- Never invent text that is not on the page.`;

const PROMPTS = {
  standard: `You are a document conversion engine. Convert the content of this PDF page into clean, semantic HTML so it can be pasted into a Word document.${HTML_RULES}`,
  ocr: `You are an expert OCR engine. This page is a scan or a photograph. Transcribe every readable word into semantic HTML, ignoring speckle, scanner noise, JPEG artefacts and page borders. Where a word is genuinely illegible write [illegible] rather than guessing.${HTML_RULES}`,
};

/** DPI for the rasterised fallback (non-Gemini providers). Gemini reads a
 *  native PDF instead, where DPI does not apply. Born-digital pages need 200
 *  for the model to recover a table grid; scans want more. */
const DPI = { standard: 200, ocr: 240 };

/**
 * Split one page out of the open document as a standalone, single-page PDF and
 * return it as a base64 data URL. Gemini (and a few other endpoints) accept
 * `application/pdf` inline data and read the document structure natively —
 * which is why `pdf2word-max` keeps tables and headings that a rasterised
 * image loses. pdf-lib is loaded lazily from the /v/ virtual path so this
 * module has no hard dependency on it at import time.
 */
async function pagePdfDataUrl(doc, index) {
  const PL = await import('/v/pdf-lib.js');
  const src = await PL.PDFDocument.load(doc.bytes);
  const out = await PL.PDFDocument.create();
  const [p] = await out.copyPages(src, [index]);
  out.addPage(p);
  const bytes = await out.save();
  let s = '';
  for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
  return 'data:application/pdf;base64,' + btoa(s);
}

/* ══ OOXML ═════════════════════════════════════════════════════════════════ */

const XML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xesc = (s) => String(s).replace(/[&<>"']/g, (c) => XML_MAP[c]);
/** Control characters are illegal in XML 1.0 and make Word refuse the file. */
const xclean = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');

/** A short, tag-free error line for the "page failed" placeholder. Without
 *  this a provider that answers with an HTML page dumps the whole document
 *  into the Word file. */
function cleanErrMsg(err) {
  let s = String(err?.message || err || 'unknown error');
  s = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return s.slice(0, 240) || 'unknown error';
}

/** A config/network failure will fail every page identically — detect it so
 *  the run can stop after the first page instead of calling N times. */
function isFatalAiError(err) {
  const m = String(err?.message || err || '');
  return /HTML page instead of JSON|AI request failed|fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network error/i.test(m);
}

/** A4 portrait in twips, 2cm margins — the shape of the PDF we just read. */
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134;
const CONTENT_W = PAGE_W - MARGIN * 2;

function runsXml(runs, forceMono = false) {
  let out = '';
  for (const r of runs || []) {
    if (r.tab) { out += '<w:r><w:tab/></w:r>'; continue; }
    if (r.br) { out += '<w:r><w:br/></w:r>'; continue; }
    const text = xclean(r.text || '');
    if (!text) continue;
    const props = [];
    if (r.bold) props.push('<w:b/>');
    if (r.italic) props.push('<w:i/>');
    if (r.underline) props.push('<w:u w:val="single"/>');
    if (r.mono || forceMono) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
    const rPr = props.length ? `<w:rPr>${props.join('')}</w:rPr>` : '';
    out += `<w:r>${rPr}<w:t xml:space="preserve">${xesc(text)}</w:t></w:r>`;
  }
  return out;
}

function paraXml(block) {
  const b = block || {};
  const pPr = [];
  if (b.style) pPr.push(`<w:pStyle w:val="${b.style}"/>`);
  if (b.indent || b.hanging) {
    pPr.push(`<w:ind w:left="${b.indent || 0}"${b.hanging ? ` w:hanging="${b.hanging}"` : ''}/>`);
  }
  return `<w:p>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${runsXml(b.runs, !!b.mono)}</w:p>`;
}

const HR_XML = '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';

/** `rows` is an array of cells; each cell is `{ blocks, header, colspan }`. */
function tableXml(rows) {
  // Account for colspans so the grid width and every row line up.
  const colCounts = rows.map((cells) => cells.reduce((n, c) => n + (c.colspan || 1), 0));
  const cols = Math.max(1, ...colCounts);
  const colW = Math.floor(CONTENT_W / cols);
  const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
    .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`).join('');
  const grid = Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join('');
  const body = rows.map((cells) => {
    const tcs = [];
    for (const cell of cells) {
      const span = cell.colspan || 1;
      const tcW = colW * span;
      const inner = (cell.blocks || []).map(blockXml).join('') || '<w:p/>';
      const shd = cell.header ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>' : '';
      const gridSpan = span > 1 ? `<w:gridSpan w:val="${span}"/>` : '';
      tcs.push(`<w:tc><w:tcPr><w:tcW w:w="${tcW}" w:type="dxa"/>${gridSpan}${shd}</w:tcPr>${inner}</w:tc>`);
    }
    // Pad short rows so each row spans exactly `cols` grid columns; Word
    // rejects tables where rows disagree on the column count.
    while (tcs.length < cols) tcs.push(`<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`);
    return `<w:tr>${tcs.join('')}</w:tr>`;
  }).join('');
  // A table must be followed by a paragraph, otherwise two adjacent tables merge.
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${cols * colW}" w:type="dxa"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl><w:p/>`;
}

function blockXml(b) {
  if (!b) return '';
  if (b.kind === 'hr') return HR_XML;
  if (b.kind === 'table') return tableXml(b.rows || []);
  return paraXml(b);
}

/* ══ HTML → blocks ═════════════════════════════════════════════════════════ */

const INLINE_FMT = {
  B: 'bold', STRONG: 'bold', I: 'italic', EM: 'italic', U: 'underline', INS: 'underline',
  CODE: 'mono', KBD: 'mono', SAMP: 'mono', TT: 'mono', A: 'underline',
};

/** Walk inline content, inheriting emphasis down the tree. */
function inlineRuns(node, fmt = {}) {
  const runs = [];
  for (const child of node.childNodes || []) {
    if (child.nodeType === 3) {
      const t = child.nodeValue.replace(/\s+/g, ' ');
      if (t) runs.push({ ...fmt, text: t });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (tag === 'BR') { runs.push({ br: true }); continue; }
    if (tag === 'IMG' || tag === 'SCRIPT' || tag === 'STYLE') continue;
    const key = INLINE_FMT[tag];
    runs.push(...inlineRuns(child, key ? { ...fmt, [key]: true } : fmt));
  }
  return runs;
}

/** Drop the leading/trailing whitespace the HTML source carries between tags. */
function trimRuns(runs) {
  const out = runs.slice();
  while (out.length && !out[0].br && !out[0].tab && !String(out[0].text || '').trim()) out.shift();
  while (out.length && !out[out.length - 1].br && !out[out.length - 1].tab && !String(out[out.length - 1].text || '').trim()) out.pop();
  if (out.length && out[0].text) out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, '') };
  const last = out.length - 1;
  if (last >= 0 && out[last].text) out[last] = { ...out[last], text: out[last].text.replace(/\s+$/, '') };
  return out;
}

function listBlocks(listEl, depth = 0) {
  const out = [];
  const ordered = listEl.tagName === 'OL';
  let n = 1;
  for (const li of listEl.children) {
    if (li.tagName !== 'LI') continue;
    const marker = ordered ? `${n++}.` : '•';
    const inline = [];
    // Only the list item's own text belongs on the bullet line; nested lists
    // are emitted as their own blocks below.
    for (const child of li.childNodes) {
      if (child.nodeType === 1 && (child.tagName === 'UL' || child.tagName === 'OL')) continue;
      inline.push(child);
    }
    const runs = trimRuns(inline.flatMap((c) => (c.nodeType === 3
      ? (c.nodeValue.replace(/\s+/g, ' ').trim() ? [{ text: c.nodeValue.replace(/\s+/g, ' ') }] : [])
      : inlineRuns(c))));
    out.push({ kind: 'p', runs: [{ text: marker }, { tab: true }, ...runs], indent: 720 + depth * 360, hanging: 360 });
    for (const child of li.children) {
      if (child.tagName === 'UL' || child.tagName === 'OL') out.push(...listBlocks(child, depth + 1));
    }
  }
  return out;
}

function tableRows(tbl) {
  const rows = [];
  for (const tr of tbl.querySelectorAll('tr')) {
    const cells = [];
    for (const cell of tr.children) {
      if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
      const blocks = blocksFromNode(cell);
      const cs = parseInt(cell.getAttribute('colspan') || '1', 10);
      cells.push({ blocks: blocks.length ? blocks : [], header: cell.tagName === 'TH', colspan: cs > 1 ? cs : 1 });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/** Flatten a DOM subtree into a block list the OOXML writer understands. */
function blocksFromNode(root, depth = 0) {
  const out = [];
  for (const child of root.childNodes || []) {
    if (child.nodeType === 3) {
      const t = child.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) out.push({ kind: 'p', runs: [{ text: t }] });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (/^H[1-6]$/.test(tag)) {
      out.push({ kind: 'p', style: `Heading${tag[1]}`, runs: trimRuns(inlineRuns(child)) });
    } else if (tag === 'P') {
      out.push({ kind: 'p', runs: trimRuns(inlineRuns(child)) });
    } else if (tag === 'HR') {
      out.push({ kind: 'hr' });
    } else if (tag === 'PRE') {
      out.push({ kind: 'p', mono: true, runs: [{ mono: true, text: child.textContent.replace(/\n+$/, '') }] });
    } else if (tag === 'BLOCKQUOTE') {
      out.push(...blocksFromNode(child, depth + 1).map((b) => ({ ...b, indent: (b.indent || 0) + 720 })));
    } else if (tag === 'UL' || tag === 'OL') {
      out.push(...listBlocks(child, depth));
    } else if (tag === 'LI') {
      out.push({ kind: 'p', runs: [{ text: '•' }, { tab: true }, ...trimRuns(inlineRuns(child))], indent: 720, hanging: 360 });
    } else if (tag === 'TABLE') {
      out.push({ kind: 'table', rows: tableRows(child) });
    } else if (tag === 'SCRIPT' || tag === 'STYLE') {
      // ignore
    } else {
      // div/section/article/span-as-block and anything unknown: recurse so no
      // text is ever silently dropped.
      out.push(...blocksFromNode(child, depth));
    }
  }
  return out;
}

/** Last-resort path: the model answered in Markdown or bare prose. */
function plainToHtml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let list = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { if (list) { out.push(`</${list}>`); list = null; } continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      if (list) { out.push(`</${list}>`); list = null; }
      out.push(`<h${h[1].length}>${escapeHtml(h[2])}</h${h[1].length}>`);
    } else if (li || ol) {
      const want = li ? 'ul' : 'ol';
      if (list !== want) { if (list) out.push(`</${list}>`); out.push(`<${want}>`); list = want; }
      out.push(`<li>${escapeHtml((li || ol)[1])}</li>`);
    } else {
      if (list) { out.push(`</${list}>`); list = null; }
      out.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  if (list) out.push(`</${list}>`);
  return out.join('\n');
}

/** Strip the wrapper tags and code fences models add even when told not to. */
export function cleanModelHtml(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '');
  s = s.replace(/^\s*```(?:html)?\s*/i, '').replace(/\s*```\s*$/, '');
  s = s.replace(/<!DOCTYPE[^>]*>/gi, '');
  s = s.replace(/<\/?(?:html|head|body|main)[^>]*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.trim();
  // No tags at all → the model ignored the format instruction; salvage it.
  if (!/<[a-z][^>]*>/i.test(s)) s = plainToHtml(s);
  return s;
}

/** Public: HTML fragment (one page) → block list. */
export function htmlToBlocks(html) {
  const host = document.createElement('div');
  host.innerHTML = cleanModelHtml(html);
  const blocks = blocksFromNode(host);
  // An empty page still needs one paragraph or the page break has nowhere to sit.
  return blocks.length ? blocks : [{ kind: 'p', runs: [] }];
}

/* ══ Package parts ═════════════════════════════════════════════════════════ */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
</Relationships>`;

const SETTINGS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="100"/><w:defaultTabStop w:val="720"/><w:compat/></w:settings>`;

function headingStyle(level, size, extra = '') {
  return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/>${extra}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${headingStyle(1, 40)}
${headingStyle(2, 32)}
${headingStyle(3, 28)}
${headingStyle(4, 26)}
${headingStyle(5, 24)}
${headingStyle(6, 22, '<w:i/>')}
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

const SECT_PR = `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;

function coreXml(meta) {
  const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xesc(meta.title || 'Document')}</dc:title>
<dc:creator>${xesc(meta.creator || 'AiPDF Editor')}</dc:creator>
<cp:lastModifiedBy>${xesc(meta.creator || 'AiPDF Editor')}</cp:lastModifiedBy>
<dc:description>${xesc(meta.description || '')}</dc:description>
<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>
</cp:coreProperties>`;
}

/** Build `document.xml` from a list of block lists (one per PDF page). */
export function buildDocumentXml(pageBlocks) {
  const parts = [];
  pageBlocks.forEach((blocks, i) => {
    if (i > 0) parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    for (const b of blocks) parts.push(blockXml(b));
  });
  // A body may not end on a table: Word needs a paragraph before sectPr.
  if (!parts.length || parts[parts.length - 1].startsWith('<w:tbl')) parts.push('<w:p/>');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${parts.join('')}${SECT_PR}</w:body></w:document>`;
}

/** Public: one HTML fragment per page → `.docx` bytes. */
export function buildDocxFromPages(pages, meta = {}) {
  const pageBlocks = (pages || []).map((html) => htmlToBlocks(html));
  const documentXml = buildDocumentXml(pageBlocks.length ? pageBlocks : [[]]);
  return zipStore([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/settings.xml', data: SETTINGS },
    { name: 'docProps/core.xml', data: coreXml(meta) },
  ]);
}

/* ══ Flow ═════════════════════════════════════════════════════════════════ */

const MODES = [
  ['standard', 'Standard — born-digital pages (fast)'],
  ['ocr', 'OCR — scans and photos (slower, higher detail)'],
];

async function askOptions(doc) {
  const a = settings.ai || {};
  const total = doc.numPages;
  const out = { pages: null, mode: 'standard' };
  const range = el('input', { type: 'text', value: `1-${total}`, placeholder: 'all' });
  const mode = el('select', {});
  MODES.forEach(([v, t]) => mode.appendChild(el('option', { value: v, text: t })));
  mode.value = 'standard';

  const ok = await showModal({
    title: 'PDF to Word (AI)',
    body: (b) => {
      b.appendChild(el('div', {
        class: 'hint',
        text: `Each page is rendered and read by ${a.model || 'your model'}, then rebuilt as a real .docx. Pages leave this machine only for the provider you configured (${a.baseUrl || '—'}).`,
      }));
      b.appendChild(formRow('Pages', range).row);
      b.appendChild(formRow('Mode', mode).row);
      b.appendChild(el('div', {
        class: 'hint',
        text: 'A page takes one model call. Long documents cost more time and tokens — convert a range first to check the result.',
      }));
    },
    buttons: [
      { label: 'Cancel', value: false },
      { label: 'Convert', value: true, kind: 'primary', default: true },
    ],
  });
  if (!ok) return null;

  const text = String(range.value || '').trim();
  // An empty box means "everything" — the placeholder promises that.
  const pages = (!text || /^(all|\*)$/i.test(text)) ? allPages(total) : parsePageRange(text, total);
  if (!pages.length) {
    toast('No pages matched that range', 'err');
    return null;
  }
  out.pages = pages;
  out.mode = MODES.some(([v]) => v === mode.value) ? mode.value : 'standard';
  return out;
}

/**
 * Non-blocking progress overlay. Starts as an indeterminate shimmer, then
 * switches to a determinate bar + percentage once page reading begins, so a
 * long conversion visibly moves instead of freezing the window.
 */
function openProgress(title) {
  const bar = el('div', { class: 'busy-bar inline' });
  const label = el('div', { class: 'p2w-label', text: 'Preparing…' });
  const pct = el('div', { class: 'p2w-pct', text: '0%' });
  const card = el('div', { class: 'p2w-card' }, [
    el('div', { class: 'p2w-title', text: title }),
    label,
    bar,
    pct,
  ]);
  const overlay = el('div', { class: 'p2w-overlay' }, [card]);
  document.body.appendChild(overlay);
  let determinate = false;
  let closed = false;
  return {
    set(p, text) {
      const v = Math.max(0, Math.min(100, Math.round(Number(p) || 0)));
      if (!determinate) { bar.className = 'busy-bar inline determinate'; determinate = true; }
      bar.style.setProperty('--p', v + '%');
      pct.textContent = v + '%';
      if (text) label.textContent = text;
    },
    close() { if (!closed) { closed = true; overlay.remove(); } },
  };
}

/**
 * Convert the open document to Word.
 *
 * `busy(on, label)` is injected by app.js so the status bar keeps working
 * without this module reaching into app.js internals (which would be a cycle).
 */
export async function convertPdfToWord(opts = {}) {
  const busy = typeof opts.busy === 'function' ? opts.busy : () => {};
  // Injection seams: production passes nothing and gets the real provider and
  // the real file APIs; scripts/pdf2word-test.mjs substitutes both so the whole
  // pipeline can run offline. Nothing else in the flow is mocked.
  const api = opts.api || window.api || {};
  const vision = typeof opts.vision === 'function' ? opts.vision : visionRequest;
  const doc = activeDoc();
  if (!doc) {
    toast('Open a PDF first', 'err');
    return { ok: false, reason: 'no-document' };
  }

  // The whole feature depends on a vision-capable provider. Ask for one instead
  // of failing with a cryptic HTTP error halfway through the first page.
  if (!aiReady()) {
    await configureAI(true);
    if (!aiReady()) {
      toast('PDF to Word needs an AI provider — add a base URL, model and key, then try again.', 'err', 7000);
      return { ok: false, reason: 'no-ai' };
    }
  }

  // Tests may hand in an explicit plan; the UI path always asks.
  const plan = Array.isArray(opts.pages) && opts.pages.length
    ? { pages: opts.pages, mode: opts.mode === 'ocr' ? 'ocr' : 'standard' }
    : await askOptions(doc);
  if (!plan) return { ok: false, reason: 'cancelled' };

  const total = plan.pages.length;
  const html = [];
  let failed = 0;
  let firstErr = '';
  const prog = openProgress('Converting to Word');
  try {
    for (let k = 0; k < total; k++) {
      const i = plan.pages[k];
      // Pages occupy the first 90% of the bar; packing/saving the rest.
      prog.set((k / total) * 90, `AI reading page ${i + 1} (${k + 1}/${total})…`);
      busy(true, `AI reading page ${i + 1} (${k + 1}/${total})…`);
      let fragment = '';
      try {
        let dataUrl;
        // Gemini (and endpoints that accept PDF inline data) read the page's
        // native structure, so tables and headings survive. Everything else
        // falls back to a high-DPI raster the model has to OCR.
        const native = isGemini(settings.ai) && doc.bytes && doc.bytes.length;
        if (native) {
          dataUrl = await pagePdfDataUrl(doc, i);
        } else {
          const canvas = await renderPageToCanvas(i, DPI[plan.mode] || 200);
          dataUrl = canvas.toDataURL('image/jpeg', 0.92);
          // Free the backing store before the next page allocates another one.
          canvas.width = 0;
          canvas.height = 0;
        }
        fragment = cleanModelHtml(await vision(PROMPTS[plan.mode] || PROMPTS.standard, dataUrl, undefined, { maxTokens: 16384 }));
      } catch (err) {
        failed++;
        if (!firstErr) firstErr = cleanErrMsg(err);
        fragment = `<p>[Page ${i + 1} could not be converted: ${escapeHtml(firstErr)}]</p>`;
        // Stop on a misconfigured/blocked endpoint: every page would fail the
        // same way, and the user needs the diagnosis, not N failed calls.
        if (failed === 1 && isFatalAiError(err)) {
          busy(false);
          toast('PDF to Word failed: ' + firstErr, 'err', 9000);
          return { ok: false, reason: 'endpoint', error: firstErr };
        }
      }
      html.push(fragment);
      prog.set(((k + 1) / total) * 90);
    }

    // Nothing converted: do not write a document full of error placeholders.
    // Surface the real reason (e.g. a Cloudflare block) and stop.
    if (failed === total) {
      busy(false);
      toast('PDF to Word failed: ' + firstErr, 'err', 9000);
      return { ok: false, reason: 'all-failed', error: firstErr };
    }

    prog.set(92, 'Packing the Word document…');
    busy(true, 'Packing the Word document…');
    const base = (doc.name || 'document').replace(/\.pdf$/i, '');
    const bytes = buildDocxFromPages(html, {
      title: doc.meta?.title || base,
      creator: doc.meta?.author || 'AiPDF Editor',
      description: `Converted from ${doc.name || 'document.pdf'} by AiPDF Editor`,
    });
    busy(false);

    prog.set(97, 'Saving…');
    const path = await api.saveDialog({
      defaultPath: base + '.docx',
      filters: [{ name: 'Word document', extensions: ['docx'] }],
    });
    if (!path) return { ok: false, reason: 'cancelled' };

    const res = await api.writeFile(path, bytes);
    if (!res || !res.ok) {
      toast('Could not write the file: ' + (res?.error || 'unknown error'), 'err', 6000);
      return { ok: false, reason: 'write-failed', error: res?.error };
    }
    if (failed) {
      toast(`Word document saved — ${failed} page${failed === 1 ? '' : 's'} failed and are marked in the file`, 'warn', 7000);
    } else {
      toast(`Word document saved (${total} page${total === 1 ? '' : 's'})`, 'ok', 5000);
    }
    return { ok: true, path, pages: total, failed, bytes: bytes.length };
  } catch (err) {
    toast('PDF to Word failed: ' + (err?.message || err), 'err', 7000);
    return { ok: false, reason: 'error', error: String(err?.message || err) };
  } finally {
    prog.close();
    busy(false);
  }
}

/* ══ Self-test hook ═══════════════════════════════════════════════════════ */

/**
 * Headless checks for the DOCX writer: no model call, no file dialog. Returns
 * the observations the CDP suite asserts on.
 */
export function docxSelfTest() {
  const sample = `
    <h1>Quarterly Report</h1>
    <p>Revenue rose <strong>12%</strong> and <em>churn</em> fell.</p>
    <ul><li>North</li><li>South<ol><li>Coastal</li></ol></li></ul>
    <table><tr><th>Region</th><th>Q1</th></tr><tr><td>North</td><td>1,200</td></tr></table>
    <table><tr><th colspan="2">Totals</th></tr><tr><td>North</td><td>1,200</td></tr></table>
    <hr/>
    <p>Tail &amp; end.</p>`;
  const blocks = htmlToBlocks(sample);
  const docXml = buildDocumentXml([blocks, htmlToBlocks('<p>Page two</p>')]);
  const bytes = buildDocxFromPages([sample, '<p>Page two</p>'], { title: 'Test & Co' });
  const md = htmlToBlocks('## Heading\n- one\n- two');
  const blank = htmlToBlocks('');
  const raw = cleanModelHtml('```html\n<p>fenced</p>\n```');

  const magic = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const names = [];
  // Read the local file headers back out of the ZIP we just wrote.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at < bytes.length - 4;) {
    if (dv.getUint32(at, true) !== 0x04034b50) break;
    const n = dv.getUint16(at + 26, true);
    names.push(new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + n)));
    at += 30 + n + dv.getUint32(at + 18, true) + dv.getUint16(at + 28, true);
  }

  return {
    ok: true,
    bytes: bytes.length,
    magic,
    names,
    blocks: blocks.length,
    kinds: blocks.map((b) => b.kind + (b.style ? ':' + b.style : '')),
    hasHeadingStyle: docXml.includes('w:pStyle w:val="Heading1"'),
    hasBold: docXml.includes('<w:b/>'),
    hasItalic: docXml.includes('<w:i/>'),
    hasTable: docXml.includes('<w:tbl>') && docXml.includes('<w:tc>'),
    hasColspan: docXml.includes('<w:gridSpan w:val="2"/>'),
    hasPageBreak: docXml.includes('<w:br w:type="page"/>'),
    hasBullet: docXml.includes('•'),
    hasTab: docXml.includes('<w:tab/>'),
    escapedAmp: docXml.includes('Tail &amp; end.') && !docXml.includes('Tail & end.'),
    xmlWellFormed: (() => {
      try { return !!new DOMParser().parseFromString(docXml, 'application/xml').querySelector('parsererror') === false; } catch { return false; }
    })(),
    mdBlocks: md.length,
    mdHeading: md.some((b) => b.style === 'Heading2'),
    blankBlocks: blank.length,
    fencedClean: raw === '<p>fenced</p>',
  };
}
