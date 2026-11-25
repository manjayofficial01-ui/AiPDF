import { diffPages } from './compare.js';
import { el } from './util.js';
import { showModal } from './dialog.js';

function mergeCellRuns(cells, cellSize, width, height) {
  const regions = [];
  let active = new Map();
  for (let row = 0; row < cells.length; row++) {
    const next = new Map();
    let col = 0;
    while (col < cells[row].length) {
      if (!cells[row][col]) { col++; continue; }
      const start = col;
      while (col < cells[row].length && cells[row][col]) col++;
      const runWidth = col - start;
      const key = `${start}:${runWidth}`;
      const y = row * cellSize;
      const previous = active.get(key);
      const region = previous && previous.y + previous.h === y
        ? { ...previous, h: previous.h + cellSize }
        : { x: start * cellSize, y, w: runWidth * cellSize, h: cellSize };
      region.w = Math.min(region.w, width - region.x);
      region.h = Math.min(region.h, height - region.y);
      next.set(key, region);
    }
    for (const [key, region] of active) if (!next.has(key)) regions.push(region);
    active = next;
  }
  for (const region of active.values()) regions.push(region);
  return regions;
}

export function diffImageData(before, after, { tolerance = 24, cellSize = 24, minChangedPixels = 2 } = {}) {
  if (!before || !after || !Number.isInteger(before.width) || !Number.isInteger(after.width)
    || !Number.isInteger(before.height) || !Number.isInteger(after.height)) {
    throw new Error('Both page images must have integer dimensions.');
  }
  if (before.width !== after.width || before.height !== after.height) {
    return {
      changed: true,
      dimensionMismatch: true,
      changedPixels: 0,
      ratio: 1,
      bounds: { x: 0, y: 0, w: Math.max(before.width, after.width), h: Math.max(before.height, after.height) },
      regions: [{ x: 0, y: 0, w: Math.max(before.width, after.width), h: Math.max(before.height, after.height) }],
    };
  }
  const { width, height } = before;
  const a = before.data;
  const b = after.data;
  if (!a || !b || a.length !== b.length) throw new Error('Page image buffers must match their dimensions.');
  const cells = Array.from({ length: Math.ceil(height / cellSize) }, () => Array(Math.ceil(width / cellSize)).fill(0));
  let changedPixels = 0;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = Math.floor(y / cellSize);
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const different = Math.abs(a[offset] - b[offset]) > tolerance
        || Math.abs(a[offset + 1] - b[offset + 1]) > tolerance
        || Math.abs(a[offset + 2] - b[offset + 2]) > tolerance
        || Math.abs(a[offset + 3] - b[offset + 3]) > tolerance;
      if (!different) continue;
      changedPixels++;
      cells[row][Math.floor(x / cellSize)]++;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const marked = cells.map((row) => row.map((count) => count >= minChangedPixels));
  const regions = mergeCellRuns(marked, cellSize, width, height);
  return {
    changed: changedPixels > 0,
    dimensionMismatch: false,
    changedPixels,
    ratio: changedPixels / (width * height),
    bounds: changedPixels ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null,
    regions,
  };
}

function intersects(a, b, margin = 0) {
  return a.x + a.w + margin >= b.x && b.x + b.w + margin >= a.x
    && a.y + a.h + margin >= b.y && b.y + b.h + margin >= a.y;
}

export function classifyPageChanges(page, allowedRegions = [], { margin = 2 } = {}) {
  const regions = Array.isArray(page?.regions) ? page.regions : [];
  const allowed = Array.isArray(allowedRegions) ? allowedRegions : [];
  const unexplainedRegions = regions.filter((region) => !allowed.some((rect) => intersects(region, rect, margin)));
  return { expected: unexplainedRegions.length === 0, unexplainedRegions };
}

export function pdfRectToPixels(rect, viewport) {
  if (!Array.isArray(rect) || rect.length !== 4 || !viewport) return null;
  const [x0, y0, x1, y1] = rect.map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  const width = Number(viewport.width) || 0;
  const height = Number(viewport.height) || 0;
  const scale = Number(viewport.scale) || 1;
  const rotation = ((Number(viewport.rotation) || 0) % 360 + 360) % 360;
  const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
    if (rotation === 90) return [y, width - x];
    if (rotation === 180) return [width - x, height - y];
    if (rotation === 270) return [height - y, x];
    return [x, height - y];
  });
  const xs = corners.map((point) => point[0] * scale);
  const ys = corners.map((point) => point[1] * scale);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, w: Math.max(...xs) - left, h: Math.max(...ys) - top };
}

function rectsForEdit(edit, viewport) {
  const rects = [];
  for (const rect of [edit?.coverRect, edit?.rect]) {
    const converted = pdfRectToPixels(rect, viewport);
    if (converted) rects.push(converted);
  }
  for (const frame of edit?.frames || []) {
    const converted = pdfRectToPixels(frame.rect, viewport);
    if (converted) rects.push(converted);
  }
  return rects;
}

export function allowedRegionsForPage(doc, pageIndex, viewport) {
  if (!doc || !viewport) return [];
  if (doc.pageOps || Object.hasOwn(doc.pageRotate || {}, pageIndex)) {
    return [{ x: 0, y: 0, w: viewport.width, h: viewport.height }];
  }
  const regions = [];
  for (const edit of doc.textEdits || []) if (edit.page === pageIndex) regions.push(...rectsForEdit(edit, viewport));
  for (const annot of doc.annots || []) {
    if (annot.page !== pageIndex) continue;
    const converted = pdfRectToPixels(annot.rect, viewport);
    if (converted) regions.push(converted);
  }
  const stamped = (doc.stamps || []).some((stamp) => {
    const from = Number(stamp.from ?? 1);
    const to = Number(stamp.to ?? from);
    return pageIndex + 1 >= from && pageIndex + 1 <= to;
  });
  if (stamped) return [{ x: 0, y: 0, w: viewport.width, h: viewport.height }];
  return regions;
}

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('/v/pdf.min.mjs').then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = '/v/pdf.worker.min.mjs';
      return lib;
    });
  }
  return pdfjsPromise;
}

async function renderPageImage(page, scale, optionalContentConfigPromise) {
  const viewport = page.getViewport({ scale, rotation: page.rotate || 0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, optionalContentConfigPromise }).promise;
  return { canvas, viewport: { width: viewport.width, height: viewport.height, scale, rotation: viewport.rotation }, image: ctx.getImageData(0, 0, canvas.width, canvas.height) };
}

async function pageText(page) {
  if (!page) return '';
  const content = await page.getTextContent();
  return content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
}

export async function buildVisualComparison(beforeBytes, afterBytes, { doc = null, scale = 1, onProgress = null } = {}) {
  if (!beforeBytes?.length || !afterBytes?.length) throw new Error('Both original and candidate PDF bytes are required.');
  const pdfjs = await getPdfjs();
  const beforePdf = await pdfjs.getDocument({ data: beforeBytes.slice(0), useSystemFonts: false }).promise;
  let afterPdf = null;
  try {
    afterPdf = await pdfjs.getDocument({ data: afterBytes.slice(0), useSystemFonts: false }).promise;
    const pageCount = Math.max(beforePdf.numPages, afterPdf.numPages);
    const pages = [];
    let changed = 0, unexplained = 0, visualChanged = 0, textChanged = 0;
    for (let index = 0; index < pageCount; index++) {
      const beforePage = index < beforePdf.numPages ? await beforePdf.getPage(index + 1) : null;
      const afterPage = index < afterPdf.numPages ? await afterPdf.getPage(index + 1) : null;
      const beforeText = await pageText(beforePage);
      const afterText = await pageText(afterPage);
      const textDiff = diffPages(beforeText, afterText);
      let visual = { changed: !!beforePage !== !!afterPage, dimensionMismatch: !!beforePage !== !!afterPage,
        changedPixels: 0, ratio: 0, bounds: null, regions: [] };
      let beforeRender = null, afterRender = null, allowed = [];
      if (beforePage && afterPage) {
        beforeRender = await renderPageImage(beforePage, scale, doc?.ocgConfigPromise);
        afterRender = await renderPageImage(afterPage, scale, doc?.ocgConfigPromise);
        visual = diffImageData(beforeRender.image, afterRender.image);
        allowed = allowedRegionsForPage(doc, index, afterRender.viewport);
      } else {
        const render = await renderPageImage(beforePage || afterPage, scale, doc?.ocgConfigPromise);
        beforeRender = beforePage ? render : null;
        afterRender = afterPage ? render : null;
        const fullPage = { x: 0, y: 0, w: render.viewport.width, h: render.viewport.height };
        visual = { changed: true, dimensionMismatch: true, changedPixels: 0, ratio: 1,
          bounds: fullPage, regions: [fullPage] };
        allowed = doc?.pageOps ? [fullPage] : [];
      }
      const classification = classifyPageChanges({ regions: visual.regions }, allowed);
      const pageChanged = textDiff.changed || visual.changed;
      const pageExpected = !visual.changed || classification.expected;
      if (pageChanged) changed++;
      if (textDiff.changed) textChanged++;
      if (visual.changed) visualChanged++;
      unexplained += classification.unexplainedRegions.length;
      pages.push({
        index, changed: pageChanged, expected: pageExpected,
        textChanged: textDiff.changed, removed: textDiff.removed, added: textDiff.added,
        visual, regions: visual.regions, unexplainedRegions: classification.unexplainedRegions, allowedRegions: allowed,
        beforeCanvas: visual.changed ? beforeRender?.canvas : null,
        afterCanvas: visual.changed ? afterRender?.canvas : null,
      });
      onProgress?.({ page: index + 1, pageCount, changed });
    }
    return {
      pages,
      summary: { pages: pageCount, changed, unexplained, visualChanged, textChanged,
        identical: pageCount - changed, beforePages: beforePdf.numPages, afterPages: afterPdf.numPages },
    };
  } finally {
    try { await afterPdf?.destroy(); } catch { /* ignore */ }
    try { await beforePdf.destroy(); } catch { /* ignore */ }
  }
}

function cloneCanvas(source) {
  if (!source) return null;
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  canvas.getContext('2d').drawImage(source, 0, 0);
  return canvas;
}

function overlayCanvas(source, regions) {
  if (!source) return null;
  const canvas = cloneCanvas(source);
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#dc2626';
  ctx.lineWidth = 2;
  for (const region of regions || []) {
    ctx.strokeRect(region.x + 1, region.y + 1, Math.max(0, region.w - 2), Math.max(0, region.h - 2));
  }
  return canvas;
}

export async function showTrustPreview(comparison, { docName = 'Document' } = {}) {
  const changedPages = (comparison?.pages || []).filter((page) => page.changed);
  const summary = comparison?.summary || {};
  return showModal({
    title: 'Trust Preview — review saved changes',
    width: 980,
    body: (body) => {
      const head = el('div', { class: 'trust-preview-head' }, [
        el('div', { class: 'trust-preview-title', text: `${docName}: ${summary.changed || 0} changed page(s)` }),
        el('div', { class: 'trust-preview-sub', text: `${summary.textChanged || 0} text change(s) · ${summary.visualChanged || 0} visual change(s) · ${summary.unexplained || 0} unexplained region(s)` }),
      ]);
      body.appendChild(head);
      if (summary.unexplained) {
        body.appendChild(el('div', { class: 'trust-preview-warning', text: 'Some visual changes are outside the expected edit regions. Cancel and review the document, or explicitly choose Save anyway.' }));
      }
      for (const page of changedPages) {
        const card = el('div', { class: 'trust-preview-page' });
        card.appendChild(el('div', { class: 'trust-preview-page-head', text: `Page ${page.index + 1}${page.expected ? '' : ' — unexplained changes'}` }));
        if (page.removed?.length || page.added?.length) {
          const text = el('pre', { class: 'trust-preview-text' });
          text.textContent = [
            ...page.removed.map((line) => `- ${line}`),
            ...page.added.map((line) => `+ ${line}`),
          ].join('\n');
          card.appendChild(text);
        }
        if (page.beforeCanvas || page.afterCanvas) {
          const row = el('div', { class: 'trust-preview-images' });
          for (const [label, canvas] of [
            ['Before', cloneCanvas(page.beforeCanvas)],
            ['After', cloneCanvas(page.afterCanvas)],
            ['Changed regions', overlayCanvas(page.afterCanvas, page.visual?.regions)],
          ]) {
            if (!canvas) continue;
            const pane = el('div', { class: 'trust-preview-pane' }, [el('div', { class: 'trust-preview-label', text: label }), canvas]);
            row.appendChild(pane);
          }
          card.appendChild(row);
        }
        body.appendChild(card);
      }
    },
    buttons: [
      { label: 'Cancel save', value: 'cancel', kind: 'ghost' },
      { label: summary.unexplained ? 'Save anyway' : 'Continue to save', value: 'keep', kind: summary.unexplained ? 'danger' : 'primary', default: !summary.unexplained },
    ],
  }).then((choice) => choice === 'keep');
}
