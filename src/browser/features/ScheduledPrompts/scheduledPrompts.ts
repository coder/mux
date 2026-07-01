import type { QueueDispatchMode } from "@/browser/features/ChatInput/types";

export type ScheduledPromptStatus = "scheduled" | "sending" | "sent" | "failed";

export interface ScheduledPrompt {
  id: string;
  content: string;
  runAt: number;
  createdAt: number;
  updatedAt: number;
  status: ScheduledPromptStatus;
  queueDispatchMode: QueueDispatchMode;
  sentAt?: number;
  error?: string;
}

export interface ScheduledPromptDraft {
  content: string;
  runAt: number;
  queueDispatchMode: QueueDispatchMode;
}

const SENDING_MANUAL_RECOVERY_MS = 30 * 60 * 1000;

function isQueueDispatchMode(value: unknown): value is QueueDispatchMode {
  return value === "tool-end" || value === "turn-end";
}

function isScheduledPromptStatus(value: unknown): value is ScheduledPromptStatus {
  return value === "scheduled" || value === "sending" || value === "sent" || value === "failed";
}

function fallbackId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createScheduledPrompt(
  draft: ScheduledPromptDraft,
  now = Date.now(),
  id: string = globalThis.crypto?.randomUUID?.() ?? fallbackId(now)
): ScheduledPrompt {
  return {
    id,
    content: draft.content.trim(),
    runAt: draft.runAt,
    createdAt: now,
    updatedAt: now,
    status: "scheduled",
    queueDispatchMode: draft.queueDispatchMode,
  };
}

export function normalizeScheduledPrompts(value: unknown): ScheduledPrompt[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const prompts: ScheduledPrompt[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const raw = item as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      typeof raw.content !== "string" ||
      raw.content.trim().length === 0 ||
      typeof raw.runAt !== "number" ||
      !Number.isFinite(raw.runAt) ||
      typeof raw.createdAt !== "number" ||
      typeof raw.updatedAt !== "number" ||
      !isScheduledPromptStatus(raw.status)
    ) {
      continue;
    }

    prompts.push({
      id: raw.id,
      content: raw.content,
      runAt: raw.runAt,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      status: raw.status,
      queueDispatchMode: isQueueDispatchMode(raw.queueDispatchMode)
        ? raw.queueDispatchMode
        : "tool-end",
      ...(typeof raw.sentAt === "number" ? { sentAt: raw.sentAt } : {}),
      ...(typeof raw.error === "string" && raw.status === "failed" ? { error: raw.error } : {}),
    });
  }

  return prompts.sort((left, right) => {
    if (left.status !== right.status) {
      const rank: Record<ScheduledPromptStatus, number> = {
        sending: 0,
        scheduled: 1,
        failed: 2,
        sent: 3,
      };
      return rank[left.status] - rank[right.status];
    }
    return left.runAt - right.runAt || left.createdAt - right.createdAt;
  });
}

export function getDueScheduledPrompts(
  prompts: readonly ScheduledPrompt[],
  now = Date.now()
): ScheduledPrompt[] {
  return prompts.filter((prompt) => prompt.status === "scheduled" && prompt.runAt <= now);
}

export function getNextScheduledPromptRunAt(prompts: readonly ScheduledPrompt[]): number | null {
  const scheduled = prompts.filter((prompt) => prompt.status === "scheduled");
  if (scheduled.length === 0) {
    return null;
  }
  return Math.min(...scheduled.map((prompt) => prompt.runAt));
}

export function canRunScheduledPromptNow(prompt: ScheduledPrompt, now = Date.now()): boolean {
  return (
    prompt.status === "scheduled" ||
    prompt.status === "failed" ||
    (prompt.status === "sending" && prompt.updatedAt <= now - SENDING_MANUAL_RECOVERY_MS)
  );
}

export function markScheduledPromptSending(
  prompts: readonly ScheduledPrompt[],
  id: string,
  now = Date.now()
): ScheduledPrompt[] {
  return prompts.map((prompt) =>
    prompt.id === id ? { ...prompt, status: "sending", updatedAt: now, error: undefined } : prompt
  );
}

export function markScheduledPromptSent(
  prompts: readonly ScheduledPrompt[],
  id: string,
  now = Date.now()
): ScheduledPrompt[] {
  return prompts.map((prompt) =>
    prompt.id === id
      ? { ...prompt, status: "sent", sentAt: now, updatedAt: now, error: undefined }
      : prompt
  );
}

export function markScheduledPromptFailed(
  prompts: readonly ScheduledPrompt[],
  id: string,
  error: string,
  now = Date.now()
): ScheduledPrompt[] {
  return prompts.map((prompt) =>
    prompt.id === id ? { ...prompt, status: "failed", error, updatedAt: now } : prompt
  );
}

export function reschedulePromptNow(
  prompts: readonly ScheduledPrompt[],
  id: string,
  now = Date.now()
): ScheduledPrompt[] {
  return prompts.map((prompt) =>
    prompt.id === id
      ? { ...prompt, status: "scheduled", runAt: now, updatedAt: now, error: undefined }
      : prompt
  );
}

export function removeScheduledPrompt(
  prompts: readonly ScheduledPrompt[],
  id: string
): ScheduledPrompt[] {
  return prompts.filter((prompt) => prompt.id !== id);
}

export function formatDateTimeLocalInput(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

export function parseDateTimeLocalInput(value: string): number | null {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}
