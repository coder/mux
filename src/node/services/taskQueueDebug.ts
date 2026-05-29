export function taskQueueDebug(message: string, details?: Record<string, unknown>): void {
  if (process.env.MUX_DEBUG_TASK_QUEUE !== "1") return;
  console.log(`[task-queue] ${message}`, details ?? {});
}
