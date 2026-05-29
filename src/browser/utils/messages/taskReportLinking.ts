import type { DisplayedMessage } from "@/common/types/message";

export interface LinkedTaskReport {
  taskId: string;
  reportMarkdown: string;
  title?: string;
}

export interface TaskReportLinking {
  /**
   * Completed task reports indexed by taskId.
   *
   * If the same taskId appears multiple times (multiple task_await calls), the last one
   * in the message history wins.
   */
  reportByTaskId: Map<string, LinkedTaskReport>;

  /**
   * Task IDs whose completed report should be rendered under the original `task` tool call,
   * instead of being duplicated under the corresponding `task_await` result.
   */
  suppressReportInAwaitTaskIds: Set<string>;

  /**
   * Titles from the original `task` tool call input (`args.title`), indexed by taskId.
   *
   * This is a best-effort fallback for task_await rows when the completed result omitted a title
   * (e.g. older agent_report payloads).
   */
  spawnTitleByTaskId: Map<string, string>;
}

function getTaskIdsFromToolResult(result: unknown): string[] {
  if (typeof result !== "object" || result === null) return [];

  const taskIds = new Set<string>();

  const taskId = (result as { taskId?: unknown }).taskId;
  if (typeof taskId === "string" && taskId.trim().length > 0) {
    taskIds.add(taskId.trim());
  }

  const pluralTaskIds = (result as { taskIds?: unknown }).taskIds;
  if (Array.isArray(pluralTaskIds)) {
    for (const candidate of pluralTaskIds) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        taskIds.add(candidate.trim());
      }
    }
  }

  const tasks = (result as { tasks?: unknown }).tasks;
  if (Array.isArray(tasks)) {
    for (const task of tasks) {
      if (typeof task !== "object" || task === null) continue;
      const candidate = (task as { taskId?: unknown }).taskId;
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        taskIds.add(candidate.trim());
      }
    }
  }

  return Array.from(taskIds);
}

function getTitleFromTaskToolArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  if (!("title" in args)) return null;

  const title = (args as { title?: unknown }).title;
  return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
}

/**
 * Render-time helper that links completed task reports (from `task_await`) back to the
 * original `task` tool call that spawned the background work.
 *
 * This is intentionally UI-only: it does not mutate persisted history/tool output; it just
 * helps the renderer place the final report in a more intuitive location.
 */
export function computeTaskReportLinking(messages: DisplayedMessage[]): TaskReportLinking {
  // First pass: record which taskIds have a visible `task` tool call (and capture spawn titles).
  const taskToolCallTaskIds = new Set<string>();
  const spawnTitleByTaskId = new Map<string, string>();
  for (const msg of messages) {
    if (msg.type !== "tool" || msg.toolName !== "task") continue;

    const taskIds = getTaskIdsFromToolResult(msg.result);
    if (taskIds.length === 0) continue;

    const title = getTitleFromTaskToolArgs(msg.args);
    for (const taskId of taskIds) {
      taskToolCallTaskIds.add(taskId);
      if (title) {
        spawnTitleByTaskId.set(taskId, title);
      }
    }
  }

  // Second pass: collect completed reports from `task_await` results.
  const reportByTaskId = new Map<string, LinkedTaskReport>();
  for (const msg of messages) {
    if (msg.type !== "tool" || msg.toolName !== "task_await") continue;

    const rawResult = msg.result;
    if (typeof rawResult !== "object" || rawResult === null) continue;
    if (!("results" in rawResult)) continue;

    const results = (rawResult as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;

    for (const r of results) {
      if (typeof r !== "object" || r === null) continue;

      const status = (r as { status?: unknown }).status;
      if (status !== "completed") continue;

      const taskId = (r as { taskId?: unknown }).taskId;
      if (typeof taskId !== "string" || taskId.trim().length === 0) continue;

      const reportMarkdown = (r as { reportMarkdown?: unknown }).reportMarkdown;
      if (typeof reportMarkdown !== "string") continue;

      const title = (r as { title?: unknown }).title;

      // Last-wins (history order)
      reportByTaskId.set(taskId, {
        taskId,
        reportMarkdown,
        title: typeof title === "string" ? title : undefined,
      });
    }
  }

  // If a task has both a visible spawn card and a non-empty report, suppress the report
  // duplication under `task_await`.
  const suppressReportInAwaitTaskIds = new Set<string>();
  for (const [taskId, completed] of reportByTaskId) {
    if (!taskToolCallTaskIds.has(taskId)) continue;
    if (completed.reportMarkdown.trim().length === 0) continue;

    suppressReportInAwaitTaskIds.add(taskId);
  }

  return { reportByTaskId, suppressReportInAwaitTaskIds, spawnTitleByTaskId };
}
