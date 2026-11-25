#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  diffImageData,
  classifyPageChanges,
  pdfRectToPixels,
} from '../src/renderer/js/visualdiff.js';

function image(width = 100, height = 80) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 255;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function paint(img, x, y, w, h, color) {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const offset = (py * img.width + px) * 4;
      img.data[offset] = color[0];
      img.data[offset + 1] = color[1];
      img.data[offset + 2] = color[2];
      img.data[offset + 3] = 255;
    }
  }
}

test('identical page images produce no visual diff', () => {
  const result = diffImageData(image(), image());
  assert.equal(result.changed, false);
  assert.equal(result.changedPixels, 0);
  assert.deepEqual(result.regions, []);
});

test('a localized visual change produces bounded regions and pixels', () => {
  const before = image();
  const after = image();
  paint(after, 30, 20, 12, 10, [255, 0, 0]);
  const result = diffImageData(before, after);
  assert.equal(result.changed, true);
  assert.equal(result.changedPixels, 120);
  assert.ok(result.bounds.x <= 30 && result.bounds.y <= 20);
  assert.ok(result.bounds.x + result.bounds.w >= 42 && result.bounds.y + result.bounds.h >= 30);
  assert.ok(result.regions.length > 0);
});

test('small antialiasing-level color changes are ignored by tolerance', () => {
  const before = image();
  const after = image();
  paint(after, 10, 10, 5, 5, [250, 250, 250]);
  assert.equal(diffImageData(before, after, { tolerance: 12 }).changed, false);
});

test('dimension changes fail closed as a full-page visual change', () => {
  const result = diffImageData(image(100, 80), image(120, 80));
  assert.equal(result.changed, true);
  assert.equal(result.dimensionMismatch, true);
  assert.deepEqual(result.regions, [{ x: 0, y: 0, w: 120, h: 80 }]);
});

test('page changes inside approved regions are expected and outside regions are not', () => {
  const page = { regions: [
    { x: 10, y: 10, w: 20, h: 20 },
    { x: 70, y: 55, w: 15, h: 10 },
  ] };
  const allowed = [{ x: 5, y: 5, w: 30, h: 30 }];
  const result = classifyPageChanges(page, allowed);
  assert.equal(result.expected, false);
  assert.deepEqual(result.unexplainedRegions, [{ x: 70, y: 55, w: 15, h: 10 }]);
  assert.equal(classifyPageChanges(page, [...allowed, { x: 65, y: 50, w: 25, h: 20 }]).expected, true);
});

test('PDF rectangles convert to top-left canvas pixels with page rotation metadata', () => {
  const rect = pdfRectToPixels([10, 20, 30, 40], { width: 100, height: 80, scale: 2, rotation: 0 });
  assert.deepEqual(rect, { x: 20, y: 80, w: 40, h: 40 });
});
