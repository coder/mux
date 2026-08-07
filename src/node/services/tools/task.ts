import { randomUUID } from "node:crypto";

import { tool, type Tool } from "ai";
import type { z } from "zod";

import type { ToolConfiguration, ToolFactory } from "@/common/utils/tools/tools";
import {
  ProjectChatTaskToolArgsSchema,
  TaskToolResultSchema,
  buildProjectChatTaskToolDescription,
  buildTaskToolAgentArgsSchema,
  buildTaskToolDescription,
} from "@/common/utils/tools/toolDefinitions";
import type { TaskToolArgsSchema } from "@/common/utils/tools/toolDefinitions";
import {
  RUNTIME_MODE,
  runtimeModeSupportsSharedTaskWorkspace,
  type RuntimeMode,
} from "@/common/types/runtime";
import type { TaskCreatedEvent } from "@/common/types/stream";
import { log } from "@/node/services/log";

import { buildTaskGroupLaunches, type TaskGroupKind } from "@/common/utils/tools/taskGroups";
import {
  emitChatEventBestEffort,
  parseToolResult,
  requireTaskService,
  requireWorkspaceId,
} from "./toolUtils";
import {
  coerceThinkingLevel,
  parseThinkingInput,
  type OpenAIReasoningMode,
  type ParsedThinkingInput,
  type ThinkingLevel,
} from "@/common/types/thinking";
import { normalizeModelInput } from "@/common/utils/ai/normalizeModelInput";
import { coerceNonEmptyString } from "@/node/services/taskUtils";

// Plan agent is read-only: only `explore` sub-agent tasks may be spawned. Shared by both the
// workspace-turn guard and the per-launch agent-id guard so the message can't drift between them.
const PLAN_AGENT_EXPLORE_ONLY_ERROR =
  'In the plan agent you may only spawn agentId: "explore" tasks.';

const BUILT_IN_TASK_TOOL_MARKER = Symbol("muxBuiltInTaskTool");

export function markBuiltInTaskTool<TParameters, TResult>(
  taskTool: Tool<TParameters, TResult>
): Tool<TParameters, TResult> {
  Object.defineProperty(taskTool, BUILT_IN_TASK_TOOL_MARKER, {
    value: true,
    // enumerable so object spread (wrapWithInitWait) and descriptor clones (withHooks,
    // cloneToolPreservingDescriptors, cache control) carry the marker forward to every wrapper —
    // that is what lets sibling explore task calls share the parallel reader lock downstream.
    enumerable: true,
    configurable: true,
  });
  return taskTool;
}

export function isBuiltInTaskTool(tool: Tool | undefined): boolean {
  return Boolean(
    (tool as (Tool & Record<symbol, unknown>) | undefined)?.[BUILT_IN_TASK_TOOL_MARKER] === true
  );
}

/** Resolve the parent workspace's runtime mode from the injected MUX_RUNTIME env. */
function resolveRuntimeMode(config: ToolConfiguration): RuntimeMode | undefined {
  const runtimeValue = config.muxEnv?.MUX_RUNTIME;
  return runtimeValue != null && Object.values(RUNTIME_MODE).includes(runtimeValue as RuntimeMode)
    ? (runtimeValue as RuntimeMode)
    : undefined;
}

/**
 * Build dynamic task tool description with runtime-specific workspace visibility
 * guidance and the currently available sub-agents.
 */
function buildTaskDescription(config: ToolConfiguration): string {
  const runtimeMode = resolveRuntimeMode(config);
  const baseDescription = buildTaskToolDescription(runtimeMode);
  const subagents = config.availableSubagents?.filter((a) => a.subagentRunnable) ?? [];

  if (subagents.length === 0) {
    return baseDescription;
  }

  const subagentLines = subagents.map((agent) => {
    const desc = agent.description ? `: ${agent.description}` : "";
    return `- ${agent.id}${desc}`;
  });

  return `${baseDescription}\n\nAvailable sub-agents (use \`agentId\` parameter):\n${subagentLines.join("\n")}`;
}

function buildParentRuntimeAiSettings(
  config: ToolConfiguration
): { modelString?: string; thinkingLevel?: ThinkingLevel } | undefined {
  const modelString = coerceNonEmptyString(config.muxEnv?.MUX_MODEL_STRING);
  const thinkingLevel = coerceThinkingLevel(config.muxEnv?.MUX_THINKING_LEVEL);

  if (modelString == null && thinkingLevel == null) {
    return undefined;
  }

  return {
    ...(modelString != null ? { modelString } : {}),
    ...(thinkingLevel != null ? { thinkingLevel } : {}),
  };
}

/**
 * Parse the optional `model`/`thinking` overrides supplied on a task launch,
 * reusing the exact parsing the UI uses (`normalizeModelInput` for model alias
 * resolution; `parseThinkingInput` for named levels OR numeric indices). Numeric
 * thinking indices stay deferred as a `ParsedThinkingInput` so they resolve
 * against the sub-agent's chosen model in `resolveTaskAISettings`. Throws a
 * descriptive error on invalid input so the model can correct the call.
 */
function parseTaskAiOverrides(args: {
  model?: string | null;
  thinking?: string | null;
  reasoningMode?: OpenAIReasoningMode | null;
}): {
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
  reasoningMode?: OpenAIReasoningMode;
} {
  const overrides: {
    modelString?: string;
    thinkingLevel?: ParsedThinkingInput;
    reasoningMode?: OpenAIReasoningMode;
  } = {};

  if (args.model != null) {
    const normalized = normalizeModelInput(args.model);
    if (normalized.model == null) {
      throw new Error(
        `task tool: invalid model "${args.model}". Provide a known alias or a "provider:model" string.`
      );
    }
    overrides.modelString = normalized.model;
  }

  if (args.thinking != null) {
    const parsed = parseThinkingInput(args.thinking);
    if (parsed == null) {
      throw new Error(
        `task tool: invalid thinking "${args.thinking}". Use a level name (off, low, medium, high, xhigh, max) or a numeric index.`
      );
    }
    overrides.thinkingLevel = parsed;
  }

  if (args.reasoningMode != null) {
    overrides.reasoningMode = args.reasoningMode;
  }

  return overrides;
}

interface SpawnedTaskInfo {
  taskId: string;
  workspaceId: string;
  status: "queued" | "starting" | "running";
  groupKind?: TaskGroupKind;
  label?: string;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
}

function buildTaskGroupId(workspaceId: string, toolCallId: string | undefined): string {
  return `task-group:${workspaceId}:${toolCallId ?? randomUUID()}`;
}

function emitTaskCreatedEvent(params: {
  config: ToolConfiguration;
  workspaceId: string;
  toolCallId: string | undefined;
  taskId: string;
  taskWorkspaceId: string;
}): void {
  if (!params.config.emitChatEvent || !params.config.workspaceId || !params.toolCallId) {
    return;
  }

  emitChatEventBestEffort(
    params.config,
    {
      type: "task-created",
      workspaceId: params.workspaceId,
      toolCallId: params.toolCallId,
      taskId: params.taskId,
      taskWorkspaceId: params.taskWorkspaceId,
      timestamp: Date.now(),
    } satisfies TaskCreatedEvent,
    "task"
  );
}

function buildTaskStartNote(taskCount: number, runInBackground: boolean): string {
  if (runInBackground) {
    return taskCount === 1
      ? "Task started in background. Use task_await when its output is needed."
      : "Tasks started in background. Use task_await when their output is needed.";
  }

  return taskCount === 1
    ? "Task started with blocking attention. Use task_await to retrieve its terminal result."
    : "Tasks started with blocking attention. Use task_await to retrieve their terminal results.";
}

function buildCreatedTaskResult(params: {
  tasks: readonly SpawnedTaskInfo[];
  note: string;
  forceGrouped?: boolean;
}): z.infer<typeof TaskToolResultSchema> {
  const status = params.tasks.every((task) => task.status === "queued")
    ? "queued"
    : params.tasks.every((task) => task.status === "starting")
      ? "starting"
      : "running";

  if (params.tasks.length === 1 && !params.forceGrouped) {
    const task = params.tasks[0];
    return {
      workspaceId: task.workspaceId,
      status,
      taskId: task.taskId,
      modelString: task.modelString,
      thinkingLevel: task.thinkingLevel,
      note: params.note,
    };
  }

  return {
    status,
    taskIds: params.tasks.map((task) => task.taskId),
    tasks: params.tasks.map((task) => ({
      workspaceId: task.workspaceId,
      taskId: task.taskId,
      status: task.status,
      groupKind: task.groupKind,
      label: task.label,
      modelString: task.modelString,
      thinkingLevel: task.thinkingLevel,
    })),
    note: params.note,
  };
}

export const createTaskTool: ToolFactory = (config: ToolConfiguration) => {
  // Only advertise the `isolation` parameter on runtimes where sharing the parent checkout is
  // supported. On local runtimes the field is omitted from the schema entirely, so it never
  // enters LLM context.
  const runtimeMode = resolveRuntimeMode(config);
  const projectChat = config.projectChat === true;
  type ParsedTaskToolArgs = Omit<z.infer<typeof TaskToolArgsSchema>, "run_in_background"> & {
    run_in_background: boolean | null;
  };
  const inputSchema: z.ZodType<ParsedTaskToolArgs> = projectChat
    ? ProjectChatTaskToolArgsSchema
    : buildTaskToolAgentArgsSchema({
        includeIsolation: runtimeModeSupportsSharedTaskWorkspace(runtimeMode),
      });
  const taskTool = tool({
    description: projectChat ? buildProjectChatTaskToolDescription() : buildTaskDescription(config),
    inputSchema,
    execute: async (args, { abortSignal, toolCallId }): Promise<unknown> => {
      // Defensive: tool() should have already validated args via inputSchema,
      // but keep runtime validation here to preserve type-safety.
      const parsedArgs = inputSchema.safeParse(args);
      if (!parsedArgs.success) {
        const keys =
          args && typeof args === "object" ? Object.keys(args as Record<string, unknown>) : [];
        log.warn(
          "[task tool] Unexpected input validation failure (should have been caught by AI SDK)",
          {
            issues: parsedArgs.error.issues,
            keys,
          }
        );
        throw new Error(`task tool input validation failed: ${parsedArgs.error.message}`);
      }
      const validatedArgs = parsedArgs.data;
      if (abortSignal?.aborted) {
        throw new Error("Interrupted");
      }

      const {
        kind,
        agentId,
        subagent_type,
        prompt,
        title,
        run_in_background,
        sticky,
        n,
        variants,
        model,
        thinking,
        isolation,
        workspace,
      } = validatedArgs;
      const projectChatAi =
        projectChat && "ai" in validatedArgs
          ? (validatedArgs.ai as
              | {
                  model?: string | null;
                  thinking?: string | null;
                  reasoningMode?: OpenAIReasoningMode | null;
                }
              | null
              | undefined)
          : undefined;
      const reasoningMode =
        projectChat && "reasoningMode" in validatedArgs
          ? (validatedArgs.reasoningMode as OpenAIReasoningMode | null | undefined)
          : undefined;

      const taskKind = projectChat ? (kind ?? "workspace") : kind;
      // Strict providers represent omitted optional inputs as null. Project Chat stays
      // non-blocking unless the caller explicitly requests foreground mode with false.
      const runInBackground = projectChat
        ? (run_in_background ?? true)
        : (run_in_background ?? false);

      // Explicit per-launch model/thinking overrides. Omitted by default so delegated work
      // inherits the parent's live settings unless the caller requests an override.
      const aiOverrides = parseTaskAiOverrides({
        model: projectChatAi?.model ?? model,
        thinking: projectChatAi?.thinking ?? thinking,
        reasoningMode: projectChatAi?.reasoningMode ?? reasoningMode,
      });

      const projectChatProjectPath =
        projectChat &&
        workspace != null &&
        "projectPath" in workspace &&
        typeof workspace.projectPath === "string"
          ? workspace.projectPath
          : undefined;

      const workspaceId = requireWorkspaceId(config, "task");
      const taskService = requireTaskService(config, "task");

      const parentRuntimeAiSettings = buildParentRuntimeAiSettings(config);

      if (config.planFileOnly && taskKind === "workspace") {
        throw new Error(PLAN_AGENT_EXPLORE_ONLY_ERROR);
      }

      if (taskKind === "workspace") {
        const created = await taskService.createWorkspaceTurn({
          ownerWorkspaceId: workspaceId,
          prompt,
          title,
          experiments: config.experiments,
          ...(aiOverrides.modelString != null ? { modelString: aiOverrides.modelString } : {}),
          ...(aiOverrides.thinkingLevel != null
            ? { thinkingLevel: aiOverrides.thinkingLevel }
            : {}),
          ...(aiOverrides.reasoningMode != null
            ? { reasoningMode: aiOverrides.reasoningMode }
            : {}),
          ...(parentRuntimeAiSettings != null ? { parentRuntimeAiSettings } : {}),
          // This flag controls owner attention only; task always returns the created handle promptly.
          attentionPolicy: runInBackground ? "notify_on_terminal" : "blocking_until_terminal",
          workspace: {
            mode: workspace?.mode ?? "new",
            ...(projectChatProjectPath != null ? { projectPath: projectChatProjectPath } : {}),
            ...(workspace?.workspaceId != null ? { workspaceId: workspace.workspaceId } : {}),
            ...(workspace?.branchName != null ? { branchName: workspace.branchName } : {}),
            ...(workspace?.trunkBranch != null ? { trunkBranch: workspace.trunkBranch } : {}),
            ...(workspace?.title != null ? { title: workspace.title } : {}),
            ...(workspace?.runtimeConfig != null ? { runtimeConfig: workspace.runtimeConfig } : {}),
            ...(workspace?.queueDispatchMode != null
              ? { queueDispatchMode: workspace.queueDispatchMode }
              : {}),
            ...(workspace?.disposable != null ? { disposable: workspace.disposable } : {}),
          },
        });
        if (!created.success) {
          throw new Error(created.error);
        }

        return parseToolResult(
          TaskToolResultSchema,
          {
            status: created.data.status,
            taskId: created.data.taskId,
            workspaceId: created.data.workspaceId,
            handleKind: "workspace_turn" as const,
            modelString: created.data.modelString,
            thinkingLevel: created.data.thinkingLevel,
            reasoningMode: created.data.reasoningMode,
            note: buildTaskStartNote(1, runInBackground),
          },
          "task"
        );
      }

      const requestedAgentId =
        typeof agentId === "string" && agentId.trim().length > 0 ? agentId : subagent_type;
      if (!requestedAgentId) {
        throw new Error("task tool input validation failed: expected agent task args");
      }

      const taskGroupLaunches = buildTaskGroupLaunches({ prompt, n, variants });
      const taskGroupCount = taskGroupLaunches.length;
      const taskGroupId =
        taskGroupCount > 1 ? buildTaskGroupId(workspaceId, toolCallId) : undefined;

      // Nested task spawning is allowed and enforced via maxTaskNestingDepth in TaskService
      // (and by tool policy at/over the depth limit).

      // Plan agent is explicitly non-executing. Allow only read-only exploration tasks.
      if (config.planFileOnly && requestedAgentId !== "explore") {
        throw new Error(PLAN_AGENT_EXPLORE_ONLY_ERROR);
      }

      // Parent runtime model and thinking are forwarded as a low-priority fallback so
      // unconfigured delegated runs still inherit the parent's live model. Do not
      // restore the previous top-priority forwarding through explicit task args.
      const createdTasks: SpawnedTaskInfo[] = [];
      for (const launch of taskGroupLaunches) {
        if (abortSignal?.aborted) {
          throw new Error("Interrupted");
        }

        const created = await taskService.create({
          parentWorkspaceId: workspaceId,
          kind: "agent",
          agentId: requestedAgentId,
          // Legacy alias (persisted for older clients / on-disk compatibility).
          agentType: requestedAgentId,
          prompt: launch.prompt,
          title,
          experiments: config.experiments,
          ...(aiOverrides.modelString != null ? { modelString: aiOverrides.modelString } : {}),
          ...(aiOverrides.thinkingLevel != null
            ? { thinkingLevel: aiOverrides.thinkingLevel }
            : {}),
          ...(isolation != null ? { isolation } : {}),
          ...(sticky === true ? { sticky: true } : {}),
          ...(parentRuntimeAiSettings != null ? { parentRuntimeAiSettings } : {}),
          // This flag controls owner attention only; task always returns the created handle promptly.
          attentionPolicy: runInBackground ? "notify_on_terminal" : "blocking_until_terminal",
          bestOf:
            taskGroupId != null
              ? {
                  groupId: taskGroupId,
                  index: launch.index,
                  total: launch.total,
                  kind: launch.kind,
                  ...(launch.label ? { label: launch.label } : {}),
                }
              : undefined,
        });

        if (!created.success) {
          if (createdTasks.length > 0) {
            return parseToolResult(
              TaskToolResultSchema,
              buildCreatedTaskResult({
                tasks: createdTasks,
                note:
                  `Grouped task creation stopped after spawning ${createdTasks.length} of ${taskGroupCount} task(s): ${created.error}. ` +
                  "Use task_await on the returned task metadata before retrying, or you may duplicate work.",
                forceGrouped: taskGroupCount > 1,
              }),
              "task"
            );
          }

          throw new Error(created.error);
        }

        const task = {
          taskId: created.data.taskId,
          workspaceId: created.data.workspaceId,
          status: created.data.status,
          modelString: created.data.modelString,
          thinkingLevel: created.data.thinkingLevel,
          ...(taskGroupCount > 1 || launch.label
            ? { groupKind: launch.kind, ...(launch.label ? { label: launch.label } : {}) }
            : {}),
        } satisfies SpawnedTaskInfo;
        createdTasks.push(task);

        // UI-only signal: expose spawned taskIds as soon as the workspaces exist.
        emitTaskCreatedEvent({
          config,
          workspaceId,
          toolCallId,
          taskWorkspaceId: task.workspaceId,
          taskId: task.taskId,
        });
      }

      return parseToolResult(
        TaskToolResultSchema,
        buildCreatedTaskResult({
          tasks: createdTasks,
          note: buildTaskStartNote(createdTasks.length, runInBackground),
          forceGrouped: taskGroupCount > 1,
        }),
        "task"
      );
    },
  });
  return markBuiltInTaskTool(taskTool);
};
