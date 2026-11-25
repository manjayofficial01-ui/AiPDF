/**
 * Font intelligence — the "how do editors know which font this is?" pipeline
 * from the competitor research, applied locally:
 *
 *  1. Read embedded font resources (BaseFont names, encodings, descriptors)
 *     straight out of the PDF's page /Resources — no pixels involved.
 *  2. Report per page which fonts are used, whether they are embedded, and
 *     whether they are subsets (ABCDEF+ prefix) or fully available.
 *  3. Optionally extract the actual font program (FontFile2/FontFile3) so a
 *     font from the document can be REUSED for newly added text — the same
 *     trick Acrobat relies on when the original font is embedded.
 *  4. A user-supplied TTF/OTF can be registered as the font for new text.
 *
 * Extracted/registered fonts are consumed by pdfwrite.baseFont(), which
 * embeds them into the output via fontkit.
 */
import * as PL from '/v/pdf-lib.js';
import { settings, saveSettings } from './store.js';

const { PDFDocument, PDFName, PDFDict, PDFArray, decodePDFRawStream } = PL;

/* ── fontkit loader ─────────────────────────────────────────────────────── */

let fontkitPromise = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

export function getFontkit() {
  if (!fontkitPromise) {
    fontkitPromise = (async () => {
      if (window.fontkit) return window.fontkit;
      // regenerator-runtime first, and as a classic script: fontkit's GSUB
      // shaping path was transpiled against that global. Without it, every
      // complex-script font (Devanagari, Arabic, Indic) throws
      // "regeneratorRuntime is not defined" the moment it is embedded — which
      // is why those faces could never be used for replacement text.
      if (typeof globalThis.regeneratorRuntime === 'undefined') {
        await loadScript('/v/regenerator-runtime.js');
      }
      await loadScript('/v/fontkit.umd.min.js');
      if (!window.fontkit) throw new Error('fontkit failed to load');
      return window.fontkit;
    })();
    // Clear the memo on failure so a transient load error is retryable rather
    // than permanently poisoning every later font operation.
    fontkitPromise.catch(() => { fontkitPromise = null; });
  }
  return fontkitPromise;
}

/* ── Registry of fonts available for NEW text ───────────────────────────── */

const customFonts = new Map(); // alias -> { name, bytes, source, user }
let activeNewTextFont = '';

/** A single path segment, validated against the same shape main.js accepts. */
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function slugFileName(family, ext) {
  const base = String(family).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 96) || 'font';
  return `${base}.${ext === 'otf' ? 'otf' : 'ttf'}`;
}

let userDataDir = null;
async function fontDirPath() {
  if (userDataDir === null) userDataDir = String(await window.api.getPath('userData')).replace(/[\\/]+$/, '');
  return `${userDataDir}/fonts`;
}

/** Make the bytes render on screen as well as in the written PDF. */
async function addFontFace(family, bytes) {
  try {
    const face = new FontFace(family, bytes.slice(0).buffer);
    await face.load();
    document.fonts.add(face);
  } catch { /* the display fallback is fine; the PDF still embeds correctly */ }
}

export function registerCustomFont(alias, bytes, source) {
  customFonts.set(alias, { name: alias, bytes, source, user: false });
  activeNewTextFont = alias;
}
export function getCustomFont(family = '') {
  if (!family) return null;
  if (customFonts.has(family)) return customFonts.get(family);
  // "12pt ABCDEF+FontName" style prefixes and file names shouldn't block a match
  const bare = String(family).replace(/[A-Z]{6}\+/, '').replace(/\.(ttf|otf)$/i, '').trim();
  return customFonts.get(bare) || null;
}
export function activeCustomFont() {
  return activeNewTextFont ? customFonts.get(activeNewTextFont) || null : null;
}
export function setActiveNewTextFont(alias) {
  activeNewTextFont = customFonts.has(alias) ? alias : '';
  // tools.js reads settings.newTextFont when it creates a box; keeping the
  // persisted choice and the in-memory alias as one thing stops them disagreeing.
  settings.newTextFont = activeNewTextFont;
  saveSettings();
}
export function newTextFont() { return activeNewTextFont; }

/** Every font name the pickers may offer: the standard set plus anything registered. */
export function customFontFamilies() {
  return [...customFonts.keys()];
}

/* ── Persistence ────────────────────────────────────────────────────────── */

/**
 * Uploaded fonts are written to <userData>/fonts and indexed in settings, so they
 * survive a restart and stay available until the user removes them. Fonts
 * extracted from the open document are deliberately NOT persisted — they belong to
 * that file, not to the app.
 */
export function userFontRecords() {
  return Array.isArray(settings.userFonts) ? settings.userFonts : [];
}

/** Re-register every stored font at boot. Prunes records whose file has gone. */
export async function loadStoredUserFonts() {
  const kept = [];
  for (const rec of userFontRecords()) {
    if (!rec || !rec.family || !FILE_RE.test(String(rec.file || ''))) continue;
    const dir = await fontDirPath();
    const r = await window.api.readFile(`${dir}/${rec.file}`);
    if (!r || !r.ok) continue;
    customFonts.set(rec.family, { name: rec.family, bytes: r.data, source: rec.file, user: true });
    addFontFace(rec.family, r.data);
    kept.push(rec);
  }
  if (kept.length !== userFontRecords().length) {
    settings.userFonts = kept;
    saveSettings();
  }
  const wanted = settings.newTextFont;
  if (wanted && customFonts.has(wanted)) activeNewTextFont = wanted;
  return kept;
}

/** Write bytes into the fonts directory and add them to the index. */
export async function saveUserFont(family, bytes, ext) {
  const file = slugFileName(family, ext);
  const dir = await fontDirPath();
  const r = await window.api.writeFile(`${dir}/${file}`, bytes);
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'Could not save the font.' };
  customFonts.set(family, { name: family, bytes, source: file, user: true });
  const list = userFontRecords().filter((x) => x.family !== family);
  list.push({ family, file, ext: ext === 'otf' ? 'otf' : 'ttf' });
  settings.userFonts = list;
  saveSettings();
  return { ok: true, file };
}

/** Delete a stored font: file, index entry and in-memory registration. */
export async function removeUserFont(family) {
  const rec = userFontRecords().find((x) => x.family === family);
  if (!rec) return false;
  if (rec.file && FILE_RE.test(String(rec.file))) await window.api.deleteFontFile(rec.file);
  customFonts.delete(family);
  settings.userFonts = userFontRecords().filter((x) => x.family !== family);
  if (activeNewTextFont === family) activeNewTextFont = '';
  if (settings.newTextFont === family) settings.newTextFont = '';
  saveSettings();
  return true;
}

export function isUserFont(family) {
  return userFontRecords().some((x) => x.family === family);
}

/**
 * Copy a font that is already installed on this machine into the app's own font
 * store, so it persists and embeds like an upload.
 *
 * Registered under the family name, which is what the text properties picker and
 * tools.js both key on. Consequence worth knowing: choosing a second style of the
 * same family replaces the first, because one alias maps to one font program.
 * Bold/italic synthesis from separate faces is not modelled yet.
 */
export async function addSystemFont(face) {
  const r = await window.api.readFile(face.file);
  if (!r.ok) return { ok: false, error: r.error || 'Could not read the font file.' };
  const ext = /\.otf$/i.test(face.file) ? 'otf' : 'ttf';
  const saved = await saveUserFont(face.family, r.data, ext);
  if (!saved.ok) return { ok: false, error: saved.error };
  setActiveNewTextFont(face.family);
  addFontFace(face.family, r.data);
  return { ok: true, family: face.family, style: face.style };
}

export async function listSystemFonts(refresh) {
  return window.api.listSystemFonts(!!refresh);
}

/** Register a user-chosen TTF/OTF as the font used for new text boxes. */
export async function pickFontFile() {
  const paths = await window.api.openDialog({
    title: 'Choose a font file',
    filters: [{ name: 'Fonts', extensions: ['ttf', 'otf'] }],
  });
  if (!paths || !paths[0]) return null;
  const r = await window.api.readFile(paths[0]);
  if (!r.ok) return null;
  const srcPath = paths[0];
  const name = srcPath.split(/[\\/]/).pop().replace(/\.(ttf|otf)$/i, '');
  const ext = /\.otf$/i.test(srcPath) ? 'otf' : 'ttf';
  const saved = await saveUserFont(name, r.data, ext);
  if (!saved.ok) {
    // Still usable for this session even if it could not be stored.
    registerCustomFont(name, r.data, srcPath);
  }
  setActiveNewTextFont(name);
  addFontFace(name, r.data);
  return name;
}

/* ── Extraction from the PDF itself ─────────────────────────────────────── */

function fontNameOf(maybeName) {
  try {
    if (!maybeName) return '';
    if (typeof maybeName.asString === 'function') return maybeName.asString().replace(/^\//, '');
    if (typeof maybeName.asNumber === 'function') return String(maybeName.asNumber());
  } catch { /* ignore */ }
  return '';
}

function descriptorHasFontFile(dict) {
  if (!dict || typeof dict.get !== 'function') return false;
  return !!(dict.get(PDFName.of('FontFile')) || dict.get(PDFName.of('FontFile2')) || dict.get(PDFName.of('FontFile3')));
}

/** Best-effort extraction of the raw font program for a font dict. */
function extractFontProgram(doc, fontDict) {
  try {
    let descriptor = fontDict.get(PDFName.of('FontDescriptor'));
    if (!descriptor) {
      const descendants = fontDict.get(PDFName.of('DescendantFonts'));
      if (descendants instanceof PDFArray && descendants.size() > 0) {
        const d0 = doc.context.lookup(descendants.get(0));
        if (d0 instanceof PDFDict) descriptor = d0.get(PDFName.of('FontDescriptor'));
      }
    }
    if (!descriptor) return null;
    const desc = doc.context.lookup(descriptor);
    if (!(desc instanceof PDFDict)) return null;
    for (const key of ['FontFile2', 'FontFile', 'FontFile3']) {
      const ref = desc.get(PDFName.of(key));
      if (!ref) continue;
      const stream = doc.context.lookup(ref);
      if (stream && typeof stream.getContents === 'function') {
        // FontFile streams are commonly Flate-compressed. getContents() returns
        // the encoded bytes; fontkit needs the decoded sfnt program.
        const bytes = decodePDFRawStream(stream).decode();
        if (bytes && bytes.length > 64) return { key, bytes };
      }
    }
  } catch { /* malformed font — ignore */ }
  return null;
}

/**
 * Walk every page's /Resources → /Font and collect real font information.
 * Returns { perPage: [[{name, type, embedded, subset, usable}]], all: Map }.
 */
export async function extractFontInfo(bytes, onProgress) {
  const doc = await PDFDocument.load(bytes.slice(0), { updateMetadata: false, ignoreEncryption: true });
  const pages = doc.getPages();
  const all = new Map(); // baseName -> record
  const perPage = [];

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const list = [];
    try {
      let resources = null;
      try { resources = page.node.Resources ? page.node.Resources() : null; } catch { resources = null; }
      if (!resources) resources = page.node.get(PDFName.of('Resources'));
      const fonts = resources ? resources.lookupMaybe ? resources.lookupMaybe(PDFName.of('Font'), PDFDict) : null : null;
      if (fonts) {
        for (const key of fonts.keys()) {
          const fd = fonts.lookup(key);
          if (!(fd instanceof PDFDict)) continue;
          const raw = fontNameOf(fd.get(PDFName.of('BaseFont'))) || fontNameOf(key);
          if (!raw) continue;
          const name = raw.replace(/^[A-Z]{6}\+/, '');
          const subset = /^[A-Z]{6}\+/.test(raw);
          const type = fontNameOf(fd.get(PDFName.of('Subtype'))) || 'Font';
          const embedded = descriptorHasFontFile(fd) || (() => {
            try {
              const descendants = fd.get(PDFName.of('DescendantFonts'));
              if (descendants instanceof PDFArray) {
                for (let k = 0; k < descendants.size(); k++) {
                  const d = doc.context.lookup(descendants.get(k));
                  if (d instanceof PDFDict && descriptorHasFontFile(d)) return true;
                }
              }
            } catch { /* ignore */ }
            return false;
          })();

          let rec = all.get(raw);
          if (!rec) {
            rec = { name, rawName: raw, type, embedded, subset, pages: new Set(), program: null };
            all.set(raw, rec);
          }
          rec.pages.add(p);
          list.push(rec);

          // Pull the font program once, for the "reuse for new text" feature.
          if (!rec.program) {
            const prog = extractFontProgram(doc, fd);
            if (prog) rec.program = prog;
          }
        }
      }
    } catch (e) {
      console.warn('font scan failed on page', p + 1, e);
    }
    perPage.push(list);
    if (onProgress && (p % 12 === 0)) onProgress(p + 1, pages.length);
  }

  return { perPage, all: [...all.values()] };
}
