#!/usr/bin/env node
import { electronPath, launchElectron, freePort } from './lib/electron-harness.mjs';
import './ensure-fixture.mjs';
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
import { inflateSync } from 'node:zlib';
import * as PL from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = electronPath();
const FIXTURE = path.join(ROOT, '.fixtures', 'fixture.pdf');
const PORT = await freePort();
// A fresh profile per run. Never delete a fixed .smoke/ profile: the
// safe-delete shim routes recursive deletes to the OS trash and fails closed
// once a Chromium profile grows past ~50 files, which aborted this suite.
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'aipdf-editplan-ud-'));

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = launchElectron(['.', FIXTURE, `--remote-debugging-port=${PORT}`, `--user-data-dir=${UD}`], { cwd: ROOT, env });
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
const ev = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
};
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

const TITLE = 'AiPDF Editor verified test fixture.';

/* The shared block model must retain source-run colour evidence. pdf.js does
   not put colour on TextItem, so the plan resolver registers the operator-list
   evidence on the exact text-content object before grouping. These pure checks
   fail if the model flattens every native block back to black. */
const textblocks = await import('../src/renderer/js/textblocks.js');
function nativeColourFixture(colourPairs) {
  const prefix = 'AiPDF Editor ';
  const suffix = 'verified test fixture.';
  return {
    items: [
      { str: prefix, transform: [16, 0, 0, 16, 50, 760], width: 96, height: 16, fontName: 'f1', hasEOL: false },
      { str: suffix, transform: [16, 0, 0, 16, 146, 760], width: 140, height: 16, fontName: 'f1', hasEOL: false },
    ],
    styles: { f1: { fontFamily: 'sans-serif', ascent: 0.718, descent: -0.207, vertical: false } },
    sourceColours: new Map([
      [0, { colors: [colourPairs[0]], fonts: ['F1'] }],
      [1, { colors: [colourPairs[1]], fonts: ['F1'] }],
    ]),
  };
}
let uniformColourBlock = null;
let mixedColourBlock = null;
let uncertainColourBlock = null;
if (typeof textblocks.setTextSourceColors === 'function') {
  const uniformTc = nativeColourFixture([[1, 0, 0], [1, 0, 0]]);
  textblocks.setTextSourceColors(uniformTc, uniformTc.sourceColours);
  uniformColourBlock = textblocks.groupTextBlocks(uniformTc, 595)[0];
  const mixedTc = nativeColourFixture([[1, 0, 0], [0, 0, 1]]);
  textblocks.setTextSourceColors(mixedTc, mixedTc.sourceColours);
  mixedColourBlock = textblocks.groupTextBlocks(mixedTc, 595)[0];
  const uncertainTc = nativeColourFixture([[1, 0, 0], [1, 0, 0]]);
  uncertainTc.sourceColours.forEach((entry) => { entry.colorCertain = false; });
  textblocks.setTextSourceColors(uncertainTc, uncertainTc.sourceColours);
  uncertainColourBlock = textblocks.groupTextBlocks(uncertainTc, 595)[0];
}
check('the native block model retains one actual source-run colour',
  !!uniformColourBlock && uniformColourBlock.text === TITLE && uniformColourBlock.colorCertain === true
  && JSON.stringify(uniformColourBlock.color) === JSON.stringify([1, 0, 0])
  && JSON.stringify(uniformColourBlock.colors) === JSON.stringify([[1, 0, 0]]),
  JSON.stringify(uniformColourBlock && { color: uniformColourBlock.color, colors: uniformColourBlock.colors }));
check('the native block model retains mixed source-run colours instead of flattening them',
  !!mixedColourBlock && mixedColourBlock.colorCertain === true
  && JSON.stringify(mixedColourBlock.colors) === JSON.stringify([[1, 0, 0], [0, 0, 1]]),
  JSON.stringify(mixedColourBlock && { color: mixedColourBlock.color, colors: mixedColourBlock.colors }));
check('the native block model keeps uncertain source colour evidence marked uncertain',
  !!uncertainColourBlock && uncertainColourBlock.colorCertain === false,
  JSON.stringify(uncertainColourBlock && { color: uncertainColourBlock.color, colorCertain: uncertainColourBlock.colorCertain }));

// The canonical fixture from make-fixtures.mjs carries the "functional test
// fixture" sentence on its FIRST page. Older runs used a drifted 4-page
// save-over file; pinning the test to that artifact made it fail whenever the
// fixture guard restored the real document.
const PAGE = 1;
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
  return JSON.stringify({ pages: d ? d.numPages : 0, edits: d ? d.textEdits.length : -1, annots: d ? d.annots.length : -1, stamps: d ? d.stamps.length : -1, highlights: d ? d.annots.filter(function (a) { return a.type === 'highlight'; }).length : -1, text: String(t || '').replace(/\\s+/g,' ').slice(0, 90) });
})()`);
check('fixture is open with native text on the page we plan to edit',
  booted && booted.pages >= PAGE && /functional test fixture/.test(booted.text), JSON.stringify(booted));
const baseline = { edits: booted.edits, annots: booted.annots, stamps: booted.stamps, highlights: booted.highlights };

/* ── Provider selection during first-time configuration ──────────────────── */

const configurationRequests = [];
const configurationServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    configurationRequests.push(JSON.parse(body));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'not json' }, finish_reason: 'stop' }] }));
  });
});
await new Promise((resolve) => configurationServer.listen(0, '127.0.0.1', resolve));
const configurationUrl = `http://127.0.0.1:${configurationServer.address().port}/v1`;
try {
  const configuredAnna = await evJson(`(async function(){
    var st = await import('/js/store.js');
    var savedAi = st.settings.ai;
    var savedEgress = st.settings.aiEgress;
    var savedAnna = window.AIPDF_ANNA;
    var annaSelected = false;
    window.AIPDF_ANNA = true;
    st.settings.ai = {};
    st.settings.aiEgress = 'ask';
    st.saveSettings();
    window.__epConfiguredAnna = { done: false, result: null };
    window.__aipdfRunPlan('Make the document title on page 1 blue', null)
      .then(function (r) { window.__epConfiguredAnna.result = r; window.__epConfiguredAnna.done = true; })
      .catch(function (e) { window.__epConfiguredAnna.result = { error: String(e) }; window.__epConfiguredAnna.done = true; });
    for (var i = 0; i < 100 && !document.querySelector('.modal'); i++) {
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    var preset = document.querySelector('.modal select');
    if (preset) {
      preset.value = '0';
      preset.dispatchEvent(new Event('change'));
      document.querySelector('.modal-foot button.primary').click();
    }
    var consent = null;
    for (var j = 0; j < 100 && !(consent = document.querySelector('.modal')); j++) {
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    if (consent) {
      annaSelected = st.settings.ai.baseUrl === 'anna://host';
      // Keep the branch decision made after configuration, but route the actual
      // request to this suite's local scripted endpoint instead of a live host.
      st.settings.ai = { provider: 'openai', baseUrl: '${configurationUrl}', model: 'scripted-model', authMode: 'none', apiKey: '' };
      consent.querySelector('.modal-foot button.primary').click();
    }
    for (var k = 0; k < 200 && !window.__epConfiguredAnna.done; k++) {
      await new Promise(function (resolve) { setTimeout(resolve, 50); });
    }
    var result = {
      annaSelected: annaSelected,
      modalOpened: !!preset,
      consentOpened: !!consent,
      run: window.__epConfiguredAnna,
    };
    window.AIPDF_ANNA = savedAnna;
    st.settings.ai = savedAi;
    st.settings.aiEgress = savedEgress;
    return JSON.stringify(result);
  })()`);
  const request = configurationRequests[0];
  check('a provider selected during first-time configuration uses the Anna structured planner',
    configuredAnna && configuredAnna.modalOpened && configuredAnna.consentOpened && configuredAnna.annaSelected
    && configurationRequests.length === 1 && request && !('tools' in request) && !configuredAnna.run.error,
    JSON.stringify({ calls: configurationRequests.length, tools: request && 'tools' in request, error: configuredAnna && configuredAnna.run.error }));
  const visualMessage = request?.messages?.find(function (message) { return message.role === 'user'; });
  check('Anna visual planning includes a consented page image for title edits',
    Array.isArray(visualMessage?.content) && visualMessage.content.some(function (part) { return part.type === 'image_url'; }),
    JSON.stringify(visualMessage?.content?.map(function (part) { return part.type; }) || []));
} finally {
  await new Promise((resolve) => configurationServer.close(resolve));
}

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
            { op: 'constructor', page: ${PAGE}, text: 'SHOULD NEVER APPEAR' },
            { op: 'toString', page: ${PAGE}, text: 'SHOULD NEVER APPEAR' },
            { op: '__proto__', page: ${PAGE}, text: 'SHOULD NEVER APPEAR' },
          ],
          uncertainties: ['The date on page 1 may need checking against the source.'],
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
while (waited < 90000 && !(await ev(`!!window.__ep.done || !!document.querySelector('.plan-actions')`))) { await sleep(250); waited += 250; }
const planned = await evJson(`(function(){
  var rows = Array.prototype.slice.call(document.querySelectorAll('.plan-op'));
  return JSON.stringify({
    card: !!document.querySelector('.plan-actions'),
    rows: rows.length,
    blocked: rows.filter(function (r) { return r.classList.contains('not_found') || r.classList.contains('rejected'); }).length,
    diffs: document.querySelectorAll('.plan-diff').length,
    uncertain: !!document.querySelector('.plan-unc'),
    applyLabel: (document.querySelector('.plan-actions .primary') || {}).textContent || '',
    runDone: !!window.__ep.done, runError: window.__ep.error,
    runMessage: (function(){ var n = document.querySelector('.msg.ai:last-child'); return n ? n.textContent.replace(/\\s+/g, ' ').slice(-1600) : ''; })(),
  });
})()`);
check('a plan card is rendered for approval', planned && planned.card, JSON.stringify(planned));
check('every proposed operation is shown, including the ones that cannot run',
  planned && planned.rows === 8 && planned.blocked === 6, `rows=${planned && planned.rows} blocked=${planned && planned.blocked}`);
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
    stamps: d.stamps.length,
    stray: d.annots.filter(function (a) { return String(a.text || '').indexOf('SHOULD NEVER APPEAR') >= 0; }).length
      + d.textEdits.filter(function (e) { return String(e.text || '').indexOf('SHOULD NEVER APPEAR') >= 0; }).length,
  });
})()`);
check('nothing was mutated while the plan was being drawn up',
  duringPlanning && duringPlanning.edits === baseline.edits && duringPlanning.annots === baseline.annots
  && duringPlanning.stamps === baseline.stamps,
  JSON.stringify(duringPlanning));
check('the refused edit attempt left no trace in the document',
  duringPlanning && duringPlanning.stray === 0, JSON.stringify(duringPlanning));

const scripted = await evJson('JSON.stringify(window.__ep)');
check('a mutating tool called during planning is refused', !!(scripted && scripted.sawMutatingRefusal));
check('page text reached the model fenced as untrusted content', !!(scripted && scripted.sawFence));

/* ── 2. Approval is the gate ────────────────────────────────────────────── */

if (!planned.card) {
  child.kill();
  await sleep(300);
  process.exit(1);
}
await ev(`(function(){ document.querySelector('.plan-actions .primary').click(); return 1; })()`);
let w2 = 0;
while (w2 < 120000 && !(await ev('!!window.__ep.done'))) { await sleep(300); w2 += 300; }

const done = await evJson('JSON.stringify(window.__ep.result)');
check('the run completed without throwing', !!done && !done.error, done && done.error);

const inheritedOps = ((done && done.plan && done.plan.ops) || [])
  .filter((op) => ['constructor', 'toString', '__proto__'].includes(op.kind));
check('prototype-chain operation names are rejected instead of becoming ready actions',
  inheritedOps.length === 3 && inheritedOps.every((op) => op.status === 'rejected' && op.label === 'Unknown operation'),
  JSON.stringify(inheritedOps.map(({ kind, status, label }) => ({ kind, status, label }))));

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
    inheritedStray: (d.textEdits || []).concat(d.annots || [], d.stamps || [])
      .filter(function (item) { return String(item.text || '').indexOf('SHOULD NEVER APPEAR') >= 0; }).length,
  });
})()`);
check('the approved replacement was written into the document',
  /verified test fixture/.test(after.newText) && !/functional test fixture/.test(after.newText), after.newText);
check('the approved highlight was created', after.highlights === baseline.highlights + 1,
  `highlights ${baseline.highlights} → ${after.highlights}`);
check('the operations the plan could not resolve created nothing',
  after.edits === baseline.edits + 1 && after.inheritedStray === 0,
  `edits ${baseline.edits} → ${after.edits}, inherited-name artifacts=${after.inheritedStray}`);

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

/* ── 3. Typed, deterministic AI page numbering ─────────────────────────── */

const planSelf = await evJson('JSON.stringify(window.__aipdfAgentSelfTest())');
check('the plan self-test admits fourteen operations including exact title colouring and restyling',
  !!(planSelf && planSelf.passed && planSelf.checks.plan_formatTextColor),
  JSON.stringify(planSelf));

// A manual stamp must survive; a stale AI-group stamp must not. This is test
// setup, not an AI mutation, and gives the planning-no-mutation check a baseline.
await ev(`(async function(){
  var st = await import('/js/store.js');
  var d = st.activeDoc();
  d.stamps.push(
    { id: 'manual-footer', kind: 'footer', text: 'MANUAL', align: 'center', fontSize: 10, color: [0.4, 0.4, 0.4], from: 1, to: 1 },
    { id: 'ai-page-numbers', kind: 'footer', text: 'MANUAL GROUP LOOKALIKE', align: 'center', fontSize: 10, color: [0.4, 0.4, 0.4], from: 1, to: 1 },
    { id: 'ai-page-number-1', kind: 'footer', text: 'MANUAL ID LOOKALIKE', align: 'center', fontSize: 10, color: [0.4, 0.4, 0.4], from: 1, to: 1 },
    { id: 'ai-page-numbers-99', kind: 'footer', text: 'STALE', align: 'center', fontSize: 10, color: [0.4, 0.4, 0.4], from: 3, to: 3 }
  );
  return d.stamps.length;
})()`);

async function beginNumberPlan(goal, operations, corruption = '') {
  await ev(`(async function(){
    var ep = await import('/js/editplan.js');
    var app = await import('/js/app.js');
    var st = await import('/js/store.js');
    var d = st.activeDoc();
    var priorNodes = document.querySelectorAll('.msg.ai');
    var priorNode = priorNodes[priorNodes.length - 1];
    window.__epNumber = {
      done: false, result: null, error: null, beforeNodeId: priorNode ? priorNode.dataset.id : '',
      doc: d, pdf: d.pdf, bytes: d.bytes, stampsBefore: JSON.stringify(d.stamps),
      model: st.settings.ai.model, schema: null, cardReady: false,
    };
    var deps = {
      app: { buildDocBytes: app.buildDocBytes, extractTextFromBytes: app.extractTextFromBytes, saveDoc: app.saveDoc },
      chat: async function (messages, options) {
        var spec = (options.tools || []).find(function (tool) { return tool.function && tool.function.name === 'propose_plan'; });
        window.__epNumber.schema = spec ? spec.function.parameters.properties.operations.items.properties : null;
        return { text: '', toolCalls: [{ id: 'number-plan', name: 'propose_plan', args: {
          summary: 'Apply the requested page numbering.', operations: ${JSON.stringify(operations)},
        } }] };
      },
    };
    var mode = ${JSON.stringify(corruption)};
    if (mode === 'duplicate-text') {
      deps.app.extractTextFromBytes = async function (bytes) {
        var texts = await app.extractTextFromBytes(bytes);
        texts[1] += ' Page 5 of 3';
        return texts;
      };
    } else if (mode === 'missing-text') {
      deps.app.extractTextFromBytes = async function (bytes) {
        var texts = await app.extractTextFromBytes(bytes);
        texts[1] = texts[1].split('Page 5 of 3').join('');
        return texts;
      };
    } else if (mode === 'wrong-page') {
      deps.app.extractTextFromBytes = async function (bytes) {
        var texts = await app.extractTextFromBytes(bytes);
        texts[1] = texts[1].split('Page 5 of 3').join('');
        texts[0] += ' Page 5 of 3';
        return texts;
      };
    } else if (mode === 'duplicate-group') {
      deps.app.buildDocBytes = async function (doc) {
        var original = doc.stamps.find(function (stamp) { return stamp.id === 'ai-page-numbers-2'; });
        if (!original) throw new Error('The numbering test did not create its target stamp.');
        // Empty text keeps the rebuilt candidate unique while the AI group itself
        // contains a duplicate target-page stamp.
        doc.stamps.push({ ...original, id: 'ai-page-numbers-2-copy', text: '' });
        return app.buildDocBytes(doc);
      };
    }
    ep.runVerifiedEdit(${JSON.stringify(goal)}, deps)
      .then(function (result) { window.__epNumber.result = result; window.__epNumber.done = true; })
      .catch(function (error) { window.__epNumber.error = String(error); window.__epNumber.done = true; });
    return 'started';
  })()`);

  let waited = 0;
  while (waited < 30000 && !(await ev(`window.__epNumber.done || (function(){
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    return node && node.dataset.id !== window.__epNumber.beforeNodeId && !!node.querySelector('.plan-actions');
  })()`))) {
    await sleep(100);
    waited += 100;
  }
  return inspectNumberPlan();
}

async function inspectNumberPlan() {
  return evJson(`(async function(){
    var run = window.__epNumber;
    var st = await import('/js/store.js');
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    var card = node ? node.querySelector('.plan-actions') : null;
    var host = card ? card.closest('.msg') : node;
    var rows = host ? Array.prototype.slice.call(host.querySelectorAll('.plan-op')) : [];
    run.cardReady = !!card;
    return JSON.stringify({
      done: run.done, error: run.error, card: !!card,
      rows: rows.map(function (row) {
        return {
          title: (row.querySelector('.plan-op-title') || {}).textContent || '',
          status: ['ready', 'rejected', 'not_found'].find(function (name) { return row.classList.contains(name); }) || '',
          reason: (row.querySelector('.plan-fail') || {}).textContent || '',
        };
      }),
      blocked: rows.filter(function (row) { return row.classList.contains('rejected') || row.classList.contains('not_found'); }).length,
      applyLabel: card ? (card.querySelector('.primary') || {}).textContent || '' : '',
      failures: host ? Array.prototype.slice.call(host.querySelectorAll('.plan-fail')).map(function (row) { return row.textContent; }) : [],
      dead: node && node.querySelector('.plan-dead') ? node.querySelector('.plan-dead').textContent : '',
      stampsUnchanged: JSON.stringify(run.doc.stamps) === run.stampsBefore,
      sameDoc: st.activeDoc() === run.doc,
      samePdf: st.activeDoc() === run.doc && run.doc.pdf === run.pdf,
      modelUnchanged: st.settings.ai.model === run.model,
      schema: run.schema,
    });
  })()`);
}

async function approveNumberPlan() {
  const clicked = await ev(`(function(){
    var run = window.__epNumber;
    if (!run.cardReady) return 0;
    var nodes = document.querySelectorAll('.msg.ai');
    var card = nodes[nodes.length - 1].querySelector('.plan-actions');
    card.querySelector('.primary').click();
    return 1;
  })()`);
  if (!clicked) return null;
  let waited = 0;
  while (waited < 120000 && !(await ev('!!window.__epNumber.done'))) { await sleep(100); waited += 100; }
  return evJson('JSON.stringify(window.__epNumber.result)');
}

async function numberState() {
  return evJson(`(async function(){
    var run = window.__epNumber;
    var st = await import('/js/store.js');
    var app = await import('/js/app.js');
    var d = run.doc;
    var texts = await app.extractTextFromBytes(await app.buildDocBytes(d));
    return JSON.stringify({
      ai: d.stamps.filter(function (stamp) { return String(stamp.id || '').indexOf('ai-page-numbers-') === 0; }).map(function (stamp) {
        return { id: stamp.id, text: stamp.text, kind: stamp.kind, align: stamp.align, fontSize: stamp.fontSize,
          color: stamp.color, from: stamp.from, to: stamp.to, behind: stamp.behind, odd: stamp.odd };
      }),
      allIds: d.stamps.map(function (stamp) { return stamp.id; }),
      manual: d.stamps.find(function (stamp) { return stamp.id === 'manual-footer'; }) || null,
      sameDoc: st.activeDoc() === d,
      samePdf: d.pdf === run.pdf,
      sameBytes: d.bytes === run.bytes,
      model: st.settings.ai.model,
      modelUnchanged: st.settings.ai.model === run.model,
      dirty: !!d.dirty,
      candidate: texts,
    });
  })()`);
}

const countText = (text, needle) => String(text || '').split(needle).length - 1;
const defaultExpected = [
  { page: 0, text: 'Page 1 of 3' },
  { page: 1, text: 'Page 2 of 3' },
  { page: 2, text: 'Page 3 of 3' },
];
const rangedExpected = [
  { page: 1, text: 'Page 5 of 3' },
  { page: 2, text: 'Page 6 of 3' },
];
const rangedOp = {
  op: 'add_page_numbers', format: 'n-of-N', from: 2, to: 3, start: 5,
  position: 'header', align: 'right', fontSize: 14, color: '#336699',
};
const numberVerificationOp = { ...rangedOp, fontSize: 15 };

const defaultPlan = await beginNumberPlan('Add Page 1 of N to every page', [{ op: 'add_page_numbers' }]);
const numberFields = defaultPlan.schema || {};
check('the plan schema exposes all typed page-number fields',
  !!defaultPlan.schema && ['format', 'from', 'to', 'start', 'position', 'align', 'fontSize', 'color']
    .every((field) => Object.hasOwn(numberFields, field))
  && numberFields.op.enum.includes('add_page_numbers')
  && numberFields.position.enum.join(',') === 'header,footer'
  && numberFields.align.enum.join(',') === 'left,center,right'
  && numberFields.fontSize.minimum === 4 && numberFields.fontSize.maximum === 120
  && numberFields.color.pattern === '^#[0-9A-Fa-f]{6}$',
  JSON.stringify(Object.keys(numberFields)));
check('a natural every-page numbering request resolves one ready operation without mutation',
  booted.pages === 3 && defaultPlan.card && defaultPlan.rows.length === 1 && defaultPlan.blocked === 0
  && defaultPlan.rows[0].status === 'ready' && /apply 1 operation/i.test(defaultPlan.applyLabel)
  && defaultPlan.stampsUnchanged,
  JSON.stringify({ rows: defaultPlan.rows, applyLabel: defaultPlan.applyLabel, stampsUnchanged: defaultPlan.stampsUnchanged }));

const defaultRun = await approveNumberPlan();
const defaultOp = defaultRun && defaultRun.plan.ops[0];
check('default numbering resolves the full 1-based page range and expected texts',
  !!defaultOp && defaultOp.status === 'ready'
  && JSON.stringify(defaultOp.args) === JSON.stringify({ format: 'n-of-N', from: 1, to: 3, start: 1, position: 'footer', align: 'center', fontSize: 10, color: '#666666' })
  && JSON.stringify(defaultOp.expected) === JSON.stringify(defaultExpected),
  JSON.stringify(defaultOp && { args: defaultOp.args, expected: defaultOp.expected }));

const defaultState = await numberState();
check('numbering appends one deterministic stamp per page and preserves manual stamps',
  JSON.stringify(defaultState.ai.map((s) => s.id)) === JSON.stringify(['ai-page-numbers-1', 'ai-page-numbers-2', 'ai-page-numbers-3'])
  && JSON.stringify(defaultState.ai.map((s) => s.text)) === JSON.stringify(defaultExpected.map((e) => e.text))
  && defaultState.ai.every((s) => s.kind === 'footer' && s.align === 'center' && s.fontSize === 10 && s.from === s.to)
  && defaultState.ai.every((s) => JSON.stringify(s.color) === JSON.stringify([0.4, 0.4, 0.4]))
  && !!defaultState.manual && !defaultState.allIds.includes('ai-page-numbers-99')
  && defaultState.allIds.includes('ai-page-numbers') && defaultState.allIds.includes('ai-page-number-1'),
  JSON.stringify(defaultState.ai));
const defaultVerdict = defaultRun && defaultRun.verdicts.find((v) => v.kind === 'add_page_numbers');
check('candidate verification confirms each default number exactly once on its target page',
  !!defaultVerdict && defaultVerdict.ok === true && /exactly once/i.test(defaultVerdict.detail)
  && defaultExpected.every((e) => countText(defaultState.candidate[e.page], e.text) === 1),
  JSON.stringify(defaultVerdict));
check('AI numbering keeps the same document, PDF, bytes, and inherited model selection',
  defaultState.sameDoc && defaultState.samePdf && defaultState.sameBytes && defaultState.modelUnchanged && defaultState.dirty,
  JSON.stringify({ sameDoc: defaultState.sameDoc, samePdf: defaultState.samePdf, sameBytes: defaultState.sameBytes, model: defaultState.model }));

const rangedPlan = await beginNumberPlan('Number pages 2 through 3 starting at 5', [rangedOp]);
check('a custom numbering range resolves only its target pages', rangedPlan.card && rangedPlan.rows.length === 1
  && rangedPlan.rows[0].status === 'ready' && rangedPlan.stampsUnchanged, JSON.stringify(rangedPlan.rows));
const rangedRun = await approveNumberPlan();
const rangedResolved = rangedRun && rangedRun.plan.ops[0];
const rangedState = await numberState();
check('range, start, placement, alignment, size, and color reach the stamp writer',
  !!rangedResolved && JSON.stringify(rangedResolved.expected) === JSON.stringify(rangedExpected)
  && JSON.stringify(rangedState.ai.map((s) => [s.id, s.text, s.kind, s.align, s.fontSize, s.from, s.to])) === JSON.stringify([
    ['ai-page-numbers-2', 'Page 5 of 3', 'header', 'right', 14, 2, 2],
    ['ai-page-numbers-3', 'Page 6 of 3', 'header', 'right', 14, 3, 3],
  ])
  && rangedState.ai.every((s) => JSON.stringify(s.color) === JSON.stringify([0.2, 0.4, 0.6]))
  && !!rangedState.manual,
  JSON.stringify(rangedState.ai));
const rangedVerdict = rangedRun && rangedRun.verdicts.find((v) => v.kind === 'add_page_numbers');
check('the rebuilt candidate contains each custom-range number exactly once',
  !!rangedVerdict && rangedVerdict.ok === true
  && rangedExpected.every((e) => countText(rangedState.candidate[e.page], e.text) === 1),
  JSON.stringify(rangedVerdict));

await beginNumberPlan('Apply the same page numbering again', [rangedOp]);
await ev(`(function(){
  return import('/js/store.js').then(function (mod) {
    var d = window.__epNumber.doc;
    window.__epNumberRepeatRefs = d.stamps.slice();
    window.__epNumberRepeatBefore = { history: d.history.length, dirty: !!d.dirty, plans: (d.editPlans || []).length };
    window.__epNumberRepeatDirtyEvents = 0;
    window.__epNumberRepeatDirtyOff = mod.on('dirty', function (doc) {
      if (doc === d) window.__epNumberRepeatDirtyEvents++;
    });
    return 1;
  });
})()`);
const numberRepeatBefore = await evJson('JSON.stringify(window.__epNumberRepeatBefore)');
const rerun = await approveNumberPlan();
const rerunState = await numberState();
const rerunEffects = await evJson(`(function(){
  return import('/js/store.js').then(function (mod) {
    if (window.__epNumberRepeatDirtyOff) window.__epNumberRepeatDirtyOff();
    var d = window.__epNumber.doc;
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    var refs = window.__epNumberRepeatRefs;
    return JSON.stringify({
      history: d.history.length, dirty: !!d.dirty, plans: (d.editPlans || []).length,
      dirtyEvents: window.__epNumberRepeatDirtyEvents,
      sameStampObjects: refs.length === d.stamps.length && refs.every(function (stamp, index) { return stamp === d.stamps[index]; }),
      footer: !!(node && node.querySelector('.plan-foot')),
      message: node ? node.textContent.replace(/\\s+/g, ' ').slice(-240) : '',
    });
  });
})()`);
check('an exact AI page-number repeat reports no changes without recreating stamps or committing side effects',
  !!rerun && rerun.noChanges === true && rerun.committed === false
  && rerunState.ai.length === 2 && new Set(rerunState.ai.map((s) => s.id)).size === 2
  && new Set(rerunState.ai.map((s) => s.from)).size === 2
  && JSON.stringify(rerunState.ai.map((s) => s.text)) === JSON.stringify(['Page 5 of 3', 'Page 6 of 3'])
  && !!rerunState.manual
  && rerunState.allIds.includes('ai-page-numbers') && rerunState.allIds.includes('ai-page-number-1')
  && rerunEffects.sameStampObjects && rerunEffects.dirtyEvents === 0 && !rerunEffects.footer
  && /no changes required/i.test(rerunEffects.message)
  && rerunEffects.history === numberRepeatBefore.history
  && rerunEffects.dirty === numberRepeatBefore.dirty
  && rerunEffects.plans === numberRepeatBefore.plans,
  JSON.stringify({ result: rerun && { noChanges: rerun.noChanges, committed: rerun.committed }, effects: rerunEffects }));

const mixedNumberPlan = await beginPlanIn('__epNumberNoopMixed', 'Keep identical page numbers and add one real highlight', [
  rangedOp,
  { op: 'highlight', page: PAGE, search: 'AiPDF Editor' },
]);
const mixedNumberBefore = await transactionState('__epNumberNoopMixed');
await ev(`(function(){
  return import('/js/store.js').then(function (mod) {
    var d = window.__epNumberNoopMixed.doc;
    window.__epNumberMixedRefs = d.stamps.slice();
    window.__epNumberMixedDirtyEvents = 0;
    window.__epNumberMixedDirtyOff = mod.on('dirty', function (doc) {
      if (doc === d) window.__epNumberMixedDirtyEvents++;
    });
    return 1;
  });
})()`);
const mixedNumberRun = mixedNumberPlan.card ? await approvePlanIn('__epNumberNoopMixed') : null;
const mixedNumberAfter = await transactionState('__epNumberNoopMixed');
const mixedNumberEffects = await evJson(`(function(){
  return import('/js/store.js').then(function (mod) {
    if (window.__epNumberMixedDirtyOff) window.__epNumberMixedDirtyOff();
    var d = window.__epNumberNoopMixed.doc;
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    var refs = window.__epNumberMixedRefs;
    return JSON.stringify({
      dirtyEvents: window.__epNumberMixedDirtyEvents,
      sameStampObjects: refs.length === d.stamps.length && refs.every(function (stamp, index) { return stamp === d.stamps[index]; }),
      footer: !!(node && node.querySelector('.plan-foot')),
    });
  });
})()`);
check('a page-number no-op inside a mixed plan preserves its stamps while the real operation commits once',
  mixedNumberPlan.card && mixedNumberRun && mixedNumberRun.committed === true && mixedNumberRun.noChanges !== true
  && mixedNumberRun.records.length === 2 && mixedNumberRun.records[0].noop === true
  && mixedNumberRun.verdicts.every((v) => v.ok === true)
  && mixedNumberAfter.history.length === mixedNumberBefore.history.length + 1
  && mixedNumberAfter.annots.length === mixedNumberBefore.annots.length + 1
  && JSON.stringify(mixedNumberAfter.stamps) === JSON.stringify(mixedNumberBefore.stamps)
  && mixedNumberEffects.sameStampObjects && mixedNumberEffects.dirtyEvents === 1 && mixedNumberEffects.footer,
  JSON.stringify({ records: mixedNumberRun && mixedNumberRun.records, verdicts: mixedNumberRun && mixedNumberRun.verdicts,
    effects: mixedNumberEffects }));

const lowerBoundaryPlan = await beginNumberPlan('Use the smallest allowed numbering style', [
  { op: 'add_page_numbers', from: 1, to: 1, start: 1, fontSize: 7, color: '#000000' },
]);
check('numbering accepts the inclusive lower page, start, font-size, and color boundaries',
  lowerBoundaryPlan.card && lowerBoundaryPlan.rows.length === 1 && lowerBoundaryPlan.rows[0].status === 'ready',
  JSON.stringify(lowerBoundaryPlan.rows));
const upperBoundaryPlan = await beginNumberPlan('Use the largest allowed numbering style', [
  { op: 'add_page_numbers', from: 3, to: 3, start: 24, fontSize: 24, color: '#FFFFFF' },
]);
check('numbering accepts the inclusive upper page and font-size boundaries',
  upperBoundaryPlan.card && upperBoundaryPlan.rows.length === 1 && upperBoundaryPlan.rows[0].status === 'ready',
  JSON.stringify(upperBoundaryPlan.rows));

const romanCeilingPlan = await beginNumberPlan('Use standard Roman numbering through its supported ceiling', [
  { op: 'add_page_numbers', format: 'roman', from: 1, to: 1, start: 3999 },
  { op: 'add_page_numbers', format: 'ROMAN', from: 2, to: 3, start: 3998 },
]);
check('numbering accepts Roman labels through 3999, including a range ending at the cap',
  romanCeilingPlan.card && romanCeilingPlan.rows.length === 2 && romanCeilingPlan.blocked === 0
  && romanCeilingPlan.rows.every((row) => row.status === 'ready') && romanCeilingPlan.stampsUnchanged,
  JSON.stringify(romanCeilingPlan.rows));
const nonRomanLargeStartPlan = await beginNumberPlan('Use a large printed number without Roman formatting', [
  { op: 'add_page_numbers', format: 'n-of-N', from: 1, to: 1, start: 4000 },
]);
check('numbering keeps starts above the Roman cap available to non-Roman formats',
  nonRomanLargeStartPlan.card && nonRomanLargeStartPlan.rows.length === 1
  && nonRomanLargeStartPlan.rows[0].status === 'ready' && nonRomanLargeStartPlan.stampsUnchanged,
  JSON.stringify(nonRomanLargeStartPlan.rows));

const invalidOps = [
  { op: 'add_page_numbers', format: 'bogus' },
  { op: 'add_page_numbers', from: 3, to: 2 },
  { op: 'add_page_numbers', from: 0, to: 1 },
  { op: 'add_page_numbers', from: 1, to: 4 },
  { op: 'add_page_numbers', from: 1.5, to: 2 },
  { op: 'add_page_numbers', start: 0 },
  { op: 'add_page_numbers', start: 1.5 },
  { op: 'add_page_numbers', position: 'margin' },
  { op: 'add_page_numbers', align: 'justify' },
  { op: 'add_page_numbers', fontSize: 6 },
  { op: 'add_page_numbers', fontSize: 25 },
  { op: 'add_page_numbers', color: '#GGGGGG' },
  { op: 'add_page_numbers', color: '336699' },
  { op: 'add_page_numbers', start: Number.MAX_VALUE },
  { op: 'add_page_numbers', from: 2, to: 3, start: Number.MAX_SAFE_INTEGER },
  { op: 'add_page_numbers', format: 'roman', start: 4000 },
  { op: 'add_page_numbers', format: 'ROMAN', from: 1, to: 2, start: 3999 },
];
const invalidPlan = await beginNumberPlan('Reject malformed page numbering', invalidOps);
const invalidReasons = [
  /format/i, /from.*to/i, /from.*1.*3/i, /to.*1.*3/i, /from.*integer/i,
  /start.*integer.*1/i, /start.*integer/i, /position.*header.*footer/i,
  /align.*left.*center.*right/i, /fontSize.*7.*24/i, /fontSize.*7.*24/i,
  /color.*#RRGGBB/i, /color.*#RRGGBB/i,
  /start.*safe integer/i, /start.*safe integer/i,
  /Roman.*3999/i, /Roman.*3999/i,
];
check('invalid numbering values are rejected with visible field-specific reasons',
  invalidPlan.done && !invalidPlan.card && invalidPlan.failures.length === invalidOps.length
  && invalidReasons.every((reason, index) => reason.test(invalidPlan.failures[index] || '')),
  JSON.stringify(invalidPlan.failures));
check('rejected numbering proposals leave the stamp group untouched', invalidPlan.stampsUnchanged);

const duplicateTextBefore = await transactionState('__epNumber');
await beginNumberPlan('Verify custom page numbering', [numberVerificationOp], 'duplicate-text');
const duplicateText = await approveNumberPlan();
const duplicateTextAfter = await transactionState('__epNumber');
const duplicateTextVerdict = duplicateText && duplicateText.verdicts.find((v) => v.kind === 'add_page_numbers');
check('candidate verification rejects a duplicated expected number and rolls back',
  !!duplicateTextVerdict && duplicateTextVerdict.ok === false && /exactly once|duplicate/i.test(duplicateTextVerdict.detail)
  && duplicateText.committed === false
  && JSON.stringify(duplicateTextAfter) === JSON.stringify(duplicateTextBefore),
  JSON.stringify(duplicateTextVerdict));

const missingTextBefore = await transactionState('__epNumber');
await beginNumberPlan('Verify custom page numbering', [numberVerificationOp], 'missing-text');
const missingText = await approveNumberPlan();
const missingTextAfter = await transactionState('__epNumber');
const missingTextVerdict = missingText && missingText.verdicts.find((v) => v.kind === 'add_page_numbers');
check('candidate verification rejects a missing expected number and rolls back',
  !!missingTextVerdict && missingTextVerdict.ok === false && /exactly once|found 0/i.test(missingTextVerdict.detail)
  && missingText.committed === false
  && JSON.stringify(missingTextAfter) === JSON.stringify(missingTextBefore),
  JSON.stringify(missingTextVerdict));

const wrongPageBefore = await transactionState('__epNumber');
await beginNumberPlan('Verify custom page numbering', [numberVerificationOp], 'wrong-page');
const wrongPage = await approveNumberPlan();
const wrongPageAfter = await transactionState('__epNumber');
const wrongPageVerdict = wrongPage && wrongPage.verdicts.find((v) => v.kind === 'add_page_numbers');
check('candidate verification rejects an expected number found only on the wrong page and rolls back',
  !!wrongPageVerdict && wrongPageVerdict.ok === false && /p\.2:.*found 0/i.test(wrongPageVerdict.detail)
  && wrongPage.committed === false
  && JSON.stringify(wrongPageAfter) === JSON.stringify(wrongPageBefore),
  JSON.stringify(wrongPageVerdict));

const duplicateGroupBefore = await transactionState('__epNumber');
await beginNumberPlan('Verify custom page numbering', [numberVerificationOp], 'duplicate-group');
const duplicateGroup = await approveNumberPlan();
const duplicateGroupAfter = await transactionState('__epNumber');
const duplicateGroupState = await numberState();
const duplicateGroupVerdict = duplicateGroup && duplicateGroup.verdicts.find((v) => v.kind === 'add_page_numbers');
check('candidate verification rejects duplicates within the AI numbering group and rolls back',
  !!duplicateGroupVerdict && duplicateGroupVerdict.ok === false && /duplicate|group/i.test(duplicateGroupVerdict.detail)
  && duplicateGroup.committed === false
  && JSON.stringify(duplicateGroupAfter) === JSON.stringify(duplicateGroupBefore)
  && countText(duplicateGroupState.candidate[1], 'Page 5 of 3') === 1,
  JSON.stringify(duplicateGroupVerdict));
await ev(`(async function(){
  var st = await import('/js/store.js');
  st.activeDoc().stamps = st.activeDoc().stamps.filter(function (stamp) {
    return stamp.id !== 'ai-page-numbers-2-copy' && stamp.id !== 'ai-page-numbers' && stamp.id !== 'ai-page-number-1';
  });
  return 1;
})()`);

/* ── 4. Restyle by request: "make the title blue" ─────────────────────── */

async function beginPlanIn(slot, goal, operations, candidateMode = '') {
  await ev(`(async function(){
    var ep = await import('/js/editplan.js');
    var app = await import('/js/app.js');
    var st = await import('/js/store.js');
    var d = st.activeDoc();
    var priorNodes = document.querySelectorAll('.msg.ai');
    var priorNode = priorNodes[priorNodes.length - 1];
    window[${JSON.stringify(slot)}] = {
      done: false, result: null, error: null, doc: d, pdf: d.pdf, bytes: d.bytes,
      stampsBefore: JSON.stringify(d.stamps), editsBefore: d.textEdits.length,
      revisionBefore: d.revision, historyBefore: d.history.length, hIndexBefore: d.hIndex,
      dirtyBefore: !!d.dirty, saveCalls: 0, saveAsCalls: 0,
      beforeNodeId: priorNode ? priorNode.dataset.id : '', cardReady: false,
      schema: null, candidateBytes: null, beforeBytes: null,
      stagingStarted: false, busyAtStaging: null, historyAtStaging: null, dirtyAtStaging: null,
    };
    var run = window[${JSON.stringify(slot)}];
    var mode = ${JSON.stringify(candidateMode)};
    if (mode === 'missing-color' || mode === 'color-after-text'
      || mode === 'missing-annotation' || mode === 'wrong-structure') {
      run.beforeBytes = Array.from(await app.buildDocBytes(d));
    }
    var deps = {
      app: {
        buildDocBytes: async function (candidateDoc) {
          var bytes;
          if (mode === 'missing-color' || mode === 'missing-annotation' || mode === 'wrong-structure') {
            bytes = new Uint8Array(run.beforeBytes);
          } else if (mode === 'color-after-text') {
            var PL = await import('/v/pdf-lib.js');
            var candidate = await PL.PDFDocument.create();
            var font = await candidate.embedFont(PL.StandardFonts.Helvetica);
            var page = candidate.addPage([595.28, 841.89]);
            var hex = ${JSON.stringify(operations[0]?.color || '#123ABC')};
            var col = [1, 3, 5].map(function (at) { return parseInt(hex.slice(at, at + 2), 16) / 255; });
            page.drawText(${JSON.stringify(TITLE)}, { x: 50, y: 760, size: 16, font: font, color: PL.rgb(0, 0, 0) });
            page.drawText('Requested colour follows the title.', { x: 50, y: 730, size: 12, font: font, color: PL.rgb(col[0], col[1], col[2]) });
            bytes = await candidate.save({ useObjectStreams: true });
          } else if (mode === 'wrong-annotation-content' || mode === 'structural-tagged') {
            bytes = await app.buildDocBytes(candidateDoc);
            var PL = await import('/v/pdf-lib.js');
            var candidate = await PL.PDFDocument.load(bytes);
            if (mode === 'wrong-annotation-content') {
              candidate.getPages().forEach(function (page) {
                var annots = page.node.Annots();
                if (!annots || typeof annots.asArray !== 'function') return;
                annots.asArray().forEach(function (ref) {
                  var annot = candidate.context.lookup(ref);
                  if (annot && typeof annot.set === 'function') {
                    annot.set(PL.PDFName.of('Contents'), PL.PDFHexString.fromText('Candidate annotation content mismatch'));
                  }
                });
              });
            } else {
              candidate.setTitle('Prebuilt structural candidate');
            }
            bytes = await candidate.save({ useObjectStreams: true });
          } else if (mode === 'gated') {
            run.stagingStarted = true;
            run.busyAtStaging = !!st.state.ai.busy;
            run.historyAtStaging = candidateDoc.history.length;
            run.dirtyAtStaging = !!candidateDoc.dirty;
            await new Promise(function (resolve) { run.releaseBuild = resolve; });
            bytes = await app.buildDocBytes(candidateDoc);
          } else {
            bytes = await app.buildDocBytes(candidateDoc);
          }
          run.candidateBytes = Array.from(bytes);
          return bytes;
        },
        extractTextFromBytes: async function (bytes) {
          if (mode === 'empty-text') return [];
          var texts = await app.extractTextFromBytes(bytes);
          if (mode === 'missing-text') texts[0] = String(texts[0] || '').split(${JSON.stringify(TITLE)}).join('');
          return texts;
        },
        saveDoc: async function (candidateDoc) {
          run.saveCalls++;
          run.savedDoc = candidateDoc;
          return true;
        },
        saveDocAs: async function (candidateDoc) {
          run.saveAsCalls++;
          run.savedAsDoc = candidateDoc;
          return true;
        },
        countInkPixels: app.countInkPixels,
      },
      chat: async function (messages, options) {
        var spec = (options.tools || []).find(function (tool) { return tool.function && tool.function.name === 'propose_plan'; });
        run.schema = spec ? spec.function.parameters.properties.operations.items.properties : null;
        return { text: '', toolCalls: [{ id: ${JSON.stringify('plan-' + slot)}, name: 'propose_plan', args: { summary: 'Scripted plan.', operations: ${JSON.stringify(operations)} } }] };
      },
    };
    ep.runVerifiedEdit(${JSON.stringify(goal)}, deps)
      .then(function (result) { run.result = result; run.done = true; })
      .catch(function (error) { run.error = String(error); run.done = true; });
    return 'started';
  })()`);
  let waited = 0;
  while (waited < 30000 && !(await ev(`(function(){
    var run = window[${JSON.stringify(slot)}];
    if (run.done) return true;
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    return !!(node && node.dataset.id !== run.beforeNodeId && node.querySelector('.plan-actions'));
  })()`))) { await sleep(100); waited += 100; }
  return evJson(`(function(){
    var run = window[${JSON.stringify(slot)}];
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    var card = node ? node.querySelector('.plan-actions') : null;
    var rows = node ? Array.prototype.slice.call(node.querySelectorAll('.plan-op')) : [];
    run.cardReady = !!card;
    return JSON.stringify({
      done: run.done, error: run.error, card: !!card,
      rows: rows.map(function (row) {
        return {
          title: (row.querySelector('.plan-op-title') || {}).textContent || '',
          status: ['ready', 'rejected', 'not_found'].find(function (name) { return row.classList.contains(name); }) || '',
          detail: ((row.querySelector('.plan-diff') || row.querySelector('.plan-fail') || row.querySelector('.plan-note') || {}).textContent || '').replace(/\\s+/g, ' ').trim(),
        };
      }),
      blocked: rows.filter(function (row) { return row.classList.contains('rejected') || row.classList.contains('not_found'); }).length,
      applyLabel: card ? (card.querySelector('.primary') || {}).textContent || '' : '',
      stampsUnchanged: JSON.stringify(run.doc.stamps) === run.stampsBefore,
      editsUnchanged: run.doc.textEdits.length === run.editsBefore,
      failures: node ? Array.prototype.slice.call(node.querySelectorAll('.plan-fail')).map(function (row) { return row.textContent; }) : [],
      schema: run.schema,
      candidateCaptured: !!(run.candidateBytes && run.candidateBytes.length),
    });
  })()`);
}

async function approvePlanIn(slot, allowNull = false) {
  const clicked = await ev(`(function(){
    var run = window[${JSON.stringify(slot)}];
    if (!run.cardReady) return 0;
    var nodes = document.querySelectorAll('.msg.ai');
    nodes[nodes.length - 1].querySelector('.plan-actions .primary').click();
    return 1;
  })()`);
  if (!clicked) return null;
  let waited = 0;
  while (waited < 120000 && !(await ev(`window[${JSON.stringify(slot)}].done`))) { await sleep(100); waited += 100; }
  const result = await evJson(`JSON.stringify(window[${JSON.stringify(slot)}].result)`);
  if (!result && !allowNull) {
    const last = await ev(`(function(){ var nodes = document.querySelectorAll('.msg.ai'); var n = nodes[nodes.length - 1]; return n ? n.textContent.replace(/\\s+/g, ' ').slice(-400) : ''; })()`);
    console.log(`      (no result for ${slot}; last AI message: ${last})`);
  }
  return result;
}

async function cancelPlanIn(slot) {
  const clicked = await ev(`(function(){
    var run = window[${JSON.stringify(slot)}];
    if (!run.cardReady) return 0;
    var nodes = document.querySelectorAll('.msg.ai');
    var cancel = nodes[nodes.length - 1].querySelector('.plan-actions .mini-btn:not(.primary)');
    if (!cancel) return 0;
    cancel.click();
    return 1;
  })()`);
  if (!clicked) return;
  let waited = 0;
  while (waited < 10000 && !(await ev(`window[${JSON.stringify(slot)}].done`))) { await sleep(100); waited += 100; }
}

async function transactionState(slot) {
  return evJson(`(function(){
    var d = window[${JSON.stringify(slot)}].doc;
    return JSON.stringify({
      numPages: d.numPages, pageSizes: d.pageSizes, pageOps: d.pageOps,
      pageRotate: d.pageRotate, crops: d.crops, meta: d.meta,
      attachments: d.attachments, newFields: d.newFields, annots: d.annots,
      textEdits: d.textEdits, stamps: d.stamps,
      dirty: !!d.dirty, history: d.history, hIndex: d.hIndex,
      plans: (d.editPlans || []).length,
    });
  })()`);
}

async function candidateTextColorEvidence(bytes, hex) {
  const pdf = await PL.PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  const page = pdf.getPage(0);
  const contents = page.node.get(PL.PDFName.of('Contents'));
  const refs = contents instanceof PL.PDFArray
    ? Array.from({ length: contents.size() }, (_, index) => contents.get(index))
    : (contents ? [contents] : []);
  const streams = [];
  for (const ref of refs) {
    const obj = pdf.context.lookup(ref);
    if (!obj) continue;
    const raw = obj.contents instanceof Uint8Array ? obj.contents : obj.getContents?.();
    if (!raw) continue;
    const filter = obj.dict?.get?.(PL.PDFName.of('Filter'))?.toString() || '';
    streams.push((filter.includes('FlateDecode') ? inflateSync(raw) : raw).toString('latin1'));
  }
  const source = streams.join('\n');
  const wanted = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const number = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+))';
  const token = new RegExp(`${number}\\s+${number}\\s+${number}\\s+rg\\b|<([0-9a-fA-F\\s]+)>\\s*Tj\\b`, 'g');
  const extracted = [];
  let fill = [0, 0, 0], requestedFillAt = -1, evidence = null;
  for (const match of source.matchAll(token)) {
    if (match[1] !== undefined) {
      fill = [Number(match[1]), Number(match[2]), Number(match[3])];
      if (wanted.every((value, index) => Math.abs(fill[index] - value) <= 2 / 255)) requestedFillAt = match.index;
      continue;
    }
    const text = Buffer.from(match[4].replace(/\s+/g, ''), 'hex').toString('latin1');
    extracted.push(text);
    if (text.includes(TITLE) && requestedFillAt >= 0
      && wanted.every((value, index) => Math.abs(fill[index] - value) <= 2 / 255)) {
      evidence = { fillAt: requestedFillAt, textAt: match.index, text };
      break;
    }
  }
  return {
    extracted: extracted.join(' ').replace(/\s+/g, ' '),
    ...(evidence || { fillAt: -1, textAt: -1, text: '' }),
  };
}

async function addDuplicateTitleBlock() {
  return evJson(`(async function(){
    var st = await import('/js/store.js');
    var te = await import('/js/textedit.js');
    var tb = await import('/js/textblocks.js');
    var d = st.activeDoc();
    var blocks = await te.editableBlocks(0);
    var targetIndex = blocks.findIndex(function (b) { return tb.blockText(d, 0, b) === ${JSON.stringify(TITLE)}; });
    var otherIndex = blocks.findIndex(function (b, i) { return i !== targetIndex && String(b.text || '').trim(); });
    if (targetIndex < 0 || otherIndex < 0) return JSON.stringify({ error: 'missing blocks' });
    var before = d.textEdits.map(function (e) { return e.id; });
    var changed = await te.commitBlockEdit(0, blocks[otherIndex], ${JSON.stringify(TITLE)}, {
      label: 'Task 4 duplicate-title fixture', color: [0.2, 0.8, 0.2],
    });
    var temp = d.textEdits.find(function (e) { return before.indexOf(e.id) < 0; });
    window.__epTask4Temp = temp || null;
    return JSON.stringify({ changed: !!changed, id: temp ? temp.id : '', targetIndex: targetIndex, otherIndex: otherIndex });
  })()`);
}

async function removeTask4Temp(id) {
  if (!id) return;
  await ev(`(async function(){
    var st = await import('/js/store.js');
    var d = st.activeDoc();
    d.textEdits = d.textEdits.filter(function (e) { return e.id !== ${JSON.stringify(id)}; });
    d.annots = d.annots.filter(function (a) { return a.directEdit !== ${JSON.stringify(id)}; });
    return 1;
  })()`);
}

async function openSyntheticBytes(bytes, name) {
  return ev(`(async function(){
    var app = await import('/js/app.js');
    await app.openDocFromBytes(new Uint8Array(${JSON.stringify(Array.from(bytes))}), ${JSON.stringify(name)}, null);
    return 1;
  })()`);
}

const asciiHex = (text) => Buffer.from(text, 'latin1').toString('hex');
const rawStream = (doc, dict, source) => doc.context.register(PL.PDFRawStream.of(
  dict, new TextEncoder().encode(source),
));

/** Real Form XObject / FreeText appearance streams whose internal colour and
 *  text state deliberately lack q/Q. The boundary itself must isolate them. */
async function makeBoundaryFixture(kind) {
  const doc = await PL.PDFDocument.create();
  const helvetica = await doc.embedFont(PL.StandardFonts.Helvetica);
  const times = await doc.embedFont(PL.StandardFonts.TimesRoman);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('font placeholder', { x: 50, y: 800, size: 10, font: helvetica });
  page.drawText('font placeholder', { x: 50, y: 780, size: 10, font: times });
  const resources = page.node.Resources();
  const keys = resources.lookup(PL.PDFName.of('Font')).keys().map((key) => key.decodeText());
  const helveticaKey = keys.find((key) => key.startsWith('Helvetica'));
  const timesKey = keys.find((key) => key.startsWith('TimesRoman'));
  const contaminatedState = (text) => `1 0 0 rg `
    + `BT /${helveticaKey} 12 Tf 1 Tr 3 Tc 2 Tw 80 Tz 4 Ts 1 0 0 1 50 700 Tm <${asciiHex(text)}> Tj ET`;
  const outerState = `BT /${timesKey} 16 Tf ET `;
  let prefix = outerState;
  if (kind === 'form' || kind === 'form-color') {
    const formSource = kind === 'form-color'
      ? `1 0 0 rg BT /${helveticaKey} 12 Tf 1 0 0 1 50 700 Tm <${asciiHex('Form contamination')}> Tj ET`
      : contaminatedState('Form contamination');
    const form = rawStream(doc, doc.context.obj({
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 595.28, 841.89], Resources: resources,
    }), formSource);
    const name = page.node.newXObject('Contamination', form);
    prefix += `/${name.decodeText()} Do `;
    prefix += `BT 1 0 0 1 50 760 Tm <${asciiHex(TITLE)}> Tj ET`;
  } else {
    const appearance = (text, contaminated) => rawStream(doc, doc.context.obj({
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 240, 60], Resources: resources,
    }), contaminated
      ? contaminatedState(text)
      : `BT /${timesKey} 12 Tf 1 0 0 1 10 20 Tm <${asciiHex(text)}> Tj ET`);
    const first = appearance('First annotation', true);
    const second = appearance('Second annotation', false);
    for (const [index, ap] of [first, second].entries()) {
      page.node.addAnnot(doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'FreeText', Rect: [50, 680 + index * 70, 290, 740 + index * 70],
        Contents: PL.PDFString.of(index ? 'Second annotation' : 'First annotation'),
        F: PL.PDFNumber.of(4), AP: doc.context.obj({ N: ap }),
      })));
    }
  }
  page.node.set(PL.PDFName.of('Contents'), rawStream(doc, doc.context.obj({}), prefix));
  return doc.save({ useObjectStreams: true });
}

async function makeUnregisteredFontFixture() {
  let doc = await PL.PDFDocument.create();
  const font = await doc.embedFont(PL.StandardFonts.Helvetica);
  doc.addPage([595.28, 841.89]).drawText(TITLE, { x: 50, y: 760, size: 16, font });
  doc = await PL.PDFDocument.load(Buffer.from(await doc.save({ useObjectStreams: true })));
  const fonts = doc.getPage(0).node.Resources().lookup(PL.PDFName.of('Font'));
  for (const [, ref] of fonts.entries()) {
    doc.context.lookup(ref).set(PL.PDFName.of('BaseFont'), PL.PDFName.of('UnregisteredFace'));
  }
  return doc.save({ useObjectStreams: true });
}

const NON_WINANSI_TITLE = 'ĀΩЖ synthetic title.';
async function makeEmbeddedFontFixture() {
  const doc = await PL.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fontBytes = fs.readFileSync(path.join(ROOT, 'node_modules', 'pdfjs-dist', 'standard_fonts', 'LiberationSans-Regular.ttf'));
  const font = await doc.embedFont(fontBytes, { subset: false });
  doc.addPage([595.28, 841.89]).drawText(NON_WINANSI_TITLE, { x: 50, y: 760, size: 16, font });
  return doc.save({ useObjectStreams: true });
}

async function makeMultilineFixture() {
  const doc = await PL.PDFDocument.create();
  const font = await doc.embedFont(PL.StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Centered title', { x: 200, y: 760, size: 16, font });
  page.drawText('second line', { x: 170, y: 740, size: 16, font });
  page.drawText('Uneven title', { x: 180, y: 690, size: 16, font });
  page.drawText('middle line', { x: 165, y: 670, size: 16, font });
  page.drawText('last line', { x: 150, y: 642, size: 16, font });
  return doc.save({ useObjectStreams: true });
}

async function boundaryRunState(kind) {
  await openSyntheticBytes(await makeBoundaryFixture(kind), `task4-${kind}-boundary.pdf`);
  return evJson(`(async function(){
    var ep = await import('/js/editplan.js');
    if (typeof ep.operatorTextRuns !== 'function') return JSON.stringify({ available: false });
    var v = await import('/js/viewer.js');
    var st = await import('/js/store.js');
    var page = await st.activeDoc().pdf.getPage(1);
    var list = await page.getOperatorList();
    var outerFont = null;
    for (var i = 0; i < list.fnArray.length; i++) {
      if (list.fnArray[i] === v.pdfjs.OPS.paintFormXObjectBegin
        || list.fnArray[i] === v.pdfjs.OPS.beginAnnotation) break;
      if (list.fnArray[i] === v.pdfjs.OPS.setFont) outerFont = list.argsArray[i][0];
    }
    var runs = ep.operatorTextRuns(list, v.pdfjs.OPS);
    return JSON.stringify({
      available: true, outerFont: outerFont,
      runs: runs.map(function (run) {
        return { text: run.text, color: run.color, font: run.font, renderMode: run.renderMode,
          inForm: run.inForm, inAnnotation: run.inAnnotation, charSpacing: run.charSpacing,
          wordSpacing: run.wordSpacing, hScale: run.hScale, textRise: run.textRise };
      }),
    });
  })()`);
}

const stylePlan = await beginPlanIn('__epStyle', 'Make the title blue', [
  { op: 'style_text', page: PAGE, find: 'verified test fixture', color: '#1d4ed8' },
  { op: 'style_text', page: PAGE, find: 'no such words anywhere here', color: '#ff0000' },
  { op: 'style_text', page: PAGE, find: 'must be extractable', color: 'not-a-color' },
  { op: 'style_text', page: PAGE, find: 'must be extractable' },
]);
check('a restyle request resolves against the real block and shows the colour it will apply',
  stylePlan.card && stylePlan.rows.length === 4 && stylePlan.rows[0].status === 'ready'
  && /#1d4ed8/i.test(stylePlan.rows[0].detail) && /p\.1/.test(stylePlan.rows[0].detail) && /apply 1 operation/i.test(stylePlan.applyLabel),
  JSON.stringify(stylePlan.rows));
check('a restyle of text that is not on the page is kept as not found',
  stylePlan.rows[1].status === 'not_found' && /not in an editable text block on page 1/i.test(stylePlan.rows[1].detail), stylePlan.rows[1].detail);
check('malformed or empty style values are rejected with field-specific reasons',
  stylePlan.rows[2].status === 'rejected' && /#RRGGBB/i.test(stylePlan.rows[2].detail)
  && stylePlan.rows[3].status === 'rejected' && /Nothing to change/i.test(stylePlan.rows[3].detail),
  JSON.stringify(stylePlan.rows.slice(2)));
check('planning a restyle changed nothing', stylePlan.stampsUnchanged && stylePlan.editsUnchanged);
const styleRun = await approvePlanIn('__epStyle');
const styleRec = styleRun && styleRun.records[0];
const styleVerdict = styleRun && styleRun.verdicts[0];
check('the approved restyle was applied to the block',
  !!styleRun && !styleRun.error && styleRec && styleRec.status === 'applied' && /1\/1/.test(styleRec.detail), JSON.stringify(styleRec));
check('verification rendered the rebuilt file and found the requested colour inside the block',
  !!styleVerdict && styleVerdict.ok === true && /requested colour/i.test(styleVerdict.detail) && /wording intact/i.test(styleVerdict.detail),
  JSON.stringify(styleVerdict));
const styleState = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var d = st.activeDoc();
  var e = (d.textEdits || []).find(function (x) { return x.page === ${PAGE - 1} && String(x.text).indexOf('verified test fixture') >= 0; });
  return JSON.stringify({ hex: e ? '#' + e.color.map(function (c) { return Math.round(c * 255).toString(16).padStart(2, '0'); }).join('') : '', text: e ? e.text : '', dirty: !!d.dirty });
})()`);
check('the edit record carries the requested colour and the unchanged wording, and the file is left unsaved',
  styleState.hex === '#1d4ed8' && /verified test fixture/.test(styleState.text) && styleState.dirty, JSON.stringify(styleState));

/* ── 5. Stamps by request: watermark, header/footer text ────────────────── */

// The AI page-number group from section 3 occupies the header band (pages 2–3,
// right-aligned). A centred header request must therefore be moved, not stacked.
const stampPlan = await beginPlanIn('__epStamps', 'Add a DRAFT watermark and a Confidential footer', [
  { op: 'add_watermark', text: 'DRAFT' },
  { op: 'add_header_footer', text: 'Confidential — {filename}', position: 'footer', align: 'left' },
  { op: 'add_header_footer', text: 'Internal use only', position: 'header' },
  { op: 'add_watermark', text: '   ' },
  { op: 'add_header_footer', text: 'x', position: 'margin' },
  { op: 'add_watermark', text: 'TOO BIG', fontSize: 500 },
]);
check('stamp requests resolve with their text, placement and page range',
  stampPlan.card && stampPlan.rows[0].status === 'ready' && /DRAFT/.test(stampPlan.rows[0].detail) && /every page/.test(stampPlan.rows[0].detail)
  && stampPlan.rows[1].status === 'ready' && /footer/.test(stampPlan.rows[1].detail) && /left/.test(stampPlan.rows[1].detail)
  && stampPlan.rows[2].status === 'ready' && /moved left/.test(stampPlan.rows[2].detail),
  JSON.stringify(stampPlan.rows));
check('empty, misplaced or oversized stamp values are rejected with visible reasons',
  stampPlan.blocked === 3 && /No watermark text/i.test(stampPlan.rows[3].detail)
  && /header or footer/i.test(stampPlan.rows[4].detail) && /12 through 120/i.test(stampPlan.rows[5].detail),
  JSON.stringify(stampPlan.rows.slice(3)));
check('planning stamps changed nothing', stampPlan.stampsUnchanged && stampPlan.editsUnchanged);
const stampRun = await approvePlanIn('__epStamps');
check('watermark and header/footer text are confirmed in the rebuilt file',
  !!stampRun && !stampRun.error && stampRun.records.length === 3 && stampRun.records.every((r) => r.status === 'applied')
  && stampRun.verdicts.every((v) => v.ok === true) && /3 page\(s\)/.test(stampRun.verdicts[0].detail),
  JSON.stringify(stampRun && stampRun.verdicts));
const stampState = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var d = st.activeDoc();
  var ai = (d.stamps || []).filter(function (s) { return String(s.id || '').indexOf('ai-') === 0; });
  return JSON.stringify({
    ids: ai.map(function (s) { return s.id.replace(/-[a-z0-9]+$/, ''); }).sort(),
    header: ai.filter(function (s) { return String(s.id).indexOf('ai-header-') === 0; }).map(function (s) { return s.parts[0]; }),
    footer: ai.filter(function (s) { return String(s.id).indexOf('ai-footer-') === 0; }).map(function (s) { return s.parts[0]; }),
    watermark: ai.filter(function (s) { return s.kind === 'watermark'; }).map(function (s) { return { text: s.text, from: s.from, to: s.to, behind: s.behind }; }),
  });
})()`);
check('the stamps carry AI group ids, the requested text, and the collision-avoiding alignment',
  JSON.stringify(stampState.ids) === JSON.stringify(['ai-footer', 'ai-header', 'ai-page-numbers', 'ai-page-numbers', 'ai-watermark'])
  && stampState.header.length === 1 && stampState.header[0].text === 'Internal use only' && stampState.header[0].align === 'left'
  && stampState.footer.length === 1 && stampState.footer[0].text === 'Confidential — {filename}' && stampState.footer[0].align === 'left'
  && stampState.watermark.length === 1 && stampState.watermark[0].text === 'DRAFT' && stampState.watermark[0].from === 1 && stampState.watermark[0].to === 3,
  JSON.stringify(stampState));

// Asking again replaces the AI's own watermark instead of stacking a second one.
const rerunPlan = await beginPlanIn('__epStamps2', 'Change the watermark to CONFIDENTIAL', [{ op: 'add_watermark', text: 'CONFIDENTIAL' }]);
check('a repeated watermark request says it replaces the earlier AI watermark',
  rerunPlan.card && rerunPlan.rows[0].status === 'ready' && /replaces the earlier AI watermark/i.test(rerunPlan.rows[0].detail), JSON.stringify(rerunPlan.rows));
const rerunStamp = await approvePlanIn('__epStamps2');
const rerunStampState = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var w = (st.activeDoc().stamps || []).filter(function (s) { return s.kind === 'watermark'; });
  return JSON.stringify({ count: w.length, texts: w.map(function (s) { return s.text; }) });
})()`);
check('rerunning the watermark leaves exactly one AI watermark with the new text',
  !!rerunStamp && rerunStamp.verdicts[0].ok === true && rerunStampState.count === 1 && rerunStampState.texts[0] === 'CONFIDENTIAL', JSON.stringify(rerunStampState));

/* ── 6. The dock makes editing discoverable from Ask mode ────────────────── */

const intent = await evJson(`(async function(){
  var ai = await import('/js/ai.js');
  return JSON.stringify({
    pageNumbers: ai.looksLikeEditRequest('Can you add page numbers to this?'),
    colour: ai.looksLikeEditRequest('make the title blue'),
    watermark: ai.looksLikeEditRequest('Put a DRAFT watermark on it'),
    question: ai.looksLikeEditRequest('What does the termination clause say?'),
    summary: ai.looksLikeEditRequest('Summarise the key points of section 3'),
  });
})()`);
check('an Ask-mode question that is really an edit request is recognised',
  intent.pageNumbers && intent.colour && intent.watermark && !intent.question && !intent.summary, JSON.stringify(intent));

const dock = await evJson(`(async function(){
  var ai = await import('/js/ai.js');
  var st = await import('/js/store.js');
  var saved = st.state.ai.mode;
  var savedMessages = st.state.ai.messages;
  st.state.ai.messages = [];            // the empty-state copy only renders on an empty dock
  st.state.ai.mode = 'chat';
  ai.openAIDock();
  var sw = document.querySelector('.ai-input .ai-mode');
  var buttons = sw ? Array.prototype.slice.call(sw.querySelectorAll('.ai-mode-btn')).map(function (b) { return b.textContent.trim(); }) : [];
  var askChips = Array.prototype.slice.call(document.querySelectorAll('.ai-actions .ai-chip')).map(function (b) { return b.textContent.trim(); });
  st.state.ai.mode = 'agent';
  ai.renderAIDock();
  var editChips = Array.prototype.slice.call(document.querySelectorAll('.ai-actions .ai-chip')).map(function (b) { return b.textContent.trim(); });
  var placeholder = (document.querySelector('.ai-input textarea') || {}).placeholder || '';
  var empty = (document.querySelector('.ai-msgs .empty-state') || {}).textContent || '';
  var sendLabel = (document.querySelector('.ai-input .mini-btn.primary') || {}).textContent || '';
  var askEmpty = (function(){ st.state.ai.mode = 'chat'; ai.renderAIDock(); var t = (document.querySelector('.ai-msgs .empty-state') || {}).textContent || ''; return t; })();
  st.state.ai.mode = saved;
  st.state.ai.messages = savedMessages;
  ai.renderAIDock();
  return JSON.stringify({ hasSwitch: !!sw, buttons: buttons, askChips: askChips, editChips: editChips, placeholder: placeholder, empty: empty, askEmpty: askEmpty, sendLabel: sendLabel });
})()`);
check('the Ask ⇄ Edit switch is visible from Ask mode', dock.hasSwitch && dock.buttons.join(',') === 'Ask,Edit', JSON.stringify(dock.buttons));
check('Edit mode offers natural-language editing examples and a matching placeholder',
  /Add page numbers/.test(dock.editChips.join('|')) && /Make the title blue/.test(dock.editChips.join('|'))
  && /DRAFT watermark/.test(dock.editChips.join('|')) && /add page numbers/.test(dock.placeholder)
  && /nothing changes until you approve/i.test(dock.empty) && dock.sendLabel === 'Plan it'
  && /switch to Edit and describe the change/i.test(dock.askEmpty.replace(/<[^>]+>/g, '')), JSON.stringify(dock));

/* ── 7. Exact, reviewable title colour ───────────────────────────────────── */

const exactColorOp = { op: 'format_text_color', page: PAGE, find: TITLE, color: '#123ABC' };
const exactColorPlan = await beginPlanIn('__epColor', 'Change only the title colour to #123ABC', [exactColorOp]);
const colorFields = exactColorPlan.schema || {};
check('the plan schema exposes a distinct typed format_text_color operation',
  !!exactColorPlan.schema && colorFields.op.enum.includes('format_text_color')
  && colorFields.color.pattern === '^#[0-9A-Fa-f]{6}$'
  && !/replace_text \/ style_text/.test(colorFields.all.description),
  JSON.stringify(Object.keys(colorFields)));
check('one exact native title resolves without mutation and shows the requested colour',
  exactColorPlan.card && exactColorPlan.rows.length === 1 && exactColorPlan.rows[0].status === 'ready'
  && /#123ABC/i.test(exactColorPlan.rows[0].detail) && exactColorPlan.rows[0].detail.includes(TITLE)
  && /apply 1 operation/i.test(exactColorPlan.applyLabel) && exactColorPlan.editsUnchanged,
  JSON.stringify(exactColorPlan.rows));

// A resolved plan is bound to the document revision. Editing the target after
// resolution must invalidate approval, not recolour a stale block identity.
const bindingSetup = exactColorPlan.card ? await evJson(`(async function(){
  var run = window.__epColor;
  var st = await import('/js/store.js');
  var te = await import('/js/textedit.js');
  var tb = await import('/js/textblocks.js');
  var d = run.doc;
  var blocks = await te.editableBlocks(0);
  var targetIndex = blocks.findIndex(function (b) { return tb.blockText(d, 0, b) === ${JSON.stringify(TITLE)}; });
  if (targetIndex < 0) return JSON.stringify({ error: 'missing title block' });
  var target = blocks[targetIndex];
  run.targetKey = target.key;
  var changed = await te.commitBlockEdit(0, target, 'Temporarily changed after resolution.', {
    label: 'Task 5 stale-plan fixture',
  });
  var edit = d.textEdits.find(function (e) { return e.key === run.targetKey; });
  return JSON.stringify({
    changed: !!changed, targetIndex: targetIndex, targetKey: run.targetKey,
    targetText: edit ? edit.text : '', revisionBefore: run.revisionBefore,
    revisionAfter: d.revision, historyBefore: run.historyBefore, historyAfter: d.history.length,
    plansBefore: (d.editPlans || []).length,
  });
})()`) : { error: 'no exact colour plan' };

const exactColorRun = exactColorPlan.card ? await approvePlanIn('__epColor', true) : null;
const staleColorState = await evJson(`(function(){
  var run = window.__epColor;
  var d = run.doc;
  var edit = d.textEdits.find(function (e) { return e.key === run.targetKey; });
  var actions = document.querySelector('.plan-actions');
  return JSON.stringify({
    done: run.done, result: run.result, targetText: edit ? edit.text : '',
    history: d.history.length, plans: (d.editPlans || []).length,
    applyDisabled: !!(actions && actions.querySelector('.primary') && actions.querySelector('.primary').disabled),
    message: actions && actions.parentElement ? actions.parentElement.textContent.replace(/\\s+/g, ' ').slice(-240) : '',
  });
})()`);
check('editing after resolution invalidates the proposal instead of executing the stale plan',
  exactColorPlan.card && bindingSetup.changed === true && exactColorRun === null
  && staleColorState.done && staleColorState.result === null
  && staleColorState.targetText === 'Temporarily changed after resolution.'
  && staleColorState.history === bindingSetup.historyAfter
  && staleColorState.plans === bindingSetup.plansBefore && staleColorState.applyDisabled
  && /invalid|changed|stale/i.test(staleColorState.message),
  JSON.stringify({ setup: bindingSetup, state: staleColorState }));
check('a post-resolution model edit advances the document revision',
  Number.isInteger(bindingSetup.revisionBefore) && Number.isInteger(bindingSetup.revisionAfter)
  && bindingSetup.revisionAfter > bindingSetup.revisionBefore,
  JSON.stringify({ before: bindingSetup.revisionBefore, after: bindingSetup.revisionAfter }));

const dirtyOnlyPlan = await beginPlanIn('__epDirtyOnly', 'Invalidate approval on a dirty-only notification', [
  { op: 'note', page: PAGE, text: 'DIRTY-ONLY PLAN MUST NOT APPLY' },
]);
const dirtyOnlyState = await evJson(`(function(){
  var st = import('/js/store.js');
  return st.then(function (mod) {
    var run = window.__epDirtyOnly;
    var changes = 0;
    var off = mod.on('change', function () { changes++; });
    run.revisionBeforeDirty = run.doc.revision;
    mod.emit('dirty', run.doc);
    off();
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    var actions = node ? node.querySelector('.plan-actions') : null;
    return JSON.stringify({
      revisionBefore: run.revisionBeforeDirty, revisionAfter: run.doc.revision, changes: changes,
      disabled: !!(actions && actions.querySelector('.primary') && actions.querySelector('.primary').disabled),
      plansBefore: (run.doc.editPlans || []).length,
      message: actions && actions.parentElement ? actions.parentElement.textContent.replace(/\\s+/g, ' ').slice(-220) : '',
    });
  });
})()`);
const dirtyOnlyRun = dirtyOnlyPlan.card ? await approvePlanIn('__epDirtyOnly', true) : null;
const dirtyOnlyAfter = await evJson(`(function(){
  var d = window.__epDirtyOnly.doc;
  return JSON.stringify({ notes: d.annots.filter(function (a) { return a.type === 'note'; }).length,
    plans: (d.editPlans || []).length });
})()`);
check('a dirty-only document notification immediately disables and invalidates approval',
  dirtyOnlyPlan.card && dirtyOnlyRun === null
  && dirtyOnlyState.revisionAfter > dirtyOnlyState.revisionBefore && dirtyOnlyState.changes === 0
  && dirtyOnlyState.disabled && /invalid|changed/i.test(dirtyOnlyState.message)
  && dirtyOnlyAfter.plans === dirtyOnlyState.plansBefore,
  JSON.stringify({ state: dirtyOnlyState, after: dirtyOnlyAfter }));

// Test cleanup only: the assertion above proves the app did not restore the
// external edit. Put the fixture title back for the remaining Task 4 cases.
await ev(`(async function(){
  var run = window.__epColor;
  var st = await import('/js/store.js');
  var te = await import('/js/textedit.js');
  var blocks = await te.editableBlocks(0);
  var target = blocks.find(function (b) { return b.key === run.targetKey; });
  if (target) await te.commitBlockEdit(0, target, ${JSON.stringify(TITLE)}, { label: 'Task 5 stale-plan cleanup' });
  return 1;
})()`);

const invalidColorOps = [
  { op: 'format_text_color', page: 4, find: TITLE, color: '#123ABC' },
  { op: 'format_text_color', page: PAGE, find: 'No such exact native title', color: '#123ABC' },
  { op: 'format_text_color', page: PAGE, find: '', color: '#123ABC' },
  { op: 'format_text_color', page: PAGE, find: TITLE, color: 'not-a-color' },
  { op: 'format_text_color', page: PAGE, find: TITLE, color: '123ABC' },
  { op: 'format_text_color', page: PAGE, find: TITLE, color: '#12345G' },
];
const invalidColorPlan = await beginPlanIn('__epColorInvalid', 'Reject malformed exact colour edits', invalidColorOps);
const invalidColorReasons = [
  /page.*does not exist/i, /not.*editable.*block|not found/i, /empty.*find/i,
  /color.*#RRGGBB/i, /color.*#RRGGBB/i, /color.*#RRGGBB/i,
];
check('missing pages/text, empty find, and invalid colours are rejected with visible reasons',
  invalidColorPlan.done && !invalidColorPlan.card && invalidColorPlan.failures.length === invalidColorOps.length
  && invalidColorReasons.every((reason, index) => reason.test(invalidColorPlan.failures[index] || ''))
  && invalidColorPlan.editsUnchanged,
  JSON.stringify(invalidColorPlan.failures));

const duplicateSetup = await addDuplicateTitleBlock();
const ambiguousColorPlan = await beginPlanIn('__epColorAmbiguous', 'Reject an ambiguous title colour edit', [exactColorOp]);
check('two exact matching blocks are rejected rather than choosing the first',
  duplicateSetup.changed && ambiguousColorPlan.done && !ambiguousColorPlan.card
  && ambiguousColorPlan.failures.length === 1 && /exactly one|ambiguous|multiple/i.test(ambiguousColorPlan.failures[0])
  && ambiguousColorPlan.editsUnchanged,
  JSON.stringify({ setup: duplicateSetup, failures: ambiguousColorPlan.failures }));
await removeTask4Temp(duplicateSetup.id);

const candidateFailures = [
  { mode: 'missing-text', color: '#234BCD', reason: /wording|text/i },
  { mode: 'missing-color', color: '#345CDE', reason: /fill|colour|color|operator/i },
  { mode: 'color-after-text', color: '#456DEF', reason: /before|preced|fill|colour|color|operator/i },
];
for (const failure of candidateFailures) {
  const slot = '__epColor' + failure.mode;
  const plan = await beginPlanIn(slot, 'Verify exact title colour candidate bytes', [
    { op: 'format_text_color', page: PAGE, find: TITLE, color: failure.color },
  ], failure.mode);
  const before = plan.card ? await transactionState(slot) : null;
  const run = plan.card ? await approvePlanIn(slot) : null;
  const after = plan.card ? await transactionState(slot) : null;
  const verdict = run && run.verdicts[0];
  check(`candidate verification fails closed for ${failure.mode}`,
    plan.card && run && run.records[0].status === 'applied' && verdict && verdict.ok === false
    && run.committed === false && failure.reason.test(verdict.detail)
    && JSON.stringify(after) === JSON.stringify(before),
    JSON.stringify(verdict));
}

const freshDoc = await PL.PDFDocument.create();
const freshFont = await freshDoc.embedFont(PL.StandardFonts.Helvetica);
const freshPage = freshDoc.addPage([595.28, 841.89]);
freshPage.drawText(TITLE, { x: 50, y: 760, size: 16, font: freshFont, color: PL.rgb(0, 0, 0) });
freshPage.drawText('A separate native line.', { x: 50, y: 730, size: 12, font: freshFont, color: PL.rgb(0, 0, 0) });
await openSyntheticBytes(await freshDoc.save({ useObjectStreams: true }), 'task4-fresh-title.pdf');
await ev(`(function(){
  return import('/js/store.js').then(function (mod) {
    window.__epFreshSettings = {
      textAlign: mod.settings.textAlign, textCharSpacing: mod.settings.textCharSpacing,
      textHScale: mod.settings.textHScale, textBold: mod.settings.textBold,
      textItalic: mod.settings.textItalic, textUnderline: mod.settings.textUnderline,
    };
    mod.settings.textAlign = 'right';
    mod.settings.textCharSpacing = 2;
    mod.settings.textHScale = 80;
    mod.settings.textBold = true;
    mod.settings.textItalic = true;
    mod.settings.textUnderline = true;
    return 1;
  });
})()`);
const freshColorPlan = await beginPlanIn('__epColorFresh', 'Colour a fresh native title without inheriting house styles', [
  { op: 'format_text_color', page: PAGE, find: TITLE, color: '#56789A' },
]);
const freshSource = freshColorPlan.card ? await evJson(`(async function(){
  var te = await import('/js/textedit.js');
  var blocks = await te.editableBlocks(0);
  var block = blocks.find(function (b) { return b.text === ${JSON.stringify(TITLE)}; });
  var fields = ['text', 'fontFamily', 'size', 'baseline', 'rect', 'coverRect', 'maxWidth', 'maxHeight', 'lineHeight', 'angle'];
  var source = {};
  fields.forEach(function (field) { source[field] = block[field]; });
  return JSON.stringify(source);
})()`) : null;
const freshColorRun = freshColorPlan.card ? await approvePlanIn('__epColorFresh') : null;
const freshColorState = await evJson(`(function(){
  var d = window.__epColorFresh.doc;
  var edit = d.textEdits.find(function (e) { return e.page === 0 && e.text === ${JSON.stringify(TITLE)}; });
  return JSON.stringify(edit ? {
    text: edit.text, fontFamily: edit.fontFamily, size: edit.size, baseline: edit.baseline,
    rect: edit.rect, coverRect: edit.coverRect, maxWidth: edit.maxWidth, maxHeight: edit.maxHeight,
    lineHeight: edit.lineHeight, angle: edit.angle, align: edit.align,
    charSpacing: edit.charSpacing, hScale: edit.hScale,
    bold: edit.bold, italic: edit.italic, underline: edit.underline,
    hex: '#' + edit.color.map(function (c) { return Math.round(c * 255).toString(16).padStart(2, '0'); }).join(''),
  } : null);
})()`);
await ev(`import('/js/store.js').then(function (mod) {
  var saved = window.__epFreshSettings;
  ['textAlign', 'textCharSpacing', 'textHScale', 'textBold', 'textItalic', 'textUnderline'].forEach(function (key) {
    mod.settings[key] = saved[key];
  });
  return 1;
})`);
check('a fresh native colour edit ignores house defaults and preserves source formatting and geometry',
  !!freshSource && !!freshColorState && freshColorRun && freshColorRun.records[0].status === 'applied'
  && freshColorRun.verdicts[0].ok === true && freshColorState.hex === '#56789a'
  && ['text', 'fontFamily', 'size', 'baseline', 'rect', 'coverRect', 'maxWidth', 'maxHeight', 'lineHeight', 'angle']
    .every((field) => JSON.stringify(freshSource[field]) === JSON.stringify(freshColorState[field]))
  && freshColorState.align === 'left' && freshColorState.charSpacing === 0 && freshColorState.hScale === 100
  && freshColorState.bold === false && freshColorState.italic === false && freshColorState.underline === false,
  JSON.stringify({ source: freshSource, edit: freshColorState }));
const freshCandidateBytes = await evJson('JSON.stringify(window.__epColorFresh.candidateBytes)');
const freshCandidateEvidence = freshCandidateBytes?.length
  ? await candidateTextColorEvidence(freshCandidateBytes, '#56789A') : null;
check('independent candidate bytes contain the fresh title after the requested fill colour',
  !!freshCandidateEvidence && freshCandidateEvidence.extracted.includes(TITLE)
  && freshCandidateEvidence.fillAt >= 0 && freshCandidateEvidence.textAt > freshCandidateEvidence.fillAt,
  JSON.stringify(freshCandidateEvidence && { extracted: freshCandidateEvidence.extracted.includes(TITLE),
    fillAt: freshCandidateEvidence.fillAt, textAt: freshCandidateEvidence.textAt }));

const noopBefore = await evJson(`(function(){
  var d = window.__epColorFresh.doc;
  var edit = d.textEdits.find(function (e) { return e.page === 0 && e.text === ${JSON.stringify(TITLE)}; });
  return JSON.stringify({ edits: d.textEdits.length, id: edit ? edit.id : '', history: d.history.length,
    dirty: !!d.dirty, plans: (d.editPlans || []).length,
    hex: edit ? '#' + edit.color.map(function (c) { return Math.round(c * 255).toString(16).padStart(2, '0'); }).join('') : '' });
})()`);
const noopPlan = await beginPlanIn('__epColorNoop', 'Reapply the title colour already in use', [
  { op: 'format_text_color', page: PAGE, find: TITLE, color: '#56789A' },
]);
await ev(`(function(){
  return import('/js/store.js').then(function (mod) {
    window.__epNoopDirtyEvents = 0;
    window.__epNoopDirtyOff = mod.on('dirty', function (doc) {
      if (doc === window.__epColorFresh.doc) window.__epNoopDirtyEvents++;
    });
    return 1;
  });
})()`);
const noopRun = noopPlan.card ? await approvePlanIn('__epColorNoop') : null;
const noopAfter = await evJson(`(function(){
  return import('/js/store.js').then(function (mod) {
    if (window.__epNoopDirtyOff) window.__epNoopDirtyOff();
    var d = window.__epColorFresh.doc;
    var edit = d.textEdits.find(function (e) { return e.page === 0 && e.text === ${JSON.stringify(TITLE)}; });
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    return JSON.stringify({ edits: d.textEdits.length, id: edit ? edit.id : '', history: d.history.length,
      dirty: !!d.dirty, plans: (d.editPlans || []).length, dirtyEvents: window.__epNoopDirtyEvents,
      footer: !!(node && node.querySelector('.plan-foot')),
      message: node ? node.textContent.replace(/\\s+/g, ' ').slice(-240) : '',
      hex: edit ? '#' + edit.color.map(function (c) { return Math.round(c * 255).toString(16).padStart(2, '0'); }).join('') : '' });
  });
})()`);
check('an all-no-op colour plan reports no changes required without history, dirty, audit, or save actions',
  noopPlan.card && noopRun && noopRun.noChanges === true && noopRun.committed === false
  && noopAfter.dirtyEvents === 0 && !noopAfter.footer && /no changes required/i.test(noopAfter.message)
  && ['edits', 'id', 'history', 'dirty', 'plans', 'hex']
    .every((field) => JSON.stringify(noopAfter[field]) === JSON.stringify(noopBefore[field])),
  JSON.stringify({ before: noopBefore, result: noopRun && { noChanges: noopRun.noChanges, committed: noopRun.committed }, after: noopAfter }));

const mixedNoopPlan = await beginPlanIn('__epColorNoopMixed', 'Apply one real highlight beside an unchanged colour', [
  { op: 'format_text_color', page: PAGE, find: TITLE, color: '#56789A' },
  { op: 'highlight', page: PAGE, search: 'A separate native line.' },
]);
const mixedNoopBefore = await transactionState('__epColorNoopMixed');
await ev(`(function(){
  return import('/js/store.js').then(function (mod) {
    window.__epMixedNoopDirtyEvents = 0;
    window.__epMixedNoopDirtyOff = mod.on('dirty', function (doc) {
      if (doc === window.__epColorNoopMixed.doc) window.__epMixedNoopDirtyEvents++;
    });
    return 1;
  });
})()`);
const mixedNoopRun = mixedNoopPlan.card ? await approvePlanIn('__epColorNoopMixed') : null;
const mixedNoopAfter = await transactionState('__epColorNoopMixed');
const mixedNoopState = await evJson(`(function(){
  return import('/js/store.js').then(function (mod) {
    if (window.__epMixedNoopDirtyOff) window.__epMixedNoopDirtyOff();
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    return JSON.stringify({ dirtyEvents: window.__epMixedNoopDirtyEvents,
      footer: !!(node && node.querySelector('.plan-foot')) });
  });
})()`);
check('a mixed no-op and real plan commits the real mutation exactly once',
  mixedNoopPlan.card && mixedNoopRun && mixedNoopRun.committed === true && mixedNoopRun.noChanges !== true
  && mixedNoopRun.records.length === 2 && mixedNoopRun.verdicts.every((v) => v.ok === true)
  && mixedNoopAfter.history.length === mixedNoopBefore.history.length + 1
  && mixedNoopAfter.annots.length === mixedNoopBefore.annots.length + 1
  && mixedNoopState.dirtyEvents === 1 && mixedNoopState.footer,
  JSON.stringify({ run: mixedNoopRun && { records: mixedNoopRun.records, verdicts: mixedNoopRun.verdicts }, state: mixedNoopState }));

const mixedDoc = await PL.PDFDocument.create();
const mixedFont = await mixedDoc.embedFont(PL.StandardFonts.Helvetica);
const mixedPage = mixedDoc.addPage([595.28, 841.89]);
const mixedPrefix = 'AiPDF Editor ';
const mixedSuffix = 'verified test fixture.';
mixedPage.drawText(mixedPrefix, { x: 50, y: 760, size: 16, font: mixedFont, color: PL.rgb(1, 0, 0) });
mixedPage.drawText(mixedSuffix, {
  x: 50 + mixedFont.widthOfTextAtSize(mixedPrefix, 16), y: 760, size: 16, font: mixedFont, color: PL.rgb(0, 0, 1),
});
await openSyntheticBytes(await mixedDoc.save({ useObjectStreams: true }), 'task4-mixed-colour.pdf');
const mixedColorPlan = await beginPlanIn('__epColorMixed', 'Reject a mixed-colour title', [exactColorOp]);
check('a native block with mixed original run colours is rejected',
  mixedColorPlan.done && !mixedColorPlan.card && mixedColorPlan.failures.length === 1
  && /mixed.*(colour|color)|multiple.*(colour|color)/i.test(mixedColorPlan.failures[0])
  && mixedColorPlan.editsUnchanged,
  JSON.stringify(mixedColorPlan.failures));

const scanDoc = await PL.PDFDocument.create();
const scanPage = scanDoc.addPage([595.28, 841.89]);
scanPage.drawRectangle({ x: 40, y: 700, width: 240, height: 90, color: PL.rgb(0.92, 0.92, 0.92), borderWidth: 0 });
await openSyntheticBytes(await scanDoc.save({ useObjectStreams: true }), 'task4-no-text-layer.pdf');
const scanColorPlan = await beginPlanIn('__epColorScan', 'Reject a title colour edit on a scan', [exactColorOp]);
check('a scanned or no-text-layer page is rejected instead of inventing a native target',
  scanColorPlan.done && !scanColorPlan.card && scanColorPlan.failures.length === 1
  && /no native text|text layer|scan|OCR/i.test(scanColorPlan.failures[0])
  && scanColorPlan.editsUnchanged,
  JSON.stringify(scanColorPlan.failures));

/* ── 8. Fix round 1: fail closed at real evidence boundaries ─────────────── */

const formBoundary = await boundaryRunState('form');
const formTitleRun = formBoundary.runs?.find((run) => run.text === TITLE);
check('a Form XObject boundary restores fill, font, rendering, and spacing for later native text',
  formBoundary.available && formTitleRun && formTitleRun.font === formBoundary.outerFont
  && JSON.stringify(formTitleRun.color) === JSON.stringify([0, 0, 0])
  && formTitleRun.renderMode === 0 && formTitleRun.inForm === false
  && formTitleRun.charSpacing === 0 && formTitleRun.wordSpacing === 0
  && formTitleRun.hScale === 100 && formTitleRun.textRise === 0,
  JSON.stringify({ outerFont: formBoundary.outerFont, title: formTitleRun }));

const annotationBoundary = await boundaryRunState('annotation');
const secondAnnotationRun = annotationBoundary.runs?.find((run) => run.text === 'Second annotation');
check('an annotation boundary restores tracked state before the next annotation appearance',
  annotationBoundary.available && secondAnnotationRun && secondAnnotationRun.font === annotationBoundary.outerFont
  && JSON.stringify(secondAnnotationRun.color) === JSON.stringify([0, 0, 0])
  && secondAnnotationRun.renderMode === 0 && secondAnnotationRun.inAnnotation === true
  && secondAnnotationRun.charSpacing === 0 && secondAnnotationRun.wordSpacing === 0
  && secondAnnotationRun.hScale === 100 && secondAnnotationRun.textRise === 0,
  JSON.stringify({ outerFont: annotationBoundary.outerFont, second: secondAnnotationRun }));

await openSyntheticBytes(await makeBoundaryFixture('form-color'), 'task4-form-colour-evidence.pdf');
const formColorPlan = await beginPlanIn('__epColorForm', 'Colour a native title after a red form', [exactColorOp]);
const formColorRun = formColorPlan.card ? await approvePlanIn('__epColorForm') : null;
const formColorTarget = formColorRun && formColorRun.plan.ops[0].target;
check('form colour cannot contaminate later native source-colour evidence',
  formColorPlan.card && formColorRun && formColorRun.records[0].status === 'applied'
  && formColorRun.verdicts[0].ok === true && formColorTarget
  && JSON.stringify(formColorTarget.block.colors) === JSON.stringify([[0, 0, 0]]),
  JSON.stringify({ plan: formColorPlan.rows, target: formColorTarget && formColorTarget.block.colors,
    verdict: formColorRun && formColorRun.verdicts[0] }));

await openSyntheticBytes(await makeMultilineFixture(), 'task4-multiline-geometry.pdf');
const multilineOps = [
  { op: 'format_text_color', page: PAGE, find: 'Centered title\nsecond line', color: '#123ABC' },
  { op: 'format_text_color', page: PAGE, find: 'Uneven title\nmiddle line\nlast line', color: '#123ABC' },
];
const multilinePlan = await beginPlanIn('__epColorMultiline', 'Reject multiline titles without exact per-line geometry', multilineOps);
check('fresh centered and uneven-leading multiline colour targets fail closed',
  multilinePlan.done && !multilinePlan.card && multilinePlan.failures.length === 2
  && multilinePlan.failures.every((failure) => /multiline|per-line|geometry/i.test(failure))
  && multilinePlan.editsUnchanged,
  JSON.stringify(multilinePlan.failures));

await openSyntheticBytes(await makeUnregisteredFontFixture(), 'task4-unregistered-font.pdf');
const unregisteredFontPlan = await beginPlanIn('__epColorUnregisteredFont', 'Reject a colour rewrite that would substitute an unregistered face', [exactColorOp]);
check('an unregistered non-Standard-14 source font is rejected instead of silently changing face or metrics',
  unregisteredFontPlan.done && !unregisteredFontPlan.card && unregisteredFontPlan.failures.length === 1
  && /font|standard-14|registered|glyph|unsupported/i.test(unregisteredFontPlan.failures[0])
  && unregisteredFontPlan.editsUnchanged,
  JSON.stringify(unregisteredFontPlan.failures));

await openSyntheticBytes(await makeEmbeddedFontFixture(), 'task4-embedded-non-winansi.pdf');
const embeddedFontPlan = await beginPlanIn('__epColorEmbeddedFont', 'Preserve an embedded face while colouring non-WinAnsi text', [
  { op: 'format_text_color', page: PAGE, find: NON_WINANSI_TITLE, color: '#123ABC' },
]);
const embeddedFontRun = embeddedFontPlan.card ? await approvePlanIn('__epColorEmbeddedFont') : null;
const embeddedFontState = await evJson(`(async function(){
  var run = window.__epColorEmbeddedFont;
  var app = await import('/js/app.js');
  var edit = run.doc.textEdits.find(function (e) { return e.text === ${JSON.stringify(NON_WINANSI_TITLE)}; });
  var texts = run.candidateBytes ? await app.extractTextFromBytes(new Uint8Array(run.candidateBytes)) : [];
  return JSON.stringify({ family: edit ? edit.fontFamily : '', text: edit ? edit.text : '',
    extracted: !!(texts[0] || '').includes(${JSON.stringify(NON_WINANSI_TITLE)}) });
})()`);
check('an embedded source face covers and preserves non-WinAnsi wording through candidate verification',
  embeddedFontPlan.card && embeddedFontRun && embeddedFontRun.records[0].status === 'applied'
  && embeddedFontRun.verdicts[0].ok === true && embeddedFontState.family === 'sans-serif'
  && embeddedFontState.text === NON_WINANSI_TITLE && embeddedFontState.extracted,
  JSON.stringify({ record: embeddedFontRun && embeddedFontRun.records[0], verdict: embeddedFontRun && embeddedFontRun.verdicts[0], state: embeddedFontState }));

/* ── 9. Task 5: transactional plans and explicit Save As ───────────────── */

const task5Fixture = fs.readFileSync(FIXTURE);
await openSyntheticBytes(task5Fixture, 'task5-transactional.pdf');

const snapshotCheck = await evJson(`(async function(){
  var st = await import('/js/store.js');
  if (typeof st.captureModel !== 'function' || typeof st.restoreModel !== 'function') {
    return JSON.stringify({ available: false, revisionDefault: st.newDocShell().revision });
  }
  var d = st.newDocShell({
    id: 'snapshot-doc', revision: 7, numPages: 2,
    pageSizes: [{ w: 200, h: 300 }, { w: 400, h: 500 }],
    pageOps: { items: [{ t: 'src', i: 0 }, { t: 'src', i: 1 }] },
    pageRotate: { 1: 90 }, crops: { 0: [1, 2, 190, 280] },
    meta: { title: 'Snapshot title', keywords: ['alpha'] },
    attachments: [{ filename: 'snapshot.txt', data: new Uint8Array([1, 2, 3]) }],
    newFields: [{ name: 'snapshot-field', page: 0 }],
    annots: [{ id: 'snapshot-note', type: 'note', page: 0, rect: [1, 2, 20, 20], text: 'snapshot' }],
    textEdits: [{ id: 'snapshot-edit', page: 0, text: 'before' }],
    stamps: [{ id: 'snapshot-stamp', text: 'before' }],
    dirty: true, history: ['base', 'prior'], hIndex: 0,
  });
  var capture = function () {
    return JSON.stringify({
      numPages: d.numPages, pageSizes: d.pageSizes, pageOps: d.pageOps,
      pageRotate: d.pageRotate, crops: d.crops, meta: d.meta,
      attachments: d.attachments, newFields: d.newFields, annots: d.annots,
      textEdits: d.textEdits, stamps: d.stamps,
      dirty: !!d.dirty, history: d.history, hIndex: d.hIndex,
    });
  };
  var expected = capture();
  var snapshot = st.captureModel(d);
  d.meta.title = 'changed';
  d.attachments[0].data[0] = 9;
  d.newFields.push({ name: 'changed' });
  d.annots[0].text = 'changed';
  d.textEdits[0].text = 'changed';
  d.stamps[0].text = 'changed';
  d.pageRotate[1] = 180;
  d.crops[0][0] = 99;
  d.dirty = false;
  d.history.push('changed');
  d.hIndex = 2;
  st.restoreModel(d, snapshot);
  var same = capture() === expected;
  d.meta.title = 'changed again';
  st.restoreModel(d, snapshot);
  return JSON.stringify({
    available: true, same: same && capture() === expected, revision: d.revision,
    attachmentBytesTyped: d.attachments[0].data instanceof Uint8Array,
  });
})()`);
check('captureModel/restoreModel round-trip the complete plan model, dirty flag, and history',
  snapshotCheck && snapshotCheck.available && snapshotCheck.same
  && snapshotCheck.attachmentBytesTyped
  && Number.isInteger(snapshotCheck.revision) && snapshotCheck.revision >= 7,
  JSON.stringify(snapshotCheck));

const writerFixtureDoc = await PL.PDFDocument.create();
const writerFixtureFont = await writerFixtureDoc.embedFont(PL.StandardFonts.Helvetica);
const writerFixturePage = writerFixtureDoc.addPage([595.28, 841.89]);
writerFixturePage.drawText('functional test fixture', { x: 50, y: 760, size: 16, font: writerFixtureFont });
writerFixturePage.drawText(TITLE, { x: 50, y: 680, size: 16, font: writerFixtureFont });
const writerFixture = await writerFixtureDoc.save({ useObjectStreams: true });
const writerSwitch = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var app = await import('/js/app.js');
  var agent = await import('/js/agent.js');
  var out = [];
  var cases = [
    { kind: 'replace_text', args: { page: 1, find: 'functional test fixture', replace: 'writer switch replacement' } },
    { kind: 'style_text', args: { page: 1, find: ${JSON.stringify(TITLE)}, color: '#123ABC' } },
  ];
  for (var c = 0; c < cases.length; c++) {
    var item = cases[c];
    var a = await app.openDocFromBytes(new Uint8Array(${JSON.stringify(Array.from(writerFixture))}), 'task5-writer-' + item.kind + '-a.pdf');
    var b = await app.openDocFromBytes(new Uint8Array(${JSON.stringify(Array.from(writerFixture))}), 'task5-writer-' + item.kind + '-b.pdf');
    var pending = agent.TOOLS[item.kind](a, item.args, { commit: function () {}, deferCommit: true });
    var tabs = Array.prototype.slice.call(document.querySelectorAll('#tabStrip .tab'));
    var tab = tabs.find(function (node) { return node.querySelector('.t-name').textContent === b.name; });
    if (tab) tab.click();
    var result = await pending;
    for (var wait = 0; wait < 100; wait++) {
      var activeTab = document.querySelector('#tabStrip .tab.active .t-name');
      if (activeTab && activeTab.textContent === b.name) break;
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
    out.push({ kind: item.kind, ok: !!(result && result.ok), error: result && result.error,
      activeIsB: st.activeDoc() === b, aEdits: a.textEdits.length, bEdits: b.textEdits.length });
  }
  return JSON.stringify(out);
})()`);
check('replace_text and style_text cannot write into a newly active document after an async tab switch',
  Array.isArray(writerSwitch) && writerSwitch.length === 2
  && writerSwitch.every((item) => item.ok === false && item.activeIsB === true
    && item.aEdits === 0 && item.bEdits === 0 && /document|switched|changed/i.test(item.error || '')),
  JSON.stringify(writerSwitch));

const legacyWriterSwitch = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var app = await import('/js/app.js');
  var te = await import('/js/textedit.js');
  var out = [];
  async function openPair(name) {
    var b = await app.openDocFromBytes(new Uint8Array(${JSON.stringify(Array.from(writerFixture))}), name + '-b.pdf');
    var a = await app.openDocFromBytes(new Uint8Array(${JSON.stringify(Array.from(writerFixture))}), name + '-a.pdf');
    return { a: a, b: b };
  }
  function activate(doc) {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('#tabStrip .tab'));
    var tab = tabs.find(function (node) { return node.querySelector('.t-name').textContent === doc.name; });
    if (tab) tab.click();
  }
  var direct = await openPair('task5-legacy-direct-switch');
  var directBlocks = await te.editableBlocks(0, direct.a);
  var directIndex = directBlocks.findIndex(function (block) { return block.text === 'functional test fixture'; });
  var editor = await te.openDirectEditor(0, directIndex, { askText: false });
  if (!editor) return JSON.stringify({ error: 'Direct Editor did not open', cases: out });
  editor.el.querySelector('.direct-editor-surface').innerText = 'Direct Editor switch must not apply.';
  var directPending = editor.commit();
  activate(direct.b);
  await directPending;
  out.push({ kind: 'direct-editor', activeIsB: st.activeDoc() === direct.b,
    aEdits: direct.a.textEdits.length, bEdits: direct.b.textEdits.length });

  var mergeCases = [[0], [0, 1]];
  for (var i = 0; i < mergeCases.length; i++) {
    var pair = await openPair('task5-legacy-merge-switch-' + mergeCases[i].length);
    var pending = te.mergeBlocksIntoParagraph(0, mergeCases[i], { text: 'Merged block switch must not apply.' });
    activate(pair.b);
    var changed = await pending;
    out.push({ kind: 'merge-' + mergeCases[i].length, changed: !!changed,
      activeIsB: st.activeDoc() === pair.b, aEdits: pair.a.textEdits.length, bEdits: pair.b.textEdits.length });
  }
  return JSON.stringify({ cases: out });
})()`);
const legacyDirectSwitch = legacyWriterSwitch?.cases?.find((item) => item.kind === 'direct-editor');
check('Direct Editor commitInner keeps its captured document across the font-probe await',
  !!legacyDirectSwitch && legacyDirectSwitch.activeIsB
  && legacyDirectSwitch.aEdits === 0 && legacyDirectSwitch.bEdits === 0,
  JSON.stringify(legacyWriterSwitch));
const legacyMergeSwitch = legacyWriterSwitch?.cases?.filter((item) => item.kind.startsWith('merge-'));
check('single- and multi-block paragraph commits keep their captured document across extraction',
  Array.isArray(legacyMergeSwitch) && legacyMergeSwitch.length === 2
  && legacyMergeSwitch.every((item) => item.activeIsB && item.changed === false
    && item.aEdits === 0 && item.bEdits === 0),
  JSON.stringify(legacyMergeSwitch));

const attachmentFixtureDoc = await PL.PDFDocument.create();
const attachmentFixtureFont = await attachmentFixtureDoc.embedFont(PL.StandardFonts.Helvetica);
attachmentFixtureDoc.addPage([595.28, 841.89]).drawText(TITLE, { x: 50, y: 760, size: 16, font: attachmentFixtureFont });
await openSyntheticBytes(await attachmentFixtureDoc.save({ useObjectStreams: true }), 'task5-attachment-history.pdf');
const attachmentHistory = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var app = await import('/js/app.js');
  var viewer = await import('/js/viewer.js');
  var d = st.activeDoc();
  d.attachments = [{ filename: 'synthetic-history.bin', data: new Uint8Array([0, 1, 2, 127, 255]), description: '' }];
  var original = d.attachments[0];
  st.pushHistory('attachment baseline');
  st.addAnnot({ type: 'note', page: 0, rect: [40, 40, 90, 90], color: [1, 1, 0], text: 'Attachment history edit' });
  st.pushHistory('attachment history');
  var undone = st.undo();
  var afterUndo = d.attachments[0];
  var redone = st.redo();
  var afterRedo = d.attachments[0];
  var bytes = await app.buildDocBytes(d);
  var pdf = await viewer.loadPdfBytes(bytes);
  var raw = (await pdf.getAttachments()) || {};
  var saved = Object.values(raw)[0];
  var savedData = saved && saved.content ? Array.from(saved.content) : null;
  await pdf.destroy();
  return JSON.stringify({
    originalTyped: original.data instanceof Uint8Array, original: Array.from(original.data),
    undone: undone, redone: redone,
    undoTyped: !!afterUndo && afterUndo.data instanceof Uint8Array, undo: afterUndo ? Array.from(afterUndo.data) : null,
    redoTyped: !!afterRedo && afterRedo.data instanceof Uint8Array, redo: afterRedo ? Array.from(afterRedo.data) : null,
    saved: savedData,
  });
})()`);
check('normal JSON history preserves attachment Uint8Array data through undo, redo, and the save writer',
  attachmentHistory && attachmentHistory.originalTyped
  && attachmentHistory.undone && attachmentHistory.redone
  && attachmentHistory.undoTyped && attachmentHistory.redoTyped
  && JSON.stringify(attachmentHistory.original) === '[0,1,2,127,255]'
  && JSON.stringify(attachmentHistory.undo) === JSON.stringify(attachmentHistory.original)
  && JSON.stringify(attachmentHistory.redo) === JSON.stringify(attachmentHistory.original)
  && JSON.stringify(attachmentHistory.saved) === JSON.stringify(attachmentHistory.original),
  JSON.stringify(attachmentHistory));

const rotatedFixtureDoc = await PL.PDFDocument.create();
const rotatedFixtureFont = await rotatedFixtureDoc.embedFont(PL.StandardFonts.Helvetica);
const rotatedPageOne = rotatedFixtureDoc.addPage([595.28, 841.89]);
rotatedPageOne.setRotation(PL.degrees(90));
rotatedPageOne.drawText(TITLE, { x: 50, y: 760, size: 16, font: rotatedFixtureFont });
const rotatedPageTwo = rotatedFixtureDoc.addPage([595.28, 841.89]);
rotatedPageTwo.setRotation(PL.degrees(270));
rotatedPageTwo.drawText('Intrinsically rotated second page.', { x: 50, y: 760, size: 16, font: rotatedFixtureFont });
await openSyntheticBytes(await rotatedFixtureDoc.save({ useObjectStreams: true }), 'task5-intrinsic-rotation.pdf');
const rotationPlan = await beginPlanIn('__epIntrinsicRotation', 'Rotate an intrinsically rotated page', [
  { op: 'rotate_pages', pages: '1', degrees: 90 },
]);
const rotationRun = rotationPlan.card ? await approvePlanIn('__epIntrinsicRotation') : null;
const rotationState = await evJson(`(async function(){
  var d = window.__epIntrinsicRotation.doc;
  var app = await import('/js/app.js');
  var viewer = await import('/js/viewer.js');
  var bytes = await app.buildDocBytes(d);
  var pdf = await viewer.loadPdfBytes(bytes);
  var rotations = [];
  for (var i = 1; i <= pdf.numPages; i++) rotations.push((await pdf.getPage(i)).rotate || 0);
  await pdf.destroy();
  return JSON.stringify({ delta: d.pageRotate[0], written: rotations });
})()`);
check('rotation verification expects intrinsic PDF rotation plus the requested relative delta',
  rotationPlan.card && rotationRun && rotationRun.committed === true
  && rotationRun.verdicts[0].ok === true
  && JSON.stringify(rotationRun.records[0].expectedRotations) === JSON.stringify({ 0: 180, 1: 270 })
  && rotationState.delta === 90 && JSON.stringify(rotationState.written) === '[180,270]',
  JSON.stringify({ run: rotationRun && { records: rotationRun.records, verdicts: rotationRun.verdicts }, state: rotationState }));

await openSyntheticBytes(task5Fixture, 'task5-annotation-content.pdf');
const annotationContentPlan = await beginPlanIn('__epAnnotationContent', 'Verify note content in candidate bytes', [
  { op: 'note', page: PAGE, text: 'Candidate note content' },
], 'wrong-annotation-content');
const annotationContentBefore = await transactionState('__epAnnotationContent');
const annotationContentRun = annotationContentPlan.card ? await approvePlanIn('__epAnnotationContent') : null;
const annotationContentAfter = await transactionState('__epAnnotationContent');
check('annotation verification reads candidate note content instead of trusting doc.annots',
  annotationContentPlan.card && annotationContentRun && annotationContentRun.committed === false
  && annotationContentRun.verdicts[0].ok === false && /annotation|content/i.test(annotationContentRun.verdicts[0].detail)
  && JSON.stringify(annotationContentAfter) === JSON.stringify(annotationContentBefore),
  JSON.stringify(annotationContentRun && annotationContentRun.verdicts[0]));

await openSyntheticBytes(task5Fixture, 'task5-annotation-rect.pdf');
const annotationRectPlan = await beginPlanIn('__epAnnotationRect', 'Verify highlight geometry in candidate bytes', [
  { op: 'highlight', page: PAGE, search: 'AiPDF Editor' },
], 'missing-annotation');
const annotationRectBefore = await transactionState('__epAnnotationRect');
const annotationRectRun = annotationRectPlan.card ? await approvePlanIn('__epAnnotationRect') : null;
const annotationRectAfter = await transactionState('__epAnnotationRect');
check('the specific candidate annotation check is reached even when expectedRect and expectedAnnotation both exist',
  annotationRectPlan.card && annotationRectRun && annotationRectRun.committed === false
  && annotationRectRun.records[0].expectedRect && annotationRectRun.records[0].expectedAnnotation
  && annotationRectRun.verdicts[0].ok === false && /annotation/i.test(annotationRectRun.verdicts[0].detail)
  && JSON.stringify(annotationRectAfter) === JSON.stringify(annotationRectBefore),
  JSON.stringify(annotationRectRun && annotationRectRun.verdicts[0]));

const twoHighlights = [
  { op: 'highlight', page: PAGE, search: 'AiPDF Editor' },
  { op: 'highlight', page: PAGE, search: 'must be extractable' },
];
const twoHighlightPlan = await beginPlanIn('__epTxnTwo', 'Add two review highlights', twoHighlights);
const twoHighlightBefore = await transactionState('__epTxnTwo');
await ev(`(function(){
  var st = import('/js/store.js');
  return st.then(function (mod) {
    var run = window.__epTxnTwo;
    window.__epTxnDirtyEvents = 0;
    window.__epTxnDirtyOff = mod.on('dirty', function (doc) {
      if (doc === run.doc) window.__epTxnDirtyEvents++;
    });
    return 1;
  });
})()`);
const twoHighlightRun = await approvePlanIn('__epTxnTwo');
const twoHighlightAfter = await transactionState('__epTxnTwo');
const twoHighlightUi = await evJson(`(function(){
  var st = import('/js/store.js');
  return st.then(function (mod) {
    var run = window.__epTxnTwo;
    if (window.__epTxnDirtyOff) window.__epTxnDirtyOff();
    var nodes = document.querySelectorAll('.msg.ai');
    var foot = nodes[nodes.length - 1].querySelector('.plan-foot');
    var buttons = foot ? Array.prototype.slice.call(foot.querySelectorAll('button')).map(function (b) { return b.textContent.trim(); }) : [];
    var save = buttons.indexOf('Save changes') >= 0 ? foot.querySelectorAll('button')[buttons.indexOf('Save changes')] : null;
    var saveAs = buttons.indexOf('Save As…') >= 0 ? foot.querySelectorAll('button')[buttons.indexOf('Save As…')] : null;
    if (save) save.click();
    if (saveAs) saveAs.click();
    return JSON.stringify({
      labels: buttons, saveCalls: run.saveCalls, saveAsCalls: run.saveAsCalls,
      savedDocMatches: run.savedDoc === run.doc, savedAsDocMatches: run.savedAsDoc === run.doc,
      dirtyEvents: window.__epTxnDirtyEvents,
    });
  });
})()`);
check('two approved nonstructural operations commit one history entry and one dirty transition',
  twoHighlightPlan.card && twoHighlightRun && twoHighlightRun.committed === true
  && twoHighlightRun.records.length === 2 && twoHighlightRun.records.every((r) => r.status === 'applied')
  && twoHighlightRun.verdicts.every((v) => v.ok === true)
  && twoHighlightAfter.history.length === twoHighlightBefore.history.length + 1
  && twoHighlightAfter.hIndex === twoHighlightBefore.hIndex + 1
  && twoHighlightAfter.annots.length === twoHighlightBefore.annots.length + 2
  && twoHighlightAfter.dirty === true && twoHighlightUi.dirtyEvents === 1,
  JSON.stringify({ records: twoHighlightRun && twoHighlightRun.records, verdicts: twoHighlightRun && twoHighlightRun.verdicts,
    history: [twoHighlightBefore.history.length, twoHighlightAfter.history.length], dirtyEvents: twoHighlightUi.dirtyEvents }));
check('the plan footer exposes separate Save changes and Save As… actions wired to the matching helpers',
  twoHighlightUi.labels.includes('Save changes') && twoHighlightUi.labels.includes('Save As…')
  && twoHighlightUi.saveCalls === 1 && twoHighlightUi.saveAsCalls === 1
  && twoHighlightUi.savedDocMatches && twoHighlightUi.savedAsDocMatches,
  JSON.stringify(twoHighlightUi));
const undoRedoState = await evJson(`(function(){
  var st = import('/js/store.js');
  return st.then(function (mod) {
    var d = window.__epTxnTwo.doc;
    var after = d.annots.filter(function (a) { return a.type === 'highlight'; }).length;
    var undone = mod.undo();
    var afterUndo = d.annots.filter(function (a) { return a.type === 'highlight'; }).length;
    var redone = mod.redo();
    var afterRedo = d.annots.filter(function (a) { return a.type === 'highlight'; }).length;
    return JSON.stringify({ after: after, undone: undone, afterUndo: afterUndo, redone: redone, afterRedo: afterRedo,
      history: d.history.length, hIndex: d.hIndex });
  });
})()`);
check('one undo/redo step restores both operations from the single plan history entry',
  undoRedoState.undone && undoRedoState.redone
  && undoRedoState.afterUndo === twoHighlightBefore.annots.filter((a) => a.type === 'highlight').length
  && undoRedoState.afterRedo === undoRedoState.after
  && undoRedoState.history === twoHighlightAfter.history.length
  && undoRedoState.hIndex === twoHighlightAfter.hIndex,
  JSON.stringify(undoRedoState));

const gatedOpenDoc = await PL.PDFDocument.create();
gatedOpenDoc.addPage([595.28, 841.89]);
const gatedOpenBytes = await gatedOpenDoc.save({ useObjectStreams: true });
await openSyntheticBytes(task5Fixture, 'task5-lock-other.pdf');
await openSyntheticBytes(task5Fixture, 'task5-busy-gate.pdf');
await ev(`(function(){
  return import('/js/store.js').then(function (mod) {
    var d = mod.activeDoc();
    d.annots.push({ id: 'transaction-lock-textbox', type: 'textbox', page: 0,
      rect: [40, 40, 240, 90], text: 'Transaction lock fixture', color: [0, 0, 0], bold: false });
    mod.state.selection = ['transaction-lock-textbox'];
    mod.pushHistory('transaction lock fixture');
    window.__epLockOther = mod.state.docs.find(function (doc) { return doc.name === 'task5-lock-other.pdf'; });
    window.__epLockBaselineHistory = d.history.length;
    return 1;
  });
})()`);
const gatedPlan = await beginPlanIn('__epTxnGated', 'Add one highlight', [twoHighlights[0]], 'gated');
await ev(`(function(){
  var nodes = document.querySelectorAll('.msg.ai');
  nodes[nodes.length - 1].querySelector('.plan-actions .primary').click();
  return 1;
})()`);
let gatedWaited = 0;
while (gatedWaited < 30000 && !(await ev('!!window.__epTxnGated.stagingStarted'))) { await sleep(100); gatedWaited += 100; }
const gatedState = await evJson(`(function(){
  var run = window.__epTxnGated;
  return JSON.stringify({
    started: run.stagingStarted, busy: run.busyAtStaging,
    history: run.historyAtStaging, dirty: run.dirtyAtStaging,
    expectedHistory: run.historyBefore, expectedDirty: run.dirtyBefore,
  });
})()`);
const lockAttempt = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var app = await import('/js/app.js');
  var run = window.__epTxnGated;
  var other = window.__epLockOther;
  var docsBefore = st.state.docs.length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
  var input = document.querySelector('#findInput');
  input.value = 'transaction-input-must-be-blocked';
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('#tabStrip .tab'));
  var otherTab = tabs.find(function (node) { return node.querySelector('.t-name').textContent === other.name; });
  if (otherTab) otherTab.click();
  var close = otherTab && otherTab.querySelector('.t-close');
  if (close) close.click();
  await new Promise(function (resolve) { setTimeout(resolve, 50); });
  var opened = await app.openDocFromBytes(new Uint8Array(${JSON.stringify(Array.from(gatedOpenBytes))}), 'task5-lock-open-blocked.pdf');
  var box = run.doc.annots.find(function (annot) { return annot.id === 'transaction-lock-textbox'; });
  return JSON.stringify({
    activeSame: st.activeDoc() === run.doc, docsBefore: docsBefore, docsAfter: st.state.docs.length,
    otherStillOpen: !!other && st.getDoc(other.id) === other, openBlocked: opened === null,
    search: st.state.search.query, bold: !!(box && box.bold), history: run.doc.history.length,
    baselineHistory: window.__epLockBaselineHistory,
  });
})()`);
if (!lockAttempt.activeSame) {
  await ev(`(async function(){
    var st = await import('/js/store.js');
    var target = window.__epTxnGated.doc;
    var tabs = Array.prototype.slice.call(document.querySelectorAll('#tabStrip .tab'));
    var tab = tabs.find(function (node) { return node.querySelector('.t-name').textContent === target.name; });
    if (tab) tab.click();
    for (var i = 0; i < 100 && st.activeDoc() !== target; i++) {
      await new Promise(function (resolve) { setTimeout(resolve, 10); });
    }
    return 1;
  })()`);
}
await ev('(function(){ if (window.__epTxnGated.releaseBuild) window.__epTxnGated.releaseBuild(); return 1; })()');
let gatedDone = 0;
while (gatedDone < 120000 && !(await ev('!!window.__epTxnGated.done'))) { await sleep(100); gatedDone += 100; }
const gatedRun = await evJson('JSON.stringify(window.__epTxnGated.result)');
const lockAfter = await evJson(`(function(){
  var st = import('/js/store.js');
  return st.then(function (mod) {
    var run = window.__epTxnGated;
    var box = run.doc.annots.find(function (annot) { return annot.id === 'transaction-lock-textbox'; });
    var input = document.querySelector('#findInput');
    input.value = 'transaction-input-after-release';
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    var released = mod.state.search.query === 'transaction-input-after-release';
    mod.state.search.query = '';
    return JSON.stringify({ committed: !!(run.result && run.result.committed), activeSame: mod.activeDoc() === run.doc,
      bold: !!(box && box.bold), history: run.doc.history.length,
      baselineHistory: window.__epLockBaselineHistory, released: released });
  });
})()`);
check('staging stays busy-gated without history or dirty side effects before candidate verification',
  gatedPlan.card && gatedState.started && gatedState.busy === true
  && gatedState.history === gatedState.expectedHistory
  && gatedState.dirty === gatedState.expectedDirty
  && gatedRun && gatedRun.committed === true,
  JSON.stringify(gatedState));
check('the transaction lock blocks tab switches, open/close, keyboard edits, and input until finally releases it',
  lockAttempt.activeSame && lockAttempt.docsAfter === lockAttempt.docsBefore
  && lockAttempt.otherStillOpen && lockAttempt.openBlocked && lockAttempt.search === ''
  && lockAttempt.bold === false && lockAttempt.history === lockAttempt.baselineHistory
  && lockAfter.committed && lockAfter.activeSame && lockAfter.bold === false
  && lockAfter.history === lockAfter.baselineHistory + 1 && lockAfter.released,
  JSON.stringify({ during: lockAttempt, after: lockAfter }));

const failureOps = [
  { op: 'highlight', page: PAGE, search: 'AiPDF Editor' },
  { op: 'highlight', page: PAGE, search: 'functional test fixture' },
  { op: 'highlight', page: PAGE, search: 'must be extractable' },
];
const failurePlan = await beginPlanIn('__epTxnFailure', 'Inject a second-operation failure', failureOps);
const failureBefore = await transactionState('__epTxnFailure');
await ev(`(async function(){
  var agent = await import('/js/agent.js');
  window.__epTxnOriginalHighlight = agent.TOOLS.add_highlight;
  window.__epTxnHighlightCalls = 0;
  agent.TOOLS.add_highlight = async function (doc, args, options) {
    window.__epTxnHighlightCalls++;
    if (window.__epTxnHighlightCalls === 2) throw new Error('Injected second-operation failure');
    return window.__epTxnOriginalHighlight(doc, args, options);
  };
  return 1;
})()`);
let failureRun = null;
try {
  failureRun = await approvePlanIn('__epTxnFailure');
} finally {
  await ev(`(async function(){
    var agent = await import('/js/agent.js');
    if (window.__epTxnOriginalHighlight) agent.TOOLS.add_highlight = window.__epTxnOriginalHighlight;
    return 1;
  })()`);
}
const failureAfter = await transactionState('__epTxnFailure');
const failureCalls = await ev('window.__epTxnHighlightCalls');
const failureHasFooter = await ev(`(function(){
  var nodes = document.querySelectorAll('.msg.ai');
  return !!nodes[nodes.length - 1].querySelector('.plan-foot');
})()`);
check('the first execution failure stops the plan and restores the exact model, dirty state, and history',
  failurePlan.card && failureRun && failureRun.committed === false
  && failureCalls === 2 && failureRun.records.length === 2
  && failureRun.records[0].status === 'applied' && failureRun.records[1].status === 'failed'
  && failureRun.verdicts.some((v) => v.ok === false)
  && JSON.stringify(failureAfter) === JSON.stringify(failureBefore)
  && !failureHasFooter,
  JSON.stringify({ calls: failureCalls, records: failureRun && failureRun.records,
    verdicts: failureRun && failureRun.verdicts }));

const metadataPlan = await beginPlanIn('__epTxnUnverified', 'Set metadata without an independent post-check', [
  { op: 'set_metadata', title: 'Task 5 verification title' },
]);
const metadataBefore = await transactionState('__epTxnUnverified');
const metadataRun = await approvePlanIn('__epTxnUnverified');
const metadataAfter = await transactionState('__epTxnUnverified');
const metadataHasFooter = await ev(`(function(){
  var nodes = document.querySelectorAll('.msg.ai');
  return !!nodes[nodes.length - 1].querySelector('.plan-foot');
})()`);
check('a required verification that is unavailable fails closed and rolls back instead of claiming success',
  metadataPlan.card && metadataRun && metadataRun.committed === false
  && metadataRun.verdicts[0].ok === false
  && /unverified|no independent|not independently/i.test(metadataRun.verdicts[0].detail)
  && JSON.stringify(metadataAfter) === JSON.stringify(metadataBefore)
  && !metadataHasFooter,
  JSON.stringify(metadataRun && metadataRun.verdicts[0]));

const emptyCandidatePlan = await beginPlanIn('__epTxnEmptyCandidate', 'Reject an incomplete candidate read', [twoHighlights[0]], 'empty-text');
const emptyCandidateBefore = await transactionState('__epTxnEmptyCandidate');
const emptyCandidateRun = await approvePlanIn('__epTxnEmptyCandidate');
const emptyCandidateAfter = await transactionState('__epTxnEmptyCandidate');
check('an incomplete candidate page read fails closed even for an annotation-only plan',
  emptyCandidatePlan.card && emptyCandidateRun && emptyCandidateRun.committed === false
  && emptyCandidateRun.verdicts[0].ok === false
  && /unverified|could not be rebuilt|independently read/i.test(emptyCandidateRun.verdicts[0].detail)
  && JSON.stringify(emptyCandidateAfter) === JSON.stringify(emptyCandidateBefore),
  JSON.stringify(emptyCandidateRun && emptyCandidateRun.verdicts[0]));

const mixedStructuralPlan = await beginPlanIn('__epTxnMixedStructural', 'Reject mixed structural and page-indexed work', [
  { op: 'delete_pages', pages: '3' },
  { op: 'highlight', page: PAGE, search: 'must be extractable' },
]);
const mixedStructuralBefore = await transactionState('__epTxnMixedStructural');
if (mixedStructuralPlan.card) await cancelPlanIn('__epTxnMixedStructural');
const mixedStructuralAfter = await transactionState('__epTxnMixedStructural');
check('mixed structural/page-indexed plans are rejected before approval',
  mixedStructuralPlan.done && !mixedStructuralPlan.card
  && mixedStructuralPlan.failures.some((failure) => /structural|combin|only one/i.test(failure))
  && JSON.stringify(mixedStructuralAfter) === JSON.stringify(mixedStructuralBefore),
  JSON.stringify(mixedStructuralPlan.failures));

const multipleStructuralPlan = await beginPlanIn('__epTxnMultipleStructural', 'Reject multiple structural operations', [
  { op: 'delete_pages', pages: '3' },
  { op: 'insert_blank_page', after: 1 },
]);
const multipleStructuralBefore = await transactionState('__epTxnMultipleStructural');
if (multipleStructuralPlan.card) await cancelPlanIn('__epTxnMultipleStructural');
const multipleStructuralAfter = await transactionState('__epTxnMultipleStructural');
check('multiple structural operations are rejected before approval',
  multipleStructuralPlan.done && !multipleStructuralPlan.card
  && multipleStructuralPlan.failures.some((failure) => /structural|only one/i.test(failure))
  && JSON.stringify(multipleStructuralAfter) === JSON.stringify(multipleStructuralBefore),
  JSON.stringify(multipleStructuralPlan.failures));

const switchSetup = await ev(`(async function(){
  var ep = await import('/js/editplan.js');
  var app = await import('/js/app.js');
  var st = await import('/js/store.js');
  var d = st.activeDoc();
  var nodes = document.querySelectorAll('.msg.ai');
  var prior = nodes[nodes.length - 1];
  window.__epSwitch = {
    done: false, result: null, error: null, doc: d,
    beforeNodeId: prior ? prior.dataset.id : '',
    before: JSON.stringify({ annots: d.annots, textEdits: d.textEdits, stamps: d.stamps,
      meta: d.meta, attachments: d.attachments, newFields: d.newFields,
      dirty: !!d.dirty, history: d.history, hIndex: d.hIndex }),
  };
  var deps = {
    app: { buildDocBytes: app.buildDocBytes, extractTextFromBytes: app.extractTextFromBytes,
      saveDoc: app.saveDoc, saveDocAs: app.saveDocAs, countInkPixels: app.countInkPixels },
    chat: async function () {
      await app.openDocFromBytes(new Uint8Array(${JSON.stringify(Array.from(task5Fixture))}), 'task5-switched.pdf', null);
      return { text: '', toolCalls: [{ id: 'switch-plan', name: 'propose_plan', args: {
        summary: 'A plan that must not survive a document switch.', operations: [
          { op: 'note', page: 1, text: 'SWITCHED PLAN MUST NOT APPLY' },
        ],
      } }] };
    },
  };
  ep.runVerifiedEdit('Switch documents during planning', deps)
    .then(function (result) { window.__epSwitch.result = result; window.__epSwitch.done = true; })
    .catch(function (error) { window.__epSwitch.error = String(error); window.__epSwitch.done = true; });
  return 'started';
})()`);
let switchWaited = 0;
let switchCardSeen = false;
while (switchWaited < 30000) {
  const status = await evJson(`(function(){
    var run = window.__epSwitch;
    var nodes = document.querySelectorAll('.msg.ai');
    var node = nodes[nodes.length - 1];
    var card = node && node.dataset.id !== run.beforeNodeId ? node.querySelector('.plan-actions') : null;
    return JSON.stringify({ done: run.done, card: !!card });
  })()`);
  if (status.card) {
    switchCardSeen = true;
    await ev(`(function(){
      var nodes = document.querySelectorAll('.msg.ai');
      nodes[nodes.length - 1].querySelector('.plan-actions .mini-btn:not(.primary)').click();
      return 1;
    })()`);
  }
  if (status.done) break;
  await sleep(100);
  switchWaited += 100;
}
const switchResult = await evJson(`(function(){
  var st = import('/js/store.js');
  return st.then(function (mod) {
    var run = window.__epSwitch;
    var d = run.doc;
    var active = mod.activeDoc();
    return JSON.stringify({
      done: run.done, result: run.result, error: run.error,
      sameActive: active === d,
      originalUnchanged: JSON.stringify({ annots: d.annots, textEdits: d.textEdits, stamps: d.stamps,
        meta: d.meta, attachments: d.attachments, newFields: d.newFields,
        dirty: !!d.dirty, history: d.history, hIndex: d.hIndex }) === run.before,
      activeNotes: active ? active.annots.filter(function (a) { return a.type === 'note'; }).length : -1,
    });
  });
})()`);
check('switching documents during planning invalidates the proposal and changes neither document',
  switchResult.done && switchResult.result === null && !switchResult.error
  && !switchCardSeen && !switchResult.sameActive && switchResult.originalUnchanged
  && switchResult.activeNotes === 0,
  JSON.stringify({ cardSeen: switchCardSeen, result: switchResult }));

await openSyntheticBytes(task5Fixture, 'task5-structural-failure.pdf');
const structuralFailurePlan = await beginPlanIn('__epTxnStructuralFailure', 'Reject an unverified structural candidate', [
  { op: 'delete_pages', pages: '3' },
], 'wrong-structure');
const structuralFailureBefore = await evJson(`(function(){
  var d = window.__epTxnStructuralFailure.doc;
  window.__epStructuralFailureBytes = d.bytes;
  return JSON.stringify({ pages: d.numPages, pageOps: JSON.stringify(d.pageOps),
    undo: (d.structUndoStack || []).length, history: d.history.length, hIndex: d.hIndex,
    dirty: !!d.dirty, plans: (d.editPlans || []).length });
})()`);
const structuralFailureRun = structuralFailurePlan.card ? await approvePlanIn('__epTxnStructuralFailure') : null;
const structuralFailureAfter = await evJson(`(function(){
  var d = window.__epTxnStructuralFailure.doc;
  var nodes = document.querySelectorAll('.msg.ai');
  var node = nodes[nodes.length - 1];
  return JSON.stringify({ pages: d.numPages, pageOps: JSON.stringify(d.pageOps),
    undo: (d.structUndoStack || []).length, history: d.history.length, hIndex: d.hIndex,
    dirty: !!d.dirty, plans: (d.editPlans || []).length, sameBytes: d.bytes === window.__epStructuralFailureBytes,
    footer: !!(node && node.querySelector('.plan-foot')) });
})()`);
check('structural verification failure does not reload, commit, push byte undo, or append audit',
  structuralFailurePlan.card && structuralFailureRun && structuralFailureRun.committed === false
  && structuralFailureRun.verdicts[0].ok === false
  && structuralFailureAfter.sameBytes && !structuralFailureAfter.footer
  && ['pages', 'pageOps', 'undo', 'history', 'hIndex', 'dirty', 'plans']
    .every((field) => JSON.stringify(structuralFailureAfter[field]) === JSON.stringify(structuralFailureBefore[field])),
  JSON.stringify({ run: structuralFailureRun && { records: structuralFailureRun.records, verdicts: structuralFailureRun.verdicts },
    before: structuralFailureBefore, after: structuralFailureAfter }));

await openSyntheticBytes(task5Fixture, 'task5-structural-insert-failure.pdf');
const structuralInsertPlan = await beginPlanIn('__epTxnStructuralInsertFailure', 'Reject an unverified blank-page candidate', [
  { op: 'insert_blank_page', after: 1 },
], 'wrong-structure');
const structuralInsertBefore = await transactionState('__epTxnStructuralInsertFailure');
const structuralInsertRun = structuralInsertPlan.card ? await approvePlanIn('__epTxnStructuralInsertFailure') : null;
const structuralInsertAfter = await transactionState('__epTxnStructuralInsertFailure');
const structuralInsertUndo = await ev('(window.__epTxnStructuralInsertFailure.doc.structUndoStack || []).length');
check('blank-page insertion is also staged and verified before any reload or byte-backed commit',
  structuralInsertPlan.card && structuralInsertRun && structuralInsertRun.committed === false
  && structuralInsertRun.verdicts[0].ok === false
  && structuralInsertUndo === 0 && JSON.stringify(structuralInsertAfter) === JSON.stringify(structuralInsertBefore),
  JSON.stringify({ run: structuralInsertRun && { records: structuralInsertRun.records, verdicts: structuralInsertRun.verdicts },
    before: structuralInsertBefore, after: structuralInsertAfter }));

await openSyntheticBytes(task5Fixture, 'task5-structural.pdf');
const structuralBefore = await evJson(`(function(){
  var active = null;
  return import('/js/store.js').then(function (st) {
    active = st.activeDoc();
    return JSON.stringify({ pages: active.numPages, undo: (active.structUndoStack || []).length,
      history: active.history.length, hIndex: active.hIndex, dirty: !!active.dirty });
  });
})()`);
const structuralPlan = await beginPlanIn('__epTxnStructural', 'Delete one page as a single structural plan', [
  { op: 'delete_pages', pages: '3' },
], 'structural-tagged');
const structuralRun = await approvePlanIn('__epTxnStructural');
const structuralState = await evJson(`(async function(){
  var d = window.__epTxnStructural.doc;
  var writer = await import('/js/pdfwrite.js');
  var meta = await writer.readMetadata(d.bytes);
  return JSON.stringify({ pages: d.numPages, undo: (d.structUndoStack || []).length,
    history: d.history.length, hIndex: d.hIndex, dirty: !!d.dirty, title: meta.title });
})()`);
const structuralUndoRedo = await evJson(`(async function(){
  var pages = await import('/js/pages.js');
  var writer = await import('/js/pdfwrite.js');
  var d = window.__epTxnStructural.doc;
  var undone = await pages.undoStructure();
  var pagesAfterUndo = d.numPages;
  var titleAfterUndo = (await writer.readMetadata(d.bytes)).title;
  var redone = await pages.redoStructure();
  var titleAfterRedo = (await writer.readMetadata(d.bytes)).title;
  return JSON.stringify({ undone: undone, pagesAfterUndo: pagesAfterUndo, redone: redone,
    pagesAfterRedo: d.numPages, titleAfterUndo: titleAfterUndo, titleAfterRedo: titleAfterRedo });
})()`);
check('a verified structural plan commits the exact prebuilt bytes with byte-backed undo/redo',
  structuralPlan.card && structuralRun && structuralRun.committed === true
  && structuralRun.records[0].status === 'applied' && structuralRun.verdicts[0].ok === true
  && structuralState.pages === structuralBefore.pages - 1
  && structuralState.undo === structuralBefore.undo + 1
  && structuralState.title === 'Prebuilt structural candidate'
  && structuralUndoRedo.undone && structuralUndoRedo.pagesAfterUndo === structuralBefore.pages
  && structuralUndoRedo.redone && structuralUndoRedo.pagesAfterRedo === structuralBefore.pages - 1
  && structuralUndoRedo.titleAfterRedo === 'Prebuilt structural candidate',
  JSON.stringify({ run: structuralRun && { records: structuralRun.records, verdicts: structuralRun.verdicts },
    state: structuralState, undoRedo: structuralUndoRedo }));

await openSyntheticBytes(writerFixture, 'task5-shared-writer-lock.pdf');
const sharedWriterSetup = await evJson(`(async function(){
  var st = await import('/js/store.js');
  var te = await import('/js/textedit.js');
  var d = st.activeDoc();
  var blocks = await te.editableBlocks(0, d);
  var index = blocks.findIndex(function (block) { return block.text === ${JSON.stringify(TITLE)}; });
  var editor = await te.openDirectEditor(0, index, { askText: false });
  window.__epSharedLegacy = { done: false, error: null };
  if (!editor) return JSON.stringify({ editor: false, waiting: false });
  editor.el.querySelector('.direct-editor-surface').innerText = 'ĀΩЖ legacy commit must not survive the plan lock.';
  te.applyDirectFormat({ fontFamily: 'ZapfDingbats' });
  editor.commit().then(function () { window.__epSharedLegacy.done = true; })
    .catch(function (error) { window.__epSharedLegacy.error = String(error); window.__epSharedLegacy.done = true; });
  var waiting = false;
  for (var i = 0; i < 100; i++) {
    waiting = !!document.querySelector('.modal .modal-foot button:last-child');
    if (waiting || window.__epSharedLegacy.done) break;
    await new Promise(function (resolve) { setTimeout(resolve, 50); });
  }
  return JSON.stringify({ editor: true, waiting: waiting, done: window.__epSharedLegacy.done,
    error: window.__epSharedLegacy.error });
})()`);
const sharedWriterPlan = await beginPlanIn('__epTxnSharedWriter', 'Replace text while a legacy commit is deferred', [
  { op: 'replace_text', page: PAGE, find: 'functional test fixture', replace: 'Plan-owned replacement.' },
], 'gated');
await ev(`(function(){
  var nodes = document.querySelectorAll('.msg.ai');
  var card = nodes[nodes.length - 1].querySelector('.plan-actions');
  if (card) card.querySelector('.primary').click();
  return !!card;
})()`);
let sharedWriterWaited = 0;
while (sharedWriterWaited < 30000 && !(await ev('!!window.__epTxnSharedWriter.stagingStarted'))) { await sleep(100); sharedWriterWaited += 100; }
await ev(`(function(){
  var proceed = document.querySelector('.modal .modal-foot button:last-child');
  if (proceed && typeof proceed.onclick === 'function') proceed.onclick();
  return !!proceed;
})()`);
let sharedLegacyWaited = 0;
while (sharedLegacyWaited < 30000 && !(await ev('!!window.__epSharedLegacy.done'))) { await sleep(50); sharedLegacyWaited += 50; }
const sharedWriterDuring = await evJson(`(function(){
  var run = window.__epTxnSharedWriter;
  return JSON.stringify({ stagingStarted: !!run.stagingStarted, legacyDone: !!window.__epSharedLegacy.done,
    legacyError: window.__epSharedLegacy.error, texts: run.doc.textEdits.map(function (edit) { return edit.text; }),
    history: run.doc.history.length, expectedHistory: run.historyBefore,
    dirty: !!run.doc.dirty, expectedDirty: !!run.dirtyBefore, plans: (run.doc.editPlans || []).length });
})()`);
await ev('(function(){ if (window.__epTxnSharedWriter.releaseBuild) window.__epTxnSharedWriter.releaseBuild(); return 1; })()');
let sharedWriterDone = 0;
while (sharedWriterDone < 120000 && !(await ev('!!window.__epTxnSharedWriter.done'))) { await sleep(100); sharedWriterDone += 100; }
const sharedWriterFinal = await evJson(`(function(){
  var run = window.__epTxnSharedWriter;
  return JSON.stringify({ result: run.result, error: run.error,
    texts: run.doc.textEdits.map(function (edit) { return edit.text; }),
    history: run.doc.history.length, expectedHistory: run.historyBefore + 1,
    plans: (run.doc.editPlans || []).length });
})()`);
check('a deferred legacy writer aborts at the plan lock boundary without mutating or losing the staged plan',
  sharedWriterSetup.editor && sharedWriterSetup.waiting && sharedWriterPlan.card
  && sharedWriterDuring.stagingStarted && sharedWriterDuring.legacyDone && !sharedWriterDuring.legacyError
  && sharedWriterDuring.history === sharedWriterDuring.expectedHistory
  && sharedWriterDuring.dirty === sharedWriterDuring.expectedDirty
  && sharedWriterDuring.texts.length === 1
  && !sharedWriterDuring.texts.some((text) => /legacy commit/i.test(text))
  && sharedWriterFinal.result && sharedWriterFinal.result.committed === true && sharedWriterFinal.result.verified === true
  && sharedWriterFinal.result.verdicts.every((verdict) => verdict.ok === true)
  && JSON.stringify(sharedWriterFinal.texts) === JSON.stringify(['Plan-owned replacement.'])
  && sharedWriterFinal.history === sharedWriterFinal.expectedHistory && sharedWriterFinal.plans === 1,
  JSON.stringify({ setup: sharedWriterSetup, during: sharedWriterDuring, final: sharedWriterFinal }));

await send('Page.captureScreenshot', { format: 'png' }).then((shot) => {
  fs.mkdirSync(path.join(ROOT, '.scratch'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.scratch', 'editplan.png'), Buffer.from(shot.data, 'base64'));
}).catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
child.kill();
await sleep(300);
process.exit(failed.length ? 1 : 0);
