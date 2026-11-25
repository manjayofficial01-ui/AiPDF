#!/usr/bin/env node
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeRecipe, runBatch } from '../src/renderer/js/batch-core.js';

test('batch recipes keep only known pipeline steps and normalize parameters', () => {
  const recipe = normalizeRecipe({ name: 'Client intake', steps: [
    { id: 'addPageNumbers', params: { formatId: 'n-of-N' } },
    { id: 'unknown', params: {} },
    null,
  ] });
  assert.equal(recipe.name, 'Client intake');
  assert.deepEqual(recipe.steps, [{ id: 'addPageNumbers', params: { formatId: 'n-of-N' } }]);
  assert.equal(normalizeRecipe(null).steps.length > 0, true);
});

test('batch runner bounds concurrency and isolates per-file failures', async () => {
  let active = 0;
  let maxActive = 0;
  const updates = [];
  const items = ['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf'].map((name, index) => ({ id: String(index), name }));
  const result = await runBatch(items, { steps: [] }, {
    concurrency: 2,
    worker: async (item) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      if (item.name === 'b.pdf') throw new Error('bad file');
      return { ok: true, summary: `${item.name} done` };
    },
    onUpdate: (state) => updates.push(state),
  });
  assert.equal(maxActive, 2);
  assert.equal(result.results.length, 4);
  assert.equal(result.results.find((entry) => entry.name === 'b.pdf').status, 'failed');
  assert.equal(result.results.filter((entry) => entry.status === 'done').length, 3);
  assert.equal(result.done, true);
  assert.ok(updates.length >= 4);
});

test('batch runner pauses without losing pending work and resumes', async () => {
  let paused = true;
  let started = 0;
  const items = [{ id: '1', name: 'one.pdf' }, { id: '2', name: 'two.pdf' }];
  const pending = runBatch(items, { steps: [] }, {
    concurrency: 1,
    shouldPause: async () => paused,
    worker: async (item) => { started++; return { ok: true, summary: item.name }; },
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(started, 0);
  paused = false;
  const result = await pending;
  assert.equal(started, 2);
  assert.equal(result.done, true);
});
