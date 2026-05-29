import { useEffect, useRef, useState } from "react";
import type { APIClient } from "@/browser/contexts/API";
import { readPersistedState, usePersistedState } from "@/browser/hooks/usePersistedState";
import { getScheduledPromptsKey } from "@/common/constants/storage";
import { prepareUserMessageForSend, type MuxMessageMetadata } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import {
  getDueScheduledPrompts,
  getNextScheduledPromptRunAt,
  markScheduledPromptFailed,
  markScheduledPromptSending,
  markScheduledPromptSent,
  normalizeScheduledPrompts,
  type ScheduledPrompt,
} from "./scheduledPrompts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface ScheduledPromptDispatcherOptions {
  api: APIClient | null;
  workspaceId: string;
  sendMessageOptions: SendMessageOptions;
  additionalSystemContext?: string;
  enabled: boolean;
  onMessageSendStarted?: (dispatchMode: QueueDispatchMode) => void;
  onMessageSent?: (dispatchMode: QueueDispatchMode) => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim().length > 0
  ) {
    return error.message;
  }
  return "Failed to send scheduled prompt";
}

function getCurrentRunnablePrompt(storageKey: string, promptId: string): ScheduledPrompt | null {
  const currentPrompts = normalizeScheduledPrompts(
    readPersistedState<ScheduledPrompt[]>(storageKey, [])
  );
  return getDueScheduledPrompts(currentPrompts).find((prompt) => prompt.id === promptId) ?? null;
}

export function useScheduledPromptDispatcher(options: ScheduledPromptDispatcherOptions) {
  const {
    api,
    workspaceId,
    sendMessageOptions,
    additionalSystemContext,
    enabled,
    onMessageSendStarted,
    onMessageSent,
  } = options;
  const storageKey = getScheduledPromptsKey(workspaceId);
  const [storedPrompts, setStoredPrompts] = usePersistedState<ScheduledPrompt[]>(storageKey, [], {
    listener: true,
  });
  const inFlightIdsRef = useRef(new Set<string>());
  const isDispatchingRef = useRef(false);
  const [timerNonce, setTimerNonce] = useState(0);

  useEffect(() => {
    if (!enabled || !api) {
      return;
    }

    const prompts = normalizeScheduledPrompts(storedPrompts);
    const duePrompts = getDueScheduledPrompts(prompts);
    const nextRunAt = getNextScheduledPromptRunAt(prompts);
    let delay = 0;
    if (duePrompts.length === 0) {
      if (nextRunAt === null) {
        return;
      }
      delay = Math.max(0, Math.min(nextRunAt - Date.now(), MAX_TIMER_DELAY_MS));
    }

    const timeout = window.setTimeout(() => {
      if (isDispatchingRef.current) {
        return;
      }

      const runnablePrompts = getDueScheduledPrompts(prompts).filter(
        (prompt) => !inFlightIdsRef.current.has(prompt.id)
      );
      if (runnablePrompts.length === 0) {
        setTimerNonce((current) => current + 1);
        return;
      }

      isDispatchingRef.current = true;

      void (async () => {
        for (const queuedPrompt of runnablePrompts) {
          if (inFlightIdsRef.current.has(queuedPrompt.id)) {
            continue;
          }

          const prompt = getCurrentRunnablePrompt(storageKey, queuedPrompt.id);
          if (!prompt) {
            continue;
          }

          inFlightIdsRef.current.add(prompt.id);
          setStoredPrompts((current) =>
            markScheduledPromptSending(normalizeScheduledPrompts(current), prompt.id)
          );

          const dispatchMode = prompt.queueDispatchMode;
          const muxMetadata: MuxMessageMetadata = {
            type: "normal",
            requestedModel: sendMessageOptions.model,
          };
          const prepared = prepareUserMessageForSend({ text: prompt.content }, muxMetadata);

          try {
            onMessageSendStarted?.(dispatchMode);
            const result = await api.workspace.sendMessage({
              workspaceId,
              message: prepared.finalText,
              options: {
                ...sendMessageOptions,
                ...(additionalSystemContext !== undefined ? { additionalSystemContext } : {}),
                queueDispatchMode: dispatchMode,
                muxMetadata: prepared.metadata,
              },
            });

            if (!result?.success) {
              const error = result?.error ? getErrorMessage(result.error) : "API not connected";
              setStoredPrompts((current) =>
                markScheduledPromptFailed(normalizeScheduledPrompts(current), prompt.id, error)
              );
              continue;
            }

            setStoredPrompts((current) =>
              markScheduledPromptSent(normalizeScheduledPrompts(current), prompt.id)
            );
            onMessageSent?.(dispatchMode);
          } catch (error) {
            setStoredPrompts((current) =>
              markScheduledPromptFailed(
                normalizeScheduledPrompts(current),
                prompt.id,
                getErrorMessage(error)
              )
            );
          } finally {
            inFlightIdsRef.current.delete(prompt.id);
          }
        }
      })().finally(() => {
        isDispatchingRef.current = false;
      });
    }, delay);

    return () => window.clearTimeout(timeout);
  }, [
    api,
    enabled,
    onMessageSendStarted,
    onMessageSent,
    additionalSystemContext,
    sendMessageOptions,
    setStoredPrompts,
    storedPrompts,
    storageKey,
    timerNonce,
    workspaceId,
  ]);
}
