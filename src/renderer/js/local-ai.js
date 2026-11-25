async function probe(url, parse, { timeoutMs = 1500, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return null;
    return parse(await response.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function detectLocalAi({
  ollamaUrl = 'http://localhost:11434',
  lmStudioUrl = 'http://localhost:1234',
  timeoutMs = 1500,
  fetchImpl = fetch,
} = {}) {
  const ollamaBase = String(ollamaUrl).replace(/\/+$/, '');
  const ollamaModels = await probe(`${ollamaBase}/api/tags`, (json) => {
    const models = Array.isArray(json?.models) ? json.models.map((item) => item?.name).filter(Boolean) : [];
    return [...new Set(models)];
  }, { timeoutMs, fetchImpl });
  if (ollamaModels?.length) {
    return { provider: 'ollama', baseUrl: `${ollamaBase}/v1`, models: ollamaModels };
  }

  const lmBase = String(lmStudioUrl).replace(/\/+$/, '');
  const lmModels = await probe(`${lmBase}/v1/models`, (json) => {
    const models = Array.isArray(json?.data) ? json.data.map((item) => item?.id).filter(Boolean) : [];
    return [...new Set(models)];
  }, { timeoutMs, fetchImpl });
  if (lmModels?.length) {
    return { provider: 'lmstudio', baseUrl: `${lmBase}/v1`, models: lmModels };
  }
  return null;
}

export function applyLocalAiSettings(found, current = {}) {
  if (!found?.provider || !found?.baseUrl || !found?.models?.length) throw new Error('No local AI model is available.');
  return {
    ...current,
    provider: found.provider,
    baseUrl: found.baseUrl,
    model: found.models[0],
    authMode: 'none',
    apiKey: '',
  };
}
