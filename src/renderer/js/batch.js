import { el, toast } from './util.js';
import { showModal } from './dialog.js';
import { loadPdfBytes } from './viewer.js';
import { newDocShell } from './store.js';
import { buildPdf } from './pdfwrite.js';
import { runPipelineModel, planCompress, pipelineStamps } from './stirling.js';
import { rasterizePages, allPages } from './docxtools.js';
import { normalizeRecipe, runBatch } from './batch-core.js';

const BATCH_STEPS = [
  { id: 'sanitize', label: 'Sanitize metadata, forms and attachments' },
  { id: 'addPageNumbers', label: 'Add page numbers' },
  { id: 'watermark', label: 'Add watermark' },
  { id: 'compress', label: 'Compress pages' },
  { id: 'grayscale', label: 'Convert to grayscale' },
];

function fileName(path) {
  return String(path || '').split(/[\\/]/).pop() || 'document.pdf';
}

export async function runBatchFile(path, recipe, { readFile = window.api.readFile.bind(window.api) } = {}) {
  const normalized = normalizeRecipe(recipe);
  if (!normalized.steps.length) throw new Error('The recipe has no supported steps.');
  const loaded = await readFile(path);
  if (!loaded?.ok) throw new Error(loaded?.error || 'Could not read the PDF.');
  const bytes = loaded.data instanceof Uint8Array ? loaded.data : new Uint8Array(loaded.data || []);
  const pdf = await loadPdfBytes(bytes);
  try {
    const doc = newDocShell({ name: fileName(path), path, bytes, pdf, numPages: pdf.numPages });
    doc.pageSizes = new Array(pdf.numPages);
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      doc.pageSizes[i] = { w: viewport.width, h: viewport.height };
    }
    const planned = runPipelineModel(doc, normalized.steps);
    const flags = doc.pipelineFlags || {};
    const done = [];
    if (flags.flatten) done.push('flattened');
    if (flags.compress) {
      const plan = planCompress({ ...(flags.compress || {}), pageCount: doc.numPages });
      doc.compressQuality = plan.quality;
      rasterizePages(doc, plan.pages, plan.filter, plan.dpi);
      done.push('compressed');
    }
    if (flags.grayscale) {
      rasterizePages(doc, allPages(doc.numPages), 'grayscale(1)', 150);
      done.push('grayscale');
    }
    const stamps = pipelineStamps(flags, doc.numPages);
    doc.stamps = [...(doc.stamps || []), ...stamps];
    let output;
    try {
      output = await buildPdf(doc, { sanitize: normalized.steps.some((step) => step.id === 'sanitize') });
    } finally {
      doc.stamps = (doc.stamps || []).slice(0, (doc.stamps || []).length - stamps.length);
      doc.pipelineFlags = null;
    }
    if (stamps.some((stamp) => String(stamp.id || '').startsWith('pipeline-pn-'))) done.push(`numbered ${doc.numPages} page(s)`);
    if (stamps.some((stamp) => stamp.kind === 'watermark')) done.push('watermarked');
    if (normalized.steps.some((step) => step.id === 'sanitize')) done.push('sanitized');
    return { ok: true, bytes: output, summary: done.join(' · ') || planned.applied.join(' · ') || 'Processed' };
  } finally {
    try { await pdf.destroy(); } catch { /* ignore */ }
  }
}

export async function openBatchWorkbench() {
  let files = [];
  let recipes = [];
  let running = false;
  let paused = false;
  try { recipes = (await window.api.storeGet('batchRecipes', [])) || []; } catch { recipes = []; }
  if (!Array.isArray(recipes) || !recipes.length) recipes = [normalizeRecipe({ name: 'Number and sanitize' })];
  recipes = recipes.map(normalizeRecipe);
  let selected = recipes[0];

  await showModal({
    title: 'Batch Document Workbench',
    width: 'wide',
    body: (body) => {
      const fileList = el('div', { class: 'batch-files' });
      const recipeSelect = el('select', {});
      const recipeName = el('input', { type: 'text', value: selected.name });
      const steps = el('div', { class: 'batch-steps' });
      const progress = el('div', { class: 'batch-progress', text: 'Choose PDFs and a recipe to begin.' });
      const results = el('div', { class: 'batch-results' });
      const add = el('button', { class: 'mini-btn', type: 'button', text: 'Add PDFs…' });
      const saveRecipe = el('button', { class: 'mini-btn', type: 'button', text: 'Save recipe' });
      const run = el('button', { class: 'mini-btn primary', type: 'button', text: 'Run batch' });

      const renderSteps = () => {
        steps.textContent = '';
        for (const step of BATCH_STEPS) {
          const checked = selected.steps.some((item) => item.id === step.id);
          const box = el('input', { type: 'checkbox', checked });
          const label = el('label', { class: 'batch-step' }, [box, document.createTextNode(step.label)]);
          let param = null;
          if (step.id === 'addPageNumbers') {
            param = el('select', {}, [
              el('option', { value: 'n-of-N', text: 'Page 1 of N' }),
              el('option', { value: 'n', text: '1' }),
              el('option', { value: 'n/N', text: '1/N' }),
              el('option', { value: 'roman', text: 'i' }),
            ]);
            param.value = selected.steps.find((item) => item.id === step.id)?.params?.formatId || 'n-of-N';
          } else if (step.id === 'watermark') {
            param = el('input', { type: 'text', value: selected.steps.find((item) => item.id === step.id)?.params?.text || 'DRAFT' });
          } else if (step.id === 'compress') {
            param = el('select', {}, [
              el('option', { value: 'web', text: 'Web / email' }),
              el('option', { value: 'balanced', text: 'Balanced' }),
              el('option', { value: 'print', text: 'Print-safe' }),
            ]);
            param.value = selected.steps.find((item) => item.id === step.id)?.params?.presetId || 'balanced';
          }
          box.onchange = () => {
            selected.steps = selected.steps.filter((item) => item.id !== step.id);
            if (box.checked) selected.steps.push({ id: step.id, params: param ? (step.id === 'watermark' ? { text: param.value } : step.id === 'addPageNumbers' ? { formatId: param.value } : { presetId: param.value }) : {} });
            renderSteps();
          };
          if (param) {
            param.onchange = () => {
              const item = selected.steps.find((entry) => entry.id === step.id);
              if (item) item.params = step.id === 'watermark' ? { text: param.value } : step.id === 'addPageNumbers' ? { formatId: param.value } : { presetId: param.value };
            };
            label.appendChild(param);
          }
          steps.appendChild(label);
        }
      };
      const renderRecipes = () => {
        recipeSelect.textContent = '';
        recipes.forEach((recipe, index) => recipeSelect.appendChild(el('option', { value: String(index), text: recipe.name })));
        recipeSelect.value = String(Math.max(0, recipes.indexOf(selected)));
        recipeName.value = selected.name;
        renderSteps();
      };
      const renderFiles = () => {
        fileList.textContent = '';
        if (!files.length) fileList.appendChild(el('div', { class: 'set-hint', text: 'No PDFs selected.' }));
        files.forEach((file) => fileList.appendChild(el('div', { class: 'batch-file', text: file.name })));
      };
      const renderResults = (state) => {
        results.textContent = '';
        for (const record of state.results) {
          const row = el('div', { class: `batch-result ${record.status}` });
          row.appendChild(el('span', { text: `${record.name}: ${record.status}${record.summary ? ` — ${record.summary}` : ''}${record.error ? ` — ${record.error}` : ''}` }));
          if (record.bytes) {
            const save = el('button', { class: 'mini-btn', type: 'button', text: 'Save As…' });
            save.onclick = async () => {
              const destination = await window.api.saveDialog({ defaultPath: record.name.replace(/\.pdf$/i, '') + '-processed.pdf' });
              if (!destination) return;
              const written = await window.api.writeFile(destination, record.bytes);
              toast(written.ok ? 'Batch output saved' : written.error || 'Save failed', written.ok ? 'ok' : 'err');
            };
            row.appendChild(save);
          }
          results.appendChild(row);
        }
        const complete = state.results.filter((item) => item.status === 'done' || item.status === 'failed').length;
        progress.textContent = `${complete}/${state.total} complete${paused ? ' — paused' : ''}`;
      };

      add.onclick = async () => {
        const paths = await window.api.openDialog({ title: 'Choose PDFs for the batch', multiSelections: true });
        if (!paths) return;
        for (const path of paths) if (!files.some((file) => file.path === path)) files.push({ path, name: fileName(path) });
        renderFiles();
      };
      saveRecipe.onclick = async () => {
        selected.name = recipeName.value.trim() || 'Document recipe';
        const existing = recipes.findIndex((recipe) => recipe.id === selected.id);
        if (existing >= 0) recipes[existing] = selected;
        else recipes.push(selected);
        await window.api.storeSet('batchRecipes', recipes);
        renderRecipes();
        toast('Recipe saved', 'ok');
      };
      recipeSelect.onchange = () => { selected = recipes[Number(recipeSelect.value)] || recipes[0]; renderRecipes(); };
      recipeName.onchange = () => { selected.name = recipeName.value.trim() || 'Document recipe'; };
      run.onclick = async () => {
        if (running) { paused = !paused; run.textContent = paused ? 'Resume batch' : 'Pause batch'; return; }
        if (!files.length || !selected.steps.length) return toast('Choose PDFs and at least one recipe step.', 'warn');
        running = true;
        paused = false;
        run.textContent = 'Pause batch';
        add.disabled = true;
        saveRecipe.disabled = true;
        recipeSelect.disabled = true;
        try {
          await runBatch(files, selected, {
            concurrency: 2,
            worker: (file) => runBatchFile(file.path, selected),
            shouldPause: async () => paused,
            onUpdate: renderResults,
          });
        } finally {
          running = false;
          run.textContent = 'Run batch';
          add.disabled = false;
          saveRecipe.disabled = false;
          recipeSelect.disabled = false;
        }
      };

      body.appendChild(el('div', { class: 'batch-toolbar' }, [add, run]));
      body.appendChild(fileList);
      body.appendChild(el('div', { class: 'batch-recipe-row' }, [recipeSelect, recipeName, saveRecipe]));
      body.appendChild(steps);
      body.appendChild(progress);
      body.appendChild(results);
      renderRecipes();
      renderFiles();
    },
    buttons: [{ label: 'Close', value: true, kind: 'primary' }],
  });
}
