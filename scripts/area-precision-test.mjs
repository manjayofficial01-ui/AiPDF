#!/usr/bin/env node
/**
 * Area Direct Edit — glyph-precise marquee, pure-geometry regression suite.
 *
 *   node scripts/area-precision-test.mjs
 *
 * The precision bug: pdf.js hands the app ONE TextItem per drawn run, and for
 * most producers that run is a whole line. Filtering items by "centre inside
 * the marquee" therefore made the ENTIRE line editable — including the words
 * to the left and right of the box ("nearest text in line with the area").
 *
 * The contract locked here:
 *   - a straddling run is cut down to the characters wholly inside the box;
 *   - no character, hit target or source rect can reach outside the marquee;
 *   - a run that fits wholly inside is kept VERBATIM (truthful excision stays
 *     available for those edits);
 *   - neighbouring lines never join the selection;
 *   - OCR lines are trimmed word-by-word, not taken whole.
 *
 * Runs offline against real pdf.js text content from a checked-in fixture.
 * No Electron, no mocks — `opts.measure` just makes char widths deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clipTextContentToRegion, groupTextBlocks, textItemBoxes, editForBlock,
  rectCentreInside, rectFullyInside, rectClip,
  flatOcrLinesInRegion, blocksFromFlatOcrLines,
} from '../src/renderer/js/textblocks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, '.fixtures', 'real-chrome.pdf');

let problems = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems++;
};
const measure = (ch) => (/\s/u.test(ch) ? 0.5 : 1);

/** The ink box clipTextContentToRegion uses for a horizontal run. */
function inkBox(item, styles) {
  const t = item.transform;
  const size = Math.hypot(t[2], t[3]);
  const st = styles?.[item.fontName] || {};
  const asc = Number.isFinite(st.ascent) ? st.ascent : 0.9;
  const desc = Number.isFinite(st.descent) ? st.descent : -0.21;
  return [t[4], t[5] + desc * size * 0.8, t[4] + item.width, t[5] + asc * size * 0.82];
}

if (!fs.existsSync(FIXTURE)) {
  console.log('AREA_PRECISION_FAIL missing fixture ' + FIXTURE);
  process.exit(1);
}
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(FIXTURE)), useSystemFonts: true }).promise;
const tc = await (await doc.getPage(1)).getTextContent();

/* ── 0. The fixture really does put a whole line in ONE item ─────────────── */
const lineIndex = tc.items.findIndex((it) => String(it.str || '').split(' ').length > 12);
const line = tc.items[lineIndex];
check('the fixture has a whole line in one pdf.js TextItem', lineIndex >= 0 && line.width > 300,
  line ? `index=${lineIndex} words=${line.str.split(' ').length} width=${Math.round(line.width)}pt` : 'none');
const words = String(line.str).split(/\s+/u).filter(Boolean);
const firstWord = words[0], lastWord = words[words.length - 1];
const y = line.transform[5], size = Math.hypot(line.transform[2], line.transform[3]);

/* ── 1. The old behaviour really did select the whole line ──────────────── */
const MIDDLE = [line.transform[4] + line.width * 0.40, y - 8,
  line.transform[4] + line.width * 0.60, y + 11];
const oldPick = textItemBoxes(tc).filter((b) => rectCentreInside(b.rect, MIDDLE));
const oldText = oldPick.map((b) => tc.items[b.index]?.str || '').join(' ');
check('REGRESSION: the old centre-inside filter would offer the WHOLE line',
  oldText.includes(firstWord) && oldText.includes(lastWord),
  `picked ${oldPick.length} item(s), text starts "${String(oldText).slice(0, 34)}…"`);

/* ── 2. The new clip keeps only what is inside the box ──────────────────── */
const clip = clipTextContentToRegion(tc, MIDDLE, { measure });
const blocks = groupTextBlocks(clip.tc, 595).filter((b) => String(b.text || '').trim());
const areaText = blocks.map((b) => b.text).join('\n');
console.log('MIDDLE', JSON.stringify(MIDDLE.map((v) => Math.round(v))), '=>', JSON.stringify(areaText));
check('a partial marquee still finds text', blocks.length >= 1, `blocks=${blocks.length}`);
check('the words to the LEFT of the box are not editable', !areaText.includes(firstWord), firstWord);
check('the words to the RIGHT of the box are not editable', !areaText.includes(lastWord), lastWord);
check('every editable word is a word from the source line',
  areaText.split(/\s+/u).filter(Boolean).every((w) => words.some((src) => src.includes(w) || w.includes(src))),
  JSON.stringify(areaText));
check('the straddling item was cut into a fragment (not kept whole)',
  clip.partial.some(Boolean) && clip.tc.items.some((it) => it.__sourceIndex === lineIndex),
  `partial=${clip.partial.filter(Boolean).length}`);

const escaped = clip.tc.items.filter((it) => !rectFullyInside(inkBox(it, tc.styles), MIDDLE, 1.5));
check('no clipped glyph box reaches outside the marquee', escaped.length === 0,
  escaped.length ? JSON.stringify(escaped.map((it) => inkBox(it, tc.styles).map(Math.round))) : '');
const outsideWords = ['This', 'paragraph', 'enough', 'to'];
check('no word from outside the box appears in the editable text',
  !outsideWords.some((w) => new RegExp(`\\b${w}\\b`, 'iu').test(areaText)), JSON.stringify(areaText));

/* ── 3. Neighbouring lines are excluded ────────────────────────────────── */
const sameLine = clip.tc.items.every((it) => (it.__sourceIndex ?? clip.originMap[clip.tc.items.indexOf(it)]) === lineIndex);
check('only the line under the marquee contributes items', sameLine,
  `origins=${[...new Set(clip.originMap)].join(',')}`);

/* ── 4. A run that fits WHOLE is kept verbatim (truthful excision) ─────── */
const WHOLE = [line.transform[4] - 2, y - 6, line.transform[4] + line.width + 2, y + 13];
const whole = clipTextContentToRegion(tc, WHOLE, { measure });
const wholeItem = whole.tc.items.find((it) => it.str === line.str);
check('a fully-inside run is kept verbatim, not fragmented', !!wholeItem && whole.partial.every((p) => !p),
  `items=${whole.tc.items.length} partial=${whole.partial.filter(Boolean).length}`);
const wholeBlocks = groupTextBlocks(whole.tc, 595).filter((b) => b.text.trim());
check('a whole-line marquee still offers the whole line',
  wholeBlocks.some((b) => b.text.includes(firstWord) && b.text.includes(lastWord)),
  JSON.stringify(wholeBlocks.map((b) => b.text.slice(0, 40))));

/* ── 5. Multi-line band: straddling lines clipped, inside lines verbatim ── */
const BAND = [line.transform[4] - 2, y - 34, line.transform[4] + line.width * 0.6, y + 13];
const band = clipTextContentToRegion(tc, BAND, { measure });
const bandText = groupTextBlocks(band.tc, 595).filter((b) => b.text.trim()).map((b) => b.text).join('\n');
const bandLines = bandText.split('\n').map((s) => s.trim()).filter(Boolean);
const bandOrigins = [...new Set(band.originMap)];
const lower = tc.items[lineIndex + 1];
check('a multi-line band clips each line separately', bandOrigins.length >= 2,
  `origins=${bandOrigins.join(',')}`);
check('every clipped item in the band is inside the band',
  band.tc.items.every((it) => rectFullyInside(inkBox(it, tc.styles), BAND, 1.5)),
  `items=${band.tc.items.length}`);

/* A straddling line must appear as a STRICT PREFIX of the source line, not as
 * the whole run. (`str.includes(lastWord)` is NOT a usable assertion here:
 * this fixture ends line 1 with "to", which also occurs legitimately inside
 * the box as "exists to" — that false positive is what this rewrite fixes.) */
const upperFrag = bandLines.find((s) => String(line.str).startsWith(s));
const lowerFrag = bandLines.find((s) => String(lower.str).startsWith(s));
check('the upper straddling line is cut short, not offered whole',
  !!upperFrag && upperFrag.length > 8 && upperFrag !== line.str.trim(),
  JSON.stringify((upperFrag || '').slice(0, 60)));
check('the lower straddling line is cut short, not offered whole',
  !!lowerFrag && lowerFrag.length > 2 && lowerFrag !== lower.str.trim(),
  JSON.stringify((lowerFrag || '').slice(0, 60)));

/* Words lying beyond the box on either straddling line must not leak in.
 * Compare tails against the UNION of the surviving heads so a word that is
 * legitimately inside the box on another line (e.g. "paragraph") is not
 * mistaken for a leak. */
const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const heads = new Set(bandLines.flatMap((s) => s.split(/\s+/u).map(norm)).filter(Boolean));
const tails = [line.str, lower.str].flatMap((src, k) => {
  const frag = k === 0 ? upperFrag : lowerFrag;
  return String(src).slice((frag || '').length).split(/\s+/u).map(norm)
    .filter((w) => w.length >= 3 && !heads.has(w));
});
const leaked = tails.filter((w) => bandLines.some((s) => s.split(/\s+/u).map(norm).includes(w)));
check('no word beyond the right edge of either straddling line leaks in',
  leaked.length === 0,
  leaked.length ? `leaked=${JSON.stringify(leaked)} tails=${JSON.stringify(tails)}` : `tails=${tails.length}`);

/* A line the box FULLY covers is still kept verbatim — precision must not
 * cost us truthful excision on the ordinary, fully-selected case. */
const insideLine = tc.items[lineIndex + 2];
check('a line wholly inside the band is kept verbatim',
  band.tc.items.some((it, i) => it.str === insideLine.str && !band.partial[i]),
  JSON.stringify(String(insideLine.str).slice(0, 45)));

/* ── 6. RTL / rotated straddlers are never split by visual order ────────── */
const rtlTc = {
  styles: { f: { fontFamily: 'serif', ascent: 0.9, descent: -0.21 } },
  items: [
    { str: 'abcdef ghijkl', dir: 'rtl', width: 120, height: 10, fontName: 'f', hasEOL: false,
      transform: [10, 0, 0, 10, 50, 700] },
  ],
};
const rtlClip = clipTextContentToRegion(rtlTc, [70, 694, 110, 709], { measure });
check('a straddling RTL run is dropped rather than split', rtlClip.tc.items.length === 0,
  `items=${rtlClip.tc.items.length}`);
const rtlWhole = clipTextContentToRegion(rtlTc, [45, 692, 175, 712], { measure });
check('a fully-inside RTL run is kept', rtlWhole.tc.items.length === 1 && !rtlWhole.partial[0]);

/* ── 7. Helpers ────────────────────────────────────────────────────────── */
check('rectFullyInside rejects a straddler', !rectFullyInside([0, 0, 20, 10], [5, 0, 15, 10]));
check('rectFullyInside accepts a contained box', rectFullyInside([6, 1, 14, 9], [5, 0, 15, 10]));
check('rectClip stops at the bounds', JSON.stringify(rectClip([0, 0, 20, 10], [5, 2, 15, 8])) === '[5,2,15,8]');
check('rectClip returns null for no overlap', rectClip([0, 0, 4, 4], [5, 5, 9, 9]) === null);

/* ── 8. OCR: word-level trim, never a whole row ────────────────────────── */
const ocrLines = [{
  text: 'ALPHA BRAVO CHARLIE DELTA ECHO',
  bbox: { x0: 100, y0: 200, x1: 700, y1: 225 },
  confidence: 90,
  words: ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA', 'ECHO'].map((w, k) => ({
    text: w, bbox: { x0: 100 + k * 120, y0: 200, x1: 100 + k * 120 + 100, y1: 225 },
  })),
}];
// 200 dpi → 0.36pt/px: page height 842, so the line sits near y=770.
const pageH = 842, dpi = 200;
const flatAll = flatOcrLinesInRegion(ocrLines, pageH, dpi, [0, 0, 10000, 10000]);
const BOX = [flatAll[0].x + 0.36 * 120 - 1, flatAll[0].bottom - 2,
  flatAll[0].x + 0.36 * 360 - 1, flatAll[0].top + 2];
const ocrFlat = flatOcrLinesInRegion(ocrLines, pageH, dpi, BOX);
const ocrText = ocrFlat.map((l) => l.text).join('\n');
console.log('OCR_BOX', JSON.stringify(BOX.map((v) => Math.round(v * 10) / 10)), '=>', JSON.stringify(ocrText));
check('OCR keeps only words wholly inside the marquee', ocrFlat.length === 1
  && !/ALPHA|DELTA|ECHO/u.test(ocrText), JSON.stringify(ocrText));
check('OCR keeps the words that are inside', /BRAVO/u.test(ocrText) && /CHARLIE/u.test(ocrText), JSON.stringify(ocrText));
check('OCR line geometry stops at the box', ocrFlat.every((l) => l.x >= BOX[0] - 0.01 && l.end <= BOX[2] + 0.01
  && l.top <= BOX[3] + 0.01 && l.bottom >= BOX[1] - 0.01),
  JSON.stringify(ocrFlat.map((l) => [l.x, l.bottom, l.end, l.top].map((v) => Math.round(v * 10) / 10))));
const ocrBlocks = blocksFromFlatOcrLines(ocrFlat, 595, 0).filter((b) => b.text.trim());
check('OCR editable blocks carry only the inside words', ocrBlocks.length === 1
  && !/ALPHA|DELTA|ECHO/u.test(ocrBlocks[0].text), JSON.stringify(ocrBlocks.map((b) => b.text)));

/* ── 9. Edit identity: an area edit is NOT a whole-page edit ─────────────
 * Both can point at the SAME original text operator (a partial area clip keeps
 * the original index for source ownership). Without a region-scoped identity,
 * re-selecting an area resolves back to a whole-page edit and washes the
 * entire line, or two different areas collapse into the first one's edit. */
const AREA_A = [100, 700, 200, 720], AREA_B = [300, 700, 400, 720];
const areaBlockA = { key: 'r:0:100.0_700.0_200.0_720.0:0', itemIndices: [2], regionRect: AREA_A };
const areaBlockB = { key: 'r:0:300.0_700.0_400.0_720.0:0', itemIndices: [2], regionRect: AREA_B };
const pageBlock = { key: 'n:0:2', itemIndices: [2] };
const edits = [
  { id: 'whole', page: 0, key: 'n:0:2', itemIndices: [2], text: 'whole line' },
  { id: 'areaA', page: 0, key: areaBlockA.key, itemIndices: [2], regionRect: AREA_A, text: 'area A' },
];
const fakeDoc = { textEdits: edits };
check('a whole-page edit is not reused for an area block',
  editForBlock(fakeDoc, 0, areaBlockA)?.id === 'areaA');
check('an area edit is not reused for a whole-page block',
  editForBlock(fakeDoc, 0, pageBlock)?.id === 'whole');
check('a second area cannot inherit the first area edit by item index',
  editForBlock(fakeDoc, 0, areaBlockB) === undefined);
check('re-selecting the same area still finds its edit',
  editForBlock(fakeDoc, 0, { ...areaBlockA })?.id === 'areaA');
check('another page never matches', editForBlock(fakeDoc, 1, areaBlockA) === undefined);

await doc.destroy();
console.log(problems ? `AREA_PRECISION_FAIL ${problems} problem(s)` : 'AREA_PRECISION_PASS all checks green');
process.exit(problems ? 1 : 0);
