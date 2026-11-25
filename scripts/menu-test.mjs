#!/usr/bin/env node
import { electronPath, launchElectron } from './lib/electron-harness.mjs';
/**
 * Native-menu wiring check.
 *
 * Builds the real application menu in a throwaway Electron process and asserts:
 *   - Edit ▸ Select Tool / Hand Tool exist and dispatch tool:select / tool:hand
 *   - no menu item uses a BARE-LETTER accelerator (the renderer keymap owns
 *     bare letters; a native one fires even while a text field has focus and
 *     would steal the keystroke from the find bar)
 *   - Help ▸ Start page is present
 *
 *   env -u ELECTRON_RUN_AS_NODE node scripts/menu-test.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = electronPath();
const PROBE = path.join(ROOT, '.smoke', 'menu-probe.cjs');

fs.mkdirSync(path.dirname(PROBE), { recursive: true });
fs.writeFileSync(PROBE, `
const { app } = require('electron');
app.whenReady().then(() => {
  const { buildMenu } = require(${JSON.stringify(path.join(ROOT, 'src', 'main', 'menu.js'))});
  const sent = [];
  const menu = buildMenu((a) => sent.push(a), { recents: [] });
  const flat = [];
  const walk = (items, trail) => {
    for (const it of items) {
      if (it.type === 'separator') continue;
      const label = String(it.label || '').replace('&', '');
      const here = trail ? trail + ' > ' + label : label;
      flat.push({ path: here, label, accelerator: it.accelerator || null, hasSub: !!it.submenu });
      if (it.submenu) walk(it.submenu.items, here);
    }
  };
  walk(menu.items, '');
  const edit = menu.items.find((i) => String(i.label).replace('&','') === 'Edit');
  const find = (l) => edit ? edit.submenu.items.find((i) => i.label === l) : null;
  const sel = find('Select Tool');
  const hand = find('Hand Tool');
  if (sel) sel.click();
  if (hand) hand.click();
  console.log('MENU_JSON ' + JSON.stringify({ flat, sent }));
  app.quit();
});
`);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const out = await new Promise((resolve) => {
  const child = launchElectron([PROBE], { cwd: ROOT, env });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', () => {});
  const t = setTimeout(() => { try { child.kill(); } catch {} resolve(buf); }, 45000);
  child.on('exit', () => { clearTimeout(t); resolve(buf); });
});

const m = out.match(/MENU_JSON (\{.*\})/);
if (!m) { console.log('MENU_FAIL no MENU_JSON in output'); process.exit(1); }
const { flat, sent } = JSON.parse(m[1]);

const editSelect = flat.find((x) => x.path === 'Edit > Select Tool');
const editHand = flat.find((x) => x.path === 'Edit > Hand Tool');
check('Edit menu exposes Select Tool', !!editSelect);
check('Edit menu exposes Hand Tool', !!editHand);
check('Select Tool dispatches tool:select', sent.includes('tool:select'), JSON.stringify(sent));
check('Hand Tool dispatches tool:hand', sent.includes('tool:hand'), JSON.stringify(sent));

// A bare letter accelerator would be a single character with no '+'.
const bare = flat.filter((x) => x.accelerator && !/\+/.test(x.accelerator));
check('no bare-letter accelerators (they would hijack typing)', bare.length === 0,
  bare.length ? bare.map((b) => `${b.path}=${b.accelerator}`).join(', ') : `${flat.filter((x) => x.accelerator).length} modifier combos`);

check('Help menu still offers the Start page', !!flat.find((x) => x.path.startsWith('Help > Start page')));

try { fs.unlinkSync(PROBE); } catch { /* gone */ }

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nMENU_FAIL ${failed.length}/${results.length} checks failed` : `\nMENU_PASS all ${results.length} checks green`);
process.exit(failed.length ? 1 : 0);
