#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectVisualPages, buildVisualPlanContext } from '../src/renderer/js/visual-context.js';

function fakeDoc() {
  const texts = ['Quarterly Report title', '', 'Financial details and totals', 'Appendix'];
  return {
    numPages: texts.length,
    pdf: {
      async getPage(pageNumber) {
        const text = texts[pageNumber - 1];
        return { getTextContent: async () => ({ items: text ? [{ str: text }] : [] }) };
      },
    },
  };
}

test('visual page selection uses explicit page references and goal-term matches', async () => {
  assert.deepEqual(await selectVisualPages(fakeDoc(), 'make the title blue', { maxPages: 2 }), [0]);
  assert.deepEqual(await selectVisualPages(fakeDoc(), 'change page 3 heading', { maxPages: 2 }), [2]);
  assert.deepEqual(await selectVisualPages(fakeDoc(), 'financial totals', { maxPages: 1 }), [2]);
});

test('visual context sends page images and recognizes only pages without native text', async () => {
  const rendered = [];
  const recognized = [];
  const result = await buildVisualPlanContext(fakeDoc(), 'make the title blue', {
    pages: [0, 1],
    renderPage: async (page) => { rendered.push(page); return `data:image/png;base64,page${page}`; },
    recognize: async (page, dataUrl) => { recognized.push({ page, dataUrl }); return 'Scanned invoice title'; },
  });
  assert.deepEqual(rendered, [0, 1]);
  assert.deepEqual(recognized, [{ page: 1, dataUrl: 'data:image/png;base64,page1' }]);
  assert.equal(result.images.length, 2);
  assert.match(result.text, /Scanned invoice title/);
  assert.match(result.text, /Quarterly Report title/);
});

test('visual context ignores invalid page indexes', async () => {
  const result = await buildVisualPlanContext(fakeDoc(), 'title', {
    pages: [-1, 99],
    renderPage: async () => { throw new Error('must not render'); },
    recognize: async () => { throw new Error('must not recognize'); },
  });
  assert.equal(result.images.length, 0);
});
