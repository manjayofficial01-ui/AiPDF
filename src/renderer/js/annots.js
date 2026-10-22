import { state, activeDoc, settings } from './store.js';
import { rectToCss, toCss, currentScale, pageEl } from './viewer.js';
import { uid, clamp, rgbToCss, readableOn, hexToRgb } from './util.js';
import { renderStampPreviews } from './stamps.js';
import { normalizeRect, HANDLE_CURSORS } from './geometry.js';
import { textEditDrawBox, textEditWashes } from './textblocks.js';
import { storyFromEdit, layoutStory } from './story.js';
import { activeLayerName, layerVisible } from './layers.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const XHTMLNS = 'http://www.w3.org/1999/xhtml';

export function svgEl(tag, attrs = {}, children = []) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) n.appendChild(c);
  return n;
}

export const ANNOT_TYPES = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly',
  note: 'Text', callout: 'FreeText', textbox: 'FreeText', stamp: 'Stamp',
  rect: 'Square', ellipse: 'Circle', line: 'Line', arrow: 'Line', ink: 'Ink',
  brush: 'Ink', highlighter: 'Ink',
  signature: 'Stamp', image: 'Stamp', redact: 'Redact', whiteout: 'Square', measure: 'Line',
  roundRect: 'Square', measureArea: 'Polygon', polygon: 'Polygon', polyline: 'PolyLine',
  cloud: 'Polygon', areaHighlight: 'Polygon', caret: 'Caret', link: 'Link',
};

/* Brush and highlighter share /Subtype /Ink with the pencil, so the subtype
 * alone cannot say which tool wrote an annotation. /IT is the one free-name
 * field pdf.js hands back to us, and readers ignore an intent they do not
 * know, so the originating tool is recorded there and recovered on read-back. */
export const INK_INTENTS = { brush: 'InkBrush', highlighter: 'InkMarker' };
const INK_INTENT_TYPES = { InkBrush: 'brush', InkMarker: 'highlighter' };

/* pdf.js publishes /IT as `data.it`; reading `raw.intent` always gave
 * undefined, which is why saved callouts/measures reopened as plain
 * text boxes and lines. */
export function annotIntent(raw) {
  return raw.it || raw.intent || null;
}

/* ── Parsing annotations coming out of the PDF ──────────────────────────── */

function normColor(c) {
  if (!c) return [1, 0.85, 0.2];
  const arr = Array.from(c);
  if (arr.length >= 3) return arr.slice(0, 3).map((v) => clamp(v / 255, 0, 1));
  if (arr.length === 1) return [arr[0], arr[0], arr[0]];
  return [1, 0.85, 0.2];
}

/** A colour pulled from a FreeText /DA can arrive in either range — pdf.js
 *  reports `defaultAppearanceData.fontColor` in 0–255, but a raw /DA string is
 *  0–1, and a custom writer could go either way. Normalise whatever we get back
 *  to 0–1 so the on-screen box and the saved /DA always agree. */
function normAnyColor(c) {
  if (!c) return null;
  const arr = Array.from(c).slice(0, 3).map(Number);
  if (arr.some((v) => !Number.isFinite(v))) return null;
  if (arr.some((v) => v > 1.5)) return arr.map((v) => clamp(v / 255, 0, 1));
  return arr.map((v) => clamp(v, 0, 1));
}

function numericPath(points) {
  const values = Array.from(points || []);
  const flat = values.flatMap((p) => typeof p === 'number' ? [p] :
    Array.isArray(p) || ArrayBuffer.isView(p) ? Array.from(p) : [p?.x, p?.y]);
  return flat.length % 2 === 0 && flat.every(Number.isFinite) ? flat : [];
}

export function annotationState(a) {
  const ignored = new Set(['id', 'fromFile', 'origId', 'origRef', 'origIndex', 'origSubtype', 'originalState']);
  return JSON.stringify(Object.fromEntries(Object.keys(a).sort().filter((k) => !ignored.has(k)).map((k) => [k, a[k]])));
}

function flattenQuads(qp) {
  if (!qp) return [];
  const arr = Array.from(qp); // also handles typed arrays (e.g. Float32Array)
  if (!arr.length) return [];
  if (Array.isArray(arr[0]) || ArrayBuffer.isView(arr[0])) return arr.map((q) => Array.from(q));
  const out = [];
  for (let i = 0; i + 7 < arr.length; i += 8) out.push(arr.slice(i, i + 8));
  return out;
}

function parseFontSize(da) {
  if (!da) return null;
  const m = /([0-9]+(?:\.[0-9]+)?)\s+Tf/.exec(da);
  return m ? parseFloat(m[1]) : null;
}

/** Map a PDF font resource name back to a family + style.
 *  The name is whatever the producer chose — "Helv", "Times-Bold",
 *  "Arial-BoldItalic", "F1" — so the match is a heuristic, which is also how
 *  every other reader recovers a style from /DA. */
function fontFromName(name) {
  const s = String(name || '');
  const bold = /bold|black|heavy|semibold|\bBd\b|-B\b/i.test(s);
  const italic = /italic|oblique|obliq|\bIt\b|-I\b/i.test(s);
  let family = 'Helvetica';
  if (/times|serif/i.test(s)) family = 'Times';
  else if (/courier|mono|console/i.test(s)) family = 'Courier';
  else if (/symbol/i.test(s)) family = 'Symbol';
  else if (/zapf|dingbat|zadb/i.test(s)) family = 'ZapfDingbats';
  return { fontFamily: family, bold, italic };
}

/** Read the /DA (default appearance) of a FreeText annotation.
 *  pdf.js publishes it parsed as `defaultAppearanceData` — {fontSize,
 *  fontName, fontColor} — NOT as the raw string `defaultAppearance`, and the
 *  colour is 0–255. Older/newer builds may still hand back the string, so both
 *  shapes are accepted; without this the font, size and colour of every text
 *  box were silently reset on reopen. */
function parseDefaultAppearance(raw) {
  const d = raw && raw.defaultAppearanceData;
  if (d && typeof d === 'object') {
    const { fontFamily, bold, italic } = fontFromName(d.fontName);
    return {
      fontSize: Number.isFinite(d.fontSize) && d.fontSize > 0 ? d.fontSize : null,
      fontFamily,
      bold,
      italic,
      textColor: d.fontColor ? normAnyColor(d.fontColor) : null,
    };
  }
  // Fallback: a raw /DA string such as "/Times-Bold 14 Tf 1 0 0 rg".
  const str = raw && (raw.defaultAppearance || raw.da);
  if (typeof str === 'string' && str) {
    const fontName = /\/([A-Za-z0-9+\-_,]+)\s+[0-9.]+\s+Tf/.exec(str);
    const rgb = /([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+rg\b/.exec(str);
    const gray = /([0-9.]+)\s+g\b/.exec(str);
    let textColor = null;
    if (rgb) textColor = [+rgb[1], +rgb[2], +rgb[3]].map((v) => clamp(v, 0, 1));
    else if (gray) { const g = clamp(+gray[1], 0, 1); textColor = [g, g, g]; }
    const { fontFamily, bold, italic } = fontFromName(fontName ? fontName[1] : 'Helvetica');
    return { fontSize: parseFontSize(str), fontFamily, bold, italic, textColor };
  }
  return { fontSize: null, fontFamily: 'Helvetica', bold: false, italic: false, textColor: null };
}

/** pdf.js does not expose a FreeText annotation's /Q (text alignment) at all —
 *  it only reads /Q for form-field widgets. Read it back with pdf-lib instead.
 *  Annotations are matched by /Rect + /Subtype so the mapping cannot drift if
 *  pdf.js skips an annotation it does not understand. Safe to call always; it
 *  returns immediately when there is nothing to align. */
export async function applyFreeTextAlignment(doc) {
  const targets = (doc.annots || []).filter((a) => a && (a.type === 'textbox' || a.type === 'callout'));
  if (!targets.length || !doc.bytes) return 0;
  let PL;
  try { PL = await import('/v/pdf-lib.js'); } catch { return 0; }
  let pdf;
  try { pdf = await PL.PDFDocument.load(doc.bytes, { updateMetadata: false }); } catch { return 0; }
  const ALIGN = ['left', 'center', 'right'];
  let patched = 0;
  for (const a of targets) {
    const page = pdf.getPage(a.page);
    if (!page) continue;
    let annots;
    try { annots = page.node.Annots(); } catch { continue; }
    if (!annots) continue;
    const want = a.rect || [];
    for (let k = 0; k < annots.size(); k++) {
      let dict;
      try { dict = annots.lookup(k, PL.PDFDict); } catch { continue; }
      if (!dict) continue;
      let subtype;
      try { subtype = dict.get(PL.PDFName.of('Subtype')); } catch { continue; }
      if (!subtype || String(subtype) !== '/FreeText') continue;
      // Match on the rect so index drift (pdf.js dropping an unknown annot)
      // cannot pair the wrong annotation.
      let r = null;
      try { r = dict.get(PL.PDFName.of('Rect')); } catch { continue; }
      if (r && r.asArray) {
        const vals = [];
        for (let j = 0; j < Math.min(4, r.size()); j++) vals.push(r.get(j).asNumber());
        if (vals.length === 4 && vals.every(Number.isFinite)) {
          const near = vals.every((v, j) => Math.abs(v - (want[j] ?? v)) < 0.75);
          if (!near) continue;
        }
      }
      let q = null;
      try { q = dict.get(PL.PDFName.of('Q')); } catch { continue; }
      const n = q ? q.asNumber() : null;
      if (n == null) continue;
      a.align = ALIGN[n] || 'left';
      patched++;
      break;
    }
  }
  return patched;
}

export function parsePdfAnnotation(raw, pageIndex) {
  const subtype = raw.subtype || (raw.annotationType != null ? raw.subtype : 'Unknown');
  const rect = (raw.rect || [0, 0, 0, 0]).slice(0, 4);
  const color = normColor(raw.color);
  const base = {
    id: raw.id ? `pdf:${pageIndex}:${raw.id}` : uid('an'),
    origId: raw.id || null,
    origRef: raw.ref ? { num: raw.ref.num, gen: raw.ref.gen ?? 0 } : null,
    page: pageIndex,
    rect: Array.from(rect),
    color,
    opacity: raw.opacity != null && raw.opacity < 1 ? raw.opacity : (subtype === 'Highlight' ? 0.4 : 1),
    text: raw.contentsObj?.str ?? raw.contents ?? '',
    author: raw.titleObj?.str ?? raw.title ?? '',
    date: raw.modificationDate || raw.creationDate || '',
    borderWidth: raw.borderStyle?.width ?? 1,
    dash: raw.borderStyle?.dashArray?.length ? raw.borderStyle.dashArray : null,
    fromFile: true,
    flags: raw.annotationFlags || 0,
    origSubtype: subtype,
  };

  switch (subtype) {
    case 'Highlight':
    case 'Underline':
    case 'StrikeOut':
    case 'Squiggly': {
      const t = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly' }[subtype];
      const quads = flattenQuads(raw.quadPoints);
      return { ...base, type: t, quads, opacity: subtype === 'Highlight' ? (raw.opacity ?? 0.4) : (raw.opacity ?? 1) };
    }
    case 'Text':
      return { ...base, type: 'note', icon: raw.name || 'Note' };
    case 'FreeText': {
      const da = parseDefaultAppearance(raw);
      return {
        ...base,
        type: annotIntent(raw) === 'FreeTextCallout' ? 'callout' : 'textbox',
        fontSize: da.fontSize || 11,
        fontFamily: da.fontFamily || 'Helvetica',
        bold: !!da.bold,
        italic: !!da.italic,
        textColor: da.textColor || [0.08, 0.09, 0.12],
        fill: raw.backgroundColor ? normColor(raw.backgroundColor) : null,
        align: raw.textAlign || 'left',
        leader: raw.calloutLine || null,
      };
    }
    case 'Stamp':
      return { ...base, type: 'stamp', stampLabel: base.text || 'Stamp' };
    case 'Square': {
      // A rounded rectangle and an area highlight are both squares on disk;
      // /IT is the only field that tells them apart (and pdf.js passes it
      // through). The corner radius is not stored anywhere portable, so it is
      // re-derived from the rect exactly the way the draw tool computes it.
      const sqIntent = annotIntent(raw);
      if (sqIntent === 'AreaHighlight') {
        // pdf.js does not parse /Vertices on a Square, so a foreign file's
        // area highlight arrives as a box; fall back to the rect itself.
        const pts = numericPath(raw.vertices);
        const box = pts.length >= 4 ? pts : [rect[0], rect[1], rect[2], rect[1], rect[2], rect[3], rect[0], rect[3]];
        return { ...base, type: 'areaHighlight', poly: true, closed: true, points: box, opacity: base.opacity != null && base.opacity < 1 ? base.opacity : 0.35 };
      }
      if (sqIntent === 'RoundRect') {
        const w = Math.abs(rect[2] - rect[0]), h = Math.abs(rect[3] - rect[1]);
        return { ...base, type: 'roundRect', corner: Math.min(w, h) * 0.16, fill: raw.backgroundColor ? normColor(raw.backgroundColor) : null };
      }
      return { ...base, type: 'rect', fill: raw.backgroundColor ? normColor(raw.backgroundColor) : null };
    }
    case 'Circle':
      return { ...base, type: 'ellipse', fill: raw.backgroundColor ? normColor(raw.backgroundColor) : null };
    case 'Line': {
      const lc = raw.lineCoordinates || [rect[0], rect[1], rect[2], rect[3]];
      // A dimension line and a plain line share /Subtype /Line; only /IT tells
      // them apart. Without this, a saved measurement reopened as a plain line.
      const intent = annotIntent(raw);
      const isMeasure = intent === 'LineDimension';
      const isArrow = !isMeasure && ((raw.lineEndings || [])[1] === 'ClosedArrow' || intent === 'LineArrow');
      return {
        ...base,
        type: isMeasure ? 'measure' : isArrow ? 'arrow' : 'line',
        points: [lc[0], lc[1], lc[2], lc[3]],
        measure: raw.measure || null,
        ...(isMeasure ? { label: base.text || '' } : {}),
      };
    }
    case 'Ink': {
      // /InkList carries only coordinate pairs, so a brush's per-vertex widths
      // are lost on the round trip: the reopened stroke keeps its centreline
      // and base width and draws flat until it is edited again.
      const intent = annotIntent(raw);
      const type = INK_INTENT_TYPES[intent] || 'ink';
      const paths = Array.from(raw.inkLists || [], numericPath).filter((p) => p.length);
      const back = { ...base, type, paths };
      // A highlighter writes no /QuadPoints (it is meaningless on an /Ink), so
      // its swept band is rebuilt from the centreline on every read.
      if (type === 'highlighter') back.quads = paths.flatMap((p) => sweptQuads(p, base.borderWidth || 16));
      return back;
    }
    case 'Caret':
      return { ...base, type: 'caret', caret: true };
    case 'Polygon': {
      // /IT carries the Foxit intent: a cloud, a measured area or an area
      // highlight are all polygons on disk but distinct tools in the UI.
      const intent = annotIntent(raw);
      const pts = numericPath(raw.vertices);
      if (intent === 'PolygonCloud') return { ...base, type: 'cloud', poly: true, closed: true, points: pts };
      if (intent === 'PolygonDimension') return { ...base, type: 'measureArea', poly: true, closed: true, points: pts, label: base.text || '' };
      if (intent === 'AreaHighlight') return { ...base, type: 'areaHighlight', poly: true, closed: true, points: pts, opacity: base.opacity != null && base.opacity < 1 ? base.opacity : 0.35 };
      return { ...base, type: 'polygon', poly: true, closed: true, points: pts };
    }
    case 'PolyLine':
    case 'Polyline':
      return { ...base, type: 'polyline', poly: true, points: numericPath(raw.vertices) };
    case 'Link': {
      // Web links come back as url; page links as a resolved dest array whose
      // first element is a page ref. The ref is turned into a page index in
      // loadFileAnnotations (parsePdfAnnotation stays synchronous).
      if (raw.url) return { ...base, type: 'link', dest: 'uri', uri: raw.url, borderWidth: 0 };
      if (raw.dest && raw.dest.length && raw.dest[0] && typeof raw.dest[0].num === 'number') {
        return { ...base, type: 'link', dest: 'goto', destRef: { num: raw.dest[0].num, gen: raw.dest[0].gen ?? 0 }, borderWidth: 0 };
      }
      return null;
    }
    case 'Redact':
      return { ...base, type: 'redact', applied: false, quads: flattenQuads(raw.quadPoints) };
    case 'FileAttachment':
      return null; // Do not replace specialized annotations with sticky notes.
    default:
      return null; // Links/Widgets handled elsewhere
  }
}

/** Embedded file attachments — the data behind Foxit's Attachments panel.
 *  pdf.js hands them back as { name: { filename, content, description } }; we
 *  keep a flat model so buildPdf can re-embed them into a rebuilt file. */
export async function loadAttachments() {
  const d = activeDoc();
  if (!d) return;
  try {
    const raw = (await d.pdf.getAttachments()) || {};
    d.attachments = Object.entries(raw).map(([key, a]) => ({
      filename: a.filename || key,
      data: a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content || []),
      description: a.description || '',
    }));
  } catch {
    d.attachments = [];
  }
}

/** Same model shape for a file the user attaches from the panel. */
export function attachmentFromBytes(filename, data, description = '') {
  return {
    filename,
    data: data instanceof Uint8Array ? data : new Uint8Array(data || []),
    description,
  };
}

export async function loadFileAnnotations() {
  const d = activeDoc();
  if (!d) return;
  d.annots = [];
  d.originalAnnots = [];
  let sig = false;
  for (let i = 0; i < d.numPages; i++) {
    const page = await d.pdf.getPage(i + 1);
    const list = await page.getAnnotations();
    for (const raw of list) {
      if (raw.subtype === 'Signature' || raw.fieldType === 'Sig') sig = true;
      if (raw.subtype === 'Widget') continue;
      const a = parsePdfAnnotation(raw, i);
      if (a) {
        if (a.type === 'link' && a.dest === 'goto' && a.destRef) {
          // Resolve the destination ref to a page index by walking pages —
          // pdf.js hands back a bare {num, gen} object, not its own Ref.
          let idx = 0;
          for (let p = 0; p < d.numPages; p++) {
            const pg = await d.pdf.getPage(p + 1);
            if (pg.ref && pg.ref.num === a.destRef.num) { idx = p; break; }
          }
          a.destPage = idx;
          delete a.destRef;
        }
        a.originalState = annotationState(a);
        d.annots.push(a);
        d.originalAnnots.push({ id: a.id, page: i, origId: a.origId, origRef: a.origRef, origSubtype: a.origSubtype });
      }
    }
  }
  d.hasSignature = sig;
  // pdf.js never exposes a FreeText's /Q (text alignment), so recover it from
  // the stored bytes with pdf-lib and patch the model. Safe no-op when there
  // are no text boxes or no byte access.
  try { await applyFreeTextAlignment(d); } catch { /* alignment is best-effort */ }
  try { await applyLayerAssignment(d); } catch { /* layer read-back is best-effort */ }
}

/**
 * Recover a saved annotation's layer membership. The writer stores it as the
 * private /AIPDFLayer key on the annotation dict; pdf.js does not surface
 * custom keys, so this re-opens the stored bytes with pdf-lib and matches by
 * subtype + rect, the same drift-proof pairing applyFreeTextAlignment uses.
 * Same best-effort contract: safe to call always, returns immediately when
 * there is nothing to recover.
 */
export async function applyLayerAssignment(doc) {
  const targets = (doc.annots || []).filter((a) => a && !a.layer && a.fromFile);
  if (!targets.length || !doc.bytes) return 0;
  let PL;
  try { PL = await import('/v/pdf-lib.js'); } catch { return 0; }
  let pdf;
  try { pdf = await PL.PDFDocument.load(doc.bytes, { updateMetadata: false }); } catch { return 0; }
  const byPage = new Map();
  for (const a of targets) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }
  let patched = 0;
  for (const [pi, list] of byPage) {
    let page;
    try { page = pdf.getPage(pi); } catch { continue; }
    if (!page) continue;
    let annots;
    try { annots = page.node.Annots(); } catch { continue; }
    if (!annots) continue;
    const dicts = [];
    for (let k = 0; k < annots.size(); k++) {
      try { const dict = annots.lookup(k, PL.PDFDict); if (dict) dicts.push(dict); } catch { /* skip */ }
    }
    for (const a of list) {
      const sub = ANNOT_TYPES[a.type];
      if (!sub) continue;
      const r = a.rect || [];
      for (const dict of dicts) {
        try {
          if (dict.get(PL.PDFName.of('Subtype'))?.toString() !== '/' + sub) continue;
          const rr = dict.get(PL.PDFName.of('Rect'));
          if (!rr || !rr.asArray) continue;
          const vals = [];
          for (let j = 0; j < Math.min(4, rr.size()); j++) vals.push(rr.get(j).asNumber());
          if (vals.length !== 4 || !vals.every(Number.isFinite)) continue;
          if (!vals.every((v, j) => Math.abs(v - (r[j] ?? v)) < 0.75)) continue;
          const t = dict.get(PL.PDFName.of('AIPDFLayer'));
          if (t) {
            const s = String(t.asString?.() ?? t.decodeText?.() ?? t).replace(/^\uFEFF/, '');
            if (s) { a.layer = s; patched++; }
          }
          break;
        } catch { /* try the next dict */ }
      }
    }
  }
  return patched;
}

/* ── Geometry helpers ───────────────────────────────────────────────────── */

export function annotCssRect(a) {
  return rectToCss(a.page, a.rect);
}

// Defined once in geometry.js so the resize maths and the annotation factory
// cannot drift; re-exported here because app.js and tools.js import it from
// this module.
export { normalizeRect };

/* ── SVG rendering ──────────────────────────────────────────────────────── */

const BLEND = { highlight: 'multiply', highlighter: 'multiply', strikeout: 'normal', underline: 'normal', squiggly: 'normal' };

/** Sweep a disc of `width` along a flat PDF-space polyline and return the
 *  covered quads. The screen layer, the /QuadPoints list and the baked
 *  appearance stream all draw from this one geometry. */
export function sweptQuads(pts, width) {
  const r = Math.max(0.2, width / 2);
  const out = [];
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const x0 = pts[k], y0 = pts[k + 1], x1 = pts[k + 2], y1 = pts[k + 3];
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const nx = (-dy / len) * r, ny = (dx / len) * r;
    out.push([x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny]);
  }
  if (!out.length) out.push([pts[0] - r, pts[1] - r, pts[0] + r, pts[1] - r, pts[0] + r, pts[1] + r, pts[0] - r, pts[1] + r]);
  return out;
}

function quadCornersCss(page, q) {
  const pts = [];
  for (let k = 0; k < 8; k += 2) pts.push(toCss(page, q[k], q[k + 1]));
  return pts; // 0: UL, 1: UR, 2: LL, 3: LR
}

function textMarkupNode(a, page) {
  const g = svgEl('g');
  const c = rgbToCss(a.color, 1);
  const w = currentScale();
  const quads = (a.quads && a.quads.length) ? a.quads : [rectToQuad(a.rect)];
  for (const q of quads) {
    const p = quadCornersCss(page, q);
    const poly = `${p[0].x},${p[0].y} ${p[1].x},${p[1].y} ${p[3].x},${p[3].y} ${p[2].x},${p[2].y}`;
    if (a.type === 'highlight' || a.type === 'highlighter') {
      g.appendChild(svgEl('polygon', {
        points: poly, fill: c, opacity: a.opacity ?? 0.4,
        style: `mix-blend-mode:${BLEND.highlight}`,
      }));
    } else {
      const h = Math.abs(p[0].y - p[2].y) || 12 * w;
      const sw = Math.max(1, h * (a.type === 'squiggly' ? 0.06 : 0.09));
      if (a.type === 'underline') {
        const y = (p[2].y + p[3].y) / 2 + h * 0.08;
        g.appendChild(svgEl('line', { x1: p[2].x, y1: y, x2: p[3].x, y2: y, stroke: c, 'stroke-width': sw, 'stroke-linecap': 'butt' }));
      } else if (a.type === 'strikeout') {
        const y = (p[0].y + p[2].y) / 2;
        g.appendChild(svgEl('line', { x1: p[0].x, y1: y, x2: p[1].x, y2: y, stroke: c, 'stroke-width': sw }));
      } else {
        // squiggly
        const x1 = p[2].x, x2 = p[3].x;
        const y0 = (p[0].y + p[2].y) / 2;
        const amp = h * 0.12;
        const n = Math.max(4, Math.round(Math.abs(x2 - x1) / Math.max(4, amp * 1.6)));
        let d = `M ${x1} ${y0}`;
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const x = x1 + (x2 - x1) * t;
          const y = y0 + (i % 2 ? -amp : amp);
          d += ` Q ${x1 + (x2 - x1) * (t - 0.5 / n)} ${y} ${x} ${y0}`;
        }
        g.appendChild(svgEl('path', { d, fill: 'none', stroke: c, 'stroke-width': sw }));
      }
    }
  }
  return g;
}

export function rectToQuad(r) {
  return [r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]];
}

/** Velocity-tapered marker. Only `a.widths` holds the taper, and /InkList can
 *  carry coordinate pairs alone, so a reopened stroke has none and draws flat —
 *  the taper survives in the file only inside the baked appearance stream. */
function brushNode(a, page, s) {
  const g = svgEl('g');
  const c = rgbToCss(a.color, 1);
  const hardness = clamp(a.hardness == null ? 1 : a.hardness, 0, 1);
  const base = Math.max(0.4, a.borderWidth || 6) * s;
  for (const path of a.paths || []) {
    const count = path.length >> 1;
    const wid = (k) => clamp((a.widths && a.widths[k] != null ? a.widths[k] : base / s) * s, 0.4, base * 3);
    if (count === 1) {
      const p = toCss(page, path[0], path[1]);
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: Math.max(0.4, wid(0) / 2), fill: c, opacity: a.opacity ?? 1 }));
      continue;
    }
    if (hardness < 1) {
      // Soft edge, approximated as one lighter halo pass under the core: an
      // appearance stream cannot hold a real gaussian falloff.
      let d = '';
      for (let k = 0; k < path.length; k += 2) {
        const p = toCss(page, path[k], path[k + 1]);
        d += (k === 0 ? 'M ' : 'L ') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
      }
      g.appendChild(svgEl('path', {
        d, fill: 'none', stroke: c, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        'stroke-width': base + (1 - hardness) * base * 1.8, opacity: (a.opacity ?? 1) * (1 - hardness) * 0.45,
      }));
    }
    for (let k = 0; k + 1 < count; k++) {
      const p0 = toCss(page, path[k * 2], path[k * 2 + 1]);
      const p1 = toCss(page, path[k * 2 + 2], path[k * 2 + 3]);
      g.appendChild(svgEl('line', {
        x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: c,
        'stroke-width': (wid(k) + wid(k + 1)) / 2, 'stroke-linecap': 'round', opacity: a.opacity ?? 1,
      }));
    }
  }
  return g;
}

function shapeNode(a, page, s) {
  const r = annotCssRect(a);
  const c = rgbToCss(a.color, 1);
  const sw = Math.max(0.6, (a.borderWidth || 1.2) * s * 0.75);
  const dash = a.dash && a.dash.length ? a.dash.map((v) => v * s).join(' ') : null;
  const common = { stroke: c, 'stroke-width': sw, fill: 'none', 'stroke-dasharray': dash };
  if (a.type === 'rect' || a.type === 'roundRect') {
    const fill = a.fill && a.type !== 'redact' ? rgbToCss(a.fill, a.opacity ?? 1) : 'none';
    return svgEl('rect', {
      x: r[0], y: r[1], width: Math.max(1, r[2] - r[0]), height: Math.max(1, r[3] - r[1]),
      rx: a.type === 'roundRect' ? Math.max(1, (a.corner || 8) * s) : 0,
      ...common, fill,
    });
  }
  if (a.type === 'whiteout') {
    return svgEl('rect', { x: r[0], y: r[1], width: Math.max(1, r[2] - r[0]), height: Math.max(1, r[3] - r[1]), fill: '#fff', stroke: 'none' });
  }
  if (a.type === 'redact') {
    return svgEl('rect', {
      class: 'rd', x: r[0], y: r[1], width: Math.max(1, r[2] - r[0]), height: Math.max(1, r[3] - r[1]),
      fill: a.applied ? '#111' : 'rgba(17,17,17,.55)', stroke: a.applied ? 'none' : '#d92d3f',
      'stroke-width': a.applied ? 0 : 1.2, 'stroke-dasharray': a.applied ? null : '4 3',
    });
  }
  if (a.type === 'ellipse') {
    return svgEl('ellipse', {
      cx: (r[0] + r[2]) / 2, cy: (r[1] + r[3]) / 2,
      rx: Math.max(0.5, (r[2] - r[0]) / 2), ry: Math.max(0.5, (r[3] - r[1]) / 2),
      ...common, fill: a.fill ? rgbToCss(a.fill, a.opacity ?? 1) : 'none',
    });
  }
  if (a.type === 'line' || a.type === 'arrow' || a.type === 'measure') {
    const p1 = toCss(page, a.points[0], a.points[1]);
    const p2 = toCss(page, a.points[2], a.points[3]);
    const g = svgEl('g');
    g.appendChild(svgEl('line', { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, ...common }));
    if (a.type === 'arrow') {
      const ang = Math.atan2(p2.y - p1.y, p2.x - p1.x);
      const len = Math.max(7, sw * 5);
      const a1 = ang + Math.PI * 0.82, a2 = ang - Math.PI * 0.82;
      g.appendChild(svgEl('path', {
        d: `M ${p2.x} ${p2.y} L ${p2.x + Math.cos(a1) * len} ${p2.y + Math.sin(a1) * len} M ${p2.x} ${p2.y} L ${p2.x + Math.cos(a2) * len} ${p2.y + Math.sin(a2) * len}`,
        stroke: c, 'stroke-width': sw, fill: 'none', 'stroke-linecap': 'round',
      }));
    }
    if (a.type === 'measure' && a.label) {
      g.appendChild(svgEl('text', {
        x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 - 4, fill: c,
        'font-size': Math.max(8, 10), 'text-anchor': 'middle',
        style: 'paint-order:stroke;stroke:#fff;stroke-width:3px',
      }, [document.createTextNode(a.label)]));
    }
    return g;
  }
  if (a.type === 'ink') {
    const g = svgEl('g');
    for (const path of a.paths || []) {
      let d = '';
      for (let k = 0; k < path.length; k += 2) {
        const p = toCss(page, path[k], path[k + 1]);
        d += (k === 0 ? 'M ' : 'L ') + p.x.toFixed(1) + ' ' + p.y.toFixed(1) + ' ';
      }
      g.appendChild(svgEl('path', { d, fill: 'none', stroke: c, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    }
    return g;
  }
  return svgEl('g');
}

function freeTextNode(a, page, s) {
  const r = annotCssRect(a);
  const g = svgEl('g');
  const w = Math.max(2, r[2] - r[0]), h = Math.max(2, r[3] - r[1]);
  // Mirrors pdfwrite: a null fill is transparent. It used to fake a white card
  // here, which is why a "None" option could not have been honest.
  const bg = a.fill ? rgbToCss(a.fill, 1) : 'none';
  const stroke = a.borderWidth === 0 ? null : rgbToCss(a.color, 1);
  if (a.type === 'callout') {
    // leader line from anchor to box
    const anchor = a.leader ? toCss(page, a.leader[0], a.leader[1]) : { x: r[0] - 26, y: r[1] - 26 };
    g.appendChild(svgEl('line', { x1: anchor.x, y1: anchor.y, x2: r[0] + w / 2, y2: r[1] + h / 2, stroke: rgbToCss(a.color, 1), 'stroke-width': 1.2 }));
    g.appendChild(svgEl('circle', { cx: anchor.x, cy: anchor.y, r: 3, fill: rgbToCss(a.color, 1) }));
    g.appendChild(svgEl('rect', { x: r[0], y: r[1], width: w, height: h, rx: 4, fill: bg, stroke: stroke || 'none', 'stroke-width': 1.2 }));
  } else if (a.borderWidth !== 0 || a.fill) {
    g.appendChild(svgEl('rect', { x: r[0], y: r[1], width: w, height: h, rx: 2, fill: bg, stroke: stroke || 'none', 'stroke-width': 1.1 }));
  }
  const fo = svgEl('foreignObject', { x: r[0], y: r[1], width: w, height: h });
  const div = document.createElementNS(XHTMLNS, 'div');
  const fs = (a.fontSize || 11) * s;
  div.setAttribute('xmlns', XHTMLNS);
  div.style.cssText = `width:100%;height:100%;margin:0;padding:${Math.max(1, 2 * s)}px ${Math.max(2, 3 * s)}px;` +
    `font-family:${a.fontFamily || 'Helvetica'},Arial,sans-serif;font-size:${fs}px;` +
    // A box produced by the Direct Editor carries its own leading: without it a
    // block edited at 1.8 spacing would preview at 1.28 and jump on save.
    `line-height:${a.lineHeight ? (a.lineHeight * s) + 'px' : (1.28 * fs) + 'px'};` +
    `white-space:pre-wrap;word-break:break-word;overflow:hidden;box-sizing:border-box;` +
    `color:${rgbToCss(a.textColor || [0.08, 0.09, 0.12], 1)};text-align:${a.align || 'left'};` +
    // Bold / italic are part of Foxit's Typewriter style and now round-trip.
    (a.bold ? 'font-weight:700;' : '') + (a.italic ? 'font-style:italic;' : '') +
    // Character spacing, horizontal scaling and underline come from Acrobat's
    // Format list. A PDF box cannot carry them in /DA, but the screen must
    // still show what the user asked for while the document is open.
    (a.charSpacing ? `letter-spacing:${a.charSpacing * s}px;` : '') +
    (a.underline ? 'text-decoration:underline;' : '') +
    (a.hScale && a.hScale !== 100 ? `transform-origin:0 0;transform:scaleX(${a.hScale / 100});` : '') +
    (a.align === 'justify' ? 'text-align-last:left;' : '');
  div.textContent = a.text || '';
  fo.appendChild(div);
  g.appendChild(fo);
  return g;
}

function stampNode(a, page, s) {
  const r = annotCssRect(a);
  const g = svgEl('g');
  const w = Math.max(2, r[2] - r[0]), h = Math.max(2, r[3] - r[1]);
  if (a.image) {
    g.appendChild(svgEl('image', { x: r[0], y: r[1], width: w, height: h, href: a.image, preserveAspectRatio: 'xMidYMid meet' }));
  } else {
    const c = rgbToCss(a.color, 1);
    g.appendChild(svgEl('rect', {
      x: r[0], y: r[1], width: w, height: h, rx: 3,
      fill: rgbToCss(a.color, 0.14), stroke: c, 'stroke-width': Math.max(1, 2 * s * 0.6),
    }));
    const fs = clamp((a.fontSize || 14) * s, 7, 120);
    g.appendChild(svgEl('text', {
      x: r[0] + w / 2, y: r[1] + h / 2 + fs * 0.35, fill: c, 'font-size': fs,
      'text-anchor': 'middle', 'font-weight': '700', 'font-family': 'Helvetica,Arial,sans-serif',
      style: 'letter-spacing:.5px',
    }, [document.createTextNode(a.stampLabel || a.text || 'STAMP')]));
  }
  return g;
}

function noteNode(a, page, s) {
  const r = annotCssRect(a);
  const c = rgbToCss(a.color, 1);
  const size = Math.max(16, Math.min(22, 20));
  const x = r[0], y = r[1];
  const g = svgEl('g');
  g.appendChild(svgEl('path', {
    d: `M ${x} ${y} h ${size} v ${size * 0.95} l ${-size * 0.34} ${-size * 0.34} h ${-size * 0.66} z`,
    fill: c, stroke: 'rgba(0,0,0,.28)', 'stroke-width': 0.8,
  }));
  g.appendChild(svgEl('path', {
    d: `M ${x + size * 0.2} ${y + size * 0.22} h ${size * 0.6} M ${x + size * 0.2} ${y + size * 0.42} h ${size * 0.6} M ${x + size * 0.2} ${y + size * 0.62} h ${size * 0.36}`,
    stroke: readableOn(a.color), 'stroke-width': 1.3, fill: 'none', 'stroke-linecap': 'round',
  }));
  return g;
}

/* ── Polygon / polyline / cloud / area-highlight / caret / link ───────────── */

/** Flat point list → CSS points. */
function polyPoints(pts, page) {
  const out = [];
  for (let k = 0; k + 1 < pts.length; k += 2) out.push(toCss(page, pts[k], pts[k + 1]));
  return out;
}

/** Foxit-style cloud: alternating arcs along the outline. */
function cloudPathStr(pts, closed) {
  const list = pts.slice();
  if (closed && pts.length > 2) list.push(pts[0]);
  if (list.length < 2) return '';
  let d = `M ${list[0].x.toFixed(1)} ${list[0].y.toFixed(1)}`;
  for (let k = 1; k < list.length; k++) {
    const a = list[k - 1], b = list[k];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const amp = Math.min(len * 0.17, 7);
    const s = (k % 2 === 0 ? 1 : -1);
    d += ` Q ${(mx - (dy / len) * amp * s).toFixed(1)} ${(my + (dx / len) * amp * s).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  }
  return d;
}

function polyNode(a, page, s) {
  const g = svgEl('g');
  const c = rgbToCss(a.color, 1);
  const sw = Math.max(0.6, (a.borderWidth || 1.2) * s * 0.75);
  const pts = polyPoints(a.points || [], page);
  if (!pts.length) return g;
  const closed = a.type === 'polygon' || a.type === 'cloud' || a.type === 'measureArea';
  const attr = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

  if (a.type === 'areaHighlight') {
    // Covers the enclosed region with a translucent wash (multiply), the way
    // Foxit's Area Highlight paints over text.
    g.appendChild(svgEl('polygon', { points: attr, fill: c, opacity: a.opacity ?? 0.4, style: 'mix-blend-mode:multiply' }));
    return g;
  }
  if (a.type === 'cloud') {
    g.appendChild(svgEl('path', { d: cloudPathStr(pts, closed), fill: 'none', stroke: c, 'stroke-width': sw, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return g;
  }
  if (a.fill) {
    g.appendChild(svgEl('polygon', { points: attr, fill: rgbToCss(a.fill, a.opacity ?? 1), stroke: 'none' }));
  }
  g.appendChild(svgEl(closed ? 'polygon' : 'polyline', {
    points: attr, fill: 'none', stroke: c, 'stroke-width': sw,
    'stroke-dasharray': a.dash && a.dash.length ? a.dash.map((v) => v * s).join(' ') : null,
    'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  if (a.type === 'measureArea' && a.label) {
    const cx = pts.reduce((t, p) => t + p.x, 0) / pts.length;
    const cy = pts.reduce((t, p) => t + p.y, 0) / pts.length;
    const w = Math.max(70, String(a.label).length * 6);
    g.appendChild(svgEl('rect', { x: cx - w / 2, y: cy - 9, width: w, height: 18, rx: 4, fill: 'rgba(255,255,255,.92)', stroke: c, 'stroke-width': 1 }));
    g.appendChild(svgEl('text', {
      x: cx, y: cy + 4, fill: c, 'font-size': 11, 'text-anchor': 'middle',
      style: 'paint-order:stroke;stroke:#fff;stroke-width:3px',
    }, [document.createTextNode(a.label)]));
  }
  return g;
}

function caretNode(a, page, s) {
  const r = annotCssRect(a);
  const c = rgbToCss(a.color, 1);
  const h = Math.max(8, r[3] - r[1]);
  const g = svgEl('g');
  // A caret tick plus underline — the conventional "insert text here" markup.
  g.appendChild(svgEl('path', {
    d: `M ${r[0]} ${r[3]} L ${r[0] + h * 0.34} ${r[1]} L ${r[0] + h * 0.68} ${r[3]}`,
    stroke: c, 'stroke-width': Math.max(1, 1.4), fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  }));
  g.appendChild(svgEl('line', { x1: r[0], y1: r[3] + 2, x2: r[2], y2: r[3] + 2, stroke: c, 'stroke-width': 1, opacity: 0.7 }));
  return g;
}

function linkNode(a, page, s) {
  const r = annotCssRect(a);
  return svgEl('rect', {
    x: r[0], y: r[1], width: Math.max(2, r[2] - r[0]), height: Math.max(2, r[3] - r[1]),
    fill: 'rgba(59,91,253,.08)', stroke: 'var(--accent)', 'stroke-width': 1.2, 'stroke-dasharray': '4 3',
  });
}

export function annotNode(a, page, s) {
  switch (a.type) {
    case 'highlight': case 'highlighter': case 'underline': case 'strikeout': case 'squiggly':
      return textMarkupNode(a, page);
    case 'brush':
      return brushNode(a, page, s);
    case 'textbox': case 'callout':
      return freeTextNode(a, page, s);
    case 'stamp': case 'signature': case 'image':
      return stampNode(a, page, s);
    case 'note':
      return noteNode(a, page, s);
    case 'polygon': case 'polyline': case 'cloud': case 'areaHighlight': case 'measureArea':
      return polyNode(a, page, s);
    case 'caret':
      return caretNode(a, page, s);
    case 'link':
      return linkNode(a, page, s);
    default:
      return shapeNode(a, page, s);
  }
}

/* ── Overset badge + frame flow (story model UI) ─────────────────────────
 *
 * Overset is a first-class result of the layout model, not something the UI
 * infers from a viewer clipping text out of view. When a story needs more room
 * than its frames give, the remainder is reported here — the text is never
 * discarded from the model.
 */

let measureCtx = null;
function canvasMeasure(family, size) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${size}px ${family || 'Helvetica'}, Helvetica, Arial, sans-serif`;
  return (t) => measureCtx.measureText(String(t)).width;
}

function svgText(x, y, text, size = 10, fill = '#fff') {
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', x);
  t.setAttribute('y', y);
  t.setAttribute('font-size', String(size));
  t.setAttribute('font-family', 'system-ui, sans-serif');
  t.setAttribute('fill', fill);
  t.textContent = text;
  return t;
}

/** A small "overset" chip: the story needs more room than its frames give. */
function oversetBadge(x, y, label = 'overset') {
  const g = svgEl('g', { class: 'overset-badge', 'pointer-events': 'none' });
  const w = 8 + label.length * 6;
  g.appendChild(svgEl('rect', { x, y, width: w, height: 15, rx: 3, fill: '#d92d3f', opacity: 0.92 }));
  g.appendChild(svgText(x + 5, y + 11, label, 10));
  return g;
}

/* ── Page annotation layer ──────────────────────────────────────────────── */

export function renderPageAnnotations(i) {
  const rec = pageEl(i);
  const d = activeDoc();
  if (!rec || !d || !rec.svg) return;
  const svg = rec.svg;
  svg.innerHTML = '';
  const s = currentScale();
  const list = d.annots.filter((a) => a.page === i);
  for (const a of list) {
    // Content on a hidden layer is not drawn — and therefore not pickable —
    // exactly like the page content pdf.js already hides through the
    // optional-content config.
    if (a.layer && !layerVisible(d, a.layer)) continue;
    const g = svgEl('g', { class: 'ann', 'data-id': a.id });
    g.appendChild(annotNode(a, i, s));
    // Invisible fat stroke for easier hit-testing of thin geometry.
    const r = annotCssRect(a);
    g.appendChild(svgEl('rect', {
      class: 'ann-hit', x: r[0] - 3, y: r[1] - 3,
      width: Math.max(6, r[2] - r[0] + 6), height: Math.max(6, r[3] - r[1] + 6),
    }));
    if (state.selection.includes(a.id)) drawSelectionDecor(g, a, i, s);
    svg.appendChild(g);
  }

  // Pending in-place text edits: show the result immediately.
  // Object-owned model: the writer REMOVES the owned source operators and draws
  // the replacement as ordinary page text, so on screen the edit is an overlay
  // on the still-untouched source render. The wash below is the writer's cover
  // FALLBACK made visible — it is only painted while removal is still unknown
  // (before the first save) or when removal genuinely failed (a scan whose
  // glyphs are pixels, text inside a shared Form XObject). Once a save has
  // recorded `e.removal === 'excise'` the original is gone from the file, so the
  // wash would only be a spurious opaque patch over the page's own background.
  for (const e of d.textEdits || []) {
    if (e.page !== i) continue;
    // A Direct Editor commit owns a real text box annotation on screen — the box
    // draws the replacement text, so all this renders is the wash that hides the
    // ORIGINAL run underneath. It goes in first so it paints *below* the
    // annotation it belongs to; appended like the other edits it would cover its
    // own box. The saved file removes the original rather than hiding it, and
    // omits the paired box from the file (the text lives in the page content).
    if (e.boxId && d.annots.some((a) => a.id === e.boxId)) {
      const box = d.annots.find((a) => a.id === e.boxId);
      if (e.bg && e.removal !== 'excise') {
        const cg = svgEl('g', { class: 'textedit textedit-cover', 'data-eid': e.id });
        for (const w of [e.coverRect, ...(e.priorBoxes || [])]) {
          if (!w) continue;
          const b = (() => {
            const c = [toCss(i, w[0], w[1]), toCss(i, w[2], w[3])];
            return [Math.min(c[0].x, c[1].x), Math.min(c[0].y, c[1].y), Math.max(c[0].x, c[1].x), Math.max(c[0].y, c[1].y)];
          })();
          cg.appendChild(svgEl('rect', {
            x: b[0], y: b[1], width: Math.max(1, b[2] - b[0]), height: Math.max(1, b[3] - b[1]),
            fill: rgbToCss(e.bg, 1), stroke: 'none',
          }));
        }
        svg.insertBefore(cg, svg.firstChild);
      }
      // Overset marker: the frame cannot hold the whole story. Shown on the box
      // rather than left for the user to discover in the saved file.
      if (e.overset) {
        const r = annotCssRect({ rect: box.rect });
        const bg = svgEl('g', { class: 'textedit textedit-overset', 'data-eid': e.id });
        bg.appendChild(oversetBadge(r[2] - 60, r[1] - 20, `+${e.overset.lines} line${e.overset.lines === 1 ? '' : 's'}`));
        svg.appendChild(bg);
      }
      continue;
    }

    /* Threaded story: composed into an ordered chain of frames, possibly on
       several pages. Each frame is outlined, its placements drawn, and a flow
       arrow marks where the text continues — the frames are never merged into
       one rectangle. */
    if (Array.isArray(e.frames) && e.frames.length > 1) {
      const story = storyFromEdit(e);
      const layout = layoutStory(story, canvasMeasure(e.fontFamily, e.size || 11));
      const g = svgEl('g', { class: 'textedit textedit-story', 'data-eid': e.id });
      const fs = (e.size || 11) * s;
      const leading = (e.lineHeight || (e.size || 11) * 1.2) * s;
      for (const pl of layout.placements) {
        if (pl.page !== i) continue;
        const a2 = toCss(i, pl.rect[0], pl.rect[1]);
        const b2 = toCss(i, pl.rect[2], pl.rect[3]);
        const fb = [Math.min(a2.x, b2.x), Math.min(a2.y, b2.y), Math.max(a2.x, b2.x), Math.max(a2.y, b2.y)];
        g.appendChild(svgEl('rect', {
          class: 'story-frame', x: fb[0], y: fb[1], width: Math.max(1, fb[2] - fb[0]), height: Math.max(1, fb[3] - fb[1]),
          fill: 'none', stroke: '#3b5bfd', 'stroke-width': 1, 'stroke-dasharray': '4 3',
          // `all` (not `auto`): a threaded story carries no text box, so this
          // outline is the only thing the user can click to re-open its panel.
          // The rect has no fill, so `visiblePainted` would leave a hole in the
          // middle — `all` makes the whole frame a hit target.
          'pointer-events': 'all',
        }));
        const fo = svgEl('foreignObject', { x: fb[0], y: fb[1], width: Math.max(1, fb[2] - fb[0]), height: Math.max(1, fb[3] - fb[1]), overflow: 'visible' });
        const div = document.createElementNS(XHTMLNS, 'div');
        div.setAttribute('xmlns', XHTMLNS);
        div.style.cssText = `width:100%;height:100%;margin:0;padding:0;overflow:visible;white-space:pre;`
          + `font-family:${e.fontFamily || 'Helvetica'},Helvetica,Arial,sans-serif;font-size:${fs}px;line-height:${leading}px;`
          + `color:${rgbToCss(e.color || [0, 0, 0], 1)};`;
        div.textContent = pl.lines.map((l) => l.text).join('\n');
        fo.appendChild(div);
        g.appendChild(fo);
      }
      // Flow arrows: where each non-final frame continues.
      layout.placements.forEach((pl, k) => {
        if (pl.page !== i) return;
        const next = layout.placements[k + 1];
        if (!next) return;
        const a3 = toCss(i, pl.rect[2], pl.rect[1]);
        const label = next.page === pl.page ? 'continues ↓' : `→ page ${next.page + 1}`;
        const w = 10 + label.length * 5.4;
        g.appendChild(svgEl('rect', { x: a3.x - w, y: a3.y - 17, width: w, height: 14, rx: 3, fill: '#3b5bfd', opacity: 0.9, 'pointer-events': 'none' }));
        g.appendChild(svgText(a3.x - w + 4, a3.y - 6, label, 9));
      });
      if (e.overset) {
        const first = layout.placements.find((pl) => pl.page === i) || layout.placements[0];
        if (first) {
          const c = toCss(i, first.rect[0], first.rect[3]);
          g.appendChild(oversetBadge(c.x, c.y - 20, `overset +${e.overset.lines}`));
        }
      }
      svg.appendChild(g);
      continue;
    }
    const block = !!e.itemIndices?.length;
    const washes = textEditWashes(e);
    const paint = (r) => {
      const c = [toCss(i, r[0], r[1]), toCss(i, r[2], r[3])];
      return [Math.min(c[0].x, c[1].x), Math.min(c[0].y, c[1].y), Math.max(c[0].x, c[1].x), Math.max(c[0].y, c[1].y)];
    };
    const g = svgEl('g', { class: 'textedit', 'data-eid': e.id });
    // e.bg paints every wash; additive agent text (bg:null) renders over the
    // page untouched.
    if (e.bg) {
      for (const w of washes.length ? washes : [e.coverRect || e.rect]) {
        if (!w) continue;
        const b = paint(w);
        g.appendChild(svgEl('rect', {
          x: b[0], y: b[1], width: Math.max(1, b[2] - b[0]), height: Math.max(1, b[3] - b[1]),
          fill: rgbToCss(e.bg, 1), stroke: 'none',
        }));
      }
    }
    const drawn = (block ? textEditDrawBox(e) : null) || e.coverRect || e.rect;
    const anchor = block ? toCss(i, e.baseline[0], e.baseline[1]) : null;
    const fs = (e.size || 11) * s;
    const top = block ? anchor.y - fs * .85 : paint(drawn)[1];
    const fontFamily = e.fontFamily || 'Helvetica';
    const wCss = block ? Math.max(1, (e.maxWidth || 100) * s) : Math.max(1, paint(drawn)[2] - paint(drawn)[0]);
    const hCss = block ? Math.max(1, (e.maxHeight || 20) * s) : Math.max(1, paint(drawn)[3] - paint(drawn)[1]);
    const fx = block ? anchor.x : paint(drawn)[0];
    const fo = svgEl('foreignObject', { x: fx, y: top,
      width: wCss, height: hCss, overflow: 'visible' });
    const div = document.createElementNS(XHTMLNS, 'div');
    div.setAttribute('xmlns', XHTMLNS);
    // A block is left to wrap itself rather than being pre-wrapped: justified
    // text can only justify when the browser does the line breaking, so
    // pre-splitting the lines (the old approach) made `justify` a no-op.
    const scaleX = (e.hScale && e.hScale !== 100) ? ` scaleX(${e.hScale / 100})` : '';
    div.style.cssText = `width:100%;height:100%;margin:0;padding:0;` +
      `font-family:${fontFamily},Helvetica,Arial,sans-serif;font-size:${fs}px;` +
      `line-height:${block ? ((e.lineHeight || (e.size || 11) * 1.2) * s) + 'px' : '1.15'};` +
      `white-space:${block ? 'pre-wrap' : 'pre'};overflow-wrap:break-word;overflow:visible;` +
      `color:${rgbToCss(e.color || [0, 0, 0], 1)};` +
      (block && e.align ? `text-align:${e.align};` : '') +
      (block && e.charSpacing ? `letter-spacing:${e.charSpacing * s}px;` : '') +
      (block && e.bold ? 'font-weight:700;' : '') +
      (block && e.italic ? 'font-style:italic;' : '') +
      (block && e.underline ? 'text-decoration:underline;' : '') +
      `transform-origin:0 0;transform:rotate(${-(e.angle || 0)}deg)${scaleX};`;
    div.textContent = e.text || '';
    fo.appendChild(div);
    g.appendChild(fo);
    // Fat invisible hit target over the text box, so the Select tool can grab
    // a moved block; plus the standard selection outline when selected.
    g.appendChild(svgEl('rect', {
      class: 'ann-hit', x: fx - 3, y: top - 3,
      width: Math.max(6, wCss + 6), height: Math.max(6, hCss + 6),
    }));
    if (state.selection.includes(e.id)) {
      const selPdf = (block ? textEditDrawBox(e) : null) || e.rect;
      if (selPdf) drawSelectionDecor(g, { page: i, rect: selPdf }, i, s, false);
    }
    svg.appendChild(g);
  }

  renderStampPreviews(svg, i, s);
}

function drawSelectionDecor(g, a, i, s, handles = true) {
  const r = annotCssRect(a);
  g.appendChild(svgEl('rect', { class: 'selbox', x: r[0] - 2, y: r[1] - 2, width: r[2] - r[0] + 4, height: r[3] - r[1] + 4 }));
  if (!handles) return;   // text blocks move but do not resize via handles
  const pts = [
    [r[0], r[1]], [(r[0] + r[2]) / 2, r[1]], [r[2], r[1]],
    [r[2], (r[1] + r[3]) / 2], [r[2], r[3]], [(r[0] + r[2]) / 2, r[3]],
    [r[0], r[3]], [r[0], (r[1] + r[3]) / 2],
  ];
  pts.forEach(([x, y], k) => {
    // Cursor comes from the same index table the resize maths uses, so hovering
    // the right edge cannot offer a vertical drag.
    g.appendChild(svgEl('rect', {
      class: 'handle', style: `cursor:${HANDLE_CURSORS[k]}`, x: x - 3.5, y: y - 3.5, width: 7, height: 7, rx: 1, 'data-h': String(k),
    }));
  });
}

export function renderAllAnnotations() {
  const d = activeDoc();
  if (!d) return;
  for (let i = 0; i < d.numPages; i++) renderPageAnnotations(i);
}

/* ── Factory for new annotations ────────────────────────────────────────── */

export function makeAnnot(type, page, rect, extra = {}) {
  const now = new Date();
  const base = {
    id: uid('an'),
    type,
    page,
    rect: normalizeRect(rect),
    color: state.colorRgb || [1, 0.85, 0.2],
    opacity: (type === 'highlight' || type === 'highlighter') ? (state.opacity ?? 0.4) : 1,
    text: '',
    author: settings.author || 'User',
    date: now.toISOString(),
    created: now.toISOString(),
    // Land on the layer the user has active in the Layers panel (null =
    // un-layered base content). extra.layer overrides for pastes and copies.
    layer: activeLayerName() || null,
    borderWidth: type === 'rect' || type === 'ellipse' || type === 'line' || type === 'arrow' ? 1.5 : 0,
    fromFile: false,
    // Text Box / Callout: carry the Typewriter text properties so a new box
    // uses what the user picked in the properties panel instead of silently
    // falling back to Helvetica / 11pt / near-black / left on every creation.
    ...(type === 'textbox' || type === 'callout' ? {
      fontFamily: settings.textFont || 'Helvetica',
      fontSize: settings.textSize || 11,
      textColor: hexToRgb(settings.textColor || '#14171f'),
      align: settings.textAlign || 'left',
      bold: !!settings.textBold,
      italic: !!settings.textItalic,
    } : {}),
    flags: 4, // print
  };
  return { ...base, ...extra };
}
