import { useEffect, useRef } from "react";

import { useAPI } from "@/browser/contexts/API";
import { updatePersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { CHAT_TRANSCRIPT_FULL_WIDTH_KEY } from "@/common/constants/storage";

/** Seeded from local cache to avoid a layout flash before the backend responds. */
export function useChatTranscriptFullWidth(): boolean {
  const { api } = useAPI();
  const fetchVersionRef = useRef(0);
  const [rawChatTranscriptFullWidth] = usePersistedState<unknown>(
    CHAT_TRANSCRIPT_FULL_WIDTH_KEY,
    false,
    { listener: true }
  );
  const chatTranscriptFullWidth = rawChatTranscriptFullWidth === true;
  const chatTranscriptFullWidthRef = useRef(chatTranscriptFullWidth);

  useEffect(() => {
    chatTranscriptFullWidthRef.current = chatTranscriptFullWidth;
  }, [chatTranscriptFullWidth]);

  useEffect(() => {
    const getConfig = api?.config?.getConfig;
    if (!getConfig) {
      return;
    }

    const abortController = new AbortController();
    const { signal } = abortController;
    let iterator: AsyncIterator<unknown> | null = null;

    const setSyncedValue = (enabled: boolean) => {
      if (chatTranscriptFullWidthRef.current === enabled) {
        return;
      }

      chatTranscriptFullWidthRef.current = enabled;
      updatePersistedState<boolean | undefined>(
        CHAT_TRANSCRIPT_FULL_WIDTH_KEY,
        enabled ? true : undefined
      );
    };

    const refresh = () => {
      const fetchVersion = ++fetchVersionRef.current;
      getConfig()
        .then((config) => {
          if (!signal.aborted && fetchVersion === fetchVersionRef.current) {
            setSyncedValue(config.chatTranscriptFullWidth === true);
          }
        })
        .catch(() => {
          // Keep the current preference on failure.
        });
    };

    refresh();

    const onConfigChanged = api?.config?.onConfigChanged;
    if (onConfigChanged) {
      const runSubscription = async () => {
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
            refresh();
          }
        } catch {
          // Subscription errors are non-fatal.
        }
      };

      void runSubscription();
    }

    return () => {
      abortController.abort();
      void iterator?.return?.();
    };
  }, [api]);

  return chatTranscriptFullWidth;
}
