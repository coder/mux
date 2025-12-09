import type { APIClient } from "@/browser/contexts/API";

const MAX_CACHE_ENTRIES = 256;

type CacheKey = string;

interface CacheEntry {
  promise: Promise<number>;
  value: number | null;
}

const tokenCache = new Map<CacheKey, CacheEntry>();
const keyOrder: CacheKey[] = [];

function makeKey(model: string, text: string): CacheKey {
  return `${model}::${text}`;
}

function pruneCache(): void {
  while (keyOrder.length > MAX_CACHE_ENTRIES) {
    const oldestKey = keyOrder.shift();
    if (oldestKey) {
      tokenCache.delete(oldestKey);
    }
  }
}

export function getTokenCountPromise(
  client: APIClient,
  model: string,
  text: string
): Promise<number> {
  const trimmedModel = model?.trim();
  if (!trimmedModel || text.length === 0) {
    return Promise.resolve(0);
  }

  const key = makeKey(trimmedModel, text);
  const cached = tokenCache.get(key);
  if (cached) {
    return cached.value !== null ? Promise.resolve(cached.value) : cached.promise;
  }

  const promise = client.tokenizer
    .countTokens({ model: trimmedModel, text })
    .then((tokens) => {
      const entry = tokenCache.get(key);
      if (entry) {
        entry.value = tokens;
      }
      return tokens;
    })
    .catch((error) => {
      console.error("[tokenizer] countTokens failed", error);
      tokenCache.delete(key);
      return 0;
    });

  tokenCache.set(key, { promise, value: null });
  keyOrder.push(key);
  pruneCache();
  return promise;
}

export async function countTokensBatchRenderer(
  client: APIClient,
  model: string,
  texts: string[]
): Promise<number[]> {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const trimmedModel = model?.trim();
  if (!trimmedModel) {
    return texts.map(() => 0);
  }

  const results = new Array<number>(texts.length).fill(0);
  const missingIndices: number[] = [];
  const missingTexts: string[] = [];

  for (let i = 0; i < texts.length; i++) {
    const text = texts[i];
    const key = makeKey(trimmedModel, text);
    const cached = tokenCache.get(key);
    if (cached && cached.value !== null) {
      results[i] = cached.value;
    } else {
      missingIndices.push(i);
      missingTexts.push(text);
    }
  }

  if (missingTexts.length === 0) {
    return results;
  }

  try {
    const rawBatchResult: unknown = await client.tokenizer.countTokensBatch({
      model: trimmedModel,
      texts: missingTexts,
    });
    if (!Array.isArray(rawBatchResult)) {
      throw new Error("Tokenizer returned invalid batch result");
    }
    const batchResult = rawBatchResult.map((value) => (typeof value === "number" ? value : 0));

    for (let i = 0; i < missingIndices.length; i++) {
      const idx = missingIndices[i];
      const rawCount = batchResult[i];
      const count = typeof rawCount === "number" ? rawCount : 0;
      const text = texts[idx];
      const key = makeKey(trimmedModel, text);
      tokenCache.set(key, { promise: Promise.resolve(count), value: count });
      keyOrder.push(key);
      results[idx] = count;
    }
    pruneCache();
  } catch (error) {
    console.error("[tokenizer] countTokensBatch failed", error);
    for (const idx of missingIndices) {
      results[idx] = 0;
    }
  }

  return results;
}

export function clearRendererTokenizerCache(): void {
  tokenCache.clear();
  keyOrder.length = 0;
}
