import * as PL from '/v/pdf-lib.js';
import { pdfjs, renderPageToCanvas } from './viewer.js';
import { pdfDate, clamp } from './util.js';
import { ANNOT_TYPES, INK_INTENTS, annotationState } from './annots.js';
import { getCustomFont, getFontkit } from './fonts.js';
import { wrapBlockText, blocksFromOcrLines, textEditWashes } from './textblocks.js';
import { exciseText } from './textops.js';
import { walkVectorPaths } from './tables.js';
import { storyFromEdit, layoutStory, fitCount, normRect } from './story.js';

const {
  PDFDocument, StandardFonts, PDFName, PDFNumber, PDFString, PDFHexString,
  PDFRawStream, PDFArray, PDFDict, PDFObjectCopier, PDFBool, degrees, rgb,
} = PL;

const pdfRgb = (c) => rgb(clamp(c[0], 0, 1), clamp(c[1], 0, 1), clamp(c[2], 0, 1));

/* ── Font resolution ────────────────────────────────────────────────────── */

const FONT_MAP = [
  [/times|serif/i, [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic]],
  [/courier|mono|console/i, [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique]],
  [/symbol/i, [StandardFonts.Symbol, StandardFonts.Symbol, StandardFonts.Symbol, StandardFonts.Symbol]],
  [/zapf|dingbat/i, [StandardFonts.ZapfDingbats, StandardFonts.ZapfDingbats, StandardFonts.ZapfDingbats, StandardFonts.ZapfDingbats]],
  [/.*/, [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique]],
];

const fontCache = new Map();

export async function baseFont(doc, family = 'Helvetica') {
  // Custom fonts (an embedded font reused from this document, or a user
  // supplied TTF) are embedded via fontkit so any Unicode text works.
  const custom = getCustomFont(family);
  if (custom) {
    const key = 'custom:' + custom.name;
    const cached = fontCache.get(key);
    if (cached && cached.doc === doc) return cached.font;
    try {
      if (!doc.__fontkitRegistered) {
        doc.registerFontkit(await getFontkit());
        doc.__fontkitRegistered = true;
      }
      const font = await embedCustomFont(doc, custom);
      fontCache.set(key, { doc, font });
      return font;
    } catch (e) {
      // Recorded, not just logged: falling back to Standard-14 is a fidelity
      // loss the user has to hear about, because Standard-14 is WinAnsi-only
      // and silently writes 0x3F for every character outside it. See
      // fontSubstitutions(), consumed by the save report.
      fontSubstitutions.push({ family: custom.name, to: 'Standard-14', reason: String(e?.message || e) });
      console.warn('custom font embed failed, falling back to standard:', custom.name, e);
    }
  }

  const bold = /bold|black|heavy|semibold/i.test(family);
  const italic = /italic|oblique/i.test(family);
  const variant = bold && italic ? 3 : bold ? 1 : italic ? 2 : 0;
  const [, set] = FONT_MAP.find(([re]) => re.test(family || ''));
  const key = set[variant];
  if (fontCache.has(key)) {
    const cached = fontCache.get(key);
    if (cached.doc === doc) return cached.font;
  }
  const font = await doc.embedFont(key);
  fontCache.set(key, { doc, font });
  return font;
}

/** Embed a font program.
 *
 *  `subset: false` is not a preference, it is the only thing that works here.
 *  The self-contained fontkit build this renderer can load (1.1.1 UMD) has a
 *  subsetter exposing `_addGlyph` but not the `includeGlyph` that
 *  @cantoo/pdf-lib's CustomFontSubsetEmbedder calls, so `{ subset: true }`
 *  throws for every font. That throw used to be caught and swallowed into a
 *  Standard-14 fallback — which is WinAnsi-only, so non-Latin text became
 *  literal "?" bytes in the saved file.
 *
 *  The cost is size: a full Arial embeds at ~583 KB where a subset would be
 *  ~12 KB. Correctness first; subsetting via a main-process fontkit is the
 *  follow-up (spec §12).
 */
async function embedCustomFont(doc, custom) {
  try {
    return await doc.embedFont(custom.bytes, { subset: false });
  } catch (e) {
    fontSubstitutions.push({ family: custom.name, to: 'none', reason: 'could not embed: ' + String(e?.message || e) });
    throw e;
  }
}

/** Fonts this save had to replace, and why. Drained by buildPdf so the report
 *  describes what actually landed in the file rather than what was asked for. */
const fontSubstitutions = [];
export function drainFontSubstitutions() {
  const out = fontSubstitutions.splice(0, fontSubstitutions.length);
  return out;
}

/* The model keeps a base family ('Helvetica' | 'Times' | 'Courier') plus
 * separate bold/italic flags, but pdf-lib's StandardFonts are named per
 * variant ('Helvetica-BoldOblique' …). Fold the two into the single name pdf.js
 * reads back from /DA on reopen — without this a bold text box silently
 * reopened as regular weight. Custom / symbol / dingbat families are embedded
 * as-is (their variant names do not exist). */
function fontVariant(family = 'Helvetica', bold = false, italic = false) {
  const f = String(family || '');
  const isTimes = /times|serif/i.test(f);
  const isCourier = /courier|mono|console/i.test(f);
  const isStandard = isTimes || isCourier || /helvetica|arial|sans/i.test(f);
  if (!isStandard) return family;            // custom / Symbol / ZapfDingbats
  const base = isTimes ? 'Times' : isCourier ? 'Courier' : 'Helvetica';
  const b = bold ? '-Bold' : '';
  const i = italic ? '-Oblique' : '';
  return `${base}${b}${i}`;
}

/* ── Low-level helpers ──────────────────────────────────────────────────── */

function obj(doc, v) { return doc.context.obj(v); }

function setAnnots(doc, page, refs) {
  if (!refs.length) {
    if (page.node.has(PDFName.of('Annots'))) page.node.delete(PDFName.of('Annots'));
    return;
  }
  page.node.set(PDFName.of('Annots'), obj(doc, refs));
}

/** Annotation subtypes our own model owns and re-creates from `doc.annots`.
 *  Originals of these must NOT be preserved verbatim, or we would duplicate
 *  them (or resurrect ones the user deleted). */
const MANAGED_SUBTYPES = new Set([
  'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Text', 'FreeText',
  'Stamp', 'Square', 'Circle', 'Line', 'Ink', 'Redact',
  'Polygon', 'PolyLine', 'Caret',
]);

/** Annotations the app wrote itself carry /NM "aipdf:…" so a later save can
 *  recognise and replace them instead of preserving the old copy alongside the
 *  new one. (Links are not model-managed, so without this they would duplicate
 *  on every re-save.) */
const OWNED_NM = /^aipdf:/;

function annotName(annot) {
  return `aipdf:${annot.type}:${annot.id}`;
}

/** Refs of the interactive form-widget annotations already on a page — keep
 *  these untouched so existing form fields survive a save. */
function widgetRefs(doc, page) {
  const annots = page.node.Annots();
  if (!annots || typeof annots.asArray !== 'function') return [];
  const out = [];
  for (const ref of annots.asArray()) {
    try {
      const d = doc.context.lookup(ref);
      const sub = d && d.get && d.get(PDFName.of('Subtype'));
      const subName = sub && (sub.asName?.() || (sub.asString && sub.asString()?.replace(/^\//, '')));
      if (subName === 'Widget') out.push(ref);
    } catch { /* skip unreadable ref */ }
  }
  return out;
}

function originalAnnotationIndex(source, entries, src) {
  const refs = src.getPage(source.page).node.Annots()?.asArray() || [];
  const idRef = /^(\d+)R(\d*)$/.exec(source.origId || '');
  const refText = source.origRef ? `${source.origRef.num} ${source.origRef.gen || 0} R` :
    idRef ? `${idRef[1]} ${idRef[2] || 0} R` : null;
  if (refText) return refs.findIndex((ref) => String(ref) === refText);
  return entries.findIndex((entry) => entry.id === source.origId && entry.subtype === source.origSubtype);
}

/** Invoke a form XObject before the existing, flat /Contents array. */
function prependContent(doc, page, ref) {
  const key = page.node.newXObject('Stamp', ref);
  const stream = doc.context.register(doc.context.flateStream(`q ${key} Do Q`));
  const cur = page.node.Contents();
  page.node.set(PDFName.of('Contents'), obj(doc, [stream, ...(cur instanceof PDFArray ? cur.asArray() : cur ? [cur] : [])]));
}

/** Append a `q <XObject> Do Q` stream AFTER the page's existing content, so
 *  what it draws lands on top of the page instead of under it. */
function appendContent(doc, page, ref) {
  const key = page.node.newXObject('DE', ref);
  const stream = doc.context.register(doc.context.flateStream(`q ${key} Do Q`));
  const cur = page.node.Contents();
  page.node.set(PDFName.of('Contents'), obj(doc, [...(cur instanceof PDFArray ? cur.asArray() : cur ? [cur] : []), stream]));
}

/** Append raw operators straight into the PAGE's content stream (font resources
 *  are already registered by the caller). Deliberately NOT a Form XObject: a
 *  form shared by several pages would make the replacement un-re-editable —
 *  later edits cover previous replacements by position, and a form hides the
 *  text from that walk. */
function appendPageOps(doc, page, body) {
  const stream = doc.context.register(doc.context.flateStream(body));
  const cur = page.node.Contents();
  page.node.set(PDFName.of('Contents'), obj(doc, [...(cur instanceof PDFArray ? cur.asArray() : cur ? [cur] : []), stream]));
}

function makeFormXObject(doc, content, bbox, resources) {
  const dict = obj(doc, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: bbox,
    Resources: resources || {},
  });
  const stream = PDFRawStream.of(dict, new TextEncoder().encode(content));
  return doc.context.register(stream);
}

/* ── Optional-content layers ──────────────────────────────────────────────
   doc.layers (see layers.js) is written into the saved file as real OCGs.
   Content assigned to a layer is wrapped in /OC marked-content:
     - annotation appearance streams get the wrapper inside their own form
       XObject, with a /Properties entry mapping the name to the OCG ref;
     - Direct Editor page content is wrapped inline, with the page's
       /Resources /Properties gaining the same entry.
   Empty doc.layers ⇒ every helper is a no-op, so documents without layers
   save exactly as before. */

/** The dict's /Name as a JS string, or '' — pdf-lib string types vary. */
function ocgName(d) {
  try {
    const t = d.get(PDFName.of('Name'));
    if (!t) return '';
    const s = t.asString?.() ?? t.decodeText?.() ?? String(t);
    return String(s).replace(/^\uFEFF/, '');
  } catch { return ''; }
}

/** Map layer name → OCG ref for every OCG the target already carries: from
 *  the catalog's OCProperties, plus the /Properties dicts of the pages
 *  (copied pages reference copied OCG dicts the catalog does not list). */
function collectOcgRefs(target, pages) {
  const map = new Map();
  const consider = (ref, d) => {
    if (!d || !(d instanceof PDFDict)) return;
    if (d.get(PDFName.of('Type'))?.toString() !== '/OCG') return;
    const nm = ocgName(d);
    if (nm && !map.has(nm)) map.set(nm, ref);
  };
  try {
    const ocp = target.context.lookup(target.catalog.get(PDFName.of('OCProperties')));
    const ocgs = ocp instanceof PDFDict ? target.context.lookup(ocp.get(PDFName.of('OCGs'))) : null;
    if (ocgs instanceof PDFArray) for (const ref of ocgs.asArray()) consider(ref, target.context.lookup(ref));
  } catch { /* no catalog layers */ }
  for (const p of pages || []) {
    try {
      const res = target.context.lookup(p.node.get(PDFName.of('Resources')));
      const props = res instanceof PDFDict ? target.context.lookup(res.get(PDFName.of('Properties'))) : null;
      if (!(props instanceof PDFDict)) continue;
      for (const [, v] of props.entries()) consider(v, target.context.lookup(v));
    } catch { /* page without resources */ }
  }
  return map;
}

/** Resolve (creating where needed) an OCG ref for every model layer.
 *  propByName fixes the property name each layer is referenced by — layer
 *  names may contain characters that are not legal in a PDF name. */
function ensureLayerRefs(target, doc, pages) {
  const refByName = collectOcgRefs(target, pages);
  const propByName = new Map();
  (doc.layers || []).forEach((l, i) => {
    propByName.set(l.name, 'L' + i);
    if (!refByName.has(l.name)) {
      refByName.set(l.name, target.context.register(obj(target, { Type: 'OCG', Name: PDFString.of(l.name) })));
    }
  });
  return { refByName, propByName };
}

/** Write the catalog OCProperties from the model: one OCG per layer, ON/OFF
 *  split by visibility. Replaces any inherited OCProperties — the model was
 *  parsed from it at load, so this is faithful for flat layer lists. */
function writeOCProperties(target, doc, L) {
  const list = Array.isArray(doc.layers) ? doc.layers : [];
  if (!list.length) return;
  const all = [], on = [], off = [], order = [];
  for (const l of list) {
    const ref = L.refByName.get(l.name);
    if (!ref) continue;
    all.push(ref);
    order.push(ref);
    (l.visible !== false ? on : off).push(ref);
  }
  if (!all.length) return;
  const d = obj(target, {});
  d.set(PDFName.of('ON'), obj(target, on));
  d.set(PDFName.of('OFF'), obj(target, off));
  d.set(PDFName.of('Order'), obj(target, order));
  d.set(PDFName.of('ListMode'), PDFName.of('AllPages'));
  const ocp = obj(target, {});
  ocp.set(PDFName.of('OCGs'), obj(target, all));
  ocp.set(PDFName.of('D'), d);
  target.catalog.set(PDFName.of('OCProperties'), target.context.register(ocp));
}

/** Wrap content in the layer's marked-content section and carry the OCG ref
 *  in the resources' /Properties. Content on an unknown layer passes through
 *  unwrapped (it renders un-layered rather than vanishing). */
function ocWrap(name, L, content, resources) {
  const ref = name && L && L.refByName.get(name);
  if (!ref) return { content, resources };
  const prop = L.propByName.get(name) || 'OC';
  return {
    content: '/OC /' + prop + ' BDC\n' + content + '\nEMC',
    resources: { ...(resources || {}), Properties: { ...((resources && resources.Properties) || {}), [prop]: ref } },
  };
}

/** Ensure a page's /Resources /Properties carries the layer's OCG ref, then
 *  wrap the page-content ops in the marked-content section. Returns the ops
 *  unchanged when there is nothing to wrap or the page has no own resources
 *  (inherited resources would need a tree walk — such an edit then simply
 *  draws un-layered, which is visible and safe rather than wrong). */
function pageWrapOps(doc, page, name, ops, L) {
  const ref = name && L && L.refByName.get(name);
  if (!ref) return ops;
  try {
    const res = doc.context.lookup(page.node.get(PDFName.of('Resources')));
    if (!(res instanceof PDFDict)) return ops;
    const prop = L.propByName.get(name) || 'OC';
    let props = doc.context.lookup(res.get(PDFName.of('Properties')));
    if (!(props instanceof PDFDict)) {
      props = obj(doc, {});
      res.set(PDFName.of('Properties'), props);
    }
    props.set(PDFName.of(prop), ref);
    return '/OC /' + prop + ' BDC\n' + ops + '\nEMC';
  } catch { return ops; }
}

/* An annotation's own /CA only sets transparency. A blend mode has to live in
 * the appearance stream's graphics state, and every /GS name must be unique
 * per document, so the states are numbered as they are minted. */
let gsSeq = 0;
function extGState(doc, alpha, blend) {
  const props = { Type: 'ExtGState', CA: n(alpha), ca: n(alpha) };
  if (blend) props.BM = PDFName.of(blend);
  return { name: `GS${gsSeq++}`, ref: doc.context.register(obj(doc, props)) };
}

const n = (v) => {
  const num = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(num)) return 0;
  return Number(num.toFixed(3));
};

/* ── Appearance streams ─────────────────────────────────────────────────── */

async function appearanceFor(doc, page, a) {
  const r = a.rect;
  const x0 = r[0], y0 = r[1], w = Math.max(1, r[2] - r[0]), h = Math.max(1, r[3] - r[1]);
  const c = a.color;
  const col = `${n(c[0])} ${n(c[1])} ${n(c[2])}`;
  const sw = a.borderWidth || 1;
  const local = (x, y) => `${n(x - x0)} ${n(y - y0)}`;

  if (a.type === 'ink' && a.paths) {
    let d = `q ${col} RG ${sw} w 1 J 1 j `;
    for (const p of a.paths) {
      for (let k = 0; k < p.length; k += 2) {
        d += (k === 0 ? `${local(p[k], p[k + 1])} m ` : `${local(p[k], p[k + 1])} l `);
      }
      d += 'S ';
    }
    return { content: d + 'Q', resources: {} };
  }
  if (a.type === 'brush' && a.paths) {
    // /InkList is a bare list of coordinate pairs — it has no room for a width
    // per vertex — so the velocity taper only survives as drawn geometry here.
    const hardness = clamp(a.hardness == null ? 1 : a.hardness, 0, 1);
    const base = Math.max(0.2, a.borderWidth || 6);
    const widths = a.widths && a.widths.length === (a.paths[0] || []).length / 2 ? a.widths : null;
    const soft = hardness < 1;
    const halo = soft ? extGState(doc, (1 - hardness) * 0.45, null) : null;
    const core = soft ? extGState(doc, 1, null) : null;
    const resources = {};
    if (halo) resources[halo.name] = halo.ref;
    if (core) resources[core.name] = core.ref;
    let d = `q ${col} RG 1 J 1 j `;
    if (soft) {
      // A soft edge cannot be a real falloff in an appearance stream, so it is
      // approximated by one lighter, wider halo pass under the core.
      let outline = '';
      for (const p of a.paths) for (let k = 0; k + 3 < p.length; k += 2) outline += `${local(p[k], p[k + 1])} m ${local(p[k + 2], p[k + 3])} l `;
      d += `/${halo.name} gs ${n(base + (1 - hardness) * base * 1.8)} w ${outline}S /${core.name} gs `;
    }
    for (const p of a.paths) {
      for (let k = 0; k + 3 < p.length; k += 2) {
        const i0 = k >> 1;
        const w = widths ? (widths[i0] + widths[i0 + 1]) / 2 : base;
        d += `${n(Math.max(0.2, w))} w ${local(p[k], p[k + 1])} m ${local(p[k + 2], p[k + 3])} l S `;
      }
    }
    return { content: d + 'Q', resources: Object.keys(resources).length ? { ExtGState: resources } : {} };
  }
  if (a.type === 'highlighter' && a.quads && a.quads.length) {
    // Transparency comes from the annotation's own /CA, so the state here only
    // carries the blend mode; setting alpha in both would darken twice over.
    const gs = extGState(doc, 1, 'Multiply');
    let d = `q /${gs.name} gs ${col} rg `;
    for (const q of a.quads) {
      for (let k = 0; k < 8; k += 2) d += `${local(q[k], q[k + 1])} ${k === 0 ? 'm' : 'l'} `;
      d += 'h ';
    }
    return { content: `${d}f Q`, resources: { ExtGState: { [gs.name]: gs.ref } } };
  }
  if (a.type === 'rect' || a.type === 'whiteout') {
    const fill = a.type === 'whiteout' ? '1 1 1 rg' : (a.fill ? `${a.fill[0]} ${a.fill[1]} ${a.fill[2]} rg` : '');
    const content = `q ${fill} ${col} RG ${sw} w ${local(x0, y0)} ${n(w)} ${n(h)} re ${fill ? 'B' : 'S'} Q`;
    return { content, resources: {} };
  }
  if (a.type === 'ellipse') {
    const k = 0.5523;
    const d = `q ${col} RG ${sw} w ${local(x0 + w / 2, y0)} m ` +
      `${local(x0 + w / 2 + w * k / 2, y0)} ${local(x0 + w, y0 + h / 2 - h * k / 2)} ${local(x0 + w, y0 + h / 2)} c ` +
      `${local(x0 + w, y0 + h / 2 + h * k / 2)} ${local(x0 + w / 2 + w * k / 2, y0 + h)} ${local(x0 + w / 2, y0 + h)} c ` +
      `${local(x0 + w / 2 - w * k / 2, y0 + h)} ${local(x0, y0 + h / 2 + h * k / 2)} ${local(x0, y0 + h / 2)} c ` +
      `${local(x0, y0 + h / 2 - h * k / 2)} ${local(x0 + w / 2 - w * k / 2, y0)} ${local(x0 + w / 2, y0)} c S Q`;
    return { content: d, resources: {} };
  }
  if ((a.type === 'line' || a.type === 'arrow' || a.type === 'measure') && a.points) {
    let d = `q ${col} RG ${sw} w 1 J 1 j ${local(a.points[0], a.points[1])} m ${local(a.points[2], a.points[3])} l S`;
    if (a.type === 'arrow') {
      const ang = Math.atan2(a.points[3] - a.points[1], a.points[2] - a.points[0]);
      const L = Math.max(8, sw * 4);
      const p2x = a.points[2], p2y = a.points[3];
      for (const off of [Math.PI * 0.82, -Math.PI * 0.82]) {
        d += ` ${local(p2x, p2y)} m ${local(p2x + Math.cos(ang + off) * L, p2y + Math.sin(ang + off) * L)} l S`;
      }
    }
    return { content: d + ' Q', resources: {} };
  }
  if (a.type === 'textbox' || a.type === 'callout') {
    const font = await baseFont(doc, fontVariant(a.fontFamily, a.bold, a.italic));
    const size = a.fontSize || 11;
    const pad = 3;
    const maxW = Math.max(6, w - pad * 2);
    const lines = wrapText(a.text || '', font, size, maxW);
    const lh = size * 1.3;
    let d = 'q ';
    // A null fill is transparent, not white. Baking `1 1 1 rg` here is what made
    // "no fill" and "white fill" produce the same page, so the writer strokes the
    // rect only when there is no fill.
    if (a.fill) d += `${n(a.fill[0])} ${n(a.fill[1])} ${n(a.fill[2])} rg `;
    d += `${col} RG ${sw} w ${local(x0, y0)} ${n(w)} ${n(h)} re ${a.fill ? 'B' : 'S'} Q BT /${font.name} ${n(size)} Tf `;
    const tc = a.textColor || [0.08, 0.09, 0.12];
    d += `${n(tc[0])} ${n(tc[1])} ${n(tc[2])} rg `;
    let y = y0 + h - pad - size * 0.95;
    for (const line of lines) {
      let x = x0 + pad;
      if (a.align === 'center') x = x0 + (w - font.widthOfTextAtSize(line, size)) / 2;
      else if (a.align === 'right') x = x0 + w - pad - font.widthOfTextAtSize(line, size);
      d += `1 0 0 1 ${local(x, y)} Tm ${font.encodeText(line)} Tj `;
      y -= lh;
      if (y < y0 + pad - lh) break;
    }
    d += 'ET';
    return { content: d, resources: { Font: { [font.name]: font.ref } } };
  }
  if (a.type === 'stamp' || a.type === 'signature' || a.type === 'image') {
    if (a.image) {
      const bytes = dataUrlBytes(a.image);
      if (bytes) {
        let img = null;
        try { img = await doc.embedPng(bytes); } catch { /* not png */ }
        if (!img) { try { img = await doc.embedJpg(bytes); } catch { img = null; } }
        if (img) {
          const d = `q ${n(w)} 0 0 ${n(h)} ${local(x0, y0)} cm /${img.name} Do Q`;
          return { content: d, resources: { XObject: { [img.name]: img.ref } } };
        }
      }
    }
    const font = await baseFont(doc, 'Helvetica');
    const size = clamp((a.fontSize || 14), 4, 200);
    const label = a.stampLabel || a.text || 'STAMP';
    const tw = font.widthOfTextAtSize(label, size);
    const d = `q ${col} RG ${sw} w ${local(x0, y0)} ${n(w)} ${n(h)} re S Q BT /${font.name} ${n(size)} Tf ${col} rg ` +
      `1 0 0 1 ${n(x0 + (w - tw) / 2)} ${n(y0 + h / 2 - size * 0.35)} Tm (${label}) Tj ET`;
    return { content: d, resources: { Font: { [font.name]: font.ref } } };
  }

  /* ── Foxit drawing set: rounded rectangle / polygon / polyline / cloud /
         area highlight / caret ───────────────────────────────────────────── */

  const flatPoints = (arr) => {
    const out = [];
    for (let k = 0; k + 1 < arr.length; k += 2) out.push([arr[k], arr[k + 1]]);
    return out;
  };

  if (a.type === 'roundRect') {
    const rad = Math.min(w, h) * 0.16;
    const k = 0.5523 * rad;
    const B = (x, y) => local(x, y);
    const d = `q ${a.fill ? `${a.fill[0]} ${a.fill[1]} ${a.fill[2]} rg ` : ''}${col} RG ${sw} w ` +
      `${B(x0 + rad, y0)} m ` +
      `${B(x0 + rad - k, y0)} ${B(x0, y0 + rad - k)} ${B(x0, y0 + rad)} c ` +
      `${B(x0, y0 + h - rad)} l ` +
      `${B(x0, y0 + h - rad + k)} ${B(x0 + rad - k, y0 + h)} ${B(x0 + rad, y0 + h)} c ` +
      `${B(x0 + w - rad, y0 + h)} l ` +
      `${B(x0 + w - rad + k, y0 + h)} ${B(x0 + w, y0 + h - rad + k)} ${B(x0 + w, y0 + h - rad)} c ` +
      `${B(x0 + w, y0 + rad)} l ` +
      `${B(x0 + w, y0 + rad - k)} ${B(x0 + w - rad + k, y0)} ${B(x0 + w - rad, y0)} c ` +
      `h ${a.fill ? 'B' : 'S'} Q`;
    return { content: d, resources: {} };
  }

  if ((a.type === 'polygon' || a.type === 'polyline' || a.type === 'cloud' || a.type === 'measureArea' || a.type === 'areaHighlight') && a.points) {
    const pts = flatPoints(a.points);
    if (pts.length < 2) return null;
    const closed = a.type !== 'polyline';
    // Area highlight needs translucent paint; the others are opaque strokes.
    const resources = {};
    const alpha = a.type === 'areaHighlight' ? clamp(a.opacity ?? 0.4, 0.05, 1) : null;
    if (alpha != null) {
      const gsName = 'GSp';
      resources.ExtGState = { [gsName]: makeExtGState(doc, alpha).ref };
    }
    const gs = alpha != null ? `/GS${''} gs ` : '';
    let d = `q ${gs}`;
    if (a.fill && closed && a.type !== 'areaHighlight') d += `${a.fill[0]} ${a.fill[1]} ${a.fill[2]} rg `;
    if (a.type === 'cloud') {
      // Each segment is drawn as a bulging cubic so the result reads as a
      // cloud outline rather than a plain polygon.
      const list = pts.slice();
      if (closed) list.push(pts[0]);
      d += `${col} RG ${sw} w 1 J 1 j ${local(list[0][0], list[0][1])} m `;
      for (let k = 1; k < list.length; k++) {
        const A = list[k - 1], Bp = list[k];
        const dx = Bp[0] - A[0], dy = Bp[1] - A[1];
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;
        const amp = Math.min(len * 0.17, 7) * (k % 2 === 0 ? 1 : -1);
        d += `${local(A[0] + nx * amp, A[1] + ny * amp)} ${local(Bp[0] + nx * amp, Bp[1] + ny * amp)} ${local(Bp[0], Bp[1])} c `;
      }
      d += 'S Q';
    } else if (a.type === 'areaHighlight') {
      d += `${col} rg `;
      for (let k = 0; k < pts.length; k++) d += `${local(pts[k][0], pts[k][1])} ${k === 0 ? 'm' : 'l'} `;
      d += `h f Q`;
    } else {
      d += `${col} RG ${sw} w 1 J 1 j `;
      for (let k = 0; k < pts.length; k++) d += `${local(pts[k][0], pts[k][1])} ${k === 0 ? 'm' : 'l'} `;
      if (closed) d += 'h ';
      d += a.fill && closed ? 'B' : 'S';
      d += ' Q';
    }
    return { content: d, resources };
  }

  if (a.type === 'caret') {
    // Conventional "insert text here" caret glyph.
    const d = `q ${col} RG 1.2 w 1 J 1 j ${local(x0, y0)} m ${local(x0 + w * 0.34, y0 + h)} l ${local(x0 + w * 0.68, y0)} l S Q`;
    return { content: d, resources: {} };
  }

  return null;
}

/** A graphics state carrying a constant alpha, so area highlights paint as a
 *  translucent wash instead of an opaque slab. */
function makeExtGState(doc, alpha) {
  const dict = obj(doc, { Type: 'ExtGState', ca: clamp(alpha, 0, 1), CA: clamp(alpha, 0, 1) });
  return doc.context.register(dict);
}

function wrapText(text, font, size, maxW) {
  const out = [];
  for (const para of String(text).split(/\r?\n/)) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const test = line ? line + ' ' + word : word;
      if (font.widthOfTextAtSize(test, size) <= maxW || !line) line = test;
      else { out.push(line); line = word; }
    }
    out.push(line);
  }
  return out;
}

function dataUrlBytes(dataUrl) {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const i = dataUrl.indexOf(',');
  const meta = dataUrl.slice(0, i);
  const body = dataUrl.slice(i + 1);
  const bin = meta.includes('base64') ? atob(body) : decodeURIComponent(body);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

/* ── Annotation writer ──────────────────────────────────────────────────── */

async function writeAnnotation(doc, page, a, L = null) {
  const subtype = ANNOT_TYPES[a.type] || 'Square';
  const r = a.rect.map((v) => n(v));
  const dict = obj(doc, {
    Type: 'Annot',
    Subtype: subtype,
    Rect: r,
    F: 4,                       // print the annotation
    C: [n(a.color[0]), n(a.color[1]), n(a.color[2])],
    T: PDFHexString.fromText(a.author || 'User'),
    M: PDFString.of(pdfDate(new Date(a.date || Date.now()))),
  });

  /* Links are invisible rectangles that carry an action, not a visual border,
     and they are tagged with /NM so a later save replaces (not duplicates) them. */
  if (a.type === 'link') {
    dict.set(PDFName.of('Border'), obj(doc, [0, 0, 0]));
    dict.set(PDFName.of('BS'), obj(doc, { W: 0, S: PDFName.of('S') }));
    dict.set(PDFName.of('NM'), PDFString.of(annotName(a)));
    if (a.dest === 'goto') {
      // getPage() throws for an out-of-range index, which a link can easily
      // hold: draw one to the last page, delete that page, save. That threw
      // out of the writer and abandoned the annotation. An unreachable
      // destination is dropped instead — the link stays, inert, rather than
      // taking the whole save down with it.
      const idx = typeof a.destPage === 'number' ? a.destPage : -1;
      const destPage = idx >= 0 && idx < doc.getPageCount() ? doc.getPage(idx) : null;
      if (destPage) dict.set(PDFName.of('Dest'), obj(doc, [destPage.ref, PDFName.of('XYZ'), PDFNumber.of(0), PDFNumber.of(0), PDFNumber.of(0)]));
    } else if (a.uri) {
      dict.set(PDFName.of('A'), obj(doc, {
        S: PDFName.of('URI'), URI: PDFString.of(String(a.uri)),
      }));
    }
    return doc.context.register(dict);
  }

  if (a.text) dict.set(PDFName.of('Contents'), PDFHexString.fromText(a.text));
  // Layer membership travels on the annotation dict as a private key — pdf.js
  // does not surface custom keys, so applyLayerAssignment() reads it back
  // from the stored bytes on the next load (same trick as /Q alignment).
  if (a.layer) dict.set(PDFName.of('AIPDFLayer'), PDFString.of(a.layer));
  if (a.opacity != null && a.opacity < 1) dict.set(PDFName.of('CA'), PDFNumber.of(n(a.opacity)));

  if (a.quads && a.quads.length && a.type !== 'highlighter') {
    // /QuadPoints means nothing on an /Ink; the highlighter's swept quads are
    // derived geometry, and the read-back rebuilds them from /InkList.
    dict.set(PDFName.of('QuadPoints'), obj(doc, a.quads.flat().map((v) => n(v))));
  }
  if (a.type === 'highlight') dict.set(PDFName.of('Subtype'), PDFName.of('Highlight'));
  if (a.type === 'redact') {
    dict.set(PDFName.of('Subtype'), PDFName.of('Redact'));
    dict.set(PDFName.of('IC'), obj(doc, [0, 0, 0]));
  }
  if (a.type === 'note') {
    dict.set(PDFName.of('Name'), PDFName.of(a.icon && /^[A-Za-z]+$/.test(a.icon) ? a.icon : 'Note'));
  }
  if (a.type === 'callout') {
    dict.set(PDFName.of('IT'), PDFName.of('FreeTextCallout'));
    if (a.leader) dict.set(PDFName.of('CL'), obj(doc, a.leader.map((v) => n(v))));
  }
  if (a.type === 'textbox' || a.type === 'callout') {
    const font = await baseFont(doc, fontVariant(a.fontFamily, a.bold, a.italic));
    dict.set(PDFName.of('DA'), PDFString.of(`/${font.name} ${n(a.fontSize || 11)} Tf ${n((a.textColor || [0.08, 0.09, 0.12])[0])} ${n((a.textColor || [0.08, 0.09, 0.12])[1])} ${n((a.textColor || [0.08, 0.09, 0.12])[2])} rg`));
    dict.set(PDFName.of('Q'), PDFNumber.of(a.align === 'center' ? 1 : a.align === 'right' ? 2 : 0));
  }
  if ((a.type === 'ink' || a.type === 'brush' || a.type === 'highlighter') && a.paths) {
    dict.set(PDFName.of('InkList'), obj(doc, a.paths.map((p) => p.map((v) => n(v)))));
  }
  // All three freehand tools write /Subtype /Ink; /IT is the only field pdf.js
  // gives back that can name the one which drew this stroke. Readers that do
  // not know the name fall back to a plain ink annotation.
  if (INK_INTENTS[a.type]) dict.set(PDFName.of('IT'), PDFName.of(INK_INTENTS[a.type]));
  if ((a.type === 'polygon' || a.type === 'polyline' || a.type === 'cloud' || a.type === 'measureArea' || a.type === 'areaHighlight') && a.points && a.points.length >= 4) {
    // /Vertices is the canonical vertex list for Polygon/PolyLine. A cloud is a
    // polygon drawn with a clouded border, and Foxit's area tools are polygons
    // with an /IT intent — all three are polygons on disk but distinct tools.
    dict.set(PDFName.of('Vertices'), obj(doc, a.points.map((v) => n(v))));
    if (a.type === 'cloud') dict.set(PDFName.of('IT'), PDFName.of('PolygonCloud'));
    if (a.type === 'areaHighlight') dict.set(PDFName.of('IT'), PDFName.of('AreaHighlight'));
    if (a.type === 'measureArea') {
      dict.set(PDFName.of('IT'), PDFName.of('PolygonDimension'));
      if (a.label) dict.set(PDFName.of('Contents'), PDFHexString.fromText(a.label));
    }
  }
  if (a.type === 'roundRect') dict.set(PDFName.of('IT'), PDFName.of('RoundRect'));
  if ((a.type === 'line' || a.type === 'arrow' || a.type === 'measure') && a.points) {
    dict.set(PDFName.of('L'), obj(doc, a.points.map((v) => n(v))));
    if (a.type === 'arrow') dict.set(PDFName.of('LE'), obj(doc, [PDFName.of('None'), PDFName.of('ClosedArrow')]));
    dict.set(PDFName.of('IT'), PDFName.of(a.type === 'measure' ? 'LineDimension' : 'LineArrow'));
    if (a.type === 'measure') {
      // Without /Cap the caption is treated as popup text and most readers do
      // not draw the dimension on the line itself. PDFBool has no of() — only
      // the True/False singletons — and the throw used to swallow this whole
      // annotation into the per-annot catch below, so saved measurements
      // silently vanished.
      dict.set(PDFName.of('Cap'), PDFBool.True);
      // a.label is the formatted caption (e.g. "42.5 mm"); a round-tripped
      // measure already carries it in a.text, so only fill /Contents once.
      if (a.label && !a.text) dict.set(PDFName.of('Contents'), PDFHexString.fromText(String(a.label)));
    }
  }
  if (a.borderWidth) {
    dict.set(PDFName.of('Border'), obj(doc, [0, 0, n(a.borderWidth)]));
    dict.set(PDFName.of('BS'), obj(doc, { W: n(a.borderWidth), S: PDFName.of('S') }));
  }

  const ap = await appearanceFor(doc, page, a);
  if (ap) {
    const wrapped = ocWrap(a.layer, L, ap.content, ap.resources);
    const ref = makeFormXObject(doc, wrapped.content, r, wrapped.resources);
    dict.set(PDFName.of('AP'), obj(doc, { N: ref }));
  }
  return doc.context.register(dict);
}

/** @cantoo/pdf-lib has no createSignature(), so build a /Sig field manually.
 *  Registers a field dict + widget annotation, links them, and registers the
 *  field on the AcroForm. Verified to round-trip through save/load. */
function addSignatureField(doc, form, name, page, box) {
  const ctx = doc.context;
  const fieldDict = obj(doc, {
    FT: PDFName.of('Sig'),
    T: PDFHexString.fromText(name),
    Ff: 0,
  });
  const fieldRef = ctx.register(fieldDict);
  const widgetDict = obj(doc, {
    Type: 'Annot',
    Subtype: PDFName.of('Widget'),
    Rect: [n(box.x), n(box.y), n(box.x + box.width), n(box.y + box.height)],
    F: 4,
    Parent: fieldRef,
  });
  if (page.ref) widgetDict.set(PDFName.of('P'), page.ref);
  const widgetRef = ctx.register(widgetDict);
  fieldDict.set(PDFName.of('Kids'), obj(doc, [widgetRef]));
  const existing = page.node.Annots();
  const arr = (existing && typeof existing.asArray === 'function')
    ? existing.asArray().concat([widgetRef])
    : [widgetRef];
  page.node.set(PDFName.of('Annots'), obj(doc, arr));
  const acro = form.acroForm;
  if (acro && typeof acro.addField === 'function') acro.addField(fieldRef);
  return fieldRef;
}

/* ── OCR: writing the recognised text back into the file ─────────────────── */

/**
 * Persist recognised text as an invisible text layer.
 *
 * Only pages the user actually recognised for editing get one (`forEditing`),
 * and only when the page had no native text to begin with — writing a second
 * copy of text the page already contains would double every search hit and
 * make copy-paste produce duplicated words.
 */
async function applyOcrLayer(doc, target, pages, indexMap) {
  const ocr = doc.ocr;
  if (!ocr) return;
  for (const key of Object.keys(ocr)) {
    const rec = ocr[key];
    if (!rec || !rec.forEditing || rec.engine !== 'tesseract') continue;
    if (!Array.isArray(rec.lines) || !rec.lines.length) continue;
    const pageIndex = Number(key);
    const idx = indexMap ? indexMap.get(pageIndex) : pageIndex;
    if (idx == null || !pages[idx]) continue;

    const size0 = doc.pageSizes?.[pageIndex] || pages[idx].getSize();
    const blocks = blocksFromOcrLines(rec.lines, size0.w, size0.h, rec.dpi || 200, pageIndex);
    if (!blocks.length) continue;

    const font = await baseFont(target, 'Helvetica');
    const fontKey = pages[idx].node.newFontDictionary(font.name, font.ref);
    const ops = [];
    for (const b of blocks) {
      const size = clamp(Number(b.size) || 10, 4, 96);
      const leading = Number(b.lineHeight) || size * 1.2;
      const lines = String(b.text || '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        // 3 Tr = render mode "invisible": no fill, no stroke, still extractable.
        ops.push(`BT /${fontKey} ${n(size)} Tf 3 Tr ${n(b.baseline[0])} ${n(b.baseline[1] - i * leading)} Td ${font.encodeText(line)} Tj ET`);
      }
    }
    if (ops.length) appendPageOps(target, pages[idx], ops.join(' '));
  }
}

/* ── Text edits (in-place editing) ──────────────────────────────────────── */

/** What a save had to do that the user should know about: an edit that could
 *  only be covered rather than removed, or text left over as overset. Drained
 *  by the caller so the report describes the file that was actually written. */
const exportWarnings = [];
export function drainExportWarnings() {
  return exportWarnings.splice(0, exportWarnings.length);
}

/** Renderer-side zlib inflate for FlateDecode content streams. PDF's FlateDecode
 *  is zlib-wrapped, which is DecompressionStream('deflate') — not
 *  'deflate-raw'. Returns null where the API is missing so the caller can fall
 *  back to covering instead of throwing. */
async function inflateBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * The page's own ruling lines, read from its content stream.
 *
 * A table's grid is drawn, not implied: it is a set of stroked (or thin filled)
 * segments in the page content. pdf.js does not expose those as geometry — it
 * hands them to a canvas — so the only honest source is the stream itself, which
 * is why this lives next to the excise path (same decoder, same tokenizer).
 *
 * Needed because text geometry alone cannot see the grid of a table whose cells
 * are close together: such a row arrives as ONE text run, so there are no
 * gutters to cluster and the columns are invisible. The rules are the only
 * evidence left, and they are exact.
 *
 * Returns `{ h, v }` (horizontal / vertical segments) or null when the stream
 * cannot be read — an encrypted or exotic file degrades to text-only detection
 * rather than failing the whole editor.
 */
export async function pageRulePaths(doc, pageIndex) {
  if (!doc?.bytes) return null;
  try {
    const pl = await PL.PDFDocument.load(doc.bytes.slice(0), { updateMetadata: false, ignoreEncryption: true });
    const page = pl.getPage(pageIndex);
    const entry = page.node.get(PL.PDFName.of('Contents'));
    if (!entry) return null;
    const resolved = pl.context.lookup(entry);
    const refs = resolved instanceof PL.PDFArray
      ? Array.from({ length: resolved.size() }, (_, i) => resolved.get(i))
      : [entry];

    const out = { h: [], v: [] };
    for (const ref of refs) {
      const obj = pl.context.lookup(ref);
      if (!obj) continue;
      const raw = obj.contents instanceof Uint8Array ? obj.contents
        : (typeof obj.getContents === 'function' ? obj.getContents() : null);
      if (!raw) continue;
      const filter = obj.dict?.get?.(PL.PDFName.of('Filter'))?.toString() || '';
      if (filter && !filter.includes('FlateDecode')) continue;   // unsupported filter
      const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const bytes = filter.includes('FlateDecode') ? await inflateBytes(buf) : buf;
      if (!bytes) continue;
      const paths = walkVectorPaths(new TextDecoder('latin1').decode(bytes));
      out.h.push(...paths.h);
      out.v.push(...paths.v);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Remove the ORIGINAL operators a text edit owns, instead of hiding them.
 *
 * The research this editor is built on is explicit that a white cover is not a
 * deletion: a screenshot looks right while the old, searchable words remain in
 * the file, so search, copy-paste and a screen reader disagree with the page.
 * Excision is what makes the saved file truthful.
 *
 * It is safe here because buildPdf() always reconstructs the candidate from the
 * ORIGINAL bytes: excising mutates only the throwaway candidate, so undo and
 * "Restore original" stay exact.
 *
 * Returns { removal: 'excise' | 'cover', removed, fallbackReason? }:
 *  - 'excise' — the owned operators were cut; nothing is left to hide.
 *  - 'cover'  — a wash is still required: the glyphs are pixels (a recognised
 *               scan), or the page's text lives in a shared Form XObject, which
 *               must never be edited in place because several pages may share it.
 */
async function removeOwnedSource(doc, pageIndex, e) {
  if (e.kind === 'o' || e.bgSource === 'ocr') return { removal: 'cover', removed: 0, fallbackReason: 'scan' };
  // Excise each owned source rect SEPARATELY. A merged paragraph may own lines 1
  // and 3 while skipping line 2 — a single union rect would remove line 2, which
  // the replacement does not contain, and the words would be gone for good.
  const owned = (Array.isArray(e.sourceRects) && e.sourceRects.length
    ? e.sourceRects
    : [e.exciseRect || e.coverRect]).map(normRect).filter(Boolean);
  if (!owned.length) return { removal: 'cover', removed: 0, fallbackReason: 'no-source-geometry' };
  const inflate = async (b) => {
    const out = await inflateBytes(b);
    if (!out) throw new Error('DecompressionStream unavailable');
    return out;
  };
  try {
    // Excision is destructive and irreversible once written, so dry-run first
    // and only commit when it matched the geometry we expected.
    const dry = await exciseText(PL, doc, pageIndex, owned, { inflate, dryRun: true });
    if (dry.refused.length) return { removal: 'cover', removed: 0, fallbackReason: 'form-xobject:' + dry.refused.join(',') };
    if (dry.removed < 1) return { removal: 'cover', removed: 0, fallbackReason: 'no-owned-operators' };
    const real = await exciseText(PL, doc, pageIndex, owned, { inflate });
    if (real.refused.length || real.removed < 1) return { removal: 'cover', removed: 0, fallbackReason: 'excision-refused' };
    return { removal: 'excise', removed: real.removed };
  } catch (err) {
    console.warn('text excision failed; falling back to a cover wash', err);
    return { removal: 'cover', removed: 0, fallbackReason: 'error:' + String(err?.message || err) };
  }
}

/** Paint the opaque washes that hide an original run. Used ONLY when the source
 *  operators could not be removed — a scan, or a shared Form XObject. */
function washRects(page, rects, bg) {
  for (const c of rects) {
    if (!c) continue;
    page.drawRectangle({
      x: Math.min(c[0], c[2]), y: Math.min(c[1], c[3]),
      width: Math.max(1, Math.abs(c[2] - c[0])), height: Math.max(1, Math.abs(c[3] - c[1])),
      color: rgb(...bg), borderWidth: 0,
    });
  }
}

/**
 * Compose a story into an ordered chain of frames, on whatever pages the frames
 * name — the research's "Thread frames". Frame 1 is filled first; the remaining
 * text continues from the exact logical position into frame 2, and so on. The
 * frames are never merged into one rectangle.
 *
 * Anything left after the last frame is OVERSET: reported, never silently
 * clipped, and never discarded from the model.
 */
async function applyFramedEdit(doc, e, ctx) {
  const { pageIndex, pages, indexMap, font, size, measure } = ctx;
  const story = storyFromEdit({ ...e, drawBox: null });
  const layout = layoutStory(story, measure);
  e.consumed = layout.consumed;
  e.total = layout.total;
  e.overset = layout.overset ? { text: layout.overset.text, lines: layout.overset.lines } : null;
  if (e.overset) exportWarnings.push({ kind: 'overset', id: e.id, page: e.page, remaining: e.overset.lines });

  const col = rgb(clamp((e.color || [0, 0, 0])[0], 0, 1), clamp((e.color || [0, 0, 0])[1], 0, 1), clamp((e.color || [0, 0, 0])[2], 0, 1));
  const stroke = `${n(col.red)} ${n(col.green)} ${n(col.blue)} rg`;
  const hScale = e.hScale && e.hScale !== 100 ? e.hScale : 100;

  for (const pl of layout.placements) {
    const ti = indexMap ? indexMap.get(pl.page) : pl.page;
    const targetPage = pages ? pages[ti] : null;
    if (!targetPage) continue;
    // The wash fallback only ever applies to the page that still holds the
    // original glyphs; the continuation frames had nothing to remove.
    if (e.removal !== 'excise' && e.bg && pl.page === e.page) {
      washRects(targetPage, [e.coverRect, ...(e.priorBoxes || [])], e.bg);
    }
    const fontKey = targetPage.node.newFontDictionary(font.name, font.ref);
    const ops = [];
    for (const ln of pl.lines) {
      if (!ln.text) continue;
      const lw = measure(ln.text);
      let x = ln.x;
      if (e.align === 'center') x = ln.x + (pl.width - lw) / 2;
      else if (e.align === 'right') x = ln.x + (pl.width - lw);
      ops.push(`q BT /${fontKey} ${n(size)} Tf ${stroke} `
        + `${n(e.charSpacing || 0)} Tc ${n(hScale)} Tz `
        + `1 0 0 1 ${n(x)} ${n(ln.y)} Tm ${font.encodeText(ln.text)} Tj ET Q`);
    }
    if (ops.length) appendPageOps(doc, targetPage, ops.join(' '));
  }
  void pageIndex;
}

async function applyTextEdit(doc, page, e, ctx = {}) {
  const pageIndex = ctx.pageIndex != null ? ctx.pageIndex : e.page;
  const r = e.rect;
  const w = Math.abs(r[2] - r[0]);
  const font = await baseFont(doc, e.fontFamily || 'Helvetica');
  const size = e.size || 11;
  const rot = Math.round((e.angle || 0) / 90) * 90;
  const block = !!e.itemIndices?.length;
  const hScale = e.hScale && e.hScale !== 100 ? e.hScale : 100;
  const maxWidth = e.maxWidth || w;
  // Horizontal scaling multiplies advance widths, so wrapping has to be
  // measured with it applied or a scaled line silently overflows the box.
  const measure = (t) => font.widthOfTextAtSize(t, size) * (hScale / 100);

  /* ── Removal strategy ─────────────────────────────────────────────────────
     Prefer TRUE REMOVAL of the owned source operators over a white cover. The
     original operators are what search, copy-paste and a screen reader read, so
     leaving them under a wash makes the file lie about its own contents. */
  const removalInfo = await removeOwnedSource(doc, pageIndex, e);
  e.removal = removalInfo.removal;
  e.removedBlocks = removalInfo.removed;
  if (removalInfo.removal === 'cover' && removalInfo.fallbackReason) {
    exportWarnings.push({ kind: 'cover-fallback', id: e.id, page: e.page, reason: removalInfo.fallbackReason });
  }

  /* ── Linked frames (Thread frames) ────────────────────────────────────────
     A story composed into an ordered chain of frames is drawn by its own path,
     because the continuation frames may live on other pages. */
  if (Array.isArray(e.frames) && e.frames.length > 1 && !e.boxId) {
    return applyFramedEdit(doc, e, { pageIndex, pages: ctx.pages, indexMap: ctx.indexMap, font, size, measure });
  }

  // Preflight BEFORE covering anything, so a font that genuinely cannot encode
  // the text fails the save here rather than leaving a cover rectangle with no
  // replacement on top of it. (Standard fonts substitute '?' for code points
  // they cannot encode instead of throwing — see textedit.js's fontIsUsable,
  // which warns about that when the editor opens.)
  const lines = block ? wrapBlockText(e.text, maxWidth, measure) : String(e.text || '').split(/\r?\n/);
  for (const line of lines) font.encodeText(line);

  // Overset is a first-class result, never inferred from a viewer clipping text
  // out of view. The UI shows it and export warns about it; the story text is
  // never discarded from the model.
  const boxH = Number(e.maxHeight) || size * 1.25;
  const fit = fitCount(lines, boxH, size, e.lineHeight || size * 1.2);
  e.consumed = fit;
  e.total = lines.length;
  e.overset = fit < lines.length ? { text: lines.slice(fit).join('\n'), lines: lines.length - fit } : null;
  if (e.overset) exportWarnings.push({ kind: 'overset', id: e.id, page: e.page, remaining: e.overset.lines });

  /* The removal decision above already decided whether the original survives.
     When it was truly removed there is nothing left to hide, so no wash is
     painted — the page genuinely no longer contains the old words. A wash is
     only painted when removal was impossible (a scan whose glyphs are pixels,
     or text inside a shared Form XObject). This is still NOT secure redaction:
     a removed visible object does not prove every copy elsewhere is gone — use
     Redact + Sanitize for confidentiality. */
  /* A direct edit owns a paired /FreeText box. The box is the on-screen
     affordance for dragging and re-editing, but the SAVED file must carry the
     replacement as ORDINARY PAGE TEXT: an annotation is invisible to a text
     search, a screen reader and copy-paste, so a file whose replacement lives
     only in the annotation layer again lies about its own contents.

     When the owned operators were truly removed there is nothing left to hide,
     so we fall through and draw the replacement into the page content — exactly
     as an unboxed edit does — and buildPdf omits the paired box from the file
     (see `contentBoxes` below), keeping the text layer the single source of
     truth. The box stays in the model so the edit remains draggable on screen.

     A cover fallback still cannot remove the original, so there we keep the
     wash plus the box annotation: the box draws the replacement over the wash
     and there is no page text to duplicate it. */
  if (e.boxId && removalInfo.removal !== 'excise') {
    if (!e.bg) return;
    washRects(page, [e.coverRect, ...(e.priorBoxes || [])], e.bg);
    return;
  }

  if (removalInfo.removal === 'cover' && e.bg) {
    washRects(page, textEditWashes(e), e.bg);
  }

  if (!block) {
    const opts = {
      x: e.baseline[0], y: e.baseline[1], size, font,
      color: rgb(...(e.color || [0, 0, 0])),
      lineHeight: e.lineHeight || size * 1.2,
    };
    if (rot) opts.rotate = degrees(rot);
    page.drawText(lines.join('\n'), opts);
    return;
  }

  /* Blocks are written as raw content-stream operators rather than through
     page.drawText, because drawText cannot express the typography Acrobat's
     Format panel exposes: character spacing (Tc), horizontal scaling (Tz) and
     justified lines, which need each word placed by hand.

     They go into the PAGE's own content stream, not a Form XObject, so the
     replacement stays ordinary selectable PDF text that later edits can cover
     again — a form would hide it from re-editing and from the wash list. */
  const col = rgb(clamp((e.color || [0, 0, 0])[0], 0, 1), clamp((e.color || [0, 0, 0])[1], 0, 1), clamp((e.color || [0, 0, 0])[2], 0, 1));
  const leading = e.lineHeight || size * 1.2;
  const rad = (rot * Math.PI) / 180;
  // Register the font in the page's /Resources /Font. newFontDictionary hands
  // back the resource KEY it chose, which may differ from font.name, so the Tf
  // operator must use that key or the viewer resolves it to nothing.
  const fontKey = page.node.newFontDictionary(font.name, font.ref);
  const ops = [];
  const stroke = `${n(col.red)} ${n(col.green)} ${n(col.blue)} rg`;
  const textAt = (str, x, y) => `q BT /${fontKey} ${n(size)} Tf ${stroke} `
    + `${n(e.charSpacing || 0)} Tc ${n(hScale)} Tz `
    + `${n(Math.cos(rad))} ${n(Math.sin(rad))} ${n(-Math.sin(rad))} ${n(Math.cos(rad))} ${n(x)} ${n(y)} Tm `
    // font.encodeText() returns a PDFHexString whose string form is already the
    // correct `<hex>` operand — WinAnsi codes for a standard font, glyph ids for
    // an embedded subset. Wrapping it in a literal-string helper throws
    // (it is not a byte array) and writes the wrong bytes for a standard font.
    + `${font.encodeText(str)} Tj ET Q`;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Line origins step along "down the page" in the text's own rotated frame.
    const y = e.baseline[1] - i * leading * Math.cos(rad);
    const x = e.baseline[0] + i * leading * Math.sin(rad);
    if (!line) continue;
    const lw = measure(line);
    let x0 = x;
    if (e.align === 'center') x0 = x + (maxWidth - lw) / 2;
    else if (e.align === 'right') x0 = x + (maxWidth - lw);

    // Justify by spacing the words out. Never the last line of a paragraph —
    // a justified last line is a typographic error, and Acrobat agrees.
    const paragraphEnd = lines[i + 1] === '' || i === lines.length - 1;
    const words = line.split(/\s+/).filter(Boolean);
    if (e.align === 'justify' && words.length > 1 && !paragraphEnd) {
      const widths = words.map((wd) => measure(wd));
      const used = widths.reduce((a, b) => a + b, 0);
      const gap = (maxWidth - used) / (words.length - 1);
      let cx = x;
      words.forEach((wd, k) => { ops.push(textAt(wd, cx, y)); cx += widths[k] + gap; });
    } else {
      ops.push(textAt(line, x0, y));
    }

    if (e.underline && !rot) {
      ops.push(`q ${stroke} ${n(x0)} ${n(y - size * 0.14)} ${n(lw)} ${n(Math.max(0.4, size * 0.06))} re f Q`);
    }
  }
  if (!ops.length) return;
  appendPageOps(doc, page, pageWrapOps(doc, page, e.layer, ops.join(' '), ctx.oc));
}

/* ── Stamps: watermark / header / footer / Bates ────────────────────────── */

function expandTokens(str, ctx) {
  return String(str || '')
    .replace(/\{page\}/g, String(ctx.page))
    .replace(/\{pages\}/g, String(ctx.pages))
    .replace(/\{date\}/g, ctx.date)
    .replace(/\{time\}/g, ctx.time)
    .replace(/\{filename\}/g, ctx.filename)
    .replace(/\{author\}/g, ctx.author)
    .replace(/\{bates\}/g, String(ctx.bates ?? ''));
}

async function applyStamp(doc, page, st, ctx) {
  const { width: pw, height: ph } = page.getSize();
  const font = await baseFont(doc, st.fontFamily || 'Helvetica');
  const col = pdfRgb(st.color || [0.4, 0.4, 0.4]);
  const behind = !!st.behind;

  const draw = async (drawFn) => {
    if (!behind) { await drawFn(); return; }
    // Draw into a form XObject then prepend it to /Contents.
    const ops = [];
    const proxy = {
      drawText: (t, o) => ops.push(textOp(font, t, o)),
      drawRectangle: (o) => ops.push(rectOp(o)),
      drawImage: () => {},
    };
    await drawFn(proxy);
    const content = ops.join(' ');
    if (!content) return;
    const ref = makeFormXObject(doc, content, [0, 0, pw, ph], { Font: { [font.name]: font.ref } });
    prependContent(doc, page, ref);
  };

  if (st.kind === 'watermark') {
    if (st.image) {
      const bytes = dataUrlBytes(st.image);
      if (bytes) {
        let img = null;
        try { img = await doc.embedPng(bytes); } catch { try { img = await doc.embedJpg(bytes); } catch { img = null; } }
        if (img) {
          const s = (st.scale || 60) / 100;
          const w = pw * s, h = (img.height / img.width) * w;
          const drawImg = () => page.drawImage(img, {
            x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h,
            opacity: st.opacity ?? 0.18, rotate: degrees(st.angle || 0),
            xOrigin: pw / 2, yOrigin: ph / 2,
          });
          // Raster watermarks are always drawn directly (still visible over white page bg).
          drawImg();
        }
      }
    } else {
      const txt = expandTokens(st.text || 'DRAFT', ctx);
      const size = st.fontSize || 52;
      const push = () => page.drawText(txt, {
        x: pw / 2, y: ph / 2, size, font, color: col,
        opacity: st.opacity ?? 0.16, rotate: degrees(st.angle ?? -45),
        xOrigin: pw / 2, yOrigin: ph / 2,
      });
      if (behind) {
        const w = font.widthOfTextAtSize(txt, size);
        const rad = ((st.angle ?? -45) * Math.PI) / 180;
        const bx = pw / 2 - (w / 2) * Math.cos(rad), by = ph / 2 - (w / 2) * Math.sin(rad) - size * 0.3;
        const content = `q BT /${font.name} ${n(size)} Tf ${n(col.red)} ${n(col.green)} ${n(col.blue)} rg ` +
          `${n(Math.cos(rad))} ${n(Math.sin(rad))} ${n(-Math.sin(rad))} ${n(Math.cos(rad))} ${n(bx)} ${n(by)} Tm (${txt.replace(/([\\()])/g, '\\$1')}) Tj ET Q`;
        const ref = makeFormXObject(doc, content, [0, 0, pw, ph], { Font: { [font.name]: font.ref } });
        prependContent(doc, page, ref);
      } else push();
    }
    return;
  }

  // header / footer / bates
  const margin = st.margin ?? 28;
  const size = st.fontSize || 10;
  const isFooter = st.kind === 'footer' || st.kind === 'bates';
  const y = isFooter ? margin : ph - margin - size;
  const parts = st.parts && st.parts.length
    ? st.parts
    : [{ text: st.text || '', align: st.align || 'left' }];

  let content = 'q ';
  for (const part of parts) {
    const txt = expandTokens(part.text || '', ctx);
    if (!txt) continue;
    const w = font.widthOfTextAtSize(txt, size);
    let x = margin;
    if (part.align === 'center') x = (pw - w) / 2;
    else if (part.align === 'right') x = pw - margin - w;
    content += `BT /${font.name} ${n(size)} Tf ${n(col.red)} ${n(col.green)} ${n(col.blue)} rg ` +
      `1 0 0 1 ${n(x)} ${n(y)} Tm (${txt.replace(/([\\()])/g, '\\$1')}) Tj ET `;
  }
  content += 'Q';

  if (behind) {
    const ref = makeFormXObject(doc, content, [0, 0, pw, ph], { Font: { [font.name]: font.ref } });
    prependContent(doc, page, ref);
  } else {
    for (const part of parts) {
      const txt = expandTokens(part.text || '', ctx);
      if (!txt) continue;
      const w = font.widthOfTextAtSize(txt, size);
      let x = margin;
      if (part.align === 'center') x = (pw - w) / 2;
      else if (part.align === 'right') x = pw - margin - w;
      page.drawText(txt, { x, y, size, font, color: col, opacity: st.opacity ?? 1 });
    }
  }
}

function textOp(font, text, o) {
  const size = o.size || 12;
  const c = o.color || rgb(0, 0, 0);
  const rad = o.rotate ? (o.rotate.angle * Math.PI) / 180 : 0;
  const tm = rad
    ? `${n(Math.cos(rad))} ${n(Math.sin(rad))} ${n(-Math.sin(rad))} ${n(Math.cos(rad))} ${n(o.x)} ${n(o.y)}`
    : `1 0 0 1 ${n(o.x)} ${n(o.y)}`;
  return `q BT /${font.name} ${n(size)} Tf ${n(c.red)} ${n(c.green)} ${n(c.blue)} rg ${tm} Tm (${String(text).replace(/([\\()])/g, '\\$1')}) Tj ET Q`;
}
function rectOp(o) {
  const c = o.color || rgb(0, 0, 0);
  return `q ${n(c.red)} ${n(c.green)} ${n(c.blue)} rg ${n(o.x)} ${n(o.y)} ${n(o.width)} ${n(o.height)} re f Q`;
}

/* ── Main build ─────────────────────────────────────────────────────────── */

/**
 * Build the output PDF for a document.
 * opts: { password, permissions, flatten }
 */
export async function buildPdf(doc, opts = {}) {
  // An encrypted source must be decrypted before it can be rewritten, or
  // pdf-lib throws EncryptedPDFError on every save. `doc.password` is the
  // password captured at open — an empty string for owner-password-only files,
  // which pdf.js opens without ever prompting, so `!= null` matters here.
  const src = await PDFDocument.load(doc.bytes.slice(0), {
    updateMetadata: false,
    ...(doc.password != null ? { password: doc.password } : {}),
  });
  let target = src;
  let indexMap = null;      // oldIndex -> newIndex
  let pageList = null;      // [{kind, ...}] describing final layout

  if (doc.pageOps && doc.pageOps.items) {
    const out = await PDFDocument.create();
    const items = doc.pageOps.items;
    const srcPages = src.getPages();
    indexMap = new Map();
    pageList = [];
    for (const it of items) {
      if (it.t === 'src') {
        const copied = await out.copyPages(src, [it.i]);
        const p = out.addPage(copied[0]);
        const origRot = srcPages[it.i].getRotation().angle || 0;
        const delta = (doc.pageRotate?.[it.i] || 0);
        p.setRotation(degrees((origRot + delta + 360) % 360));
        indexMap.set(it.i, out.getPageCount() - 1);
        pageList.push({ t: 'src', i: it.i, newIndex: out.getPageCount() - 1 });
      } else if (it.t === 'file') {
        try {
          const other = await PDFDocument.load(it.bytes.slice(0), { updateMetadata: false });
          const idxs = (it.pages && it.pages.length) ? it.pages : other.getPageIndices();
          const copied = await out.copyPages(other, idxs);
          for (const p of copied) out.addPage(p);
        } catch (e) { console.warn('insert file failed', e); }
      } else if (it.t === 'image') {
        const bytes = dataUrlBytes(it.dataUrl) || it.bytes;
        if (bytes) {
          let img = null;
          try { img = await out.embedPng(bytes); } catch { try { img = await out.embedJpg(bytes); } catch { img = null; } }
          if (img) {
            const pw = it.w || 595.28, ph = it.h || 841.89;
            const s = Math.min(pw / img.width, ph / img.height) * (it.fill ? 1.04 : 1);
            const w = img.width * s, h = img.height * s;
            const p = out.addPage([pw, ph]);
            p.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
          }
        }
      } else if (it.t === 'blank') {
        out.addPage([it.w || 595.28, it.h || 841.89]);
      } else if (it.t === 'raster') {
        const canvas = await renderRedactedPage(doc, it.i, it.rects, it.dpi || 200);
        const jpg = await renderFilteredJpeg(canvas, it.filter, it.quality ?? doc.compressQuality);
        const img = await out.embedJpg(jpg);
        const dims = doc.pageSizes[it.i];
        // Match renderRedactedPage(): intrinsic /Rotate + user delta decides the swap.
        const intrinsic = src.getPage(it.i).getRotation().angle || 0;
        const rot = (((intrinsic + (doc.pageRotate?.[it.i] || 0)) % 360) + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const pw = swap ? dims.h : dims.w, ph = swap ? dims.w : dims.h;
        const p = out.addPage([pw, ph]);
        p.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        indexMap.set(it.i, out.getPageCount() - 1);
        pageList.push({ t: 'raster', i: it.i, newIndex: out.getPageCount() - 1 });
      } else if (it.t === 'scaled') {
        /* Scale (Documents ▸ Scale Pages). We copy the page and let pdf-lib's
           own page.scale() resize it, rather than re-embedding it as a Form
           XObject. Two reasons:

           1. embedPdf() *lazily* rejects a page with no /Contents — the
              exception surfaces at save() time, not at the await, so no
              try/catch here can catch it. A single blank page would abort the
              whole build. copyPages()+scale() has no such trap: a page without
              /Contents is a legal blank page, and scaleContent() is a no-op on
              it (wrapContentStreams() only touches array Contents).
           2. copyPages() carries /Annots, /Rotate and inherited /Resources
              over, exactly like the plain 'src' branch — so a scaled page
              keeps the comments and widgets it had before. embedPdf() drops
              them both. */
        const sx = it.sx == null ? 1 : it.sx, sy = it.sy == null ? 1 : it.sy;
        let ok = false;
        try {
          const copied = await out.copyPages(src, [it.i]);
          const p = out.addPage(copied[0]);
          if (sx !== 1 || sy !== 1) p.scale(sx, sy);
          indexMap.set(it.i, out.getPageCount() - 1);
          pageList.push({ t: 'src', i: it.i, newIndex: out.getPageCount() - 1 });
          ok = true;
        } catch (e) {
          console.warn('scaled copy failed, emitting a blank page', it.i, e);
        }
        if (!ok) {
          // Last resort: never let one unusable page cost the user the build.
          const s0 = srcPages[it.i].getSize();
          out.addPage([s0.width * sx, s0.height * sy]);
          indexMap.set(it.i, out.getPageCount() - 1);
          pageList.push({ t: 'src', i: it.i, newIndex: out.getPageCount() - 1 });
        }
      } else if (it.t === 'scaled-file') {
        try {
          const other = await PDFDocument.load(it.bytes.slice(0), { updateMetadata: false });
          const idxs = (it.pages && it.pages.length) ? it.pages : other.getPageIndices();
          const embedded = await out.embedPdf(other, idxs);
          for (const ep of embedded) {
            const w = ep.width * (it.sx == null ? 1 : it.sx);
            const h = ep.height * (it.sy == null ? 1 : it.sy);
            const p = out.addPage([w, h]);
            p.drawPage(ep, { x: 0, y: 0, width: w, height: h });
          }
        } catch (e) { console.warn('scaled file failed', e); }
      } else if (it.t === 'scaled-raster') {
        const canvas = await renderRedactedPage(doc, it.i, it.rects, it.dpi || 200);
        const jpg = await renderFilteredJpeg(canvas, it.filter, it.quality ?? doc.compressQuality);
        const img = await out.embedJpg(jpg);
        const dims = doc.pageSizes[it.i];
        const intrinsic = src.getPage(it.i).getRotation().angle || 0;
        const rot = (((intrinsic + (doc.pageRotate?.[it.i] || 0)) % 360) + 360) % 360;
        const swap = rot === 90 || rot === 270;
        const pw = (swap ? dims.h : dims.w) * (it.sx == null ? 1 : it.sx);
        const ph = (swap ? dims.w : dims.h) * (it.sy == null ? 1 : it.sy);
        const p = out.addPage([pw, ph]);
        p.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
        indexMap.set(it.i, out.getPageCount() - 1);
        pageList.push({ t: 'raster', i: it.i, newIndex: out.getPageCount() - 1 });
      } else if (it.t === 'scaled-image') {
        const bytes = dataUrlBytes(it.dataUrl) || it.bytes;
        if (bytes) {
          let img = null;
          try { img = await out.embedPng(bytes); } catch { try { img = await out.embedJpg(bytes); } catch { img = null; } }
          if (img) {
            const pw = it.w || 595.28, ph = it.h || 841.89;
            const p = out.addPage([pw, ph]);
            p.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
          }
        }
      } else if (it.t === 'scaled-blank') {
        out.addPage([it.w || 595.28, it.h || 841.89]);
      }
    }
    if (!out.getPageCount()) out.addPage([595.28, 841.89]);
    target = out;
  } else {
    // In-place: apply persistent page rotations.
    const pages = target.getPages();
    pages.forEach((p, i) => {
      const delta = doc.pageRotate?.[i] || 0;
      if (delta) p.setRotation(degrees(((p.getRotation().angle || 0) + delta + 360) % 360));
    });
  }

  const pages = target.getPages();

  /* Layer refs: one OCG per model layer (existing file OCGs are matched by
     /Name; session-only layers are minted here). Everything layer-assigned
     below wraps against this map, and the catalog OCProperties is written
     from it just before the save. */
  const L = ensureLayerRefs(target, doc, pages);

  /* Overlay (Stirling "Overlay PDFs"): stamp the pages of another document on
     top of — or underneath — this one. Positioning is in PDF user space, so
     existing annotations, stamps and text edits keep their coordinates and the
     underlay mode keeps the original page visible on top. */
  if (doc.overlay) await applyOverlay(doc, target, pages, indexMap);

  /* Crops (Foxit Organize > Crop Pages): the kept region becomes the page's
     CropBox, so the content outside is hidden without being destroyed. */
  for (const [key, r] of Object.entries(doc.crops || {})) {
    const idx = indexMap ? indexMap.get(Number(key)) : Number(key);
    const p = pages[idx];
    if (!p) continue;
    try {
      const size = p.getSize();
      const x = clamp(Math.min(r[0], r[2]), 0, size.width);
      const y = clamp(Math.min(r[1], r[3]), 0, size.height);
      const w = clamp(Math.abs(r[2] - r[0]), 1, Math.max(1, size.width - x));
      const h = clamp(Math.abs(r[3] - r[1]), 1, Math.max(1, size.height - y));
      p.setCropBox(x, y, w, h);
    } catch (e) { console.warn('crop failed', idx, e); }
  }

  /* Recognised text becomes a real (invisible) text layer in the saved file,
     which is what "Recognize Text" means in Acrobat: the scan is now
     searchable, selectable and readable by a screen reader. Render mode 3
     draws nothing, so the image underneath is untouched. */
  await applyOcrLayer(doc, target, pages, indexMap);

  /* Text edits — object-owned model. Each edit's owned source operators are
     REMOVED (not covered) where that is safe, and the replacement is inserted;
     a cover wash remains only as the fallback for pages whose glyphs are
     pixels or live in a shared Form XObject. */
  for (const e of doc.textEdits || []) {
    const idx = indexMap ? indexMap.get(e.page) : e.page;
    if (idx == null || !pages[idx]) continue;
    await applyTextEdit(target, pages[idx], e, { pageIndex: idx, pages, indexMap, oc: L });
  }

  /* Stamps (watermarks, header/footer, Bates) */
  const stampCtx = {
    pages: pages.length,
    date: new Date().toLocaleDateString(),
    time: new Date().toLocaleTimeString(),
    filename: doc.name || 'document.pdf',
    author: opts.author || '',
  };
  for (const st of doc.stamps || []) {
    const from = Math.max(1, st.from || 1), to = Math.min(pages.length, st.to || pages.length);
    const start = st.start ?? 1, step = st.step ?? 1, pad = st.pad ?? 4;
    for (let p = from - 1; p < to; p++) {
      if (st.odd === 'odd' && (p + 1) % 2 === 0) continue;
      if (st.odd === 'even' && (p + 1) % 2 === 1) continue;
      const bates = String(start + (p - (from - 1)) * step).padStart(pad, '0');
      const ctxP = { ...stampCtx, page: p + 1, bates };
      await applyStamp(target, pages[p], st, ctxP);
    }
  }

  /* New form fields requested by the user */
  if (doc.newFields && doc.newFields.length) {
    try {
      const form = target.getForm();
      for (const nf of doc.newFields) {
        const idx = indexMap ? indexMap.get(nf.page) : nf.page;
        const page = pages[idx];
        if (!page) continue;
        const [x, y, x2, y2] = nf.rect;
        const box = { x: Math.min(x, x2), y: Math.min(y, y2), width: Math.abs(x2 - x), height: Math.abs(y2 - y) };
        try {
          if (nf.type === 'checkbox') form.createCheckBox(nf.name).addToPage(page, box);
          else if (nf.type === 'radio') {
            const rg = form.createRadioGroup(nf.name);
            (nf.options || ['Yes', 'No']).forEach((o) => rg.addOptionToPage(o, page, box));
          } else if (nf.type === 'dropdown') {
            const dd = form.createDropdown(nf.name);
            dd.addOptions(nf.options || ['Option 1', 'Option 2']);
            dd.addToPage(page, box);
          } else if (nf.type === 'signature') {
            try { addSignatureField(target, form, nf.name, page, box); }
            catch (e) { console.warn('signature field failed, using text field', e); form.createTextField(nf.name).addToPage(page, box); }
          }
          else form.createTextField(nf.name).addToPage(page, box);
        } catch (e) { console.warn('field create failed', nf.name, e); }
      }
    } catch (e) { console.warn('form creation failed', e); }
  }

  /* Annotations */
  /* A direct edit whose replacement was drawn into the PAGE CONTENT must not
     also be saved as its paired /FreeText box. Writing both would put the same
     words in the annotation layer as well, and an annotation is invisible to a
     text search, a screen reader and copy-paste — so the file would show the new
     text without containing it, which is the very lie this rewrite removes.
     `FreeText` is in MANAGED_SUBTYPES, so the box's old byte-ref is not
     preserved either: the annotation genuinely leaves the file. The box stays in
     the model (doc.annots) so the edit is still draggable and re-editable on
     screen until the next save round-trip. */
  const contentBoxes = new Set();
  for (const e of doc.textEdits || []) {
    if (e.boxId && e.removal === 'excise') contentBoxes.add(e.boxId);
  }
  const byPage = new Map();
  for (const a of doc.annots || []) {
    if (contentBoxes.has(a.id)) continue;
    if (a.type === 'redact' && a.applied && !opts.flatten) {
      // Applied redactions become flat black boxes.
      const idx = indexMap ? indexMap.get(a.page) : a.page;
      if (idx == null || !pages[idx]) continue;
      const r = a.rect;
      pages[idx].drawRectangle({
        x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]),
        width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]),
        color: rgb(0, 0, 0), borderWidth: 0,
      });
      continue;
    }
    const idx = indexMap ? indexMap.get(a.page) : a.page;
    if (idx == null) continue;
    if (!byPage.has(idx)) byPage.set(idx, []);
    byPage.get(idx).push(a);
  }
  for (const [idx, list] of byPage) {
    const page = pages[idx];
    if (!page) continue;
    const keep = widgetRefs(target, page);
    const refs = [];
    for (const a of list) {
      try { refs.push(await writeAnnotation(target, page, a, L)); } catch (e) { console.warn('annot write failed', a.type, e); }
    }
    // Preserve original annotations our model does NOT manage (links,
    // polygons, file attachments, …) so they survive a save. Annotations our
    // model owns are recreated from `refs`, so we must NOT also keep their
    // originals — that would duplicate them or resurrect deleted ones.
    const markup = [];
    const annots = page.node.Annots();
    if (annots && typeof annots.asArray === 'function') {
    for (const ref of annots.asArray()) {
      try {
        const d = target.context.lookup(ref);
        const sub = d && d.get && d.get(PDFName.of('Subtype'));
        const subName = sub && (sub.asName?.() || (sub.asString && sub.asString()?.replace(/^\//, '')));
        if (!subName || subName === 'Widget') continue;   // widgets kept via `keep`
        if (MANAGED_SUBTYPES.has(subName)) continue;      // recreated from model
        // Skip our own generated annotations: they are recreated from the model,
        // so also keeping the old byte-ref would duplicate them every save.
        const nm = d.get && d.get(PDFName.of('NM'));
        const nmStr = nm && (nm.asString?.() || (nm.asBytes && String(nm.asBytes())));
        if (nmStr && OWNED_NM.test(nmStr)) continue;
        markup.push(ref);
      } catch { /* skip unreadable ref */ }
    }
    }
    setAnnots(target, page, [...keep, ...markup, ...refs]);
  }

  /* Attachments — buildPdf rebuilds the file from scratch, so the embedded
     files live in the model and are re-attached here (Foxit Attachments).
     opts.sanitize (Stirling Sanitize) skips them: attachments are a malware
     and exfiltration vector, and sanitize means "no embedded files". */
  if (!opts.sanitize) {
    try {
      for (const att of doc.attachments || []) {
        if (!att.data || !att.data.length) continue;
        target.attach(att.data, att.filename, att.description ? { description: att.description } : {});
      }
    } catch (e) { console.warn('attachment write failed', e); }
  }

  /* Form values — skipped under sanitize (values can leak PII), flattened
     under opts.flattenForm (Stirling Flatten: no interactive layer left). */
  if (!opts.sanitize) {
    try {
      const form = target.getForm();
      for (const f of doc.fields || []) {
        if (!f.name || f.value == null) continue;
        const field = form.getFieldMaybe(f.name);
        if (!field) continue;
        if (typeof field.setText === 'function' && !field.isReadOnly) { try { field.setText(String(f.value)); } catch {} }
        else if (typeof field.check === 'function') { try { String(f.value) === 'true' || f.value === true ? field.check() : field.uncheck(); } catch {} }
        else if (typeof field.select === 'function') { try { field.select(String(f.value)); } catch {} }
      }
      if (opts.flattenForm) {
        try { form.flatten(); } catch (e) { console.warn('form flatten failed', e); }
      }
    } catch { /* no AcroForm */ }
  }

  /* Embedded JavaScript — AiPDF never executes it, but files can carry it
     (document /OpenAction, /Names /JavaScript, page /AA). Stirling's
     Sanitize strips it; do the same on a best-effort basis — every step is
     guarded so an unfamiliar dictionary shape can never abort the save. */
  if (opts.sanitize) {
    try { stripDocumentJavascript(target); } catch (e) { console.warn('js strip failed', e); }
  }

  /* Optional-content layers — the model's layer list becomes the catalog's
     OCProperties (written after all content so wrapped /OC references resolve). */
  writeOCProperties(target, doc, L);

  /* Metadata — sanitize clears identifying fields (Stirling Sanitize). */
  if (opts.sanitize) {
    try {
      target.setTitle('');
      target.setAuthor('');
      target.setSubject('');
      target.setKeywords([]);
      target.setCreator('');
    } catch { /* ignore */ }
  } else {
    const meta = doc.meta || {};
    if (meta.title !== undefined) target.setTitle(meta.title || '');
    if (meta.author !== undefined) target.setAuthor(meta.author || '');
    if (meta.subject !== undefined) target.setSubject(meta.subject || '');
    if (meta.keywords !== undefined) target.setKeywords(meta.keywords ? [].concat(meta.keywords) : []);
    if (meta.creator) target.setCreator(meta.creator);
  }
  target.setProducer('AiPDF Editor');
  target.setModificationDate(new Date());

  /* Encryption — AES-256 by default (ISO 32000-2 recommended cipher). */
  if (opts.password || opts.ownerPassword) {
    try {
      target.encrypt({
        userPassword: opts.password || '',
        ownerPassword: opts.ownerPassword || opts.password || '',
        algorithm: opts.algorithm || 'AES-256',
        permissions: {
          printing: opts.permissions?.printing ?? 'highResolution',
          modifying: opts.permissions?.modifying ?? false,
          copying: opts.permissions?.copying ?? false,
          annotating: opts.permissions?.annotating ?? true,
          fillingForms: opts.permissions?.fillingForms ?? true,
          contentAccessibility: opts.permissions?.contentAccessibility ?? true,
          documentAssembly: opts.permissions?.documentAssembly ?? false,
        },
      });
    } catch (e) {
      console.warn('encryption failed', e);
      throw new Error(`Encryption failed: ${e.message}`);
    }
  }

  return await target.save({ useObjectStreams: true, addDefaultPage: false });
}/* ── Redaction rasterisation (true removal) ─────────────────────────────── */

async function renderRedactedPage(doc, i, rects, dpi) {
  const canvas = await renderPageToCanvas(i, dpi);
  const ctx = canvas.getContext('2d');
  const dims = doc.pageSizes[i];
  // Same combined rotation renderPageToCanvas() (viewer.js) uses: the page's
  // intrinsic /Rotate plus the user delta, normalised to [0, 360). Deriving
  // the swap from the delta alone misplaces boxes on intrinsically rotated pages.
  let intrinsic = 0;
  try { intrinsic = (await doc.pdf.getPage(i + 1)).rotate || 0; } catch { /* no proxy: delta only */ }
  const rot = (((intrinsic + (doc.pageRotate?.[i] || 0)) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const pw = swap ? dims.h : dims.w, ph = swap ? dims.w : dims.h;
  const s = dpi / 72;
  ctx.fillStyle = '#000';
  for (const r of rects || []) {
    // PDF rect (y up) → canvas (y down)
    const x = Math.min(r[0], r[2]) * s;
    const yTop = ph - Math.max(r[1], r[3]);
    ctx.fillRect(x, yTop * s, Math.abs(r[2] - r[0]) * s, Math.abs(r[3] - r[1]) * s);
  }
  return canvas;
}

function canvasToJpegBytes(canvas, quality = 0.92) {
  const q = Number.isFinite(Number(quality)) ? Math.min(0.95, Math.max(0.3, Number(quality))) : 0.92;
  const dataUrl = canvas.toDataURL('image/jpeg', q);
  const i = dataUrl.indexOf(',');
  const bin = atob(dataUrl.slice(i + 1));
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

/**
 * canvasToJpegBytes(), but with an optional CSS colour filter applied through
 * an intermediate canvas. Used by Adjust Colors (contrast, invert, scanner
 * effect …) and by Compress, which downsamples at the same time.
 *
 * Applying the filter on a copy is deliberate: mutating the rendered canvas in
 * place would leave a tinted thumbnail in the view.
 *
 * `quality` is honoured on BOTH paths — the old code dropped it on the
 * filtered path, so Compress never actually shrank filtered pages. */
function renderFilteredJpeg(canvas, filter, quality = 0.92) {
  const q = Number.isFinite(Number(quality)) ? Math.min(0.95, Math.max(0.3, Number(quality))) : 0.92;
  if (!filter) return canvasToJpegBytes(canvas, q);
  const copy = document.createElement('canvas');
  copy.width = canvas.width;
  copy.height = canvas.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return canvasToJpegBytes(canvas, q);
  ctx.filter = filter;
  ctx.drawImage(canvas, 0, 0);
  return canvasToJpegBytes(copy, q);
}

/** JPEG quality for a raster op: per-op override, else the document default
 *  set by Compress, else the long-standing 0.92. */
function rasterQuality(doc, it) {
  const q = it && it.quality != null ? Number(it.quality) : Number(doc && doc.compressQuality);
  if (Number.isFinite(q)) return Math.min(0.95, Math.max(0.3, q));
  return 0.92;
}

/* ── Secondary builders ─────────────────────────────────────────────────── */

/**
 * Overlay the pages of another document onto this one — Stirling's "Overlay
 * PDFs". A single overlay page is reused for every target page, which is what
 * letterheads, stamps and templates need; passing several pages cycles them.
 *
 * Uses pdf-lib's `embedPdf()` + `page.drawPage()`, which converts the source
 * page into a form XObject of its own content stream. `drawPage()` appends to
 * the page's stream, so the overlay lands on top — which is what "overlay"
 * means. (To place it underneath, embed the target page's content instead and
 * draw *that* on a fresh page; not needed for this feature.)
 *
 * doc.overlay = { bytes, pages: number[], x, y, scale, opacity, fit }
 */
async function applyOverlay(doc, target, pages, indexMap) {
  const ov = doc.overlay;
  if (!ov || !ov.bytes) return 0;
  let source = null;
  try {
    source = await PDFDocument.load(ov.bytes.slice(0), { updateMetadata: false });
  } catch (e) {
    console.warn('overlay source could not be parsed', e);
    return 0;
  }

  const wanted = (ov.pages && ov.pages.length)
    ? ov.pages.slice().sort((a, b) => a - b)
    : source.getPageIndices();
  if (!wanted.length) return 0;

  // Embed once per distinct overlay page: the XObject is reusable across every
  // target page, so a 30-page document still costs a single conversion.
  const embeddedCache = new Map();
  const embedFor = async (srcIndex) => {
    if (!embeddedCache.has(srcIndex)) {
      embeddedCache.set(srcIndex, target.embedPdf(source, [srcIndex]).then((r) => r[0]));
    }
    try { return await embeddedCache.get(srcIndex); }
    catch (e) { console.warn('overlay embed failed', srcIndex, e); return null; }
  };

  const scale = ov.scale == null ? 1 : (Number(ov.scale) > 0 ? Number(ov.scale) : 1);
  const opacity = ov.opacity == null ? 1 : clamp(Number(ov.opacity), 0.02, 1);
  const xOff = Number(ov.x) || 0;
  const yOff = Number(ov.y) || 0;

  let applied = 0;
  for (let i = 0; i < pages.length; i++) {
    const page = pages[indexMap ? indexMap.get(i) ?? i : i];
    const srcIndex = wanted[i % wanted.length];
    if (!page || srcIndex == null) continue;
    const embedded = await embedFor(srcIndex);
    if (!embedded) continue;
    try {
      const opts = { x: xOff, y: yOff, xScale: scale, yScale: scale, opacity };
      if (ov.fit) {
        const { width, height } = embedded;
        const size = page.getSize();
        opts.width = Math.min(size.width, (width / height) * size.height);
        opts.height = Math.min(size.height, (height / width) * size.width);
      }
      page.drawPage(embedded, opts);
      applied++;
    } catch (e) {
      console.warn('overlay failed on page', i + 1, e);
    }
  }
  return applied;
}

export async function buildExtract(doc, indices) {
  const src = await PDFDocument.load(doc.bytes.slice(0), {
    updateMetadata: false,
    ...(doc.password != null ? { password: doc.password } : {}),
  });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach((p, k) => {
    out.addPage(p);
    const delta = doc.pageRotate?.[indices[k]] || 0;
    if (delta) p.setRotation(degrees(((src.getPage(indices[k]).getRotation().angle || 0) + delta + 360) % 360));
  });
  // Layers survive an extract: the copied pages reference copied OCG dicts,
  // but the fresh catalog has no OCProperties — without this the reader
  // would not offer the layers any more. Extracted layers default to visible.
  try {
    const found = collectOcgRefs(out, pages);
    if (found.size) {
      const refs = [...found.values()];
      const d = obj(out, {});
      d.set(PDFName.of('ON'), obj(out, refs));
      d.set(PDFName.of('Order'), obj(out, refs));
      const ocp = obj(out, {});
      ocp.set(PDFName.of('OCGs'), obj(out, refs));
      ocp.set(PDFName.of('D'), d);
      out.catalog.set(PDFName.of('OCProperties'), out.context.register(ocp));
    }
  } catch { /* layers are best-effort in extracts */ }
  return await out.save({ useObjectStreams: true });
}

export async function buildMerge(byteLists) {
  const out = await PDFDocument.create();
  for (const bytes of byteLists) {
    const src = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return await out.save({ useObjectStreams: true });
}

export async function buildBlank(width = 595.28, height = 841.89) {
  const out = await PDFDocument.create();
  out.addPage([width, height]);
  return await out.save({ useObjectStreams: true });
}

export async function buildFromImages(images) {
  const out = await PDFDocument.create();
  for (const { bytes, w, h } of images) {
    let img = null;
    try { img = await out.embedPng(bytes); } catch { try { img = await out.embedJpg(bytes); } catch { img = null; } }
    if (!img) continue;
    const pw = w || 595.28, ph = h || 841.89;
    const s = Math.min(pw / img.width, ph / img.height);
    const iw = img.width * s, ih = img.height * s;
    const p = out.addPage([pw, ph]);
    p.drawImage(img, { x: (pw - iw) / 2, y: (ph - ih) / 2, width: iw, height: ih });
  }
  return await out.save({ useObjectStreams: true });
}

/* ── Stirling layout builders (raster-composed, DOM-supplied renderer) ────
 *
 * N-up / booklet / poster / single-strip all compose rendered page bitmaps
 * onto new sheets and re-embed them as images. That is deliberate: the
 * vector alternative (embedPdf + drawPage) fails lazily on pages without
 * /Contents and drops /Annots + /Rotate (see README "Why the scaling op is
 * not a Form XObject"), so one blank page would abort the whole build.
 * Raster composition cannot fail that way; the tradeoff (text becomes
 * non-selectable on the new sheets) is stated in every dialog.
 *
 * `renderFn(i, dpi)` renders source page i to a canvas. In the app it is
 * V.renderPageToCanvas; tests never call these builders (they need DOM). */

function canvasToPngBytes(canvas) {
  const dataUrl = canvas.toDataURL('image/png');
  const i = dataUrl.indexOf(',');
  const bin = atob(dataUrl.slice(i + 1));
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

async function embedCanvas(out, canvas, jpegQuality = 0.85) {
  // JPEG for photos/scans (small), PNG fallback for blank/line-art pages
  // where JPEG artefacts would be visible.
  try {
    const jpg = canvasToJpegBytes(canvas, jpegQuality);
    return await out.embedJpg(jpg);
  } catch {
    return await out.embedPng(canvasToPngBytes(canvas));
  }
}

/** Tile source pages onto sheets per an nupPlan(). */
export async function buildNup(plan, sizes, renderFn, { dpi = 150, quality = 0.85, paper = null } = {}) {
  const out = await PDFDocument.create();
  const sheetW = paper ? paper[0] : Math.max(...sizes.map((s) => s?.w || 595.28));
  const sheetH = paper ? paper[1] : Math.max(...sizes.map((s) => s?.h || 841.89));
  for (const sheet of plan.sheets || []) {
    const cellW = sheetW / plan.cols, cellH = sheetH / plan.rows;
    const cv = document.createElement('canvas');
    const s = dpi / 72;
    cv.width = Math.max(8, Math.round(sheetW * s));
    cv.height = Math.max(8, Math.round(sheetH * s));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (let k = 0; k < sheet.length; k++) {
      const src = sheet[k];
      if (src == null || src < 0) continue;
      try {
        const srcCanvas = await renderFn(src, dpi);
        const cx = (k % plan.cols) * cellW * s;
        const cy = Math.floor(k / plan.cols) * cellH * s;
        // Contain the page bitmap in its cell with a small gutter.
        const g = 3 * s;
        const dw = cellW * s - g * 2, dh = cellH * s - g * 2;
        const fit = Math.min(dw / srcCanvas.width, dh / srcCanvas.height);
        const w = srcCanvas.width * fit, h = srcCanvas.height * fit;
        ctx.drawImage(srcCanvas, cx + (cellW * s - w) / 2, cy + (cellH * s - h) / 2, w, h);
      } catch (e) { console.warn('nup tile failed', src, e); }
    }
    const img = await embedCanvas(out, cv, quality);
    const p = out.addPage([sheetW, sheetH]);
    p.drawImage(img, { x: 0, y: 0, width: sheetW, height: sheetH });
  }
  if (!out.getPageCount()) out.addPage([595.28, 841.89]);
  return await out.save({ useObjectStreams: true });
}

/** Stack every page into one long strip per a singlePagePlan(). */
export async function buildSingleStrip(strip, renderFn, { dpi = 150, quality = 0.85 } = {}) {
  const out = await PDFDocument.create();
  const s = dpi / 72;
  const cv = document.createElement('canvas');
  cv.width = Math.max(8, Math.round(strip.width * s));
  cv.height = Math.max(8, Math.round(strip.height * s));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  for (const pl of strip.placements || []) {
    try {
      const srcCanvas = await renderFn(pl.page, dpi);
      const yTopPt = strip.height - pl.y - pl.h; // PDF y-up → canvas y-down
      ctx.drawImage(srcCanvas, 0, yTopPt * s, cv.width, pl.h * s);
    } catch (e) { console.warn('strip tile failed', pl.page, e); }
  }
  // A single strip can exceed viewer texture limits; cap the canvas height.
  const img = await embedCanvas(out, cv, quality);
  const MAX_H = 14400; // 200in — pdf viewers paginate beyond this anyway
  const h = Math.min(strip.height, MAX_H);
  const p = out.addPage([strip.width, h]);
  p.drawImage(img, { x: 0, y: 0, width: strip.width, height: strip.height });
  return await out.save({ useObjectStreams: true });
}

/** Split one rendered page into cols×rows tiles, one output page each. */
export async function buildPoster(pageIndex, cols, rows, renderFn, { dpi = 200, quality = 0.88 } = {}) {
  const c = Math.min(8, Math.max(1, Math.floor(cols) || 2));
  const r = Math.min(8, Math.max(1, Math.floor(rows) || 2));
  const src = await renderFn(pageIndex, dpi);
  const out = await PDFDocument.create();
  const tw = src.width / c, th = src.height / r;
  for (let y = 0; y < r; y++) {
    for (let x = 0; x < c; x++) {
      const cv = document.createElement('canvas');
      cv.width = Math.max(8, Math.round(tw));
      cv.height = Math.max(8, Math.round(th));
      cv.getContext('2d').drawImage(src, x * tw, y * th, tw, th, 0, 0, cv.width, cv.height);
      const img = await embedCanvas(out, cv, quality);
      // Keep the tile's aspect: one tile fills one page of the same ratio.
      const pw = 595.28, ph = (595.28 * cv.height) / Math.max(1, cv.width);
      const p = out.addPage([pw, ph]);
      p.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
    }
  }
  return await out.save({ useObjectStreams: true });
}

/** Reorder rendered pages into booklet sheets per a bookletOrder(). */
export async function buildBooklet(order, renderFn, { dpi = 150, quality = 0.85, paper = null } = {}) {
  const out = await PDFDocument.create();
  const seq = [];
  for (const sh of order.sheets || []) {
    seq.push([sh.front[0], sh.front[1]]);
    seq.push([sh.back[0], sh.back[1]]);
  }
  for (const [left, right] of seq) {
    const leftCv = left >= 0 ? await renderFn(left, dpi).catch((e) => (console.warn('booklet tile failed', left, e), null)) : null;
    const rightCv = right >= 0 ? await renderFn(right, dpi).catch((e) => (console.warn('booklet tile failed', right, e), null)) : null;
    const half = leftCv || rightCv;
    if (!half) continue;
    const s = dpi / 72;
    const halfW = paper ? paper[0] / 2 : half.width / s / 2;
    const halfH = paper ? paper[1] : half.height / s;
    const cv = document.createElement('canvas');
    cv.width = Math.max(8, Math.round(halfW * 2 * s));
    cv.height = Math.max(8, Math.round(halfH * s));
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (leftCv) ctx.drawImage(leftCv, 0, 0, cv.width / 2, cv.height);
    if (rightCv) ctx.drawImage(rightCv, cv.width / 2, 0, cv.width / 2, cv.height);
    const img = await embedCanvas(out, cv, quality);
    const p = out.addPage([halfW * 2, halfH]);
    p.drawImage(img, { x: 0, y: 0, width: halfW * 2, height: halfH });
  }
  if (!out.getPageCount()) out.addPage([595.28, 841.89]);
  return await out.save({ useObjectStreams: true });
}

/**
 * Repair-by-re-encode (Stirling RepairController, writer half): copy every
 * page into a fresh document, skipping pages that fail. Returns { bytes,
 * copied, skipped }. Never throws for a partially readable file — an empty
 * result throws instead, so callers can distinguish "nothing salvageable". */
export async function buildRepaired(bytes, password = null) {
  const src = await PDFDocument.load(bytes.slice(0), { updateMetadata: false, ignoreEncryption: false, ...(password != null ? { password } : {}) });
  const out = await PDFDocument.create();
  let copied = 0;
  const skipped = [];
  const indices = src.getPageIndices();
  for (const i of indices) {
    try {
      const [p] = await out.copyPages(src, [i]);
      out.addPage(p);
      copied++;
    } catch (e) {
      console.warn('repair skipped page', i, e);
      skipped.push(i);
    }
  }
  if (!copied) throw new Error('No pages could be recovered from this file.');
  try {
    const meta = { title: src.getTitle(), author: src.getAuthor(), subject: src.getSubject() };
    if (meta.title) out.setTitle(meta.title);
    if (meta.author) out.setAuthor(meta.author);
    if (meta.subject) out.setSubject(meta.subject);
  } catch { /* metadata is best-effort */ }
  out.setProducer('AiPDF Editor (repaired)');
  return { bytes: await out.save({ useObjectStreams: true }), copied, skipped };
}

/** Best-effort removal of document-level JavaScript. Every lookup is
 *  guarded: an unfamiliar dictionary shape skips instead of aborting. */
function stripDocumentJavascript(target) {
  let removed = 0;
  try {
    const catalog = target.catalog;
    if (catalog) {
      for (const key of ['OpenAction', 'AA', 'JavaScript']) {
        try {
          if (catalog.has && catalog.has(PDFName.of(key))) { catalog.delete(PDFName.of(key)); removed++; }
        } catch { /* next key */ }
      }
      try {
        const names = catalog.lookup && catalog.lookup(PDFName.of('Names'));
        if (names && names.lookup) {
          const js = names.lookup(PDFName.of('JavaScript'));
          if (js && names.delete) { names.delete(PDFName.of('JavaScript')); removed++; }
        }
      } catch { /* names are optional */ }
    }
  } catch { /* catalog shape unknown */ }
  try {
    for (const page of target.getPages()) {
      try {
        if (page.node.has(PDFName.of('AA'))) { page.node.delete(PDFName.of('AA')); removed++; }
      } catch { /* next page */ }
    }
  } catch { /* pages unreadable */ }
  return removed;
}

/* ── Introspection ──────────────────────────────────────────────────────── */

/**
 * True when these bytes are an encrypted PDF. The open flow cannot rely on the
 * password prompt alone: pdf.js opens owner-password-only files silently, so
 * the only reliable signal is asking the writer, which is what has to load them.
 */
export async function probeEncryption(bytes) {
  try {
    const d = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
    return !!d.isEncrypted;
  } catch (err) {
    const name = err && err.name ? String(err.name) : '';
    const msg = err && err.message ? String(err.message) : '';
    return name === 'EncryptedPDFError' || /encrypt/i.test(msg);
  }
}

export async function readMetadata(bytes) {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  return {
    pages: doc.getPageCount(),
    title: doc.getTitle() || '',
    author: doc.getAuthor() || '',
    subject: doc.getSubject() || '',
    keywords: (doc.getKeywords() || '').toString(),
    creator: doc.getCreator() || '',
    producer: doc.getProducer() || '',
    creationDate: doc.getCreationDate(),
    modificationDate: doc.getModificationDate(),
    encrypted: doc.isEncrypted,
    formFields: (() => { try { return doc.getForm().getFields().map((f) => f.getName()); } catch { return []; } })(),
  };
}

/**
 * Widgets live in a page's /Annots array, and pdf-lib does not expose the
 * owning page, so we build our own rect → page index map first.
 */
function widgetPageMap(doc) {
  const map = [];
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p++) {
    const annots = pages[p].node.Annots();
    if (!annots || typeof annots.asArray !== 'function') continue;
    for (const ref of annots.asArray()) {
      try {
        const d = doc.context.lookup(ref);
        const sub = d && d.get && d.get(PDFName.of('Subtype'));
        if (!sub || !(sub === PDFName.of('Widget') || sub.asString?.() === '/Widget')) continue;
        const rectArr = d.get(PDFName.of('Rect'));
        if (!rectArr || typeof rectArr.asArray !== 'function') continue;
        const r = rectArr.asArray().map((v) => Number(v.asNumber?.() ?? v));
        if (r.length < 4) continue;
        map.push({ page: p, rect: r, name: (d.get(PDFName.of('T'))?.asString?.() || '').replace(/^\(|\)$/g, '') });
      } catch { /* skip */ }
    }
  }
  return map;
}

function matchPage(map, rect, name) {
  if (name) {
    const hit = map.find((m) => m.name === name);
    if (hit) return hit.page;
  }
  let best = null, bestD = Infinity;
  for (const m of map) {
    const d = Math.abs(m.rect[0] - rect[0]) + Math.abs(m.rect[1] - rect[1]);
    if (d < bestD) { bestD = d; best = m; }
  }
  return best ? best.page : 0;
}

export async function readFormFields(bytes) {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false });
  try {
    const form = doc.getForm();
    const map = widgetPageMap(doc);
    return form.getFields().map((f) => {
      const ctor = f.constructor.name;
      const base = { name: f.getName(), type: ctor };
      try {
        if (typeof f.getText === 'function') base.value = f.getText() || '';
        if (typeof f.isChecked === 'function') base.checked = f.isChecked();
        if (typeof f.getOptions === 'function') base.options = f.getOptions();
        if (typeof f.getSelected === 'function') base.selected = f.getSelected();
      } catch { /* ignore */ }
      const widgets = [];
      try {
        for (const w of f.acroField.getWidgets()) {
          const r = w.getRectangle();
          const rect = [r.x, r.y, r.x + r.width, r.y + r.height];
          widgets.push({ page: matchPage(map, rect, base.name), rect });
        }
      } catch { /* ignore */ }
      base.widgets = widgets;
      return base;
    });
  } catch {
    return [];
  }
}
