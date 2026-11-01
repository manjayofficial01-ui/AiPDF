#!/usr/bin/env node
/**
 * Verified AI editing — the plan, the approval gate, and the proof.
 *
 * Runs the real application with a scripted model (no network, no key) and
 * checks the behaviour that makes this a different feature from the agent:
 *
 *   1. Planning cannot mutate. A mutating tool called while planning is
 *      refused, and the document is untouched when the plan card appears.
 *   2. Every operation is resolved against the document before the user is
 *      asked to approve it, and one that cannot be applied stays in the plan as
 *      a visible failure instead of vanishing.
 *   3. Nothing is written until the user approves.
 *   4. After approval the change is confirmed by re-reading the candidate file
 *      with an independent extractor — not by trusting the model's claim.
 *   5. Document text reaching the model is fenced as untrusted content.
 *
 *   node scripts/editplan-test.mjs
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = 9472;
const UD = path.join(ROOT, '.smoke', 'editplan-test-ud');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.rmSync(UD, { recursive: true, force: true });
const child = spawn(ELECTRON, ['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
child.stdout.on('data', () => {});
child.stderr.on('data', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page = null;
const deadline = Date.now() + 40000;
while (!page && Date.now() < deadline) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    page = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html')) || null;
  } catch { /* not up */ }
  if (!page) await sleep(400);
}
if (!page) { console.log('EDITPLAN_FAIL no renderer target'); child.kill(); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let mid = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((res, rej) => { const id = ++mid; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
});
await new Promise((r) => ws.addEventListener('open', r));
const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
const evJson = async (expression) => {
  const raw = await ev(expression);
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
};

for (let i = 0; i < 80; i++) { if (await ev('!!window.__aipdfBooted')) break; await sleep(300); }
for (let i = 0; i < 80; i++) { if (await ev(`document.querySelectorAll('#pages .page').length > 0`)) break; await sleep(300); }
await sleep(2000);
await send('Page.bringToFront').catch(() => {});

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };

const PAGE = 4;
const booted = await evJson(`(async function(){
  var st = await import('/js/store.js');
  st.settings.ai = Object.assign({}, st.settings.ai, {
    provider: 'openai', baseUrl: 'https://scripted.invalid/v1', model: 'scripted-model', apiKey: 'test-key',
  });
  st.settings.aiEgress = 'allow';       // consent has its own gate; this test is about planning
  st.settings.aiPlanFirst = true;
  st.saveSettings();
  var d = st.activeDoc();
  var v = await import('/js/viewer.js');
  var t = await v.getPageText(${PAGE - 1});
  return JSON.stringify({ pages: d ? d.numPages : 0, edits: d ? d.textEdits.length : -1, annots: d ? d.annots.length : -1, highlights: d ? d.annots.filter(function (a) { return a.type === 'highlight'; }).length : -1, text: String(t || '').replace(/\\s+/g,' ').slice(0, 90) });
})()`);
check('fixture is open with native text on the page we plan to edit',
  booted && booted.pages >= PAGE && /functional test fixture/.test(booted.text), JSON.stringify(booted));
const baseline = { edits: booted.edits, annots: booted.annots, highlights: booted.highlights };

/* ── The scripted model ─────────────────────────────────────────────────── */

await ev(`(async function(){
  window.__ep = { turns: 0, sawFence: false, sawMutatingRefusal: false, done: false, result: null };
  // A model with no network. Its "reasoning" is fixed, so every assertion below
  // is about what the app does with it rather than about a provider.
  window.__epChat = async function (messages) {
    var last = messages[messages.length - 1];
    window.__ep.turns++;
    // Scan the whole transcript: the refusal and the page text arrive as two
    // separate tool results in the same turn.
    var toolText = JSON.stringify(messages.map(function (m) { return m.content; }).join(' '));
    if (toolText.indexOf('<tool_result') >= 0 && toolText.indexOf('untrusted') >= 0) window.__ep.sawFence = true;
    if (toolText.indexOf('not available while planning') >= 0) window.__ep.sawMutatingRefusal = true;
    if (last && last.role === 'tool') {
      return { text: '', toolCalls: [
        { id: 't3', name: 'propose_plan', args: {
          summary: 'Reword the fixture sentence and highlight the one after it.',
          operations: [
            { op: 'replace_text', page: ${PAGE}, find: 'functional test fixture', replace: 'verified test fixture' },
            { op: 'highlight', page: ${PAGE}, search: 'must be extractable' },
            { op: 'replace_text', page: ${PAGE}, find: 'a phrase that is definitely absent here', replace: 'x' },
            { op: 'delete_pages', pages: '1-${booted.pages}' },
            { op: 'polish_the_prose', page: ${PAGE} },
          ],
          uncertainties: ['The date on page 4 may need checking against page 1.'],
        } },
      ] };
    }
    // Turn 1: try to edit during planning (must be refused), then read a page.
    return { text: '', toolCalls: [
      { id: 't1', name: 'add_text', args: { page: ${PAGE}, text: 'SHOULD NEVER APPEAR' } },
      { id: 't2', name: 'read_page', args: { page: ${PAGE} } },
    ] };
  };
  window.__aipdfRunPlan('Reword page ${PAGE} and highlight the next sentence', window.__epChat)
    .then(function (r) { window.__ep.result = r; window.__ep.done = true; })
    .catch(function (e) { window.__ep.result = { error: String((e && e.message) || e) }; window.__ep.done = true; });
  return 'started';
})()`);

/* ── 1. The plan arrives without the document having changed ────────────── */

let waited = 0;
while (waited < 90000 && !(await ev(`!!document.querySelector('.plan-actions')`))) { await sleep(250); waited += 250; }
const planned = await evJson(`(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('.plan-op'));
  return JSON.stringify({
    card: !!document.querySelector('.plan-actions'),
    rows: rows.length,
    blocked: rows.filter(function (r) { return r.classList.contains('not_found') || r.classList.contains('rejected'); }).length,
    diffs: document.querySelectorAll('.plan-diff').length,
    uncertain: !!document.querySelector('.plan-unc'),
    applyLabel: (document.querySelector('.plan-actions .primary') || {}).textContent || '',
  });
})()`);
check('a plan card is rendered for approval', planned && planned.card, JSON.stringify(planned));
check('every proposed operation is shown, including the ones that cannot run',
  planned && planned.rows === 5 && planned.blocked === 3, `rows=${planned && planned.rows} blocked=${planned && planned.blocked}`);
check('only the resolvable operations are offered for approval',
  planned && /apply 2 operation/.test(planned.applyLabel), planned.applyLabel);
check('the replacement shows before/after text to read, not a count alone',
  planned && planned.diffs >= 1, `diffs=${planned && planned.diffs}`);
check('the model states what it could not verify', planned && planned.uncertain);

const duringPlanning = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var d = st.activeDoc();
  return JSON.stringify({
    edits: d.textEdits.length,
    annots: d.annots.length,
    stray: d.annots.filter(function (a) { return String(a.text || '').indexOf('SHOULD NEVER APPEAR') >= 0; }).length
      + d.textEdits.filter(function (e) { return String(e.text || '').indexOf('SHOULD NEVER APPEAR') >= 0; }).length,
  });
})()`);
check('nothing was mutated while the plan was being drawn up',
  duringPlanning && duringPlanning.edits === baseline.edits && duringPlanning.annots === baseline.annots,
  JSON.stringify(duringPlanning));
check('the refused edit attempt left no trace in the document',
  duringPlanning && duringPlanning.stray === 0, JSON.stringify(duringPlanning));

const scripted = await evJson('JSON.stringify(window.__ep)');
check('a mutating tool called during planning is refused', !!(scripted && scripted.sawMutatingRefusal));
check('page text reached the model fenced as untrusted content', !!(scripted && scripted.sawFence));

/* ── 2. Approval is the gate ────────────────────────────────────────────── */

await ev(`(function(){ document.querySelector('.plan-actions .primary').click(); return 1; })()`);
let w2 = 0;
while (w2 < 120000 && !(await ev('!!window.__ep.done'))) { await sleep(300); w2 += 300; }

const done = await evJson('JSON.stringify(window.__ep.result)');
check('the run completed without throwing', !!done && !done.error, done && done.error);

const after = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var d = st.activeDoc();
  return JSON.stringify({
    edits: d.textEdits.length,
    annots: d.annots.length,
    highlights: d.annots.filter(function (a) { return a.type === 'highlight'; }).length,
    newText: (d.textEdits[0] || {}).text || '',
    plans: (d.editPlans || []).length,
    report: ((d.editPlans || [])[0] || {}).report || '',
  });
})()`);
check('the approved replacement was written into the document',
  /verified test fixture/.test(after.newText) && !/functional test fixture/.test(after.newText), after.newText);
check('the approved highlight was created', after.highlights === baseline.highlights + 1,
  `highlights ${baseline.highlights} → ${after.highlights}`);
check('the operations the plan could not resolve created nothing',
  after.edits === baseline.edits + 1, `edits ${baseline.edits} → ${after.edits}`);

const verdicts = await evJson(`(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('.plan-verdict'));
  return JSON.stringify(rows.map(function (r) { return r.textContent; }));
})()`);
const passLine = (verdicts || []).find((t) => /Replace text/.test(t));
check('the replacement is verified against the rebuilt file, not against the model',
  /^PASS/.test(passLine || '') && /rebuilt file/.test(passLine || ''), passLine);
check('an annotation operation is verified against the annotation layer',
  (verdicts || []).some((t) => /^PASS/.test(t) && /annotation layer/.test(t)), JSON.stringify(verdicts));

const report = after.report || '';
check('an audit record is kept, and it records what was NOT done too',
  /verified AI edit plan/i.test(report) && /Replace text/.test(report) && /Highlight/.test(report)
  && /NOT APPROVED/.test(report) && /scripted-model/.test(report),
  report.replace(/\n/g, ' | ').slice(0, 150));
check('the record says what was verified', /verified: PASS/.test(report), report.split('\n').filter((l) => /verified:/.test(l)).join(' ; '));

const dirty = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var d = st.activeDoc();
  return JSON.stringify({ dirty: !!d.dirty });
})()`);
check('the document is left unsaved for the user to review', dirty && dirty.dirty === true);

await send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
  fs.mkdirSync(path.join(ROOT, '.scratch'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.scratch', 'editplan.png'), Buffer.from(shot.data, 'base64'));
}).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
child.kill();
await sleep(300);
process.exit(failed.length ? 1 : 0);
