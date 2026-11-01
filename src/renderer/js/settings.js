/* ── Settings dialog ───────────────────────────────────────────────────────
   A tabbed, live-updating preferences dialog. Every control writes straight
   through to the live `settings` object in store.js and calls saveSettings();
   there is no Apply button — the primary button is "Done".

   The host app (app.js) passes optional re-render hooks; each one is guarded
   so the dialog works even when a hook is missing.                           */

import { settings, saveSettings, DEFAULT_SETTINGS } from './store.js';
import { el } from './util.js';
import { showModal, confirmDialog } from './dialog.js';
import { svgIcon } from './icons.js';

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isHex(v) {
  return typeof v === 'string' && HEX_RE.test(v);
}

/* ── Small value helpers ────────────────────────────────────────────────── */

/** Current value of a top-level setting, falling back to the default. */
function val(key) {
  const v = settings[key];
  return v === undefined || v === null ? DEFAULT_SETTINGS[key] : v;
}

/** Current value of a nested setting (`ai` / `ocr`), falling back to default. */
function valSub(group, key) {
  const g = ensureSub(group);
  const v = g[key];
  return v === undefined || v === null ? DEFAULT_SETTINGS[group][key] : v;
}

/** Make sure a nested group object exists on the live settings object. */
function ensureSub(group) {
  if (!settings[group] || typeof settings[group] !== 'object') {
    settings[group] = { ...DEFAULT_SETTINGS[group] };
  }
  return settings[group];
}

/* ── Layout primitives (CSS classes are owned by app.css) ───────────────── */

function group(title) {
  return el('div', { class: 'set-group' }, [el('div', { class: 'set-group-title', text: title })]);
}

/** One setting row: label (+ optional hint) on the left, control on the right. */
function row(label, control, hint) {
  const text = el('div', { class: 'set-text' }, [el('div', { class: 'set-label', text: label })]);
  if (hint) text.appendChild(el('div', { class: 'set-hint', text: hint }));
  return el('div', { class: 'set-row' }, [text, el('div', { class: 'set-ctl' }, [control])]);
}

/* ── Control factories ──────────────────────────────────────────────────── */

/** options: [[value, label], ...] */
function select(value, options, onChange) {
  const s = el('select', {}, options.map(([v, label]) => el('option', { value: v, text: label })));
  s.value = value == null ? '' : String(value);
  s.onchange = () => onChange(s.value);
  return s;
}

function textInput(value, attrs, onChange) {
  const input = el('input', Object.assign({ type: 'text' }, attrs || {}));
  input.value = value == null ? '' : String(value);
  input.oninput = () => onChange(input.value);
  return input;
}

function numberInput(value, attrs, onChange) {
  const input = el('input', Object.assign({ type: 'number' }, attrs || {}));
  input.value = value == null ? '' : String(value);
  const push = () => {
    const n = parseFloat(input.value);
    if (!Number.isNaN(n)) onChange(n);
  };
  input.oninput = push;
  input.onchange = push;
  return input;
}

function rangeInput(value, attrs, onChange) {
  const input = el('input', Object.assign({ type: 'range' }, attrs || {}));
  input.value = value == null ? '' : String(value);
  const push = () => {
    const n = parseFloat(input.value);
    if (!Number.isNaN(n)) onChange(n);
  };
  input.oninput = push;
  input.onchange = push;
  return input;
}

function colorInput(value, onChange) {
  const input = el('input', { type: 'color' });
  input.value = isHex(value) ? value : '#000000';
  const push = () => onChange(input.value);
  input.oninput = push;
  input.onchange = push;
  return input;
}

function toggle(value, label, onChange, caption) {
  const input = el('input', { type: 'checkbox', 'aria-label': label });
  input.checked = !!value;
  input.onchange = () => onChange(input.checked);
  // The row already names the setting on the left, so the control renders the
  // switch alone. Repeating the name inside the control printed it twice —
  // and once with two different words for the same preference. A short
  // caption is still passed where the switch itself needs identifying text,
  // as the B / I / U style toggles do.
  const kids = [input];
  if (caption) kids.push(el('span', { text: caption }));
  return el('label', { class: 'set-switch chk' }, kids);
}

/* ── Section builders ───────────────────────────────────────────────────── */

function buildGeneral(W) {
  const g = group('General');
  g.appendChild(row('Author name',
    textInput(val('author'), { placeholder: 'Your name' }, W.set('author'))));
  g.appendChild(row('Default zoom',
    select(val('defaultZoom'), [
      ['fitWidth', 'Fit width'],
      ['fitPage', 'Fit page'],
      ['custom', '100%'],
    ], W.set('defaultZoom'))));
  g.appendChild(row('Measurement unit',
    select(val('measureUnit'), [
      ['cm', 'Centimetres (cm)'],
      ['mm', 'Millimetres (mm)'],
      ['in', 'Inches (in)'],
      ['pt', 'Points (pt)'],
    ], W.set('measureUnit'))));
  g.appendChild(row('Recognition language',
    textInput(val('ocrLang'), { placeholder: 'eng+nep' }, W.set('ocrLang')),
    'e.g. eng+nep'));
  return g;
}

function buildAppearance(W) {
  const g = group('Appearance');
  g.appendChild(row('Theme',
    select(val('theme'), [
      ['system', 'Match system'],
      ['light', 'Light'],
      ['dark', 'Dark'],
    ], W.set('theme', ['applyTheme']))));
  g.appendChild(row('Interface density',
    select(val('density'), [
      ['comfortable', 'Comfortable'],
      ['compact', 'Compact'],
    ], W.set('density', ['applyChrome']))));
  g.appendChild(row('Ribbon labels',
    select(val('ribbonLabels'), [
      ['auto', 'Automatic'],
      ['always', 'Always show'],
      ['never', 'Never'],
    ], W.set('ribbonLabels', ['applyChrome']))));
  g.appendChild(row('Reopen on the last ribbon tab',
    toggle(val('restoreRibbonTab'), 'Reopen on the last ribbon tab', W.set('restoreRibbonTab', ['renderRibbon']))));
  g.appendChild(row('Default highlight colour',
    colorInput(val('color'), W.set('color', ['renderRibbon']))));
  g.appendChild(row('Default fill colour',
    colorInput(val('fillColor'), W.set('fillColor', ['renderRibbon']))));
  g.appendChild(row('Fill new shapes',
    toggle(val('fillEnabled'), 'Fill new shapes', W.set('fillEnabled', ['renderRibbon']))));
  return g;
}

function buildLayout(W) {
  const g = group('View & layout');
  g.appendChild(row('Default page layout',
    select(val('layout'), [
      ['single', 'Single page'],
      ['continuous', 'Continuous'],
      ['facing', 'Facing pages'],
    ], W.set('layout', ['renderRibbon', 'renderSidebar']))));
  g.appendChild(row('Open the side panel at startup',
    toggle(val('sidebarOpen'), 'Open the side panel', W.set('sidebarOpen', ['renderSidebar']))));
  g.appendChild(row('Show rulers',
    toggle(val('showRulers'), 'Show rulers', W.set('showRulers', ['renderRibbon']))));
  g.appendChild(row('Show page grid',
    toggle(val('grid'), 'Show the page grid', W.set('grid', ['renderRibbon']))));
  g.appendChild(row('Cover page',
    toggle(val('coverPage'), 'Cover page', W.set('coverPage', ['renderRibbon']))));
  g.appendChild(row('Reverse page order',
    toggle(val('reverse'), 'Reverse page order', W.set('reverse', ['renderRibbon']))));
  g.appendChild(row('Ribbon state at startup',
    select(val('ribbonMode'), [
      ['expanded', 'Expanded'],
      ['collapsed', 'Collapsed'],
    ], W.set('ribbonMode', ['renderRibbon']))));
  return g;
}

function buildMarkup(W) {
  const g = group('Markup & editing');

  const opacityOut = el('span', { class: 'set-val', text: Number(val('opacity')).toFixed(2) });
  const writeOpacity = W.set('opacity');
  g.appendChild(row('Default opacity',
    el('div', { class: 'set-inline' }, [
      rangeInput(val('opacity'), { min: '0.1', max: '1', step: '0.05' }, (v) => {
        opacityOut.textContent = Number(v).toFixed(2);
        writeOpacity(v);
      }),
      opacityOut,
    ])));

  g.appendChild(row('Default font size (pt)',
    numberInput(val('fontSize'), { min: '1', max: '400', step: '1' }, W.set('fontSize'))));
  g.appendChild(row('Default font family',
    textInput(val('textFont'), { placeholder: 'Helvetica' }, W.set('textFont'))));
  g.appendChild(row('Default text colour',
    colorInput(val('textColor'), W.set('textColor'))));
  g.appendChild(row('Default text alignment',
    select(val('textAlign'), [
      ['left', 'Left'],
      ['center', 'Centre'],
      ['right', 'Right'],
      ['justify', 'Justify'],
    ], W.set('textAlign'))));
  g.appendChild(row('Default text style',
    el('div', { class: 'set-inline' }, [
      toggle(val('textBold'), 'Bold', W.set('textBold'), 'B'),
      toggle(val('textItalic'), 'Italic', W.set('textItalic'), 'I'),
      toggle(val('textUnderline'), 'Underline', W.set('textUnderline'), 'U'),
    ])));
  g.appendChild(row('Line spacing (× size)',
    numberInput(val('textLineSpacing'), { min: '0.5', max: '5', step: '0.1' }, W.set('textLineSpacing'))));
  g.appendChild(row('Character spacing (pt)',
    numberInput(val('textCharSpacing'), { step: '0.1' }, W.set('textCharSpacing'))));
  g.appendChild(row('Horizontal scale (%)',
    numberInput(val('textHScale'), { min: '1', max: '1000', step: '1' }, W.set('textHScale'))));
  g.appendChild(row('Border width (pt)',
    numberInput(val('borderWidth'), { min: '0', max: '50', step: '0.5' }, W.set('borderWidth'))));
  g.appendChild(row('Brush size (pt)',
    numberInput(val('brushSize'), { min: '0.5', max: '100', step: '0.5' }, W.set('brushSize'))));

  const hardOut = el('span', { class: 'set-val', text: Number(val('brushHardness')).toFixed(2) });
  const writeHardness = W.set('brushHardness');
  g.appendChild(row('Brush hardness',
    el('div', { class: 'set-inline' }, [
      rangeInput(val('brushHardness'), { min: '0', max: '1', step: '0.05' }, (v) => {
        hardOut.textContent = Number(v).toFixed(2);
        writeHardness(v);
      }),
      hardOut,
    ])));

  g.appendChild(row('Marker size (pt)',
    numberInput(val('highlighterSize'), { min: '1', max: '100', step: '1' }, W.set('highlighterSize'))));
  g.appendChild(row('Stamp font',
    textInput(val('stampFont'), { placeholder: 'Helvetica' }, W.set('stampFont'))));
  return g;
}

function buildPresets(W) {
  const g = group('Colour presets');
  const wrap = el('div', { class: 'set-presets' });

  const render = () => {
    wrap.textContent = '';
    if (!Array.isArray(settings.colorPresets)) settings.colorPresets = [...DEFAULT_SETTINGS.colorPresets];
    settings.colorPresets.forEach((hex, idx) => {
      if (!isHex(hex)) return;
      const chip = el('div', { class: 'set-chip' }, [
        el('span', { class: 'set-chip-swatch', style: { background: hex } }),
        el('span', { class: 'set-chip-label', text: hex }),
      ]);
      const rm = el('button', {
        class: 'icon-btn sm',
        type: 'button',
        'aria-label': `Remove colour ${hex}`,
        html: svgIcon('x', 12, 2),
      });
      rm.onclick = () => {
        const list = Array.isArray(settings.colorPresets) ? settings.colorPresets : [];
        if (idx < list.length) list.splice(idx, 1);
        settings.colorPresets = list.slice();
        saveSettings();
        render();
      };
      chip.appendChild(rm);
      wrap.appendChild(chip);
    });

    const add = el('input', { type: 'color', 'aria-label': 'Colour to add' });
    add.value = '#3b5bfd';
    const addBtn = el('button', { class: 'mini-btn', type: 'button', text: 'Add colour' });
    addBtn.onclick = () => {
      const hex = add.value;
      if (!isHex(hex)) return;
      const list = Array.isArray(settings.colorPresets) ? settings.colorPresets : [];
      list.push(hex);
      settings.colorPresets = list.slice();
      saveSettings();
      render();
    };
    wrap.appendChild(el('div', { class: 'set-inline' }, [add, addBtn]));
  };
  render();

  g.appendChild(el('div', { class: 'set-row' }, [
    el('div', { class: 'set-text' }, [
      el('div', { class: 'set-label', text: 'Colour presets' }),
      el('div', { class: 'set-hint', text: 'The swatches offered by the colour pickers.' }),
    ]),
    el('div', { class: 'set-ctl' }, [wrap]),
  ]));
  return g;
}

function buildOcr(W) {
  const g = group('OCR');
  g.appendChild(row('Engine',
    select(valSub('ocr', 'engine'), [
      ['tesseract', 'Tesseract (local, default)'],
      ['ai', 'AI vision model'],
      ['hybrid', 'Hybrid (AI first)'],
    ], W.setSub('ocr', 'engine'))));
  g.appendChild(row('Render resolution (dpi)',
    numberInput(valSub('ocr', 'dpi'), { min: '72', max: '1200', step: '1' }, W.setSub('ocr', 'dpi'))));
  g.appendChild(row('Language hint',
    textInput(valSub('ocr', 'langHint'), { placeholder: 'Nepali and English' }, W.setSub('ocr', 'langHint')),
    'e.g. Nepali and English'));
  return g;
}

function buildAI(W) {
  const g = group('AI assistant');

  const cfg = el('button', { class: 'mini-btn', type: 'button', text: 'Configure AI model…' });
  cfg.onclick = () => W.call('configureAI');
  g.appendChild(row('Model setup', cfg));

  g.appendChild(row('Provider',
    select(valSub('ai', 'provider'), [
      ['openai', 'OpenAI'],
      ['gemini', 'Google Gemini'],
      ['openrouter', 'OpenRouter'],
      ['groq', 'Groq'],
      ['together', 'Together AI'],
      ['deepseek', 'DeepSeek'],
      ['mistral', 'Mistral'],
      ['ollama', 'Ollama'],
      ['lmstudio', 'LM Studio'],
      ['custom', 'Custom'],
    ], W.setSub('ai', 'provider'))));
  g.appendChild(row('Base URL',
    textInput(valSub('ai', 'baseUrl'), { placeholder: 'https://api.openai.com/v1' }, W.setSub('ai', 'baseUrl'))));
  g.appendChild(row('Model',
    textInput(valSub('ai', 'model'), { placeholder: 'gpt-4o-mini' }, W.setSub('ai', 'model'))));
  g.appendChild(row('API key',
    textInput(valSub('ai', 'apiKey'), { type: 'password', autocomplete: 'off' }, W.setSub('ai', 'apiKey')),
    'Stored locally and sent only to your own endpoint.'));
  g.appendChild(row('Auth mode',
    select(valSub('ai', 'authMode'), [
      ['bearer', 'Authorization: Bearer'],
      ['x-api-key', 'x-api-key'],
      ['x-goog-api-key', 'x-goog-api-key'],
      ['api-key', 'api-key'],
      ['custom', 'Custom header'],
      ['none', 'None'],
    ], W.setSub('ai', 'authMode'))));

  const tempOut = el('span', { class: 'set-val', text: Number(valSub('ai', 'temperature')).toFixed(1) });
  const writeTemp = W.setSub('ai', 'temperature');
  g.appendChild(row('Temperature',
    el('div', { class: 'set-inline' }, [
      rangeInput(valSub('ai', 'temperature'), { min: '0', max: '1', step: '0.1' }, (v) => {
        tempOut.textContent = Number(v).toFixed(1);
        writeTemp(v);
      }),
      tempOut,
    ])));

  g.appendChild(row('Max pages per request',
    numberInput(valSub('ai', 'maxPagesPerRequest'), { min: '1', max: '1000', step: '1' }, W.setSub('ai', 'maxPagesPerRequest'))));
  g.appendChild(row('Smart context',
    toggle(valSub('ai', 'smartContext'), 'Rank pages by relevance', W.setSub('ai', 'smartContext'))));
  g.appendChild(row('Context budget (characters)',
    numberInput(valSub('ai', 'contextBudget'), { min: '1000', max: '200000', step: '500' }, W.setSub('ai', 'contextBudget'))));
  g.appendChild(row('Default scope',
    select(valSub('ai', 'defaultScope'), [
      ['page', 'Current page'],
      ['doc', 'Current document'],
      ['alldocs', 'All open documents'],
    ], W.setSub('ai', 'defaultScope'))));
  return g;
}

function buildTrust(W) {
  const g = group('Files & trust');
  g.appendChild(el('div', { class: 'set-hint', text: 'What a save does to your file, and what leaves your machine.' }));
  g.appendChild(row('Keep the previous version on save',
    toggle(val('backupBeforeSave'), 'Keep the previous version on save', W.set('backupBeforeSave')),
    'A save rewrites the whole file, so the revision before it is kept as name.pdf.bak — one copy of the document you are editing, replaced each save. File ▸ Restore Previous Version… puts it back.'));
  g.appendChild(row('Sending document text to the AI',
    select(val('aiEgress'), [
      ['ask', 'Ask before the first upload of a session'],
      ['allow', 'Allow — every AI feature may send'],
      ['deny', 'Deny — AI that reads the document stays off'],
    ], W.set('aiEgress')),
    'Summarise, Ask, Contract review, Smart Redact, vision OCR, PDF→Word and the Agent all upload the pages they work on. Nothing is sent without this being answered.'));
  g.appendChild(row('Agent proposes an edit plan first',
    toggle(val('aiPlanFirst'), 'Agent proposes an edit plan first', W.set('aiPlanFirst')),
    'The agent shows what it intends to change — each operation with its before and after text — and waits for you to approve. Off means it edits as it works, undoable afterwards.'));
  return g;
}

function buildShortcuts(W) {
  const g = group('Shortcuts');
  const holder = el('div', { class: 'set-shortcuts' });
  let node = null;
  try {
    if (typeof W.hooks.renderShortcuts === 'function') node = W.hooks.renderShortcuts();
  } catch (e) {
    console.error('renderShortcuts hook failed:', e);
    node = null;
  }
  if (node && node.nodeType === 1) {
    holder.appendChild(node);
  } else {
    holder.appendChild(el('div', {
      class: 'set-hint',
      text: 'The keyboard shortcut list is unavailable right now.',
    }));
  }
  g.appendChild(el('div', { class: 'set-row' }, [
    el('div', { class: 'set-text' }, [
      el('div', { class: 'set-label', text: 'Keyboard shortcuts' }),
      el('div', { class: 'set-hint', text: 'Reference only — these cannot be changed here.' }),
    ]),
    el('div', { class: 'set-ctl' }, [holder]),
  ]));
  return g;
}

function buildAdvanced(W) {
  const g = group('Advanced');
  const btn = el('button', {
    class: 'mini-btn',
    type: 'button',
    text: 'Reset all settings',
    style: {
      background: 'var(--danger-soft)',
      borderColor: 'var(--danger-line)',
      color: 'var(--danger-ink)',
    },
  });
  btn.onclick = async () => {
    let ok = false;
    try {
      ok = await confirmDialog('Reset all settings back to their defaults?', {
        title: 'Reset settings',
        detail: 'Every preference, including the AI configuration, is restored. This cannot be undone.',
        okLabel: 'Reset',
        cancelLabel: 'Cancel',
        danger: true,
      });
    } catch (e) {
      console.error('confirmDialog failed:', e);
      ok = false;
    }
    if (!ok) return;
    W.reset();
    W.close(false);
  };
  g.appendChild(row('Reset', btn, 'Restores every preference to its default value.'));
  return g;
}

/* ── Public entry point ─────────────────────────────────────────────────── */

export async function openSettingsDialog(hooks = {}) {
  const H = hooks && typeof hooks === 'object' ? hooks : {};

  const call = (name) => {
    const fn = H[name];
    if (typeof fn !== 'function') return;
    try {
      fn();
    } catch (e) {
      console.error(`settings hook "${name}" failed:`, e);
    }
  };

  const refresh = (names) => (names || []).forEach(call);

  /** Writer for a top-level setting: assign, persist, then re-render. */
  const set = (key, refreshNames) => (value) => {
    try {
      settings[key] = value;
      saveSettings();
    } catch (e) {
      console.error(`settings write "${key}" failed:`, e);
    }
    refresh(refreshNames);
  };

  /** Writer for a nested setting (`ai` / `ocr`). */
  const setSub = (groupName, key, refreshNames) => (value) => {
    try {
      ensureSub(groupName)[key] = value;
      saveSettings();
    } catch (e) {
      console.error(`settings write "${groupName}.${key}" failed:`, e);
    }
    refresh(refreshNames);
  };

  let closeFn = null;

  const W = {
    hooks: H,
    set,
    setSub,
    call,
    close: (v) => { if (closeFn) closeFn(v); },
    reset: () => {
      // Prefer the host hook (it re-applies everything); fall back to a local
      // restore of DEFAULT_SETTINGS when the hook is not supplied.
      if (typeof H.resetAll === 'function') {
        call('resetAll');
        return;
      }
      try {
        Object.assign(settings, DEFAULT_SETTINGS, {
          ai: { ...DEFAULT_SETTINGS.ai },
          ocr: { ...DEFAULT_SETTINGS.ocr },
          colorPresets: [...DEFAULT_SETTINGS.colorPresets],
        });
        saveSettings();
      } catch (e) {
        console.error('settings reset failed:', e);
      }
      refresh(['applyTheme', 'applyChrome', 'renderRibbon', 'renderSidebar']);
    },
  };

  const SECTIONS = [
    { id: 'general', label: 'General', icon: 'settings', build: buildGeneral },
    { id: 'appearance', label: 'Appearance', icon: 'palette', build: buildAppearance },
    { id: 'layout', label: 'View & layout', icon: 'eye', build: buildLayout },
    { id: 'markup', label: 'Markup & editing', icon: 'highlight', build: buildMarkup },
    { id: 'presets', label: 'Colour presets', icon: 'palette', build: buildPresets },
    { id: 'ocr', label: 'OCR', icon: 'scan', build: buildOcr },
    { id: 'ai', label: 'AI assistant', icon: 'ai', build: buildAI },
    { id: 'trust', label: 'Files & trust', icon: 'shield', build: buildTrust },
    { id: 'shortcuts', label: 'Shortcuts', icon: 'wand', build: buildShortcuts },
    { id: 'advanced', label: 'Advanced', icon: 'info', build: buildAdvanced },
  ];

  const nav = el('div', { class: 'settings-nav' });
  const pane = el('div', { class: 'settings-pane' });
  const shell = el('div', { class: 'settings-shell' }, [nav, pane]);
  const buttons = [];

  const show = (id) => {
    const section = SECTIONS.find((s) => s.id === id) || SECTIONS[0];
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.section === section.id));
    pane.textContent = '';
    try {
      const content = section.build(W);
      if (content) pane.appendChild(content);
    } catch (e) {
      console.error(`settings section "${section.id}" failed to render:`, e);
      pane.appendChild(el('div', { class: 'set-hint', text: 'This section could not be displayed.' }));
    }
  };

  SECTIONS.forEach((section) => {
    const btn = el('button', { class: 'settings-nav-btn', type: 'button' }, [
      el('span', { class: 'settings-nav-ico', html: svgIcon(section.icon, 15) }),
      el('span', { class: 'settings-nav-label', text: section.label }),
    ]);
    btn.dataset.section = section.id;
    btn.onclick = () => show(section.id);
    buttons.push(btn);
    nav.appendChild(btn);
  });

  let result;
  try {
    result = await showModal({
      title: 'Settings',
      width: 'wide',
      body: (b, api) => {
        closeFn = api.close;
        b.appendChild(shell);
        show(SECTIONS[0].id);
      },
      buttons: [{ label: 'Done', value: true, kind: 'primary', default: true }],
    });
  } catch (e) {
    console.error('settings dialog failed:', e);
    return false;
  }
  return result === true;
}

export default openSettingsDialog;
