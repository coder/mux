import { useEffect, useRef, useState } from "react";
import type { APIClient } from "@/browser/contexts/API";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import { getScheduledPromptsKey } from "@/common/constants/storage";
import { prepareUserMessageForSend, type MuxMessageMetadata } from "@/common/types/message";
import type { SendMessageOptions } from "@/common/orpc/types";
import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";
import type { SendMessageError } from "@/common/types/errors";
import { formatSendMessageError } from "@/common/utils/errors/formatSendError";
import {
  getDueScheduledPrompts,
  getNextScheduledPromptRunAt,
  markScheduledPromptFailed,
  markScheduledPromptSent,
  normalizeScheduledPrompts,
  type ScheduledPrompt,
} from "./scheduledPrompts";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DISPATCH_LOCK_TTL_MS = 5 * 60 * 1000;
const DISPATCH_LOCK_RETRY_DELAY_MS = 1_000;
const SEND_MESSAGE_ERROR_TYPES = new Set<string>([
  "api_key_not_found",
  "oauth_not_connected",
  "provider_disabled",
  "provider_not_supported",
  "model_not_available",
  "invalid_model_string",
  "incompatible_workspace",
  "runtime_not_ready",
  "runtime_start_failed",
  "policy_denied",
  "unknown",
]);

interface ScheduledDispatchLock {
  ownerId: string;
  expiresAt: number;
}

interface LockManagerLike {
  request<T>(
    name: string,
    options: { ifAvailable: true; mode: "exclusive" },
    callback: (lock: object | null) => T | Promise<T>
  ): Promise<T>;
}

interface ScheduledPromptDispatcherOptions {
  api: APIClient | null;
  workspaceId: string;
  sendMessageOptions: SendMessageOptions;
  additionalSystemContext?: string;
  enabled: boolean;
  onMessageSendStarted?: (dispatchMode: QueueDispatchMode) => void;
  onMessageSent?: (dispatchMode: QueueDispatchMode) => void;
}

function createDispatcherOwnerId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function getDispatchLockKey(storageKey: string): string {
  return `${storageKey}:dispatch-lock`;
}

function readDispatchLock(raw: string | null): ScheduledDispatchLock | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ScheduledDispatchLock>;
    if (
      typeof parsed.ownerId === "string" &&
      typeof parsed.expiresAt === "number" &&
      Number.isFinite(parsed.expiresAt)
    ) {
      return {
        ownerId: parsed.ownerId,
        expiresAt: parsed.expiresAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

function tryAcquireDispatchLock(lockKey: string, ownerId: string): boolean {
  if (typeof window === "undefined" || !window.localStorage) {
    return true;
  }

  try {
    const now = Date.now();
    const currentLock = readDispatchLock(window.localStorage.getItem(lockKey));
    if (currentLock && currentLock.ownerId !== ownerId && currentLock.expiresAt > now) {
      return false;
    }

    const nextLock: ScheduledDispatchLock = {
      ownerId,
      expiresAt: now + DISPATCH_LOCK_TTL_MS,
    };
    window.localStorage.setItem(lockKey, JSON.stringify(nextLock));

    return readDispatchLock(window.localStorage.getItem(lockKey))?.ownerId === ownerId;
  } catch {
    return true;
  }
}

function releaseDispatchLock(lockKey: string, ownerId: string): void {
  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    const currentLock = readDispatchLock(window.localStorage.getItem(lockKey));
    if (!currentLock || currentLock.ownerId === ownerId) {
      window.localStorage.removeItem(lockKey);
    }
  } catch {
    // Ignore storage failures; the lock expires automatically.
  }
}

function getBrowserLockManager(): LockManagerLike | undefined {
  if (typeof window === "undefined" || !window.navigator) {
    return undefined;
  }

  const maybeNavigator = window.navigator as Navigator & { locks?: LockManagerLike };
  if (typeof maybeNavigator.locks?.request !== "function") {
    return undefined;
  }
  return maybeNavigator.locks;
}

async function runWithDispatchLock(
  lockKey: string,
  ownerId: string,
  callback: () => Promise<void>
): Promise<boolean> {
  const lockManager = getBrowserLockManager();
  if (lockManager) {
    return lockManager.request(lockKey, { ifAvailable: true, mode: "exclusive" }, async (lock) => {
      if (!lock) {
        return false;
      }
      await callback();
      return true;
    });
  }

  if (!tryAcquireDispatchLock(lockKey, ownerId)) {
    return false;
  }

  try {
    await callback();
    return true;
  } finally {
    releaseDispatchLock(lockKey, ownerId);
  }
}

function isSendMessageError(error: unknown): error is SendMessageError {
  if (typeof error !== "object" || error === null || !("type" in error)) {
    return false;
  }
  const type = (error as { type?: unknown }).type;
  return typeof type === "string" && SEND_MESSAGE_ERROR_TYPES.has(type);
}

function getErrorMessage(error: unknown): string {
  if (isSendMessageError(error)) {
    const formatted = formatSendMessageError(error);
    return [formatted.message, formatted.resolutionHint].filter(Boolean).join(" ");
  }

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

function claimCurrentRunnablePrompt(storageKey: string, promptId: string): ScheduledPrompt | null {
  const claimedAt = Date.now();
  let claimedPrompt: ScheduledPrompt | null = null;

  updatePersistedState<ScheduledPrompt[]>(
    storageKey,
    (current) => {
      const prompts = normalizeScheduledPrompts(current);
      const prompt = getDueScheduledPrompts(prompts).find((candidate) => candidate.id === promptId);
      if (!prompt) {
        return prompts;
      }

      const nextPrompt: ScheduledPrompt = {
        ...prompt,
        status: "sending",
        updatedAt: claimedAt,
        error: undefined,
      };
      claimedPrompt = nextPrompt;
      return prompts.map((candidate) => (candidate.id === promptId ? nextPrompt : candidate));
    },
    []
  );

  if (!claimedPrompt) {
    return null;
  }

  const storedPrompt = normalizeScheduledPrompts(
    readPersistedState<ScheduledPrompt[]>(storageKey, [])
  ).find((prompt) => prompt.id === promptId);

  if (storedPrompt?.status !== "sending" || storedPrompt.updatedAt !== claimedAt) {
    return null;
  }

  return claimedPrompt;
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
  const dispatcherOwnerIdRef = useRef(createDispatcherOwnerId());
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
      const lockKey = getDispatchLockKey(storageKey);
      const ownerId = dispatcherOwnerIdRef.current;

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

      void (async () => {
        const acquired = await runWithDispatchLock(lockKey, ownerId, async () => {
          isDispatchingRef.current = true;
          try {
            for (const queuedPrompt of runnablePrompts) {
              if (inFlightIdsRef.current.has(queuedPrompt.id)) {
                continue;
              }

              const prompt = claimCurrentRunnablePrompt(storageKey, queuedPrompt.id);
              if (!prompt) {
                continue;
              }

              inFlightIdsRef.current.add(prompt.id);

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
          } finally {
            isDispatchingRef.current = false;
          }
        });

        if (!acquired) {
          window.setTimeout(
            () => setTimerNonce((current) => current + 1),
            DISPATCH_LOCK_RETRY_DELAY_MS
          );
        }
      })().catch((error) => {
        console.error("scheduled prompt dispatcher failed", error);
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
