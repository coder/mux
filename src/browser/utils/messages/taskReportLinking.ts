import type { DisplayedMessage } from "@/common/types/message";
import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";

export interface LinkedTaskReport {
  taskId: string;
  workspaceId?: string;
  reportMarkdown: string;
  title?: string;
  // Report-time AI settings: fresher than the spawn result when a plan child
  // handed off to exec after launch.
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

export interface BashTaskSpawnInfo {
  script: string;
  modelIntent?: string;
}

export interface TaskReportLinking {
  /** Canonical report linkage for current task results. */
  reportByWorkspaceId: Map<string, LinkedTaskReport>;
  /** Legacy report linkage for historical results that have no workspaceId. */
  reportByTaskId: Map<string, LinkedTaskReport>;

  /** Canonical workspace IDs whose report is already shown on the spawning execution card. */
  suppressReportInAwaitWorkspaceIds: Set<string>;
  /** Legacy task IDs whose report is already shown on the spawning execution card. */
  suppressReportInAwaitTaskIds: Set<string>;

  /** Spawn titles indexed by canonical workspaceId for current task results. */
  spawnTitleByWorkspaceId: Map<string, string>;
  /** Legacy spawn titles indexed by taskId. */
  spawnTitleByTaskId: Map<string, string>;

  /** Spawn agent types indexed by canonical workspaceId for current task results. */
  spawnAgentTypeByWorkspaceId: Map<string, string>;
  /** Legacy spawn agent types indexed by taskId. */
  spawnAgentTypeByTaskId: Map<string, string>;

  /**
   * Spawn args of background `bash` tool calls, indexed by taskId. Lets task_await rows
   * surface the spawning command's model_intent, which task_await results do not carry.
   */
  bashSpawnByTaskId: Map<string, BashTaskSpawnInfo>;
}

interface TaskExecutionRef {
  taskId: string;
  workspaceId?: string;
}

function getTaskExecutionRefs(result: unknown): TaskExecutionRef[] {
  if (typeof result !== "object" || result === null) return [];

  const refs = new Map<string, TaskExecutionRef>();
  const remember = (taskIdValue: unknown, workspaceIdValue?: unknown): void => {
    if (typeof taskIdValue !== "string" || taskIdValue.trim().length === 0) return;
    const taskId = taskIdValue.trim();
    const workspaceId =
      typeof workspaceIdValue === "string" && workspaceIdValue.trim().length > 0
        ? workspaceIdValue.trim()
        : undefined;
    const existing = refs.get(taskId);
    refs.set(taskId, workspaceId ? { taskId, workspaceId } : (existing ?? { taskId }));
  };

  remember(
    (result as { taskId?: unknown }).taskId,
    (result as { workspaceId?: unknown }).workspaceId
  );

  const pluralTaskIds = (result as { taskIds?: unknown }).taskIds;
  if (Array.isArray(pluralTaskIds)) {
    for (const taskId of pluralTaskIds) remember(taskId);
  }

  for (const key of ["tasks", "reports"] as const) {
    const entries = (result as Record<typeof key, unknown>)[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      remember(
        (entry as { taskId?: unknown }).taskId,
        (entry as { workspaceId?: unknown }).workspaceId
      );
    }
  }

  return Array.from(refs.values());
}

function getTitleFromTaskToolArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;
  if (!("title" in args)) return null;

  const title = (args as { title?: unknown }).title;
  return typeof title === "string" && title.trim().length > 0 ? title.trim() : null;
}

function getAgentTypeFromTaskToolArgs(args: unknown): string | null {
  if (typeof args !== "object" || args === null) return null;

  const candidates = [
    (args as { agentId?: unknown }).agentId,
    (args as { subagent_type?: unknown }).subagent_type,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

// Only background bash spawn results carry a taskId, so its presence identifies them.
function getBashSpawnTaskId(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;

  const taskId = (result as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId.trim().length > 0 ? taskId.trim() : null;
}

function getBashSpawnInfoFromArgs(args: unknown): BashTaskSpawnInfo | null {
  if (typeof args !== "object" || args === null) return null;

  const { script, model_intent } = args as {
    script?: unknown;
    model_intent?: unknown;
  };
  const modelIntent =
    typeof model_intent === "string" && model_intent.trim().length > 0
      ? model_intent.trim()
      : undefined;
  if (modelIntent === undefined) return null;

  return {
    script: typeof script === "string" ? script : "",
    modelIntent,
  };
}

/**
 * Render-time helper that links completed task reports (from `task_await`) back to the
 * original `task` tool call that spawned the background work.
 *
 * This is intentionally UI-only: it does not mutate persisted history/tool output; it just
 * helps the renderer place the final report in a more intuitive location.
 */
export function computeTaskReportLinking(messages: DisplayedMessage[]): TaskReportLinking {
  const taskToolCallWorkspaceIds = new Set<string>();
  const legacyTaskToolCallTaskIds = new Set<string>();
  const spawnTitleByWorkspaceId = new Map<string, string>();
  const spawnTitleByTaskId = new Map<string, string>();
  const spawnAgentTypeByWorkspaceId = new Map<string, string>();
  const spawnAgentTypeByTaskId = new Map<string, string>();
  const bashSpawnByTaskId = new Map<string, BashTaskSpawnInfo>();

  for (const msg of messages) {
    if (msg.type !== "tool") continue;

    if (msg.toolName === "bash") {
      const taskId = getBashSpawnTaskId(msg.result);
      const spawnInfo = taskId ? getBashSpawnInfoFromArgs(msg.args) : null;
      if (taskId && spawnInfo) bashSpawnByTaskId.set(taskId, spawnInfo);
      continue;
    }

    if (msg.toolName !== "task") continue;

    const executionRefs = getTaskExecutionRefs(msg.result);
    const title = getTitleFromTaskToolArgs(msg.args);
    const agentType = getAgentTypeFromTaskToolArgs(msg.args);
    for (const executionRef of executionRefs) {
      if (executionRef.workspaceId) {
        taskToolCallWorkspaceIds.add(executionRef.workspaceId);
        if (title) spawnTitleByWorkspaceId.set(executionRef.workspaceId, title);
        if (agentType) spawnAgentTypeByWorkspaceId.set(executionRef.workspaceId, agentType);
        continue;
      }

      // Historical results did not expose canonical workspaceId, so keep taskId linking only
      // for those persisted transcripts.
      legacyTaskToolCallTaskIds.add(executionRef.taskId);
      if (title) spawnTitleByTaskId.set(executionRef.taskId, title);
      if (agentType) spawnAgentTypeByTaskId.set(executionRef.taskId, agentType);
    }
  }

  const reportByWorkspaceId = new Map<string, LinkedTaskReport>();
  const reportByTaskId = new Map<string, LinkedTaskReport>();
  for (const msg of messages) {
    if (msg.type !== "tool" || msg.toolName !== "task_await") continue;

    const rawResult = msg.result;
    if (typeof rawResult !== "object" || rawResult === null || !("results" in rawResult)) continue;
    const results = (rawResult as { results?: unknown }).results;
    if (!Array.isArray(results)) continue;

    for (const result of results) {
      if (typeof result !== "object" || result === null) continue;
      if ((result as { status?: unknown }).status !== "completed") continue;

      const taskIdValue = (result as { taskId?: unknown }).taskId;
      const reportMarkdown = (result as { reportMarkdown?: unknown }).reportMarkdown;
      if (typeof taskIdValue !== "string" || taskIdValue.trim().length === 0) continue;
      if (typeof reportMarkdown !== "string") continue;

      const taskId = taskIdValue.trim();
      const workspaceIdValue = (result as { workspaceId?: unknown }).workspaceId;
      const workspaceId =
        typeof workspaceIdValue === "string" && workspaceIdValue.trim().length > 0
          ? workspaceIdValue.trim()
          : undefined;
      const title = (result as { title?: unknown }).title;
      const modelString = (result as { modelString?: unknown }).modelString;
      const thinkingLevel = (result as { thinkingLevel?: unknown }).thinkingLevel;
      const linkedReport: LinkedTaskReport = {
        taskId,
        workspaceId,
        reportMarkdown,
        title: typeof title === "string" ? title : undefined,
        modelString:
          typeof modelString === "string" && modelString.trim().length > 0
            ? modelString
            : undefined,
        thinkingLevel:
          typeof thinkingLevel === "string" &&
          (THINKING_LEVELS as readonly string[]).includes(thinkingLevel)
            ? (thinkingLevel as ThinkingLevel)
            : undefined,
      };

      // Canonical results never depend on the opaque execution ID for UI linkage.
      if (workspaceId) reportByWorkspaceId.set(workspaceId, linkedReport);
      else reportByTaskId.set(taskId, linkedReport);
    }
  }

  const suppressReportInAwaitWorkspaceIds = new Set<string>();
  for (const [workspaceId, completed] of reportByWorkspaceId) {
    if (taskToolCallWorkspaceIds.has(workspaceId) && completed.reportMarkdown.trim().length > 0) {
      suppressReportInAwaitWorkspaceIds.add(workspaceId);
    }
  }

  const suppressReportInAwaitTaskIds = new Set<string>();
  for (const [taskId, completed] of reportByTaskId) {
    if (legacyTaskToolCallTaskIds.has(taskId) && completed.reportMarkdown.trim().length > 0) {
      suppressReportInAwaitTaskIds.add(taskId);
    }
  }

  return {
    reportByWorkspaceId,
    reportByTaskId,
    suppressReportInAwaitWorkspaceIds,
    suppressReportInAwaitTaskIds,
    spawnTitleByWorkspaceId,
    spawnTitleByTaskId,
    spawnAgentTypeByWorkspaceId,
    spawnAgentTypeByTaskId,
    bashSpawnByTaskId,
  };
}
