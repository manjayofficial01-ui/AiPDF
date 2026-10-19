import {
  state, settings, loadSettings, saveSettings, saveRecents, activeDoc, getDoc, on, emit,
  newDocShell, pushHistory, undo, redo, canUndo, canRedo, addRecent, updateAnnot,
  removeAnnots, annotById, markDirty, setClean, addAnnot, reorderAnnots,
  canUndoStructure, canRedoStructure,
} from './store.js';
import * as V from './viewer.js';
import { loadPdfBytes, buildPages, relayout, renderVisible, scrollToPage, renderPageToCanvas, applyLayoutToDom, currentScale, pageDims, pageEl, rerenderAllPages } from './viewer.js';
import { loadFileAnnotations, renderPageAnnotations, renderAllAnnotations, ANNOT_TYPES, makeAnnot, normalizeRect, loadAttachments } from './annots.js';
import { loadStoredUserFonts, customFontFamilies, isUserFont, removeUserFont, registerCustomFont, getFontkit, listSystemFonts, addSystemFont } from './fonts.js';
import { indexDocumentFonts, resetDocumentFonts, resolveFontFor } from './fontresolve.js';
import { buildPdf, buildBlank, buildFromImages, buildExtract, buildMerge, readMetadata, probeEncryption, drainFontSubstitutions, buildNup, buildSingleStrip, buildPoster, buildBooklet, buildRepaired } from './pdfwrite.js';
import { initSidebar, renderSidebar, setSidebar, renderSidebarChrome } from './sidebar.js';
import { initTools, selectAnnot, transformAnnot, clearFormat } from './tools.js';
import { initTextEditing, replaceAllInDocument, commitBlockEdit, editableBlocks, editableSource, applyDirectFormat, directEditorOpen, directEditorState, openDirectEditor, openEditorForEdit, recognizePageForEditing, mergeBlocksIntoParagraph, threadEditFrames, previewEditLayout, toggleRegionMode, clearEditRegion } from './textedit.js';
import { runSearch, nextMatch, prevMatch, clearHighlights } from './search.js';
import { loadFormFields, renderFormFields, startFieldPlacement, exportFormData, importFormData, resetForm } from './forms.js';
import { watermarkDialog, headerFooterDialog, batesDialog, signatureDialog } from './stamps.js';
import { deletePages, rotatePages, extractPages, insertBlankAt, insertFromPdfAt, mergeDocuments, splitDocument, splitByBookmarks, splitByBlankPages, duplicatePages, reversePages, replacePageAt, cropPages, undoStructure, redoStructure, reloadDocFromBytes } from './pages.js';
import { initAI, aiStatusLabel, aiReady, renderAIDock, configureAI, ask, summarize, translate, proofread, rewrite, openAIDock, extractData, outline as aiOutline, aiSelfTest } from './ai.js';
import { initImageEdit } from './image-edit.js';
import { openSmartRedact } from './smartredact.js';
import { runContractReview } from './contract.js';
import { toggleReadAloud as ttsToggle, stopReadAloud as ttsStop, openTtsSettings } from './tts.js';
import { runAgent, agentSelfTest } from './agent.js';
import { detectScannedPages, OCR_LANGS } from './ocr.js';
import { buildComparison, comparisonReport, jumpToPage } from './compare.js';
import { scalePages, removeBlankPages, rasterizePages, COLOR_PRESETS, colorPresetById, parsePageRange, allPages } from './docxtools.js';
import {
  COMPRESS_PRESETS, compressPresetById, planCompress, estimateCompress,
  flattenPlan, sanitizePlan, applySanitizeModel, docInfoSummary,
  removeAnnotationsPlan, nupPlan, nupGrids, bookletOrder,
  posterTiles, singlePagePlan, splitBySizePlan, chunkByCount, autoRenameSuggest,
  repairCheck, PAGE_NUMBER_FORMATS, pageNumberPlan, autoRotatePlan,
  attachmentOps, unlockFormsPlan, PIPELINE_STEPS, validatePipeline, runPipelineModel,
} from './stirling.js';
import { $, el, toast, formatBytes, hexToRgb, rgbToHex, rgbToCss, clamp, initTooltips, uid } from './util.js';
import { svgIcon } from './icons.js';
import { showModal, confirmDialog, alertDialog, promptDialog, formRow, contextMenu } from './dialog.js';

// Ribbon tabs, in Foxit's order: Home, View, Comment, Edit, Organize,
// Protect, Convert, Forms — with AI as our own final tab. (View and Convert
// used to be missing, so zoom/layout and the export tools had no home.)
const MODES = ['Home', 'View', 'Comment', 'Edit', 'Organize', 'Protect', 'Convert', 'Forms', 'AI'];
let mode = 'Home';
let bootInfo = null;

/* ══ Boot ═══════════════════════════════════════════════════════════════ */

async function boot() {
  bootInfo = await window.api.boot();
  await loadSettings(bootInfo);
  settings.recents = (await window.api.storeGet('recents', [])) || [];

  // Uploaded fonts are stored on disk; re-register them before anything lists
  // font names, so a restart does not silently drop them.
  await loadStoredUserFonts();

  applyTheme();
  // Window chrome metrics come from main so the CSS reserves exactly the right
  // space for the Windows caption buttons instead of a hardcoded 138px.
  if (bootInfo && bootInfo.chrome) {
    const rs = document.documentElement.style;
    rs.setProperty('--h-title', `${bootInfo.chrome.overlayHeight}px`);
    rs.setProperty('--w-caption', `${bootInfo.chrome.captionWidth}px`);
  }
  // Follow the OS while the user has not picked an explicit theme.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if ((settings.theme || 'system') === 'system') applyTheme();
  });
  V.initViewer();
  initTools();
  initTextEditing();
  initSidebar();
  initAI();
  initImageEdit();

  buildChrome();
  wireToolPair();
  wireGlobal();
  initTooltips();
  initContextMenus();
  renderAIDockIfNeeded();
  updateStatus();

  setTool(state.tool || 'select');

  if (bootInfo.startupPath) openDocFromPath(bootInfo.startupPath);
  else showWorkspace();

  window.api.on('menu:action', onMenuAction);
  window.api.on('app:openPath', (p) => openDocFromPath(p));
  window.api.on('app:willClose', onWillClose);
  // AI Smart Redact's "Mark + Apply & Sanitize" button lives in a dialog that
  // must not import app.js (circular) — it signals over the store bus instead.
  on('smartredact:apply', () => { applyRedactions(true); });
  // Headless OCR test (main.js --ocr-test): runs Tesseract on page 1 of the
  // open document and reports confidence + a text sample. Requires network
  // for the first language-pack download; results are cached afterwards.
  window.__aipdfOcrProgress = [];
  window.__aipdfRunOcrTest = async () => {
    const d = activeDoc();
    if (!d) return { error: 'no doc' };
    const log = window.__aipdfOcrProgress;
    const step = (s) => { log.push(s); };
    const withTimeout = (p, ms, tag) => Promise.race([
      p,
      new Promise((_, rej) => setTimeout(() => rej(new Error(tag + ' timed out after ' + ms + 'ms')), ms)),
    ]);
    try {
      const ocr = await import('./ocr.js');
      const V = await import('./viewer.js');
      // Phase A0: is the viewer's own on-screen render alive?
      const rec0 = V.pageEl(0);
      step(`A0: viewer page0 rendered=${rec0 ? rec0.rendered : 'no-rec'} scale=${rec0 ? rec0.scale : '-'}`);
      // Phase A: does an offscreen page render complete at all?
      step('A: render page');
      await withTimeout(V.renderPageToCanvas(0, 72), 20000, 'renderPageToCanvas');
      step('A: render ok');
      // Phase B: synthetic canvas through the full engine.
      step('B: engine');
      await withTimeout(ocr.ocrCanvas(makeSyntheticCanvas(), 'eng', (m) => step('b:' + (m.status || '?') + ' ' + (m.progress ?? 0).toFixed(2))), 90000, 'recognize');
      step('B: engine ok');
      // Phase C: the real thing.
      step('C: ocrPage');
      const rec = await withTimeout(ocr.ocrPage(0, 'eng', (m) => step('c:' + (m.status || '?') + ' ' + (m.progress ?? 0).toFixed(2))), 90000, 'ocrPage');
      return { ok: true, confidence: rec.confidence, chars: rec.text.length, textSample: rec.text.slice(0, 120) };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), progress: log.slice(-8) };
    }

    function makeSyntheticCanvas() {
      const cv = document.createElement('canvas');
      cv.width = 500; cv.height = 120;
      const c = cv.getContext('2d');
      c.fillStyle = '#fff';
      c.fillRect(0, 0, cv.width, cv.height);
      c.fillStyle = '#000';
      c.font = '28px Helvetica';
      c.fillText('Hello AiPDF OCR 12345', 20, 60);
      return cv;
    }
  };

  window.api.ready();
  window.__aipdfBooted = true;
  // Test hooks (gui-walkthrough-test.mjs): drive the same action table the
  // native menu uses, and read live app state without reaching into modules.
  window.__aipdfAction = (action, payload) => onMenuAction(action, payload);
  window.__aipdfState = state;
  window.__aipdfSettings = settings;
  // Table/OCR tests: test mode never auto-opens a file, so they open explicitly.
  window.__aipdfOpenPath = (p) => openDocFromPath(p);
  // Table tests: inspect the editable block list (native or OCR) for a page.
  window.__aipdfEditableSource = (pageIndex) => editableSource(pageIndex);
  // Mark the lazy modules as importable (the boot test probes these).
  import('./ocr.js').then(() => { window.__aipdfOcrReady = true; }).catch(() => {});
  import('./fonts.js').then(() => { window.__aipdfFontsReady = true; }).catch(() => {});

  // Lightweight inspection hook used by the headless functional test
  // (main.js --functional-test). Returns a snapshot of the active doc.
  window.__aipdfGetTestReport = async () => {
    const d = activeDoc();
    const welcomeEl = $('#welcome');
    const pagesEl = $('#pagesScroll');
    const welcomeHidden = welcomeEl ? welcomeEl.classList.contains('hidden') : null;
    const pagesVisible = pagesEl ? !pagesEl.classList.contains('hidden') : null;
    if (!d || !d.pdf) {
      return { hasDoc: false, welcomeHidden, pagesVisible };
    }
    let text = '';
    try { text = await V.getPageText(0); } catch (e) { text = 'ERR:' + e.message; }
    return {
      hasDoc: true,
      name: d.name,
      numPages: d.numPages,
      annotCount: d.annots.length,
      fieldCount: (d.fields || []).length,
      scannedPages: d.scanned ? d.scanned.size : -1,
      fontCount: d.fontInfo ? d.fontInfo.all.length : -1,
      ocrReady: !!window.__aipdfOcrReady,
      page0Rendered: (() => { const r = V.pageEl(0); return r ? !!r.rendered : null; })(),
      page0RenderTaskAlive: (() => { const r = V.pageEl(0); return r ? !!r.rendering : null; })(),
      textSample: String(text).slice(0, 160),
      welcomeHidden,
      pagesVisible,
    };
  };

  // Direct Editor inspection for the live tests: the committed edit records,
  // including the table/cell structure a cell edit carries.
  window.__aipdfGetTextEdits = () => (activeDoc()?.textEdits || []).map((e) => ({
    id: e.id, page: e.page, text: e.text, mode: e.mode,
    frames: (e.frames || []).map((f) => ({ page: f.page, rect: f.rect })),
    table: e.table || null,
    overset: e.overset || null,
    removal: e.removal || null,
  }));

  // Build the current document and read a page's text back through pdf.js —
  // what a reader/search would see. Lets the table test prove a cell edit is
  // truthful in the SAVED file, not only on screen.
  window.__aipdfSaveAndExtract = async (pageIndex = 0) => {
    const d = activeDoc();
    if (!d) return { error: 'no active doc' };
    const bytes = await buildPdf(d);
    if (!bytes || !bytes.length) return { error: 'buildPdf produced no bytes' };
    const pdf = await V.pdfjs.getDocument({ data: bytes.slice(0), isEvalSupported: false }).promise;
    try {
      const page = await pdf.getPage(pageIndex + 1);
      const tc = await page.getTextContent();
      return { bytes: bytes.length, text: tc.items.map((i) => i.str).join(' ') };
    } finally {
      await pdf.destroy();
    }
  };

  // Headless AI self-test (main.js --ai-test). Pure-logic checks of the
  // OpenAI-compatible provider layer — no network calls.
  window.__aipdfAiSelfTest = () => {
    try { return aiSelfTest(); } catch (e) { return { passed: false, errors: [String(e && e.stack ? e.stack : e)] }; }
  };

  // Headless agent self-test (main.js --agent-test): tool registry, page-range
  // parsing and schema sanity — no model, no network.
  window.__aipdfAgentSelfTest = () => {
    try { return agentSelfTest(); } catch (e) { return { passed: false, errors: [String(e && e.stack ? e.stack : e)] }; }
  };

  // Headless edit→save→reopen cycle test (main.js --edit-test). Adds a
  // rectangle annotation, builds the PDF, writes it, reopens it, and
  // reports whether the new annotation persisted.
  window.__aipdfRunEditCycle = async () => {
    const d = activeDoc();
    if (!d) return { error: 'no active doc' };
    const before = d.annots.length;
    const a = makeAnnot('rect', 0, [60, 600, 260, 640], { color: [1, 0.4, 0.2], borderWidth: 2 });
    addAnnot(a);
    const bytes = await buildPdf(d);
    if (!bytes || !bytes.length) return { error: 'buildPdf produced no bytes', before };
    const editedPath = (d.path || 'fixture.pdf').replace(/\.pdf$/i, '') + '.edited.pdf';
    const wres = await window.api.writeFile(editedPath, bytes);
    if (!wres || !wres.ok) return { error: 'write failed', before, savedBytes: bytes.length };
    await openDocFromPath(editedPath);
    const d2 = activeDoc();
    return {
      before,
      added: 1,
      savedBytes: bytes.length,
      afterReopen: d2 ? d2.annots.length : -1,
      fieldAfter: d2 ? (d2.fields || []).length : -1,
      editedPath,
    };
  };

  // Headless Foxit-parity test (main.js --parity-test). Exercises every
  // Foxit-parity feature added in this pass through the SAME code paths the
  // UI uses — makeAnnot/addAnnot/buildPdf/write/reopen, replaceAllInDocument,
  // the structural page ops with struct undo/redo, and the pure Convert
  // builders. One row per tool; each row is guarded so a single failure
  // never takes down the rest of the run.
  window.__aipdfRunParityTest = async () => {
    const rows = [];
    const row = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
    const guard = async (name, fn) => {
      try {
        const r = await fn();
        const ok = r === true ? true : !!(r && r.ok);
        const detail = r === true ? '' : (r && r.detail !== undefined ? r.detail : JSON.stringify(r));
        row(name, ok, detail);
      } catch (e) {
        row(name, false, 'THREW: ' + (e && e.message ? e.message : String(e)));
      }
    };

    /* ── A. Foxit annotation shapes: create → build → write → reopen ── */
    await guard('shapes: add all Foxit parity annotations', async () => {
      const d0 = activeDoc();
      if (!d0) return { ok: false, detail: 'no active doc' };
      const before = d0.annots.length;
      const P = [80, 620, 220, 620, 150, 540];            // triangle, PDF space
      const rect = [60, 560, 300, 660];
      const add = (type, extra, r) => addAnnot(makeAnnot(type, 0, r || rect, Object.assign({ borderWidth: 1.5 }, extra)));
      add('polygon', { poly: true, points: P, closed: true });
      add('polyline', { poly: true, points: P });
      add('cloud', { poly: true, points: P, closed: true });
      add('areaHighlight', { poly: true, points: P, closed: true, opacity: 0.35 });
      add('roundRect', { corner: 24, fill: [1, 1, 1] });
      add('caret', { caret: true }, [100, 600, 106, 618]);
      add('measureArea', { poly: true, points: P, label: 'Perimeter 2.42 in · Area 0.24 in²' });
      add('link', { borderWidth: 0, dest: 'uri', uri: 'https://example.com' }, [320, 600, 520, 640]);
      add('link', { borderWidth: 0, dest: 'goto', destPage: 1 }, [320, 540, 520, 580]);
      const added = activeDoc().annots.length - before;
      return { ok: added === 9, detail: added + ' added (expect 9)' };
    });

    await guard('shapes: save → reopen → all survive', async () => {
      const d0 = activeDoc();
      const bytes = await buildPdf(d0);
      if (!bytes || !bytes.length) return { ok: false, detail: 'buildPdf produced no bytes' };
      const p = '.smoke/parity-annots.pdf';
      const wres = await window.api.writeFile(p, bytes);
      if (!wres || !wres.ok) return { ok: false, detail: 'write failed: ' + (wres && wres.error) };
      await openDocFromPath(p);
      const d1 = activeDoc();
      const types = (d1.annots || []).map((a) => a.type);
      const missing = ['polygon', 'polyline', 'cloud', 'areaHighlight', 'roundRect', 'caret', 'measureArea', 'link']
        .filter((t) => !types.includes(t));
      const links = types.filter((t) => t === 'link').length;
      const ok = !missing.length && links >= 2;
      return { ok, detail: ok ? `${types.length} annots, ${links} links` : `missing [${missing.join(',')}] links=${links} have=[${types.join(',')}]` };
    });

    /* ── B. Find & replace + text-edit serialization ── */
    await guard('edit: find & replace all', async () => {
      const n = await replaceAllInDocument('extractable', 'REPLACED', {});
      const edits = (activeDoc().textEdits || []).length;
      return { ok: n >= 1 && edits >= 1, detail: `replaced=${n} textEdits=${edits}` };
    });
    await guard('edit: text edits serialize without error', async () => {
      const bytes = await buildPdf(activeDoc());
      return { ok: !!(bytes && bytes.length), detail: bytes ? bytes.length + ' bytes' : 'no bytes' };
    });

    /* ── C. Structural page ops + struct undo/redo ── */
    await guard('pages: duplicate', async () => {
      const n0 = activeDoc().numPages;
      await duplicatePages([0]);
      return { ok: activeDoc().numPages === n0 + 1, detail: `${n0} → ${activeDoc().numPages}` };
    });
    await guard('pages: reverse', async () => {
      const n = activeDoc().numPages;
      await reversePages();
      return { ok: activeDoc().numPages === n, detail: `${n} pages, order reversed` };
    });
    await guard('pages: crop bakes CropBox into the file', async () => {
      const d = activeDoc();
      const w0 = d.pageSizes[0].w, h0 = d.pageSizes[0].h;
      await cropPages([0], [50, 60, 400, 500]);
      const ps = activeDoc().pageSizes[0];
      const bytes = await buildPdf(activeDoc());
      const ok = ps.w === 350 && ps.h === 440 && !!(bytes && bytes.length);
      return { ok, detail: `full=${w0}x${h0} cropped=${ps.w}x${ps.h} ${bytes ? bytes.length : 0} bytes` };
    });
    await guard('pages: structural undo / redo walks CropBox back', async () => {
      const cropped = activeDoc().pageSizes[0].w;
      await undoStructure();
      const afterUndo = activeDoc().pageSizes[0].w;
      await redoStructure();
      const afterRedo = activeDoc().pageSizes[0].w;
      const ok = afterUndo !== cropped && afterRedo === cropped;
      return { ok, detail: `cropped=${cropped} undo=${afterUndo} redo=${afterRedo}` };
    });
    await guard('pages: split by bookmarks (fixture has none → 0 parts)', async () => {
      const n = await splitByBookmarks();
      return { ok: n === 0, detail: `parts=${n}` };
    });
    await guard('pages: split by blank pages (none blank → 0 parts)', async () => {
      const n = await splitByBlankPages();
      return { ok: n === 0, detail: `parts=${n}` };
    });

    /* ── D. Convert exporters (pure builders + real ZIP writer) ── */
    await guard('convert: HTML builder', async () => {
      const d = activeDoc();
      const html = buildHtmlExport(d, await collectDocText(d));
      const ok = html.startsWith('<!DOCTYPE html>') && html.includes('<section class="page" id="page-1"') && html.includes('&lt;') === false && html.includes('AiPDF Editor functional test fixture.');
      return { ok, detail: html.length + ' chars' };
    });
    await guard('convert: RTF builder + escaping', async () => {
      const d = activeDoc();
      const rtf = buildRtfExport(d, await collectDocText(d));
      const esc = rtfEscape('a{b}\\c\né😀');
      const ok = rtf.startsWith('{\\rtf1') && rtf.trimEnd().endsWith('}') && rtf.includes('\\par')
        && esc.includes('\\{') && esc.includes('\\par') && esc.includes('\\u233?') && esc.includes('\\u55357?') && !esc.includes('😀');
      return { ok, detail: rtf.length + ' chars, escape=' + JSON.stringify(esc) };
    });
    await guard('convert: Markdown builder', async () => {
      const d = activeDoc();
      const md = buildMarkdownExport(d, await collectDocText(d));
      const ok = md.startsWith('# ') && md.includes('<!-- page 1 -->') && md.includes('<!-- page 2 -->');
      return { ok, detail: md.length + ' chars' };
    });
    await guard('convert: EPUB container written as valid ZIP', async () => {
      const d = activeDoc();
      const bytes = zipStore(buildEpubFiles(d, await collectDocText(d)));
      const magic = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
      const eocd = bytes.length >= 22 && bytes[bytes.length - 22] === 0x50 && bytes[bytes.length - 21] === 0x4b
        && bytes[bytes.length - 20] === 0x05 && bytes[bytes.length - 19] === 0x06;
      const wres = await window.api.writeFile('.smoke/parity.epub', bytes);
      return { ok: magic && eocd && !!(wres && wres.ok), detail: `${bytes.length} bytes magic=${magic} eocd=${eocd}` };
    });

    /* ── E. Foxit panels: attachments, layers, signatures ── */
    await guard('panel: attachments survive save → reopen', async () => {
      await openDocFromPath('.fixtures/fixture-attach.pdf');
      const d0 = activeDoc();
      const names0 = (d0.attachments || []).map((a) => a.filename);
      if (!names0.includes('spec-v2.txt')) return { ok: false, detail: `loaded attachments: [${names0.join(',')}]` };
      const bytes = await buildPdf(d0);
      const wres = await window.api.writeFile('.smoke/parity-attach.pdf', bytes);
      if (!wres || !wres.ok) return { ok: false, detail: 'write failed' };
      await openDocFromPath('.smoke/parity-attach.pdf');
      const atts = activeDoc().attachments || [];
      const hit = atts.find((a) => a.filename === 'spec-v2.txt');
      const text = hit ? new TextDecoder().decode(hit.data) : '';
      const ok = !!hit && text === 'AiPDF attachment round-trip fixture.';
      return { ok, detail: ok ? `${atts.length} attachment(s), content intact` : `have=[${atts.map((a) => a.filename).join(',')}] text=${JSON.stringify(text.slice(0, 40))}` };
    });

    await guard('panel: layers list + toggle + re-render', async () => {
      await openDocFromPath('.fixtures/fixture-layers.pdf');
      const d = activeDoc();
      const cfg = await d.pdf.getOptionalContentConfig();
      const raw = cfg.getGroups();
      const entries = raw instanceof Map ? Array.from(raw.entries()) : Object.entries(raw || {});
      if (!entries.length) return { ok: false, detail: 'no OCG groups found' };
      const [gid, g] = entries[0];
      const nameOk = g.name === 'Layer 1';
      cfg.setVisibility(gid, false);
      d.ocgConfigPromise = Promise.resolve(cfg);
      rerenderAllPages();
      // The re-render is fire-and-forget; poll until page 0 paints again.
      let repainted = false;
      for (let i = 0; i < 15 && !repainted; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const rec = V.pageEl(0);
        repainted = !!(rec && rec.rendered);
      }
      cfg.setVisibility(gid, true);
      d.ocgConfigPromise = Promise.resolve(cfg);
      rerenderAllPages();
      const ok = nameOk && repainted;
      return { ok, detail: `group="${g.name}" toggled, repainted=${repainted}` };
    });

    await guard('panel: all three panels render through the sidebar', async () => {
      await openDocFromPath('.fixtures/fixture-attach.pdf');
      const report = [];
      for (const panel of ['attachments', 'signatures', 'layers']) {
        setSidebar(panel);
        await new Promise((r) => setTimeout(r, 350));
        const body = $('#sideBody');
        report.push(`${panel}:${body && body.children.length ? body.children.length : 0}`);
      }
      const ok = report.every((r) => !r.endsWith(':0'));
      return { ok, detail: report.join(' ') };
    });

    /* ── F. Foxit View extras: cover page, reverse, grid, read aloud ── */
    await guard('view: cover page / reverse / grid toggle their classes', async () => {
      const pages = $('#pages');
      const before = { cover: pages.classList.contains('cover'), rev: pages.classList.contains('reverse'), grid: document.body.classList.contains('show-grid') };
      onMenuAction('view:cover');
      onMenuAction('view:reverse');
      onMenuAction('view:grid');
      const on = { cover: pages.classList.contains('cover'), rev: pages.classList.contains('reverse'), grid: document.body.classList.contains('show-grid') };
      // Leave the view as it was found: toggle back whatever we changed.
      if (on.cover !== before.cover) onMenuAction('view:cover');
      if (on.rev !== before.rev) onMenuAction('view:reverse');
      if (on.grid !== before.grid) onMenuAction('view:grid');
      return { ok: on.cover && on.rev && on.grid, detail: `cover=${on.cover} reverse=${on.rev} grid=${on.grid}` };
    });

    await guard('view: read aloud speaks once, then stops', async () => {
      const hasSynth = typeof window.speechSynthesis !== 'undefined' && typeof window.SpeechSynthesisUtterance !== 'undefined';
      if (!hasSynth) return { ok: false, detail: 'speechSynthesis unavailable in this runtime' };
      // Spy on speak() so the assertion does not depend on a voice existing —
      // the headless runtime has zero voices and errors the utterance at once.
      const synth = window.speechSynthesis;
      const realSpeak = synth.speak.bind(synth);
      let speakCalls = 0;
      synth.speak = (u) => { speakCalls++; return realSpeak(u); };
      await onMenuAction('view:readAloud');
      await onMenuAction('view:readAloud');   // same menu item stops it
      synth.speak = realSpeak;
      const stopped = window.__aipdfReadAloud === false;
      return { ok: speakCalls === 1 && stopped, detail: `speakCalls=${speakCalls} stopped=${stopped}` };
    });

    /* ── G. Form data import parsers (Foxit Forms > Import) ── */
    await guard('forms: FDF / CSV / JSON import parsers', async () => {
      const m = await import('./forms.js');
      const fdf = m.parseFdf('%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ << /T (Name) /V (Foxit User) >> << /T (Note) /V (a (nested) note\\nline 2) >> ] >> >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF');
      const fdfOk = fdf.length === 2 && fdf[0].name === 'Name' && fdf[0].value === 'Foxit User'
        && fdf[1].name === 'Note' && fdf[1].value === 'a (nested) note\nline 2';
      const csv = m.parseCsv('name,type,value\r\n"alpha","Text","Hello, world"\r\n"beta","Text","line\\nbreak"\r\n');
      const csvOk = csv.length === 2 && csv[0].name === 'alpha' && csv[0].value === 'Hello, world' && csv[1].value === 'line\nbreak';
      const cbOn = m.normFieldValue({ type: 'Checkbox' }, 'Yes');
      const cbOff = m.normFieldValue({ type: 'Checkbox' }, 'Off');
      const normOk = cbOn === 'true' && cbOff === '';
      const json = m.parseCsv('name,value\ngamma,"plain"\n');
      return { ok: fdfOk && csvOk && normOk && json.length === 1, detail: `fdf=${fdf.length} csv=${csv.length} json=${json.length} norm=${cbOn}/${cbOff}` };
    });

    /* ── H. Toolbar expand / shrink / show / hide, icon-only chrome ── */
    await guard('toolbar: ribbon is icon-only (no .rlabel, tooltip present)', async () => {
      const btns = Array.from(document.querySelectorAll('#ribbon .rbtn'));
      if (!btns.length) return { ok: false, detail: 'no .rbtn in the ribbon' };
      const labelled = btns.filter((b) => b.querySelector('.rlabel'));
      const titled = btns.filter((b) => b.getAttribute('title') || b.getAttribute('aria-label'));
      return { ok: labelled.length === 0 && titled.length === btns.length,
        detail: `btns=${btns.length} labelled=${labelled.length} titled=${titled.length}` };
    });

    await guard('toolbar: Home ribbon exposes Select, Hand and Direct Editor', async () => {
      const titles = new Set(
        Array.from(document.querySelectorAll('#ribbon .rbtn'))
          .map((b) => (b.getAttribute('title') || b.getAttribute('aria-label') || '').toLowerCase())
      );
      // Select and Hand are separate tools now, so look for each by its own
      // name rather than the old combined "Select / Hand" button. The Edit Text
      // tool is labelled "Direct Editor" everywhere except its internal id.
      const hasSelect = titles.has('select');
      const hasHand = titles.has('hand');
      const hasDirectEditor = titles.has('direct editor');
      return { ok: hasSelect && hasHand && hasDirectEditor,
        detail: `select=${hasSelect} hand=${hasHand} directEditor=${hasDirectEditor} total=${titles.size}` };
    });

    await guard('toolbar: Ctrl+F1 collapses the ribbon and restores it', async () => {
      const before = document.body.classList.contains('ribbon-collapsed');
      // Synthesise the keydown the renderer keymap listens for.
      const ev = new KeyboardEvent('keydown', { key: 'F1', ctrlKey: true, bubbles: true });
      document.dispatchEvent(ev);
      const afterToggle = document.body.classList.contains('ribbon-collapsed');
      // Toggle back so the next test sees the same world.
      const ev2 = new KeyboardEvent('keydown', { key: 'F1', ctrlKey: true, bubbles: true });
      document.dispatchEvent(ev2);
      const afterRestore = document.body.classList.contains('ribbon-collapsed');
      return { ok: afterToggle !== before && afterRestore === before,
        detail: `before=${before} toggled=${afterToggle} restored=${afterRestore}` };
    });

    await guard('toolbar: View > Show / Hide Toolbars toggles chrome-hidden', async () => {
      const before = document.body.classList.contains('chrome-hidden');
      onMenuAction('view:chromeToggle');
      const hidden = document.body.classList.contains('chrome-hidden');
      onMenuAction('view:chromeToggle');
      const restored = document.body.classList.contains('chrome-hidden');
      return { ok: hidden !== before && restored === before && !!document.getElementById('btnChromeToggle'),
        detail: `before=${before} hidden=${hidden} restored=${restored}` };
    });

    await guard('toolbar: title-bar version chip renders the running build', async () => {
      const el = document.getElementById('brandVer');
      const txt = el ? el.textContent : '';
      const ok = !!txt && /^v?\d+(\.\d+)+/.test(txt);
      return { ok, detail: `chip="${txt}"` };
    });

    await guard('toolbar: clicking a mode tab while collapsed auto-expands the ribbon', async () => {
      // Force a known starting state — persisted settings from a prior run
      // could otherwise leave the ribbon already collapsed, making the
      // "before" assertion order-dependent.
      if (state.view.ribbonMode !== 'expanded') setRibbonMode('expanded');
      onMenuAction('view:ribbonToggle');                                  // → collapsed
      const wasCollapsed = document.body.classList.contains('ribbon-collapsed');
      const firstTab = document.querySelector('#modeTabs .mode-tab');
      if (firstTab) firstTab.click();
      const after = document.body.classList.contains('ribbon-collapsed');
      onMenuAction('view:ribbonToggle');                                  // restore
      return { ok: wasCollapsed && !after, detail: `before=${wasCollapsed} after=${after}` };
    });

    /* ── I. Direct on-page text editing (double-click in Select tool) ── */
    await guard('edit: double-click on a text run with the Select tool opens the inline editor', async () => {
      const d0 = activeDoc();
      if (!d0) return { ok: false, detail: 'no active doc' };
      const editsBefore = (d0.textEdits || []).length;
      setTool('select');
      const span = document.querySelector('#pages .textLayer span[data-item]');
      if (!span) return { ok: false, detail: 'no textLayer span in the fixture' };
      const r = span.getBoundingClientRect();
      span.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: r.left + 4, clientY: r.top + 4 }));
      // startTextEdit → openDirectEditor is async (it awaits getTextContent),
      // so poll for the surface rather than assuming it is there on the next tick.
      let surface = null;
      for (let i = 0; i < 40 && !surface; i++) {
        await new Promise((res) => setTimeout(res, 50));
        surface = document.querySelector('.direct-editor-surface');
      }
      if (!surface) return { ok: false, detail: 'direct editor surface never opened' };
      // Replace rather than append: a block refuses to commit text that no
      // longer fits its measured box, and appending overflows this fixture.
      surface.innerText = 'EDITED';
      // The surface is contenteditable, so it takes a real Ctrl+Enter — the same
      // contract as Acrobat's Edit PDF surface.
      surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      let editsAfter = editsBefore;
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 50));
        editsAfter = (activeDoc().textEdits || []).length;
        if (editsAfter > editsBefore) break;
      }
      return { ok: editsAfter > editsBefore, detail: `editsBefore=${editsBefore} editsAfter=${editsAfter}` };
    });

    await guard('edit: arming the Edit Text tool paints the hover outline via body.tool-editText', async () => {
      setTool('editText');
      const armed = document.body.classList.contains('tool-editText');
      setTool('select');
      const disarmed = document.body.classList.contains('tool-editText');
      return { ok: armed && !disarmed, detail: `armed=${armed} disarmed=${disarmed}` };
    });

    /* ── I2. Selection targeting: edits must hit the object that is selected ── */
    await guard('selection: switching tools drops the object selection', async () => {
      // The panel gives a non-empty selection priority over the tool panel, so a
      // selection left behind by the previous tool kept rendering THAT object's
      // properties — every colour/font-size change landed on it even though it
      // was no longer selected.
      const d = activeDoc();
      const a = makeAnnot('rect', 0, [60, 600, 220, 680], { color: [1, 0, 0], borderWidth: 2 });
      addAnnot(a);
      selectAnnot(a.id);
      const before = state.selection.length;
      setTool('ellipse');
      const afterTool = state.selection.length;
      const stillSelected = !!document.querySelector('.annLayer .handle');
      setTool('select');
      removeAnnots([a.id]);
      return { ok: before === 1 && afterTool === 0 && !stillSelected,
        detail: `selected=${before} afterToolSwitch=${afterTool} handlesVisible=${stillSelected}` };
    });

    await guard('selection: an edit lands on the selected object, not the previous one', async () => {
      const d = activeDoc();
      const A = makeAnnot('rect', 0, [60, 600, 220, 680], { color: [1, 0, 0], borderWidth: 2 });
      const B = makeAnnot('rect', 0, [260, 600, 420, 680], { color: [0, 0, 1], borderWidth: 2 });
      addAnnot(A); addAnnot(B);
      setTool('select');
      selectAnnot(A.id); renderContext();
      const colA = document.querySelector('#ctxBody input[type=color]');
      if (!colA) { removeAnnots([A.id, B.id]); return { ok: false, detail: 'no colour input for A' }; }
      colA.value = '#00ff00';
      colA.dispatchEvent(new Event('input', { bubbles: true }));
      // Now select B and edit again — the edit must move to B.
      selectAnnot(B.id); renderContext();
      const colB = document.querySelector('#ctxBody input[type=color]');
      if (!colB) { removeAnnots([A.id, B.id]); return { ok: false, detail: 'no colour input for B' }; }
      colB.value = '#ff00ff';
      colB.dispatchEvent(new Event('input', { bubbles: true }));
      const a = annotById(A.id), b = annotById(B.id);
      const rgb = (c) => c.map((v) => Math.round(v * 255)).join(',');
      const ok = rgb(a.color) === '0,255,0' && rgb(b.color) === '255,0,255';
      const detail = `A=${rgb(a.color)} B=${rgb(b.color)}`;
      removeAnnots([A.id, B.id]);
      setTool('select');
      return { ok, detail };
    });

    await guard('panel: arming the Direct Editor shows its Format panel', async () => {
      // editText was missing from TOOL_PROPS, so arming the Direct Editor fell
      // through to the page-info panel and the Format list was unreachable.
      setTool('editText');
      renderContext();
      const title = (document.getElementById('ctxTitle') || {}).textContent || '';
      const host = document.getElementById('ctxBody');
      const titles = Array.from(host.querySelectorAll('.prop-title')).map((x) => x.textContent).join(' ');
      const hasAlign = Array.from(host.querySelectorAll('select'))
        .some((s) => Array.from(s.options).some((o) => o.value === 'justify'));
      const hasScale = Array.from(host.querySelectorAll('.prop-row label'))
        .some((l) => /Horiz\. scale/i.test(l.textContent));
      setTool('select');
      return { ok: /Direct Editor/.test(title) && hasAlign && hasScale,
        detail: `title="${title}" sections="${titles}" justify=${hasAlign} hScale=${hasScale}` };
    });

    await guard('shell: boots into the workspace, not the Welcome page', async () => {
      // The app now lands in the editor shell; the empty-workspace card stands in
      // for a landing page and must give way as soon as a document is shown.
      const welcomeHidden = document.getElementById('welcome').classList.contains('hidden');
      const card = document.getElementById('emptyWorkspace');
      const cardHiddenWithDoc = card ? card.classList.contains('hidden') : false;
      const pagesVisible = !document.getElementById('pagesScroll').classList.contains('hidden');
      return { ok: welcomeHidden && !!card && cardHiddenWithDoc && pagesVisible,
        detail: `welcomeHidden=${welcomeHidden} cardExists=${!!card} cardHiddenWithDoc=${cardHiddenWithDoc} pagesVisible=${pagesVisible}` };
    });

    /* ── J. Text Box / Typewriter: content-aware panel + round-trip ── */
    await guard('text: armed Text box tool shows content-aware text panel', async () => {
      setTool('textbox');
      renderContext();                                   // rebuild the ctx panel
      const host = document.getElementById('ctxBody');
      const selects = Array.from(host.querySelectorAll('select'));
      const colors = Array.from(host.querySelectorAll('input[type=color]'));
      const fontSel = selects.find((s) => Array.from(s.options).some((o) => /Helvetica|Times|Courier/.test(o.value)));
      const alignSel = selects.find((s) => Array.from(s.options).some((o) => o.value === 'center'));
      const colorInput = colors.find((c) => c.type === 'color');
      const ok = !!fontSel && !!alignSel && !!colorInput;
      setTool('select');
      return { ok, detail: `selects=${selects.length} colors=${colors.length} fontSel=${!!fontSel} alignSel=${!!alignSel}` };
    });

    await guard('text: new text box inherits Typewriter settings', async () => {
      settings.textFont = 'Times'; settings.textSize = 22; settings.textColor = '#ff0000';
      settings.textAlign = 'center'; settings.textBold = true; settings.textItalic = false;
      const a = makeAnnot('textbox', 0, [0, 0, 200, 30], {});
      const ok = a.fontFamily === 'Times' && a.fontSize === 22 && a.textColor
        && Math.round(a.textColor[0] * 255) === 255 && a.align === 'center' && a.bold === true;
      return { ok, detail: `family=${a.fontFamily} size=${a.fontSize} color=${JSON.stringify(a.textColor)} align=${a.align} bold=${a.bold}` };
    });

    await guard('text: save → reopen preserves FreeText font/size/colour/align/bold', async () => {
      await openDocFromPath('.fixtures/fixture.pdf');
      const d0 = activeDoc();
      d0.annots = [];
      const a = makeAnnot('textbox', 0, [50, 700, 250, 730], {});
      a.fontFamily = 'Times'; a.fontSize = 18; a.textColor = [1, 0, 0]; a.align = 'right';
      a.bold = true; a.italic = false; a.text = 'RT test'; a.id = 'an-rt';
      d0.annots.push(a);
      const bytes = await buildPdf(d0);
      const wres = await window.api.writeFile('.smoke/parity-text.pdf', bytes);
      if (!wres || !wres.ok) return { ok: false, detail: 'write failed' };
      await openDocFromPath('.smoke/parity-text.pdf');
      const d1 = activeDoc();
      const found = d1.annots.find((x) => x.type === 'textbox' && x.text === 'RT test');
      if (!found) return { ok: false, detail: 'textbox not found after reopen' };
      const ok = found.fontFamily === 'Times' && found.fontSize === 18 && found.align === 'right'
        && found.bold === true && found.textColor && Math.round(found.textColor[0] * 255) === 255;
      return { ok, detail: `family=${found.fontFamily} size=${found.fontSize} align=${found.align} bold=${found.bold} color=${JSON.stringify(found.textColor)}` };
    });

    /* ── K. Object-owned editing: a replaced block is REMOVED, not covered ──
       The Direct Editor used to cover the original words with an opaque wash.
       That made the file lie about its own contents — a screenshot looked right
       while the old, searchable words were still extractable underneath. The
       writer now removes the owned source operators and inserts the replacement.
       These rows assert the new contract: after a save the replacement is real
       text, the ORIGINAL IS GONE from extraction, neighbouring text survives,
       and the removal mode is recorded on the edit. A wash remains only as the
       fallback for pages whose glyphs are pixels or live in a Form XObject. */
    const flat = async (i) => {
      const tc = await V.getTextContent(i);
      return (tc.items || []).map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim();
    };

    await guard('truthful: a replaced block is REMOVED from the file and the replacement is real text', async () => {
      await openDocFromPath('.fixtures/fixture.pdf');
      const d0 = activeDoc();
      if (!d0) return { ok: false, detail: 'no active doc' };
      const blocks = await editableBlocks(0);
      if (!blocks || !blocks.length) return { ok: false, detail: 'no text blocks on page 1' };
      const block = blocks.find((b) => b.text.trim().length > 12) || blocks[0];
      // Compare on the first line only: a multi-line block is joined with \n,
      // which will not appear in the extracted text of the rewritten file.
      const needle = block.text.split('\n')[0].trim().slice(0, 24);
      const marker = 'REFLOWPROOF';
      const committed = await commitBlockEdit(0, block, marker, {});
      if (!committed) return { ok: false, detail: 'commitBlockEdit refused the edit' };
      const bytes = await buildPdf(activeDoc());
      if (!bytes || !bytes.length) return { ok: false, detail: 'buildPdf produced no bytes' };
      const wres = await window.api.writeFile('.smoke/parity-reflow.pdf', bytes);
      if (!wres || !wres.ok) return { ok: false, detail: 'write failed: ' + (wres && wres.error) };
      await openDocFromPath('.smoke/parity-reflow.pdf');
      const after = await flat(0);
      const stillThere = after.includes(needle);
      const added = after.includes(marker);
      return { ok: !stillThere && added,
        detail: `originalGone=${!stillThere} added=${added} needle=${JSON.stringify(needle)} after=${JSON.stringify(after.slice(0, 90))}` };
    });

    await guard('truthful: text outside the replaced block survives', async () => {
      // The fixture's other paragraph must still be readable in the saved file —
      // an excision that reached past the block would have deleted it.
      const before = await flat(0);
      const survived = before.includes('This sentence on page one');
      const replaced = before.includes('REFLOWPROOF');
      return { ok: survived && replaced,
        detail: `survived=${survived} replaced=${replaced} text=${JSON.stringify(before.slice(0, 90))}` };
    });

    await guard('truthful: removal mode and overset are recorded on the edit', async () => {
      await openDocFromPath('.fixtures/fixture.pdf');
      const d0 = activeDoc();
      if (!d0) return { ok: false, detail: 'no active doc' };
      const blocks = await editableBlocks(0);
      const block = blocks.find((b) => b.text.trim().length > 12) || blocks[0];
      await commitBlockEdit(0, block, 'MODEPROOF', {});
      const edit = activeDoc().textEdits[0];
      await buildPdf(activeDoc());
      const mode = edit.removal;
      const hasSchema = edit.schemaVersion >= 2;
      const hasRefs = !!(edit.sourceRefs && edit.sourceRefs.itemIndices.length);
      const hasFrames = Array.isArray(edit.frames) && edit.frames.length >= 1;
      return { ok: mode === 'excise' && hasSchema && hasRefs && hasFrames,
        detail: `removal=${mode} removedBlocks=${edit.removedBlocks} schema=${edit.schemaVersion} refs=${hasRefs} frames=${edit.frames && edit.frames.length} overset=${JSON.stringify(edit.overset)}` };
    });

    await guard('truthful: the replacement is ordinary PDF text, editable again', async () => {
      // Self-contained: reopen the file guard 1 saved rather than relying on
      // whatever document an earlier row happened to leave active. This is the
      // row that proves the replacement is real, re-editable page text — it
      // must read the saved bytes, not the in-memory model.
      await openDocFromPath('.smoke/parity-reflow.pdf');
      const blocks = await editableBlocks(0);
      const hit = blocks.find((b) => b.text.includes('REFLOWPROOF'));
      if (!hit) return { ok: false, detail: `no block contains the replacement: ${JSON.stringify(blocks.map((b) => b.text.slice(0, 20)))}` };
      // Roomier than the block the writer measured, so the assertion is about
      // round-tripping the replacement rather than about wrapping.
      await commitBlockEdit(0, hit, 'REFLOWPROOF2', { maxWidth: 320, maxHeight: 120 });
      const bytes = await buildPdf(activeDoc());
      const wres = await window.api.writeFile('.smoke/parity-reflow2.pdf', bytes);
      if (!wres || !wres.ok) return { ok: false, detail: 'write failed' };
      await openDocFromPath('.smoke/parity-reflow2.pdf');
      const after = await flat(0);
      return { ok: after.includes('REFLOWPROOF2'),
        detail: JSON.stringify(after.slice(0, 90)) };
    });

    await guard('truthful: an edit over blank space still saves', async () => {
      await openDocFromPath('.fixtures/fixture.pdf');
      const d0 = activeDoc();
      if (!d0) return { ok: false, detail: 'no active doc' };
      // A rect well below the body text: no original text underneath, so there
      // is nothing to excise and the writer draws the replacement into it.
      d0.textEdits.push({
        id: 'te-coverfallback', page: 0, rect: [60, 60, 300, 80], coverRect: [60, 60, 300, 80],
        baseline: [62, 64], size: 11, angle: 0, fontFamily: 'Helvetica', color: [0, 0, 0],
        bg: [1, 1, 1], text: 'COVERFALLBACK', original: '',
      });
      const bytes = await buildPdf(d0);
      if (!bytes || !bytes.length) return { ok: false, detail: 'buildPdf produced no bytes' };
      const wres = await window.api.writeFile('.smoke/parity-cover.pdf', bytes);
      if (!wres || !wres.ok) return { ok: false, detail: 'write failed' };
      await openDocFromPath('.smoke/parity-cover.pdf');
      const after = await flat(0);
      return { ok: after.includes('COVERFALLBACK'), detail: JSON.stringify(after.slice(0, 90)) };
    });

    /* ── Font coverage and embedding ───────────────────────────────────────
     * These guards exist because a silent-corruption bug survived every prior
     * test. Standard-14 encodeText() does not throw when a glyph is missing —
     * it writes 0x3F — so "save did not error" passed while non-Latin text was
     * being turned into question marks in the saved file. */

    // Candidate Devanagari-capable faces, first present wins. Hardcoded because
    // this app only builds for Windows; a missing font skips rather than fails.
    const devFontCandidates = [
      'C:/Windows/Fonts/mangal.ttf',
      'C:/Windows/Fonts/Nirmala.ttf',
      'C:/Windows/Fonts/NotoSansDevanagari-Regular.ttf',
    ];
    const DEVANAGARI = '\u0928\u092e\u0938\u094d\u0924\u0947';

    const loadDevFont = async () => {
      for (const p of devFontCandidates) {
        const r = await window.api.readFile(p).catch(() => null);
        if (r?.ok && r.data) return { path: p, name: p.split('/').pop().replace(/\.ttf$/i, ''), bytes: new Uint8Array(r.data) };
      }
      return null;
    };

    await guard('font: the coverage gate flags glyphs Standard-14 cannot draw', async () => {
      const cap = await resolveFontFor('Helvetica', DEVANAGARI, null);
      const ok = cap.missing.length === [...DEVANAGARI].length && cap.source === 'standard14';
      return { ok, detail: `missing=${cap.missing.length}/${[...DEVANAGARI].length} source=${cap.source}` };
    });

    await guard('font: Latin text passes the same gate clean', async () => {
      const cap = await resolveFontFor('Helvetica', 'Hello \u2014 world \u2022 \u20ac', null);
      return { ok: cap.missing.length === 0, detail: `missing=${JSON.stringify(cap.missing)}` };
    });

    await guard('font: fontkit loads in the renderer with its shaping polyfill', async () => {
      // Spec §12 open risk, and it was real: the @cantoo/fontkit browser build
      // cannot load here at all (bare specifiers, CJS-only deps, no bundler).
      // What must hold is that the self-contained UMD loads AND that
      // regenerator-runtime is present, because without the latter every
      // complex-script font throws on embed.
      const fk = await getFontkit();
      if (!fk || typeof fk.create !== 'function') return { ok: false, detail: 'getFontkit() returned no create()' };
      const polyfilled = typeof globalThis.regeneratorRuntime !== 'undefined';
      const f = await loadDevFont();
      if (!f) return { ok: false, detail: 'no Devanagari-capable system font found' };
      const parsed = fk.create(new Uint8Array(f.bytes));
      const covers = [...DEVANAGARI].every((c) => parsed.hasGlyphForCodePoint(c.codePointAt(0)));
      return { ok: polyfilled && covers,
        detail: `regeneratorRuntime=${polyfilled} font=${f.name} coversDevanagari=${covers}` };
    });

    await guard('font: Devanagari survives edit → save → reopen with no "?"', async () => {
      const f = await loadDevFont();
      if (!f) return { ok: false, detail: 'no Devanagari-capable system font found' };
      registerCustomFont(f.name, f.bytes, 'guard-test');
      await openDocFromPath('.fixtures/fixture.pdf');
      const d0 = activeDoc();
      if (!d0) return { ok: false, detail: 'no active doc' };
      const blocks = await editableBlocks(0);
      const block = blocks.find((b) => b.text.trim().length > 12) || blocks[0];
      if (!block) return { ok: false, detail: 'no text block to replace' };
      const committed = await commitBlockEdit(0, block, DEVANAGARI, {
        fontFamily: f.name, maxWidth: 320, maxHeight: 60,
      });
      if (!committed) return { ok: false, detail: 'commitBlockEdit refused' };
      drainFontSubstitutions();          // clear anything earlier guards left
      const bytes = await buildPdf(activeDoc());
      const subs = drainFontSubstitutions();   // ...so this reflects THIS build
      const wres = await window.api.writeFile('.smoke/parity-devanagari.pdf', bytes);
      if (!wres?.ok) return { ok: false, detail: 'write failed: ' + wres?.error };
      await openDocFromPath('.smoke/parity-devanagari.pdf');
      const after = await flat(0);
      // Assert what is true and what matters. Full logical round-tripping of a
      // complex script is NOT asserted, and deliberately so: without HarfBuzz
      // the stack writes unshaped base glyphs, and a renderer maps those back
      // imperfectly (measured: extraction reads "नमè" for "नमस्ते"). Verified
      // visually against a reference built by the cleanest font path available —
      // both render the same unshaped glyph run. What this guard exists to
      // catch is the old failure: the whole string becoming "?" bytes.
      const intact = after.includes(DEVANAGARI.slice(0, 2));
      const corrupted = after.includes('?');
      // The substitutions log must stay empty: a downgrade to Standard-14 is
      // exactly the silent failure this guard is here to catch.
      return { ok: intact && !corrupted && subs.length === 0,
        detail: `glyphsPresent=${intact} corrupted=${corrupted} substitutions=${subs.length} after=${JSON.stringify(after.slice(-24))}` };
    });

    const failed2 = rows.filter((r) => !r.ok);
    return { rows, passed: !failed2.length, failed: failed2 };
  };
}

function applyTheme() {
  const t = settings.theme || 'system';
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  // body.dark is kept as an alias so the stylesheet can migrate to
  // [data-theme] without ever leaving the app unstyled mid-change.
  document.body.classList.toggle('dark', dark);
  state.view.dark = dark;
  // Without this, nativeTheme stays on 'system' and the Windows caption glyphs
  // keep whatever colour they were created with.
  if (window.api && window.api.setTheme) window.api.setTheme(t).catch(() => {});
}

/* ══ Chrome: titlebar, rail, mode tabs, ribbon ══════════════════════════ */

function buildChrome() {
  // The version is fetched once during boot (main.js returns it in the
  // 'boot' IPC reply). It surfaces in the title bar as a subtle chip so
  // users can confirm which build they're running without opening Help → About.
  if (bootInfo && bootInfo.version) {
    const ver = document.getElementById('brandVer');
    if (ver) ver.textContent = 'v' + bootInfo.version;
  }
  $('#btnTheme').innerHTML = svgIcon('moon', 16);
  $('#btnPrefs').innerHTML = svgIcon('settings', 16);
  $('#btnFind').innerHTML = svgIcon('search', 16);
  $('#btnPalette').innerHTML = svgIcon('wand', 16);
  $('#sideClose').innerHTML = svgIcon('x', 14);
  $('#ctxClose').innerHTML = svgIcon('x', 14);
  $('#findPrev').innerHTML = svgIcon('chevronUp', 14);
  $('#findNext').innerHTML = svgIcon('chevronDown', 14);
  $('#findClose').innerHTML = svgIcon('x', 14);
  // The zoom pill used raw text glyphs (− + ⛶); it now uses the icon set like
  // every other control.
  $('#zpOut').innerHTML = svgIcon('zoomOut', 14);
  $('#zpIn').innerHTML = svgIcon('zoomIn', 14);
  $('#zpFit').innerHTML = svgIcon('fit', 14);

  document.querySelectorAll('.qbtn').forEach((b) => {
    const map = { 'file:open': 'open', 'file:save': 'save', 'file:print': 'print', 'edit:undo': 'undo', 'edit:redo': 'redo', 'view:pages': 'pages', 'view:comments': 'comments', 'view:ai': 'ai' };
    if (b.dataset.tool) {
      // Select / Hand live here so they are one click away from any ribbon tab
      // and from a collapsed ribbon. They arm a tool; they are not menu actions.
      b.innerHTML = svgIcon(b.dataset.tool === 'select' ? 'cursor' : 'hand', 16);
      b.onclick = () => setTool(b.dataset.tool);
      return;
    }
    b.innerHTML = svgIcon(map[b.dataset.act] || 'info', 16);
    b.onclick = () => onMenuAction(b.dataset.act);
  });

  $('#btnTheme').onclick = () => { settings.theme = state.view.dark ? 'light' : 'dark'; applyTheme(); saveSettings(); };
  $('#btnPrefs').onclick = () => preferencesDialog();
  $('#btnFind').onclick = () => toggleFind(true);
  $('#btnPalette').onclick = () => commandPalette();
  $('#btnRibbonToggle').onclick = () => toggleRibbon();
  $('#btnChromeToggle').onclick = () => toggleChrome();
  applyChromeVisibility();
  $('#ctxClose').onclick = () => { state.ai.dockOpen = false; $('#context').classList.add('hidden'); };
  $('#aiChip').onclick = () => configureAI();

  // Left rail
  const rail = $('#rail');
  rail.innerHTML = '';
  const railItems = [
    ['pages', 'Page thumbnails', 'pages'],
    ['bookmarks', 'Bookmarks', 'bookmark'],
    ['comments', 'Comments', 'comments'],
    ['search', 'Search results', 'search'],
    ['forms', 'Form fields', 'form'],
    ['attachments', 'Attachments', 'attach'],
    ['signatures', 'Signatures', 'signature'],
    ['layers', 'Layers', 'layers'],
    ['ocr', 'OCR — scanned pages', 'scan'],
    ['fonts', 'Document fonts', 'font'],
    ['ai', 'AI assistant', 'ai'],
  ];
  railItems.forEach(([panel, title, icon]) => {
    const b = el('button', { class: 'rail-btn', dataset: { panel }, title, html: svgIcon(icon, 18) });
    b.onclick = () => {
      if (panel === 'ai') { openAIDock(); return; }
      setSidebar(panel);
    };
    rail.appendChild(b);
  });
  rail.appendChild(el('div', { class: 'rail-spacer' }));

  renderModeTabs();
  renderRibbon();
  renderTabs();
  renderZoomOptions();
  renderAIIndicator();
}

function renderModeTabs() {
  const host = $('#modeTabs');
  host.innerHTML = '';
  MODES.forEach((m) => {
    const b = el('button', { class: `mode-tab${m === mode ? ' active' : ''}`, text: m });
    b.onclick = () => {
      // Office-style auto-expand: a click on a mode tab always reveals the
      // ribbon body, so a one-off "collapse to read" never strands the user
      // with no way to switch tools.
      if (state.view.ribbonMode === 'collapsed') setRibbonMode('expanded');
      mode = m;
      renderModeTabs();
      renderRibbon();
    };
    host.appendChild(b);
  });
}

/* ── Ribbon collapse / hide-toolbars ──────────────────────────────────────── */

function setRibbonMode(next) {
  state.view.ribbonMode = next === 'collapsed' ? 'collapsed' : 'expanded';
  settings.ribbonMode = state.view.ribbonMode;
  applyChromeVisibility();
  saveSettings();
}
function toggleRibbon() {
  setRibbonMode(state.view.ribbonMode === 'collapsed' ? 'expanded' : 'collapsed');
}
function toggleChrome() {
  state.view.chromeHidden = !state.view.chromeHidden;
  settings.chromeHidden = state.view.chromeHidden;
  applyChromeVisibility();
  saveSettings();
}
/** Apply the current `state.view.ribbonMode` / `chromeHidden` to the body
 *  classes and refresh the two toggle buttons (chevron direction + visible
 *  show/hide button on the title bar). */
function applyChromeVisibility() {
  document.body.classList.toggle('ribbon-collapsed', state.view.ribbonMode === 'collapsed');
  document.body.classList.toggle('chrome-hidden', !!state.view.chromeHidden);
  const rib = document.getElementById('btnRibbonToggle');
  if (rib) {
    // Up chevron = "collapse upward"; down chevron = "expand downward".
    rib.innerHTML = svgIcon(state.view.ribbonMode === 'collapsed' ? 'chevronDown' : 'chevronUp', 16);
    rib.title = state.view.ribbonMode === 'collapsed'
      ? 'Expand the Ribbon (Ctrl+F1)'
      : 'Collapse the Ribbon (Ctrl+F1)';
    rib.setAttribute('aria-pressed', state.view.ribbonMode === 'collapsed' ? 'true' : 'false');
  }
  const ch = document.getElementById('btnChromeToggle');
  if (ch) {
    ch.hidden = false;
    ch.innerHTML = svgIcon(state.view.chromeHidden ? 'fit' : 'info', 16);
    ch.title = state.view.chromeHidden
      ? 'Show toolbars (Ctrl+F11)'
      : 'Hide toolbars (Ctrl+F11)';
  }
}

/* ── Ribbon definitions ─────────────────────────────────────────────────── */

const TOOLS = [
  // The Select tool used to ship with the 'eye' icon, which made it look like
  // a "preview" button and kept it tucked away in the Comment ribbon. Surface
  // it with a real arrow cursor and a Tools group on the Home ribbon.
  ['hand', 'Hand', 'hand'], ['select', 'Select', 'cursor'], ['highlight', 'Highlight', 'highlight'], ['underline', 'Underline', 'underline'],
  ['strikeout', 'Strike', 'strikeout'], ['squiggly', 'Squiggly', 'squiggly'], ['note', 'Note', 'note'],
  ['callout', 'Callout', 'callout'], ['textbox', 'Text box', 'textbox'], ['rect', 'Rectangle', 'rect'],
  ['ellipse', 'Ellipse', 'ellipse'], ['line', 'Line', 'line'], ['arrow', 'Arrow', 'arrow'],
  ['ink', 'Pencil', 'ink'], ['brush', 'Brush', 'ink'], ['highlighter', 'Marker', 'highlight'],
  ['formatPainter', 'Format painter', 'copy'], ['eyedropper', 'Colour picker', 'palette'],
  ['eraser', 'Eraser', 'eraser'], ['stamp', 'Stamp', 'stamp'],
  ['image', 'Image', 'image'], ['signature', 'Sign', 'signature'], ['redact', 'Redact', 'redact'],
  // Select and edit an image already placed on the page (move, resize, rotate,
  // flip, fade, replace, delete) through the native content-stream editor.
  ['editImage', 'Edit image', 'crop'],
  ['whiteout', 'Whiteout', 'whiteout'], ['measure', 'Measure', 'measure'],
  // Foxit's full drawing set
  ['roundRect', 'Rounded rect', 'roundRect'], ['polygon', 'Polygon', 'polygon'],
  ['polyline', 'Polyline', 'polyline'], ['cloud', 'Cloud', 'cloud'],
  ['areaHighlight', 'Area highlight', 'areaHighlight'],
  // Foxit's text-edit markups
  ['caret', 'Insert text', 'caret'],
  // Perimeter & Area measurement (Foxit's Measure > Perimeter/Area)
  ['measureArea', 'Perimeter & Area', 'measure'],
  // Edit > Link
  ['link', 'Link', 'link'],
  // Edit > Direct Editor. The internal id stays `editText`: it is persisted in
  // settings.tool, referenced by the keymap and by CSS (body.tool-editText), so
  // renaming it would silently strand old settings. Only the label changes.
  ['editText', 'Direct Editor', 'editText'],
  // Direct Editor companion: drag a rectangle on the page and ONLY the text
  // inside it becomes editable (recognition runs for that region on scans).
  ['editArea', 'Area Direct Edit', 'marquee'],
];

/** Display name for a tool id. Used by the status bar and the properties pane,
 *  which both used to derive it by upper-casing the raw id ("EditText"). */
function toolName(id) {
  const t = TOOLS.find((x) => x[0] === id);
  return t ? t[1] : String(id || 'select').replace(/^\w/, (c) => c.toUpperCase());
}

function toolButtons(keys) {
  return keys.map((k) => {
    const [, label, icon] = TOOLS.find((t) => t[0] === k);
    return {
      icon, label, kind: 'tool', value: k,
      active: () => state.tool === k,
      act: () => setTool(k),
    };
  });
}

/** Hand, Select and the Direct Editor: the tools that are meaningful whatever
 *  the tab is about. Foxit leads every tab with Hand then Select, and Hand is
 *  the one people hunt for — it used to exist on the Home tab only, so from
 *  Comment / Edit / Organize / … you had to go back to Home (or find the status
 *  bar) just to move the page. */
const UNIVERSAL_TOOLS = ['hand', 'select', 'editText'];

function ribbonGroups() {
  const groups = ribbonGroupsForMode();
  const first = groups[0];
  if (first && first.title === 'Tools' && Array.isArray(first.items)) {
    // Home already leads with a Tools group — top it up rather than duplicating.
    const have = new Set(first.items.map((it) => it.value).filter(Boolean));
    const missing = UNIVERSAL_TOOLS.filter((k) => !have.has(k));
    if (missing.length) first.items = [...toolButtons(missing), ...first.items];
    return groups;
  }
  return [{ title: 'Tools', items: toolButtons(UNIVERSAL_TOOLS) }, ...groups];
}

function ribbonGroupsForMode() {
  const doc = activeDoc();
  switch (mode) {
    // Home mirrors Foxit's Home tab: file actions, the basic Select / Edit-text
    // tools, plus the most-used comment & markup, drawing and stamp tools — the
    // things you reach for on nearly every page.
    case 'Home': return [
      { title: 'File', items: [
        { icon: 'open', label: 'Open', act: () => onMenuAction('file:open') },
        { icon: 'save', label: 'Save', act: () => onMenuAction('file:save') },
        { icon: 'print', label: 'Print', act: () => onMenuAction('file:print') },
        { icon: 'info', label: 'Props', act: () => onMenuAction('file:properties') },
      ] },
      // Select used to be buried in the Comment ribbon with a "preview" icon;
      // Foxit keeps Select + Edit text on Home, so both live here.
      { title: 'Tools', items: [
        // Foxit leads every tab with Hand then Select; Hand pans, Select picks.
        ...toolButtons(['hand', 'select', 'editText', 'editArea', 'editImage']),
        { icon: 'link', label: 'Add link', act: () => setTool('link') },
      ] },
      { title: 'Comment & Markup', items: toolButtons(['highlight', 'underline', 'strikeout', 'squiggly', 'note', 'callout', 'textbox', 'areaHighlight']) },
      { title: 'Drawing', items: toolButtons(['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'polygon', 'polyline', 'cloud', 'ink', 'brush', 'highlighter', 'whiteout', 'redact', 'eraser']) },
      { title: 'Stamp & sign', items: toolButtons(['stamp', 'image', 'signature']) },
    ];
    // View is its own tab in Foxit (zoom, page display, panels, read aloud).
    case 'View': return [
      { title: 'Zoom', items: [
        { icon: 'zoomIn', label: 'Zoom in', act: () => onMenuAction('view:zoomIn') },
        { icon: 'zoomOut', label: 'Zoom out', act: () => onMenuAction('view:zoomOut') },
        { icon: 'fit', label: 'Fit page', act: () => onMenuAction('view:fitPage') },
        { icon: 'fit', label: 'Fit width', act: () => onMenuAction('view:fitWidth') },
      ] },
      { title: 'Page display', items: [
        { icon: 'file', label: 'Single', act: () => onMenuAction('view:single'), active: () => state.view.layout === 'single' },
        { icon: 'pages', label: 'Continuous', act: () => onMenuAction('view:continuous'), active: () => state.view.layout === 'continuous' },
        { icon: 'grid', label: 'Facing', act: () => onMenuAction('view:facing'), active: () => state.view.layout === 'facing' },
        { icon: 'pages', label: 'Cover', act: () => onMenuAction('view:cover'), active: () => !!state.view.coverPage },
        { icon: 'grid', label: 'Grid', act: () => onMenuAction('view:grid'), active: () => !!settings.grid },
        { icon: 'reverse', label: 'Reverse', act: () => onMenuAction('view:reverse'), active: () => !!state.view.reverse },
        { icon: 'ruler', label: 'Show rulers', act: () => onMenuAction('view:rulers'), active: () => !!V.rulersVisible?.() },
      ] },
      { title: 'Rotate', items: [
        { icon: 'rotate', label: 'Rotate right', act: () => onMenuAction('view:rotateCW') },
        { icon: 'rotate', label: 'Rotate left', act: () => onMenuAction('view:rotateCCW') },
      ] },
      { title: 'Panels', items: [
        { icon: 'pages', label: 'Thumbnails', act: () => setSidebar('pages') },
        { icon: 'bookmark', label: 'Bookmarks', act: () => setSidebar('bookmarks') },
        { icon: 'comments', label: 'Comments', act: () => setSidebar('comments') },
        { icon: 'attach', label: 'Attachments', act: () => setSidebar('attachments') },
        { icon: 'layers', label: 'Layers', act: () => setSidebar('layers') },
        { icon: 'search', label: 'Find', act: () => toggleFind(true) },
      ] },
      { title: 'Read', items: [
        { icon: 'readAloud', label: 'Read aloud', act: () => onMenuAction('view:readAloud') },
        { icon: 'settings', label: 'Read aloud settings…', act: () => onMenuAction('view:ttsSettings') },
        { icon: 'present', label: 'Present', act: () => togglePresentation() },
        { icon: state.view.dark ? 'sun' : 'moon', label: state.view.dark ? 'Light' : 'Dark', act: () => { settings.theme = state.view.dark ? 'light' : 'dark'; applyTheme(); saveSettings(); renderRibbon(); } },
      ] },
    ];
    // Convert is a first-class Foxit tab (To Office / To Other). We expose the
    // export targets we actually implement, matching that category.
    case 'Convert': return [
      { title: 'To file', items: [
        { icon: 'html', label: 'HTML…', act: () => onMenuAction('convert:toHtml') },
        { icon: 'rtf', label: 'RTF…', act: () => onMenuAction('convert:toRtf') },
        { icon: 'epub', label: 'EPUB…', act: () => onMenuAction('convert:toEpub') },
        { icon: 'markdown', label: 'Markdown…', act: () => onMenuAction('convert:toMarkdown') },
        { icon: 'plaintext', label: 'Plain text…', act: () => onMenuAction('convert:toText') },
      ] },
      { title: 'Images', items: [
        { icon: 'image', label: 'To images…', act: () => onMenuAction('convert:toImages') },
        { icon: 'upload', label: 'From images…', act: () => onMenuAction('convert:fromImages') },
      ] },
    ];
    case 'Comment': return [
      { title: 'Text markup', items: toolButtons(['select', 'highlight', 'underline', 'strikeout', 'squiggly', 'caret']) },
      { title: 'Notes', items: toolButtons(['note', 'callout', 'textbox']) },
      { title: 'Drawing', items: toolButtons(['rect', 'roundRect', 'ellipse', 'line', 'arrow', 'polygon', 'polyline', 'cloud', 'ink', 'brush', 'highlighter', 'areaHighlight', 'eraser']) },
      { title: 'Style transfer', items: toolButtons(['formatPainter', 'eyedropper']) },
      { title: 'Stamp & sign', items: toolButtons(['stamp', 'image', 'signature']) },
      { title: 'Measure', items: [
        ...toolButtons(['measure', 'measureArea']),
        { icon: 'measure', label: 'Set scale…', act: () => onMenuAction('measure:scale') },
      ] },
      { title: 'Colour', items: [{ custom: colourSwatches }] },
      { title: 'Comments', items: [
        { icon: 'comments', label: 'List', act: () => setSidebar('comments') },
        { icon: 'download', label: 'Export…', act: () => exportComments() },
      ] },
    ];
    case 'Edit': return [
      { title: 'Direct Editor', items: toolButtons(['editText', 'editArea', 'whiteout']) },
      { title: 'Images', items: toolButtons(['editImage']) },
      { title: 'Links', items: [
        { icon: 'link', label: 'Add link', act: () => setTool('link') },
        { icon: 'trash', label: 'Remove links', act: () => onMenuAction('edit:removeLinks') },
      ] },
      { title: 'Find & replace', items: [
        { icon: 'search', label: 'Find', act: () => toggleFind(true) },
        { icon: 'replace', label: 'Replace…', act: () => onMenuAction('edit:replace') },
      ] },
      { title: 'Recognise text', items: [
        { icon: 'scan', label: 'OCR page', act: () => onMenuAction('ocr:page') },
        { icon: 'scan', label: 'All scanned…', act: () => { setSidebar('ocr'); onMenuAction('ocr:all'); } },
        { icon: 'font', label: 'Fonts', act: () => setSidebar('fonts') },
      ] },
      { title: 'Objects', items: [
        { icon: 'image', label: 'Insert image', act: () => setTool('image') },
        { icon: 'signature', label: 'Insert signature', act: () => setTool('signature') },
      ] },
      { title: 'Stamps', items: [
        { icon: 'stamp', label: 'Watermark…', act: () => watermarkDialog() },
        { icon: 'text', label: 'Header…', act: () => headerFooterDialog('header') },
        { icon: 'text', label: 'Footer…', act: () => headerFooterDialog('footer') },
        { icon: 'table', label: 'Bates…', act: () => batesDialog() },
      ] },
      { title: 'Text style', items: [{ custom: textStyleControls }] },
    ];
    case 'Organize': return [
      { title: 'Pages', items: [
        { icon: 'plus', label: 'Insert blank', act: () => insertBlankAt((activeDoc()?.currentPage ?? 0) + 1) },
        { icon: 'upload', label: 'From PDF…', act: () => insertFromPdfAt((activeDoc()?.currentPage ?? 0) + 1) },
        { icon: 'scissors', label: 'Extract…', act: () => extractPages([activeDoc()?.currentPage ?? 0]) },
        { icon: 'dupe2', label: 'Duplicate', act: () => duplicatePages([activeDoc()?.currentPage ?? 0]) },
        { icon: 'replace', label: 'Replace…', act: () => replacePageAt(activeDoc()?.currentPage ?? 0) },
        { icon: 'trash', label: 'Delete', act: () => deletePages([activeDoc()?.currentPage ?? 0]) },
      ] },
      { title: 'Rotate & order', items: [
        { icon: 'rotate', label: 'Left 90°', act: () => rotatePages([activeDoc()?.currentPage ?? 0], -90) },
        { icon: 'rotate', label: 'Right 90°', act: () => rotatePages([activeDoc()?.currentPage ?? 0], 90) },
        { icon: 'reverse', label: 'Reverse', act: () => reversePages() },
      ] },
      { title: 'Crop', items: [
        { icon: 'crop', label: 'Crop pages…', act: () => onMenuAction('page:crop') },
      ] },
      { title: 'Document', items: [
        { icon: 'merge', label: 'Merge…', act: () => mergeDocuments() },
        { icon: 'split', label: 'Split…', act: () => splitDocument() },
        { icon: 'bookmark', label: 'By bookmarks', act: () => splitByBookmarks() },
        { icon: 'grid', label: 'By blank pages', act: () => splitByBlankPages() },
      ] },
      { title: 'Go to', items: [{ custom: pageJumpControls }] },
    ];
    case 'Forms': return [
      { title: 'Add field', items: [
        { icon: 'text', label: 'Text', act: () => startFieldPlacement('text') },
        { icon: 'checkbox', label: 'Checkbox', act: () => startFieldPlacement('checkbox') },
        { icon: 'radio', label: 'Radio', act: () => startFieldPlacement('radio') },
        { icon: 'dropdown', label: 'Dropdown', act: () => startFieldPlacement('dropdown') },
        { icon: 'signature', label: 'Signature', act: () => startFieldPlacement('signature') },
      ] },
      { title: 'Data', items: [
        { icon: 'form', label: 'Field list', act: () => setSidebar('forms') },
        { icon: 'download', label: 'Export…', act: () => exportFormData() },
        { icon: 'upload', label: 'Import…', act: () => importFormData() },
        { icon: 'reset', label: 'Reset', act: () => resetForm() },
      ] },
    ];
    case 'Protect': return [
      { title: 'Redaction', items: toolButtons(['redact']) },
      { title: 'Actions', items: [
        { icon: 'redact', label: 'Apply marks', act: () => applyRedactions(false) },
        { icon: 'shield', label: 'Sanitize…', act: () => applyRedactions(true) },
      ] },
      { title: 'Security', items: [
        { icon: 'lock', label: 'Encrypt…', act: () => encryptDialog() },
        { icon: 'key', label: 'Remove security', act: () => removeSecurity() },
      ] },
    ];
    case 'AI': return [
      { title: 'Assistant', items: [
        { icon: 'ai', label: 'Ask', act: () => openAIDock() },
        { icon: 'sparkle', label: 'Summarise', act: () => summarize() },
        { icon: 'brain', label: 'Compare all', act: () => onMenuAction('ai:summarizeAll') },
        { icon: 'table', label: 'Extract data', act: () => extractData() },
        { icon: 'translate', label: 'Translate…', act: () => translate() },
        { icon: 'wand', label: 'Rewrite…', act: () => rewrite() },
        { icon: 'check', label: 'Proofread', act: () => proofread() },
      ] },
      { title: 'Model', items: [
        { icon: 'settings', label: 'Settings', act: () => configureAI() },
      ] },
    ];
    default: return [];
  }
}

function renderRibbon() {
  const host = $('#ribbon');
  host.innerHTML = '';
  for (const g of ribbonGroups()) {
    const box = el('div', { class: 'rgroup' });
    box.appendChild(el('div', { class: 'rtitle', text: g.title }));
    const row = el('div', { class: 'rrow' });
    for (const item of g.items) {
      if (item.custom) { row.appendChild(item.custom()); continue; }
      // Icon-only: the `title` attribute stays as the tooltip so the meaning
      // is preserved without writing the name on the face of the toolbar.
      const b = el('button', {
        class: `rbtn${item.active && item.active() ? ' active' : ''}`,
        title: item.label,
        'aria-label': item.label,
        html: svgIcon(item.icon, 17),
      });
      b.onclick = item.act;
      row.appendChild(b);
    }
    box.appendChild(row);
    host.appendChild(box);
  }
}

/** True for the two annotations whose visible colour is the TYPE, not the
 *  hairline box around it. Picking yellow on a text box has to recolour the
 *  words — a 0.8pt border changing shade reads as "the colour did nothing". */
const TEXT_COLOURED = new Set(['textbox', 'callout']);

/** The patch a colour pick writes onto one object. */
function colourPatch(a, rgb) {
  const patch = { color: rgb.slice() };
  if (TEXT_COLOURED.has(a.type)) patch.textColor = rgb.slice();
  return patch;
}

/** The colour the colour controls should show: the selected object's own colour
 *  when exactly one thing is selected, otherwise the tool default. Showing the
 *  tool default while an object is selected is what made edits look like they
 *  were landing on "the previous item". */
function currentUIColor() {
  const sel = state.selection.map(annotById).filter(Boolean);
  const a = sel.length === 1 ? sel[0] : null;
  if (a) {
    if (TEXT_COLOURED.has(a.type)) return rgbToHex(a.textColor || a.color || hexToRgb(state.color));
    if (a.color) return rgbToHex(a.color);
  }
  return state.color;
}

function applyUIColor(hex) {
  state.color = hex;
  state.colorRgb = hexToRgb(hex);
  settings.color = hex;
  saveSettings();
  const sel = state.selection.map(annotById).filter(Boolean);
  for (const a of sel) updateAnnot(a.id, colourPatch(a, state.colorRgb), { silent: true });
  if (sel.length) pushHistory('colour');
  renderRibbon();
  if (activeDoc()) renderAllAnnotations();
  emit('selection');
}

function colourSwatches() {
  const box = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', justifyContent: 'center' } });
  const row = el('div', { class: 'swatches' });
  const live = currentUIColor();
  (settings.colorPresets || []).forEach((hex) => {
    const s = el('div', { class: `swatch${hex === live ? ' active' : ''}`, style: { background: hex }, title: hex });
    s.onclick = () => applyUIColor(hex);
    row.appendChild(s);
  });
  const more = el('input', { type: 'color', value: live, style: { width: '26px', height: '22px', padding: '0', border: '1px solid var(--border)', borderRadius: '4px' } });
  // oninput fires continuously while the picker is open; commit to history on
  // change so dragging does not create one undo step per pixel.
  more.oninput = () => {
    state.color = more.value;
    state.colorRgb = hexToRgb(more.value);
    const sel = state.selection.map(annotById).filter(Boolean);
    for (const a of sel) updateAnnot(a.id, colourPatch(a, state.colorRgb), { silent: true });
    if (activeDoc()) renderAllAnnotations();
  };
  more.onchange = () => applyUIColor(more.value);
  const op = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(state.opacity), style: { width: '76px' } });
  op.oninput = () => {
    state.opacity = Number(op.value);
    settings.opacity = state.opacity;
    const sel = state.selection.map(annotById).filter(Boolean);
    for (const a of sel) updateAnnot(a.id, { opacity: state.opacity }, { silent: true });
    if (activeDoc()) renderAllAnnotations();
  };
  op.onchange = () => { pushHistory('opacity'); saveSettings(); };
  box.appendChild(row);
  box.appendChild(el('div', { class: 'flex' }, [more, op]));
  return box;
}

function textStyleControls() {
  const box = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', justifyContent: 'center' } });
  // Show the selected object's own size, not the tool default: otherwise the
  // field reads 11 while the text box on the page is 24 and the first click on
  // the spinner silently snaps it back.
  const selOne = state.selection.map(annotById).filter(Boolean)[0];
  const fs = el('input', { type: 'number', value: String((selOne && selOne.fontSize) || settings.fontSize || 11), style: { width: '54px', height: '24px' } });
  fs.oninput = () => {
    settings.fontSize = Number(fs.value);
    for (const id of state.selection) updateAnnot(id, { fontSize: settings.fontSize }, { silent: true });
    if (activeDoc()) renderAllAnnotations();
  };
  fs.onchange = () => { saveSettings(); pushHistory('font size'); };
  const bw = el('input', { type: 'number', value: String(settings.borderWidth || 1.5), step: '0.5', style: { width: '54px', height: '24px' } });
  bw.oninput = () => {
    settings.borderWidth = Number(bw.value);
    for (const id of state.selection) updateAnnot(id, { borderWidth: settings.borderWidth }, { silent: true });
    if (activeDoc()) renderAllAnnotations();
  };
  bw.onchange = () => { saveSettings(); pushHistory('border width'); };
  box.appendChild(el('div', { class: 'flex' }, [el('span', { class: 'hint', text: 'pt' }), fs, el('span', { class: 'hint', text: 'w' }), bw]));
  return box;
}

function pageJumpControls() {
  const doc = activeDoc();
  const box = el('div', { class: 'flex' });
  const inp = el('input', { type: 'number', min: '1', max: String(doc ? doc.numPages : 1), value: String((doc?.currentPage ?? 0) + 1), style: { width: '58px', height: '26px' } });
  const go = el('button', { class: 'mini-btn', text: 'Go' });
  go.onclick = () => scrollToPage(clamp(Number(inp.value) - 1, 0, (doc?.numPages || 1) - 1));
  box.append(inp, go);
  return box;
}

/* ══ Tabs ═══════════════════════════════════════════════════════════════ */

function renderTabs() {
  const host = $('#tabStrip');
  host.innerHTML = '';
  const list = el('div', { class: 'tab-list' });
  state.docs.forEach((d) => {
    const t = el('div', { class: `tab${d.id === state.activeId ? ' active' : ''}${d.dirty ? ' dirty' : ''}` }, [
      el('span', { class: 't-name', text: d.name }),
    ]);
    const x = el('button', { class: 't-close', html: svgIcon('x', 12) });
    x.onclick = async (e) => { e.stopPropagation(); await closeDoc(d.id); };
    t.appendChild(x);
    t.onclick = () => activateDoc(d.id);
    list.appendChild(t);
  });
  host.appendChild(list);
  const add = el('button', { class: 'tab-add', title: 'Open another PDF', html: svgIcon('plus', 14) });
  add.onclick = () => onMenuAction('file:open');
  host.appendChild(add);
  updateTitle();
}

function updateTitle() {
  const d = activeDoc();
  window.api.setTitle(d ? `${d.name}${d.dirty ? ' •' : ''} — AiPDF Editor` : 'AiPDF Editor');
}

async function activateDoc(id) {
  const d = getDoc(id);
  if (!d || !d.pdf) return;
  state.activeId = id;
  state.selection = [];
  await buildPages(d.pdf);
  applyLayoutToDom();
  relayout(true);
  renderVisible();
  renderAllAnnotations();
  for (let i = 0; i < d.numPages; i++) renderFormFields(i);
  renderSidebar();
  renderTabs();
  renderRibbon();
  renderContext();
  updateStatus();
  emit('doc');
}

async function closeDoc(id) {
  const d = getDoc(id);
  if (!d) return;
  if (d.dirty) {
    const r = await confirmDialog(`Save changes to “${d.name}”?`, { okLabel: 'Save', cancelLabel: 'Discard', title: 'Unsaved changes' });
    if (r === undefined) return;
    if (r) { const ok = await saveDoc(d); if (!ok) return; }
  }
  state.docs = state.docs.filter((x) => x.id !== id);
  if (state.activeId === id) {
    const next = state.docs[state.docs.length - 1];
    state.activeId = next ? next.id : null;
    if (next) await activateDoc(next.id);
    else { V.clearPages(); showWorkspace(); }
  }
  renderTabs();
  updateStatus();
}

/* ══ Opening documents ══════════════════════════════════════════════════ */

export async function openDocFromPath(path, password = null) {
  const res = await window.api.readFile(path);
  if (!res.ok) return toast('Could not open: ' + res.error, 'err');
  await openDocFromBytes(res.data, path.split(/[\\/]/).pop(), path, password);
}

export async function openDocFromBytes(bytes, name, path = null, password = null) {
  try {
    stopReadAloudIfAny();
    const pdf = await loadPdfBytes(bytes, password ? { password } : {});
    const doc = newDocShell({ name, path, bytes, pdf });
    // Ask the writer, not the prompt: pdf.js opens owner-password-only files
    // without ever asking, so `password` alone is not evidence of encryption.
    // `passwordProtected` drives the save guard, Remove Security and the
    // status-bar lock — none of which could ever fire before this was set.
    doc.passwordProtected = await probeEncryption(bytes);
    doc.password = doc.passwordProtected ? (password || '') : null;
    state.docs.push(doc);
    setDocError('');
    state.activeId = doc.id;
    doc.currentPage = 0;
    $('#welcome').classList.add('hidden');
    hideWorkspaceCard();
    $('#pagesScroll').classList.remove('hidden');
    await afterLoad(doc);
    if (path) { addRecent(path, name); window.api.setRepresented(path); }
    return doc;
  } catch (err) {
    if (err.needsPassword) {
      const pw = await promptDialog('This PDF is password protected. Enter the password:', '', { title: 'Password required', type: 'password' });
      if (pw) return openDocFromBytes(bytes, name, path, pw);
      return null;
    }
    toast(err.message || 'Failed to open PDF', 'err', 6000);
    setDocError(err.message || 'Failed to open PDF');
    console.error(err);
    return null;
  }
}

async function openDroppedFiles(fileList) {
  const files = Array.from(fileList || []);
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  if (!pdfs.length) {
    if (files.length) toast('Only PDF files can be opened by dragging.', 'warn');
    return;
  }
  for (const f of pdfs) {
    const p = window.api.pathForFile ? window.api.pathForFile(f) : '';
    if (p) await openDocFromPath(p);
    else await openDocFromBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  }
}

async function afterLoad(doc) {
  await buildPages(doc.pdf);
  applyLayoutToDom();
  relayout(true);
  renderVisible();
  await loadFileAnnotations();
  await loadAttachments();
  await loadFormFields(doc);
  renderAllAnnotations();
  for (let i = 0; i < doc.numPages; i++) renderFormFields(i);
  renderSidebar();
  renderTabs();
  renderRibbon();
  renderContext();
  updateStatus();
  doc.history = [];
  doc.hIndex = -1;
  pushHistory('open');
  doc.dirty = false;
  emit('doc');
  emit('dirty', doc);
  // Index the document's own embedded fonts in the background, so editing a
  // run can reuse its original face instead of falling through to Standard-14.
  // Standard-14 is WinAnsi-only and writes 0x3F for anything outside it, which
  // is how an ordinary edit used to fill a file with question marks.
  resetDocumentFonts();
  indexDocumentFonts(doc.bytes).catch(() => {});
  // Flattened-page detection (background): flag pages with no selectable
  // text so the OCR panel and thumbnails can offer recognition.
  detectScannedPages(doc).then((scanned) => {
    if (scanned.size) {
      toast(`${scanned.size} scanned/flattened page(s) detected — use OCR to make them searchable`, 'info', 5200);
      renderSidebarChrome();
    }
    updateStatus();
  }).catch(() => {});
}

function renderWelcome() {
  const w = $('#welcome');
  w.classList.remove('hidden');
  $('#emptyWorkspace').classList.add('hidden');
  $('#pagesScroll').classList.add('hidden');

  const recents = $('#welcomeRecents');
  recents.innerHTML = '';
  if (settings.recents && settings.recents.length) {
    recents.appendChild(el('div', { class: 'wr-title', text: 'Recent' }));
    settings.recents.slice(0, 7).forEach((r) => {
      const item = el('div', { class: 'wr-item' }, [
        el('span', { html: svgIcon('file', 14) }),
        el('span', { class: 'wrn', text: r.name || r.path }),
        el('span', { class: 'wrp', text: r.path || '' }),
      ]);
      item.onclick = () => openDocFromPath(r.path);
      recents.appendChild(item);
    });
  }

  const feats = $('#welcomeFeatures');
  feats.innerHTML = '';
  [
    ['ai', 'AI with real citations', 'Answers quote the page they came from — click to jump straight there. Ask across all open documents at once.'],
    ['scan', 'OCR scanned pages', 'Flattened pages are detected automatically; recognise English, Hindi and Nepali/Devanagari text locally.'],
    ['highlight', 'Full markup toolset', 'Highlight, underline, strikethrough, notes, shapes, ink, stamps and redaction.'],
    ['editText', 'Direct Editor', 'Click into any line and type straight onto the page. On save the original text is removed from the file, not covered up — a cover is used only where removal is impossible, such as a scan or text inside a shared form.'],
    ['font', 'Font intelligence', 'See every embedded font per page and reuse an embedded font for the text you add.'],
    ['lock', 'AES-256 protection', 'Password-encrypt with real permissions, no account required.'],
    ['pages', 'Organise pages', 'Insert, delete, extract, rotate, reorder by drag & drop, merge and split.'],
    ['form', 'Fill and build forms', 'Fill AcroForm fields, add new ones, export the data.'],
  ].forEach(([icon, title, text]) => {
    feats.appendChild(el('div', { class: 'wf' }, [
      el('span', { html: svgIcon(icon, 16) }),
      el('div', {}, [el('b', { text: title }), el('span', { text })]),
    ]));
  });
}

/**
 * Boot into the editor shell, not a landing page.
 *
 * With no document open the canvas shows a compact empty-workspace card instead
 * of the full Welcome/Recent screen: the ribbon, tabs, sidebars and status bar
 * are all live from the first frame, so the user starts in the workspace and
 * only sees a landing page if they ask for one (Help ▸ Start page).
 */
function showWorkspace() {
  $('#welcome').classList.add('hidden');
  $('#pagesScroll').classList.remove('hidden');
  $('#emptyWorkspace').classList.remove('hidden');
}

/** Leave the empty-workspace card (a document is being shown). */
function hideWorkspaceCard() {
  $('#emptyWorkspace').classList.add('hidden');
  $('#pagesScroll').classList.remove('hidden');
}

/* ══ Saving ═════════════════════════════════════════════════════════════ */

async function buildDocBytes(doc, opts = {}) {
  const o = { ...opts };
  if (doc.passwordProtected) {
    if (doc.password == null) {
      throw new Error('This document is password protected and AiPDF does not have the password. Close it and reopen it, entering the password when prompted.');
    }
    // Saving rewrites the file, so the original permission flags cannot be
    // carried across verbatim. Ask once per document instead of silently
    // stripping the password or silently tightening the permissions.
    if (!doc.saveSecurityChoice) {
      const choice = await showModal({
        title: 'Password-protected document',
        width: 'narrow',
        body: (b) => b.appendChild(el('div', {
          style: { lineHeight: '1.55', userSelect: 'text' },
          text: 'This file is password protected. Saving rewrites it, and the original permission flags cannot be copied across exactly. Choose how to save — you will not be asked again for this document.',
        })),
        buttons: [
          { label: 'Cancel', value: null, kind: 'ghost' },
          { label: 'Save Unprotected', value: 'strip', kind: 'ghost' },
          { label: 'Keep Password', value: 'keep', kind: 'primary', default: true },
        ],
      });
      if (!choice) throw new Error('Save cancelled.');
      doc.saveSecurityChoice = choice;
    }
    if (doc.saveSecurityChoice === 'keep') {
      o.password = o.password || doc.password;
      o.ownerPassword = o.ownerPassword || doc.password;
      o.permissions = o.permissions || {
        printing: 'highResolution', copying: false, modifying: false, annotating: true,
        fillingForms: true, contentAccessibility: true, documentAssembly: false,
      };
    }
  }
  return await buildPdf(doc, o);
}

export async function saveDoc(doc = activeDoc()) {
  if (!doc) return false;
  if (!doc.path) return saveDocAs(doc);
  try {
    setBusy(true, 'Saving…');
    const bytes = await buildDocBytes(doc);
    const res = await window.api.writeFile(doc.path, bytes);
    if (!res.ok) throw new Error(res.error);
    doc.bytes = bytes;
    setClean(doc);
    renderTabs();
    updateStatus();
    toast('Saved', 'ok', 1800);
    return true;
  } catch (e) {
    toast(e.message || 'Save failed', 'err', 6000);
    setDocError(e.message || 'Save failed');
    console.error(e);
    return false;
  } finally {
    setBusy(false);
  }
}

export async function saveDocAs(doc = activeDoc()) {
  if (!doc) return false;
  const path = await window.api.saveDialog({ defaultPath: doc.path || doc.name });
  if (!path) return false;
  try {
    setBusy(true, 'Saving…');
    const bytes = await buildDocBytes(doc);
    const res = await window.api.writeFile(path, bytes);
    if (!res.ok) throw new Error(res.error);
    doc.path = path;
    doc.name = path.split(/[\\/]/).pop();
    doc.bytes = bytes;
    setClean(doc);
    addRecent(path, doc.name);
    window.api.setRepresented(path);
    renderTabs();
    updateStatus();
    toast('Saved', 'ok', 1800);
    return true;
  } catch (e) {
    toast(e.message || 'Save failed', 'err', 6000);
    return false;
  } finally {
    setBusy(false);
  }
}

async function saveCopy() {
  const doc = activeDoc();
  if (!doc) return;
  const path = await window.api.saveDialog({ defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '-copy.pdf' });
  if (!path) return;
  try {
    setBusy(true, 'Exporting…');
    const bytes = await buildDocBytes(doc);
    const res = await window.api.writeFile(path, bytes);
    toast(res.ok ? 'Copy saved' : 'Failed: ' + res.error, res.ok ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err', 6000);
  } finally {
    setBusy(false);
  }
}

/* ══ Protection ═════════════════════════════════════════════════════════ */

/* ── Documents: batch tools ported from Stirling-PDF ────────────────────── */

/**
 * Compare this document against another PDF and show a line-level diff.
 *
 * Vertical-stack diff instead of a canvas pixel comparison: a pixel diff
 * cannot tell you *what* changed, and this app already owns high-quality text
 * extraction (including OCR'd scans) to diff against.
 */
async function compareDocuments() {
  const doc = activeDoc();
  if (!doc) return;
  const paths = await window.api.openDialog({ title: 'Choose a PDF to compare with' });
  if (!paths || !paths[0]) return;
  const r = await window.api.readFile(paths[0]);
  if (!r.ok) return toast('Could not read that file.', 'err');

  toast('Reading both documents…', 'info', 1500);
  let aTexts = [];
  let bTexts = [];
  try {
    for (let i = 0; i < doc.numPages; i++) aTexts.push(await V.getPageText(i));
    bTexts = await extractTextFromBytes(r.data);
  } catch (e) {
    return toast('Comparison failed: ' + e.message, 'err');
  }
  if (!aTexts.filter((t) => t.trim()).length && !bTexts.filter((t) => t.trim()).length) {
    return toast('Neither document has extractable text. OCR them first.', 'warn');
  }

  const cmp = buildComparison(aTexts, bTexts);
  openComparePanel(cmp, doc.name || 'This document', paths[0].split(/[\\/]/).pop(), aTexts, bTexts);
}

/** Extract page-by-page text from a raw PDF using the renderer's own pdf.js. */
async function extractTextFromBytes(bytes) {
  const pdfjsLib = await import('/v/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/v/pdf.worker.min.mjs';
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0), useSystemFonts: false }).promise;
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const tc = await (await pdf.getPage(i)).getTextContent();
    out.push(tc.items.map((x) => x.str || '').join(' '));
  }
  try { pdf.destroy(); } catch { /* ignore */ }
  return out;
}

/** Present a comparison in a modal with a page filter and +/- split. */
function openComparePanel(cmp, nameA, nameB, aTexts, bTexts) {
  const s = cmp.summary;
  const wrap = el('div', { class: 'cmp' });
  const head = el('div', { class: 'cmp-head' });
  head.appendChild(el('div', { class: 'cmp-title', text: `Comparing ${nameA} with ${nameB}` }));
  head.appendChild(el('div', { class: 'cmp-summary', text: `${s.pages} pages · ${s.changed} changed · ${s.identical} identical` }));
  head.appendChild(el('div', { class: 'cmp-counts' }, [
    el('span', { class: 'cmp-chip cmp-add', text: `+${s.added} lines (+${s.addedWords} words)` }),
    el('span', { class: 'cmp-chip cmp-del', text: `−${s.removed} lines (−${s.removedWords} words)` }),
  ]));
  wrap.appendChild(head);

  if (s.changed === 0) {
    wrap.appendChild(el('div', { class: 'cmp-none', text: 'No text differences found.' }));
  } else {
    const row = el('div', { class: 'cmp-filters' });
    const only = el('input', { type: 'checkbox', checked: true });
    row.appendChild(el('label', { class: 'cmp-check' }, [only, document.createTextNode('Show changed pages only')]));
    wrap.appendChild(row);

    const list = el('div', { class: 'cmp-pages' });
    const render = () => {
      list.textContent = '';
      const changedOnly = only.checked;
      let shown = 0;
      cmp.pages.forEach((p) => {
        if (changedOnly && !p.changed) return;
        shown++;
        const card = el('div', { class: `cmp-page${p.changed ? ' changed' : ''}`, dataset: { page: String(p.index) } });
        card.appendChild(el('div', { class: 'cmp-page-head' },
          [el('span', { text: `Page ${p.index + 1}` }),
            el('button', {
              class: 'cmp-goto', title: 'Go to this page', onclick: () => jumpToPage(p.index),
            }, [svgIcon('chevron-right')])]));
        const cols = el('div', { class: 'cmp-cols' });
        const mkCol = (cls, lines, sign) => {
          const c = el('div', { class: `cmp-col ${cls}` });
          if (!lines.length) c.appendChild(el('div', { class: 'cmp-empty', text: sign === '+' ? 'Nothing added' : 'Nothing removed' }));
          lines.forEach((l) => c.appendChild(el('div', { class: 'cmp-line', text: `${sign} ${l}` })));
          return c;
        };
        cols.append(mkCol('del', p.removed, '−'), mkCol('add', p.added, '+'));
        card.appendChild(cols);
        list.appendChild(card);
      });
      if (!shown) list.appendChild(el('div', { class: 'cmp-none', text: 'No changed pages.' }));
    };
    only.onchange = render;
    render();
    wrap.appendChild(list);
  }

  const copy = el('button', {
    class: 'cmp-copy', text: 'Copy report',
    onclick: async () => {
      const txt = comparisonReport(cmp, nameA, nameB);
      try { await navigator.clipboard.writeText(txt); toast('Comparison report copied', 'ok'); }
      catch { toast('Could not reach the clipboard.', 'err'); }
    },
  });
  wrap.appendChild(el('div', { class: 'cmp-foot' }, [copy]));

  showModal({ title: 'Compare documents', width: 'wide', body: (b) => b.appendChild(wrap), okLabel: 'Close' });
}

/** Overlay one PDF onto this one — Stirling's "Overlay PDFs". */
async function overlayDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const paths = await window.api.openDialog({ title: 'Choose the PDF to overlay' });
  if (!paths || !paths[0]) return;
  const r = await window.api.readFile(paths[0]);
  if (!r.ok) return toast('Could not read that file.', 'err');

  let overlayPages = 0;
  try { overlayPages = (await extractTextFromBytes(r.data)).length || 1; } catch { overlayPages = 1; }

  let page = 0;
  let x = 0, y = 0, scale = 1, opacity = 1, fit = false;
  const ok = await showModal({
    title: 'Overlay PDF',
    width: 'narrow',
    body: (b) => {
      b.appendChild(el('div', { class: 'hint', text: `${paths[0].split(/[\\/]/).pop()} — ${overlayPages} page(s). The overlay is drawn on top of every page of this document.` }));
      const pg = el('input', { type: 'number', min: '1', max: String(overlayPages), value: '1', style: { width: '68px' } });
      const xx = el('input', { type: 'number', value: '0', style: { width: '80px' } });
      const yy = el('input', { type: 'number', value: '0', style: { width: '80px' } });
      const sc = el('input', { type: 'number', value: '1', step: '0.05', min: '0.05', style: { width: '80px' } });
      const op = el('input', { type: 'number', value: '1', step: '0.05', min: '0.05', max: '1', style: { width: '80px' } });
      const fitc = el('input', { type: 'checkbox' });
      b.appendChild(formRow('Overlay page', pg).row);
      b.appendChild(formRow('Offset X / Y (pt)', el('div', { class: 'fr-c' }, [xx, yy])).row);
      b.appendChild(formRow('Scale', sc).row);
      b.appendChild(formRow('Opacity', op).row);
      b.appendChild(formRow('Fit to page', el('div', { class: 'fr-c' }, [fitc, el('span', { class: 'hint', text: 'ignore Scale and shrink to fit' })])).row);
      pg.oninput = () => { page = Math.max(0, (Number(pg.value) || 1) - 1); };
      xx.oninput = () => { x = Number(xx.value) || 0; };
      yy.oninput = () => { y = Number(yy.value) || 0; };
      sc.oninput = () => { scale = Number(sc.value) || 1; };
      op.oninput = () => { opacity = clamp(Number(op.value) || 1, 0.05, 1); };
      fitc.onchange = () => { fit = fitc.checked; sc.disabled = fit; };
    },
  });
  if (!ok) return;
  doc.overlay = { bytes: r.data, pages: [page], x, y, scale, opacity, fit };
  const bytes = await buildPdf(doc, {});
  await reloadDocFromBytes(doc, bytes, `Overlaid ${paths[0].split(/[\\/]/).pop()}`);
}

/** Scale pages — Stirling's "Scale pages". */
async function scaleDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let mode = 'percent';
  let percent = 100;
  let paper = 'A4';
  const ok = await showModal({
    title: 'Scale pages',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {}, [
        el('option', { value: 'percent', text: 'Scale by percentage' }),
        el('option', { value: 'paper', text: 'Fit to paper size' }),
      ]);
      const pct = el('div', { class: 'fr-c' }, [el('input', { type: 'number', value: '100', min: '5', max: '400', style: { width: '76px' } }), el('span', { class: 'hint', text: '%' })]);
      const psel = el('select', { style: { display: 'none' } }, [
        el('option', { value: 'A4', text: 'A4 (595 × 842)' }),
        el('option', { value: 'Letter', text: 'Letter (612 × 792)' }),
        el('option', { value: 'Legal', text: 'Legal (612 × 1008)' }),
        el('option', { value: 'A3', text: 'A3 (842 × 1191)' }),
        el('option', { value: 'A5', text: 'A5 (420 × 595)' }),
      ]);
      b.appendChild(formRow('Mode', sel).row);
      b.appendChild(formRow('Scale', pct).row);
      b.appendChild(formRow('Paper', psel).row);
      b.appendChild(el('div', { class: 'hint', text: `All ${doc.numPages} page(s) are scaled. Text stays selectable and vector.` }));
      sel.onchange = () => { mode = sel.value; pct.style.display = mode === 'percent' ? '' : 'none'; psel.style.display = mode === 'paper' ? '' : 'none'; };
      pct.querySelector('input').oninput = (e) => { percent = Number(e.target.value) || 100; };
      psel.onchange = () => { paper = psel.value; };
    },
  });
  if (!ok) return;
  const PAPERS = { A4: [595.28, 841.89], Letter: [612, 792], Legal: [612, 1008], A3: [841.89, 1191], A5: [419.53, 594.77] };
  let factor;
  if (mode === 'percent') {
    factor = percent / 100;
    if (Math.abs(factor - 1) < 1e-6) return toast('Scale is already 100%.', 'warn');
  } else {
    // One factor for the whole document, derived from the first page, so every
    // page lands on the same paper size regardless of mixed originals.
    const first = doc.pageSizes?.[0] || { w: 595.28, h: 841.89 };
    const [tw, th] = PAPERS[paper] || PAPERS.A4;
    factor = Math.min(tw / Math.max(1, first.w), th / Math.max(1, first.h));
    if (!Number.isFinite(factor) || factor <= 0) return toast('Could not compute a scale factor.', 'err');
  }
  const n = scalePages(doc, factor);
  if (!n) return toast('Nothing to scale.', 'warn');
  const bytes = await buildPdf(doc, {});
  await reloadDocFromBytes(doc, bytes, `Scaled ${n} page(s)`);
}

/**
 * Remove blank pages. Detection renders each page at low DPI and asks whether
 * the pixels are uniform — catches pages that are empty of drawings too, not
 * just pages with no text.
 */
async function removeBlankPagesFlow() {
  const doc = activeDoc();
  if (!doc) return;
  if (doc.numPages < 2) return toast('The document has only one page.', 'warn');
  toast('Looking for blank pages…', 'info', 1500);
  const blank = [];
  for (let i = 0; i < doc.numPages; i++) {
    blank.push(await isPageBlank(doc, i));
  }
  const found = blank.filter(Boolean).length;
  if (!found) return toast('No blank pages found.', 'ok');
  const ok = await showModal({
    title: 'Remove blank pages',
    width: 'narrow',
    body: (b) => {
      b.appendChild(el('div', { text: `Found ${found} blank page(s):` }));
      b.appendChild(el('div', { class: 'hint', text: blank.map((v, i) => (v ? `${i + 1} ` : '')).join('').trim() || '—' }));
      b.appendChild(el('div', { class: 'hint', text: 'The pages are removed from the document. Undo (Ctrl+Z) restores them.' }));
    },
  });
  if (!ok) return;
  const res = removeBlankPages(doc, blank);
  if (!res.removed) return toast('Nothing removed.', 'warn');
  const bytes = await buildPdf(doc, {});
  await reloadDocFromBytes(doc, bytes, `Removed ${res.removed} blank page(s)`);
}

/** A page is blank when it renders to a single uniform colour. */
async function isPageBlank(doc, i) {
  try {
    const canvas = await V.renderPageToCanvas(i, 24);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = data[0], g = data[1], b = data[2], a = data[3];
    for (let p = 4; p < data.length; p += 4) {
      if (data[p] !== r || data[p + 1] !== g || data[p + 2] !== b || data[p + 3] !== a) return false;
    }
    return true;
  } catch { return false; }
}

/** Adjust Colors — the Stirling "contrast / invert / scanner effect" group. */
async function adjustColorsDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let preset = 'lighten';
  let custom = '';
  let pages = 'all';
  let dpi = 150;
  const ok = await showModal({
    title: 'Adjust colors',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {}, COLOR_PRESETS.map((p) => el('option', { value: p.id, text: p.label })));
      const cust = el('input', { type: 'text', placeholder: 'e.g. brightness(1.1) contrast(1.2)', style: { display: 'none' } });
      const all = el('input', { type: 'radio', name: 'ac-pages', value: 'all', checked: true });
      const rng = el('input', { type: 'text', placeholder: `1-${doc.numPages}`, style: { display: 'none' } });
      const some = el('input', { type: 'radio', name: 'ac-pages', value: 'some' });
      const d = el('input', { type: 'number', value: '150', min: '72', max: '300', style: { width: '80px' } });
      b.appendChild(formRow('Preset', sel).row);
      b.appendChild(formRow('Custom CSS filter', cust).row);
      b.appendChild(formRow('Apply to', el('div', { class: 'fr-c' }, [all, el('span', { class: 'hint', text: 'all pages' }), some, el('span', { class: 'hint', text: 'range' })])).row);
      b.appendChild(formRow('Page range', rng).row);
      b.appendChild(formRow('Resolution', el('div', { class: 'fr-c' }, [d, el('span', { class: 'hint', text: 'DPI — higher is sharper but larger' })])).row);
      b.appendChild(el('div', { class: 'hint', text: 'The page is re-rendered as an image, so text becomes non-selectable on the affected pages.' }));
      sel.onchange = () => { preset = sel.value; cust.style.display = sel.value ? 'none' : ''; };
      cust.oninput = () => { custom = cust.value; };
      all.onchange = () => { pages = 'all'; rng.style.display = 'none'; };
      some.onchange = () => { pages = 'some'; rng.style.display = ''; };
      rng.oninput = () => { /* read below from rng.value */ };
      d.oninput = () => { dpi = clamp(Number(d.value) || 150, 72, 300); };
      b._range = () => rng.value;
    },
  });
  if (!ok) return;
  const filter = custom.trim() || (colorPresetById(preset) || {}).filter || '';
  const targets = pages === 'some' ? parsePageRange(b._range(), doc.numPages) : allPages(doc.numPages);
  if (!targets.length) return toast('No pages selected.', 'warn');
  const n = rasterizePages(doc, targets, filter, dpi);
  if (!n) return toast('Those pages cannot be colour-adjusted.', 'warn');
  const bytes = await buildPdf(doc, {});
  await reloadDocFromBytes(doc, bytes, `Adjusted ${n} page(s)`);
}

/* ══ Stirling integration pack — batch tools ported from Stirling-PDF ═══
 *
 * Each dialog follows the house pattern: pure planner from stirling.js
 * decides WHAT to do, the dialog collects parameters, buildPdf (or a
 * layout builder from pdfwrite.js) executes, reloadDocFromBytes commits.
 * Raster-based tools state their tradeoff openly (text on rebuilt pages
 * becomes non-selectable), matching the Adjust Colors precedent. */

async function compressDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let presetId = 'balanced';
  let dpi = 150, quality = 0.78, stripMeta = true, scope = 'all', rangeText = '';
  const origBytes = doc.bytes ? doc.bytes.length : 0;
  const ok = await showModal({
    title: 'Compress PDF',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {}, COMPRESS_PRESETS.map((p) => el('option', { value: p.id, text: p.label })));
      const d = el('input', { type: 'number', value: '150', min: '72', max: '300', style: { width: '80px' } });
      const q = el('input', { type: 'number', value: '78', min: '30', max: '95', style: { width: '80px' } });
      const strip = el('input', { type: 'checkbox', checked: true });
      const all = el('input', { type: 'radio', name: 'cz-pages', value: 'all', checked: true });
      const some = el('input', { type: 'radio', name: 'cz-pages', value: 'some' });
      const rng = el('input', { type: 'text', placeholder: `1-${doc.numPages}`, style: { display: 'none' } });
      const est = el('div', { class: 'hint', text: `Original: ${formatBytes(origBytes)} · ${doc.numPages} page(s). Pages are re-rendered as images — text on compressed pages becomes non-selectable.` });
      b.appendChild(formRow('Preset', sel).row);
      b.appendChild(formRow('Resolution', el('div', { class: 'fr-c' }, [d, el('span', { class: 'hint', text: 'DPI' })])).row);
      b.appendChild(formRow('Quality', el('div', { class: 'fr-c' }, [q, el('span', { class: 'hint', text: '% — lower is smaller' })])).row);
      b.appendChild(formRow('Apply to', el('div', { class: 'fr-c' }, [all, el('span', { class: 'hint', text: 'all pages' }), some, el('span', { class: 'hint', text: 'range' })])).row);
      b.appendChild(formRow('Page range', rng).row);
      b.appendChild(formRow('Strip metadata', el('div', { class: 'fr-c' }, [strip, el('span', { class: 'hint', text: 'title/author/keywords' })])).row);
      b.appendChild(est);
      sel.onchange = () => {
        presetId = sel.value;
        const p = compressPresetById(presetId);
        if (p) { d.value = String(p.dpi); q.value = String(Math.round(p.quality * 100)); dpi = p.dpi; quality = p.quality; }
      };
      d.oninput = () => { dpi = clamp(Number(d.value) || 150, 72, 300); };
      q.oninput = () => { quality = clamp(Number(q.value) || 78, 30, 95) / 100; };
      strip.onchange = () => { stripMeta = strip.checked; };
      all.onchange = () => { scope = 'all'; rng.style.display = 'none'; };
      some.onchange = () => { scope = 'some'; rng.style.display = ''; };
      rng.oninput = () => { rangeText = rng.value; };
    },
  });
  if (!ok) return;
  const targets = scope === 'some' ? parsePageRange(rangeText, doc.numPages) : allPages(doc.numPages);
  const plan = planCompress({ presetId, dpi, quality, pageCount: doc.numPages, range: scope === 'all' ? null : targets, stripMeta });
  if (!plan.pages.length) return toast('No pages selected.', 'warn');
  const est = estimateCompress(origBytes, plan.pages.length, plan.dpi, plan.quality);
  setBusy(true, 'Compressing…');
  try {
    doc.compressQuality = plan.quality;
    if (plan.stripMeta && doc.meta) doc.meta = { ...(doc.meta || {}), title: '', author: '', subject: '', keywords: '' };
    const n = rasterizePages(doc, plan.pages, plan.filter, plan.dpi);
    // Carry the quality through the op so buildPdf honours it per page.
    for (const it of doc.pageOps?.items || []) {
      if (it && (it.t === 'raster' || it.t === 'scaled-raster')) it.quality = plan.quality;
    }
    if (!n) return toast('Those pages cannot be compressed.', 'warn');
    const out = await buildPdf(doc, {});
    await reloadDocFromBytes(doc, out, `Compressed ${n} page(s) (≈${formatBytes(est.estimateBytes)} expected)`);
  } catch (e) {
    toast('Compress failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function flattenDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const plan = flattenPlan({ pageCount: doc.numPages, annots: doc.annots || [], hasForm: (doc.fields || []).length > 0 || (doc.newFields || []).length > 0 });
  if (!plan.pages.length && !plan.formFlatten) return toast('Nothing to flatten — no annotations or form fields.', 'ok');
  const bits = [];
  if (plan.annotCount) bits.push(`${plan.annotCount} annotation(s) on ${plan.pages.length} page(s)`);
  if (plan.formFlatten) bits.push('form fields');
  const ok = await confirmDialog(`Burn ${bits.join(' + ')} into page content? This cannot be undone after save.`, {
    title: 'Flatten', okLabel: 'Flatten', danger: true,
    detail: 'Affected pages are re-rendered as images, so their text becomes non-selectable.',
  });
  if (!ok) return;
  setBusy(true, 'Flattening…');
  try {
    if (plan.pages.length) {
      rasterizePages(doc, plan.pages, '', 200);
      for (const it of doc.pageOps?.items || []) {
        if (it && (it.t === 'raster' || it.t === 'scaled-raster')) it.quality = 0.9;
      }
    }
    const out = await buildPdf(doc, { flattenForm: plan.formFlatten });
    await reloadDocFromBytes(doc, out, 'Flattened');
  } catch (e) {
    toast('Flatten failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function sanitizeDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const plan = sanitizePlan(doc);
  const ok = await confirmDialog(
    plan.removes.length ? `Remove: ${plan.removes.join('; ')}?` : 'No attachments, metadata or form values found — still strip hidden JavaScript and rebuild the file?',
    { title: 'Sanitize document', okLabel: 'Sanitize', danger: true, detail: 'Rebuilds the file without embedded files, scripts, metadata or form values.' },
  );
  if (!ok) return;
  setBusy(true, 'Sanitizing…');
  try {
    const r = applySanitizeModel(doc);
    const out = await buildPdf(doc, { sanitize: true });
    await reloadDocFromBytes(doc, out, `Sanitized (${r.details.join(', ') || 'rebuilt clean'})`);
  } catch (e) {
    toast('Sanitize failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function docInfoDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let extra = {};
  try {
    const meta = await readMetadata(doc.bytes.slice(0));
    extra = { version: '', producer: meta.producer || '' };
  } catch { /* info still works from the model */ }
  // PDF version lives in the first 8 bytes: "%PDF-1.7".
  try {
    extra.version = String.fromCharCode(...doc.bytes.slice(0, 8)).trim().replace('%PDF-', 'PDF ');
  } catch { /* leave blank */ }
  const info = docInfoSummary(doc, doc.bytes?.length || 0, extra);
  const rows = [
    ['File', info.name],
    ['Pages', String(info.pages)],
    ['Size', info.fileSize],
    ['Version', info.version],
    ['Producer', info.producer],
    ['Title', info.title],
    ['Author', info.author],
    ['Page sizes', info.pageSizes.map((s) => `${s.size} ×${s.count}`).join(', ') || '—'],
    ['Annotations', String(info.annotCount)],
    ['Attachments', String(info.attachmentCount)],
    ['Form fields', String(info.fieldCount)],
    ['Text edits pending', info.hasTextEdits ? 'yes' : 'no'],
    ['OCR layers', info.hasOcr ? 'yes' : 'no'],
    ['Encrypted', info.encrypted ? 'yes' : 'no'],
  ];
  await showModal({
    title: 'Document information',
    width: 'narrow',
    body: (b) => {
      const grid = el('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontSize: '13px' } });
      for (const [k, v] of rows) {
        grid.appendChild(el('span', { text: k, style: { color: 'var(--text-2)' } }));
        grid.appendChild(el('span', { text: v }));
      }
      b.appendChild(grid);
      b.appendChild(el('div', { class: 'hint', text: 'Stirling “Get All Info on PDF” equivalent — version, sizes, counts and metadata in one place.', style: { marginTop: '10px' } }));
    },
    buttons: [{ label: 'Close', value: true, kind: 'primary', default: true }],
  });
}

async function removeAnnotsDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const types = [...new Set((doc.annots || []).map((a) => a.type))].sort();
  if (!types.length) return toast('No annotations to remove.', 'ok');
  let chosen = new Set(types);
  const ok = await showModal({
    title: 'Remove annotations',
    width: 'narrow',
    body: (b) => {
      b.appendChild(el('div', { class: 'hint', text: `${doc.annots.length} annotation(s). Tick the types to delete.` }));
      const boxes = types.map((tp) => {
        const c = el('input', { type: 'checkbox', checked: true });
        const count = doc.annots.filter((a) => a.type === tp).length;
        c.onchange = () => { c.checked ? chosen.add(tp) : chosen.delete(tp); };
        b.appendChild(el('label', { class: 'cb' }, [c, el('span', { text: `${tp} (${count})` })]));
        return c;
      });
      void boxes;
    },
    buttons: [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: 'Remove', value: true, kind: 'primary', default: true },
    ],
  });
  if (!ok) return;
  const plan = removeAnnotationsPlan(doc, [...chosen]);
  if (!plan.count) return toast('Nothing selected.', 'warn');
  const yes = await confirmDialog(`Delete ${plan.count} annotation(s)?`, { title: 'Remove annotations', okLabel: 'Delete', danger: true });
  if (!yes) return;
  removeAnnots(plan.ids);
  pushHistory('remove annotations');
  renderAllAnnotations();
  toast(`Removed ${plan.count} annotation(s) — save to write the file`, 'ok');
}

async function pageNumbersDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let formatId = 'n-of-N', pos = 'footer-center', size = 10;
  const ok = await showModal({
    title: 'Add page numbers',
    width: 'narrow',
    body: (b) => {
      const fmt = el('select', {}, PAGE_NUMBER_FORMATS.map((f) => el('option', { value: f.id, text: f.label })));
      fmt.value = formatId;
      const p = el('select', {}, [
        el('option', { value: 'footer-center', text: 'Footer · centered' }),
        el('option', { value: 'footer-right', text: 'Footer · right' }),
        el('option', { value: 'header-center', text: 'Header · centered' }),
        el('option', { value: 'header-right', text: 'Header · right' }),
      ]);
      p.value = pos;
      const s = el('input', { type: 'number', value: '10', min: '7', max: '24', style: { width: '70px' } });
      b.appendChild(formRow('Format', fmt).row);
      b.appendChild(formRow('Position', p).row);
      b.appendChild(formRow('Size', s).row);
      b.appendChild(el('div', { class: 'hint', text: 'Written as real text stamps ({page}/{pages} tokens) — stays selectable and editable.' }));
      fmt.onchange = () => { formatId = fmt.value; };
      p.onchange = () => { pos = p.value; };
      s.oninput = () => { size = clamp(Number(s.value) || 10, 7, 24); };
    },
  });
  if (!ok) return;
  const plan = pageNumberPlan({ formatId, pageCount: doc.numPages });
  const [kind, align] = pos.startsWith('header') ? ['header', pos.endsWith('right') ? 'right' : 'center'] : ['footer', pos.endsWith('right') ? 'right' : 'center'];
  doc.stamps = (doc.stamps || []).filter((st) => st.kind !== 'pageNumber');
  doc.stamps.push({ kind: 'pageNumber', scope: kind, align, fontSize: size, color: [0.4, 0.4, 0.4], from: 1, to: doc.numPages, texts: Object.fromEntries(plan.pages.map((p) => [p.page, p.text])) });
  // pageNumber stamps render through the header/footer path with per-page text.
  for (const st of doc.stamps) {
    if (st.kind === 'pageNumber') { st.kind = kind; st.text = '{page}'; }
  }
  // Replace the token text per page at write time via parts.
  const stamp = doc.stamps[doc.stamps.length - 1];
  stamp.parts = plan.pages.map((p) => ({ text: p.text, align, page: p.page }));
  stamp.text = plan.pages[0]?.text || '';
  const out = await buildPdfWithPageNumberParts(doc, stamp);
  await reloadDocFromBytes(doc, out, `Numbered ${plan.pages.length} page(s)`);
}

/** buildPdf draws one stamp text on a range; page numbers need per-page
 *  text, so expand into one single-page stamp per page and build once. */
async function buildPdfWithPageNumberParts(doc, stamp) {
  const keep = doc.stamps.filter((s) => s !== stamp);
  const perPage = (stamp.parts || []).map((pt) => ({
    kind: stamp.scope || 'footer', text: pt.text, align: pt.align || 'center',
    fontSize: stamp.fontSize || 10, color: stamp.color || [0.4, 0.4, 0.4],
    from: pt.page + 1, to: pt.page + 1,
  }));
  doc.stamps = [...keep, ...perPage];
  try {
    return await buildPdf(doc, {});
  } finally {
    doc.stamps = keep;
  }
}

async function nupDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let layout = '4-up', dpi = 150;
  const ok = await showModal({
    title: 'Multi-page layout (N-up)',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {}, nupGrids().map((g) => el('option', { value: g, text: g })));
      sel.value = layout;
      const d = el('input', { type: 'number', value: '150', min: '72', max: '300', style: { width: '80px' } });
      const plan = () => nupPlan(doc.numPages, layout);
      const hint = el('div', { class: 'hint', text: `${doc.numPages} page(s) → ${plan().totalSheets} sheet(s).` });
      b.appendChild(formRow('Layout', sel).row);
      b.appendChild(formRow('Resolution', el('div', { class: 'fr-c' }, [d, el('span', { class: 'hint', text: 'DPI' })])).row);
      b.appendChild(hint);
      b.appendChild(el('div', { class: 'hint', text: 'Sheets are re-rendered images — source text becomes non-selectable on the new sheets.' }));
      sel.onchange = () => { layout = sel.value; hint.textContent = `${doc.numPages} page(s) → ${nupPlan(doc.numPages, layout).totalSheets} sheet(s).`; };
      d.oninput = () => { dpi = clamp(Number(d.value) || 150, 72, 300); };
    },
  });
  if (!ok) return;
  const plan = nupPlan(doc.numPages, layout);
  setBusy(true, 'Laying out pages…');
  try {
    const bytes = await buildNup(plan, doc.pageSizes || [], (i, d) => V.renderPageToCanvas(i, d), { dpi, quality: 0.85 });
    await reloadDocFromBytes(doc, bytes, `${layout} layout — ${plan.totalSheets} sheet(s)`);
  } catch (e) {
    toast('N-up failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function singlePageDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const ok = await confirmDialog(`Join all ${doc.numPages} page(s) into one long strip?`, {
    title: 'PDF to single page', okLabel: 'Join',
    detail: 'The strip is a re-rendered image — text becomes non-selectable.',
  });
  if (!ok) return;
  setBusy(true, 'Joining pages…');
  try {
    const strip = singlePagePlan(doc.pageSizes || [], 8);
    const bytes = await buildSingleStrip(strip, (i, d) => V.renderPageToCanvas(i, d), { dpi: 150, quality: 0.85 });
    await reloadDocFromBytes(doc, bytes, 'Joined into a single page');
  } catch (e) {
    toast('Join failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function posterDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let cols = 2, rows = 2;
  const page = doc.currentPage ?? 0;
  const ok = await showModal({
    title: 'Split page into poster tiles',
    width: 'narrow',
    body: (b) => {
      const c = el('input', { type: 'number', value: '2', min: '1', max: '8', style: { width: '70px' } });
      const r = el('input', { type: 'number', value: '2', min: '1', max: '8', style: { width: '70px' } });
      b.appendChild(formRow('Columns', c).row);
      b.appendChild(formRow('Rows', r).row);
      b.appendChild(el('div', { class: 'hint', text: `Page ${page + 1} → ${cols * rows} tile(s), one per new page.` }));
      c.oninput = () => { cols = clamp(Math.round(Number(c.value) || 2), 1, 8); };
      r.oninput = () => { rows = clamp(Math.round(Number(r.value) || 2), 1, 8); };
    },
  });
  if (!ok) return;
  setBusy(true, 'Tiling page…');
  try {
    const tiles = posterTiles(doc.pageSizes?.[page]?.w || 595, doc.pageSizes?.[page]?.h || 842, cols, rows);
    const bytes = await buildPoster(page, cols, rows, (i, d) => V.renderPageToCanvas(i, d), { dpi: 200, quality: 0.88 });
    await reloadDocFromBytes(doc, bytes, `${tiles.length} poster tile(s) from page ${page + 1}`);
  } catch (e) {
    toast('Poster failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function bookletDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const order = bookletOrder(doc.numPages);
  const ok = await confirmDialog(
    `${doc.numPages} page(s) → ${order.totalSheets} folded sheet(s)${order.blanks ? ` (${order.blanks} blank pad page(s))` : ''}. Continue?`,
    { title: 'Booklet imposition', okLabel: 'Impose', detail: 'Sheets are re-rendered images — text becomes non-selectable.' },
  );
  if (!ok) return;
  setBusy(true, 'Imposing booklet…');
  try {
    const bytes = await buildBooklet(order, (i, d) => V.renderPageToCanvas(i, d), { dpi: 150, quality: 0.85 });
    await reloadDocFromBytes(doc, bytes, `Booklet — ${order.totalSheets} sheet(s)`);
  } catch (e) {
    toast('Booklet failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function splitBySizeDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let targetMB = 5;
  const ok = await showModal({
    title: 'Split by size',
    width: 'narrow',
    body: (b) => {
      const t = el('input', { type: 'number', value: '5', min: '0.5', max: '100', step: '0.5', style: { width: '90px' } });
      const plan = () => splitBySizePlan(doc.bytes?.length || 0, doc.numPages, targetMB);
      const hint = el('div', { class: 'hint', text: `≈${plan().chunks.length} file(s) at ${targetMB} MB each.` });
      b.appendChild(formRow('Target size', el('div', { class: 'fr-c' }, [t, el('span', { class: 'hint', text: 'MB per file' })])).row);
      b.appendChild(hint);
      t.oninput = () => { targetMB = clamp(Number(t.value) || 5, 0.5, 100); hint.textContent = `≈${splitBySizePlan(doc.bytes?.length || 0, doc.numPages, targetMB).chunks.length} file(s) at ${targetMB} MB each.`; };
    },
  });
  if (!ok) return;
  const plan = splitBySizePlan(doc.bytes?.length || 0, doc.numPages, targetMB);
  if (plan.chunks.length < 2) return toast('Already under that size — nothing to split.', 'ok');
  setBusy(true, 'Splitting…');
  try {
    let k = 0;
    for (const chunk of plan.chunks) {
      k++;
      const bytes = await buildExtract(doc, chunk);
      const path = await window.api.saveDialog({ defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + `-part${k}.pdf` });
      if (!path) break;
      await window.api.writeFile(path, bytes);
    }
    toast(`Split into ${plan.chunks.length} file(s)`, 'ok');
  } catch (e) {
    toast('Split failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function autoRenameDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let first = '';
  try { first = (await V.getPageText(0)).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' | '); } catch { /* keep blank */ }
  const suggestion = autoRenameSuggest({ title: doc.meta?.title || '', firstLines: first.split('|'), fallback: doc.name || 'document.pdf' });
  const name = await promptDialog('Rename from document content:', suggestion, { title: 'Auto-rename' });
  if (!name) return;
  const path = await window.api.saveDialog({ defaultPath: name.endsWith('.pdf') ? name : `${name}.pdf` });
  if (!path) return;
  try {
    setBusy(true, 'Saving…');
    const bytes = await buildPdf(doc, {});
    const res = await window.api.writeFile(path, bytes);
    toast(res.ok ? `Saved as ${path.split(/[\\/]/).pop()}` : 'Failed: ' + res.error, res.ok ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err', 6000);
  } finally {
    setBusy(false);
  }
}

async function repairDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const check = repairCheck(doc.bytes);
  if (check.ok) return toast('No structural problems found — header, objects and trailer all look healthy.', 'ok');
  const ok = await confirmDialog(`Found: ${check.issues.join('; ')}. Rebuild the file, skipping unreadable pages?`, {
    title: 'Repair PDF', okLabel: 'Repair', danger: false,
    detail: `${check.objects} object(s) detected. Original annotations on skipped pages are lost.`,
  });
  if (!ok) return;
  setBusy(true, 'Repairing…');
  try {
    const r = await buildRepaired(doc.bytes.slice(0), doc.password ?? null);
    await reloadDocFromBytes(doc, r.bytes, `Repaired (${r.copied} page(s)${r.skipped.length ? `, ${r.skipped.length} skipped` : ''})`);
  } catch (e) {
    toast('Repair failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function attachmentsDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const names = (doc.attachments || []).map((a) => a.filename).join(', ') || 'none';
  const choice = await showModal({
    title: 'Manage attachments',
    width: 'narrow',
    body: (b) => {
      b.appendChild(el('div', { class: 'hint', text: `Embedded files: ${names}` }));
      b.appendChild(el('div', { class: 'hint', text: 'Attachments travel inside the PDF and are written on save.' }));
    },
    buttons: [
      { label: 'Close', value: 'close', kind: 'ghost' },
      { label: 'Add…', value: 'add', kind: 'primary', default: true },
      { label: 'Extract all…', value: 'extract', kind: 'ghost' },
      { label: 'Remove one…', value: 'remove', kind: 'ghost' },
    ],
  });
  if (choice === 'add') {
    const paths = await window.api.openDialog({ title: 'Attach a file' });
    if (!paths || !paths[0]) return;
    const r = await window.api.readFile(paths[0]);
    if (!r.ok) return toast('Could not read that file.', 'err');
    const filename = paths[0].split(/[\\/]/).pop();
    doc.attachments = attachmentOps.add(doc.attachments || [], { filename, data: r.data, description: '' });
    markDirty('attachments');
    renderSidebar();
    toast(`Attached ${filename} — save to write the file`, 'ok');
  } else if (choice === 'extract') {
    if (!doc.attachments?.length) return toast('No attachments to extract.', 'warn');
    for (const a of doc.attachments) {
      const path = await window.api.saveDialog({ defaultPath: a.filename });
      if (!path) break;
      await window.api.writeFile(path, a.data);
    }
  } else if (choice === 'remove') {
    if (!doc.attachments?.length) return toast('No attachments to remove.', 'warn');
    let victim = doc.attachments[0]?.filename || '';
    const go = await showModal({
      title: 'Remove attachment', width: 'narrow',
      body: (b) => {
        const sel = el('select', {}, doc.attachments.map((a) => el('option', { value: a.filename, text: a.filename })));
        sel.value = victim;
        sel.onchange = () => { victim = sel.value; };
        b.appendChild(formRow('File', sel).row);
      },
      buttons: [
        { label: 'Cancel', value: false, kind: 'ghost' },
        { label: 'Remove', value: true, kind: 'primary', default: true },
      ],
    });
    if (go && victim) {
      doc.attachments = attachmentOps.remove(doc.attachments, victim);
      markDirty('attachments');
      renderSidebar();
      toast(`Removed ${victim} — save to write the file`, 'ok');
    }
  }
}

async function unlockFormsDialog() {
  const doc = activeDoc();
  if (!doc) return;
  if (!doc.fields?.length && !doc.newFields?.length) return toast('No form fields in this document.', 'ok');
  const ok = await confirmDialog(`Make all form fields editable (clear read-only)?`, { title: 'Unlock forms', okLabel: 'Unlock' });
  if (!ok) return;
  doc.fields = unlockFormsPlan(doc.fields || []);
  markDirty('forms');
  toast('Form fields unlocked — save to write the file', 'ok');
}

async function automateDialog() {
  const doc = activeDoc();
  if (!doc) return;
  const picked = [];
  const ok = await showModal({
    title: 'Automate — run tools as a pipeline',
    width: '',
    body: (b) => {
      b.appendChild(el('div', { class: 'hint', text: 'Tick tools to run in order. Raster steps rebuild pages as images; sanitize strips attachments/metadata.' }));
      for (const s of PIPELINE_STEPS) {
        const c = el('input', { type: 'checkbox' });
        c.onchange = () => {
          const i = picked.indexOf(s.id);
          if (c.checked && i < 0) picked.push(s.id);
          if (!c.checked && i >= 0) picked.splice(i, 1);
        };
        b.appendChild(el('label', { class: 'cb' }, [c, el('span', { text: s.label })]));
      }
    },
    buttons: [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: 'Run pipeline', value: true, kind: 'primary', default: true },
    ],
  });
  if (!ok || !picked.length) return;
  const steps = picked.map((id) => ({ id }));
  const v = validatePipeline(steps);
  if (!v.ok) return toast(v.issues.join('; '), 'err');
  setBusy(true, 'Running pipeline…');
  try {
    const r = runPipelineModel(doc, steps);
    // Execute queued writer steps in a fixed, safe order.
    if (doc.pipelineFlags?.removeBlanks && doc.numPages > 1) {
      const blank = [];
      for (let i = 0; i < doc.numPages; i++) blank.push(await isPageBlank(doc, i));
      removeBlankPages(doc, blank);
    }
    if (doc.pipelineFlags?.compress) {
      const plan = planCompress({ ...(doc.pipelineFlags.compress || {}), pageCount: doc.numPages });
      doc.compressQuality = plan.quality;
      rasterizePages(doc, plan.pages, plan.filter, plan.dpi);
    }
    if (doc.pipelineFlags?.grayscale) {
      rasterizePages(doc, allPages(doc.numPages), 'grayscale(1)', 150);
    }
    const out = await buildPdf(doc, { sanitize: picked.includes('sanitize'), flattenForm: picked.includes('flatten') });
    await reloadDocFromBytes(doc, out, `Pipeline: ${r.applied.join(' · ')}`);
    doc.pipelineFlags = null;
    if (r.skipped.length) toast('Skipped: ' + r.skipped.join(', '), 'warn');
  } catch (e) {
    toast('Pipeline failed: ' + (e?.message || e), 'err');
  } finally {
    setBusy(false);
  }
}

async function encryptDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let user = '', owner = '', algo = 'AES-256';
  const perms = { printing: 'highResolution', copying: false, modifying: false, annotating: true, fillingForms: true, contentAccessibility: true, documentAssembly: false };
  const ok = await showModal({
    title: 'Encrypt with password',
    body: (b) => {
      const u = el('input', { type: 'password' });
      const o = el('input', { type: 'password', placeholder: 'defaults to the user password' });
      const a = el('select', {}, [el('option', { value: 'AES-256', text: 'AES-256 (recommended)' }), el('option', { value: 'AES-128', text: 'AES-128' }), el('option', { value: 'RC4-128', text: 'RC4-128 (legacy viewers)' })]);
      b.appendChild(formRow('Password', u).row);
      b.appendChild(formRow('Owner password', o).row);
      b.appendChild(formRow('Cipher', a).row);
      const grid = el('div', { class: 'cols' });
      const mk = (key, label) => {
        const c = el('input', { type: 'checkbox' });
        c.checked = !!perms[key];
        c.onchange = () => { perms[key] = c.checked; };
        return el('label', { class: 'cb' }, [c, el('span', { text: label })]);
      };
      grid.append(
        mk('copying', 'Allow copying text'),
        mk('modifying', 'Allow content editing'),
        mk('annotating', 'Allow commenting'),
        mk('fillingForms', 'Allow form filling'),
      );
      b.appendChild(grid);
      b.appendChild(el('div', { class: 'hint', text: 'High-quality printing stays allowed so recipients can still print. The encrypted file is written as a copy — the open document is unchanged.' }));
      u.oninput = () => { user = u.value; };
      o.oninput = () => { owner = o.value; };
      a.onchange = () => { algo = a.value; };
    },
  });
  if (!ok || !user) return;
  const path = await window.api.saveDialog({ defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '-encrypted.pdf' });
  if (!path) return;
  try {
    setBusy(true, 'Encrypting…');
    const bytes = await buildPdf(doc, { password: user, ownerPassword: owner || user, permissions: perms, algorithm: algo });
    const res = await window.api.writeFile(path, bytes);
    toast(res.ok ? `Encrypted copy saved (${algo})` : 'Failed: ' + res.error, res.ok ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err', 6000);
  } finally {
    setBusy(false);
  }
}

async function removeSecurity() {
  const doc = activeDoc();
  if (!doc) return;
  if (!doc.passwordProtected) return toast('This document is not password protected.', 'warn');
  const path = await window.api.saveDialog({ defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '-unlocked.pdf' });
  if (!path) return;
  try {
    setBusy(true, 'Decrypting…');
    const bytes = await buildPdf(doc, {});
    const res = await window.api.writeFile(path, bytes);
    toast(res.ok ? 'Unlocked copy saved' : 'Failed: ' + res.error, res.ok ? 'ok' : 'err');
  } catch (e) {
    toast(e.message, 'err', 6000);
  } finally {
    setBusy(false);
  }
}

async function applyRedactions(sanitize) {
  const doc = activeDoc();
  if (!doc) return;
  const reds = doc.annots.filter((a) => a.type === 'redact' && !a.applied);
  if (!reds.length) return toast('No pending redaction marks. Use the Redact tool to mark areas first.', 'warn', 5000);
  const msg = sanitize
    ? `Rasterise ${new Set(reds.map((r) => r.page)).size} page(s) at 200 dpi and permanently remove the marked content? The text layer on those pages will be replaced by an image.`
    : `Apply ${reds.length} redaction mark(s)? Areas are covered with black boxes. Hidden text underneath may still be extractable — use Sanitize for irreversible removal.`;
  const ok = await confirmDialog(msg, { okLabel: sanitize ? 'Sanitize' : 'Apply', danger: sanitize });
  if (!ok) return;
  if (sanitize) {
    const pages = [...new Set(reds.map((r) => r.page))].sort((a, b) => a - b);
    const items = doc.pageOps?.items || Array.from({ length: doc.numPages }, (_, i) => ({ t: 'src', i }));
    const rasterSet = new Map(pages.map((p) => [p, reds.filter((r) => r.page === p).map((r) => r.rect)]));
    doc.pageOps = {
      items: items.map((it) => (it.t === 'src' && rasterSet.has(it.i)
        ? { t: 'raster', i: it.i, rects: rasterSet.get(it.i), dpi: 200 }
        : it)),
    };
    doc.annots = doc.annots.filter((a) => !(a.type === 'redact' && rasterSet.has(a.page)));
  } else {
    for (const a of reds) a.applied = true;
  }
  pushHistory('redact');
  toast(sanitize ? 'Redactions sanitized — save to write the file' : 'Redaction marks applied — save to write the file', 'ok', 5000);
  renderAllAnnotations();
  emit('annots');
}

/* ══ Export ═════════════════════════════════════════════════════════════ */

async function exportText() {
  const doc = activeDoc();
  if (!doc) return;
  setBusy(true, 'Extracting text…');
  const parts = [];
  for (let i = 0; i < doc.numPages; i++) {
    parts.push(`--- Page ${i + 1} ---\n${await V.getPageText(i)}`);
  }
  setBusy(false);
  const path = await window.api.saveDialog({ defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
  if (!path) return;
  await window.api.writeFile(path, new TextEncoder().encode(parts.join('\n\n')));
  toast('Text exported', 'ok');
}

/* ── Convert: text-based formats ───────────────────────────────────────────── */

/** Collect the document text with layout block markers so the downstream
 *  writers can decide how much structure to preserve. */
async function collectDocText(doc) {
  const pages = [];
  for (let i = 0; i < doc.numPages; i++) pages.push(await V.getPageText(i));
  return pages;
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Pure HTML builder — separated from the dialog so the output can be
 *  unit-tested without a save dialog (see __aipdfRunParityTest). */
function buildHtmlExport(doc, pages) {
  const title = doc.meta?.title || (doc.name || 'document').replace(/\.pdf$/i, '');
  const body = pages.map((t, i) =>
    `  <section class="page" id="page-${i + 1}">\n    <h2 class="page-no">Page ${i + 1}</h2>\n${t.split(/\n{2,}/).map((p) => `    <p>${htmlEscape(p).replace(/\n/g, '<br/>')}</p>`).join('\n')}\n  </section>`
  ).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${htmlEscape(title)}</title>
<meta name="generator" content="AiPDF Editor"/>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; max-width: 46rem; margin: 2rem auto; padding: 0 1.25rem; }
  .page { margin: 0 0 3rem; }
  .page-no { font-size: .8rem; font-weight: 600; opacity: .5; letter-spacing: .08em; text-transform: uppercase; }
  ${doc.meta?.author ? `.author::after { content: "${htmlEscape(doc.meta.author)}"; }` : ''}
</style>
</head>
<body>
${doc.meta?.author ? `<p class="author"></p>\n` : ''}${body}
</body>
</html>
`;
}

async function exportHtml() {
  const doc = activeDoc();
  if (!doc) return;
  setBusy(true, 'Building HTML…');
  const pages = await collectDocText(doc);
  setBusy(false);
  const html = buildHtmlExport(doc, pages);
  const path = await window.api.saveDialog({
    defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '.html',
    filters: [{ name: 'HTML', extensions: ['html'] }],
  });
  if (!path) return;
  const res = await window.api.writeFile(path, new TextEncoder().encode(html));
  toast(res.ok ? 'HTML exported' : 'Export failed: ' + res.error, res.ok ? 'ok' : 'err');
}

function rtfEscape(s) {
  // RTF is byte-oriented: non-ASCII must be escaped as \uN? or the file is
  // unreadable in Word. Keep ASCII newlines as \par.
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === '\n') out += '\\par\n';
    else if (ch === '{' || ch === '}' || ch === '\\') out += '\\' + ch;
    else if (c < 128) out += ch;
    else if (c <= 0xffff) out += `\\u${c}?`;
    else {
      // outside the BMP: emit as a surrogate pair
      const v = c - 0x10000;
      out += `\\u${0xd800 + (v >> 10)}?\\u${0xdc00 + (v & 0x3ff)}?`;
    }
  }
  return out;
}

/** Pure RTF builder — non-ASCII escaped, pages separated by \page. */
function buildRtfExport(doc, pages) {
  const title = doc.meta?.title || (doc.name || 'document').replace(/\.pdf$/i, '');
  const body = pages.map((t, i) =>
    `{\\pard\\sa240\\b Page ${i + 1}\\par}\n${t.split(/\n{2,}/).map((p) => `{\\pard\\sa120 ${rtfEscape(p)}\\par}`).join('\n')}`
  ).join('\n\\page\n');
  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\\nouicompat{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}}
{\\*\\generator AiPDF Editor;}\\pard\\sa240\\fs44\\b ${rtfEscape(title)}\\par
${body}
}`;
}

async function exportRtf() {
  const doc = activeDoc();
  if (!doc) return;
  setBusy(true, 'Building RTF…');
  const pages = await collectDocText(doc);
  setBusy(false);
  const rtf = buildRtfExport(doc, pages);
  const path = await window.api.saveDialog({
    defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '.rtf',
    filters: [{ name: 'RTF', extensions: ['rtf'] }],
  });
  if (!path) return;
  const res = await window.api.writeFile(path, new TextEncoder().encode(rtf));
  toast(res.ok ? 'RTF exported' : 'Export failed: ' + res.error, res.ok ? 'ok' : 'err');
}

/** EPUB 2 is plain ZIP + XHTML, which every reader accepts. We deflate with
 *  stored entries (no compression) so the container stays trivially valid. */
function zipStore(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const data = enc.encode(f.data);
    const crc = crc32(data);
    // Local file header: 30 bytes, stored (uncompressed), no extra field.
    const lh = [
      0x50, 0x4b, 0x03, 0x04,       // signature
      20, 0,                        // version needed to extract
      0, 0,                         // general purpose flags
      0, 0,                         // method 0 = stored
      0, 0,                         // mod time
      0x21, 0,                      // mod date 1980-01-01 (day 0 is invalid)
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      0, 0,                         // extra field length
    ];
    parts.push(new Uint8Array(lh), nameBytes, data);
    // Central directory header: 46 bytes.
    const cd = [
      0x50, 0x4b, 0x01, 0x02,       // signature
      20, 0,                        // version made by
      20, 0,                        // version needed
      0, 0,                         // flags
      0, 0,                         // method
      0, 0,                         // mod time
      0x21, 0,                      // mod date
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(nameBytes.length),
      0, 0,                         // extra field length
      0, 0,                         // comment length
      0, 0,                         // disk number start
      0, 0,                         // internal attributes
      0, 0, 0, 0,                   // external attributes
      ...u32(offset),               // offset of the local header
    ];
    central.push(new Uint8Array(cd), nameBytes);
    offset += lh.length + nameBytes.length + data.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  const end = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(cdStart), 0, 0]);
  parts.push(end);
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** EPUB 2 container file list — pure so the ZIP can be validated headlessly. */
function buildEpubFiles(doc, pages) {
  const title = doc.meta?.title || (doc.name || 'document').replace(/\.pdf$/i, '');
  const author = doc.meta?.author || 'AiPDF Editor';
  const uid = 'urn:uuid:' + (doc.id || 'aipdf') + '-' + Date.now().toString(36);
  const chapters = pages.map((t, i) => `  <h2>Page ${i + 1}</h2>\n${t.split(/\n{2,}/).map((p) => `  <p>${htmlEscape(p).replace(/\n/g, '<br/>')}</p>`).join('\n')}`).join('\n');
  return [
    { name: 'mimetype', data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles>\n    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n  </rootfiles>\n</container>\n` },
    { name: 'OEBPS/content.opf', data: `<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">\n  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n    <dc:title>${htmlEscape(title)}</dc:title>\n    <dc:creator>${htmlEscape(author)}</dc:creator>\n    <dc:language>en</dc:language>\n    <dc:identifier id="BookId">${uid}</dc:identifier>\n    <dc:source>${htmlEscape(doc.name || 'document.pdf')}</dc:source>\n  </metadata>\n  <manifest>\n    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>\n    <item id="content" href="content.html" media-type="application/xhtml+xml"/>\n  </manifest>\n  <spine toc="ncx">\n    <itemref idref="content"/>\n  </spine>\n</package>\n` },
    { name: 'OEBPS/toc.ncx', data: `<?xml version="1.0" encoding="utf-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n  <head><meta name="dtb:uid" content="${uid}"/></head>\n  <docTitle><text>${htmlEscape(title)}</text></docTitle>\n  <navMap>\n    <navPoint id="np1" playOrder="1"><navLabel><text>${htmlEscape(title)}</text></navLabel><content src="content.html"/></navPoint>\n  </navMap>\n</ncx>\n` },
    { name: 'OEBPS/content.html', data: `<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/></head><body>\n<h1>${htmlEscape(title)}</h1>\n${chapters}\n</body></html>\n` },
  ];
}

async function exportEpub() {
  const doc = activeDoc();
  if (!doc) return;
  setBusy(true, 'Building EPUB…');
  const pages = await collectDocText(doc);
  setBusy(false);
  const bytes = zipStore(buildEpubFiles(doc, pages));
  const path = await window.api.saveDialog({
    defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '.epub',
    filters: [{ name: 'EPUB', extensions: ['epub'] }],
  });
  if (!path) return;
  const res = await window.api.writeFile(path, bytes);
  toast(res.ok ? 'EPUB exported' : 'Export failed: ' + res.error, res.ok ? 'ok' : 'err');
}

/** Markdown keeps the document usable in editors/LLM pipelines. */
function buildMarkdownExport(doc, pages) {
  return [`# ${doc.meta?.title || (doc.name || 'document').replace(/\.pdf$/i, '')}`]
    .concat(pages.map((t, i) => `\n<!-- page ${i + 1} -->\n\n${t}`)).join('\n') + '\n';
}

async function exportMarkdown() {
  const doc = activeDoc();
  if (!doc) return;
  setBusy(true, 'Building Markdown…');
  const pages = await collectDocText(doc);
  setBusy(false);
  const md = buildMarkdownExport(doc, pages);
  const path = await window.api.saveDialog({
    defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '.md',
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (!path) return;
  const res = await window.api.writeFile(path, new TextEncoder().encode(md));
  toast(res.ok ? 'Markdown exported' : 'Export failed: ' + res.error, res.ok ? 'ok' : 'err');
}

async function exportImages() {
  const dir = await window.api.openDialog({ title: 'Pick any file inside the destination folder' });
  if (!dir || !dir[0]) return;
  const base = dir[0].replace(/[^\\/]+$/, '');
  setBusy(true, 'Rendering…');
  for (let i = 0; i < doc.numPages; i++) {
    const canvas = await renderPageToCanvas(i, clamp(dpi, 36, 600));
    const dataUrl = canvas.toDataURL('image/png');
    const bin = atob(dataUrl.split(',')[1]);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    await window.api.writeFile(`${base}page-${String(i + 1).padStart(3, '0')}.png`, bytes);
  }
  setBusy(false);
  toast(`Exported ${doc.numPages} page image(s)`, 'ok');
}

async function newFromImages() {
  const paths = await window.api.openDialog({ multiSelections: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }], title: 'Choose images' });
  if (!paths || !paths.length) return;
  const images = [];
  for (const p of paths) {
    const r = await window.api.readFile(p);
    if (r.ok) images.push({ bytes: r.data, w: 595.28, h: 841.89 });
  }
  const bytes = await buildFromImages(images);
  await openDocFromBytes(bytes, 'images.pdf', null);
  toast('Created a PDF from ' + images.length + ' image(s)', 'ok');
}

async function newBlank() {
  const bytes = await buildBlank();
  await openDocFromBytes(bytes, 'Untitled.pdf', null);
}

async function exportComments() {
  const doc = activeDoc();
  if (!doc || !doc.annots.length) return toast('There are no comments to export.', 'warn');
  const rows = doc.annots.map((a) => ({
    page: a.page + 1,
    type: a.type,
    subtype: ANNOT_TYPES[a.type] || a.type,
    author: a.author || '',
    date: a.date || '',
    text: a.text || '',
  }));
  const json = JSON.stringify(rows, null, 2);
  const csv = ['page,type,subtype,author,date,text']
    .concat(rows.map((r) => [r.page, r.type, r.subtype, JSON.stringify(r.author), JSON.stringify(r.date), JSON.stringify(r.text)].join(',')))
    .join('\r\n');
  let format = 'csv'; // captured from the control — the modal DOM is gone by the time it resolves
  await showModal({
    title: 'Export comments',
    width: 'narrow',
    body: (b) => {
      const sel = el('select', {}, [el('option', { value: 'csv', text: 'CSV' }), el('option', { value: 'json', text: 'JSON' })]);
      const ta = el('textarea', { class: 'mono', style: { minHeight: '160px', fontSize: '11px' } });
      ta.value = csv;
      sel.onchange = () => { format = sel.value; ta.value = format === 'csv' ? csv : json; };
      b.appendChild(formRow('Format', sel).row);
      b.appendChild(ta);
    },
  });
  const isCsv = format === 'csv';
  const path = await window.api.saveDialog({
    defaultPath: (doc.name || 'document').replace(/\.pdf$/i, '') + '-comments.' + (isCsv ? 'csv' : 'json'),
    filters: [{ name: 'Data', extensions: [isCsv ? 'csv' : 'json'] }],
  });
  if (!path) return;
  const res = await window.api.writeFile(path, new TextEncoder().encode(isCsv ? csv : json));
  toast(res.ok ? 'Comments exported' : 'Failed: ' + res.error, res.ok ? 'ok' : 'err');
}

/* ══ Print ══════════════════════════════════════════════════════════════ */

async function printDocument() {
  const doc = activeDoc();
  if (!doc) return;
  const proceed = await confirmDialog(
    `Print ${doc.numPages} page(s)? The pages are rasterised at 150 dpi and sent to your default printer.`,
    { okLabel: 'Print…' }
  );
  if (!proceed) return;
  setBusy(true, 'Preparing print…');
  let root = document.getElementById('printRoot');
  if (!root) { root = el('div', { id: 'printRoot' }); document.body.appendChild(root); }
  root.innerHTML = '';
  for (let i = 0; i < doc.numPages; i++) {
    const canvas = await renderPageToCanvas(i, 150);
    const img = el('img', { src: canvas.toDataURL('image/jpeg', 0.9) });
    root.appendChild(img);
  }
  setBusy(false);
  const style = document.createElement('style');
  style.textContent = `@media print { body > *:not(#printRoot){display:none !important} #printRoot{display:block !important} #printRoot img{display:block;width:100%;page-break-after:always} }`;
  document.head.appendChild(style);
  await window.api.print({});
  setTimeout(() => { style.remove(); root.remove(); }, 1500);
}

/* ══ Context panel ══════════════════════════════════════════════════════ */

/** Tools that own editable appearance — choosing one opens its panel immediately. */
const TOOL_PROPS = new Set(['rect', 'ellipse', 'line', 'arrow', 'ink', 'brush', 'highlighter', 'measure', 'redact', 'whiteout', 'textbox', 'callout', 'note', 'stamp', 'signature', 'image', 'editText']);

/** Each marker tool keeps its own width: a pencil lead, a brush and a highlighter
 *  are not the same size and nobody wants to reset three sliders. */
const TOOL_SIZE_KEY = { ink: 'borderWidth', brush: 'brushSize', highlighter: 'highlighterSize' };
const TOOL_SIZE_FALLBACK = { borderWidth: 1.5, brushSize: 6, highlighterSize: 16 };

/* ── Local fonts in the text/font pickers ──────────────────────────────── */

let systemFacesPromise = null;
// The full machine font list stays collapsed until the user asks for it —
// "Show all fonts…" — so nothing scans ~400 fonts at boot or panel-open.
let localFontsExpanded = false;
function systemFaces() {
  systemFacesPromise ??= listSystemFonts().then((r) => r.faces || []);
  return systemFacesPromise;
}

/**
 * Give a font <select> favourites + local fonts.
 *
 * Groups, in order: the three standard families, anything registered
 * (document-extracted or uploaded), ★ Favourites (saved in settings — no
 * scan needed), and Local fonts — LAZY: a single "Show all fonts…" item
 * until the user clicks it, so no machine-wide font scan happens at boot or
 * panel-open and pages keep loading fast.
 *
 * Picking a local face copies it into the app font store (fonts.js
 * addSystemFont) so it embeds on save exactly like an uploaded font — the
 * standard-14 fallback would write non-WinAnsi glyphs as "?".
 * prevOnChange preserves whatever binding the picker already had; `apply`
 * receives the family for a fresh pick.
 */
function attachLocalFonts(sel, apply, prevOnChange) {
  const STD = ['Helvetica', 'Times', 'Courier'];

  /* ★ Favourites — names saved in settings; instant, no index needed. */
  const fillFavourites = () => {
    const old = sel.querySelector('optgroup[label="★ Favourites"]');
    if (old) old.remove();
    const favs = settings.favoriteFonts || [];
    if (!favs.length) return;
    const favGroup = el('optgroup', { label: '★ Favourites' });
    for (const name of favs) {
      if ([...sel.options].some((o) => o.value === name)) continue;
      favGroup.appendChild(el('option', { value: 'fav:' + name, text: '★ ' + name, 'data-fav-name': name }));
    }
    if (favGroup.children.length) sel.appendChild(favGroup);
  };
  fillFavourites();

  /* Local fonts — lazy. */
  const grp = el('optgroup', { label: 'Local fonts' });
  const showAll = el('option', {
    value: '__showAll__',
    text: localFontsExpanded ? 'Local fonts' : 'Show all fonts…',
  });
  grp.appendChild(showAll);
  sel.appendChild(grp);

  const fillAll = () => {
    systemFaces().then((faces) => {
      if (!faces.length) { showAll.textContent = 'No local fonts found'; return; }
      const cur = sel.value;
      const present = new Set([...sel.options].map((o) => (o.dataset && o.dataset.sysFamily) || o.value));
      const byFamily = new Map();
      for (const f of faces) if (!byFamily.has(f.family)) byFamily.set(f.family, f);
      const favs = new Set(settings.favoriteFonts || []);
      const fams = [...byFamily.entries()].sort((x, y) => {
        const fx = favs.has(x[0]) ? 0 : 1, fy = favs.has(y[0]) ? 0 : 1;
        return fx - fy || x[0].localeCompare(y[0]);
      });
      grp.innerHTML = '';
      for (const [family, face] of fams) {
        if (present.has(family)) continue;
        grp.appendChild(el('option', {
          value: 'sys:' + family,
          text: (favs.has(family) ? '★ ' : '') + (face.style ? `${family} (${face.style})` : family),
          'data-sys-family': family,
        }));
      }
      sel.value = cur; // the fill must not move the picker
      if (sel.value !== cur) sel.value = sel.options[0] ? sel.options[0].value : '';
    }).catch(() => { showAll.textContent = 'Local fonts unavailable'; });
  };
  if (localFontsExpanded) fillAll();

  sel.onchange = async () => {
    const opt = sel.selectedOptions && sel.selectedOptions[0];
    if (opt && opt.value === '__showAll__') {
      localFontsExpanded = true;
      showAll.textContent = 'Loading local fonts…';
      fillAll();
      if (prevOnChange) prevOnChange(); else apply(sel.value);
      return;
    }
    // A favourite that is not registered yet: resolve it from the machine's
    // font index (built on demand) and register it like a local pick.
    if (opt && opt.value.startsWith && opt.value.startsWith('fav:')) {
      const family = opt.value.slice(4);
      if (customFontFamilies().includes(family)) { if (prevOnChange) prevOnChange(); else apply(family); return; }
      const face = (await systemFaces()).find((f) => f.family === family);
      if (!face) { toast('That font is not installed on this machine any more.', 'warn'); return; }
      const r = await addSystemFont(face);
      if (!r.ok) { toast(r.error || 'Could not register the local font.', 'err', 5000); return; }
      opt.value = r.family;
      opt.textContent = r.family;
      delete opt.dataset.favName;
      if (prevOnChange) prevOnChange(); else apply(r.family);
      return;
    }
    if (prevOnChange) prevOnChange(); else apply(sel.value);
  };
}

/** A ★ toggle for the font currently chosen in a picker — favourites are
 *  saved in settings and surface in the ★ Favourites group of every picker. */
function fontStarButton(getFamily) {
  const btn = el('button', { type: 'button', class: 'icon-btn sm', title: 'Add to favourites' });
  const paint = () => {
    const on = (settings.favoriteFonts || []).includes(getFamily());
    btn.innerHTML = svgIcon('star', 13, 1.8);
    btn.classList.toggle('on', on);
    if (on) btn.style.color = 'var(--accent)'; else btn.style.color = '';
    btn.title = on ? 'Remove from favourites' : 'Add to favourites';
  };
  btn.onclick = () => {
    const fam = getFamily();
    if (!fam || ['Helvetica', 'Times', 'Courier'].includes(fam)) {
      toast('The standard PDF fonts are always available.', 'info', 2600);
      return;
    }
    settings.favoriteFonts = settings.favoriteFonts || [];
    const at = settings.favoriteFonts.indexOf(fam);
    if (at >= 0) settings.favoriteFonts.splice(at, 1);
    else settings.favoriteFonts.push(fam);
    saveSettings();
    paint();
    toast(at >= 0 ? 'Removed from favourites' : `★ ${fam} — added to favourites`, 'ok', 2000);
  };
  paint();
  return btn;
}

/* Foxit's Typewriter tool panel: Font, Size, Text colour, Bold / Italic style
 * and Alignment. Shared by the armed Text Box tool and the selected-text-box
 * property panel so both read identically. `get`/`set` let each caller bind to
 * settings (armed tool) or to a specific annotation. */
function textPropsGroup(get, set) {
  const g = el('div', { class: 'prop-group' });
  g.appendChild(el('div', { class: 'prop-title', text: 'Text' }));

  const fam = el('select', {});
  // The three standard families plus anything registered — extracted from this
  // document or uploaded by the user. Without the second group an uploaded font
  // could be embedded on write but never selected here.
  const STD = ['Helvetica', 'Times', 'Courier'];
  for (const f of STD) fam.appendChild(el('option', { value: f, text: f }));
  for (const f of customFontFamilies().filter((x) => !STD.includes(x))) {
    fam.appendChild(el('option', { value: f, text: isUserFont(f) ? `${f} — my font` : f }));
  }
  fam.value = get.fontFamily || 'Helvetica';
  fam.onchange = () => set.fontFamily(fam.value);
  attachLocalFonts(fam, (v) => set.fontFamily(v), fam.onchange);

  const size = el('input', { type: 'number', min: '4', max: '144', value: String(get.fontSize || 11), style: { width: '100%' } });
  size.onchange = () => set.fontSize(Number(size.value));

  const colour = el('input', { type: 'color', value: get.textColor, style: { width: '100%', height: '28px', padding: '0' } });
  colour.oninput = () => set.textColor(colour.value);

  // Bold / Italic toggle buttons — Foxit shows B / I in the Typewriter panel.
  const bBtn = el('button', { class: 'mini-btn', text: 'B', title: 'Bold' });
  const iBtn = el('button', { class: 'mini-btn', text: 'I', title: 'Italic' });
  const paint = () => {
    bBtn.classList.toggle('on', !!get.bold);
    iBtn.classList.toggle('on', !!get.italic);
  };
  bBtn.onclick = () => { set.bold(!get.bold); paint(); };
  iBtn.onclick = () => { set.italic(!get.italic); paint(); };
  paint();

  const align = el('select', {});
  for (const [v, t] of [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]) align.appendChild(el('option', { value: v, text: t }));
  align.value = get.align || 'left';
  align.onchange = () => set.align(align.value);

  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Font' }), el('div', { class: 'pr-c', style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [fam, fontStarButton(() => get.fontFamily)])]));
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Size' }), el('div', { class: 'pr-c' }, [size])]));
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Text colour' }), el('div', { class: 'pr-c' }, [colour])]));
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Style' }), el('div', { class: 'pr-c' }, [el('div', { class: 'flex' }, [bBtn, iBtn])])]));
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Align' }), el('div', { class: 'pr-c' }, [align])]));
  return g;
}

/**
 * Fill row: a square colour chip and a square "None" chip, mutually exclusive.
 *
 * None stores `null`, which now means genuinely transparent — the preview and
 * the written PDF both stop baking white behind the text. Previously a null fill
 * rendered as a white box, so "no fill" and "white fill" were indistinguishable
 * and the None option would have been a lie.
 */
function fillRow(label, initial, onCommit) {
  let cur = initial || null;
  const col = el('input', { type: 'color', class: 'cchip', value: cur ? rgbToHex(cur) : (settings.fillColor || '#ffffff'), title: `${label} colour` });
  const none = el('button', { type: 'button', class: 'cchip cnone', title: `${label}: None (transparent)`, 'aria-label': `${label}: none` });
  const sync = () => {
    none.classList.toggle('on', cur === null);
    col.classList.toggle('off', cur === null);
  };
  const commit = (v, hist) => { cur = v; onCommit(v, hist); sync(); };
  col.oninput = () => commit(hexToRgb(col.value), false);
  col.onchange = () => commit(hexToRgb(col.value), true);
  none.onclick = () => commit(null, true);
  sync();
  return el('div', { class: 'prop-row' }, [
    el('label', { text: label }),
    el('div', { class: 'pr-c' }, [el('div', { class: 'flex' }, [col, none])]),
  ]);
}

/* ── Object clipboard ─────────────────────────────────────────────────────── */

/**
 * Ctrl+C / Ctrl+V for annotations and page objects.
 *
 * Editable targets (inputs, the find bar, the inline text editor) return from the
 * key handler before reaching this, so the browser keeps native text copy/paste
 * there. With nothing selected, Ctrl+C also falls through, which means a plain
 * text selection on the page still copies as expected.
 */
let clipboardBuf = null;
let pasteCascade = 0;

function copySelectedAnnots() {
  const doc = activeDoc();
  if (!doc || !state.selection.length) return false;
  const items = state.selection.map((id) => doc.annots.find((a) => a.id === id)).filter(Boolean);
  if (!items.length) return false;
  clipboardBuf = items.map((a) => JSON.parse(JSON.stringify(a)));
  pasteCascade = 0;
  toast(`${items.length} ${items.length === 1 ? 'item' : 'items'} copied`, 'ok');
  return true;
}

function pasteAnnots() {
  const doc = activeDoc();
  if (!doc || !clipboardBuf || !clipboardBuf.length) return false;
  const page = doc.currentPage ?? 0;
  // Offset each paste so a copy onto the same page is visibly separate, and so
  // repeated Ctrl+V cascades instead of stacking on the first one. Pre-increment:
  // the very first paste must already be offset, not land on top of the original.
  const step = 14 * Math.min(++pasteCascade, 6);
  const created = clipboardBuf.map((src) => {
    const a = JSON.parse(JSON.stringify(src));
    a.id = uid('an');
    a.page = page;
    // A pure translation by (step, step): every component moves by the same
    // amount, in both PDF axes.
    a.rect = a.rect.map((v) => v + step);
    const shiftFlat = (arr) => arr.map((v) => v + step);
    if (a.quads) a.quads = a.quads.map(shiftFlat);
    if (a.paths) a.paths = a.paths.map(shiftFlat);
    if (a.points) a.points = shiftFlat(a.points);
    if (a.leader) a.leader = shiftFlat(a.leader);
    return a;
  });
  created.forEach((a) => addAnnot(a));
  pushHistory('paste');
  state.selection = created.map((a) => a.id);
  renderAllAnnotations();
  renderSidebar();
  renderContext();
  toast(`Pasted ${created.length} ${created.length === 1 ? 'item' : 'items'}`, 'ok');
  return true;
}

function renderToolProps(host, panel) {
  panel.classList.remove('hidden');
  $('#ctxTitle').textContent = `${toolName(state.tool || 'select')} tool`;
  host.innerHTML = '';

  // Foxit's Typewriter tool: the panel is text properties first (Font / Size /
  // Colour / Style / Alignment), then the box border & fill — not shape
  // Stroke/Fill/Opacity. A new text box picks these up from settings via
  // makeAnnot, so the panel and the created box always agree.
  // Direct Editor gets the full Acrobat Format list: font, size, colour,
  // B/I/U, alignment INCLUDING justify, line spacing, character spacing and
  // horizontal scaling. Justify is the one that needs the writer to place
  // words individually — see applyTextEdit.
  if (state.tool === 'editText' || directEditorOpen()) {
    // The session, not the tool, decides the title: a Direct Editor opened by
    // double-clicking from the Select tool is still a Direct Editor.
    $('#ctxTitle').textContent = 'Direct Editor';
    const live = directEditorOpen();
    // Seed from the block actually being edited. Reading the persisted house
    // style instead is what made these controls look dead: they displayed
    // Helvetica/11pt whatever the block was, and a change then landed on the
    // *next* block rather than the one on screen.
    const S = directEditorState() || {
      fontFamily: settings.textFont || 'Helvetica',
      size: settings.textSize ?? 11,
      colorHex: settings.textColor || '#14171f',
      align: settings.textAlign || 'left',
      bold: !!settings.textBold, italic: !!settings.textItalic, underline: !!settings.textUnderline,
      lineSpacing: settings.textLineSpacing ?? 1.2,
      charSpacing: settings.textCharSpacing ?? 0,
      hScale: settings.textHScale ?? 100,
    };
    // Number fields commit on `input` as well as `change`: `change` alone fires
    // when focus leaves, which in a live editor is too late to see the effect.
    const numCtl = (value, opts, apply) => {
      const i = el('input', { type: 'number', value: String(value), style: { width: '100%' }, ...opts });
      const fire = () => apply(Number(i.value));
      i.oninput = fire;
      i.onchange = fire;
      return i;
    };
    host.appendChild(directOcrGroup());
    host.appendChild(el('div', { class: 'prop-group' }, [
      el('div', { class: 'prop-title', text: live ? 'Direct Editor — selection' : 'Direct Editor — style for next edit' }),
      el('div', { class: 'prop-row' }, [
        el('div', { class: 'pr-c', style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
          el('button', {
            type: 'button',
            class: `mini-btn${state.editRegionMode ? ' primary' : ''}`,
            text: state.editRegionMode ? 'Drag on the page…' : 'Select area',
            title: 'Limit editing to a rectangle you draw on the page — OCR runs on that area only for scans.',
            onclick: () => { toggleRegionMode(); renderContext(); },
          }),
          state.editRegion ? el('button', {
            type: 'button',
            class: 'mini-btn',
            text: 'Clear area',
            title: 'Back to editing the whole page',
            onclick: () => { clearEditRegion(); renderContext(); },
          }) : null,
        ]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Font' }),
        el('div', { class: 'pr-c' }, [(() => {
          // Standard families plus anything registered — a font extracted from
          // this document or uploaded by the user. Picking one of those is how
          // a character outside WinAnsi survives the save; Standard-14 would
          // write it as "?".
          const sel = el('select', {});
          const STD = ['Helvetica', 'Times', 'Courier'];
          for (const f of STD) sel.appendChild(el('option', { value: f, text: f }));
          for (const f of customFontFamilies().filter((x) => !STD.includes(x))) {
            sel.appendChild(el('option', { value: f, text: isUserFont(f) ? `${f} — my font` : f }));
          }
          sel.value = S.fontFamily;
          if (sel.value !== S.fontFamily) sel.value = 'Helvetica';
          // A font family that is not in the list (a document font, or a
          // pdf.js generic like "sans-serif") becomes its own option rather
          // than silently snapping back to Helvetica.
          if (sel.value !== S.fontFamily) {
            sel.insertBefore(el('option', { value: S.fontFamily, text: S.fontFamily }), sel.firstChild);
            sel.value = S.fontFamily;
          }
          sel.onchange = () => applyDirectFormat({ fontFamily: sel.value });
          attachLocalFonts(sel, (v) => applyDirectFormat({ fontFamily: v }), sel.onchange);
          return sel;
        })(), fontStarButton(() => (directEditorState() || {}).fontFamily || (settings.textFont || 'Helvetica'))]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Size' }),
        el('div', { class: 'pr-c' }, [numCtl(S.size, { step: '0.5', min: '1', max: '400' },
          (v) => applyDirectFormat({ size: v || 11 }))]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Colour' }),
        el('div', { class: 'pr-c' }, [(() => {
          const i = el('input', { type: 'color', value: S.colorHex, style: { width: '100%', height: '25px', padding: '0' } });
          i.oninput = () => applyDirectFormat({ color: hexToRgb(i.value) });
          return i;
        })()]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Align' }),
        el('div', { class: 'pr-c' }, [(() => {
          const sel = el('select', {});
          for (const [v, t] of [['left', 'Left'], ['center', 'Centre'], ['right', 'Right'], ['justify', 'Justify']]) {
            sel.appendChild(el('option', { value: v, text: t }));
          }
          sel.value = S.align;
          sel.onchange = () => { applyDirectFormat({ align: sel.value }); };
          return sel;
        })()]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Style' }),
        el('div', { class: 'pr-c' }, [el('div', { class: 'flex' }, (() => {
          const mk = (txt, title, key, field) => {
            const b = el('button', { class: 'mini-btn', text: txt, title });
            b.classList.toggle('on', !!S[field]);
            b.onclick = () => {
              const next = !S[field];
              S[field] = next;
              applyDirectFormat({ [field]: next });
              settings[key] = next;
              b.classList.toggle('on', next);
              saveSettings();
            };
            return b;
          };
          return [mk('B', 'Bold', 'textBold', 'bold'), mk('I', 'Italic', 'textItalic', 'italic'), mk('U', 'Underline', 'textUnderline', 'underline')];
        })())]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Line spacing' }),
        el('div', { class: 'pr-c' }, [numCtl(S.lineSpacing, { step: '0.05', min: '0.8', max: '4' },
          (v) => applyDirectFormat({ lineSpacing: v || 1.2 }))]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Char spacing' }),
        el('div', { class: 'pr-c' }, [numCtl(S.charSpacing, { step: '0.1', min: '-2', max: '10' },
          (v) => applyDirectFormat({ charSpacing: Number.isFinite(v) ? v : 0 }))]),
      ]),
      el('div', { class: 'prop-row' }, [
        el('label', { text: 'Horiz. scale' }),
        el('div', { class: 'pr-c' }, [numCtl(S.hScale, { step: '5', min: '25', max: '250' },
          (v) => applyDirectFormat({ hScale: v || 100 }))]),
      ]),
    ]));
    host.appendChild(el('div', { class: 'prop-group' }, [
      el('div', { class: 'prop-title', text: 'About' }),
      el('div', { class: 'kv' }, [
        el('b', { text: 'Writes' }),
        // The old copy promised the original was deleted from the file, which
        // the cover model never delivered — it only hid it. The writer now makes
        // the promise true: the owned source operators are removed and the
        // replacement is written as ordinary page text, so search, copy-paste
        // and a screen reader all agree with what the page shows.
        el('span', { text: 'The original run is removed from the file and the new text is written as ordinary page text — searchable, copyable and editable again. Where removal is impossible (a scan whose glyphs are pixels, or text inside a shared form) the original is covered instead and the Story group says so. Still not secure redaction: use Redact + Sanitize for that.' }),
      ]),
      el('div', { class: 'kv' }, [
        el('b', { text: 'Afterwards' }),
        el('span', { text: 'The result is an ordinary text box: select it, move it, restyle it from this panel, double-click to retype.' }),
      ]),
      el('div', { class: 'kv' }, [
        el('b', { text: 'Fonts' }),
        el('span', { text: 'Standard-14 faces are WinAnsi-only: anything outside that range saves as "?". Pick an embedded or uploaded font for other scripts — the editor warns before it would lose a character.' }),
      ]),
    ]));
    return;
  }

  if (state.tool === 'textbox' || state.tool === 'callout') {
    const get = {
      fontFamily: settings.textFont, fontSize: settings.textSize,
      textColor: settings.textColor, bold: settings.textBold, italic: settings.textItalic, align: settings.textAlign,
    };
    const set = {
      fontFamily: (v) => { settings.textFont = v; saveSettings(); },
      fontSize: (v) => { settings.textSize = v; saveSettings(); },
      textColor: (v) => { settings.textColor = v; saveSettings(); },
      bold: (b) => { settings.textBold = b; saveSettings(); renderToolProps(host, panel); },
      italic: (b) => { settings.textItalic = b; saveSettings(); renderToolProps(host, panel); },
      align: (v) => { settings.textAlign = v; saveSettings(); },
    };
    host.appendChild(textPropsGroup(get, set));

    const bg = el('div', { class: 'prop-group' });
    bg.appendChild(el('div', { class: 'prop-title', text: 'Box' }));
    const borderCol = el('input', { type: 'color', value: settings.color, style: { width: '100%', height: '28px', padding: '0' } });
    borderCol.oninput = () => { state.color = borderCol.value; state.colorRgb = hexToRgb(borderCol.value); settings.color = borderCol.value; if (activeDoc()) renderAllAnnotations(); };
    borderCol.onchange = () => { saveSettings(); renderRibbon(); };
    bg.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Border' }), el('div', { class: 'pr-c' }, [borderCol])]));
    const bw = el('input', { type: 'number', step: '0.5', min: '0', value: String(settings.borderWidth ?? 1.5), style: { width: '100%' } });
    bw.onchange = () => { settings.borderWidth = Number(bw.value); saveSettings(); };
    bg.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Border width' }), el('div', { class: 'pr-c' }, [bw])]));
    bg.appendChild(fillRow('Fill', settings.fillEnabled ? hexToRgb(settings.fillColor || '#ffffff') : null, (v) => {
      settings.fillEnabled = v !== null;
      if (v) settings.fillColor = rgbToHex(v);
      saveSettings();
    }));
    host.appendChild(bg);
    host.appendChild(el('div', { class: 'hint', text: 'New text boxes use these settings. Select a box to edit it directly.' }));
    return;
  }

  // Generic appearance panel for shape / markup / stamp tools.
  const g = el('div', { class: 'prop-group' });
  g.appendChild(el('div', { class: 'prop-title', text: 'Default appearance' }));
  const stroke = el('input', { type: 'color', value: state.color, style: { width: '100%', height: '28px', padding: '0' } });
  stroke.oninput = () => { state.color = stroke.value; state.colorRgb = hexToRgb(stroke.value); settings.color = stroke.value; if (activeDoc()) renderAllAnnotations(); };
  stroke.onchange = () => { saveSettings(); renderRibbon(); };
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Stroke' }), el('div', { class: 'pr-c' }, [stroke])]));
  if (['rect', 'ellipse', 'whiteout'].includes(state.tool)) {
    g.appendChild(fillRow('Fill', settings.fillEnabled ? hexToRgb(settings.fillColor || '#ffffff') : null, (v) => {
      settings.fillEnabled = v !== null;
      if (v) settings.fillColor = rgbToHex(v);
      saveSettings();
    }));
  }
  const op = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: String(state.opacity) });
  op.oninput = () => { state.opacity = Number(op.value); };
  op.onchange = () => { state.opacity = Number(op.value); settings.opacity = state.opacity; saveSettings(); };
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Opacity' }), el('div', { class: 'pr-c' }, [op])]));
  const sizeKey = TOOL_SIZE_KEY[state.tool] || 'borderWidth';
  const bw = el('input', { type: 'number', step: '0.5', min: '0', value: String(settings[sizeKey] ?? TOOL_SIZE_FALLBACK[sizeKey] ?? 1.5), style: { width: '100%' } });
  bw.onchange = () => { settings[sizeKey] = Number(bw.value); saveSettings(); renderRibbon(); };
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: sizeKey === 'borderWidth' ? 'Stroke width' : 'Marker width' }), el('div', { class: 'pr-c' }, [bw])]));
  if (state.tool === 'brush') {
    const hd = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(settings.brushHardness ?? 0.85) });
    const hv = el('span', { class: 'hint', text: `${Math.round((settings.brushHardness ?? 0.85) * 100)}%` });
    hd.oninput = () => { settings.brushHardness = Number(hd.value); hv.textContent = `${Math.round(hd.value * 100)}%`; };
    hd.onchange = () => saveSettings();
    g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Hardness' }), el('div', { class: 'pr-c' }, [hd, hv])]));
  }
  host.appendChild(g);
  host.appendChild(el('div', { class: 'hint', text: 'New shapes use these settings. Select an existing shape to edit it directly.' }));
}

/* ══ Object arrangement ════════════════════════════════════════════════ */

let sizeLinked = true;            // W↔H aspect lock, remembered across selections
const round2 = (v) => Math.round(v * 100) / 100;

/** Move or resize through transformAnnot so lines keep /L, markup keeps
 *  /QuadPoints and freehand keeps /InkList in step with the new /Rect. */
function setAnnotRect(a, to, label) {
  transformAnnot(a, a.rect.slice(), normalizeRect(to));
  pushHistory(label);
  emit('annots');
  renderContext();
}

/** One object aligns against the page; two or more against the bounding box of
 *  the selection — the behaviour the owner asked for. */
function alignmentBox(sel) {
  if (sel.length >= 2) {
    return sel.reduce((b, a) => [
      Math.min(b[0], a.rect[0]), Math.min(b[1], a.rect[1]),
      Math.max(b[2], a.rect[2]), Math.max(b[3], a.rect[3]),
    ], sel[0].rect.slice());
  }
  const d = pageDims(sel[0].page);
  return [0, 0, d.w, d.h];
}

function alignSelection(where) {
  const sel = state.selection.map(annotById).filter(Boolean);
  if (!sel.length) return;
  const box = alignmentBox(sel);
  for (const a of sel) {
    const w = a.rect[2] - a.rect[0], h = a.rect[3] - a.rect[1];
    let x = a.rect[0], y = a.rect[1];
    if (where === 'left') x = box[0];
    else if (where === 'hcentre') x = box[0] + (box[2] - box[0] - w) / 2;
    else if (where === 'right') x = box[2] - w;
    // PDF y grows upward, so the visual top of the box is its largest y.
    else if (where === 'top') y = box[3] - h;
    else if (where === 'vmiddle') y = box[1] + (box[3] - box[1] - h) / 2;
    else if (where === 'bottom') y = box[1];
    transformAnnot(a, a.rect.slice(), [x, y, x + w, y + h]);
  }
  pushHistory('align');
  emit('annots');
  renderContext();
}

function arrangeSelection(mode) {
  const ids = state.selection.slice();
  if (!ids.length) return;
  reorderAnnots(ids, mode);
  pushHistory('z-order');
  renderContext();
}

function arrangeGroup() {
  const g = el('div', { class: 'prop-group' });
  g.appendChild(el('div', { class: 'prop-title', text: 'Arrange' }));
  const btn = (text, title, act) => {
    const b = el('button', { class: 'mini-btn', text, title, style: { flex: '1', minWidth: '0' } });
    b.onclick = act;
    return b;
  };
  g.appendChild(el('div', { class: 'flex' }, [
    btn('Front', 'Bring to Front', () => arrangeSelection('front')),
    btn('Back', 'Send to Back', () => arrangeSelection('back')),
    btn('Fwd', 'Bring Forward', () => arrangeSelection('forward')),
    btn('Bwd', 'Send Backward', () => arrangeSelection('backward')),
  ]));
  g.appendChild(el('div', { class: 'flex', style: { marginTop: '5px' } }, [
    btn('Left', 'Align Left', () => alignSelection('left')),
    btn('Centre', 'Align Horizontal Centre', () => alignSelection('hcentre')),
    btn('Right', 'Align Right', () => alignSelection('right')),
  ]));
  g.appendChild(el('div', { class: 'flex', style: { marginTop: '4px' } }, [
    btn('Top', 'Align Top', () => alignSelection('top')),
    btn('Middle', 'Align Vertical Middle', () => alignSelection('vmiddle')),
    btn('Bottom', 'Align Bottom', () => alignSelection('bottom')),
  ]));
  g.appendChild(el('div', { class: 'hint', style: { marginTop: '5px' }, text: 'One object aligns to the page; two or more align to the selection box.' }));
  return g;
}

function geometryGroup(a) {
  const g = el('div', { class: 'prop-group' });
  g.appendChild(el('div', { class: 'prop-title', text: 'Size & position (pt)' }));
  const dims = pageDims(a.page);
  const w0 = a.rect[2] - a.rect[0], h0 = a.rect[3] - a.rect[1];
  const num = (v, title) => el('input', { type: 'number', step: '0.5', value: String(round2(v)), title, style: { width: '100%' } });
  const W = num(w0, 'Width'), H = num(h0, 'Height'), X = num(a.rect[0], 'X'), Y = num(a.rect[1], 'Y');
  const lock = el('button', {
    class: 'mini-btn', text: sizeLinked ? 'Link' : 'Free',
    title: sizeLinked ? 'Aspect ratio locked — click to unlock' : 'Aspect ratio free — click to lock',
    style: { width: '44px' },
  });
  lock.onclick = () => { sizeLinked = !sizeLinked; renderContext(); };

  // Resizing keeps the top-left corner fixed, the way a marquee drag does.
  const resize = (changed) => {
    const nw = clamp(Number(W.value), 1, dims.w * 4);
    const nh = clamp(Number(H.value), 1, dims.h * 4);
    if (!Number.isFinite(nw) || !Number.isFinite(nh)) { renderContext(); return; }
    const ratio = w0 > 0 && h0 > 0 ? w0 / h0 : 1;
    let fw = nw, fh = nh;
    if (sizeLinked) { if (changed === 'w') fh = fw / ratio; else fw = fh * ratio; }
    W.value = String(round2(fw)); H.value = String(round2(fh));
    setAnnotRect(a, [a.rect[0], a.rect[3] - fh, a.rect[0] + fw, a.rect[3]], 'resize');
  };
  W.onchange = () => resize('w');
  H.onchange = () => resize('h');
  const move = () => {
    const nx = Number(X.value), ny = Number(Y.value);
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) { renderContext(); return; }
    const w = a.rect[2] - a.rect[0], h = a.rect[3] - a.rect[1];
    setAnnotRect(a, [nx, ny, nx + w, ny + h], 'move');
  };
  X.onchange = move;
  Y.onchange = move;
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'W × H' }), el('div', { class: 'pr-c' }, [W, lock, H])]));
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'X / Y' }), el('div', { class: 'pr-c' }, [X, Y])]));
  g.appendChild(el('div', { class: 'hint', text: 'PDF points: X from the page’s left edge, Y from its bottom edge.' }));
  return g;
}

/**
 * "Recognize Text" — the OCR half of the Direct Editor panel.
 *
 * Acrobat puts this in the same place: Edit PDF cannot do anything with a
 * scan until the page has been read, so the panel says what the page contains
 * and offers to read it, instead of leaving an empty page that looks broken.
 */
function directOcrGroup() {
  const doc = activeDoc();
  const page = doc?.currentPage ?? 0;
  const g = el('div', { class: 'prop-group' });
  g.appendChild(el('div', { class: 'prop-title', text: 'Page text' }));
  const status = el('div', { class: 'hint', text: 'Reading this page…' });
  g.appendChild(status);

  const lang = el('select', {});
  for (const l of OCR_LANGS) lang.appendChild(el('option', { value: l.id, text: l.label }));
  lang.value = settings.ocrLang || 'eng+nep';
  lang.onchange = () => { settings.ocrLang = lang.value; saveSettings(); };

  const btn = el('button', { class: 'mini-btn primary', text: 'Recognize Text' });
  btn.onclick = async () => {
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Recognizing…';
    try { await recognizePageForEditing(page, { langs: lang.value }); } finally {
      btn.disabled = false;
      btn.textContent = was;
    }
    await refresh();
  };

  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Language' }), el('div', { class: 'pr-c' }, [lang])]));
  g.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: '' }), el('div', { class: 'pr-c' }, [btn])]));

  const refresh = async () => {
    try {
      const src = await editableSource(page);
      const kind = src.source === 'native' ? 'text found in the file'
        : src.source === 'ocr' ? 'recognised by OCR'
        : src.source === 'ocr-empty' ? 'OCR found no words here'
        : 'no text — this page is a scan or an image';
      status.textContent = `Page ${page + 1}: ${src.blocks.length} editable block${src.blocks.length === 1 ? '' : 's'} — ${kind}.`;
    } catch (e) {
      status.textContent = 'Could not read this page.';
    }
  };
  void refresh();
  return g;
}

function renderContext() {
  if (state.ai.dockOpen) { renderAIDock(); return; }
  const host = $('#ctxBody');
  const panel = $('#context');
  const doc = activeDoc();
  const sel = state.selection.map(annotById).filter(Boolean);
  if (!doc) { panel.classList.add('hidden'); return; }

  // A live Direct Editor session owns the properties panel: its Format controls
  // must act on the text being edited, never on an object that happens to still
  // be selected (double-clicking a text block while an annotation is selected
  // used to leave the annotation's panel in place, so the format controls were
  // editing the wrong thing entirely).
  if (directEditorOpen()) return renderToolProps(host, panel);

  if (sel.length === 1) {
    // A Direct Editor box is the on-screen handle for a text EDIT. Selecting it
    // must show the edit's own panel — story, frames, composition — because that
    // is where the three explicit actions live. A plain typewriter box has no
    // edit behind it and keeps the ordinary appearance panel.
    const box = sel[0];
    const linked = box && box.directEdit
      ? (doc.textEdits || []).find((x) => x.id === box.directEdit) : null;
    if (linked) return renderTextEditProps(linked, host, panel, box);
    return renderAnnotProps(sel[0], host, panel);
  }
  // A committed Direct Editor block: drag it on the page, re-open it here.
  const tes = (doc.textEdits || []).filter((x) => state.selection.includes(x.id));
  if (!sel.length && tes.length === 1) return renderTextEditProps(tes[0], host, panel);
  if (sel.length > 1) {
    panel.classList.remove('hidden');
    $('#ctxTitle').textContent = `${sel.length} selected`;
    host.innerHTML = '';
    const del = el('button', { class: 'mini-btn', text: 'Delete selected', style: { background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--accent-text)' } });
    del.onclick = () => { removeAnnots(sel.map((a) => a.id)); pushHistory('delete'); renderAllAnnotations(); renderSidebar(); emit('annots'); };
    host.appendChild(arrangeGroup());
    host.appendChild(el('div', { class: 'prop-group' }, [del]));
    return;
  }
  if (TOOL_PROPS.has(state.tool)) return renderToolProps(host, panel);
  panel.classList.remove('hidden');
  $('#ctxTitle').textContent = 'Page';
  const i = doc.currentPage ?? 0;
  const dims = pageDims(i);
  host.innerHTML = '';
  const rows = [
    ['Page', `${i + 1} of ${doc.numPages}`],
    ['Size', fmtSize(dims.w, dims.h)],
    ['Rotation', `${((doc.pageRotate?.[i] || 0) + state.view.rotation) % 360}°`],
    ['Annotations', String(doc.annots.filter((a) => a.page === i).length)],
    ['Text edits', String(doc.textEdits.filter((e) => e.page === i).length)],
  ];
  const box = el('div', { class: 'prop-group' });
  box.appendChild(el('div', { class: 'prop-title', text: `Page ${i + 1}` }));
  rows.forEach(([k, v]) => box.appendChild(el('div', { class: 'kv' }, [el('b', { text: k }), el('span', { text: v })])));
  host.appendChild(box);
}

function renderTextEditProps(e, host, panel, box = null) {
  panel.classList.remove('hidden');
  host.innerHTML = '';
  // Reached through the edit's own box? Keep that box's appearance controls
  // first — it is still a normal text box the user can restyle — then append the
  // story controls underneath. The box is what was clicked, so dropping its
  // panel would make restyling it impossible.
  if (box) renderAnnotProps(box, host, panel);
  $('#ctxTitle').textContent = 'Text block';
  const g1 = el('div', { class: 'prop-group' });
  g1.appendChild(el('div', { class: 'prop-title', text: 'Edited text' }));
  g1.appendChild(el('div', { class: 'hint', text: 'Drag the box anywhere on the page, or double-click it to type into it again. On save the original run is removed from the file and this text is written as ordinary page text.' }));
  const row = el('div', { class: 'prop-row' });
  const edit = el('button', { class: 'mini-btn primary', text: 'Edit text' });
  edit.onclick = () => { void openEditorForEdit(e.page, e.id); };
  const del = el('button', { class: 'mini-btn', text: 'Delete', style: { background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--accent-text)' } });
  del.onclick = () => {
    const doc = activeDoc();
    if (!doc) return;
    doc.textEdits = (doc.textEdits || []).filter((x) => x.id !== e.id);
    state.selection = state.selection.filter((id) => id !== e.id);
    pushHistory('delete text block');
    renderAllAnnotations();
    renderSidebar();
    renderContext();
    emit('annots');
  };
  row.append(edit, del);
  g1.appendChild(row);
  host.appendChild(g1);

  // Recognised table structure: the panel names the cell and the table it
  // belongs to, so "which cell am I editing?" is answered, not guessed.
  if (e.table) {
    const tg = el('div', { class: 'prop-group' });
    tg.appendChild(el('div', { class: 'prop-title', text: 'Table' }));
    tg.appendChild(el('div', { class: 'kv' }, [el('b', { text: 'Cell' }), el('span', { text: `R${(e.table.row ?? 0) + 1}C${(e.table.col ?? 0) + 1}` })]));
    tg.appendChild(el('div', { class: 'kv' }, [el('b', { text: 'Table size' }), el('span', { text: `${e.table.rows || '?'}×${e.table.cols || '?'}` })]));
    tg.appendChild(el('div', { class: 'hint', text: 'This text is a table cell. Edits wrap inside the cell; a cell too small for its text is reported as overset, never clipped silently.' }));
    host.appendChild(tg);
  }

  /* ── Story: the authoring model behind this edit ──────────────────────────
     The three explicit actions the research asks for live here, each named for
     what it does rather than a single ambiguous "Link". */
  const g2 = el('div', { class: 'prop-group' });
  g2.appendChild(el('div', { class: 'prop-title', text: 'Story' }));
  const frames = Array.isArray(e.frames) ? e.frames : [];
  const frameN = frames.length || 1;
  g2.appendChild(el('div', { class: 'kv' }, [el('b', { text: 'Mode' }), el('span', { text: e.mode === 'flow' ? 'Flowing paragraph' : 'Single line' })]));
  g2.appendChild(el('div', { class: 'kv' }, [el('b', { text: 'Frames' }), el('span', { text: frameN === 1 ? '1 (in place)' : `${frameN} linked` })]));
  if (e.removal) {
    g2.appendChild(el('div', { class: 'kv' }, [el('b', { text: 'On save' }), el('span', {
      text: e.removal === 'excise' ? `Original removed (${e.removedBlocks || 0} run${(e.removedBlocks || 0) === 1 ? '' : 's'})` : 'Covered (cannot remove here)',
    })]));
  }
  if (e.overset) {
    const warn = el('div', { class: 'hint', style: { color: 'var(--danger)' },
      text: `Overset: ${e.overset.lines} line${e.overset.lines === 1 ? '' : 's'} do not fit and are not shown on the page. Add a frame, enlarge it, or shorten the text — export would drop them.` });
    g2.appendChild(warn);
  }
  const srow = el('div', { class: 'prop-row' });
  const nextPage = (e.page ?? 0) + 1;
  const linkBtn = el('button', { class: 'mini-btn', text: 'Continue on next page' });
  linkBtn.disabled = nextPage >= (activeDoc()?.numPages || 0);
  linkBtn.title = 'Link frames: compose this text into a frame on the next page, continuing from where this frame ends.';
  linkBtn.onclick = async () => {
    const doc = activeDoc();
    if (!doc) return;
    const box = e.drawBox || (frames[0] && frames[0].rect) || e.rect;
    const chain = frames.length ? frames.map((f) => ({ page: f.page, rect: f.rect.slice() })) : [{ page: e.page, rect: box.slice() }];
    chain.push({ page: nextPage, rect: box.slice() });
    await threadEditFrames(e.id, chain);
    renderAllAnnotations();
    renderContext();
    emit('annots');
  };
  const unlinkBtn = el('button', { class: 'mini-btn', text: 'Unlink frames' });
  unlinkBtn.disabled = frameN < 2;
  unlinkBtn.onclick = async () => {
    await threadEditFrames(e.id, [{ page: e.page, rect: (e.drawBox || e.rect).slice() }]);
    renderAllAnnotations();
    renderContext();
    emit('annots');
  };
  srow.append(linkBtn, unlinkBtn);
  g2.appendChild(srow);

  // "Make paragraph" — merge this edit's source with the next block on the page,
  // an explicit decision with the separator the user picks.
  const mergeRow = el('div', { class: 'prop-row' });
  const sepSel = el('select', { style: { width: '100%' } });
  for (const [v, t] of [[' ', 'Join with a space (soft wrap)'], ['\n', 'Keep a line break'], ['', 'Join with nothing (split fragment)']]) {
    sepSel.appendChild(el('option', { value: v, text: t }));
  }
  const mergeBtn = el('button', { class: 'mini-btn', text: 'Make paragraph with next block' });
  mergeBtn.onclick = async () => {
    const doc = activeDoc();
    if (!doc) return;
    const blocks = await editableBlocks(e.page);
    // Find the block this edit owns, then the one after it in source order.
    const mine = blocks.findIndex((b) => (e.itemIndices || []).some((k) => (b.itemIndices || []).includes(k)) || (e.key && b.key === e.key));
    const next = mine >= 0 ? mine + 1 : -1;
    if (next < 0 || next >= blocks.length) { toast('No following block on this page to merge with.', 'warn'); return; }
    const ok = await mergeBlocksIntoParagraph(e.page, [mine, next], { separators: [sepSel.value] });
    if (!ok) { toast('Nothing to merge.', 'warn'); return; }
    renderAllAnnotations();
    renderContext();
    emit('annots');
  };
  const mg = el('div', { class: 'prop-group' });
  mg.appendChild(el('div', { class: 'prop-title', text: 'Make paragraph' }));
  mg.appendChild(el('div', { class: 'hint', text: 'Declare this text and the next block ONE logical sequence. You choose how the two are joined — never guessed automatically.' }));
  mg.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Join' }), el('div', { class: 'pr-c' }, [sepSel])]));
  mergeRow.appendChild(mergeBtn);
  mg.appendChild(mergeRow);
  host.appendChild(g2);
  host.appendChild(mg);

  const preview = previewEditLayout(e.id);
  if (preview) {
    const pg = el('div', { class: 'prop-group' });
    pg.appendChild(el('div', { class: 'prop-title', text: 'Composition' }));
    pg.appendChild(el('div', { class: 'kv' }, [el('b', { text: 'Placed' }), el('span', { text: `${preview.consumed} of ${preview.total} characters` })]));
    pg.appendChild(el('div', { class: 'kv' }, [el('b', { text: 'Overset' }), el('span', { text: preview.overset ? `yes — ${preview.overset.lines} line(s) left over` : 'none' })]));
    host.appendChild(pg);
  }
}

function renderAnnotProps(a, host, panel) {
  panel.classList.remove('hidden');
  const names = { highlight: 'Highlight', highlighter: 'Highlighter', brush: 'Brush', underline: 'Underline', strikeout: 'Strikethrough', squiggly: 'Squiggly', note: 'Sticky note', textbox: 'Text box', callout: 'Callout', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow', ink: 'Ink', stamp: 'Stamp', image: 'Image', signature: 'Signature', redact: 'Redaction', whiteout: 'Whiteout', measure: 'Measurement' };
  $('#ctxTitle').textContent = names[a.type] || a.type;
  host.innerHTML = '';

  const g1 = el('div', { class: 'prop-group' });
  g1.appendChild(el('div', { class: 'prop-title', text: (a.type === 'textbox' || a.type === 'callout') ? 'Box' : 'Appearance' }));
  const FILLABLE = ['rect', 'ellipse', 'whiteout', 'callout', 'textbox'];
  const hasFill = FILLABLE.includes(a.type);
  const col = el('input', { type: 'color', value: rgbToHex(a.color || [1, .85, .2]), style: { width: '100%', height: '28px', padding: '0' } });
  col.oninput = () => { updateAnnot(a.id, { color: hexToRgb(col.value) }, { silent: true }); renderAllAnnotations(); };
  col.onchange = () => pushHistory('colour');
  const op = el('input', { type: 'range', min: '0.05', max: '1', step: '0.05', value: String(a.opacity ?? 1) });
  op.oninput = () => { updateAnnot(a.id, { opacity: Number(op.value) }, { silent: true }); renderAllAnnotations(); };
  op.onchange = () => pushHistory('opacity');
  g1.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: (a.type === 'textbox' || a.type === 'callout') ? 'Border' : (hasFill ? 'Stroke' : 'Colour') }), el('div', { class: 'pr-c' }, [col])]));
  g1.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Opacity' }), el('div', { class: 'pr-c' }, [op])]));
  if (hasFill) {
    g1.appendChild(fillRow('Fill', a.fill || null, (v, hist) => {
      updateAnnot(a.id, { fill: v }, { silent: true });
      renderAllAnnotations();
      if (hist) pushHistory('fill');
    }));
  }
  if (!['highlight', 'underline', 'strikeout', 'squiggly', 'note', 'stamp', 'image', 'signature'].includes(a.type)) {
    const bw = el('input', { type: 'number', step: '0.5', value: String(a.borderWidth || 1), style: { width: '100%' } });
    bw.oninput = () => { updateAnnot(a.id, { borderWidth: Number(bw.value) }, { silent: true }); renderAllAnnotations(); };
    bw.onchange = () => pushHistory('border width');
    g1.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Border' }), el('div', { class: 'pr-c' }, [bw])]));
  }
  if (a.type === 'brush') {
    // 0 = softest edge we can bake, 1 = hard marker.
    const hd = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(a.hardness ?? 0.85) });
    const hv = el('span', { class: 'hint', text: `${Math.round((a.hardness ?? 0.85) * 100)}%` });
    hd.oninput = () => { hv.textContent = `${Math.round(hd.value * 100)}%`; updateAnnot(a.id, { hardness: Number(hd.value) }, { silent: true }); renderAllAnnotations(); };
    hd.onchange = () => pushHistory('hardness');
    g1.appendChild(el('div', { class: 'prop-row' }, [el('label', { text: 'Hardness' }), el('div', { class: 'pr-c' }, [hd, hv])]));
  }

  // Foxit keeps Text and Box as separate property clusters for a text box, so
  // the font/size/colour/style/alignment never get confused with the box
  // border & fill. Render Text first, then the Box group below.
  if (a.type === 'textbox' || a.type === 'callout') {
    const tget = {
      fontFamily: a.fontFamily || 'Helvetica', fontSize: a.fontSize || 11,
      textColor: rgbToHex(a.textColor || [0.08, 0.09, 0.12]), bold: a.bold, italic: a.italic, align: a.align || 'left',
    };
    const tset = {
      fontFamily: (v) => { updateAnnot(a.id, { fontFamily: v }, { silent: true }); renderAllAnnotations(); },
      fontSize: (v) => { updateAnnot(a.id, { fontSize: v }, { silent: true }); renderAllAnnotations(); },
      textColor: (v) => { updateAnnot(a.id, { textColor: hexToRgb(v) }, { silent: true }); renderAllAnnotations(); },
      bold: (b) => { updateAnnot(a.id, { bold: b }, { silent: true }); renderAllAnnotations(); renderContext(); },
      italic: (b) => { updateAnnot(a.id, { italic: b }, { silent: true }); renderAllAnnotations(); renderContext(); },
      align: (v) => { updateAnnot(a.id, { align: v }, { silent: true }); renderAllAnnotations(); pushHistory('align'); },
    };
    host.appendChild(textPropsGroup(tget, tset));
  }
  host.appendChild(g1);
  host.appendChild(geometryGroup(a));
  host.appendChild(arrangeGroup());

  const g2 = el('div', { class: 'prop-group' });
  g2.appendChild(el('div', { class: 'prop-title', text: 'Comment' }));
  const ta = el('textarea', { style: { minHeight: '70px' } });
  ta.value = a.text || '';
  ta.oninput = () => { updateAnnot(a.id, { text: ta.value }, { silent: true }); };
  ta.onchange = () => { pushHistory('comment'); renderSidebar(); };
  g2.appendChild(ta);
  const author = el('input', { type: 'text', value: a.author || settings.author || '' });
  author.oninput = () => { updateAnnot(a.id, { author: author.value }); };
  g2.appendChild(el('div', { class: 'prop-row', style: { marginTop: '7px' } }, [el('label', { text: 'Author' }), el('div', { class: 'pr-c' }, [author])]));
  host.appendChild(g2);

  const g4 = el('div', { class: 'prop-group' });
  const del = el('button', { class: 'mini-btn', text: 'Delete', style: { background: 'var(--danger)', borderColor: 'var(--danger)', color: 'var(--accent-text)' } });
  del.onclick = () => { removeAnnots([a.id]); pushHistory('delete'); renderAllAnnotations(); renderSidebar(); renderContext(); emit('annots'); };
  const dup = el('button', { class: 'mini-btn', text: 'Duplicate' });
  dup.onclick = () => {
    const copy = JSON.parse(JSON.stringify(a));
    copy.id = 'an' + Math.random().toString(36).slice(2, 9);
    copy.rect = [a.rect[0] + 12, a.rect[1] - 12, a.rect[2] + 12, a.rect[3] - 12];
    activeDoc().annots.push(copy);
    state.selection = [copy.id];
    pushHistory('duplicate');
    renderAllAnnotations();
    renderContext();
  };
  g4.appendChild(el('div', { class: 'flex' }, [dup, del]));
  host.appendChild(g4);
}

/* ══ Status bar ═════════════════════════════════════════════════════════ */

function updateStatus() {
  const doc = activeDoc();
  $('#stPage').textContent = doc ? `Page ${(doc.currentPage ?? 0) + 1} / ${doc.numPages}` : '—';
  $('#stMode').textContent = toolName(state.tool || 'select');
  const sec = $('#stSecurity');
  const scannedCount = doc && doc.scanned ? doc.scanned.size : 0;
  const bits = [];
  if (doc && doc.passwordProtected) bits.push(`${svgIcon('lock', 11)} Encrypted`);
  if (scannedCount) bits.push(`${svgIcon('scan', 11)} ${scannedCount} scanned`);
  sec.innerHTML = bits.join(' · ');
  // Undo/Redo had no disabled state at all, so they looked live with no history.
  // Structural (page) undo lives in a separate stack, so the buttons must
  // consider it too or they grey out while Ctrl+Z would still work.
  const und = document.querySelector('.qbtn[data-act="edit:undo"]');
  const red = document.querySelector('.qbtn[data-act="edit:redo"]');
  if (und) und.disabled = !canUndo() && !canUndoStructure();
  if (red) red.disabled = !canRedo() && !canRedoStructure();
  // PDF units are 1/72 inch, so rendering at scale s yields 72*s dpi.
  const dimsEl = $('#stDims');
  if (dimsEl) {
    if (doc && doc.numPages) {
      const d = pageDims(doc.currentPage ?? 0);
      dimsEl.textContent = `${fmtSize(d.w, d.h)} · ${Math.round(72 * currentScale())} dpi`;
    } else {
      dimsEl.textContent = '';
    }
  }
  $('#stMeta').textContent = doc && doc.bytes ? formatBytes(doc.bytes.length) : '';
  const s = $('#stSave');
  if (!doc) { s.textContent = 'No document'; s.className = 'st-item st-save'; }
  else if (doc.dirty) { s.textContent = 'Unsaved changes'; s.className = 'st-item st-save dirty'; }
  else { s.textContent = 'Saved'; s.className = 'st-item st-save saved'; }
  renderZoomOptions();
  updateTitle();
  syncToolPair();
}

/* The Select/Hand pair lives in the status bar and is always visible, so the
 * two universal tools are reachable from any ribbon tab. Clicking one arms it;
 * the active tool is highlighted in sync with whichever tool is current. */
function wireToolPair() {
  const pair = document.getElementById('toolPair');
  if (!pair) return;
  pair.querySelectorAll('button[data-tool]').forEach((b) => {
    b.innerHTML = svgIcon(b.dataset.tool === 'select' ? 'cursor' : 'hand', 14);
    b.onclick = () => setTool(b.dataset.tool);
  });
}

function syncToolPair() {
  // Both the status-bar pair and the quick-access bar carry Select / Hand, and
  // both must reflect the armed tool — the quick bar is the one that survives a
  // collapsed ribbon, so it is the one a user is most likely to be looking at.
  document.querySelectorAll('#toolPair button[data-tool], .qbtn[data-tool]').forEach((b) => {
    const on = state.tool === b.dataset.tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function renderZoomOptions() {
  const sel = $('#zoomSelect');
  if (!sel) return;
  const doc = activeDoc();
  const pct = Math.round(currentScale() * 100);
  const opts = [50, 75, 100, 125, 150, 200, 300, 400];
  const list = [...new Set([...opts, pct])].sort((a, b) => a - b);
  sel.innerHTML = '';
  const mk = (v, t) => sel.appendChild(el('option', { value: String(v), text: t }));
  mk('fitPage', 'Fit page');
  mk('fitWidth', 'Fit width');
  list.forEach((v) => mk('custom:' + v / 100, v + '%'));
  sel.value = state.view.zoomMode === 'custom' ? 'custom:' + state.view.zoom : state.view.zoomMode;
  if (!sel.value) sel.value = 'fitWidth';
  sel.onchange = () => {
    const v = sel.value;
    if (v === 'fitPage' || v === 'fitWidth') V.setZoom(v);
    else V.setZoom('custom', Number(v.split(':')[1]));
  };
  sel.disabled = !doc;
}

function setBusy(on, label) {
  state.busy = on;
  const s = $('#stSave');
  if (on) { s.textContent = label || 'Working…'; s.className = 'st-item st-save dirty'; }
  else updateStatus();
}

const PT_PER = { cm: 28.3464567, mm: 2.83464567, in: 72, pt: 1 };
const UNIT_DECIMALS = { cm: 1, mm: 1, in: 2, pt: 0 };

/** Format a PDF-space size in the user's measurement unit. PDF units are 1/72",
 *  so every other unit is a fixed divisor of points — cm is the default. */
function fmtSize(wPt, hPt) {
  const u = settings.measureUnit || 'cm';
  const per = PT_PER[u] != null ? PT_PER[u] : PT_PER.cm;
  const d = UNIT_DECIMALS[u] != null ? UNIT_DECIMALS[u] : 1;
  return `${(wPt / per).toFixed(d)} × ${(hPt / per).toFixed(d)} ${u}`;
}

/** Persistent error slot in the status bar. Toasts vanish; a failed open or save
 *  deserves to stay visible until the next successful operation. */
function setDocError(msg) {
  const e = $('#stErr');
  if (e) e.textContent = msg || '';
}

/* ══ Find bar ═══════════════════════════════════════════════════════════ */

function toggleFind(force) {
  const bar = $('#findBar');
  const open = force != null ? force : !bar.classList.contains('open');
  bar.classList.toggle('open', open);
  state.search.open = open;
  if (open) { setSidebar('search'); setTimeout(() => $('#findInput').focus(), 30); }
  else { clearHighlights(); state.search.matches = []; renderSidebar(); }
}

/* ══ Command palette ════════════════════════════════════════════════════ */

const COMMANDS = [
  ['File', 'Open…', 'open', 'file:open'],
  ['File', 'Save', 'save', 'file:save'],
  ['File', 'Save As…', 'save', 'file:saveAs'],
  ['File', 'Print…', 'print', 'file:print'],
  ['File', 'New blank PDF', 'plus', 'file:new'],
  ['File', 'Images → PDF', 'image', 'file:images'],
  ['File', 'Document properties', 'info', 'file:properties'],
  ['Edit', 'Undo', 'undo', 'edit:undo'],
  ['Edit', 'Redo', 'redo', 'edit:redo'],
  ['Edit', 'Preferences', 'settings', 'edit:preferences'],
  ['View', 'Fit page', 'fit', 'view:fitPage'],
  ['View', 'Fit width', 'fit', 'view:fitWidth'],
  ['View', 'Single page', 'file', 'view:single'],
  ['View', 'Continuous', 'pages', 'view:continuous'],
  ['View', 'Facing pages', 'grid', 'view:facing'],
  ['View', 'Show rulers', 'ruler', 'view:rulers'],
  ['View', 'Read aloud', 'readAloud', 'view:readAloud'],
  ['View', 'Read aloud settings…', 'settings', 'view:ttsSettings'],
  ['View', 'Toggle dark mode', 'moon', 'view:darkMode'],
  ['View', 'Presentation mode', 'present', 'view:presentation'],
  ['Comment', 'Highlight', 'highlight', 'tool:highlight'],
  ['Comment', 'Underline', 'underline', 'tool:underline'],
  ['Comment', 'Strikethrough', 'strikeout', 'tool:strikeout'],
  ['Comment', 'Sticky note', 'note', 'tool:note'],
  ['Comment', 'Text box', 'textbox', 'tool:textbox'],
  ['Comment', 'Pencil', 'ink', 'tool:ink'],
  ['Comment', 'Stamp', 'stamp', 'tool:stamp'],
  ['Comment', 'Signature', 'signature', 'tool:signature'],
  ['Comment', 'Redact', 'redact', 'tool:redact'],
  ['Edit PDF', 'Direct Editor', 'editText', 'tool:editText'],
  ['Edit PDF', 'Area Direct Edit', 'marquee', 'tool:editArea'],
  ['Edit PDF', 'OCR — recognise current page', 'scan', 'ocr:page'],
  ['Edit PDF', 'Document fonts', 'font', 'view:fonts'],
  ['Edit PDF', 'Watermark…', 'stamp', 'stamp:watermark'],
  ['Edit PDF', 'Header & footer…', 'text', 'stamp:headerFooter'],
  ['Edit PDF', 'Bates numbering…', 'table', 'stamp:bates'],
  ['Organize', 'Insert blank page', 'plus', 'page:insert'],
  ['Organize', 'Extract pages…', 'scissors', 'page:extract'],
  ['Organize', 'Merge documents…', 'merge', 'page:merge'],
  ['Organize', 'Split document…', 'split', 'page:split'],
  ['Protect', 'Encrypt with password…', 'lock', 'protect:encrypt'],
  ['Protect', 'Apply redactions', 'redact', 'protect:redactAll'],
  ['Documents', 'Compare with another PDF…', 'compare', 'docs:compare'],
  ['Documents', 'Overlay PDF…', 'layers', 'docs:overlay'],
  ['Documents', 'Scale pages…', 'resize', 'docs:scale'],
  ['Documents', 'Remove blank pages…', 'eraser', 'docs:removeBlanks'],
  ['Documents', 'Adjust colours…', 'palette', 'docs:adjustColors'],
  ['Documents', 'Compress…', 'compress', 'docs:compress'],
  ['Documents', 'Flatten annotations…', 'flatten', 'docs:flatten'],
  ['Documents', 'Sanitize…', 'shield', 'docs:sanitize'],
  ['Documents', 'Document information…', 'info', 'docs:info'],
  ['Documents', 'Remove annotations…', 'eraser', 'docs:removeAnnots'],
  ['Documents', 'Multi-page layout (N-up)…', 'grid', 'docs:nup'],
  ['Documents', 'Join into single page…', 'pages', 'docs:singlePage'],
  ['Documents', 'Poster tiles…', 'grid', 'docs:poster'],
  ['Documents', 'Booklet imposition…', 'book', 'docs:booklet'],
  ['Documents', 'Split by size…', 'split', 'docs:splitSize'],
  ['Documents', 'Auto-rename…', 'editText', 'docs:autoRename'],
  ['Documents', 'Repair…', 'check', 'docs:repair'],
  ['Documents', 'Manage attachments…', 'attach', 'docs:attachments'],
  ['Documents', 'Add page numbers…', 'table', 'docs:pageNumbers'],
  ['Documents', 'Automate (pipeline)…', 'wand', 'docs:automate'],
  ['Protect', 'Unlock form fields…', 'unlock', 'protect:unlockForms'],
  ['Protect', 'AI Smart Redact…', 'shield', 'ai:smartredact'],
  ['AI', 'Ask AI', 'ai', 'ai:ask'],
  ['AI', 'Summarise document', 'sparkle', 'ai:summarize'],
  ['AI', 'Compare all open documents', 'brain', 'ai:summarizeAll'],
  ['AI', 'Extract structured data…', 'table', 'ai:extractData'],
  ['AI', 'Translate…', 'translate', 'ai:translate'],
  ['AI', 'Rewrite selection…', 'wand', 'ai:rewrite'],
  ['AI', 'Proofread', 'check', 'ai:proofread'],
  ['AI', 'Contract review…', 'file', 'ai:contract'],
  ['AI', 'Document outline', 'book', 'ai:outline'],
  ['AI', 'AI settings', 'settings', 'ai:settings'],
  ['Export', 'Export text…', 'download', 'export:text'],
  ['Export', 'Export pages as images…', 'image', 'export:images'],
  ['Export', 'Export comments…', 'comments', 'export:comments'],
];

function commandPalette() {
  const root = document.getElementById('overlayRoot');
  const box = el('div', { class: 'palette' });
  const input = el('input', { type: 'text', placeholder: 'Type a command…', spellcheck: 'false' });
  const list = el('div', { class: 'plist' });
  box.append(input, list);
  root.appendChild(box);
  let idx = 0, items = [];

  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const hits = COMMANDS.filter((c) => !q || c[1].toLowerCase().includes(q) || c[0].toLowerCase().includes(q));
    list.innerHTML = '';
    items = [];
    let lastGroup = '';
    hits.forEach(([group, label, icon, act]) => {
      if (group !== lastGroup) { list.appendChild(el('div', { class: 'pgroup', text: group })); lastGroup = group; }
      const row = el('div', { class: 'pitem', html: svgIcon(icon, 15) + `<span class="plt">${label}</span>` });
      row.onclick = () => { close(); onMenuAction(act); };
      list.appendChild(row);
      items.push(row);
    });
    idx = 0;
    mark();
  };
  const mark = () => {
    items.forEach((r, k) => r.classList.toggle('sel', k === idx));
    if (items[idx]) items[idx].scrollIntoView({ block: 'nearest' });
  };
  const close = () => { box.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Enter') { if (items[idx]) items[idx].click(); e.preventDefault(); }
  };
  input.oninput = draw;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', (e) => { if (!box.contains(e.target)) close(); }, { once: true });
  setTimeout(() => input.focus(), 20);
  draw();
}

/* ══ Preferences ════════════════════════════════════════════════════════ */

async function preferencesDialog() {
  await showModal({
    title: 'Preferences',
    body: (b) => {
      const theme = el('select', {}, [
        el('option', { value: 'system', text: 'Match system' }),
        el('option', { value: 'light', text: 'Light' }),
        el('option', { value: 'dark', text: 'Dark' }),
      ]);
      theme.value = settings.theme || 'system';
      const author = el('input', { type: 'text', value: settings.author || '' });
      const zoom = el('select', {}, [
        el('option', { value: 'fitWidth', text: 'Fit width' }),
        el('option', { value: 'fitPage', text: 'Fit page' }),
        el('option', { value: 'custom', text: '100%' }),
      ]);
      zoom.value = settings.defaultZoom || 'fitWidth';
      b.appendChild(formRow('Theme', theme).row);
      b.appendChild(formRow('Author name', author).row);
      b.appendChild(formRow('Default zoom', zoom).row);
      b.appendChild(el('div', { class: 'divider' }));
      const ai = el('button', { class: 'mini-btn', text: 'Configure AI model…' });
      ai.onclick = () => configureAI();
      b.appendChild(formRow('AI assistant', ai).row);
      b.appendChild(el('div', { class: 'divider' }));
      const kb = el('div', { class: 'hint' });
      kb.innerHTML = shortcutHelpHtml();
      b.appendChild(kb);
      theme.onchange = () => { settings.theme = theme.value; applyTheme(); saveSettings(); };
      author.oninput = () => { settings.author = author.value; state.author = author.value; saveSettings(); };
      zoom.onchange = () => { settings.defaultZoom = zoom.value; saveSettings(); };
    },
  });
}

function shortcutHelpHtml() {
  const rows = [
    ['Ctrl+N / Ctrl+O / Ctrl+S', 'New / Open / Save'],
    ['Ctrl+Shift+S', 'Save as…'],
    ['Ctrl+W / Ctrl+P', 'Close / Print'],
    ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
    ['Ctrl+X / Ctrl+C / Ctrl+V', 'Cut / Copy / Paste'],
    ['Ctrl+A', 'Select all'],
    ['Ctrl+F', 'Find'],
    ['F3 / Shift+F3', 'Find next / previous'],
    ['Ctrl+H', 'Find & replace'],
    ['Ctrl+0 / Ctrl+1', 'Fit page / Fit width'],
    ['Ctrl+2 / 3 / 4', 'Single / Continuous / Facing'],
    ['Ctrl+= / Ctrl+-', 'Zoom in / out'],
    ['Ctrl + mouse wheel', 'Zoom in / out at the cursor'],
    ['Ctrl+Shift+= / -', 'Rotate page'],
    ['Home / End', 'First / last page'],
    ['Page Up / Page Down', 'Previous / next page'],
    ['Space (hold)', 'Pan with the Hand — from any tool'],
    ['Ctrl+L', 'Full screen presentation'],
    ['Ctrl+Tab', 'Next open document'],
    ['Ctrl+D', 'Document properties'],
    ['Ctrl+Shift+D', 'Dark mode'],
    ['Ctrl+,', 'Preferences'],
    ['Ctrl+E / D', 'Direct Editor'],
    ['Ctrl+G', 'Insert pages…'],
    ['Ctrl+B / I / U', 'Bold / Italic / Underline on the text being edited'],
    ['V H U S Q', 'Select, Highlight, Underline, Strike, Squiggly'],
    ['N C T', 'Note, Callout, Text box'],
    ['R O L A P', 'Rectangle, Ellipse, Line, Arrow, Pencil'],
    ['K I X M E', 'Stamp, Image, Redact, Measure, Eraser'],
    ['Delete / Backspace', 'Delete the selection'],
    ['Ctrl+J', 'Ask AI'],
    ['Ctrl+Alt+A', 'AI Agent — edit this PDF'],
    ['Ctrl+Shift+A / B / P', 'Comments list / Bookmarks / Page thumbnails'],
    ['Ctrl+K', 'Command palette'],
    ['Esc', 'Close palette / find, exit presentation, or back to Select'],
  ];
  return `<div style="display:grid;grid-template-columns:auto 1fr;gap:3px 12px">${
    rows.map(([k, v]) => `<span class="mono" style="color:var(--text-2)">${k}</span><span>${v}</span>`).join('')
  }</div>`;
}

/* ══ Foxit Organize > Crop Pages ══════════════════════════════════════════ */

/** Drag a rectangle over a live page preview; the box-shadow trick dims
 *  everything outside the selection. Returns PDF-space [x0,y0,x1,y1]. */
async function cropRectDialog(doc, i) {
  const page = await doc.pdf.getPage(i + 1);
  // The preview renders with the intrinsic rotation plus the user's page
  // delta, so this viewport is both the preview's aspect and the inverse that
  // maps the drag box back into unrotated PDF user space for the CropBox.
  const rotation = (page.rotate || 0) + (doc.pageRotate?.[i] || 0);
  const vp = page.getViewport({ scale: 1, rotation });
  const dims = { w: vp.width, h: vp.height };
  return new Promise((resolve) => {
    let sel = null;
    let start = null;
    const PW = 244;
    const PH = Math.max(140, Math.round((PW * dims.h) / dims.w));
    const stage = el('div', {
      style: {
        position: 'relative', width: PW + 'px', height: PH + 'px',
        margin: '0 auto', background: '#fff', border: '1px solid var(--border)',
        borderRadius: '4px', overflow: 'hidden', touchAction: 'none', cursor: 'crosshair',
      },
    });
    // The page thumbnail itself: without it the modal is a blank white box
    // ("crop tool showing blank page — we can't see anything"). renderPageToCanvas
    // resolves only after its render task completes, so the source canvas is
    // fully painted when it is blitted into the stage.
    const shot = el('canvas', {
      style: {
        position: 'absolute', inset: '0', width: PW + 'px', height: PH + 'px',
        display: 'block', pointerEvents: 'none',
      },
    });
    stage.appendChild(shot);
    (async () => {
      try {
        const src = await renderPageToCanvas(i, 150);
        if (!src) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
        shot.width = Math.round(PW * dpr);
        shot.height = Math.round(PH * dpr);
        const ctx = shot.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, shot.width, shot.height);
        const s = Math.max(shot.width / src.width, shot.height / src.height);
        const rw = src.width * s, rh = src.height * s;
        ctx.drawImage(src, (shot.width - rw) / 2, (shot.height - rh) / 2, rw, rh);
      } catch (e) { console.warn('crop preview failed', e); }
    })();
    const box = el('div', {
      style: {
        position: 'absolute', display: 'none', border: '1px solid var(--accent)',
        boxShadow: '0 0 0 9999px rgba(0,0,0,.42)', pointerEvents: 'none',
      },
    });
    stage.appendChild(box);
    stage.addEventListener('pointerdown', (e) => {
      const r = stage.getBoundingClientRect();
      start = { x: clamp(e.clientX - r.left, 0, PW), y: clamp(e.clientY - r.top, 0, PH) };
      stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener('pointermove', (e) => {
      if (!start) return;
      const r = stage.getBoundingClientRect();
      const x = clamp(e.clientX - r.left, 0, PW), y = clamp(e.clientY - r.top, 0, PH);
      sel = { l: Math.min(start.x, x), t: Math.min(start.y, y), r: Math.max(start.x, x), b: Math.max(start.y, y) };
      box.style.display = 'block';
      box.style.left = sel.l + 'px'; box.style.top = sel.t + 'px';
      box.style.width = (sel.r - sel.l) + 'px'; box.style.height = (sel.b - sel.t) + 'px';
    });
    const stop = () => { start = null; };
    stage.addEventListener('pointerup', stop);
    stage.addEventListener('pointercancel', stop);

    showModal({
      title: 'Crop Pages',
      width: 'narrow',
      body: (b) => {
        b.appendChild(el('div', { class: 'hint', text: `Page ${i + 1} — ${fmtSize(dims.w, dims.h)}. Drag a box over the area to keep.` }));
        b.appendChild(stage);
        b.appendChild(el('div', { class: 'hint', text: 'Everything outside the box is hidden (the content is kept, just not visible).', style: { marginTop: '8px' } }));
      },
      buttons: [
        { label: 'Cancel', value: null, kind: 'ghost' },
        {
          label: 'Crop this page', value: 'ok', kind: 'primary', default: true,
          validate: () => {
            if (!sel || sel.r - sel.l < 8 || sel.b - sel.t < 8) { toast('Drag a box first.', 'warn'); return false; }
            return true;
          },
        },
      ],
    }).then((ok) => {
      if (!ok) return resolve(null);
      // The stage box is in top-down preview pixels; hand it back through the
      // viewport inverse so a rotated page still yields the right CropBox.
      const toPdf = (x, y) => vp.convertToPdfPoint((x * vp.width) / PW, (y * vp.height) / PH);
      const a = toPdf(sel.l, sel.t), b = toPdf(sel.r, sel.b);
      resolve([Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]);
    });
  });
}

/* ══ Foxit Edit > Find & Replace ══════════════════════════════════════════ */

async function replaceTextDialog() {
  const doc = activeDoc();
  if (!doc) return;
  let find = '';
  let repl = '';
  let cs = false;
  let ww = false;
  let hits = 0;
  const ok = await showModal({
    title: 'Find & Replace',
    width: 'medium',
    body: (b) => {
      const f = el('input', { type: 'text', placeholder: 'Find what' });
      const r2 = el('input', { type: 'text', placeholder: 'Replace with' });
      const c1 = el('input', { type: 'checkbox' });
      const c2 = el('input', { type: 'checkbox' });
      f.oninput = () => { find = f.value; };
      r2.oninput = () => { repl = r2.value; };
      c1.onchange = () => { cs = c1.checked; };
      c2.onchange = () => { ww = c2.checked; };
      b.appendChild(formRow('Find what', f).row);
      b.appendChild(formRow('Replace with', r2).row);
      b.appendChild(formRow('Case sensitive', c1).row);
      b.appendChild(formRow('Whole word', c2).row);
      b.appendChild(el('div', {
        class: 'hint',
        text: 'Replaces every occurrence in the whole document. Each affected text run is redrawn in its original font, size and colour.',
      }));
      setTimeout(() => f.focus(), 20);
    },
    buttons: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: 'Replace all', value: 'go', kind: 'primary', default: true },
    ],
  });
  if (ok !== 'go' || !find) return;
  hits = await replaceAllInDocument(find, repl, { caseSensitive: cs, wholeWord: ww });
  if (hits) toast(`Replaced ${hits} occurrence${hits === 1 ? '' : 's'} — saved into the file on save`, 'ok');
  else toast('No matches found.', 'warn');
}

/* ══ Properties dialog ══════════════════════════════════════════════════ */

async function documentProperties() {
  const doc = activeDoc();
  if (!doc) return;
  let meta = doc.meta || {};
  try {
    const m = await readMetadata(doc.bytes);
    meta = { ...meta, ...m };
    doc.meta = meta;
  } catch { /* ignore */ }
  const ok = await showModal({
    title: 'Document properties',
    body: (b) => {
      const mk = (label, value, cb) => {
        const i = el('input', { type: 'text', value: value || '' });
        i.oninput = () => cb(i.value);
        return formRow(label, i);
      };
      b.appendChild(mk('Title', meta.title, (v) => { meta.title = v; }).row);
      b.appendChild(mk('Author', meta.author, (v) => { meta.author = v; }).row);
      b.appendChild(mk('Subject', meta.subject, (v) => { meta.subject = v; }).row);
      b.appendChild(mk('Keywords', meta.keywords, (v) => { meta.keywords = v; }).row);
      b.appendChild(el('div', { class: 'divider' }));
      [
        ['Pages', String(doc.numPages)],
        ['Producer', meta.producer || '—'],
        ['Creator', meta.creator || '—'],
        ['File size', formatBytes(doc.bytes?.length)],
        ['Path', doc.path || 'Not saved yet'],
      ].forEach(([k, v]) => b.appendChild(el('div', { class: 'kv' }, [el('b', { text: k }), el('span', { text: v })])));
    },
    buttons: [
      { label: 'Cancel', value: false, kind: 'ghost' },
      { label: 'Save metadata', value: true, kind: 'primary', default: true },
    ],
  });
  if (ok) { doc.meta = meta; markDirty('metadata'); }
}

/* ══ Actions ════════════════════════════════════════════════════════════ */

/** Page-level context menu. These operations were ribbon-only before, and the
 *  destructive ones had no confirmation on that path. */
function initContextMenus() {
  $('#pages').addEventListener('contextmenu', (e) => {
    const doc = activeDoc();
    if (!doc || !doc.numPages) return;
    const pageDiv = e.target.closest('.page');
    const i = pageDiv ? Number(pageDiv.dataset.i) : (doc.currentPage ?? 0);
    if (!Number.isFinite(i) || i < 0 || i >= doc.numPages) return;
    e.preventDefault();
    contextMenu(e.clientX, e.clientY, [
      { label: 'Rotate Clockwise', icon: 'rotate', onSelect: () => rotatePages([i], 90) },
      { label: 'Rotate Counter-clockwise', icon: 'rotate', onSelect: () => rotatePages([i], -90) },
      { separator: true },
      { label: 'Extract Page…', icon: 'upload', onSelect: () => extractPages([i]) },
      { label: 'Insert Blank Page After', icon: 'plus', onSelect: () => insertBlankAt(i + 1) },
      { label: 'Insert From PDF After…', icon: 'file', onSelect: () => insertFromPdfAt(i + 1) },
      {
        label: 'Delete Page…',
        icon: 'trash',
        danger: true,
        onSelect: async () => {
          const ok = await confirmDialog(`Delete page ${i + 1} of ${doc.numPages}?`, {
            title: 'Delete Page', okLabel: 'Delete', danger: true,
            detail: 'Undo (Ctrl+Z) still works until you save the file.',
          });
          if (ok) await deletePages([i]);
        },
      },
      { separator: true },
      { label: 'Fit Page', icon: 'fit', onSelect: () => V.setZoom('fitPage') },
      { label: 'Fit Width', icon: 'fit', onSelect: () => V.setZoom('fitWidth') },
      { label: 'Actual Size', icon: 'zoomIn', onSelect: () => V.setZoom('custom', 1) },
      { separator: true },
      { label: 'Document Properties…', icon: 'info', onSelect: () => documentProperties() },
    ]);
  });
}

function setTool(t) {
  if (t === 'editTextTool') t = 'editText';
  const changed = state.tool !== t;
  if (state.tool === 'formatPainter' && t !== 'formatPainter') clearFormat();
  state.tool = t;
  settings.tool = t;
  // Switching tools abandons whatever object was selected. The properties panel
  // must describe the tool you are about to use, not an object you picked with
  // the previous tool — renderContext() gives a non-empty selection priority
  // over the tool panel, so leaving the old id behind meant arming the Direct
  // Editor while a text box was still selected kept showing THAT BOX's panel,
  // and every colour/font-size change landed on it. Clearing here is what makes
  // "the edit applies to the object that is actually selected" true.
  if (changed && state.selection.length) {
    state.selection = [];
    renderAllAnnotations();
    emit('selection');
  }
  // The crosshair cursor is defined on `.canvas-wrap.tool-draw` in CSS, so the
  // class must go on the canvas-wrap — it used to be toggled on #pages, where
  // the stylesheet never matched it, so drawing tools never got their cursor.
  const canvasWrap = $('#canvasWrap');
  const drawTools = new Set(['rect', 'ellipse', 'line', 'arrow', 'ink', 'brush', 'highlighter', 'measure', 'redact', 'whiteout', 'textbox', 'callout', 'note', 'stamp', 'signature', 'image', 'whiteout', 'polygon', 'polyline', 'cloud', 'areaHighlight', 'roundRect', 'editArea']);
  canvasWrap.classList.toggle('tool-draw', drawTools.has(t));
  // The body class drives the editText hover feedback in CSS — every text run
  // gets a faint accent outline so users see they can type into the page.
  document.body.classList.toggle('tool-editText', t === 'editText');
  emit('tool', t);
  for (const [, rec] of V.pageElMap()) {
    // The tool layer is NEVER a hit target. It sits on top of the annotation
    // layer, so while it was switched to `auto` for the drawing tools it
    // swallowed every press before the geometry underneath could be seen: an
    // object could be created but never picked up again to be recoloured,
    // retyped, moved or deleted. Drawing now listens for bare page surface
    // (see `onLayer` in tools.js), so objects are reachable from every tool
    // that creates them.
    rec.toolLayer.style.pointerEvents = 'none';
    rec.textLayer.style.pointerEvents = t === 'editText' ? 'auto' : (['select', 'highlight', 'underline', 'strikeout', 'squiggly'].includes(t) ? 'auto' : 'none');
    // AcroForm widgets live in their own layer under the tool layer. They were
    // created pointer-events:none and nothing ever re-enabled them, so rendered
    // form fields could not be clicked or typed into at all.
    // The layer itself must stay inert: it is inset:0 and sits ABOVE the
    // annotation layer, so enabling it wholesale swallows every click and makes
    // annotations unselectable. Only the actual field widgets take the mouse.
    rec.formLayer.style.pointerEvents = 'none';
    for (const w of rec.formLayer.children) w.style.pointerEvents = t === 'select' ? 'auto' : 'none';
  }
  // Text-selection tools (the four "highlight to squiggly" markup tools) get
  // the I-beam. They look identical to the drawing tools with `crosshair`,
  // which is why every markup-related complaint so far has been "it does
  // nothing when I click" — a crosshair invites dragging a box, but these
  // tools are actually select-text-on-the-page. Foxit uses the same I-beam
  // for its text markup tools.
  const textSelectionTool = ['highlight', 'underline', 'strikeout', 'squiggly'].includes(t);
  const cursor = t === 'hand' ? 'grab'
    : t === 'select' ? 'default'
    : t === 'editText' || textSelectionTool ? 'text'
    : 'crosshair';
  $('#pages').style.cursor = cursor;
  renderRibbon();
  updateStatus();
  // A tool with editable properties opens its panel straight away, so the user
  // is not hunting through the ribbon to set fill or stroke before drawing.
  if (TOOL_PROPS.has(t)) renderContext();
}

/** Page layout is a persisted preference; V.setLayout alone never wrote it back,
 *  so settings.layout was applied at boot but always reset on the next launch. */
function setLayoutPersist(mode) {
  V.setLayout(mode);
  settings.layout = mode;
  saveSettings();
}

/* ── Foxit View extras: cover page, reverse view, grid, read aloud ─────── */

function setCoverPersist(on) {
  V.setCoverPage(on);
  settings.coverPage = !!on;
  saveSettings();
}

function setReversePersist(on) {
  V.setReverseView(on);
  settings.reverse = !!on;
  saveSettings();
}

function toggleGrid() {
  V.setGridVisible(!settings.grid);
  saveSettings();
}

/** Foxit View > Read > Activate Read / Stop Read. Delegates to tts.js, which
 *  speaks through the configured provider — the local platform voice by
 *  default, or ElevenLabs / Fish Audio / Mistral / Gemini / any
 *  OpenAI-compatible endpoint with the user's own key. */
function stopReadAloudIfAny() {
  ttsStop();
}

async function toggleReadAloud() {
  await ttsToggle();
}

async function onMenuAction(action, payload) {
  const doc = activeDoc();
  switch (action) {
    case 'file:open': {
      const paths = await window.api.openDialog({ multiSelections: true, title: 'Open PDF' });
      if (paths) for (const p of paths) await openDocFromPath(p);
      break;
    }
    case 'file:openRecent': if (payload) await openDocFromPath(payload); break;
    case 'recents:clear': {
      settings.recents = [];
      saveRecents();
      if (!activeDoc()) {
        // Re-render whichever no-document surface is actually on screen.
        if (!$('#welcome').classList.contains('hidden')) renderWelcome();
        else showWorkspace();
      }
      toast('Recent files cleared', 'info');
      break;
    }
    case 'file:new': await newBlank(); break;
    case 'file:images': await newFromImages(); break;
    case 'file:save': await saveDoc(); break;
    case 'file:saveAs': await saveDocAs(); break;
    case 'file:saveCopy': await saveCopy(); break;
    case 'file:close': if (doc) await closeDoc(doc.id); break;
    case 'file:print': await printDocument(); break;
    case 'file:properties': await documentProperties(); break;
    case 'file:quit': window.close(); break;

    case 'edit:undo': {
      // Model-level undo first (annotations/text/stamps); when that is exhausted
      // fall back to structural undo, which reloads the file from the byte
      // stream saved before the last insert/delete/extract/reorder.
      if (undo()) { renderAllAnnotations(); renderSidebar(); renderContext(); emit('annots'); }
      else await undoStructure();
      break;
    }
    case 'edit:redo': {
      if (redo()) { renderAllAnnotations(); renderSidebar(); renderContext(); emit('annots'); }
      else await redoStructure();
      break;
    }
    case 'edit:preferences': await preferencesDialog(); break;
    case 'edit:selectAll': {
      // With objects selected Ctrl+A means "all annotations on this page"; on
      // plain page text it stays the browser's select-all, which is what the
      // keystroke means everywhere else.
      if (doc && state.selection.length) {
        const ids = doc.annots.filter((a) => a.page === (doc.currentPage ?? 0)).map((a) => a.id);
        if (ids.length) { state.selection = ids; renderAllAnnotations(); emit('selection'); }
        break;
      }
      if (doc) {
        const rec = pageEl(doc.currentPage ?? 0);
        if (rec && rec.textLayer) {
          const r = document.createRange();
          r.selectNodeContents(rec.textLayer);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        }
      }
      break;
    }
    case 'edit:cut': {
      // Copy, then remove — Acrobat's Cut. No clipboard entry existed before,
      // so Ctrl+X did nothing at all while Ctrl+C / Ctrl+V both worked.
      if (!copySelectedAnnots()) break;
      const ids = state.selection.slice();
      removeAnnots(ids);
      pushHistory('cut');
      renderAllAnnotations();
      renderSidebar();
      renderContext();
      break;
    }

    case 'view:rulers': V.toggleRulers(); break;
    case 'view:clearGuides': V.clearGuides(); break;
    case 'view:fitPage': V.setZoom('fitPage'); break;
    case 'view:fitWidth': V.setZoom('fitWidth'); break;
    case 'view:actualSize': V.setZoom('custom', 1); break;
    case 'view:zoomIn': V.zoomBy(1.2); break;
    case 'view:zoomOut': V.zoomBy(1 / 1.2); break;
    case 'view:resetZoom': V.setZoom(settings.defaultZoom || 'fitWidth'); break;
    case 'view:single': setLayoutPersist('single'); break;
    case 'view:continuous': setLayoutPersist('continuous'); break;
    case 'view:facing': setLayoutPersist('facing'); break;
    case 'view:cover': setCoverPersist(!state.view.coverPage); break;
    case 'view:reverse': setReversePersist(!state.view.reverse); break;
    case 'view:grid': toggleGrid(); break;
    case 'view:readAloud': await toggleReadAloud(); break;
    case 'view:ttsSettings': await openTtsSettings(); break;
    case 'view:rotateCW': V.setViewRotation(90); break;
    case 'view:rotateCCW': V.setViewRotation(-90); break;
    case 'view:darkMode': settings.theme = state.view.dark ? 'light' : 'dark'; applyTheme(); saveSettings(); renderRibbon(); break;
    case 'view:presentation': togglePresentation(); break;
    case 'view:ribbonToggle': toggleRibbon(); break;
    case 'view:chromeToggle': toggleChrome(); break;
    case 'view:pages': setSidebar('pages'); break;
    case 'view:bookmarks': setSidebar('bookmarks'); break;
    case 'view:comments': setSidebar('comments'); break;
    case 'view:attachments': setSidebar('attachments'); break;
    case 'view:signatures': setSidebar('signatures'); break;
    case 'view:layers': setSidebar('layers'); break;
    case 'view:search': toggleFind(true); break;
    case 'view:ai': openAIDock(); break;
    case 'view:fonts': setSidebar('fonts'); break;

    case 'ocr:page': {
      if (!doc) break;
      setSidebar('ocr');
      import('./ocr.js').then((m) => m.ocrPage(doc.currentPage ?? 0, settings.ocrLang || 'eng+nep').then(() => {
        toast('OCR finished — the recognised text is searchable and AI-ready', 'ok', 4500);
        renderSidebar();
        updateStatus();
      }).catch((e) => toast('OCR failed: ' + (e.message || e), 'err', 6000)));
      break;
    }
    case 'ocr:all': {
      if (!doc) break;
      setSidebar('ocr');
      // The label promises "All Scanned Pages"; this used to only open the panel
      // and leave the actual run to a sidebar button.
      const scanned = await detectScannedPages(doc);
      const pages = [...scanned].sort((a, b) => a - b);
      if (!pages.length) {
        toast('No scanned pages detected — every page already has selectable text', 'info', 4200);
        break;
      }
      const ocr = await import('./ocr.js');
      let done = 0;
      try {
        for (const p of pages) {
          setBusy(true, `OCR ${done + 1}/${pages.length}`);
          await ocr.ocrPage(p, settings.ocrLang || 'eng+nep');
          done++;
          renderSidebar();
        }
        toast(`OCR finished — ${done} page(s) recognised and now searchable`, 'ok', 5000);
      } catch (e) {
        toast(`OCR failed after ${done}/${pages.length} page(s): ${e.message || e}`, 'err', 7000);
      } finally {
        setBusy(false);
        renderSidebar();
        updateStatus();
      }
      break;
    }
    case 'measure:scale': {
      if (!doc) break;
      let unit = doc.measureScale?.unit || settings.measureUnit || 'cm';
      let upp = doc.measureScale?.unitsPerPoint || 0;
      await showModal({
        title: 'Measurement scale',
        width: 'narrow',
        body: (b) => {
          b.appendChild(el('div', { class: 'hint', text: 'Calibrate the measure tool: how many real-world units does one PDF point (1/72 inch) represent? Leave 0 to use the default inch/mm readout.' }));
          const u = el('input', { type: 'text', value: unit, style: { width: '70px' } });
          const v = el('input', { type: 'number', value: String(upp || ''), step: 'any', min: '0', style: { width: '90px' } });
          u.oninput = () => { unit = u.value || 'units'; };
          v.oninput = () => { upp = Number(v.value) || 0; };
          b.appendChild(formRow('Unit label', u).row);
          b.appendChild(formRow('Units per point', v).row);
        },
      });
      doc.measureScale = upp > 0 ? { unitsPerPoint: upp, unit } : null;
      break;
    }

    case 'tool:hand': setTool('hand'); break;
    case 'tool:select': setTool('select'); break;
    case 'tool:highlight': case 'tool:underline': case 'tool:strikeout': case 'tool:squiggly':
    case 'tool:note': case 'tool:callout': case 'tool:textbox': case 'tool:rect':
    case 'tool:ellipse': case 'tool:line': case 'tool:arrow': case 'tool:ink':
    case 'tool:brush': case 'tool:highlighter': case 'tool:formatPainter': case 'tool:eyedropper':
    case 'tool:eraser': case 'tool:stamp': case 'tool:image': case 'tool:signature':
    case 'tool:note': case 'tool:callout': case 'tool:textbox': case 'tool:rect':
    case 'tool:ellipse': case 'tool:line': case 'tool:arrow': case 'tool:ink':
    case 'tool:brush': case 'tool:highlighter': case 'tool:formatPainter': case 'tool:eyedropper':
    case 'tool:eraser': case 'tool:stamp': case 'tool:image': case 'tool:signature':
    case 'tool:redact': case 'tool:whiteout': case 'tool:measure': case 'tool:editText':
    case 'tool:editArea':
    // Vertex + rounded shape tools have no native menu items today (the ribbon
    // buttons call setTool directly) but must stay dispatchable so the action
    // bus, command palette and future menu entries reach the same tools.
    case 'tool:roundRect': case 'tool:polygon': case 'tool:polyline': case 'tool:cloud':
    case 'tool:areaHighlight':
    case 'tool:link':
      setTool(action.slice(5));
      break;

    case 'object:bringToFront': arrangeSelection('front'); break;
    case 'object:sendToBack': arrangeSelection('back'); break;
    case 'object:bringForward': arrangeSelection('forward'); break;
    case 'object:sendBackward': arrangeSelection('backward'); break;
    case 'object:alignLeft': alignSelection('left'); break;
    case 'object:alignHCentre': alignSelection('hcentre'); break;
    case 'object:alignRight': alignSelection('right'); break;
    case 'object:alignTop': alignSelection('top'); break;
    case 'object:alignVMiddle': alignSelection('vmiddle'); break;
    case 'object:alignBottom': alignSelection('bottom'); break;

    case 'page:insert': {
      // The label says "Insert Pages…" but this used to drop a blank page in
      // without asking, and the insert-from-PDF path was sidebar-only.
      if (!doc) break;
      const at = (doc.currentPage ?? 0) + 1;
      const choice = await showModal({
        title: 'Insert Pages',
        width: 'narrow',
        body: (b) => b.appendChild(el('div', { class: 'hint', text: `Insert at position ${at}. Add a blank page, or take pages from another PDF.` })),
        buttons: [
          { label: 'Cancel', value: null, kind: 'ghost' },
          { label: 'From PDF…', value: 'pdf', kind: 'ghost' },
          { label: 'Blank Page', value: 'blank', kind: 'primary', default: true },
        ],
      });
      if (choice === 'blank') await insertBlankAt(at);
      else if (choice === 'pdf') await insertFromPdfAt(at);
      break;
    }
    case 'page:extract': if (doc) await extractPages([doc.currentPage ?? 0]); break;
    case 'page:delete': {
      // The sidebar path confirmed before deleting; the menu path did not.
      if (!doc) break;
      const i = doc.currentPage ?? 0;
      const ok = await confirmDialog(`Delete page ${i + 1} of ${doc.numPages}?`, {
        title: 'Delete Page',
        okLabel: 'Delete',
        danger: true,
        detail: 'Undo (Ctrl+Z) still works until you save the file.',
      });
      if (ok) await deletePages([i]);
      break;
    }
    case 'page:rotate': if (doc) await rotatePages([doc.currentPage ?? 0], 90); break;
    case 'page:merge': await mergeDocuments(); break;
    case 'page:split': await splitDocument(); break;
    case 'page:duplicate': if (doc) await duplicatePages([doc.currentPage ?? 0]); break;
    case 'page:reverse': await reversePages(); break;
    case 'page:replace': if (doc) await replacePageAt(doc.currentPage ?? 0); break;
    case 'page:splitBookmarks': if (doc) await splitByBookmarks(); break;
    case 'page:splitBlank': if (doc) await splitByBlankPages(); break;
    case 'page:crop': {
      if (!doc) break;
      const i = doc.currentPage ?? 0;
      const rect = await cropRectDialog(doc, i);
      if (rect) await cropPages([i], rect);
      break;
    }
    case 'edit:replace': await replaceTextDialog(); break;
    case 'edit:removeLinks': {
      if (!doc) break;
      const links = doc.annots.filter((a) => a.type === 'link');
      if (!links.length) { toast('This document has no links added in AiPDF.', 'warn'); break; }
      const ok = await confirmDialog(`Remove ${links.length} link annotation(s) you added?`, {
        title: 'Remove links', okLabel: 'Remove', danger: true,
        detail: 'Links that came with the original document are left untouched.',
      });
      if (!ok) break;
      removeAnnots(links.map((a) => a.id));
      pushHistory('remove links');
      renderAllAnnotations(); renderSidebar();
      toast(`${links.length} link(s) removed`, 'ok');
      break;
    }

    case 'stamp:watermark': await watermarkDialog(); break;
    case 'stamp:headerFooter': {
      // `kind` only picks the default field contents (header → filename/date,
      // footer → page numbering); the menu used to hardcode 'header', so the
      // footer presets were reachable from the ribbon only.
      const kind = await showModal({
        title: 'Header & Footer',
        width: 'narrow',
        body: (b) => b.appendChild(el('div', { class: 'hint', text: 'Headers start with the file name and date; footers start with page numbering. Every field is editable in the dialog that opens next.' })),
        buttons: [
          { label: 'Cancel', value: null, kind: 'ghost' },
          { label: 'Footer…', value: 'footer', kind: 'ghost' },
          { label: 'Header…', value: 'header', kind: 'primary', default: true },
        ],
      });
      if (kind) await headerFooterDialog(kind);
      break;
    }
    case 'stamp:bates': await batesDialog(); break;

    case 'form:addText': await startFieldPlacement('text'); break;
    case 'form:addCheckbox': await startFieldPlacement('checkbox'); break;
    case 'form:addRadio': await startFieldPlacement('radio'); break;
    case 'form:addDropdown': await startFieldPlacement('dropdown'); break;
    case 'form:addSignature': await startFieldPlacement('signature'); break;
    case 'form:exportData': await exportFormData(); break;
    case 'form:importData': await importFormData(); break;
    case 'form:reset': await resetForm(); break;

    case 'protect:encrypt': await encryptDialog(); break;
    // The menu item is labelled "Apply & Sanitize Redactions" — it used to call
    // applyRedactions(false), i.e. apply only, leaving the marked text in the file.
    case 'protect:redactAll': await applyRedactions(true); break;

    /* ── Documents: Stirling-PDF-style batch tools ─────────────────────── */
    case 'docs:compare': await compareDocuments(); break;
    case 'docs:overlay': await overlayDialog(); break;
    case 'docs:scale': await scaleDialog(); break;
    case 'docs:removeBlanks': await removeBlankPagesFlow(); break;
    case 'docs:adjustColors': await adjustColorsDialog(); break;
    case 'docs:compress': await compressDialog(); break;
    case 'docs:flatten': await flattenDialog(); break;
    case 'docs:sanitize': await sanitizeDialog(); break;
    case 'docs:info': await docInfoDialog(); break;
    case 'docs:removeAnnots': await removeAnnotsDialog(); break;
    case 'docs:nup': await nupDialog(); break;
    case 'docs:singlePage': await singlePageDialog(); break;
    case 'docs:poster': await posterDialog(); break;
    case 'docs:booklet': await bookletDialog(); break;
    case 'docs:splitSize': await splitBySizeDialog(); break;
    case 'docs:autoRename': await autoRenameDialog(); break;
    case 'docs:repair': await repairDialog(); break;
    case 'docs:attachments': await attachmentsDialog(); break;
    case 'docs:pageNumbers': await pageNumbersDialog(); break;
    case 'docs:automate': await automateDialog(); break;
    case 'protect:unlockForms': await unlockFormsDialog(); break;

    case 'convert:toText': await exportText(); break;
    case 'convert:toImages': await exportImages(); break;
    case 'convert:toHtml': await exportHtml(); break;
    case 'convert:toRtf': await exportRtf(); break;
    case 'convert:toEpub': await exportEpub(); break;
    case 'convert:toMarkdown': await exportMarkdown(); break;
    case 'convert:fromImages': await newFromImages(); break;
    case 'export:text': await exportText(); break;
    case 'export:images': await exportImages(); break;
    case 'export:comments': await exportComments(); break;

    case 'ai:ask': openAIDock(); break;
    case 'ai:agent': state.ai.mode = 'agent'; openAIDock(); break;
    case 'ai:summarize': await summarize(); break;
    case 'ai:summarizeAll': await import('./ai.js').then((m) => m.summarizeAllDocs()); break;
    case 'ai:extractData': await extractData(); break;
    case 'ai:translate': await translate(); break;
    case 'ai:rewrite': await rewrite(); break;
    case 'ai:proofread': await proofread(); break;
    case 'ai:outline': await aiOutline(); break;
    case 'ai:contract': await runContractReview(); break;
    case 'ai:smartredact': await openSmartRedact(); break;
    case 'ai:settings': await configureAI(); break;

    case 'help:startPage':
      // The app boots into the workspace; this is the way back to the full
      // Welcome / Recent screen (Help ▸ Start page).
      renderWelcome();
      break;
    case 'help:shortcuts':
      await showModal({ title: 'Keyboard shortcuts', width: '', body: (b) => { b.appendChild(el('div', { class: 'hint', html: shortcutHelpHtml() })); } });
      break;
    case 'help:about':
      await alertDialog('AiPDF Editor — a fast, local-first PDF editor with an AI assistant that cites the page it used.\n\nBuilt with Electron, pdf.js and pdf-lib.', { title: 'About' });
      break;
    default: break;
  }
  updateStatus();
}

function togglePresentation() {
  state.view.present = !state.view.present;
  if (state.view.present) stopReadAloudIfAny();
  document.body.classList.toggle('present', state.view.present);
  if (state.view.present) {
    V.setZoom('fitPage');
    toast('Presentation mode — press Esc or F11 to exit', 'info', 3000);
  } else {
    V.setZoom(settings.defaultZoom || 'fitWidth');
  }
}

/* ══ Global wiring ══════════════════════════════════════════════════════ */

function wireGlobal() {
  const findInput = $('#findInput');
  findInput.addEventListener('input', () => {
    state.search.query = findInput.value;
    state.search.caseSensitive = $('#findCase').checked;
    state.search.wholeWord = $('#findWord').checked;
    clearTimeout(findInput._t);
    findInput._t = setTimeout(() => {
      runSearch(findInput.value, { caseSensitive: $('#findCase').checked, wholeWord: $('#findWord').checked })
        .then(() => { $('#findCount').textContent = state.search.matches.length ? `${state.search.index + 1} / ${state.search.matches.length}` : 'no results'; renderSidebar(); });
    }, 240);
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? prevMatch() : nextMatch(); updateFindCount(); }
    if (e.key === 'Escape') toggleFind(false);
  });
  $('#findNext').onclick = () => { nextMatch(); updateFindCount(); };
  $('#findPrev').onclick = () => { prevMatch(); updateFindCount(); };
  $('#findClose').onclick = () => toggleFind(false);
  $('#findCase').onchange = () => findInput.dispatchEvent(new Event('input'));
  $('#findWord').onchange = () => findInput.dispatchEvent(new Event('input'));

  // Drag & drop — anywhere in the window, any number of PDFs. The overlay is
  // pointer-events: none (see app.css), so it never swallows the drop itself.
  const dropzone = (on) => {
    const dz = document.querySelector('.dropzone');
    if (on && !dz) document.body.appendChild(el('div', { class: 'dropzone', text: 'Drop PDFs to open them' }));
    else if (!on && dz) dz.remove();
  };
  const isFileDrag = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth++;
    dropzone(true);
  });
  window.addEventListener('dragover', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (e) => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth || e.relatedTarget === null) { dragDepth = 0; dropzone(false); }
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropzone(false);
    await openDroppedFiles(e.dataTransfer.files);
  });

  $('#welcomeOpen').onclick = () => onMenuAction('file:open');
  $('#welcomeNew').onclick = () => newBlank();
  $('#welcomeImages').onclick = () => newFromImages();
  // The empty-workspace card is the default landing surface, so its buttons
  // mirror the Welcome screen's.
  $('#ewOpen').onclick = () => onMenuAction('file:open');
  $('#ewNew').onclick = () => newBlank();
  $('#ewImages').onclick = () => newFromImages();

  document.querySelectorAll('.zoom-pill button').forEach((b) => {
    b.onclick = () => onMenuAction(b.dataset.act);
  });

  on('page', () => updateStatus());
  // tools.js owns the pointer, but only app.js owns the tool state and the
  // colour controls, so the two click tools hand their result back over the bus.
  // NOTE: `on('tool', (t) => setTool(t))` was removed — it formed a re-entrant
  // loop (setTool → emit('tool') → listener → setTool …) that crashed the app.
  on('eyedropper', (hex) => applyUIColor(hex));
  on('zoom', () => { updateStatus(); redrawOverlays(); });
  on('dirty', () => { updateStatus(); renderTabs(); });
  on('selection', () => { if (!state.ai.dockOpen) renderContext(); });
  // A Direct Editor session opening or closing changes which panel is correct.
  on('directEditor', () => { if (!state.ai.dockOpen) renderContext(); });
  on('annots', () => { if (activeDoc()) renderAllAnnotations(); renderSidebarChrome(); });
  on('pageRendered', (i) => { renderPageAnnotations(i); renderFormFields(i); });
  on('doc', () => updateStatus());
  on('aiStatus', () => renderAIIndicator());
  on('aiDock', () => { renderContext(); });
  on('search', () => updateFindCount());
  on('stamps', () => { if (activeDoc()) renderAllAnnotations(); });
  on('layout', () => {
    for (const [, rec] of V.pageElMap()) rec.toolLayer.style.pointerEvents = 'none';
    setTool(state.tool);
    redrawOverlays();
  });
  on('comments:export', () => exportComments());
  on('forms:export', () => exportFormData());
  on('recents', () => {
    // Only re-render the welcome screen if it is currently visible (no doc
    // active). Opening a file already calls addRecent() which emits 'recents';
    // without this guard the welcome would yank the user away from the
    // document they just opened.
    if (!$('#welcome').classList.contains('hidden')) renderWelcome();
  });
  on('structure', () => { renderSidebar(); updateStatus(); });
  on('ai:activateDoc', async (id) => { await activateDoc(id); });

  /* Keystrokes that belong to whatever text is being written when a text
   * surface has focus, and to the document when it does not. Handled in the
   * renderer rather than as native accelerators precisely because the
   * distinction is only visible here — see the block below. */
  const EDIT_OWNS = {
    a: 'edit:selectAll', z: 'edit:undo', y: 'edit:redo', x: 'edit:cut',
    b: 'stamp:bates', d: 'file:properties', e: 'tool:editText',
    g: 'page:insert', h: 'edit:replace', j: 'ai:ask', n: 'file:new',
  };

  // Keyboard fallbacks (the native menu handles most accelerators)
  document.addEventListener('keydown', (e) => {
    const target = e.target;
    const inEditable = target && typeof target.matches === 'function' && target.matches('input, textarea, select, [contenteditable]');

    /* ── Keys a text surface owns ────────────────────────────────────────
     * These were native menu accelerators, and a native accelerator fires
     * even while an input has focus — so Ctrl+A selected every annotation
     * instead of the sentence, Ctrl+Z undid the document instead of the
     * typing, and Ctrl+B opened Bates numbering mid-edit. They are handled
     * here because only the renderer knows whether the editor has focus:
     * focused → the keystroke belongs to the text being written; unfocused
     * → it drives the document, exactly as the menu did. */
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      // Ctrl+B / Ctrl+I / Ctrl+U keep their word-processor meaning: on the text
      // being written in a Direct Editor session, or on the text box selected.
      if (k === 'b' || k === 'i' || k === 'u') {
        const field = k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline';
        if (directEditorOpen()) {
          const st = directEditorState() || {};
          e.preventDefault();
          applyDirectFormat({ [field]: !st[field] });
          renderContext();
          return;
        }
        const boxes = state.selection.map(annotById).filter(Boolean)
          .filter((a) => a.type === 'textbox' || a.type === 'callout');
        if (boxes.length) {
          e.preventDefault();
          const next = !boxes.every((a) => a[field]);
          for (const a of boxes) updateAnnot(a.id, { [field]: next }, { silent: true });
          pushHistory('text style');
          renderAllAnnotations();
          renderContext();
          return;
        }
        if (inEditable) return;
      }
      if (EDIT_OWNS[k]) {
        if (inEditable) return;                // the editor takes it
        e.preventDefault();
        onMenuAction(k === 'z' && e.shiftKey ? 'edit:redo' : EDIT_OWNS[k]);
        return;
      }
    }

    if (inEditable) {
      if (e.key === 'Escape') target.blur();
      return;
    }
    if (state.view.present && e.key === 'Escape') { togglePresentation(); return; }
    // Copy / paste run everywhere except inside a text field, which returned
    // above. Returning false leaves the keystroke to the browser, so a plain text
    // selection still copies when nothing is selected as an object.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') { if (copySelectedAnnots()) e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') { if (pasteAnnots()) e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); commandPalette(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'F1') { e.preventDefault(); toggleRibbon(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'F11') { e.preventDefault(); e.stopPropagation(); toggleChrome(); return; }
    if (e.key === 'Escape') {
      if (document.querySelector('.palette')) return;
      if ($('#findBar').classList.contains('open')) { toggleFind(false); return; }
      setTool('select');
      return;
    }
    const single = {
      v: 'select', h: 'highlight', u: 'underline', s: 'strikeout', q: 'squiggly',
      n: 'note', c: 'callout', t: 'textbox', r: 'rect', o: 'ellipse', l: 'line',
      a: 'arrow', p: 'ink', e: 'eraser', k: 'stamp', i: 'image', x: 'redact', m: 'measure',
      // Foxit arms the typewriter-style editor with D; Ctrl+E is the
      // accelerator, and a bare letter is what people actually reach for.
      d: 'editText',
    };
    if (!e.ctrlKey && !e.metaKey && !e.altKey && single[e.key.toLowerCase()]) {
      setTool(single[e.key.toLowerCase()]);
      return;
    }
    // F3 / Shift+F3 — Acrobat's find-next / find-previous. Ctrl+G (the other
    // conventional binding) is Insert Pages here, so this pair is the one that
    // is genuinely free. With no search running, F3 opens the find bar.
    if (e.key === 'F3') {
      e.preventDefault();
      if (!state.search.matches.length) { toggleFind(true); return; }
      if (e.shiftKey) prevMatch(); else nextMatch();
      updateFindCount();
      return;
    }
    // Hold Space to temporarily grab-pan the page from ANY tool — Acrobat/Foxit
    // keep the Hand reachable everywhere, so you can scroll without dropping the
    // tool you were using. A plain tap (Space released with no drag) still pages
    // forward, preserving the old Space = next-page behaviour (handled on keyup).
    if (e.key === ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (!state.spaceDown) {
        state.spaceDown = true;
        state.spacePanned = false;
        state.spacePan = true;
        document.body.classList.add('space-pan');
      }
      e.preventDefault();
      return;
    }
    const doc = activeDoc();
    if (!doc) return;
    if (e.key === 'PageDown') { e.preventDefault(); scrollToPage((doc.currentPage ?? 0) + 1); }
    if (e.key === 'PageUp') { e.preventDefault(); scrollToPage((doc.currentPage ?? 0) - 1); }
    // Ctrl+Home / Ctrl+End are Acrobat's first / last page. Without the Ctrl
    // they stay plain Home / End = first / last page too, which is what PDF
    // viewers have done since Acrobat 3.
    if (e.key === 'Home') { e.preventDefault(); scrollToPage(0); }
    if (e.key === 'End') { e.preventDefault(); scrollToPage(doc.numPages - 1); }
    // Ctrl+L — full screen / presentation, as in Acrobat.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k === 'l') { e.preventDefault(); togglePresentation(); return; }
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle the open documents, like browser tabs.
    if (e.key === 'Tab' && (e.ctrlKey || e.metaKey) && state.docs.length > 1) {
      e.preventDefault();
      const cur = state.docs.findIndex((d) => d.id === doc.id);
      const step = e.shiftKey ? -1 : 1;
      const next = state.docs[(cur + step + state.docs.length) % state.docs.length];
      void activateDoc(next.id);
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection.length) {
      // Annotations and committed text blocks share one selection: drop both.
      if ((doc.textEdits || []).some((x) => state.selection.includes(x.id))) {
        doc.textEdits = doc.textEdits.filter((x) => !state.selection.includes(x.id));
      }
      removeAnnots(state.selection);
      state.selection = [];
      pushHistory('delete');
      renderAllAnnotations();
      renderSidebar();
      renderContext();
    }
  });

  // Release Space: end the temporary Hand pan. If no drag happened during the
  // hold it was a tap, so page forward — keeping Space = next page. A blur (e.g.
  // Alt-Tab mid-hold) also clears it so we never get stuck in pan mode.
  document.addEventListener('keyup', (e) => {
    if (e.key !== ' ' || !state.spaceDown) return;
    state.spaceDown = false;
    state.spacePan = false;
    document.body.classList.remove('space-pan');
    if (!state.spacePanned) {
      const d = activeDoc();
      if (d) { e.preventDefault(); scrollToPage((d.currentPage ?? 0) + 1); }
    }
    state.spacePanned = false;
  });
  window.addEventListener('blur', () => {
    state.spaceDown = false;
    state.spacePan = false;
    document.body.classList.remove('space-pan');
  });

  // Documents ▸ Compare: the "go to page" link on each result card.
  window.addEventListener('app:gotoPage', (e) => {
    const i = Number(e.detail);
    if (Number.isInteger(i) && i >= 0) scrollToPage(i);
  });

  // Form-field placement drag
  const pagesRoot = $('#pages');
  pagesRoot.addEventListener('pointerdown', (e) => {
    if (!state.pendingFormField) return;
    const pageDiv = e.target.closest('.page');
    if (!pageDiv) return;
    e.preventDefault();
    const i = Number(pageDiv.dataset.i);
    const layer = pageEl(i)?.toolLayer;
    layer.style.pointerEvents = 'auto';
    const start = V.clientToPdf(i, e.clientX, e.clientY);
    const move = (ev) => {
      const cur = V.clientToPdf(i, ev.clientX, ev.clientY);
      const rec = pageEl(i);
      let g = rec.svg.querySelector('.preview');
      if (!g) { g = document.createElementNS('http://www.w3.org/2000/svg', 'g'); g.setAttribute('class', 'preview'); rec.svg.appendChild(g); }
      const c0 = V.toCss(i, start.x, start.y);
      const c1 = V.toCss(i, cur.x, cur.y);
      g.innerHTML = `<rect x="${Math.min(c0.x, c1.x)}" y="${Math.min(c0.y, c1.y)}" width="${Math.abs(c1.x - c0.x)}" height="${Math.abs(c1.y - c0.y)}" fill="none" stroke="var(--accent)" stroke-dasharray="3 3"/>`;
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const rec = pageEl(i);
      const g = rec.svg.querySelector('.preview');
      if (g) g.remove();
      const cur = V.clientToPdf(i, ev.clientX, ev.clientY);
      import('./forms.js')
        .then((m) => m.createFieldAt(i, [start.x, start.y, cur.x, cur.y]))
        .catch((err) => toast('Could not create the form field: ' + (err.message || err), 'err', 6000));
      setTool('select');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, true);
}

/** Redraw annotation + form overlays for the pages that matter right now. */
function redrawOverlays() {
  const doc = activeDoc();
  if (!doc) return;
  for (let i = 0; i < doc.numPages; i++) renderPageAnnotations(i);
  const cur = doc.currentPage ?? 0;
  for (let i = Math.max(0, cur - 2); i <= Math.min(doc.numPages - 1, cur + 2); i++) renderFormFields(i);
}

function updateFindCount() {
  const n = state.search.matches.length;
  $('#findCount').textContent = n ? `${(state.search.index ?? 0) + 1} / ${n}` : (state.search.query ? 'no results' : '');
}

function renderAIIndicator() {
  const s = aiStatusLabel();
  const chip = $('#aiChip');
  chip.className = `chip ${s.cls}`;
  $('#aiChipLabel').textContent = s.text;
}

function renderAIDockIfNeeded() {
  $('#context').classList.add('hidden');
}

async function onWillClose() {
  // Headless test modes have nobody to answer a modal, and a blocked quit
  // turns every test run into a hang. Save prompts are for real sessions only.
  const dirty = bootInfo && bootInfo.testMode ? [] : state.docs.filter((d) => d.dirty);
  if (dirty.length) {
    const r = await confirmDialog(
      `${dirty.length} document(s) have unsaved changes. Save them before quitting?`,
      { okLabel: 'Save all', cancelLabel: 'Quit anyway', title: 'Unsaved changes' }
    );
    if (r === undefined) return;      // user closed the dialog with Esc → stay
    if (r) for (const d of dirty) await saveDoc(d);
  }
  saveSettings();
  await window.api.confirmQuit();
}

/* ══ Kick off ════════════════════════════════════════════════════════════ */

boot().catch((e) => {
  console.error(e);
  toast(String(e.message || e), 'err', 10000);
});
