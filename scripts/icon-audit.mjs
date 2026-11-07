#!/usr/bin/env node
import './ensure-fixture.mjs';
/**
 * Icon audit — finds every rendered UI icon that is invisible.
 *
 * The AiDM project shipped blank icons because a CSS rule
 * (`.icon { fill: none; stroke: currentColor }`) overrode the SVG's
 * `fill="currentColor"` PRESENTATION ATTRIBUTE (CSS beats attributes), and a
 * second rule killed the stroke — so fill-style icons painted as
 * fill:none + stroke:none = invisible. A CSS diff will not catch that class of
 * bug; you have to ask the live DOM what it actually computed.
 *
 * This launches the real app over CDP, walks every `<svg>` in the chrome, and
 * reports any icon whose *computed* paint makes it invisible, whose path has no
 * geometry, or whose box has collapsed to zero.
 *
 *   node scripts/icon-audit.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9414;

// Per-run userData: the shared profile can keep the renderer stuck mid-boot
// and makes consecutive runs depend on each other's persisted state.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-icon-audit-'));

const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE; // would make require('electron') return the Node binding
const child = spawn(ELECTRON, ['.', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, FIXTURE], { cwd: ROOT, env: childEnv });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});

const list = await (async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const t = (await r.json()).find((x) => x.type === 'page' && x.url.includes('index.html'));
      if (t) return t;
    } catch { /* port not up yet */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
})();
if (!list) { console.log('AUDIT_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(list.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const id = ++mid;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;

for (let i = 0; i < 60; i++) {
  if (await ev('!!window.__aipdfBooted')) break;
  await new Promise((r) => setTimeout(r, 300));
}
await new Promise((r) => setTimeout(r, 2500));

// Every <svg> the app put on screen (chrome only — not the page canvas, which
// is a bitmap, and not the annotation overlay, which is per-page geometry).
const report = await ev(`(function(){
  var out = [];
  var svgs = document.querySelectorAll('svg');
  for (var i = 0; i < svgs.length; i++) {
    var s = svgs[i];
    // skip the annotation overlay: it is a real per-page SVG with page-space geometry
    if (s.closest('.annLayer')) continue;
    var cs = getComputedStyle(s);
    var r = s.getBoundingClientRect();
    var host = s.parentElement;
    var btn = s.closest('button, .icon-btn, .qbtn, .tbtn, .rail-btn, .rbtn, .mini-btn, .mode-tab, .ctx-item, .pitem, .stamp-item, .chip, .cite, .tab');
    var label = (btn && (btn.getAttribute('aria-label') || btn.getAttribute('title'))) || (host && (host.getAttribute('aria-label') || host.getAttribute('title'))) || '';
    var paths = s.querySelectorAll('path');
    var totalD = 0;
    for (var k = 0; k < paths.length; k++) totalD += (paths[k].getAttribute('d') || '').length;
    out.push({
      label: label,
      // A closed findbar / hidden welcome strip / collapsed panel has SVGs in
      // the DOM with a 0x0 rect because an ANCESTOR is display:none. Those are
      // intentionally not on screen; only rendered SVGs can be invisible bugs.
      // getClientRects() is empty for display:none, but still has one (possibly
      // zero-sized) rect for a broken icon that IS laid out.
      rendered: s.getClientRects().length > 0,
      cls: (btn && btn.className) || (host && host.className) || '',
      id: (btn && btn.id) || (host && host.id) || '',
      w: Math.round(r.width), h: Math.round(r.height),
      fill: cs.fill, stroke: cs.stroke, sw: cs.strokeWidth,
      dLen: totalD,
      opacity: cs.opacity, visibility: cs.visibility, display: cs.display,
    });
  }
  return JSON.stringify(out);
})()`);

const icons = JSON.parse(report);
const hidden = icons.filter((i) => !i.rendered).length;
console.log('total chrome <svg> icons: ' + icons.length + ' (' + hidden + ' in hidden panels, skipped)');

function invisible(ic) {
  if (!ic.rendered) return [];
  const reasons = [];
  const fillNone = ic.fill === 'none' || ic.fill === 'rgba(0, 0, 0, 0)';
  const strokeNone = ic.stroke === 'none' || ic.stroke === 'rgba(0, 0, 0, 0)';
  if (fillNone && strokeNone) reasons.push('fill:none + stroke:none (INVISIBLE)');
  if (!ic.dLen) reasons.push('path has no geometry (d empty)');
  if (!ic.w || !ic.h) reasons.push('zero-size box ' + ic.w + 'x' + ic.h);
  if (ic.display === 'none' || ic.visibility === 'hidden' || Number(ic.opacity) === 0) reasons.push('not displayed');
  return reasons;
}

let bad = 0;
for (const ic of icons) {
  const r = invisible(ic);
  if (r.length) {
    bad++;
    console.log('  BAD  ' + (ic.label || ic.id || ic.cls || '(unlabelled)') + '  -> ' + r.join('; ') +
      '   [fill=' + ic.fill + ' stroke=' + ic.stroke + ' dLen=' + ic.dLen + ' ' + ic.w + 'x' + ic.h + ']');
  }
}

// Also report the raw fill/stroke spread so an all-green run is still evidence.
const fills = [...new Set(icons.map((i) => i.fill))];
const strokes = [...new Set(icons.map((i) => i.stroke))];
console.log('distinct computed fill values  : ' + JSON.stringify(fills));
console.log('distinct computed stroke values: ' + JSON.stringify(strokes));
console.log(bad === 0 ? 'ICON AUDIT PASS — no invisible icons' : 'ICON AUDIT FAIL — ' + bad + ' invisible icon(s)');

ws.close();
child.kill();
process.exit(bad === 0 ? 0 : 1);
