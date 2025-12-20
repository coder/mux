import type { APIClient } from "@/browser/contexts/API";
import { readPersistedState } from "@/browser/hooks/usePersistedState";
import { getThinkingLevelByModelKey } from "@/common/constants/storage";
import type { PersistedSettings } from "@/common/orpc/types";
import type { ThinkingLevel } from "@/common/types/thinking";
import { normalizeGatewayModel } from "@/common/utils/ai/models";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "medium", "high", "xhigh"];

export interface PersistedSettingsSnapshot {
  loading: boolean;
  settings: PersistedSettings;
}

type Subscriber = () => void;

const subscribers = new Set<Subscriber>();

let api: APIClient | null = null;
let abortController: AbortController | null = null;

let snapshot: PersistedSettingsSnapshot = { loading: true, settings: {} };

function emitChange(): void {
  for (const subscriber of subscribers) {
    subscriber();
  }
}

function setSnapshot(next: PersistedSettingsSnapshot): void {
  snapshot = next;
  emitChange();
}

function getThinkingLevelFromLocalStorage(model: string): ThinkingLevel {
  const key = getThinkingLevelByModelKey(model);
  const stored = readPersistedState<ThinkingLevel | undefined>(key, undefined);
  if (stored !== undefined && THINKING_LEVELS.includes(stored)) {
    return stored;
  }
  return WORKSPACE_DEFAULTS.thinkingLevel;
}

function isEmptyThinkingMap(settings: PersistedSettings): boolean {
  const byModel = settings.ai?.thinkingLevelByModel;
  return !byModel || Object.keys(byModel).length === 0;
}

async function maybeSeedThinkingFromLocalStorage(apiClient: APIClient): Promise<void> {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  const prefix = "thinkingLevel:model:";
  const toPersist: Array<{ model: string; thinkingLevel: ThinkingLevel }> = [];

  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;

    const rawModel = key.slice(prefix.length);
    const model = normalizeGatewayModel(rawModel);

    const level = readPersistedState<ThinkingLevel | undefined>(key, undefined);
    if (level !== undefined && THINKING_LEVELS.includes(level)) {
      toPersist.push({ model, thinkingLevel: level });
    }
  }

  if (toPersist.length === 0) {
    return;
  }

  await Promise.all(
    toPersist.map(({ model, thinkingLevel }) =>
      apiClient.persistedSettings.setAIThinkingLevel({ model, thinkingLevel })
    )
  );
}

async function refresh(): Promise<void> {
  if (!api) {
    return;
  }

  try {
    const settings = await api.persistedSettings.get();
    setSnapshot({ loading: false, settings });

    // One-time migration: if the backend has no thinking map yet, seed from localStorage.
    if (isEmptyThinkingMap(settings)) {
      try {
        await maybeSeedThinkingFromLocalStorage(api);
        const refreshed = await api.persistedSettings.get();
        setSnapshot({ loading: false, settings: refreshed });
      } catch {
        // Best-effort only.
      }
    }
  } catch {
    // Old server/client mismatch or offline. Keep local fallback behavior.
    setSnapshot({ loading: false, settings: snapshot.settings });
  }
}

export const persistedSettingsStore = {
  subscribe(subscriber: Subscriber): () => void {
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  },

  getSnapshot(): PersistedSettingsSnapshot {
    return snapshot;
  },

  init(apiClient: APIClient | null): void {
    if (api === apiClient) {
      return;
    }

    abortController?.abort();
    abortController = null;

    api = apiClient;

    if (!api) {
      return;
    }

    abortController = new AbortController();
    const signal = abortController.signal;

    void refresh();

    (async () => {
      try {
        const iterator = await api.persistedSettings.onChanged(undefined, { signal });
        for await (const _ of iterator) {
          if (signal.aborted) break;
          void refresh();
        }
      } catch {
        // Expected on shutdown / disconnect.
      }
    })();
  },

  async setAIThinkingLevel(model: string, thinkingLevel: ThinkingLevel | null): Promise<void> {
    const normalizedModel = normalizeGatewayModel(model);

    // Optimistic update for instant UI feedback.
    const current = snapshot.settings;
    const currentByModel = current.ai?.thinkingLevelByModel ?? {};
    const nextByModel = { ...currentByModel };
    if (thinkingLevel === null) {
      delete nextByModel[normalizedModel];
    } else {
      nextByModel[normalizedModel] = thinkingLevel;
    }

    const hasAnyThinking = Object.keys(nextByModel).length > 0;
    const nextSettings: PersistedSettings = {
      ...current,
      ai: hasAnyThinking ? { ...(current.ai ?? {}), thinkingLevelByModel: nextByModel } : undefined,
    };

    setSnapshot({ loading: snapshot.loading, settings: nextSettings });

    if (!api) {
      return;
    }

    try {
      const result = await api.persistedSettings.setAIThinkingLevel({
        model: normalizedModel,
        thinkingLevel,
      });
      if (!result.success) {
        throw new Error(result.error);
      }
    } catch {
      await refresh();
    }
  },

  getThinkingLevelForModel(model: string): ThinkingLevel {
    const normalizedModel = normalizeGatewayModel(model);
    const stored = snapshot.settings.ai?.thinkingLevelByModel?.[normalizedModel];
    if (stored !== undefined && THINKING_LEVELS.includes(stored)) {
      return stored;
    }

    return getThinkingLevelFromLocalStorage(normalizedModel);
  },

  dispose(): void {
    abortController?.abort();
    abortController = null;
    api = null;
    subscribers.clear();
    snapshot = { loading: true, settings: {} };
  },
};
