/**
 * premium.js — visual system controller + local agent command surface.
 *
 * Responsibilities:
 *   - Skin / high-contrast / focus-mode state (persisted through store settings)
 *   - Welcome & empty-workspace enhancements that survive re-renders
 *   - `window.aipdf`: a documented, local, CDP-drivable automation API. This
 *     is the groundwork for MCP-style "agent-ready PDF" interoperability:
 *     an external agent can inspect, audit, checkpoint and dispatch real
 *     commands without any cloud dependency.
 *
 * The actual look lives in css/premium.css. This file only owns state.
 */

import { state, settings, saveSettings, activeDoc } from './store.js';
import { el, toast, $ } from './util.js';
import { svgIcon } from './icons.js';
import { showModal } from './dialog.js';
import { logAudit, analyze } from './assurance.js';
import { listSnapshots, createCheckpoint } from './timeline.js';

/**
 * Colour themes. Each id maps to a small token bundle in premium.css; the same
 * id works in both light and dark mode, so the light/dark switch stays a
 * separate, independent control. `contrast` is an accessibility skin (WCAG
 * AAA black/white + safety yellow) rather than a colour mood, but keeping it
 * in one list means a single persisted setting drives every appearance path:
 * the gallery, the View menu, the cycle shortcut and the agent API.
 *
 * `swatch` is [chrome background, accent, text] used only by the gallery
 * preview — it never overrides the real document page, which stays white.
 */
export const THEMES = [
  { id: 'default',  name: 'Slate Indigo',  note: 'Cool neutrals, one confident indigo. The default workspace.',
    swatch: ['#e9edf4', '#3358d4', '#111827'] },
  { id: 'ocean',    name: 'Ocean Teal',    note: 'Calm blue-teal for long review sessions.',
    swatch: ['#e7f0f4', '#0d7490', '#102a33'] },
  { id: 'forest',   name: 'Forest Emerald', note: 'Grounded green with soft, low-glare surfaces.',
    swatch: ['#e8f1eb', '#0f7a55', '#102b20'] },
  { id: 'amber',    name: 'Amber Ember',   note: 'Warm parchment chrome and a golden accent.',
    swatch: ['#f5eee2', '#b26a09', '#3a2712'] },
  { id: 'rose',     name: 'Rose Quartz',   note: 'A soft crimson accent on quiet warm greys.',
    swatch: ['#f5ebee', '#c2415f', '#3b1a25'] },
  { id: 'violet',   name: 'Violet Ink',    note: 'Creative purple with crisp violet focus rings.',
    swatch: ['#efeaf8', '#7040c8', '#251640'] },
  { id: 'graphite', name: 'Graphite',      note: 'Neutral monochrome — the colour stays in the PDF.',
    swatch: ['#eceef1', '#465063', '#161a22'] },
  { id: 'aurora',   name: 'Aurora',        note: 'Vivid teal gradient for a brighter workspace.',
    swatch: ['#e5f5f2', '#0f8a83', '#0b2f2d'] },
  { id: 'contrast', name: 'High Contrast', note: 'Accessibility: pure black/white, safety yellow, WCAG AAA.',
    swatch: ['#ffffff', '#000000', '#ffe600'] },
];

const SKINS = THEMES.map((t) => t.id);
const SKIN_LABEL = Object.fromEntries(THEMES.map((t) => [t.id, t.name]));
const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[0];
const currentSkin = () => (SKINS.includes(settings.skin) ? settings.skin : 'default');

/** Apply the persisted skin to the DOM and keep the status-bar chip in sync. */
export function applySkin() {
  const skin = currentSkin();
  document.documentElement.dataset.skin = skin;
  document.body.classList.toggle('hc', skin === 'contrast');
  const dot = document.getElementById('stThemeDot');
  const label = document.getElementById('stThemeName');
  if (dot) dot.style.background = themeById(skin).swatch[1];
  if (label) label.textContent = themeById(skin).name;
  return skin;
}

/** Set one theme by id. Every appearance entry point goes through here. */
export function setSkin(id, quiet = false) {
  const next = themeById(String(id || 'default')).id;
  settings.skin = next;
  if (next !== 'contrast') settings.skinBeforeContrast = next;
  applySkin();
  saveSettings();
  if (!quiet) {
    toast(`Colour theme: ${themeById(next).name}`, 'info');
    logAudit('theme', themeById(next).name);
  }
  return next;
}

export function cycleSkin() {
  return setSkin(SKINS[(SKINS.indexOf(currentSkin()) + 1) % SKINS.length]);
}

export function toggleHighContrast() {
  const on = currentSkin() !== 'contrast';
  // Remember the palette we came from, so leaving the accessibility skin
  // restores it instead of dumping the user back on the factory default.
  if (on) settings.skinBeforeContrast = currentSkin();
  const back = settings.skinBeforeContrast;
  const next = on ? 'contrast' : (SKINS.includes(back) && back !== 'contrast' ? back : 'default');
  setSkin(next, true);
  toast(on ? 'High contrast on' : 'High contrast off', 'info');
  logAudit('contrast', on ? 'High contrast on' : 'High contrast off');
  return on;
}

/* ── Theme gallery ──────────────────────────────────────────────────────── */

/**
 * A real picker rather than a cycle-only shortcut: nine themes, live preview
 * on click, light/dark switch, and a persistent "Current" marker. The dialog
 * is intentionally built from tokens, so a new theme needs one CSS bundle and
 * one THEMES row — no new UI branch.
 */
export function openThemeGallery() {
  let chosen = currentSkin();
  const wrap = el('div', { class: 'th' });
  const hero = el('div', { class: 'th-hero' }, [
    el('div', { class: 'th-hero-ic', html: svgIcon('palette', 20) }),
    el('div', {}, [
      el('h3', { text: 'Colour themes' }),
      el('p', { text: 'Choose the palette for the application chrome. Your PDF pages always stay their original colour. Everything is stored locally.' }),
    ]),
  ]);
  const modeRow = el('div', { class: 'th-mode' }, [
    el('span', { class: 'th-mode-label', text: 'Brightness' }),
  ]);
  const darkNow = () => document.documentElement.dataset.theme === 'dark';
  const lightBtn = el('button', { type: 'button', class: 'th-mode-btn', text: '☀  Light' });
  const darkBtn = el('button', { type: 'button', class: 'th-mode-btn', text: '☾  Dark' });
  const syncMode = () => {
    const dark = darkNow();
    lightBtn.classList.toggle('active', !dark);
    darkBtn.classList.toggle('active', dark);
  };
  const setDark = async (wantDark) => {
    if (darkNow() !== wantDark) {
      const m = await import('./app.js');
      await m.onMenuAction('view:darkMode');
    }
    syncMode();
  };
  lightBtn.onclick = () => setDark(false);
  darkBtn.onclick = () => setDark(true);
  modeRow.append(lightBtn, darkBtn);
  syncMode();

  const grid = el('div', { class: 'th-grid' });
  const refresh = () => {
    grid.innerHTML = '';
    for (const t of THEMES) {
      const [bg, accent, ink] = t.swatch;
      const preview = el('div', { class: 'th-preview', style: { background: bg } }, [
        el('div', { class: 'th-prev-bar', style: { background: accent } }),
        el('div', { class: 'th-prev-rail', style: { background: accent } }),
        el('div', { class: 'th-prev-page' }, [
          el('i', { style: { background: ink } }),
          el('i', { style: { background: ink } }),
          el('i', { style: { background: accent } }),
        ]),
      ]);
      const card = el('button', {
        type: 'button',
        class: `th-card${t.id === chosen ? ' current' : ''}`,
        'aria-pressed': String(t.id === chosen),
      }, [
        preview,
        el('div', { class: 'th-card-body' }, [
          el('strong', { text: t.name }),
          el('small', { text: t.note }),
        ]),
        el('span', { class: 'th-check', html: svgIcon('check', 14) }),
      ]);
      card.onclick = () => {
        chosen = t.id;
        setSkin(t.id);
        refresh();
      };
      grid.appendChild(card);
    }
  };
  refresh();

  wrap.append(hero, modeRow, el('div', { class: 'th-section', text: `Palettes · ${THEMES.length}` }), grid,
    el('p', { class: 'th-foot', text: 'Shortcut: Ctrl+Alt+S cycles themes · Ctrl+Alt+C toggles high contrast. Light/dark is independent of the palette.' }));

  return showModal({
    title: 'Appearance — colour themes',
    width: 'wide',
    body: (b) => b.appendChild(wrap),
    buttons: [{ label: 'Done', value: true, kind: 'primary', default: true }],
  });
}

/* ── Focus mode ─────────────────────────────────────────────────────────── */

let exitChip = null;

export function toggleFocusMode(force, quiet = false) {
  const on = typeof force === 'boolean' ? force : !state.view.focusMode;
  state.view.focusMode = on;
  settings.focusMode = on;
  saveSettings();
  document.body.classList.toggle('focus-mode', on);
  if (on) {
    if (!exitChip) {
      exitChip = el('button', {
        class: 'focus-exit', type: 'button',
        title: 'Exit focus mode (Ctrl+Alt+F)',
        html: svgIcon('x', 15) + '<span>Exit focus mode</span><kbd>Ctrl+Alt+F</kbd>',
      });
      exitChip.onclick = () => toggleFocusMode(false);
      document.body.appendChild(exitChip);
    }
    exitChip.hidden = false;
    if (!quiet) toast('Focus mode — Ctrl+Alt+F to exit', 'info', 2600);
  } else if (exitChip) exitChip.hidden = true;
  // Restoring a persisted preference on boot is not a user action: do not
  // toast, and do not add a ledger entry every time the app launches.
  if (!quiet) logAudit('focus', on ? 'Focus mode on' : 'Focus mode off');
  return on;
}

/* ── Welcome / empty-state enhancements ─────────────────────────────────── */

function enhanceWelcome() {
  const inner = $('.welcome-inner');
  if (!inner || inner.querySelector('.w-trust')) return;
  const tagline = inner.querySelector('.tagline');
  const trust = el('div', { class: 'w-trust' }, [
    ['shield', 'Nothing uploaded', 'Editing, OCR and audits run on this device'],
    ['lock', 'No account', 'No sign-in, no telemetry, no subscription'],
    ['accessibility', 'Built to be read', 'Offline PDF/UA & WCAG checker included'],
  ].map(([icon, title, sub]) => el('div', { class: 'w-trust-item' }, [
    el('span', { class: 'w-trust-ic', html: svgIcon(icon, 16) }),
    el('div', {}, [el('strong', { text: title }), el('small', { text: sub })]),
  ])));
  if (tagline) tagline.after(trust);
  else inner.appendChild(trust);

  const hints = el('div', { class: 'w-hints' }, [
    ['Ctrl+K', 'Command palette'], ['Ctrl+F', 'Find'], ['Ctrl+E', 'Direct Editor'], ['Ctrl+Alt+F', 'Focus mode'],
  ].map(([k, label]) => el('span', { class: 'w-hint' }, [el('kbd', { text: k }), el('span', { text: label })])));
  const features = $('#welcomeFeatures');
  if (features) features.before(el('h3', { class: 'w-section', text: 'What you can do' }), hints);
  else inner.appendChild(hints);
}

function enhanceEmptyWorkspace() {
  const card = $('.ew-card');
  if (!card || card.querySelector('.ew-trust')) return;
  card.appendChild(el('div', { class: 'ew-trust' }, [
    ['shield', 'Local-first'], ['lock', 'No account'], ['clock', 'Version history'],
  ].map(([icon, label]) => el('span', {}, [el('i', { html: svgIcon(icon, 13) }), el('span', { text: label })]))));
  card.appendChild(el('div', { class: 'ew-hints' }, [
    el('kbd', { text: 'Ctrl+K' }), el('span', { text: 'any command, instantly' }),
  ]));
}

/* ── Local agent API ────────────────────────────────────────────────────── */

async function pageText(pageNumber) {
  const doc = activeDoc();
  if (!doc || !doc.pdf) return null;
  const n = Math.max(1, Math.min(doc.pdf.numPages, Number(pageNumber) || 1));
  const page = await doc.pdf.getPage(n);
  const tc = await page.getTextContent();
  return { page: n, items: tc.items.length, text: tc.items.map((i) => i.str || '').join(' ') };
}

function documentInfo() {
  const d = activeDoc();
  if (!d) return { open: false };
  return {
    open: true, name: d.name, path: d.path, pages: d.numPages,
    size: d.bytes ? d.bytes.length : 0,
    dirty: !!d.dirty, encrypted: !!d.passwordProtected,
    currentPage: (d.currentPage ?? 0) + 1,
    tool: state.tool, theme: document.documentElement.dataset.theme,
    skin: document.documentElement.dataset.skin,
  };
}

/** Read the REAL running build from the title-bar chip (set from the main
 *  process boot reply). A hardcoded version string drifts the moment the
 *  package is bumped, and an agent must never report the wrong build. */
function readAppVersion() {
  const chip = document.getElementById('brandVer');
  const v = chip && chip.textContent.trim().replace(/^v/, '');
  return v || 'unknown';
}

/** Install `window.aipdf`. Purely local — no network, no cloud, no auth. */
export function installAgentAPI() {
  const api = {
    // buildChrome() runs before initPremium() in the boot sequence, so the
    // title-bar chip already holds the main-process version at this point.
    version: readAppVersion(),
    description: 'AiPDF Editor local automation surface. Every method runs on this machine.',
    info: documentInfo,
    text: pageText,
    async inspect() { const r = await analyze(); return r ? r.security : null; },
    async accessibility() { const r = await analyze(); return r ? r.accessibility : null; },
    async versions() { return (await listSnapshots()).map(({ bytes, ...rest }) => rest); },
    checkpoint: createCheckpoint,
    audit: () => JSON.parse(localStorage.getItem('aipdf.assurance.audit.v1') || '[]'),
    /** Dispatch any ribbon/menu/palette action by id, e.g. run('docs:compare'). */
    async run(action, payload) {
      const m = await import('./app.js');
      logAudit('agent-run', String(action));
      return m.onMenuAction(action, payload);
    },
    /** enumerate valid action ids for run() */
    async actions() {
      const m = await import('./app.js');
      return m.COMMANDS.map((c) => ({ group: c[0], label: c[1], action: c[3] }));
    },
    focus: toggleFocusMode,
    skin: cycleSkin,
    /** Current palette + every available palette, for local automation. */
    theme: () => ({
      skin: currentSkin(),
      name: themeById(currentSkin()).name,
      dark: document.documentElement.dataset.theme === 'dark',
      available: THEMES.map((t) => ({ id: t.id, name: t.name })),
    }),
    setTheme: (id) => setSkin(id, true),
    help() {
      return [
        'AiPDF local agent API — window.aipdf',
        '  .info()                 document name/pages/size/dirty/tool/theme',
        '  .text(pageNumber)       extracted text for one page',
        '  .inspect()              security forensics report (offline)',
        '  .accessibility()        PDF/UA + WCAG report (offline)',
        '  .versions()             local snapshot list',
        '  .checkpoint()           create a named checkpoint',
        '  .audit()                local operation ledger',
        '  .actions()              list every dispatchable command',
        "  .run('docs:compare')    dispatch any command by id",
        '  .focus(true|false)      focus mode',
        '  .skin()                 cycle the colour theme',
        '  .theme()                current palette + all available palettes',
        "  .setTheme('ocean')      apply a colour theme by id",
        '', 'No document bytes leave the machine through this API.',
      ].join('\n');
    },
  };
  window.aipdf = api;
  return api;
}

/* ── Init ───────────────────────────────────────────────────────────────── */

/** renderWelcome() rewrites parts of the welcome card; re-apply our additions
 *  whenever its children change. Both enhancers are idempotent, so the observer
 *  cannot loop. */
function watchEnhancements() {
  const targets = [$('.welcome-inner'), $('.ew-card')].filter(Boolean);
  if (!targets.length || typeof MutationObserver === 'undefined') return;
  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; enhanceWelcome(); enhanceEmptyWorkspace(); });
  };
  const obs = new MutationObserver(refresh);
  targets.forEach((t) => obs.observe(t, { childList: true }));
}

/** Ctrl+Alt is AltGr on many keyboard layouts. Never steal a keystroke from a
 *  text field, an inline text editor or the find bar. */
function isTyping(e) {
  const t = e && e.target;
  if (!t || !t.tagName) return false;
  return !!t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

export function initPremium() {
  applySkin();
  enhanceWelcome();
  enhanceEmptyWorkspace();
  watchEnhancements();
  installAgentAPI();

  if (state.view.focusMode) toggleFocusMode(true, true);

  // Typing-safe global shortcuts stay in the renderer. These are deliberately
  // unusual combinations so they cannot steal an editing keystroke, and none
  // collide with a native menu accelerator (Ctrl+Alt+H/A/E/R are all taken).
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey && e.altKey) || e.shiftKey || isTyping(e)) return;
    const k = String(e.key || '').toLowerCase();
    if (k === 'f') { e.preventDefault(); toggleFocusMode(); }
    else if (k === 'c') { e.preventDefault(); toggleHighContrast(); }
    else if (k === 's') { e.preventDefault(); cycleSkin(); }
  });

  // Escape leaves focus mode. The modal stack also listens on Escape, so only
  // act when no dialog is open.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.view.focusMode) return;
    if (document.querySelector('.modal-backdrop, .palette')) return;
    toggleFocusMode(false);
  });

  // A quiet, persistent trust signal in the status bar.
  const chip = $('#stLocal');
  if (chip) {
    const ic = $('#stLocalIc');
    if (ic) ic.innerHTML = svgIcon('shield', 11);
    chip.title = 'Document processing stays on this machine. Click for the Trust Center.';
    chip.onclick = () => import('./assurance.js').then((m) => m.openTrustCenter());
  }

  // One-click access to the palette picker from the status bar. The dot is
  // painted from the live theme swatch so the control itself previews it.
  const themeChip = $('#stTheme');
  if (themeChip) {
    themeChip.title = 'Colour themes — pick a palette, light or dark';
    themeChip.onclick = () => openThemeGallery();
  }
  applySkin();
}
