import { useCallback, useMemo } from "react";
import { usePersistedState } from "./usePersistedState";
import { CHAT_PROMPT_HISTORY_KEY } from "@/common/constants/storage";

export interface StoredPrompt {
  text: string;
  /** Normalized key used for dedupe */
  key: string;
  /** Number of times the prompt has been used */
  useCount: number;
  /** Epoch ms */
  lastUsedAt: number;
}

const MAX_PROMPTS = 100;
const MAX_TEXT_LENGTH = 400;

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

export function normalizePromptKey(text: string): string {
  return collapseWhitespace(text).trim().toLowerCase();
}

export function normalizePromptText(text: string): string {
  // Keep original casing but normalize whitespace + trim.
  return collapseWhitespace(text).trim();
}

export function shouldStorePrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_TEXT_LENGTH) return false;
  // Slash commands have their own suggestion UX.
  if (trimmed.startsWith("/")) return false;
  // MVP: avoid storing multi-line prompts (typically unique and noisy).
  if (trimmed.includes("\n")) return false;
  return true;
}

export function scorePrompt(prompt: StoredPrompt, nowMs: number): number {
  const ageHours = Math.max(0, (nowMs - prompt.lastUsedAt) / (1000 * 60 * 60));
  const recencyScore = 1 / (1 + ageHours);
  const freqScore = Math.log(1 + prompt.useCount);
  return 0.7 * recencyScore + 0.3 * freqScore;
}

export function getBestCompletionFromPrompts(
  prompts: StoredPrompt[],
  rawPrefix: string,
  nowMs: number
): string | null {
  const prefix = rawPrefix.trimStart();
  if (!prefix) return null;

  const prefixLower = prefix.toLowerCase();

  const candidates = prompts
    .filter((p) => {
      const candidateLower = p.text.toLowerCase();
      return candidateLower.startsWith(prefixLower) && candidateLower !== prefixLower;
    })
    .map((p) => ({
      prompt: p,
      score: scorePrompt(p, nowMs),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.prompt.lastUsedAt !== a.prompt.lastUsedAt)
        return b.prompt.lastUsedAt - a.prompt.lastUsedAt;
      if (b.prompt.useCount !== a.prompt.useCount) return b.prompt.useCount - a.prompt.useCount;
      return a.prompt.text.length - b.prompt.text.length;
    });

  return candidates[0]?.prompt.text ?? null;
}

/**
 * Persisted prompt history for non-AI chat autocomplete.
 *
 * Similar spirit to `useModelLRU`, but stores text prompts and scores them by
 * a blend of recency + frequency.
 */
export function useChatPromptHistory() {
  const [prompts, setPrompts] = usePersistedState<StoredPrompt[]>(CHAT_PROMPT_HISTORY_KEY, [], {
    listener: true,
  });

  const addPrompt = useCallback(
    (rawText: string) => {
      if (!shouldStorePrompt(rawText)) {
        return;
      }

      const text = normalizePromptText(rawText);
      const key = normalizePromptKey(text);
      if (!key) return;

      const nowMs = Date.now();

      setPrompts((prev) => {
        const prevSafe = Array.isArray(prev) ? prev : [];

        const without = prevSafe.filter((p) => p && typeof p.key === "string" && p.key !== key);
        const existing = prevSafe.find((p) => p && typeof p.key === "string" && p.key === key);

        const updated: StoredPrompt = {
          text,
          key,
          useCount: (existing?.useCount ?? 0) + 1,
          lastUsedAt: nowMs,
        };

        const merged = [updated, ...without].filter(Boolean);

        // Bound size by evicting lowest-score prompts first.
        const sortedByScore = merged
          .map((p) => ({ p, score: scorePrompt(p, nowMs) }))
          .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.p.lastUsedAt - a.p.lastUsedAt;
          })
          .map(({ p }) => p);

        return sortedByScore.slice(0, MAX_PROMPTS);
      });
    },
    [setPrompts]
  );

  const getBestCompletion = useCallback(
    (rawPrefix: string) => {
      return getBestCompletionFromPrompts(prompts ?? [], rawPrefix, Date.now());
    },
    [prompts]
  );

  const clear = useCallback(() => {
    setPrompts([]);
  }, [setPrompts]);

  return useMemo(
    () => ({
      prompts,
      addPrompt,
      getBestCompletion,
      clear,
    }),
    [prompts, addPrompt, getBestCompletion, clear]
  );
}
