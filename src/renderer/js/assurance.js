/**
 * assurance.js — Document Assurance surface.
 *
 * Wires the offline forensics engine into the editor:
 *   - Security Inspector    (Foxit "PDF Action Inspector" class of feature)
 *   - Accessibility Checker (PDF/UA + WCAG, Adobe Auto-Tag's offline cousin)
 *   - Trust Center          (verifiable local-first posture + audit ledger)
 *   - Assurance rail panel  (always-on risk score + one-click actions)
 *
 * Everything here runs on the local byte stream. Nothing is uploaded.
 * The only dynamic import of app.js happens inside an action handler, after
 * boot, so there is no circular-dependency hazard at module evaluation.
 */

import { activeDoc, settings } from './store.js';
import { $, el, toast } from './util.js';
import { svgIcon } from './icons.js';
import { showModal, confirmDialog, promptDialog } from './dialog.js';
import { renderSidebar } from './sidebar.js';
import { reloadDocFromBytes } from './pages.js';
import { inspectDocument, auditAccessibility, verdict } from './forensics.js';

const AUDIT_KEY = 'aipdf.assurance.audit.v1';
const AUDIT_CAP = 240;

/* ── Audit ledger (local only) ──────────────────────────────────────────── */

export function auditLog() {
  try {
    const v = JSON.parse(localStorage.getItem(AUDIT_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function logAudit(kind, detail = '') {
  const entry = { t: Date.now(), kind: String(kind), detail: String(detail).slice(0, 240), local: true };
  const list = [entry, ...auditLog()].slice(0, AUDIT_CAP);
  try { localStorage.setItem(AUDIT_KEY, JSON.stringify(list)); } catch { /* quota */ }
  window.dispatchEvent(new CustomEvent('aipdf:audit', { detail: entry }));
  return entry;
}

export function clearAudit() {
  try { localStorage.removeItem(AUDIT_KEY); } catch { /* ignore */ }
}

/* ── Precise catalog facts via the renderer's pdf-lib bundle ─────────────── */

/** Raw byte scans cannot see dictionaries inside compressed object streams.
 *  This reader gives the accessibility audit authoritative catalog values. */
export async function readStructure(bytes) {
  try {
    const PL = await import('/v/pdf-lib.js');
    const pdf = await PL.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const N = PL.PDFName.of;
    const ctx = pdf.context;
    const cat = pdf.catalog || ctx.lookup(ctx.trailerInfo.Root);
    const lookup = (ref) => { try { return ref ? ctx.lookup(ref) : null; } catch { return null; } };
    const markInfo = lookup(cat && cat.get && cat.get(N('MarkInfo')));
    const marked = markInfo && markInfo.get && markInfo.get(N('Marked'));
    const langRef = lookup(cat && cat.get && cat.get(N('Lang')));
    const vp = lookup(cat && cat.get && cat.get(N('ViewerPreferences')));
    const display = vp && vp.get && vp.get(N('DisplayDocTitle'));
    return {
      tagged: !!(markInfo && marked && String(marked).indexOf('false') === -1),
      structTreeRoot: !!(cat && cat.get && cat.get(N('StructTreeRoot'))),
      lang: langRef ? String(langRef).replace(/^\(|\)$/g, '').trim() : '',
      title: (() => { try { return pdf.getTitle() || ''; } catch { return ''; } })(),
      displayDocTitle: !!(display && String(display).indexOf('false') === -1),
      pageCount: (() => { try { return pdf.getPageCount(); } catch { return 0; } })(),
      outlines: !!(cat && cat.get && cat.get(N('Outlines'))),
      encrypted: !!(ctx.trailerInfo && ctx.trailerInfo.Encrypt),
    };
  } catch {
    return null;   // caller falls back to byte-level heuristics
  }
}

/* ── Analysis ───────────────────────────────────────────────────────────── */

export async function analyze(doc = activeDoc()) {
  if (!doc) return null;
  const bytes = doc.bytes instanceof Uint8Array ? doc.bytes : new Uint8Array(doc.bytes || []);
  const security = inspectDocument(bytes);
  const structure = await readStructure(bytes);
  const accessibility = auditAccessibility(bytes, structure);
  return { name: doc.name || 'Untitled.pdf', path: doc.path || '', at: Date.now(), security, accessibility, structure };
}

/* ── Small UI atoms ─────────────────────────────────────────────────────── */

const SEV_LABEL = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low', info: 'Info' };

function scoreRing(score, label, tone) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const colour = tone === 'a11y'
    ? (clamped >= 75 ? 'var(--ok-solid)' : clamped >= 50 ? 'var(--warn-solid)' : 'var(--danger-solid)')
    : (clamped >= 80 ? 'var(--ok-solid)' : clamped >= 55 ? 'var(--warn-solid)' : 'var(--danger-solid)');
  const r = 34, c = 2 * Math.PI * r;
  return el('div', { class: 'asr-ring', html:
    `<svg viewBox="0 0 84 84" width="84" height="84" aria-hidden="true">
       <circle cx="42" cy="42" r="${r}" fill="none" stroke="var(--border)" stroke-width="7"/>
       <circle cx="42" cy="42" r="${r}" fill="none" stroke="${colour}" stroke-width="7"
         stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - clamped / 100)}"
         transform="rotate(-90 42 42)"/>
     </svg><span class="asr-ring-num">${clamped}</span>` },
  [el('div', { class: 'asr-ring-label', text: label })]);
}

function stat(label, value) {
  return el('div', { class: 'asr-stat' }, [
    el('div', { class: 'asr-stat-v', text: String(value) }),
    el('div', { class: 'asr-stat-l', text: label }),
  ]);
}

function severityPill(sev) {
  return el('span', { class: `asr-pill sev-${sev}`, text: SEV_LABEL[sev] || sev });
}

function findingCard(f) {
  const open = el('details', { class: `asr-find sev-${f.severity}` });
  const summary = el('summary', {}, [
    el('span', { class: 'asr-find-dot' }),
    severityPill(f.severity),
    el('span', { class: 'asr-find-title', text: f.title }),
    el('span', { class: 'asr-find-cat', text: f.category }),
    el('span', { class: 'asr-find-chev', html: svgIcon('chevronDown', 14) }),
  ]);
  const body = el('div', { class: 'asr-find-body' }, [
    el('p', { text: f.detail }),
  ]);
  if (f.evidence) body.appendChild(el('div', { class: 'asr-evidence', text: f.evidence }));
  const meta = [];
  if (f.remediation) meta.push(['Fix', f.remediation]);
  if (f.standard) meta.push(['Standard', f.standard]);
  if (meta.length) {
    body.appendChild(el('div', { class: 'asr-find-meta' }, meta.map(([k, v]) =>
      el('div', { class: 'asr-meta-row' }, [el('b', { text: k }), el('span', { text: v })]))));
  }
  open.append(summary, body);
  return open;
}

function sectionTitle(text, sub) {
  return el('div', { class: 'asr-section' }, [
    el('h4', { text }),
    sub ? el('span', { text: sub }) : null,
  ]);
}

async function downloadJson(filename, data) {
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Report exported', 'ok');
  } catch (e) {
    toast('Could not export: ' + e.message, 'err');
  }
}

/* ── Security Inspector ─────────────────────────────────────────────────── */

export async function openSecurityInspector() {
  const doc = activeDoc();
  if (!doc) return toast('Open a PDF to inspect it.', 'warn');
  let report;
  try { report = await analyze(doc); }
  catch (e) { return toast('Inspection failed: ' + e.message, 'err'); }
  const s = report.security;
  logAudit('inspect', `${report.name} · score ${s.score} · ${s.summary.total} findings`);

  const box = el('div', { class: 'asr' });
  const hero = el('div', { class: 'asr-hero' }, [
    scoreRing(s.score, 'Trust score'),
    el('div', { class: 'asr-hero-main' }, [
      el('h3', { text: verdict(s) }),
      el('p', { text: `${report.name} · ${(s.size / 1024).toFixed(0)} KB · PDF ${s.facts.header} · read entirely on this machine, nothing uploaded.` }),
      el('div', { class: 'asr-stats' }, [
        stat('Critical', s.summary.critical), stat('High', s.summary.high),
        stat('Medium', s.summary.medium), stat('Revisions', s.facts.revisions),
        stat('Attachments', s.facts.embeddedFiles), stat('Layers', s.facts.ocg),
      ]),
    ]),
  ]);
  box.appendChild(hero);

  box.appendChild(sectionTitle('Findings', `${s.findings.length} checks · ISO 32000 / NIST SP 800-88`));
  const list = el('div', { class: 'asr-list' });
  if (!s.findings.length) {
    list.appendChild(el('div', { class: 'asr-clean' }, [
      el('div', { class: 'asr-clean-ic', html: svgIcon('check', 20) }),
      el('strong', { text: 'No hidden data or active content found' }),
      el('span', { text: 'One revision, no scripts, no attachments, no trailing bytes.' }),
    ]));
  } else s.findings.forEach((f) => list.appendChild(findingCard(f)));
  box.appendChild(list);

  const actions = el('div', { class: 'asr-actions' });
  const sanitize = el('button', { class: 'primary', html: svgIcon('shield', 15) + '<span>Flatten &amp; Sanitize</span>' });
  actions.appendChild(sanitize);
  const copy = el('button', { class: 'ghost', text: 'Copy report' });
  copy.onclick = async () => {
    const text = `${report.name} — AiPDF Document Assurance\nTrust score: ${s.score}/100\n\n` +
      s.findings.map((f) => `[${SEV_LABEL[f.severity]}] ${f.title}\n${f.detail}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast('Report copied', 'ok'); }
    catch { toast('Clipboard unavailable', 'warn'); }
  };
  actions.appendChild(copy);
  const exp = el('button', { class: 'ghost', text: 'Export JSON' });
  exp.onclick = () => downloadJson(`${report.name.replace(/\.pdf$/i, '')}-assurance.json`, report);
  actions.appendChild(exp);
  box.appendChild(actions);

  await showModal({
    title: 'Security Inspector — document forensics', width: 'wide',
    body: (b, api) => {
      // Rebind: the footer-less body owns the actions so long-running work can
      // close the dialog before rebuilding the document.
      sanitize.onclick = async () => { api.close(); await flattenAndSanitize(); };
      b.appendChild(box);
    },
    buttons: [{ label: 'Done', value: true, kind: 'primary', default: true }],
  });
}

/** Rewrite the file from its live object graph. This drops every prior
 *  incremental revision, trailing bytes, unused objects and auto-actions. */
export async function flattenAndSanitize() {
  const doc = activeDoc();
  if (!doc) return toast('Open a PDF first.', 'warn');
  const ok = await confirmDialog(
    'Flatten & Sanitize rebuilds this document from its current pages. It removes saved revision history (recoverable deleted text), trailing data, embedded auto-actions, optional-content layers and author/creator metadata. Digital signatures will be invalidated. This changes the open document but does not overwrite the file until you Save.',
    { title: 'Flatten & sanitize?', okLabel: 'Rebuild document' });
  if (!ok) return;
  try {
    const { buildDocBytes } = await import('./app.js');
    const bytes = await buildDocBytes(doc);
    const PL = await import('/v/pdf-lib.js');
    const pdf = await PL.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const N = PL.PDFName.of;
    const cat = pdf.catalog;
    for (const key of ['OpenAction', 'AA', 'OCProperties']) { try { cat.delete(N(key)); } catch { /* absent */ } }
    for (const page of pdf.getPages()) { try { page.node.delete(N('AA')); } catch { /* absent */ } }
    for (const fn of ['setAuthor', 'setCreator', 'setProducer', 'setSubject']) {
      try { pdf[fn](''); } catch { /* unsupported build */ }
    }
    try { pdf.setKeywords([]); } catch { /* unsupported build */ }
    const clean = await pdf.save({ useObjectStreams: true });
    await reloadDocFromBytes(doc, clean, 'Document rebuilt — prior revisions and actions removed');
    logAudit('sanitize', `${doc.name} · ${bytes.length} → ${clean.length} bytes`);
    if (settings.sidebar === 'assurance') renderSidebar();
  } catch (e) {
    toast('Sanitize failed: ' + e.message, 'err', 6000);
  }
}

/* ── Accessibility Checker ──────────────────────────────────────────────── */

const STATUS_LABEL = { fail: 'Fail', warn: 'Review', pass: 'Pass' };

export async function openAccessibilityChecker() {
  const doc = activeDoc();
  if (!doc) return toast('Open a PDF to check it.', 'warn');
  let report;
  try { report = await analyze(doc); }
  catch (e) { return toast('Accessibility audit failed: ' + e.message, 'err'); }
  const a = report.accessibility;
  logAudit('accessibility', `${report.name} · ${a.score}/100 (${a.grade}) · ${a.summary.fail} failures`);

  const box = el('div', { class: 'asr' });
  box.appendChild(el('div', { class: 'asr-hero' }, [
    scoreRing(a.score, `PDF/UA grade ${a.grade}`, 'a11y'),
    el('div', { class: 'asr-hero-main' }, [
      el('h3', { text: a.summary.fail ? `${a.summary.fail} barrier${a.summary.fail === 1 ? '' : 's'} to assistive technology` : 'No critical barriers found' }),
      el('p', { text: `Offline structural audit of ${report.name} · ${a.facts.pageCount || '?'} pages · mapped to PDF/UA-1 and WCAG 2.1 AA.` }),
      el('div', { class: 'asr-stats' }, [
        stat('Fail', a.summary.fail), stat('Review', a.summary.warn), stat('Pass', a.summary.pass),
        stat('Alt text', a.facts.altCount), stat('Images', a.facts.images), stat('Tagged', a.facts.tagged ? 'Yes' : 'No'),
      ]),
    ]),
  ]));

  box.appendChild(sectionTitle('Checks', 'Sorted by impact'));
  const list = el('div', { class: 'asr-list' });
  a.checks.forEach((c) => {
    const d = el('details', { class: `asr-find a11y-${c.status}` });
    d.appendChild(el('summary', {}, [
      el('span', { class: 'asr-find-dot' }),
      el('span', { class: `asr-pill a11y-${c.status}`, text: STATUS_LABEL[c.status] }),
      el('span', { class: 'asr-find-title', text: c.title }),
      el('span', { class: 'asr-find-cat', text: c.standard }),
      el('span', { class: 'asr-find-chev', html: svgIcon('chevronDown', 14) }),
    ]));
    d.appendChild(el('div', { class: 'asr-find-body' }, [
      el('p', { text: c.detail }),
      el('div', { class: 'asr-meta-row' }, [el('b', { text: 'Remedy' }), el('span', { text: c.fix || 'No action needed.' })]),
    ]));
    list.appendChild(d);
  });
  box.appendChild(list);

  const actions = el('div', { class: 'asr-actions' });
  const fix = el('button', { class: 'primary', html: svgIcon('accessibility', 15) + '<span>Apply safe fixes</span>' });
  const exp = el('button', { class: 'ghost', text: 'Export JSON' });
  exp.onclick = () => downloadJson(`${report.name.replace(/\.pdf$/i, '')}-accessibility.json`, report.accessibility);
  actions.append(fix, exp);
  const note = el('p', { class: 'asr-note',
    text: 'Safe fixes set the document language, title and viewer preferences only. AiPDF will never mark an untagged document as "tagged" — false tagging is worse than none.' });
  box.append(actions, note);

  await showModal({
    title: 'Accessibility Checker — PDF/UA & WCAG', width: 'wide',
    body: (b, api) => {
      fix.onclick = async () => { api.close(); await applyAccessibilityFixes(); };
      b.appendChild(box);
    },
    buttons: [{ label: 'Done', value: true, kind: 'primary', default: true }],
  });
}

export async function applyAccessibilityFixes() {
  const doc = activeDoc();
  if (!doc) return toast('Open a PDF first.', 'warn');
  const lang = await promptDialog('Document language (BCP 47). This is read aloud by screen readers.', 'en-US', { title: 'Set document language', okLabel: 'Apply fixes' });
  if (lang === null || lang === undefined) return;
  try {
    const { buildDocBytes } = await import('./app.js');
    const bytes = await buildDocBytes(doc);
    const PL = await import('/v/pdf-lib.js');
    const pdf = await PL.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const N = PL.PDFName.of;
    let applied = 0;
    try { pdf.setLanguage(String(lang).trim() || 'en-US'); applied++; } catch { /* old build */ }
    try { pdf.catalog.set(N('Lang'), PL.PDFString.of(String(lang).trim() || 'en-US')); } catch { /* ignore */ }
    try { if (!pdf.getTitle()) pdf.setTitle(doc.name.replace(/\.pdf$/i, '')); applied++; } catch { /* ignore */ }
    try {
      const vp = pdf.catalog.lookup(N('ViewerPreferences'), PL.PDFDict) || PL.PDFDict.withContext(pdf.context);
      vp.set(N('DisplayDocTitle'), PL.PDFBool.True);
      pdf.catalog.set(N('ViewerPreferences'), vp);
      applied++;
    } catch { /* ignore */ }
    const out = await pdf.save({ useObjectStreams: true });
    await reloadDocFromBytes(doc, out, `Accessibility metadata applied (${applied} fixes)`);
    logAudit('a11y-fix', `${doc.name} · ${applied} metadata fixes`);
  } catch (e) {
    toast('Could not apply fixes: ' + e.message, 'err', 6000);
  }
}

/* ── Trust Center ───────────────────────────────────────────────────────── */

function posture() {
  const p = (settings.ai && settings.ai.provider) || 'openai';
  const url = (settings.ai && settings.ai.baseUrl) || '';
  const local = /ollama|lmstudio/i.test(p) || /localhost|127\.0\.0\.1|\[::1\]/i.test(url);
  return { provider: p, url, local, egress: settings.aiEgress || 'ask' };
}

export async function openTrustCenter() {
  const p = posture();
  const log = auditLog();
  const box = el('div', { class: 'asr trust' });

  box.appendChild(el('div', { class: 'asr-hero trust-hero' }, [
    el('div', { class: 'trust-seal', html: svgIcon('shield', 30) }),
    el('div', { class: 'asr-hero-main' }, [
      el('h3', { text: 'Local-first by architecture' }),
      el('p', { text: 'Rendering, editing, OCR, redaction, forensics and accessibility audits all run on this machine. Document bytes never leave the app unless you explicitly send them to an AI provider you configured.' }),
    ]),
  ]));

  box.appendChild(sectionTitle('Data egress'));
  const rows = [
    ['Document processing', 'On this device', 'ok'],
    ['OCR engine', settings.ocr && settings.ocr.engine === 'tesseract' ? 'Tesseract — local' : 'AI vision — sends page images', settings.ocr && settings.ocr.engine === 'tesseract' ? 'ok' : 'warn'],
    ['AI provider', p.local ? `${p.provider} — local endpoint` : `${p.provider} — remote endpoint`, p.local ? 'ok' : 'warn'],
    ['AI consent gate', p.egress === 'deny' ? 'Deny — always offline' : p.egress === 'allow' ? 'Allow (remembered)' : 'Ask every time', p.egress === 'deny' ? 'ok' : 'warn'],
    ['Telemetry', 'None. AiPDF has no analytics SDK.', 'ok'],
    ['Agent command surface', 'window.aipdf — local, CDP-accessible', 'ok'],
  ];
  box.appendChild(el('div', { class: 'trust-grid' }, rows.map(([k, v, tone]) =>
    el('div', { class: `trust-row ${tone}` }, [
      el('span', { class: 'trust-k', text: k }),
      el('span', { class: 'trust-v', text: v }),
      el('span', { class: 'trust-dot' }),
    ]))));

  box.appendChild(sectionTitle('Audit ledger', `${log.length} local entries · stored only in this profile`));
  const ledger = el('div', { class: 'asr-ledger' });
  if (!log.length) ledger.appendChild(el('div', { class: 'asr-empty', text: 'No operations recorded yet. Inspections, sanitization, checkpoints and agent commands appear here.' }));
  else log.slice(0, 40).forEach((e) => ledger.appendChild(el('div', { class: 'asr-ledger-row' }, [
    el('time', { text: new Date(e.t).toLocaleString() }),
    el('span', { class: 'asr-ledger-kind', text: e.kind }),
    el('span', { class: 'asr-ledger-detail', text: e.detail }),
    el('span', { class: 'asr-ledger-local', text: 'local' }),
  ])));
  box.appendChild(ledger);

  const copyLedger = async () => {
    try { await navigator.clipboard.writeText(JSON.stringify(auditLog(), null, 2)); toast('Ledger copied', 'ok'); }
    catch { toast('Clipboard unavailable', 'warn'); }
  };
  const clearLedger = async () => {
    if (await confirmDialog('Delete all local audit entries? This cannot be undone.', { title: 'Clear audit ledger', okLabel: 'Clear' })) {
      clearAudit();
      ledger.innerHTML = '';
      ledger.appendChild(el('div', { class: 'asr-empty', text: 'Ledger cleared. New operations will be recorded here.' }));
      toast('Audit ledger cleared', 'info');
    }
  };

  // Ledger actions live in the FOOTER, not after the scrollable ledger. A
  // long audit log otherwise pushes them below the fold. `validate` returning
  // false performs the action without closing the dialog.
  await showModal({ title: 'Trust Center — local-first & auditable', width: 'wide',
    body: (b) => { b.appendChild(box); },
    buttons: [
      { label: 'Copy ledger', kind: 'ghost', validate: () => { copyLedger(); return false; } },
      { label: 'Clear ledger', kind: 'ghost', validate: () => { clearLedger(); return false; } },
      { label: 'Done', value: true, kind: 'primary', default: true },
    ] });
}

/* ── Rail panel ─────────────────────────────────────────────────────────── */

export function renderAssurancePanel(body, tools) {
  const doc = activeDoc();
  body.innerHTML = ''; tools.innerHTML = '';
  tools.appendChild(el('button', { class: 'mini-btn', text: 'Re-scan', title: 'Re-run both audits',
    onclick: () => renderAssurancePanel(body, tools) }));
  if (!doc) {
    body.appendChild(el('div', { class: 'asr-empty', text: 'Open a PDF to see its live assurance posture.' }));
    return;
  }
  const cached = el('div', { class: 'asr-panel' });
  body.appendChild(cached);
  const run = async () => {
    const r = await analyze(doc);
    if (!r) return;
    cached.innerHTML = '';
    const s = r.security, a = r.accessibility;
    cached.appendChild(el('div', { class: 'asr-panel-score' }, [
      el('div', { class: 'asr-panel-num', text: String(s.score) }),
      el('div', {}, [el('strong', { text: 'Trust score' }), el('span', { text: verdict(s) })]),
    ]));
    cached.appendChild(el('div', { class: 'asr-panel-bars' }, [
      el('div', { class: 'asr-pbar' }, [
        el('span', { text: `Security  ${s.score}/100` }),
        el('i', { style: { width: `${s.score}%` } }),
      ]),
      el('div', { class: 'asr-pbar a11y' }, [
        el('span', { text: `Accessibility  ${a.score}/100 (${a.grade})` }),
        el('i', { style: { width: `${a.score}%` } }),
      ]),
    ]));
    const items = [
      ['shield', 'Security Inspector', `${s.summary.critical + s.summary.high} high-risk findings`, () => openSecurityInspector()],
      ['accessibility', 'Accessibility Checker', `${a.summary.fail} failures · grade ${a.grade}`, () => openAccessibilityChecker()],
      ['clock', 'Version Timeline', 'Snapshots & restore', () => import('./timeline.js').then((m) => m.openTimeline())],
      ['lock', 'Trust Center', 'Egress posture & audit ledger', () => openTrustCenter()],
      ['compress', 'Flatten & Sanitize', 'Remove hidden revisions', () => flattenAndSanitize()],
    ];
    cached.appendChild(el('div', { class: 'asr-panel-links' }, items.map(([icon, label, sub, fn]) => {
      const b = el('button', { class: 'asr-link' }, [
        el('span', { class: 'asr-link-ic', html: svgIcon(icon, 16) }),
        el('span', { class: 'asr-link-txt' }, [el('strong', { text: label }), el('small', { text: sub })]),
        el('span', { class: 'asr-link-go', html: svgIcon('chevronRight', 14) }),
      ]);
      b.onclick = fn;
      return b;
    })));
    cached.appendChild(el('div', { class: 'asr-panel-foot', text: 'All analysis runs on this device. No document bytes are uploaded.' }));
  };
  run().catch(() => cached.appendChild(el('div', { class: 'asr-empty', text: 'Analysis unavailable for this document.' })));
}

/* ── Init ───────────────────────────────────────────────────────────────── */

export function initAssurance() {
  // Panels are registered through a global table so sidebar.js does not need
  // to import this module (which would create an app.js ↔ sidebar cycle).
  window.__aipdfSidePanels = window.__aipdfSidePanels || {};
  window.__aipdfSidePanels.assurance = renderAssurancePanel;
  window.__aipdfSidePanels.timeline = (body, tools) => {
    import('./timeline.js').then((m) => m.renderTimelinePanel(body, tools));
  };
  logAudit('session', 'AiPDF Editor started — local assurance ready');
}

export { verdict };
