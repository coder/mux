import { useCallback, useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import {
  getDefaultMinimumThinkingLevel,
  resolveMinimumThinkingLevel,
} from "@/common/utils/thinking/policy";
import type { ThinkingLevel } from "@/common/types/thinking";

export interface MinThinkingLevelsState {
  /** Per-model minimum thinking overrides, keyed by canonical model id. */
  minThinkingLevelByModel: Record<string, ThinkingLevel>;
  // Arrow-function property types (not method shorthand) so consumers can safely
  // destructure these without tripping @typescript-eslint/unbound-method.
  /** Explicit per-model override (undefined when the model uses the default floor). */
  getMinOverride: (modelString: string) => ThinkingLevel | undefined;
  /** Effective floor for a model: explicit override, else the built-in default. */
  getMinimum: (modelString: string) => ThinkingLevel;
  /** Set (or clear, with null) a model's minimum thinking override. */
  setMinThinkingLevel: (modelString: string, level: ThinkingLevel | null) => void;
}

/**
 * Reads/writes the per-model "Minimum Thinking level" map from app config.
 *
 * Mirrors the route-override pattern (useRouting): fetch on mount, subscribe to
 * config changes, and optimistically apply local edits while ignoring stale fetches.
 * The map is the single source of truth that the thinking slider, keybind cycle, and
 * command palette consult to hide thinking levels below the configured floor.
 */
export function useMinThinkingLevels(): MinThinkingLevelsState {
  const { api } = useAPI();
  const [minThinkingLevelByModel, setMap] = useState<Record<string, ThinkingLevel>>({});
  // Ignore stale config fetches so backend refreshes can't overwrite newer optimistic edits.
  const fetchVersionRef = useRef(0);

  const fetchConfig = useCallback(async () => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const fetchVersion = ++fetchVersionRef.current;

    try {
      const config = await getConfig();
      if (fetchVersion !== fetchVersionRef.current) {
        return;
      }
      setMap(config.minThinkingLevelByModel ?? {});
    } catch {
      // Best-effort only.
    }
  }, [api]);

  useEffect(() => {
    const onConfigChanged = api?.config?.onConfigChanged;
    if (!onConfigChanged) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    void fetchConfig();

    (async () => {
      try {
        const subscribedIterator = await onConfigChanged(undefined, { signal });
        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }
        iterator = subscribedIterator;
        for await (const _ of subscribedIterator) {
          if (signal.aborted) {
            break;
          }
          void fetchConfig();
        }
      } catch {
        // Subscription cancelled via abort signal - expected on cleanup.
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, fetchConfig]);

  const getMinOverride = useCallback(
    (modelString: string): ThinkingLevel | undefined =>
      minThinkingLevelByModel[normalizeToCanonical(modelString)],
    [minThinkingLevelByModel]
  );

  const getMinimum = useCallback(
    (modelString: string): ThinkingLevel =>
      resolveMinimumThinkingLevel(
        modelString,
        minThinkingLevelByModel[normalizeToCanonical(modelString)]
      ),
    [minThinkingLevelByModel]
  );

  const setMinThinkingLevel = useCallback(
    (modelString: string, level: ThinkingLevel | null) => {
      const key = normalizeToCanonical(modelString);
      const next = { ...minThinkingLevelByModel };
      // Storing the default-equal floor would be redundant; treat it like clearing the
      // override so the persisted map stays sparse.
      if (level == null || level === getDefaultMinimumThinkingLevel(modelString)) {
        delete next[key];
      } else {
        next[key] = level;
      }

      fetchVersionRef.current++;
      setMap(next);

      api?.config?.updateMinThinkingLevels({ minThinkingLevelByModel: next }).catch(() => {
        // Best-effort only; backend config reload will reconcile state.
      });
    },
    [api, minThinkingLevelByModel]
  );

  return {
    minThinkingLevelByModel,
    getMinOverride,
    getMinimum,
    setMinThinkingLevel,
  };
}
