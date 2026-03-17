import { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { isAbortError } from "@/browser/utils/isAbortError";
import type {
  BrowserAction,
  BrowserSession,
  BrowserSessionEvent,
} from "@/common/types/browserSession";
import { assertNever } from "@/common/utils/assertNever";
import { SUBSCRIPTION_HEARTBEAT_INTERVAL_MS } from "@/common/utils/withQueueHeartbeat";

const MAX_RECENT_ACTIONS = 50;
const INITIAL_RESUBSCRIBE_BACKOFF_MS = 1_000;
const MAX_RESUBSCRIBE_BACKOFF_MS = 30_000;
const STALE_SUBSCRIPTION_MS = 3 * SUBSCRIPTION_HEARTBEAT_INTERVAL_MS;

export function useBrowserSessionSubscription(workspaceId: string) {
  if (workspaceId.trim().length === 0) {
    throw new Error("Browser session subscription requires a workspaceId");
  }

  const { api } = useAPI();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [recentActions, setRecentActions] = useState<BrowserAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const iteratorRef = useRef<AsyncIterator<BrowserSessionEvent> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibleRef = useRef(true);
  const lastEventAtRef = useRef(0);
  const staleResubscribeCountRef = useRef(0);
  const subscriptionGenerationRef = useRef(0);
  const activeSubscriptionGenerationRef = useRef<number | null>(null);
  const shouldClearReconnectErrorRef = useRef(false);

  useEffect(() => {
    if (!api) {
      return;
    }

    let disposed = false;

    visibleRef.current = typeof document === "undefined" || !document.hidden;

    const clearWatchdog = () => {
      if (watchdogTimerRef.current !== null) {
        clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = null;
      }
    };

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const clearScheduledWork = () => {
      clearWatchdog();
      clearReconnectTimer();
    };

    // Keep the last good session snapshot visible while internal resubscribes recycle
    // stale iterators; workspace and tab switches still reset by unmounting this hook.
    const stopSubscription = () => {
      clearScheduledWork();
      subscriptionGenerationRef.current += 1;
      activeSubscriptionGenerationRef.current = null;

      const controller = controllerRef.current;
      controllerRef.current = null;
      controller?.abort();

      const iterator = iteratorRef.current;
      iteratorRef.current = null;
      void iterator?.return?.();
    };

    const getWatchdogReconnectDelay = () => {
      return Math.min(
        INITIAL_RESUBSCRIBE_BACKOFF_MS * 2 ** Math.max(staleResubscribeCountRef.current - 1, 0),
        MAX_RESUBSCRIBE_BACKOFF_MS
      );
    };

    const armWatchdog = (generation: number) => {
      clearWatchdog();
      if (
        disposed ||
        !visibleRef.current ||
        activeSubscriptionGenerationRef.current !== generation
      ) {
        return;
      }

      watchdogTimerRef.current = setTimeout(() => {
        watchdogTimerRef.current = null;
        if (
          disposed ||
          !visibleRef.current ||
          activeSubscriptionGenerationRef.current !== generation
        ) {
          return;
        }

        if (Date.now() - lastEventAtRef.current < STALE_SUBSCRIPTION_MS) {
          armWatchdog(generation);
          return;
        }

        staleResubscribeCountRef.current += 1;
        shouldClearReconnectErrorRef.current = true;
        stopSubscription();
        scheduleReconnect(getWatchdogReconnectDelay());
      }, STALE_SUBSCRIPTION_MS);
    };

    const markEventReceived = (generation: number, event: BrowserSessionEvent) => {
      lastEventAtRef.current = Date.now();
      staleResubscribeCountRef.current = 0;
      if (shouldClearReconnectErrorRef.current && event.type !== "error") {
        shouldClearReconnectErrorRef.current = false;
        setError(null);
      }
      armWatchdog(generation);
    };

    const startSubscription = async () => {
      if (disposed || !visibleRef.current) {
        return;
      }

      stopSubscription();

      const generation = subscriptionGenerationRef.current + 1;
      subscriptionGenerationRef.current = generation;
      activeSubscriptionGenerationRef.current = generation;

      const controller = new AbortController();
      controllerRef.current = controller;
      lastEventAtRef.current = Date.now();
      armWatchdog(generation);

      try {
        const subscribedIterator = await api.browserSession.subscribe(
          { workspaceId },
          { signal: controller.signal }
        );

        if (
          disposed ||
          controller.signal.aborted ||
          activeSubscriptionGenerationRef.current !== generation
        ) {
          void subscribedIterator.return?.();
          return;
        }

        iteratorRef.current = subscribedIterator;

        for await (const event of subscribedIterator) {
          if (
            disposed ||
            controller.signal.aborted ||
            activeSubscriptionGenerationRef.current !== generation
          ) {
            break;
          }

          markEventReceived(generation, event);

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
            case "heartbeat":
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
              shouldClearReconnectErrorRef.current = false;
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

        if (
          disposed ||
          controller.signal.aborted ||
          activeSubscriptionGenerationRef.current !== generation
        ) {
          return;
        }

        shouldClearReconnectErrorRef.current = true;
        scheduleReconnect(INITIAL_RESUBSCRIBE_BACKOFF_MS);
      } catch (subscriptionError: unknown) {
        if (
          disposed ||
          controller.signal.aborted ||
          isAbortError(subscriptionError) ||
          activeSubscriptionGenerationRef.current !== generation
        ) {
          return;
        }

        shouldClearReconnectErrorRef.current = true;
        setError(
          subscriptionError instanceof Error ? subscriptionError.message : "Subscription failed"
        );
        scheduleReconnect(INITIAL_RESUBSCRIBE_BACKOFF_MS);
      } finally {
        if (activeSubscriptionGenerationRef.current === generation) {
          clearWatchdog();
          controllerRef.current = null;
          iteratorRef.current = null;
          activeSubscriptionGenerationRef.current = null;
        }
      }
    };

    const scheduleReconnect = (delayMs: number) => {
      if (disposed || !visibleRef.current) {
        return;
      }

      clearReconnectTimer();
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        void startSubscription();
      }, delayMs);
    };

    // Hidden tabs do not need a live iterator, and forcing a fresh subscribe on
    // visibility regain lets the Browser tab recover without a full page reload.
    const handleVisibilityChange = () => {
      visibleRef.current = !document.hidden;
      if (!visibleRef.current) {
        stopSubscription();
        return;
      }

      if (activeSubscriptionGenerationRef.current === null) {
        void startSubscription();
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    if (visibleRef.current) {
      void startSubscription();
    }

    return () => {
      disposed = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
      stopSubscription();
    };
  }, [api, workspaceId]);

  return { session, recentActions, error };
}

function normalizeRecentActions(actions: BrowserAction[]): BrowserAction[] {
  return [...actions].reverse().slice(0, MAX_RECENT_ACTIONS);
}
