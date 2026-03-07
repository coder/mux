import { useEffect, useState, useCallback, useRef } from "react";
import { useAPI } from "@/browser/contexts/API";
import type { OpenAICompatibleProvidersInfo } from "@/common/orpc/types";

export function useOpenAICompatibleProviders() {
  const { api } = useAPI();
  const [config, setConfig] = useState<OpenAICompatibleProvidersInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const configRef = useRef<OpenAICompatibleProvidersInfo | null>(null);
  const fetchVersionRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!api) return;
    const myVersion = ++fetchVersionRef.current;
    try {
      const cfg = await api.openaiCompatibleProviders.getConfig();
      if (myVersion === fetchVersionRef.current) {
        configRef.current = cfg;
        setConfig(cfg);
      }
    } catch {
      // Ignore errors fetching config
    } finally {
      if (myVersion === fetchVersionRef.current) {
        setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;

    const abortController = new AbortController();
    const { signal } = abortController;

    let iterator: AsyncIterator<unknown> | null = null;

    void refresh();

    (async () => {
      try {
        const subscribedIterator = await api.providers.onConfigChanged(undefined, { signal });

        if (signal.aborted) {
          void subscribedIterator.return?.();
          return;
        }

        iterator = subscribedIterator;

        for await (const _ of subscribedIterator) {
          if (signal.aborted) break;
          void refresh();
        }
      } catch {
        // Subscription cancelled
      }
    })();

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api, refresh]);

  return { config, loading, refresh };
}
