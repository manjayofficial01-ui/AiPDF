#!/usr/bin/env node
/**
 * Save reliability: an interrupted write must not cost the user the file.
 *
 * The claim under test is the one in safewrite.js — a save either lands whole or
 * leaves the previous document exactly as it was. The failure is simulated by
 * patching the rename step, because "the power went out during the save" is not
 * something a test can arrange, and rename is the moment the old file stops
 * existing.
 *
 *   node scripts/safewrite-test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeWrite, tmpPathFor } = require('../src/main/safewrite.js');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-safewrite-'));
const target = path.join(dir, 'contract.pdf');
const leftovers = () => fs.readdirSync(dir).filter((n) => n.includes('aipdf-tmp'));

/* ── First write: no previous revision exists to back up ────────────────── */

await safeWrite(target, Buffer.from('V1 signed copy'), {});
check('a new file is written', fs.readFileSync(target, 'utf8') === 'V1 signed copy');
check('no backup is invented for a first save', !fs.existsSync(target + '.bak'));
check('no temp file is left behind', leftovers().length === 0, leftovers().join(','));

/* ── Second write with backup: the previous revision survives ───────────── */

const res = await safeWrite(target, Buffer.from('V2 with redactions applied'), { backup: true });
check('the new bytes land', fs.readFileSync(target, 'utf8') === 'V2 with redactions applied');
check('the previous revision is kept as .bak', fs.readFileSync(target + '.bak', 'utf8') === 'V1 signed copy');
check('the result reports where the backup went', res.backup === target + '.bak', String(res.backup));
check('the backup is replaced, not accumulated', (() => {
  fs.writeFileSync(target, Buffer.from('V3'));
  return true;
})());
await safeWrite(target, Buffer.from('V4'), { backup: true });
check('only one previous version is kept (storage-bounded)',
  fs.readFileSync(target + '.bak', 'utf8') === 'V3', fs.readFileSync(target + '.bak', 'utf8'));

/* ── Interruption: the swap fails after the temp file is written ────────── */

const before = Buffer.from('THE DOCUMENT AS IT WAS');
fs.writeFileSync(target, before);
const realRename = fs.promises.rename.bind(fs.promises);
fs.promises.rename = async () => { throw Object.assign(new Error('SIMULATED CRASH DURING SWAP'), { code: 'EPERM' }); };
let threw = null;
try {
  await safeWrite(target, Buffer.from('PARTIAL / CORRUPT OUTPUT'), { backup: true });
} catch (e) {
  threw = e;
}
check('the failed save reports the error', !!threw && threw.code === 'EPERM', threw && threw.message);
check('the original file is untouched after an interrupted save',
  fs.readFileSync(target) .equals(before), fs.readFileSync(target, 'utf8'));
check('the failed save leaves no temp file in the folder', leftovers().length === 0, leftovers().join(','));
fs.promises.rename = realRename;

/* ── The temp file is a sibling, so the swap stays on one volume ────────── */

check('temp file lives next to the target', path.dirname(tmpPathFor(target)) === dir, tmpPathFor(target));
check('temp file is hidden from casual listing on POSIX-style names', tmpPathFor(target).includes('.contract.pdf'));

fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
