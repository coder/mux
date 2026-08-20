import { resolveShuxEnvironmentValue } from "@/common/compat/legacyMux";

export function taskQueueDebug(message: string, details?: Record<string, unknown>): void {
  if (resolveShuxEnvironmentValue("DEBUG_TASK_QUEUE", process.env) !== "1") return;
  console.log(`[task-queue] ${message}`, details ?? {});
}
