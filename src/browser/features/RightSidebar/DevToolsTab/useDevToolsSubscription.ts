import { useEffect, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type { DevToolsEvent, DevToolsRunSummary } from "@/common/types/devtools";
import { assertNever } from "@/common/utils/assertNever";

export function useDevToolsSubscription(workspaceId: string) {
  const { api } = useAPI();
  const [runs, setRuns] = useState<DevToolsRunSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!api) {
      setRuns([]);
      return;
    }

    setRuns([]);
    setError(null);

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<DevToolsEvent> | null = null;

    const subscribe = async () => {
      const subscribedIterator = await api.devtools.subscribe({ workspaceId }, { signal });

      if (signal.aborted) {
        void subscribedIterator.return?.();
        return;
      }

      iterator = subscribedIterator;

      for await (const event of subscribedIterator) {
        if (signal.aborted) break;

        switch (event.type) {
          case "snapshot":
            setRuns(event.runs);
            break;
          case "run-created":
            setRuns((previousRuns) => [event.run, ...previousRuns]);
            break;
          case "run-updated":
            setRuns((previousRuns) =>
              previousRuns.map((run) => (run.id === event.run.id ? event.run : run))
            );
            break;
          case "step-created":
          case "step-updated":
            break;
          case "cleared":
            setRuns([]);
            break;
          default:
            assertNever(event);
        }
      }
    };

    subscribe().catch((subscriptionError: unknown) => {
      if (signal.aborted || isAbortError(subscriptionError)) return;
      setError(
        subscriptionError instanceof Error ? subscriptionError.message : "Subscription failed"
      );
    });

    return () => {
      controller.abort();
      void iterator?.return?.();
    };
  }, [api, workspaceId]);

  return { runs, error };
}
