import { el, uid } from './util.js';
import { svgIcon } from './icons.js';

const root = () => document.getElementById('overlayRoot');

/* Stack of open modal records. Escape / Ctrl+Enter / Tab-trap handling only
   applies to the topmost entry so nested dialogs behave correctly. */
const stack = [];
let openCount = 0;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Let a dialog be moved by dragging its header.
 *
 * The backdrop centres the modal with a grid, so the first drag detaches it
 * from that centring at the exact pixel it already occupies (fixed left/top),
 * then tracks the pointer. Header buttons — the close X — keep their own
 * click: a press that starts on one never begins a drag. The modal is kept
 * partly on screen so it can always be grabbed again.
 */
function makeDraggable(modalEl, head) {
  const MIN_VISIBLE = 56;          // px of the modal that must stay on screen
  let drag = null;

  // Listen on the window while dragging: the pointer regularly leaves the
  // narrow header, and a capture-phase listener there would drop the gesture.
  const onMove = (e) => {
    if (!drag) return;
    const left = Math.min(window.innerWidth - MIN_VISIBLE,
      Math.max(MIN_VISIBLE - drag.w, drag.left + (e.clientX - drag.x)));
    const top = Math.min(window.innerHeight - MIN_VISIBLE,
      Math.max(0, drag.top + (e.clientY - drag.y)));
    modalEl.style.left = `${left}px`;
    modalEl.style.top = `${top}px`;
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    document.body.classList.remove('modal-dragging');
  };

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // The close button (and anything else interactive) is not a handle.
    if (e.target.closest && e.target.closest('button, a, input, select, textarea, [role="button"]')) return;
    const r = modalEl.getBoundingClientRect();
    // Detach from the grid centring without moving a pixel.
    modalEl.style.position = 'fixed';
    modalEl.style.margin = '0';
    modalEl.style.left = `${r.left}px`;
    modalEl.style.top = `${r.top}px`;
    // Stop the entrance animation: a running transform would override the
    // inline one and make the modal jump on the first drag.
    modalEl.style.animation = 'none';
    modalEl.style.transform = 'none';
    drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top, w: r.width };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onUp, true);
    document.body.classList.add('modal-dragging');
    e.preventDefault();
  });
}

/** Live query of visible, enabled focusable elements inside `container`. */
function focusables(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE)).filter((n) => {
    if (n.disabled) return false;
    if (n.getAttribute('aria-hidden') === 'true') return false;
    const visible = typeof n.checkVisibility === 'function'
      ? n.checkVisibility({ visibilityProperty: true })
      : n.getClientRects().length > 0;
    return visible;
  });
}

/**
 * showModal({ title, width, body, buttons, onMount, dismissible })
 *  - body: HTMLElement, or (container, api) => void
 *  - buttons: [{ label, value, kind, default }]
 * Resolves with the clicked button's `value`, or undefined when dismissed.
 * Accessibility: role="dialog", aria-modal, aria-labelledby, focus trap,
 * focus restore, deterministic initial focus.
 */
export function showModal(opts) {
  const {
    title = '',
    width = '',
    body = null,
    buttons = [{ label: 'OK', value: true, kind: 'primary', default: true }],
    onMount = null,
    dismissible = true,
  } = opts;

  return new Promise((resolve) => {
    let settled = false;
    const prevFocus = document.activeElement;

    const finish = (v) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      const i = stack.indexOf(record);
      if (i !== -1) stack.splice(i, 1);
      backdrop.remove();
      openCount--;
      // Restore focus to whatever had it before the dialog opened.
      try {
        if (prevFocus && prevFocus !== document.body && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
          prevFocus.focus();
        }
      } catch (_) { /* element may have been removed underneath us */ }
      resolve(v);
    };
    const record = { finish };

    const titleId = uid('modal-title-');
    const modalEl = el('div', {
      class: `modal ${width}`,
      role: 'dialog',
      'aria-modal': 'true',
      tabindex: '-1',
    });
    if (title) modalEl.setAttribute('aria-labelledby', titleId);
    else modalEl.setAttribute('aria-label', 'Dialog');
    const head = el('div', { class: 'modal-head' }, [
      el('h3', { id: titleId, text: title }),
    ]);
    if (dismissible) {
      const x = el('button', {
        class: 'icon-btn sm',
        type: 'button',
        'aria-label': 'Close dialog',
        html: svgIcon('x', 15, 2),
      });
      x.onclick = () => finish(undefined);
      head.appendChild(x);
    }
    modalEl.appendChild(head);
    // Every dialog can be moved out of the way by its title bar — a long
    // "Edit text" box over the text you are comparing against is the case
    // that makes this necessary.
    makeDraggable(modalEl, head);

    const bodyEl = el('div', { class: 'modal-body' });
    modalEl.appendChild(bodyEl);

    const foot = el('div', { class: 'modal-foot' });
    modalEl.appendChild(foot);

    if (typeof body === 'function') {
      const r = body(bodyEl, { close: finish });
      if (r instanceof HTMLElement) bodyEl.appendChild(r);
    } else if (body) {
      bodyEl.appendChild(body);
    }

    const api = { close: finish, body: bodyEl, modal: modalEl };
    if (onMount) onMount(api);

    let defaultBtn = null;
    buttons.forEach((b) => {
      const btn = el('button', { class: `${b.kind === 'primary' ? 'primary' : 'ghost'}`, type: 'button', text: b.label });
      if (b.kind === 'danger') {
        btn.style.background = 'var(--danger)';
        btn.style.borderColor = 'var(--danger)';
        btn.style.color = '#fff';
      }
      btn.onclick = () => {
        if (b.validate && b.validate(api) === false) return;
        finish(b.value);
      };
      foot.appendChild(btn);
      if (b.default && !defaultBtn) defaultBtn = btn;
    });

    const backdrop = el('div', { class: 'modal-backdrop' }, [modalEl]);
    if (dismissible) {
      backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) finish(undefined); });
    }

    const onKey = (e) => {
      // Only the topmost modal reacts; nested dialogs each get their turn.
      if (stack[stack.length - 1] !== record) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (dismissible) finish(undefined);
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        const def = buttons.find((b) => b.default);
        if (def) { e.preventDefault(); finish(def.value); }
        return;
      }
      if (e.key === 'Tab') {
        // Focus trap — queried live because dialog bodies add controls dynamically.
        const f = focusables(backdrop);
        if (!f.length) {
          e.preventDefault();
          modalEl.focus();
          return;
        }
        const first = f[0];
        const last = f[f.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !backdrop.contains(active)) { e.preventDefault(); last.focus(); }
        } else if (active === last || !backdrop.contains(active)) {
          e.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);

    root().appendChild(backdrop);
    stack.push(record);
    openCount++;

    // Initial focus after the element is actually in the DOM: prefer the first
    // focusable in the body, fall back to the default button, then the modal.
    requestAnimationFrame(() => {
      if (settled) return;
      const f = focusables(backdrop);
      const inBody = f.find((n) => bodyEl.contains(n));
      const target = inBody || defaultBtn || f[0] || modalEl;
      try { target.focus(); } catch (_) { /* ignore */ }
    });
  });
}

export function confirmDialog(message, opts = {}) {
  return showModal({
    title: opts.title || 'Please confirm',
    width: 'narrow',
    body: (b) => { b.appendChild(el('div', { text: message, style: { lineHeight: '1.5', userSelect: 'text' } })); if (opts.detail) b.appendChild(el('div', { class: 'hint', text: opts.detail, style: { marginTop: '6px' } })); },
    buttons: [
      { label: opts.cancelLabel || 'Cancel', value: false, kind: 'ghost' },
      { label: opts.okLabel || 'OK', value: true, kind: opts.danger ? 'danger' : 'primary', default: true },
    ],
  });
}

export function alertDialog(message, opts = {}) {
  return showModal({
    title: opts.title || 'AiPDF Editor',
    width: opts.width || 'narrow',
    body: (b) => { b.appendChild(el('div', { text: message, style: { lineHeight: '1.55', userSelect: 'text' } })); },
    buttons: [{ label: 'OK', value: true, kind: 'primary', default: true }],
  });
}

export function promptDialog(label, def = '', opts = {}) {
  let value = def;
  return showModal({
    title: opts.title || 'Input',
    width: 'narrow',
    body: (b) => {
      const inp = el('input', { type: opts.type || 'text', value: def });
      b.appendChild(el('div', {}, [el('div', { class: 'hint', text: label, style: { marginBottom: '6px' } }), inp]));
      inp.oninput = () => { value = inp.value; };
      setTimeout(() => { inp.focus(); inp.select(); }, 30);
    },
    buttons: [
      { label: 'Cancel', value: null, kind: 'ghost' },
      { label: opts.okLabel || 'OK', value: true, kind: 'primary', default: true },
    ],
  }).then((ok) => (ok ? value : null));
}

/** A labelled form builder used by most of the tool dialogs. */
export function formRow(label, control, hint) {
  const c = el('div', { class: 'fr-c' }, control);
  const row = el('div', { class: 'form-row' }, [el('label', { text: label }), c]);
  if (hint) row.appendChild(el('div', { class: 'hint', text: hint, style: { marginLeft: '138px', marginTop: '-4px' } }));
  const controls = Array.isArray(control) ? control : [control];
  return { row, control: controls[0] };
}

/**
 * Show a popover anchored to an element. Returns a close function.
 * `anchor` may be a fake object exposing only getBoundingClientRect()
 * (see stamps.js), so it is never treated as a real Element.
 * opts: { left, below, role ('dialog' default | 'menu'), ariaLabel }
 */
export function popover(anchor, content, opts = {}) {
  const p = el('div', {
    class: 'popover',
    role: opts.role === 'menu' ? 'menu' : 'dialog',
    tabindex: '-1',
  });
  p.setAttribute('aria-label', opts.ariaLabel || 'Popover');
  document.getElementById('overlayRoot').appendChild(p);
  p.appendChild(content);
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth, h = p.offsetHeight;
  let left = opts.left != null ? opts.left : r.left;
  let top = opts.below === false ? r.top - h - 6 : r.bottom + 6;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
  p.style.left = left + 'px';
  p.style.top = top + 'px';

  const prevFocus = document.activeElement;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    p.remove();
    try {
      if (prevFocus && prevFocus !== document.body && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
        prevFocus.focus();
      }
    } catch (_) { /* ignore */ }
  };
  const onDoc = (e) => { if (!p.contains(e.target) && e.target !== anchor) close(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); }
  };
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    const f = focusables(p);
    (f[0] || p).focus();
  }, 0);
  return close;
}

/**
 * Context-menu primitive. Builds a `.ctx-menu` at (x, y), clamped to the
 * viewport. items: [{ label, icon, onSelect, disabled, danger, separator }].
 * Closes on outside click, Escape, scroll or window blur; removes every
 * listener it adds. Keyboard: arrows move, Home/End jump, Enter/Space
 * activate (native button behaviour), first enabled item focused on open.
 * Returns close(). NOTE: intentionally does NOT register any `contextmenu`
 * event listener — callers wire that up themselves.
 */
export function contextMenu(x, y, items) {
  const menu = el('div', { class: 'ctx-menu', role: 'menu' });
  const itemEls = [];

  for (const item of items || []) {
    if (!item || item.separator) {
      menu.appendChild(el('div', { class: 'ctx-sep', role: 'separator' }));
      continue;
    }
    const btn = el('button', {
      class: `ctx-item${item.danger ? ' danger' : ''}`,
      type: 'button',
      role: 'menuitem',
    });
    if (item.icon) btn.appendChild(el('span', { class: 'ctx-ico', html: svgIcon(item.icon, 14) }));
    btn.appendChild(el('span', { class: 'ctx-label', text: item.label || '' }));
    if (item.disabled) {
      btn.disabled = true;
      btn.setAttribute('aria-disabled', 'true');
    }
    btn.addEventListener('click', () => {
      if (item.disabled) return;
      close();
      if (typeof item.onSelect === 'function') item.onSelect();
    });
    menu.appendChild(btn);
    itemEls.push(btn);
  }

  const host = root() || document.body;
  host.appendChild(menu);

  // Clamp to viewport after measuring.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const left = Math.max(4, Math.min(x, window.innerWidth - w - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - h - 4));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('blur', onWinBlur);
    window.removeEventListener('scroll', onScroll, true);
    menu.remove();
  }

  const onDocDown = (e) => { if (!menu.contains(e.target)) close(); };
  const onWinBlur = () => close();
  const onScroll = (e) => { if (!menu.contains(e.target)) close(); };

  const move = (fromIdx, dir) => {
    if (!itemEls.length) return;
    let i = fromIdx;
    for (let n = 0; n < itemEls.length; n++) {
      i = (i + dir + itemEls.length) % itemEls.length;
      const cand = itemEls[i];
      if (!cand.disabled) { cand.focus(); return; }
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    const idx = itemEls.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); move(idx, 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(idx === -1 ? 0 : idx, -1); }
    else if (e.key === 'Home') { e.preventDefault(); const t = itemEls.find((b) => !b.disabled); if (t) t.focus(); }
    else if (e.key === 'End') { e.preventDefault(); for (let i = itemEls.length - 1; i >= 0; i--) { if (!itemEls[i].disabled) { itemEls[i].focus(); break; } } }
    else if (e.key === ' ') { e.preventDefault(); if (idx !== -1) itemEls[idx].click(); }
    else if (e.key === 'Tab') { e.preventDefault(); } // menus do not tab out; Escape or click closes
  };

  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('blur', onWinBlur);
  window.addEventListener('scroll', onScroll, true);

  const firstEnabled = itemEls.find((b) => !b.disabled);
  if (firstEnabled) firstEnabled.focus();
  else menu.setAttribute('tabindex', '-1'), menu.focus();

  return close;
}
