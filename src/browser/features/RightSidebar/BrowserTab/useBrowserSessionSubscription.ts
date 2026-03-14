import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type {
  BrowserAction,
  BrowserSession,
  BrowserSessionEvent,
} from "@/common/types/browserSession";
import { assertNever } from "@/common/utils/assertNever";

const MAX_RECENT_ACTIONS = 50;

export function useBrowserSessionSubscription(workspaceId: string) {
  if (workspaceId.trim().length === 0) {
    throw new Error("Browser session subscription requires a workspaceId");
  }

  const { api } = useAPI();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [recentActions, setRecentActions] = useState<BrowserAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!api) {
      sessionIdRef.current = null;
      setSession(null);
      setRecentActions([]);
      setError(null);
      return;
    }

    sessionIdRef.current = null;
    setSession(null);
    setRecentActions([]);
    setError(null);

    const controller = new AbortController();
    const { signal } = controller;
    let iterator: AsyncIterator<BrowserSessionEvent> | null = null;

    const subscribe = async () => {
      const subscribedIterator = await api.browserSession.subscribe({ workspaceId }, { signal });

      if (signal.aborted) {
        void subscribedIterator.return?.();
        return;
      }

      iterator = subscribedIterator;

      for await (const event of subscribedIterator) {
        if (signal.aborted) break;

        switch (event.type) {
          case "snapshot":
            sessionIdRef.current = event.session?.id ?? null;
            setSession(event.session);
            setRecentActions(normalizeRecentActions(event.recentActions));
            setError(null);
            break;
          case "session-updated": {
            const sessionIdChanged = sessionIdRef.current !== event.session.id;
            sessionIdRef.current = event.session.id;
            setSession(event.session);
            if (sessionIdChanged) {
              setRecentActions([]);
            }
            setError(null);
            break;
          }
          case "action":
            setRecentActions((previousActions) => {
              const deduplicatedActions = previousActions.filter(
                (action) => action.id !== event.action.id
              );
              return [event.action, ...deduplicatedActions].slice(0, MAX_RECENT_ACTIONS);
            });
            break;
          case "session-ended":
            setSession((previousSession) => {
              if (!previousSession) {
                return null;
              }

              return {
                ...previousSession,
                status: "ended",
                updatedAt: new Date().toISOString(),
              };
            });
            setError(null);
            break;
          case "error":
            setError(event.error);
            setSession((previousSession) => {
              if (!previousSession) {
                return null;
              }

              return {
                ...previousSession,
                status: "error",
                lastError: event.error,
                updatedAt: new Date().toISOString(),
              };
            });
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

  return { session, recentActions, error };
}

function normalizeRecentActions(actions: BrowserAction[]): BrowserAction[] {
  return [...actions].reverse().slice(0, MAX_RECENT_ACTIONS);
}
