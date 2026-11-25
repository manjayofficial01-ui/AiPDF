const KNOWN_STEPS = new Set(['sanitize', 'addPageNumbers', 'watermark', 'compress', 'grayscale']);
const DEFAULT_STEPS = [
  { id: 'sanitize', params: {} },
  { id: 'addPageNumbers', params: { formatId: 'n-of-N' } },
];

export function normalizeRecipe(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const steps = Array.isArray(source.steps) && source.steps.length
    ? source.steps
    : DEFAULT_STEPS;
  return {
    id: String(source.id || `recipe-${Date.now().toString(36)}`),
    name: String(source.name || 'Document recipe').trim().slice(0, 80) || 'Document recipe',
    steps: steps.filter((step) => step && KNOWN_STEPS.has(step.id)).map((step) => ({
      id: step.id,
      params: step.params && typeof step.params === 'object' ? { ...step.params } : {},
    })),
  };
}

const pauseDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBatch(items, recipe, {
  concurrency = 2,
  worker,
  onUpdate = null,
  shouldPause = async () => false,
} = {}) {
  if (typeof worker !== 'function') throw new Error('A batch worker is required.');
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(8, Math.floor(Number(concurrency) || 2)));
  const results = list.map((item, index) => ({
    id: item.id || `item-${index}`,
    name: item.name || `Document ${index + 1}`,
    path: item.path || '',
    status: 'pending',
    summary: '',
    error: '',
  }));
  let next = 0;
  let done = false;
  const emit = () => onUpdate?.({ results, next, done, total: list.length });

  async function waitForResume() {
    while (await shouldPause()) {
      emit();
      await pauseDelay(25);
    }
  }

  async function lane() {
    while (next < list.length) {
      await waitForResume();
      const index = next++;
      const item = list[index];
      const record = results[index];
      record.status = 'running';
      emit();
      try {
        const output = await worker(item, recipe, index);
        if (output?.ok === false) throw new Error(output.error || 'Processing failed.');
        record.status = 'done';
        record.summary = output?.summary || 'Processed';
        record.bytes = output?.bytes || null;
      } catch (error) {
        record.status = 'failed';
        record.error = String(error?.message || error);
      }
      emit();
    }
  }

  emit();
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, () => lane()));
  done = true;
  emit();
  return { results, done: true };
}
