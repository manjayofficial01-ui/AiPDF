import { uid, hexToRgb } from './util.js';

/* ── Tiny event bus ─────────────────────────────────────────────────────── */
const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}
export function emit(evt, payload) {
  const s = listeners.get(evt);
  if (s) {
    const arr = Array.from(s);
    for (const fn of arr) {
      try {
        fn(payload);
      } catch (e) {
        console.error('emit listener error:', evt, e);
        console.error(new Error('trace').stack);
      }
    }
  }
}

/* ── Settings ───────────────────────────────────────────────────────────── */

export const DEFAULT_SETTINGS = {
  theme: 'system',
  author: '',
  defaultZoom: 'fitWidth',
  layout: 'continuous',          // single | continuous | facing
  sidebar: 'pages',              // pages | bookmarks | comments | search | forms | ai
  sidebarOpen: true,
  tool: 'select',
  // Foxit-style ribbon controls. `ribbonMode` is the Office-style collapse:
  // `expanded` shows the ribbon body, `collapsed` keeps the mode tabs and
  // hides the rest. `chromeHidden` removes the whole toolbar strip
  // (menubar + ribbon) for a distraction-free view; the title bar stays.
  ribbonMode: 'expanded',
  chromeHidden: false,
  // Premium design system (css/premium.css owns the look; these own the state).
  // `skin` is the colour theme id (see THEMES in premium.js). `contrast` is
  // the accessibility skin; skinBeforeContrast restores the palette the user
  // came from when high contrast is switched off again.
  skin: 'default',
  skinBeforeContrast: 'default',
  // Focus mode hides everything but the page. Restored on the next launch,
  // just like the ribbon tab and density.
  focusMode: false,
  // Local version timeline (IndexedDB). Every Save records a version, and
  // named checkpoints can be added at any time. Purely on-device.
  timelineEnabled: true,
  // Chrome density. `comfortable` is the default; `compact` tightens the
  // control heights, the ribbon and the side panels for small laptop screens.
  density: 'comfortable',        // comfortable | compact
  // How the ribbon labels its buttons. `auto` shows a text label only under
  // the large primary tools; `always` labels every button; `never` is the
  // original icon-only ribbon.
  ribbonLabels: 'auto',          // auto | always | never
  // Reopen on the ribbon tab you left, instead of always starting on Home.
  restoreRibbonTab: true,
  lastRibbonTab: 'Home',
  // Quick-access toolbar: the tools the user pins for one-click reach.
  // Empty means "the defaults only" (hand + select are always available).
  pinnedTools: [],
  // View flags. These were READ by the ribbon (settings.grid) and by
  // applySettingsToState (settings.coverPage / settings.reverse) but were
  // never defined here, so they were always undefined and the Grid toggle
  // could never show itself as active.
  grid: false,
  coverPage: false,
  reverse: false,
  showRulers: false,
  // Command-palette recents: the action ids you used most recently.
  recentCommands: [],
  // Properties-panel sections the user has collapsed. Keyed by section label.
  collapsedProps: [],
  measureUnit: 'cm',             // cm | mm | in | pt — PDF space is 1/72 inch
  ocrLang: 'eng+nep',            // default recognition: English + Nepali (auto-detects both)
  favoriteFonts: [],             // starred font families — surface in every font picker
  color: '#ffe066',
  fillColor: '#cfe3ff',           // default fill for new shapes
  fillEnabled: false,             // shapes are unfilled until the user asks
  colorPresets: ['#ffe066', '#7ce38b', '#8fd0ff', '#ff9ec4', '#ff8f6b', '#c6a8ff', '#3b5bfd', '#d92d3f', '#1d2029', '#ffffff'],
  opacity: 0.45,
  fontSize: 11,
  // Text Box / Typewriter defaults (Foxit exposes Font, Size, Colour, Style
  // and Alignment on its Typewriter tool). These are what a NEW text box is
  // created with, and what the properties panel edits when a tool is armed.
  textFont: 'Helvetica',
  textSize: 11,
  textColor: '#14171f',
  textAlign: 'left',        // left | center | right | justify
  textBold: false,
  textItalic: false,
  textUnderline: false,
  textLineSpacing: 1.2,     // multiple of the font size
  textCharSpacing: 0,       // pt added between characters (PDF Tc)
  textHScale: 100,          // % horizontal scaling (PDF Tz)
  borderWidth: 1.5,
  brushSize: 6,                   // freehand marker base width, PDF points
  brushHardness: 0.85,            // 1 = hard edge, 0 = softest edge we can bake
  highlighterSize: 16,            // translucent marker width, PDF points
  stampFont: 'Helvetica',
  ai: {
    provider: 'openai',          // openai | gemini | openrouter | groq | together | deepseek | mistral | ollama | lmstudio | custom
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    authMode: 'bearer',          // bearer | x-api-key | x-goog-api-key | api-key | custom | none
    authHeaderName: '',          // header name used when authMode === 'custom'
    customHeaders: [],           // [{ name, value, enabled }] sent with every request
    temperature: 0.2,
    maxPagesPerRequest: 40,
    smartContext: true,          // rank pages by relevance to the question
    contextBudget: 26000,        // max context characters sent to the model
    defaultScope: 'page',        // page | doc | alldocs
    availableModels: [],         // cached list from GET /models
  },
  ocr: {
    engine: 'tesseract',         // tesseract (local, default) | ai (vision model) | hybrid (AI first, Tesseract fallback)
    dpi: 150,                    // render resolution for AI vision OCR
    langHint: '',                // free-text hint passed to the vision model (e.g. "Nepali and English")
  },
  // Trust. Saving rewrites the whole file, so the revision before this one is
  // kept as `<name>.pdf.bak` and can be rolled back with File ▸ Restore
  // Previous Version. One copy of the document you are editing, replaced each
  // save — switch off if you do not want the extra file.
  backupBeforeSave: true,
  // Document text is sent to the configured AI endpoint only with consent.
  // `ask` prompts the first time a run needs to leave the machine, `allow`
  // remembers the approval, `deny` keeps the app offline-local.
  aiEgress: 'ask',
  // Verified AI editing: the agent proposes a plan and waits for approval
  // instead of mutating the document as it thinks.
  aiPlanFirst: true,
  recents: [],
};

export const settings = { ...DEFAULT_SETTINGS };

export async function loadSettings(boot) {
  // main.js hands back the whole settings *file*: { settings: {...}, recents: [...] }.
  // Merging the file itself (the old behaviour) buried every real value one level
  // deeper, so nothing but recents survived a restart. Older builds wrote the
  // values flat, so accept both shapes.
  const file = (boot && boot.settings) || {};
  const stored = file.settings && typeof file.settings === 'object' ? file.settings : file;
  Object.assign(settings, DEFAULT_SETTINGS, stored);
  delete settings.settings; // never persist the nesting artefact back to disk
  settings.ai = { ...DEFAULT_SETTINGS.ai, ...(stored.ai || {}) };
  if (!Array.isArray(settings.ai.customHeaders)) settings.ai.customHeaders = [];
  if (!Array.isArray(settings.ai.availableModels)) settings.ai.availableModels = [];
  const storedOcr = stored.ocr && typeof stored.ocr === 'object' ? stored.ocr : {};
  settings.ocr = { ...DEFAULT_SETTINGS.ocr, ...storedOcr };
  // Older builds defaulted to hybrid (and briefly carried local-model engine
  // ids). Move only those defaults to Tesseract; an explicit AI/Tesseract
  // choice is preserved. The flag makes this one-time.
  if (!storedOcr.defaultMigrated) {
    if (!storedOcr.engine || storedOcr.engine === 'hybrid' || storedOcr.engine === 'xiaomi' || storedOcr.engine === 'paddle') {
      settings.ocr.engine = 'tesseract';
    }
    settings.ocr.defaultMigrated = true;
    saveSettings();
  }
  const recents = Array.isArray(file.recents) ? file.recents : settings.recents;
  settings.recents = Array.isArray(recents) ? recents : [];
  // No `process` in the renderer main world — the old process.env.USERNAME
  // fallback could never fire.
  if (!settings.author) settings.author = 'User';
  applySettingsToState();
  return settings;
}

/** `state` snapshots several settings at module-load time, before the stored
 *  values arrive. Refresh them so restored prefs take effect this session. */
export function applySettingsToState() {
  state.tool = settings.tool || 'select';
  state.color = settings.color;
  state.colorRgb = hexToRgb(settings.color);
  state.opacity = settings.opacity;
  state.fontSize = settings.fontSize;
  state.author = settings.author;
  state.view.zoomMode = settings.defaultZoom || 'fitWidth';
  state.view.layout = settings.layout || 'continuous';
  state.view.coverPage = !!settings.coverPage;
  state.view.reverse = !!settings.reverse;
  state.view.ribbonMode = settings.ribbonMode === 'collapsed' ? 'collapsed' : 'expanded';
  state.view.chromeHidden = !!settings.chromeHidden;
  state.view.focusMode = !!settings.focusMode;
}

export function saveSettings() {
  const { recents, ...rest } = settings;
  window.api.storeSet('settings', rest).catch(() => {});
}
export function saveRecents() {
  window.api.storeSet('recents', settings.recents.slice(0, 24)).catch(() => {});
}

export function addRecent(path, name) {
  settings.recents = [{ path, name, at: Date.now() }]
    .concat(settings.recents.filter((r) => r.path !== path))
    .slice(0, 24);
  saveRecents();
  emit('recents');
}

/* ── Document model ─────────────────────────────────────────────────────── */

export const state = {
  docs: [],
  activeId: null,
  tool: 'select',
  color: settings.color,          // hex, for UI controls
  colorRgb: hexToRgb(settings.color),
  opacity: settings.opacity,
  fontSize: settings.fontSize,
  author: settings.author,
  selection: [],        // annotation ids
  view: {
    zoom: 1,            // scale factor
    zoomMode: 'fitWidth', // fitWidth | fitPage | custom
    layout: 'continuous',
    coverPage: false,   // Foxit "Cover Page": facing layout with page 1 alone
    reverse: false,     // Foxit "Reverse View": right-to-left reading order
    ribbonMode: 'expanded',
    chromeHidden: false,
    focusMode: false,   // premium.js toggles this; persisted in settings
    rotation: 0,        // global view rotation (applies to all pages)
    dark: false,
    present: false,
  },
  search: { open: false, query: '', caseSensitive: false, wholeWord: false, matches: [], index: -1 },
  ai: { dockOpen: false, messages: [], busy: false, mode: 'chat' },
  editRegion: null,       // { page, rect: [x0,y0,x1,y1] } — marquee-limited editing area
  editRegionMode: false,  // armed: the next page drag draws the marquee
  textWriteMode: false,   // Text box tool: double-click arms an I-beam writing cursor
  busy: false,
};

export function activeDoc() {
  return state.docs.find((d) => d.id === state.activeId) || null;
}
export function getDoc(id) {
  return state.docs.find((d) => d.id === id) || null;
}

export function newDocShell(partial = {}) {
  return {
    id: uid('d'),
    path: null,
    name: 'Untitled.pdf',
    bytes: null,
    pdf: null,                 // pdf.js document proxy
    numPages: 0,
    pageSizes: [],             // [{w,h}] in PDF units, unrotated
    pageRotate: {},            // index -> user rotation delta (0/90/180/270)
    annots: [],                // unified annotation model (PDF space coords)
    textEdits: [],             // in-place text edits
    stamps: [],                // watermark / header-footer / bates ops
    pageOps: null,             // { order:number[], deleted:number[] } once reorganized
    crops: {},                 // pageIndex -> [x0,y0,x1,y1] crop rectangle (Foxit Organize > Crop)
    attachments: [],           // embedded files (Foxit's Attachments panel)
    ocgConfig: null,           // optional-content (layer) config, loaded lazily
    ocgConfigPromise: null,    // resolved by the Layers panel after a toggle
    fields: [],                // AcroForm field descriptors
    outline: [],
    meta: {},
    passwordProtected: false,
    password: null,            // captured at open; '' for owner-password-only files
    saveSecurityChoice: null,  // 'keep' | 'strip', asked once per protected doc
    hasSignature: false,
    dirty: false,
    history: [],
    hIndex: -1,
    // Structural undo. Page add/delete/extract/reorder rebuild the whole file,
    // so the previous state lives in a different byte stream and a model-only
    // snapshot cannot restore it. We keep a short stack of pre-change bytes
    // (capped — each entry is a full file) and restore by reloading the doc.
    structUndoStack: [],
    structRedoStack: [],
    ...partial,
  };
}

/* ── Structural undo ────────────────────────────────────────────────────── */

const MAX_STRUCT_UNDO = 12;

/** Record the file bytes as they are *before* a structural change, and drop any
 *  redo tail — a fresh edit invalidates the future, exactly like pushHistory. */
export function pushStructUndo(bytes) {
  const doc = activeDoc();
  if (!doc) return;
  doc.structUndoStack = (doc.structUndoStack || []).concat([bytes]).slice(-MAX_STRUCT_UNDO);
  doc.structRedoStack = [];
}
export function canUndoStructure() {
  const d = activeDoc();
  return !!d && (d.structUndoStack || []).length > 0;
}
export function canRedoStructure() {
  const d = activeDoc();
  return !!d && (d.structRedoStack || []).length > 0;
}
export function markDocClean() { setClean(activeDoc()); }

/* ── History ────────────────────────────────────────────────────────────── */

function snapshot(doc) {
  return JSON.stringify({
    annots: doc.annots,
    textEdits: doc.textEdits,
    stamps: doc.stamps,
    pageOps: doc.pageOps,
    pageRotate: doc.pageRotate,
    crops: doc.crops || {},
    newFields: doc.newFields,
  });
}

export function pushHistory(label) {
  const doc = activeDoc();
  if (!doc) return;
  const snap = snapshot(doc);
  if (doc.history[doc.hIndex] === snap) return;
  doc.history = doc.history.slice(0, doc.hIndex + 1);
  doc.history.push(snap);
  if (doc.history.length > 120) doc.history.shift();
  doc.hIndex = doc.history.length - 1;
  markDirty(label);
}

export function canUndo() { const d = activeDoc(); return !!d && d.hIndex > 0; }
export function canRedo() { const d = activeDoc(); return !!d && d.hIndex < d.history.length - 1; }

export function undo() {
  const doc = activeDoc();
  if (!doc || doc.hIndex <= 0) return false;
  doc.hIndex--;
  restore(doc, doc.history[doc.hIndex]);
  markDirty('undo');
  return true;
}
export function redo() {
  const doc = activeDoc();
  if (!doc || doc.hIndex >= doc.history.length - 1) return false;
  doc.hIndex++;
  restore(doc, doc.history[doc.hIndex]);
  markDirty('redo');
  return true;
}
function restore(doc, snap) {
  const s = JSON.parse(snap);
  doc.annots = s.annots;
  doc.textEdits = s.textEdits;
  doc.stamps = s.stamps;
  doc.pageOps = s.pageOps;
  doc.pageRotate = s.pageRotate;
  doc.crops = s.crops || {};
  doc.newFields = s.newFields;
  state.selection = [];
}

export function markDirty(label) {
  const doc = activeDoc();
  if (!doc) return;
  doc.dirty = true;
  emit('dirty', doc);
  emit('change', { doc, label });
}

export function setClean(doc) {
  doc.dirty = false;
  emit('dirty', doc);
  emit('change', { doc, label: 'saved' });
}

/* ── Annotation helpers ─────────────────────────────────────────────────── */

export function annotById(id) {
  const d = activeDoc();
  return d ? d.annots.find((a) => a.id === id) : null;
}
export function annotsOnPage(pageIndex) {
  const d = activeDoc();
  return d ? d.annots.filter((a) => a.page === pageIndex) : [];
}
export function addAnnot(a) {
  const d = activeDoc();
  if (!d) return null;
  a.id = a.id || uid('an');
  a.author = a.author || settings.author;
  a.date = a.date || new Date().toISOString();
  d.annots.push(a);
  state.selection = [a.id];
  emit('annots', d);
  return a;
}
export function removeAnnots(ids) {
  const d = activeDoc();
  if (!d) return;
  const set = new Set(ids);
  d.annots = d.annots.filter((a) => !set.has(a.id));
  // Deleting the text box a Direct Editor commit produced also drops the edit
  // behind it. Without this the wash over the original text would outlive the
  // box, leaving a blank white patch where the paragraph used to be.
  if (d.textEdits?.length) {
    d.textEdits = d.textEdits.filter((e) => !e.boxId || !set.has(e.boxId));
  }
  state.selection = state.selection.filter((id) => !set.has(id));
  emit('annots', d);
}

/** Annotation draw order IS the order of the page /Annots array, and
 *  pdfwrite.js rebuilds that array in model order, so z-order is a reorder of
 *  `doc.annots` — there is no /Z key. The reorder only ever moves an annotation
 *  past others on the SAME page, since a page's array is built by filtering.
 *  mode: 'front' | 'back' | 'forward' | 'backward'. */
export function reorderAnnots(ids, mode) {
  const d = activeDoc();
  if (!d) return;
  const set = new Set(ids);
  if (!set.size) return;
  const groups = new Map();
  d.annots.forEach((a, k) => {
    if (!groups.has(a.page)) groups.set(a.page, []);
    groups.get(a.page).push({ a, k });
  });
  const out = [];
  for (const page of Array.from(groups.keys()).sort((x, y) => x - y)) {
    const items = groups.get(page);
    const sel = items.filter((it) => set.has(it.a.id));
    if (!sel.length) { out.push(...items.map((it) => it.a)); continue; }
    const rest = items.filter((it) => !set.has(it.a.id));
    if (mode === 'front') out.push(...rest.map((it) => it.a), ...sel.map((it) => it.a));
    else if (mode === 'back') out.push(...sel.map((it) => it.a), ...rest.map((it) => it.a));
    else out.push(...stepWithin(items, set, mode === 'forward' ? 1 : -1).map((it) => it.a));
  }
  d.annots = out;
  emit('annots', d);
}

/** Slide every picked annotation one place toward the top (dir 1) or bottom
 *  (dir −1) of its own page group, moving each at most once per call. */
function stepWithin(items, picked, dir) {
  const arr = items.slice();
  const done = new Set();
  const order = arr.map((_, k) => k);
  if (dir > 0) order.reverse();
  for (const k of order) {
    const j = k + dir;
    if (j < 0 || j >= arr.length || done.has(k) || done.has(j)) continue;
    const a = picked.has(arr[k].a.id), b = picked.has(arr[j].a.id);
    if (a === b) continue;
    [arr[k], arr[j]] = [arr[j], arr[k]];
    done.add(j);
  }
  return arr;
}
export function updateAnnot(id, patch, { silent = false } = {}) {
  const d = activeDoc();
  if (!d) return;
  const a = d.annots.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  if (!silent) emit('annots', d);
}
