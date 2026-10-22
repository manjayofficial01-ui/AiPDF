/* Small utilities shared across the renderer. */

import { svgIcon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) {
      // Recursively flatten nested arrays so callers may pass [a, [b, c]] freely.
      for (const cc of c) {
        if (cc == null || cc === false) continue;
        n.appendChild(typeof cc === 'string' ? document.createTextNode(cc) : cc);
      }
      continue;
    }
    n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return n;
}

export const uid = (p = 'a') => p + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));


/* ── 2×3 affine matrices (PDF ↔ CSS) ─────────────────────────────────────
   pdf.js viewport.transform maps PDF user space (y up, origin bottom-left)
   to CSS pixels (y down, origin top-left). We only ever need the transform
   itself and its inverse.                                                  */

export function applyTransform(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}
export function invertMatrix(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) return [1, 0, 0, 1, 0, 0];
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
export function mulMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/* ── Colour helpers ─────────────────────────────────────────────────────── */

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '').trim();
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(v, 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(rgb) {
  const to = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return '#' + to(rgb[0]) + to(rgb[1]) + to(rgb[2]);
}
export function rgbToCss(rgb, alpha) {
  const p = (v) => Math.round(clamp(v, 0, 1) * 255);
  return alpha == null || alpha >= 1
    ? `rgb(${p(rgb[0])},${p(rgb[1])},${p(rgb[2])})`
    : `rgba(${p(rgb[0])},${p(rgb[1])},${p(rgb[2])},${alpha})`;
}
/** Luminance-based contrast colour for text drawn on top of `rgb`. */
export function readableOn(rgb) {
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const L = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return L > 0.55 ? '#101216' : '#ffffff';
}

/* ── Misc ───────────────────────────────────────────────────────────────── */

export function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB'];
  let i = -1, v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < u.length - 1);
  return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' ' + u[i];
}

export function formatDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** PDF date string (D:YYYYMMDDHHmmSS+HH'mm') */
export function pdfDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? '+' : '-';
  const at = Math.abs(tz);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(at / 60))}'${p(at % 60)}'`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Very small markdown → HTML for AI answers (headings, lists, code, bold). */
export function miniMarkdown(src) {
  let s = escapeHtml(src || '');
  s = s.replace(/```([\s\S]*?)```/g, (_, c) => `<pre class="mono" style="background:var(--panel-3);padding:8px;border-radius:6px;overflow:auto">${c.trim()}</pre>`);
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/^###### (.*)$/gm, '<b>$1</b>');
  s = s.replace(/^##### (.*)$/gm, '<b>$1</b>');
  s = s.replace(/^#### (.*)$/gm, '<b>$1</b>');
  s = s.replace(/^### (.*)$/gm, '<b>$1</b>');
  s = s.replace(/^## (.*)$/gm, '<b>$1</b>');
  s = s.replace(/^# (.*)$/gm, '<b>$1</b>');
  s = s.replace(/^\s*[-*+] (.*)$/gm, '<li>$1</li>');
  s = s.replace(/^\s*(\d+)\. (.*)$/gm, '<li>$2</li>');
  s = s.replace(/(<li>.*<\/li>)/s, (m) => m); // keep flat
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  // Group consecutive <li> into <ul>
  s = s.replace(/(?:<li>[\s\S]*?<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
  // Paragraphs
  s = s.split(/\n{2,}/).map((blk) => (
    /^\s*<(ul|pre|h|li)/.test(blk) ? blk : `<p>${blk.replace(/\n/g, '<br/>')}</p>`
  )).join('');
  return s;
}

/* ── Toasts ─────────────────────────────────────────────────────────────── */

const TOAST_KINDS = new Set(['ok', 'err', 'warn', 'info']);

export function toast(message, kind = 'info', ms = 3200) {
  const root = document.getElementById('toastRoot');
  if (!root) return;
  // Announce the region to assistive tech (idempotent attribute writes).
  if (root.getAttribute('role') !== 'status') root.setAttribute('role', 'status');
  if (root.getAttribute('aria-live') !== 'polite') root.setAttribute('aria-live', 'polite');
  // Unknown variants degrade to 'info' so a toast is never unstyled.
  const k = TOAST_KINDS.has(kind) ? kind : 'info';
  const t = el('div', { class: `toast ${k}` }, [
    el('span', { class: 'tx', text: message }),
  ]);
  const close = el('button', {
    class: 'icon-btn sm',
    type: 'button',
    'aria-label': 'Dismiss notification',
    html: svgIcon('x', 13, 2),
  });
  close.onclick = () => t.remove();
  t.appendChild(close);
  root.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .2s'; setTimeout(() => t.remove(), 220); }, ms);
  while (root.children.length > 4) root.firstChild.remove();
}

/* ── Tooltips ───────────────────────────────────────────────────────────── */

const TIP_DELAY = 450;
let tipEl = null;
let tipTimer = 0;
let tipTarget = null;
let tipsInitialised = false;

/**
 * Resolve the tooltip text for a node. Reads `data-tip`; falls back to
 * `title` and, when falling back, MOVES the value into `data-tip` and
 * deletes `title` so the native browser tooltip does not double up.
 */
export function tooltipFor(node) {
  if (!node || typeof node.getAttribute !== 'function') return '';
  let text = node.getAttribute('data-tip');
  if (text == null || text === '') {
    if (node.hasAttribute('title')) {
      text = node.getAttribute('title');
      if (text) node.setAttribute('data-tip', text);
      node.removeAttribute('title');
    }
  }
  return text || '';
}

function ensureTipEl() {
  if (tipEl && tipEl.isConnected) return tipEl;
  tipEl = el('div', { class: 'tooltip', role: 'tooltip' });
  return tipEl;
}

function hideTooltip() {
  clearTimeout(tipTimer);
  tipTimer = 0;
  tipTarget = null;
  if (tipEl && tipEl.isConnected) tipEl.remove();
}

function showTooltipFor(node) {
  const text = tooltipFor(node);
  if (!text) return;
  tipTarget = node;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    tipTimer = 0;
    if (tipTarget !== node || !node.isConnected) return;
    const host = document.getElementById('overlayRoot') || document.body;
    const tip = ensureTipEl();
    tip.textContent = text;
    tip.classList.remove('above', 'below');
    tip.classList.add('below');
    host.appendChild(tip);
    const r = node.getBoundingClientRect();
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = r.left + r.width / 2 - tw / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - tw - 4));
    let top = r.bottom + 6;
    if (top + th > window.innerHeight - 4) {
      // Would overflow the bottom edge → flip above the target.
      top = Math.max(4, r.top - th - 6);
      tip.classList.remove('below');
      tip.classList.add('above');
    }
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }, TIP_DELAY);
}

function tipNodeFrom(target) {
  if (!target || typeof target.closest !== 'function') return null;
  if (tipEl && tipEl.contains(target)) return null; // never tip the tooltip
  return target.closest('[data-tip],[title]');
}

/**
 * Event-delegated tooltips. Call once at startup; works for elements created
 * later because every listener sits on `document`.
 */
export function initTooltips() {
  if (tipsInitialised) return;
  tipsInitialised = true;

  document.addEventListener('mouseover', (e) => {
    const node = tipNodeFrom(e.target);
    if (node && node !== tipTarget) showTooltipFor(node);
  });
  document.addEventListener('mouseout', (e) => {
    if (!tipTarget) return;
    const to = e.relatedTarget;
    if (to && (tipTarget === to || tipTarget.contains(to))) return;
    if (tipTarget === e.target || tipTarget.contains(e.target)) hideTooltip();
  });
  document.addEventListener('focusin', (e) => {
    const node = tipNodeFrom(e.target);
    if (node) showTooltipFor(node);
  });
  document.addEventListener('focusout', () => { if (tipTarget) hideTooltip(); });
  // Hide instantly on activation so a tooltip never lingers over a menu.
  document.addEventListener('pointerdown', () => hideTooltip(), true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideTooltip(); }, true);
  window.addEventListener('scroll', () => hideTooltip(), true);
}



export function bytesToDataUrl(bytes, type = 'image/png') {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return `data:${type};base64,${btoa(s)}`;
}

/** Read a File/Blob picked by the user into a Uint8Array. */


/** Word-level diff between two strings → HTML with ins/del spans. */
export function diffHtml(before, after) {
  const a = String(before).split(/(\s+)/);
  const b = String(after).split(/(\s+)/);
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0, j = 0;
  const out = [];
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(escapeHtml(a[i])); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(`<span class="diff-del">${escapeHtml(a[i])}</span>`); i++; }
    else { out.push(`<span class="diff-add">${escapeHtml(b[j])}</span>`); j++; }
  }
  while (i < n) out.push(`<span class="diff-del">${escapeHtml(a[i++])}</span>`);
  while (j < m) out.push(`<span class="diff-add">${escapeHtml(b[j++])}</span>`);
  return out.join('');
}
