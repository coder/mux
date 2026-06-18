import assert from "node:assert/strict";
import * as fsPromises from "fs/promises";

import type { z } from "zod";

import { MutexMap } from "@/node/utils/concurrency/mutexMap";
import { AsyncMutex } from "@/node/utils/concurrency/asyncMutex";
import type { Config, ProjectsConfig, Workspace as WorkspaceConfigEntry } from "@/node/config";
import type { AIService } from "@/node/services/aiService";
import type { WorkspaceService } from "@/node/services/workspaceService";
import type { HistoryService } from "@/node/services/historyService";
import type { InitStateManager } from "@/node/services/initStateManager";
import { log } from "@/node/services/log";
import {
  discoverAgentDefinitions,
  getSkipScopesAboveForKnownScope,
  readAgentDefinition,
  resolveAgentFrontmatter,
} from "@/node/services/agentDefinitions/agentDefinitionsService";
import { resolveAgentInheritanceChain } from "@/node/services/agentDefinitions/resolveAgentInheritanceChain";
import { isAgentEffectivelyDisabled } from "@/node/services/agentDefinitions/agentEnablement";
import { orchestrateFork } from "@/node/services/utils/forkOrchestrator";
import {
  createRuntimeContextForWorkspace,
  createRuntimeForWorkspace,
} from "@/node/runtime/runtimeHelpers";
import { MultiProjectRuntime } from "@/node/runtime/multiProjectRuntime";
import { runBackgroundInit } from "@/node/runtime/runtimeFactory";
import type { InitLogger, Runtime } from "@/node/runtime/Runtime";
import { readPlanFile } from "@/node/utils/runtime/helpers";
import {
  coerceNonEmptyString,
  tryReadGitHeadCommitSha,
  findWorkspaceEntry,
} from "@/node/services/taskUtils";
import { validateWorkspaceName } from "@/common/utils/validation/workspaceValidation";
import {
  TASK_GROUP_KIND,
  getTaskGroupCount,
  normalizeTaskGroupKind,
  normalizeTaskGroupLabel,
  type TaskGroupKind,
} from "@/common/utils/tools/taskGroups";
import { stripTrailingSlashes } from "@/node/utils/pathUtils";
import { Ok, Err, type Result } from "@/common/types/result";
import {
  DEFAULT_TASK_SETTINGS,
  normalizeTaskSettings,
  type TaskSettings,
} from "@/common/types/tasks";

import { createMuxMessage, type MuxMessage, type MuxMessageMetadata } from "@/common/types/message";
import {
  createCompactionSummaryMessageId,
  createTaskFailureMessageId,
  createTaskReportMessageId,
} from "@/node/services/utils/messageIds";
import { defaultModel, normalizeToCanonical } from "@/common/utils/ai/models";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import { runtimeModeSupportsSharedTaskWorkspace, type RuntimeConfig } from "@/common/types/runtime";
import type { ProjectRef, WorkspaceMetadata } from "@/common/types/workspace";
import { getRuntimeType } from "@/node/runtime/initHook";
import { AgentIdSchema } from "@/common/orpc/schemas";
import {
  normalizeAgentId,
  resolvePersistedAgentId,
  resolvePersistedAgentIdCandidates,
} from "@/common/utils/agentIds";
import { GitPatchArtifactService } from "@/node/services/gitPatchArtifactService";
import { getWorkspaceProjectRepos } from "@/node/services/workspaceProjectRepos";
import type { SessionUsageService } from "@/node/services/sessionUsageService";
import type { WorkspaceGoalService } from "@/node/services/workspaceGoalService";
import { getTotalCost, sumUsageHistory } from "@/common/utils/tokens/usageAggregator";
import type { ParsedThinkingInput, ThinkingLevel } from "@/common/types/thinking";
import type { ErrorEvent, StreamAbortEvent, StreamEndEvent } from "@/common/types/stream";
import {
  isActiveWorkflowRunStatus,
  isTerminalWorkflowRunStatus,
  type WorkflowRunStatus,
} from "@/common/types/workflow";
import { isDynamicToolPart, type DynamicToolPart } from "@/common/types/toolParts";
import {
  isWorkflowDisplayOnlyMessage,
  isWorkflowRunEmittingToolName,
} from "@/common/utils/workflowRunMessages";
import {
  AgentReportInlineToolArgsSchema,
  AgentReportSubmittedReportSchema,
  AgentReportWorkflowInlineToolArgsSchema,
  TaskToolResultSchema,
  TaskToolArgsSchema,
  type TaskIsolation,
} from "@/common/utils/tools/toolDefinitions";
import { isPlanLikeInResolvedChain } from "@/common/utils/agentTools";
import { formatSendMessageError } from "@/node/services/utils/sendMessageError";
import { enforceThinkingPolicy, resolveThinkingInput } from "@/common/utils/thinking/policy";
import { taskQueueDebug } from "@/node/services/taskQueueDebug";
import { readSubagentGitPatchArtifact } from "@/node/services/subagentGitPatchArtifacts";
import {
  readSubagentReportArtifact,
  readSubagentReportArtifactsFile,
  upsertSubagentReportArtifact,
} from "@/node/services/subagentReportArtifacts";
import {
  readSubagentFailureArtifact,
  readSubagentFailureArtifactsFile,
  upsertSubagentFailureArtifact,
} from "@/node/services/subagentFailureArtifacts";
import { secretsToRecord, type ExternalSecretResolver } from "@/common/types/secrets";
import { getErrorMessage } from "@/common/utils/errors";
import { isNonRetryableStreamError } from "@/common/utils/messages/retryEligibility";
import type { StreamErrorType } from "@/common/types/errors";
import { hasCompletedAgentReport } from "@/common/utils/agentTaskCompletion";
import { isWorkspaceArchived } from "@/common/utils/archive";
import { CONTEXT_BOUNDARY_KINDS } from "@/common/constants/contextBoundary";
import { WorkflowRunStore } from "@/node/services/workflows/WorkflowRunStore";
import {
  TaskHandleStore,
  WORKSPACE_TURN_TASK_ID_PREFIX,
  isWorkspaceTurnTaskId,
  type WorkspaceTurnFinalMessageRef,
  type WorkspaceTurnTaskHandleRecord,
  type WorkspaceTurnTaskStatus,
} from "@/node/services/taskHandleStore";
import { readAgentWorkflowRunReferences } from "@/node/services/agentWorkflowRunReferences";
import { isWorkflowRunTaskId } from "@/node/services/tools/taskId";
import {
  formatJsonSchemaValidationErrors,
  validateJsonSchemaSubset,
  validateJsonSchemaSubsetSchema,
} from "@/common/utils/jsonSchemaSubset";

export type TaskKind = "agent";

export type AgentTaskStatus = NonNullable<WorkspaceConfigEntry["taskStatus"]>;

/**
 * Resolved per-agent AI settings (canonical model + optional thinking level).
 *
 * `thinkingLevel` is optional because internal callers read these settings off of
 * partial workspace metadata where the field may be missing on older entries.
 */
interface ResolvedWorkspaceAiSettings {
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface AgentTaskStatusLookup {
  exists: boolean;
  taskStatus: AgentTaskStatus | null;
}

export interface AgentTaskTimestamps {
  createdAt?: string;
  reportedAt?: string;
}

export interface TaskCreateArgs {
  parentWorkspaceId: string;
  kind: TaskKind;
  /** Preferred identifier (matches agent definition id). */
  agentId?: string;
  /** @deprecated Legacy alias for agentId (kept for on-disk compatibility). */
  agentType?: string;
  prompt: string;
  /** Human-readable title for the task (displayed in sidebar) */
  title: string;
  modelString?: string;
  /**
   * Explicit thinking override. Named levels apply directly; a numeric index is
   * deferred (ParsedThinkingInput) and resolved against the chosen model's policy
   * in resolveTaskAISettings, mirroring the UI's `/model+level` semantics.
   */
  thinkingLevel?: ParsedThinkingInput;
  /**
   * Workspace isolation for this task. "none" runs the sub-agent directly in the parent
   * workspace's checkout (shared working tree, no fork) on runtimes that support it; defaults to
   * "fork" (isolated copy) when omitted. Ignored (treated as "fork") on unsupported runtimes.
   */
  isolation?: TaskIsolation;
  parentRuntimeAiSettings?: { modelString?: string; thinkingLevel?: ThinkingLevel };
  /**
   * Model-refusal policy persisted on the child workspace. "fail" opts the task
   * out of configured model-fallback chains so a refusal settles terminally
   * (workflow verifier steps demand honest failure). Defaults to "fallback".
   */
  onRefusal?: "fail" | "fallback";
  /** Shared grouping metadata when one tool call spawns multiple sibling tasks. */
  bestOf?: {
    groupId: string;
    index: number;
    total: number;
    kind?: TaskGroupKind;
    label?: string;
  };
  workflowTask?: {
    runId: string;
    stepId: string;
    workflowName?: string;
    outputSchema?: unknown;
  };
  /** Experiments to inherit to subagent */
  experiments?: {
    programmaticToolCalling?: boolean;
    programmaticToolCallingExclusive?: boolean;
    advisorTool?: boolean;
    execSubagentHardRestart?: boolean;
    dynamicWorkflows?: boolean;
  };
}

function stringifyStructuredOutputForSubagentReport(structuredOutput: unknown): string {
  const json = JSON.stringify(structuredOutput, null, 2);
  assert(
    json !== undefined,
    "stringifyStructuredOutputForSubagentReport requires JSON-serializable structured output"
  );
  return json;
}

function formatSubagentReportUserMessage(params: {
  childWorkspaceId: string;
  agentType: string;
  title: string;
  reportMarkdown: string;
  structuredOutput?: unknown;
}): string {
  assert(params.childWorkspaceId.length > 0, "subagent report message requires child id");
  assert(params.agentType.length > 0, "subagent report message requires agent type");
  assert(params.title.length > 0, "subagent report message requires title");
  assert(params.reportMarkdown.length > 0, "subagent report message requires markdown");

  const lines = [
    "<mux_subagent_report>",
    `<task_id>${params.childWorkspaceId}</task_id>`,
    `<agent_type>${params.agentType}</agent_type>`,
    `<title>${params.title}</title>`,
    "<report_markdown>",
    params.reportMarkdown,
    "</report_markdown>",
  ];

  if (params.structuredOutput !== undefined) {
    lines.push(
      "<structured_output_json>",
      "```json",
      stringifyStructuredOutputForSubagentReport(params.structuredOutput),
      "```",
      "</structured_output_json>"
    );
  }

  lines.push("</mux_subagent_report>");
  return lines.join("\n");
}

// Failure twin of formatSubagentReportUserMessage: terminal child failures are
// delivered into the parent context as an explicit failure block (never as a
// report) so a later wake-up — by ANY sibling's settlement — cannot present the
// fanout as fully successful.
function formatSubagentFailureUserMessage(params: {
  childWorkspaceId: string;
  agentType: string;
  errorType: string;
  errorMessage: string;
}): string {
  assert(params.childWorkspaceId.length > 0, "subagent failure message requires child id");
  assert(params.agentType.length > 0, "subagent failure message requires agent type");
  assert(params.errorMessage.length > 0, "subagent failure message requires error message");

  return [
    "<mux_subagent_failure>",
    `<task_id>${params.childWorkspaceId}</task_id>`,
    `<agent_type>${params.agentType}</agent_type>`,
    `<error_type>${params.errorType}</error_type>`,
    "<error_message>",
    params.errorMessage,
    "</error_message>",
    "This sub-agent task failed terminally and will not produce a report. Do not re-await it.",
    "</mux_subagent_failure>",
  ].join("\n");
}

// Completed background reports are already persisted into the parent context; asking the parent
// to call task_await burns an extra model/tool turn before it can synthesize the final answer.
const COMPLETED_BACKGROUND_SUBAGENT_HANDOFF_PROMPT =
  "Background sub-agent task(s) have completed. Their accepted reports and any structured outputs " +
  "are already injected into this workspace context as task tool results or synthetic user report " +
  "messages. Write the final response now, integrating those results. If a required report appears " +
  "missing, explain the missing context instead of waiting for another handoff.";

// Failure twin of COMPLETED_BACKGROUND_SUBAGENT_HANDOFF_PROMPT: the failure details
// were already appended to the parent context as synthetic mux_subagent_failure
// messages, so the wake-up prompt itself stays generic.
const FAILED_BACKGROUND_SUBAGENT_HANDOFF_PROMPT =
  "Background sub-agent task(s) failed terminally and will not produce reports. The failure " +
  "details are already injected into this workspace context as synthetic user messages. Do not " +
  "re-await those tasks. Integrate the failures into your work now: adjust your approach (e.g. a " +
  "different model, agent, or task design) or surface the failures in your response.";

function getTaskCompletionInstruction(params: {
  completionToolName: "agent_report" | "propose_plan";
}): string {
  if (params.completionToolName === "propose_plan") {
    return "Call propose_plan exactly once now. Base it only on the planning work already completed in this workspace.";
  }

  return "Call agent_report exactly once now with your final report. Base it only on the work already completed in this workspace.";
}

type AgentReportFinalizationResult =
  | { finalized: true }
  | {
      finalized: false;
      reason: "invalid_structured_output" | "terminal_interrupted";
      message: string;
    };

function formatStructuredOutputValidationMessage(params: {
  workflowTask: NonNullable<WorkspaceConfigEntry["workflowTask"]>;
  errors: Array<{ path: string; message: string }>;
}): string {
  const stepLabel = params.workflowTask.stepId
    ? ` for workflow step ${params.workflowTask.stepId}`
    : "";
  const errorSummary = formatJsonSchemaValidationErrors(params.errors, { maxErrors: 5 });
  return `agent_report structuredOutput failed schema validation${stepLabel}: ${errorSummary}`;
}

function validateWorkflowAgentReportStructuredOutput(params: {
  workflowTask?: WorkspaceConfigEntry["workflowTask"];
  reportArgs: { structuredOutput?: unknown };
  allowLegacyInvalidOutputSchema: boolean;
}): string | null {
  const workflowTask = params.workflowTask;
  if (workflowTask?.outputSchema === undefined) {
    return null;
  }

  if (params.allowLegacyInvalidOutputSchema) {
    const schemaValidation = validateJsonSchemaSubsetSchema(workflowTask.outputSchema);
    if (!schemaValidation.success) {
      return null;
    }
  }

  if (
    !Object.hasOwn(params.reportArgs, "structuredOutput") ||
    params.reportArgs.structuredOutput === undefined
  ) {
    return formatStructuredOutputValidationMessage({
      workflowTask,
      errors: [{ path: "$.structuredOutput", message: "Required property is missing" }],
    });
  }

  const validation = validateJsonSchemaSubset(
    workflowTask.outputSchema,
    params.reportArgs.structuredOutput
  );
  if (validation.success) {
    return null;
  }

  return formatStructuredOutputValidationMessage({
    workflowTask,
    errors: validation.errors,
  });
}

export interface WorkspaceTurnCreateArgs {
  ownerWorkspaceId: string;
  prompt: string;
  title: string;
  modelString?: string;
  thinkingLevel?: ParsedThinkingInput;
  parentRuntimeAiSettings?: { modelString?: string; thinkingLevel?: ThinkingLevel };
  workspace?: {
    mode?: "new" | "fork" | "existing";
    workspaceId?: string;
    branchName?: string;
    trunkBranch?: string;
    disposable?: boolean;
  };
  experiments?: TaskCreateArgs["experiments"];
}

export interface WorkspaceTurnCreateResult {
  taskId: string;
  kind: "workspace_turn";
  status: "starting" | "running";
  workspaceId: string;
}

export interface WorkspaceTurnWaitResult {
  taskId: string;
  workspaceId: string;
  reportMarkdown: string;
  title?: string;
  messageId?: string;
  finalMessageRef?: WorkspaceTurnFinalMessageRef;
}

type WorkspaceTurnMuxMetadata = Extract<MuxMessageMetadata, { type: "workspace-turn-task" }>;

interface BackgroundableForegroundWaiter {
  taskId: string;
  reject: (error: Error) => void;
  cleanup: () => void;
  requestingWorkspaceId?: string;
  backgroundOnMessageQueued: boolean;
}

interface WorkspaceTurnWaiter extends BackgroundableForegroundWaiter {
  handleId: string;
  resolve: (result: WorkspaceTurnWaitResult) => void;
}

export interface TaskCreateResult {
  taskId: string;
  kind: TaskKind;
  status: "queued" | "starting" | "running";
}

type TaskLaunchStart = { kind: "sendMessage"; prompt: string } | { kind: "resumeStream" };

interface TaskLaunchPlan {
  taskId: string;
  parentWorkspaceId: string;
  parentMeta: WorkspaceMetadata;
  agentId: string;
  agentType: string;
  start: TaskLaunchStart;
  title: string;
  workspaceName: string;
  createdAt: string;
  taskRuntimeConfig: RuntimeConfig;
  parentRuntimeConfig: RuntimeConfig;
  taskModelString: string;
  canonicalModel: string;
  effectiveThinkingLevel?: ThinkingLevel;
  skipInitHook: boolean;
  preferredTrunkBranch?: string;
  workflowTask?: TaskCreateArgs["workflowTask"];
  bestOf?: TaskCreateArgs["bestOf"];
  experiments?: TaskCreateArgs["experiments"];
  onRefusal?: TaskCreateArgs["onRefusal"];
}

interface TaskCreateManyOptions {
  onTaskReserved?: (index: number, result: TaskCreateResult) => Promise<void> | void;
}

interface MaterializedTaskLaunch {
  workspacePath: string;
  trunkBranch: string;
  forkedRuntimeConfig: RuntimeConfig;
  runtimeForTaskWorkspace: Runtime;
  inheritedProjects: WorkspaceMetadata["projects"];
  sourceRuntimeConfigUpdate?: RuntimeConfig;
}

export interface TerminateAgentTaskResult {
  /** Task IDs terminated (includes descendants). */
  terminatedTaskIds: string[];
}

export interface DescendantAgentTaskInfo {
  taskId: string;
  status: AgentTaskStatus;
  parentWorkspaceId: string;
  agentType?: string;
  workspaceName?: string;
  title?: string;
  createdAt?: string;
  modelString?: string;
  thinkingLevel?: ThinkingLevel;
  depth: number;
}

type AgentTaskWorkspaceEntry = WorkspaceConfigEntry & { projectPath: string };

const WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE = "Workspace is busy; idle-only send was skipped.";

function isWorkspaceBusyIdleOnlySend(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    (error as { type?: unknown }).type === "unknown" &&
    typeof (error as { raw?: unknown }).raw === "string" &&
    (error as { raw: string }).raw.includes(WORKSPACE_BUSY_IDLE_ONLY_SEND_MESSAGE)
  );
}

const COMPLETED_REPORT_CACHE_MAX_ENTRIES = 128;

/** Maximum consecutive auto-resumes before stopping. Prevents infinite loops when descendants are stuck. */
// Task-recovery paths must stay deterministic and editing-capable even when
// workspace/default agent preferences evolve (e.g., auto router defaults).
const TASK_RECOVERY_FALLBACK_AGENT_ID = "exec";

function resolveTaskAgentIdForResume(workspace: {
  agentId?: string;
  agentType?: string;
  parentWorkspaceId?: string | null;
}): string {
  return resolvePersistedAgentId(workspace, TASK_RECOVERY_FALLBACK_AGENT_ID);
}

const MAX_CONSECUTIVE_PARENT_AUTO_RESUMES = 3;

/**
 * Maximum completion-tool recovery prompts for a child task (since it last
 * completed successfully) before the task is interrupted instead of prompted
 * again. Unlike the in-memory
 * parent auto-resume counter above, this budget is persisted on the workspace
 * config entry (taskRecoveryAttempts) so crash/restart recovery loops stay
 * bounded across app restarts. Covers terminal-but-unclassified outcomes such
 * as repeated empty_output errors, repeated length-truncated turns, and models
 * that never call their completion tool.
 */
const MAX_TASK_RECOVERY_ATTEMPTS = 5;

const WORKSPACE_TURN_RECOVERABLE_STREAM_ERRORS: ReadonlySet<StreamErrorType> = new Set([
  "aborted",
  "context_exceeded",
  "runtime_start_failed",
]);

/**
 * Provider-terminal stream errors that settle a child task even while it is
 * still `running` (before it owes its completion tool). Subset of
 * NON_RETRYABLE_STREAM_ERRORS: errors with in-session recovery
 * (context_exceeded) or user intent (aborted) must not terminally settle a
 * running task.
 */
const RUNNING_TASK_TERMINAL_STREAM_ERRORS: ReadonlySet<StreamErrorType> = new Set([
  "model_refusal",
  "authentication",
  "quota",
  "model_not_found",
  "runtime_not_ready",
]);

interface AgentTaskIndex {
  byId: Map<string, AgentTaskWorkspaceEntry>;
  childrenByParent: Map<string, string[]>;
  parentById: Map<string, string>;
}

type WorkflowTaskConfig = NonNullable<WorkspaceConfigEntry["workflowTask"]>;

interface WorkflowTaskOwner {
  taskId: string;
  workspace: AgentTaskWorkspaceEntry;
  workflowTask: WorkflowTaskConfig;
}

interface InactiveWorkflowTaskOwner {
  ownerTaskId: string;
  runId: string;
  status?: WorkflowRunStatus;
  reason: string;
}

type InterruptedTaskStatusMutation = "interrupted" | "preserved-completed-report";

interface PendingTaskWaiter extends BackgroundableForegroundWaiter {
  resolve: (report: { reportMarkdown: string; title?: string; structuredOutput?: unknown }) => void;
}

interface PendingTaskStartWaiter {
  start: () => void;
  cleanup: () => void;
}

interface CompletedAgentReportCacheEntry {
  reportMarkdown: string;
  structuredOutput?: unknown;
  title?: string;
  // Ancestor workspace IDs captured when the report was cached.
  // Used to keep descendant-scope checks working even if the task workspace is cleaned up.
  ancestorWorkspaceIds: string[];
  // Ancestors for which the task report must only be consumed through a workflow run.
  workflowOwnedAncestorWorkspaceIds?: string[];
}

interface ParentAutoResumeHint {
  agentId?: string;
}

function isTypedWorkspaceEvent(value: unknown, type: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value as { type: unknown }).type === type &&
    "workspaceId" in value &&
    typeof (value as { workspaceId: unknown }).workspaceId === "string"
  );
}

function isStreamEndEvent(value: unknown): value is StreamEndEvent {
  return isTypedWorkspaceEvent(value, "stream-end");
}

function isStreamAbortEvent(value: unknown): value is StreamAbortEvent {
  return isTypedWorkspaceEvent(value, "stream-abort");
}

function isErrorEvent(value: unknown): value is ErrorEvent {
  return isTypedWorkspaceEvent(value, "error");
}

function hasAncestorWorkspaceId(
  entry: { ancestorWorkspaceIds?: unknown } | null | undefined,
  ancestorWorkspaceId: string
): boolean {
  const ids = entry?.ancestorWorkspaceIds;
  return Array.isArray(ids) && ids.includes(ancestorWorkspaceId);
}

function hasWorkflowOwnedAncestorWorkspaceId(
  entry: { workflowOwnedAncestorWorkspaceIds?: unknown } | null | undefined,
  ancestorWorkspaceId: string
): boolean {
  const ids = entry?.workflowOwnedAncestorWorkspaceIds;
  return Array.isArray(ids) && ids.includes(ancestorWorkspaceId);
}

function isSuccessfulToolResult(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success?: unknown }).success === true
  );
}

function formatBackgroundAwaitTargetList(label: string, ids: string[]): string | null {
  if (ids.length === 0) {
    return null;
  }
  return `${label} (${ids.join(", ")})`;
}

function buildBackgroundAwaitPrompt(params: {
  taskIds: string[];
  workflowRunIds: string[];
}): string {
  assert(
    params.taskIds.length > 0 || params.workflowRunIds.length > 0,
    "buildBackgroundAwaitPrompt requires at least one awaitable target"
  );

  const targetLabels = [
    formatBackgroundAwaitTargetList("task handle(s)", params.taskIds),
    formatBackgroundAwaitTargetList("workflow run(s)", params.workflowRunIds),
  ].filter((label): label is string => label != null);
  const taskIds = [...params.taskIds, ...params.workflowRunIds];

  return (
    `You have active background ${targetLabels.join(" and ")}. ` +
    "You MUST NOT end your turn while any listed task handles are queued/starting/running/awaiting_report or workflow runs are pending/running/backgrounded. " +
    `Call task_await now with task_ids: ${JSON.stringify(taskIds)} to wait for them. ` +
    "If any are still queued/starting/running/awaiting_report/backgrounded after that, call task_await again. " +
    "Only once all listed work is terminal should you write your final response, integrating any reports or workflow results."
  );
}

const isWorkflowRunId = isWorkflowRunTaskId;

function collectWorkflowRunIdsFromToolOutput(output: unknown): string[] {
  if (output == null || typeof output !== "object") {
    return [];
  }

  const record = output as Record<string, unknown>;
  if (isWorkflowRunId(record.runId)) {
    return [record.runId];
  }

  const results = record.results;
  if (!Array.isArray(results)) {
    return [];
  }

  const runIds: string[] = [];
  for (const result of results) {
    if (result == null || typeof result !== "object") {
      continue;
    }
    const taskId = (result as Record<string, unknown>).taskId;
    if (isWorkflowRunId(taskId)) {
      runIds.push(taskId);
    }
  }
  return runIds;
}

function collectWorkflowRunIdsFromTaskAwaitInput(input: unknown): string[] {
  if (input == null || typeof input !== "object") {
    return [];
  }
  const taskIds = (input as Record<string, unknown>).task_ids;
  if (!Array.isArray(taskIds)) {
    return [];
  }
  return taskIds.filter(isWorkflowRunId);
}

function collectAgentReferencedWorkflowRunIdsFromParts(
  parts: readonly unknown[],
  knownAgentRunIds: ReadonlySet<string>
): string[] {
  const runIds = new Set<string>();

  for (const part of parts) {
    if (!isDynamicToolPart(part) || part.state !== "output-available") {
      continue;
    }
    // workflow_resume re-establishes agent provenance the same way workflow_run does: both
    // outputs carry the runId of a run the agent explicitly owns.
    if (!isWorkflowRunEmittingToolName(part.toolName)) {
      continue;
    }
    for (const runId of collectWorkflowRunIdsFromToolOutput(part.output)) {
      runIds.add(runId);
    }
  }

  const allowedTaskAwaitRunIds = new Set([...knownAgentRunIds, ...runIds]);
  for (const part of parts) {
    if (!isDynamicToolPart(part) || part.state !== "output-available") {
      continue;
    }
    if (part.toolName !== "task_await") {
      continue;
    }

    // Omitted task_ids makes task_await discover every active run in the workspace, including
    // slash-command runs. Only treat task_await output as agent provenance when the model either
    // explicitly awaited that workflow ID in this turn or we already know the run was agent-started.
    for (const runId of collectWorkflowRunIdsFromTaskAwaitInput(part.input)) {
      runIds.add(runId);
      allowedTaskAwaitRunIds.add(runId);
    }
    for (const runId of collectWorkflowRunIdsFromToolOutput(part.output)) {
      if (allowedTaskAwaitRunIds.has(runId)) {
        runIds.add(runId);
      }
    }
  }

  return Array.from(runIds);
}

function isInternalResumeAutoCompactionMessage(message: MuxMessage): boolean {
  const muxMetadata = message.metadata?.muxMetadata;
  if (muxMetadata?.type !== "compaction-request" || muxMetadata.source !== "auto-compaction") {
    return false;
  }
  return muxMetadata.parsed.followUpContent?.dispatchOptions?.source === "internal-resume";
}

function isSyntheticManualSupersessionMessage(message: MuxMessage): boolean {
  const muxMetadata = message.metadata?.muxMetadata;
  return (
    message.metadata?.synthetic === true &&
    muxMetadata?.type === "compaction-request" &&
    muxMetadata.source === "auto-compaction" &&
    !isInternalResumeAutoCompactionMessage(message)
  );
}

function isManualUserSupersessionMessage(message: MuxMessage): boolean {
  return (
    message.role === "user" &&
    (message.metadata?.synthetic !== true || isSyntheticManualSupersessionMessage(message))
  );
}

function isResetBoundaryMessage(message: MuxMessage): boolean {
  return message.metadata?.contextBoundaryKind === CONTEXT_BOUNDARY_KINDS.RESET;
}

function isWorkflowSupersessionMessage(message: MuxMessage): boolean {
  return isManualUserSupersessionMessage(message) || isResetBoundaryMessage(message);
}

function isFailedWorkflowRunSnapshot(value: unknown, runId: string): boolean {
  if (value == null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record.id === runId && record.status === "failed";
}

function isTerminalWorkflowTaskAwaitRecord(
  record: Record<string, unknown>,
  runId: string
): boolean {
  if (record.taskId !== runId) {
    return false;
  }
  if (record.status === "completed" || record.status === "interrupted") {
    return true;
  }
  if (record.status === "error") {
    return isFailedWorkflowRunSnapshot(record.run, runId);
  }
  return false;
}

function hasTerminalWorkflowTaskAwaitInParts(parts: readonly unknown[], runId: string): boolean {
  return parts.some((part) => {
    if (!isDynamicToolPart(part) || part.toolName !== "task_await") {
      return false;
    }
    if (part.state !== "output-available") {
      return false;
    }
    const output = part.output;
    if (output == null || typeof output !== "object") {
      return false;
    }
    const results = (output as Record<string, unknown>).results;
    if (!Array.isArray(results)) {
      return false;
    }
    return results.some((result) => {
      if (result == null || typeof result !== "object") {
        return false;
      }
      return isTerminalWorkflowTaskAwaitRecord(result as Record<string, unknown>, runId);
    });
  });
}

function sanitizeAgentTypeForName(agentType: string): string {
  const normalized = agentType
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/-+/g, "-")
    .replace(/^[_-]+|[_-]+$/g, "");

  return normalized.length > 0 ? normalized : "agent";
}

function buildAgentWorkspaceName(agentType: string, workspaceId: string): string {
  const safeType = sanitizeAgentTypeForName(agentType);
  const base = `agent_${safeType}_${workspaceId}`;
  // Hard cap to validation limit (64). Ensure stable suffix is preserved.
  if (base.length <= 64) return base;

  const suffix = `_${workspaceId}`;
  const maxPrefixLen = 64 - suffix.length;
  const prefix = `agent_${safeType}`.slice(0, Math.max(0, maxPrefixLen));
  const name = `${prefix}${suffix}`;
  return name.length <= 64 ? name : `agent_${workspaceId}`.slice(0, 64);
}

function getIsoNow(): string {
  return new Date().toISOString();
}

async function runtimePathExists(runtime: Runtime, path: string): Promise<boolean> {
  assert(path.length > 0, "runtimePathExists: path must be non-empty");
  try {
    await runtime.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTaskBaseCommitShaByProjectPath(params: {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  runtimeConfig: RuntimeConfig;
  projectPath: string;
  projectName: string;
  projects?: WorkspaceMetadata["projects"];
  runtime: Runtime;
}): Promise<Record<string, string>> {
  const projectRepos = getWorkspaceProjectRepos({
    workspaceId: params.workspaceId,
    workspaceName: params.workspaceName,
    workspacePath: params.workspacePath,
    runtimeConfig: params.runtimeConfig,
    projectPath: params.projectPath,
    projectName: params.projectName,
    projects: params.projects,
  });

  const taskBaseCommitShaByProjectPath: Record<string, string> = {};
  for (const projectRepo of projectRepos) {
    const taskBaseCommitSha = await tryReadGitHeadCommitSha(params.runtime, projectRepo.repoCwd);
    if (taskBaseCommitSha) {
      taskBaseCommitShaByProjectPath[projectRepo.projectPath] = taskBaseCommitSha;
    }
  }

  return taskBaseCommitShaByProjectPath;
}

export class ForegroundWaitBackgroundedError extends Error {
  constructor() {
    super("Foreground wait sent to background due to queued message");
    this.name = "ForegroundWaitBackgroundedError";
  }
}

export class TaskService {
  // Serialize stream-end processing per workspace to avoid races when
  // finalizing reported tasks and cleanup state transitions.
  private readonly workspaceEventLocks = new MutexMap<string>();
  // Separate parent-scoped lock for deferred best-of fallback/finalization. This path can run
  // concurrently from multiple child stream-end handlers for the same parent, and it must remain
  // safe even when the parent stream-end already holds workspaceEventLocks for the parent itself.
  private readonly deferredBestOfLocks = new MutexMap<string>();
  // Serialize terminal writes per workspace-turn handle so late completions/interruptions cannot
  // overwrite an already-settled handle.
  private readonly workspaceTurnSettlementLocks = new MutexMap<string>();
  private readonly mutex = new AsyncMutex();
  private maybeStartQueuedTasksInFlight: Promise<void> | undefined;
  private maybeStartQueuedTasksRerunRequested = false;
  // Git worktree creation touches per-repository metadata; serialize that narrow phase per project
  // while allowing post-fork init/send startup work for sibling tasks to overlap.
  private readonly reservedTaskLaunchByProjectPath = new Map<string, Promise<void>>();
  private readonly pendingWaitersByTaskId = new Map<string, PendingTaskWaiter[]>();
  private readonly pendingStartWaitersByTaskId = new Map<string, PendingTaskStartWaiter[]>();
  // Tracks workspaces currently blocked in a foreground wait (e.g. a task tool call awaiting
  // agent_report). Used to avoid scheduler deadlocks when maxParallelAgentTasks is low and tasks
  // spawn nested tasks in the foreground.
  private readonly foregroundAwaitCountByWorkspaceId = new Map<string, number>();
  private readonly backgroundableForegroundWaitersByWorkspaceId = new Map<
    string,
    Set<BackgroundableForegroundWaiter>
  >();
  private readonly pendingWorkspaceTurnWaitersByHandleId = new Map<string, WorkspaceTurnWaiter[]>();
  private readonly activeWorkspaceTurnHandleByWorkspaceId = new Map<
    string,
    { handleId: string; ownerWorkspaceId: string }
  >();
  private readonly taskHandleStore: TaskHandleStore;
  private readonly userBackgroundedTaskIds = new Set<string>();

  // Cache completed reports so callers can retrieve them without re-reading disk.
  // Bounded by max entries; disk persistence is the source of truth for restart-safety.
  private readonly completedReportsByTaskId = new Map<string, CompletedAgentReportCacheEntry>();
  private readonly gitPatchArtifactService: GitPatchArtifactService;
  private readonly handoffInProgress = new Set<string>();
  /**
   * Hard-interrupted parent workspaces must not auto-resume until the next user message.
   * This closes races where descendants could report between parent interrupt and cascade cleanup.
   */
  private interruptedParentWorkspaceIds = new Set<string>();
  /** Tracks consecutive auto-resumes per workspace. Reset when a user message is sent. */
  private consecutiveAutoResumes = new Map<string, number>();

  private async findLatestWorkflowSupersession(workspaceId: string): Promise<{
    found: boolean;
    timestamp?: number;
  }> {
    assert(workspaceId.length > 0, "findLatestWorkflowSupersession requires workspaceId");
    let latest: { found: boolean; timestamp?: number } = { found: false };
    const historyResult = await this.historyService.iterateFullHistory(
      workspaceId,
      "backward",
      (messages) => {
        for (const message of messages) {
          if (!isWorkflowSupersessionMessage(message)) {
            continue;
          }
          const timestamp = message.metadata?.timestamp;
          latest = {
            found: true,
            ...(typeof timestamp === "number" ? { timestamp } : {}),
          };
          return false;
        }
        return undefined;
      }
    );

    if (!historyResult.success) {
      log.warn("Failed to read full history for workflow supersession", {
        workspaceId,
        error: historyResult.error,
      });
    }
    return latest;
  }

  private async listAgentReferencedWorkflowRunIds(
    workspaceId: string,
    currentParts: readonly unknown[],
    currentMessageId?: string
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listAgentReferencedWorkflowRunIds requires workspaceId");

    const latestSupersession = await this.findLatestWorkflowSupersession(workspaceId);
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    let historyMessages: MuxMessage[] = [];
    let historyScanStartIndex = 0;
    let trustCurrentParts = true;
    if (historyResult.success) {
      historyMessages = historyResult.data;
      const latestSupersessionIndex = historyMessages.findLastIndex(isWorkflowSupersessionMessage);
      if (latestSupersessionIndex !== -1) {
        historyScanStartIndex = latestSupersessionIndex + 1;
        const currentMessageIndex =
          currentMessageId == null
            ? -1
            : historyMessages.findIndex((message) => message.id === currentMessageId);
        if (currentMessageIndex !== -1 && currentMessageIndex < latestSupersessionIndex) {
          trustCurrentParts = false;
        }
      }
    } else {
      log.warn("Failed to read history for workflow run references", {
        workspaceId,
        error: historyResult.error,
      });
    }

    const runIds = new Set<string>();
    const references = await readAgentWorkflowRunReferences(this.config.getSessionDir(workspaceId));
    for (const reference of references) {
      // If the latest user/reset supersession has no durable timestamp, fail safe: only trust
      // workflow provenance re-established by current/post-supersession assistant output below.
      if (latestSupersession.found && latestSupersession.timestamp === undefined) {
        continue;
      }
      if (
        latestSupersession.timestamp !== undefined &&
        reference.createdAtMs <= latestSupersession.timestamp
      ) {
        continue;
      }
      runIds.add(reference.runId);
    }

    if (trustCurrentParts) {
      for (const runId of collectAgentReferencedWorkflowRunIdsFromParts(currentParts, runIds)) {
        runIds.add(runId);
      }
    }

    for (const message of historyMessages.slice(historyScanStartIndex)) {
      if (message.role !== "assistant" || isWorkflowDisplayOnlyMessage(message)) {
        continue;
      }
      for (const runId of collectAgentReferencedWorkflowRunIdsFromParts(message.parts, runIds)) {
        runIds.add(runId);
      }
    }

    return Array.from(runIds);
  }

  private async listActiveBackgroundWorkflowRunIds(
    workspaceId: string,
    referencedWorkflowRunIds: readonly string[]
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listActiveBackgroundWorkflowRunIds requires workspaceId");
    if (referencedWorkflowRunIds.length === 0) {
      return [];
    }

    try {
      const referencedRunIdSet = new Set(referencedWorkflowRunIds);
      const runStore = new WorkflowRunStore({ sessionDir: this.config.getSessionDir(workspaceId) });
      const runs = await runStore.listRuns();
      return runs
        .filter(
          (run) =>
            referencedRunIdSet.has(run.id) &&
            run.workspaceId === workspaceId &&
            isActiveWorkflowRunStatus(run.status)
        )
        .map((run) => run.id);
    } catch (error: unknown) {
      // Workflow state should never make stream-end cleanup fail; task_await can still discover
      // runs on a later turn once storage is readable again.
      log.warn("Failed to list active background workflow runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  private async listBlockingBackgroundWorkflowRunIds(
    workspaceId: string,
    referencedWorkflowRunIds: readonly string[],
    currentParts: readonly unknown[]
  ): Promise<string[]> {
    assert(workspaceId.length > 0, "listBlockingBackgroundWorkflowRunIds requires workspaceId");
    if (referencedWorkflowRunIds.length === 0) {
      return [];
    }

    try {
      const referencedRunIdSet = new Set(referencedWorkflowRunIds);
      const runStore = new WorkflowRunStore({ sessionDir: this.config.getSessionDir(workspaceId) });
      const runs = await runStore.listRuns();
      const blockingRunIds: string[] = [];
      for (const run of runs) {
        if (!referencedRunIdSet.has(run.id) || run.workspaceId !== workspaceId) {
          continue;
        }
        if (isActiveWorkflowRunStatus(run.status)) {
          blockingRunIds.push(run.id);
          continue;
        }
        if (!isTerminalWorkflowRunStatus(run.status)) {
          continue;
        }
        if (hasTerminalWorkflowTaskAwaitInParts(currentParts, run.id)) {
          continue;
        }
        const isCurrent = await this.workspaceService.isWorkflowInvocationCurrent(
          workspaceId,
          run.id
        );
        if (isCurrent) {
          blockingRunIds.push(run.id);
        }
      }
      return blockingRunIds;
    } catch (error: unknown) {
      log.warn("Failed to list blocking background workflow runs", {
        workspaceId,
        error: getErrorMessage(error),
      });
      return [];
    }
  }

  // Workflow abort/interrupt is the source of truth: task-level restart and stream-end
  // recovery must not resurrect a workflow child (or its descendants) once the owning run
  // is no longer active. Manual workflow_resume replays from the workflow journal instead.
  private findWorkflowTaskOwnersInAncestry(
    index: AgentTaskIndex,
    taskId: string
  ): WorkflowTaskOwner[] {
    assert(taskId.length > 0, "findWorkflowTaskOwnersInAncestry requires taskId");
    const owners: WorkflowTaskOwner[] = [];
    let current: string | undefined = taskId;
    for (let depth = 0; current != null; depth += 1) {
      assert(
        depth < 32,
        `findWorkflowTaskOwnersInAncestry: possible parentWorkspaceId cycle starting at ${taskId}`
      );
      const entry = index.byId.get(current);
      if (entry == null) {
        current = index.parentById.get(current);
        continue;
      }
      const workflowTask = entry.workflowTask;
      if (workflowTask != null) {
        owners.push({ taskId: current, workspace: entry, workflowTask });
      }
      current = index.parentById.get(current);
    }
    return owners;
  }

  private findWorkflowTaskOwnerInAncestry(
    index: AgentTaskIndex,
    taskId: string
  ): WorkflowTaskOwner | null {
    return this.findWorkflowTaskOwnersInAncestry(index, taskId)[0] ?? null;
  }

  private async getInactiveWorkflowTaskOwner(
    owner: WorkflowTaskOwner
  ): Promise<InactiveWorkflowTaskOwner | null> {
    const workflowTask = owner.workflowTask;
    const parentWorkspaceId = coerceNonEmptyString(owner.workspace.parentWorkspaceId);
    if (!parentWorkspaceId) {
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        reason: "workflow-owned task is missing its parent workspace",
      };
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: this.config.getSessionDir(parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      if (run.workspaceId !== parentWorkspaceId) {
        return {
          ownerTaskId: owner.taskId,
          runId: workflowTask.runId,
          status: run.status,
          reason: `workflow run belongs to ${run.workspaceId}, not ${parentWorkspaceId}`,
        };
      }
      if (isActiveWorkflowRunStatus(run.status)) {
        return null;
      }
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        status: run.status,
        reason: `workflow run is ${run.status}`,
      };
    } catch (error: unknown) {
      return {
        ownerTaskId: owner.taskId,
        runId: workflowTask.runId,
        reason: `workflow run is unavailable: ${getErrorMessage(error)}`,
      };
    }
  }

  private async getInactiveWorkflowTaskOwnerForRecovery(
    taskId: string,
    config: ProjectsConfig,
    index?: AgentTaskIndex
  ): Promise<InactiveWorkflowTaskOwner | null> {
    assert(taskId.length > 0, "getInactiveWorkflowTaskOwnerForRecovery requires taskId");
    const owners = this.findWorkflowTaskOwnersInAncestry(
      index ?? this.buildAgentTaskIndex(config),
      taskId
    );
    for (const owner of owners) {
      const inactiveOwner = await this.getInactiveWorkflowTaskOwner(owner);
      if (inactiveOwner != null) {
        return inactiveOwner;
      }
    }
    return null;
  }

  private applyInterruptedTaskStatus(
    workspace: WorkspaceConfigEntry
  ): InterruptedTaskStatusMutation {
    if (hasCompletedAgentReport(workspace)) {
      // Preserve completed report evidence so already-finished tasks stay inspectable
      // and collapse-eligible after a later interrupt/recovery pass.
      return "preserved-completed-report";
    }

    const previousStatus = workspace.taskStatus;
    const persistedQueuedPrompt = coerceNonEmptyString(workspace.taskPrompt);
    workspace.taskStatus = "interrupted";
    workspace.reportedAt = undefined;

    // Queued tasks persist their initial prompt in config until first start. Preserve that
    // intent across interrupts, including repeated interrupts after the status is no longer queued.
    if (previousStatus !== "queued" && !persistedQueuedPrompt) {
      workspace.taskPrompt = undefined;
    }
    return "interrupted";
  }

  private async interruptTaskRecoveryForInactiveWorkflowOwner(
    taskId: string,
    config: ProjectsConfig,
    trigger: string,
    index?: AgentTaskIndex,
    options?: { scheduleQueueDrain?: boolean }
  ): Promise<boolean> {
    assert(taskId.length > 0, "interruptTaskRecoveryForInactiveWorkflowOwner requires taskId");
    assert(trigger.length > 0, "interruptTaskRecoveryForInactiveWorkflowOwner requires trigger");
    const inactiveOwner = await this.getInactiveWorkflowTaskOwnerForRecovery(taskId, config, index);
    if (inactiveOwner == null) {
      return false;
    }

    let interrupted = false;
    await this.editWorkspaceEntry(
      taskId,
      (ws) => {
        interrupted = this.applyInterruptedTaskStatus(ws) === "interrupted";
      },
      { allowMissing: true }
    );

    log.debug("Skipping workflow-owned task recovery after inactive workflow owner", {
      taskId,
      trigger,
      ownerTaskId: inactiveOwner.ownerTaskId,
      workflowRunId: inactiveOwner.runId,
      workflowRunStatus: inactiveOwner.status,
      reason: inactiveOwner.reason,
    });
    if (interrupted) {
      this.rejectWaiters(taskId, new Error("Task interrupted"));
      await this.emitWorkspaceMetadata(taskId);
      if (options?.scheduleQueueDrain !== false) {
        this.scheduleMaybeStartQueuedTasks();
      }
    }
    return true;
  }

  private markTaskQueueBackgrounded(taskId: string): void {
    this.userBackgroundedTaskIds.add(taskId);
  }

  private markTaskForegroundRelevant(taskId: string): void {
    this.userBackgroundedTaskIds.delete(taskId);
  }

  private isTaskQueueBackgrounded(taskId: string): boolean {
    return this.userBackgroundedTaskIds.has(taskId);
  }

  constructor(
    private readonly config: Config,
    private readonly historyService: HistoryService,
    private readonly aiService: AIService,
    private readonly workspaceService: WorkspaceService,
    private readonly initStateManager: InitStateManager,
    private readonly opResolver?: ExternalSecretResolver,
    private readonly sessionUsageService?: SessionUsageService,
    private readonly workspaceGoalService?: WorkspaceGoalService
  ) {
    this.taskHandleStore = new TaskHandleStore(config);
    this.gitPatchArtifactService = new GitPatchArtifactService(config);

    this.aiService.on("stream-end", (payload: unknown) => {
      if (!isStreamEndEvent(payload)) return;

      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleStreamEnd(payload);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleStreamEnd failed", { error });
        });
    });

    this.aiService.on("stream-abort", (payload: unknown) => {
      if (!isStreamAbortEvent(payload)) return;

      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleStreamAbort(payload);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleStreamAbort failed", { error });
        });
    });

    this.aiService.on("error", (payload: unknown) => {
      if (!isErrorEvent(payload)) return;

      void this.workspaceEventLocks
        .withLock(payload.workspaceId, async () => {
          await this.handleTaskStreamError(payload);
        })
        .catch((error: unknown) => {
          log.error("TaskService.handleTaskStreamError failed", { error });
        });
    });
  }

  // Prefer per-agent settings so tasks inherit the correct agent defaults;
  // fall back to legacy workspace settings for older configs.
  private resolveWorkspaceAISettings(
    workspace: {
      aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
      aiSettings?: ResolvedWorkspaceAiSettings;
    },
    agentId: string | undefined
  ): ResolvedWorkspaceAiSettings | undefined {
    const normalizedAgentId =
      typeof agentId === "string" && agentId.trim().length > 0
        ? normalizeAgentId(agentId, "")
        : undefined;
    return (
      (normalizedAgentId ? workspace.aiSettingsByAgent?.[normalizedAgentId] : undefined) ??
      workspace.aiSettings
    );
  }

  private resolveTaskAISettings(params: {
    cfg: ReturnType<Config["loadConfigOrDefault"]>;
    parentMeta: {
      aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
      aiSettings?: ResolvedWorkspaceAiSettings;
    };
    agentId: string;
    modelString?: string;
    thinkingLevel?: ParsedThinkingInput;
    parentRuntimeAiSettings?: { modelString?: string; thinkingLevel?: ThinkingLevel };
  }): {
    taskModelString: string;
    canonicalModel: string;
    effectiveThinkingLevel: ThinkingLevel;
  } {
    const parentAiSettings = this.resolveWorkspaceAISettings(params.parentMeta, params.agentId);
    // Sub-agent defaults take priority over UI agent defaults per field for any agent invoked as a sub-agent.
    const subagentDefault = params.cfg.subagentAiDefaults?.[params.agentId];
    const agentDefault = params.cfg.agentAiDefaults?.[params.agentId];
    const parentRuntimeAiSettings = params.parentRuntimeAiSettings;

    const taskModelString =
      coerceNonEmptyString(params.modelString) ??
      coerceNonEmptyString(subagentDefault?.modelString) ??
      coerceNonEmptyString(agentDefault?.modelString) ??
      coerceNonEmptyString(parentRuntimeAiSettings?.modelString) ??
      coerceNonEmptyString(parentAiSettings?.model) ??
      defaultModel;
    const canonicalModel = normalizeToCanonical(taskModelString).trim();
    assert(canonicalModel.length > 0, "resolveTaskAISettings: resolved model must be non-empty");

    // Resolve an explicit override first so numeric thinking indices map into the
    // chosen model's allowed levels (named levels pass through unchanged).
    const overrideThinkingLevel =
      params.thinkingLevel != null
        ? resolveThinkingInput(params.thinkingLevel, canonicalModel)
        : undefined;
    const requestedThinkingLevel: ThinkingLevel =
      overrideThinkingLevel ??
      subagentDefault?.thinkingLevel ??
      agentDefault?.thinkingLevel ??
      parentRuntimeAiSettings?.thinkingLevel ??
      parentAiSettings?.thinkingLevel ??
      "off";
    const effectiveThinkingLevel = enforceThinkingPolicy(canonicalModel, requestedThinkingLevel);

    return { taskModelString, canonicalModel, effectiveThinkingLevel };
  }

  /**
   * Derives auto-resume send options (agentId, model, thinkingLevel) from durable
   * conversation metadata, so synthetic resumes preserve the parent's active agent.
   *
   * Precedence: stream-end event metadata → last assistant message in history → workspace AI settings → defaults.
   */
  private async resolveParentAutoResumeOptions(
    parentWorkspaceId: string,
    parentEntry: {
      workspace: {
        aiSettingsByAgent?: Record<string, ResolvedWorkspaceAiSettings>;
        aiSettings?: ResolvedWorkspaceAiSettings;
      };
    },
    fallbackModel: string,
    hint?: ParentAutoResumeHint
  ): Promise<{ model: string; agentId: string; thinkingLevel?: ThinkingLevel }> {
    // 1) Try stream-end hint metadata (available in handleStreamEnd path)
    let agentId = hint?.agentId;

    // 2) Fall back to latest assistant message metadata in history (restart-safe)
    if (!agentId) {
      try {
        const historyResult = await this.historyService.getLastMessages(parentWorkspaceId, 20);
        if (historyResult.success) {
          for (let i = historyResult.data.length - 1; i >= 0; i--) {
            const msg = historyResult.data[i];
            if (msg?.role === "assistant" && msg.metadata?.agentId) {
              agentId = msg.metadata.agentId;
              break;
            }
          }
        }
      } catch {
        // Best-effort; fall through to defaults
      }
    }

    // 3) Default
    // Keep task auto-resume recovery on exec even if the workspace default agent changes.
    // This path needs a deterministic editing-capable fallback for legacy/incomplete metadata.
    agentId = agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID;

    const aiSettings = this.resolveWorkspaceAISettings(parentEntry.workspace, agentId);
    return {
      model: aiSettings?.model ?? fallbackModel,
      agentId,
      thinkingLevel: aiSettings?.thinkingLevel,
    };
  }

  private async isPlanLikeTaskWorkspace(entry: {
    projectPath: string;
    workspace: Pick<
      WorkspaceConfigEntry,
      "id" | "name" | "path" | "runtimeConfig" | "agentId" | "agentType" | "parentWorkspaceId"
    >;
  }): Promise<boolean> {
    assert(entry.projectPath.length > 0, "isPlanLikeTaskWorkspace: projectPath must be non-empty");

    const agentIdCandidates = resolvePersistedAgentIdCandidates(entry.workspace);
    if (agentIdCandidates.length === 0) {
      return false;
    }

    const workspacePath = coerceNonEmptyString(entry.workspace.path);
    const workspaceName = coerceNonEmptyString(entry.workspace.name) ?? entry.workspace.id;
    const runtimeConfig = entry.workspace.runtimeConfig ?? DEFAULT_RUNTIME_CONFIG;
    if (!workspacePath || !workspaceName) {
      return agentIdCandidates.includes("plan");
    }

    const cfg = this.config.loadConfigOrDefault();
    const runtime = createRuntimeForWorkspace({
      runtimeConfig,
      projectPath: entry.projectPath,
      name: workspaceName,
    });
    const agentDiscoveryCandidates: Array<{ runtime: Runtime; workspacePath: string }> = [
      { runtime, workspacePath },
    ];

    const parentEntry = entry.workspace.parentWorkspaceId
      ? findWorkspaceEntry(cfg, entry.workspace.parentWorkspaceId)
      : null;
    const parentWorkspaceName = coerceNonEmptyString(parentEntry?.workspace.name);
    if (parentEntry != null && parentWorkspaceName != null) {
      try {
        agentDiscoveryCandidates.push(
          createRuntimeContextForWorkspace({
            runtimeConfig: parentEntry.workspace.runtimeConfig ?? runtimeConfig,
            projectPath: parentEntry.projectPath,
            name: parentWorkspaceName,
            namedWorkspacePath: coerceNonEmptyString(parentEntry.workspace.path),
          })
        );
      } catch (error: unknown) {
        log.debug("Failed to build parent task agent-discovery runtime", {
          workspaceId: entry.workspace.id,
          parentWorkspaceId: entry.workspace.parentWorkspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const agentId of agentIdCandidates) {
      let fallbackChain: Awaited<ReturnType<typeof resolveAgentInheritanceChain>> | undefined;
      let fallbackAgentId: string | undefined;
      for (const discovery of agentDiscoveryCandidates) {
        try {
          const agentDefinition = await readAgentDefinition(
            discovery.runtime,
            discovery.workspacePath,
            agentId
          );
          const chain = await resolveAgentInheritanceChain({
            runtime: discovery.runtime,
            workspacePath: discovery.workspacePath,
            agentId: agentDefinition.id,
            agentDefinition,
            workspaceId: entry.workspace.id ?? workspaceName,
          });

          if (agentDefinition.scope === "project") {
            return agentDefinition.id === "compact" ? false : isPlanLikeInResolvedChain(chain);
          }
          fallbackChain ??= chain;
          fallbackAgentId ??= agentDefinition.id;
        } catch (error: unknown) {
          log.debug("Failed to resolve task agent mode from discovery path", {
            workspaceId: entry.workspace.id,
            agentId,
            agentDiscoveryPath: discovery.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (fallbackChain != null) {
        if (fallbackAgentId === "compact") {
          return false;
        }
        return isPlanLikeInResolvedChain(fallbackChain);
      }
    }

    return agentIdCandidates.includes("plan");
  }

  private async emitWorkspaceMetadata(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "emitWorkspaceMetadata: workspaceId must be non-empty");

    const allMetadata = await this.config.getAllWorkspaceMetadata();
    const metadata = allMetadata.find((m) => m.id === workspaceId) ?? null;
    this.workspaceService.emit("metadata", { workspaceId, metadata });
  }

  private configureMultiProjectRuntimeEnvResolver(runtime: Runtime): void {
    if (!(runtime instanceof MultiProjectRuntime)) {
      return;
    }

    const projectEnvCache = new Map<string, Record<string, string>>();
    runtime.envResolver = async (runtimeProjectPath: string) => {
      const normalizedRuntimeProjectPath = stripTrailingSlashes(runtimeProjectPath);
      const cachedEnv = projectEnvCache.get(normalizedRuntimeProjectPath);
      if (cachedEnv) {
        return cachedEnv;
      }

      const projectEnv = await secretsToRecord(
        this.config.getEffectiveSecrets(normalizedRuntimeProjectPath),
        this.opResolver
      );
      projectEnvCache.set(normalizedRuntimeProjectPath, projectEnv);
      return projectEnv;
    };
  }

  private async editWorkspaceEntry(
    workspaceId: string,
    updater: (workspace: WorkspaceConfigEntry) => void,
    options?: { allowMissing?: boolean }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "editWorkspaceEntry: workspaceId must be non-empty");

    let found = false;
    await this.config.editConfig((config) => {
      for (const [_projectPath, project] of config.projects) {
        const ws = project.workspaces.find((w) => w.id === workspaceId);
        if (!ws) continue;
        updater(ws);
        found = true;
        return config;
      }

      if (options?.allowMissing) {
        return config;
      }

      throw new Error(`editWorkspaceEntry: workspace ${workspaceId} not found`);
    });

    return found;
  }

  async initialize(): Promise<void> {
    const startupStartedAt = Date.now();
    const startupConfig = this.config.loadConfigOrDefault();
    const queuedTaskCountAtStartup = this.listAgentTaskWorkspaces(startupConfig).filter(
      (task) => task.taskStatus === "queued" && typeof task.id === "string"
    ).length;

    log.info("[startup] TaskService.initialize starting", {
      queuedTaskCountAtStartup,
    });

    const staleStartingTasks = this.listAgentTaskWorkspaces(startupConfig).filter(
      (task) => task.taskStatus === "starting" && typeof task.id === "string"
    );
    if (staleStartingTasks.length > 0) {
      const recoveries = new Map<
        string,
        { status: Extract<AgentTaskStatus, "queued" | "running">; acceptedPrompt: boolean }
      >();
      for (const task of staleStartingTasks) {
        assert(task.id != null && task.id.length > 0, "stale starting task id is required");
        const isStreaming = this.aiService.isStreaming(task.id);
        recoveries.set(task.id, {
          status: isStreaming ? "running" : "queued",
          acceptedPrompt: !isStreaming && (await this.hasAcceptedInitialTaskPrompt(task.id)),
        });
      }

      await this.config.editConfig((config) => {
        for (const task of staleStartingTasks) {
          assert(task.id != null && task.id.length > 0, "stale starting task id is required");
          const recovery = recoveries.get(task.id);
          assert(recovery != null, "stale starting task recovery is required");
          const entry = findWorkspaceEntry(config, task.id);
          if (!entry) continue;
          entry.workspace.taskStatus = recovery.status;
          if (recovery.acceptedPrompt) {
            // The initial prompt is already durable in chat history; clearing taskPrompt makes the
            // queued recovery path resume that accepted turn instead of appending a duplicate user turn.
            entry.workspace.taskPrompt = undefined;
          }
        }
        return config;
      });
      log.info("[startup] Recovered stale starting agent tasks", {
        count: staleStartingTasks.length,
        acceptedPromptCount: [...recoveries.values()].filter((recovery) => recovery.acceptedPrompt)
          .length,
      });
    }

    const maybeStartQueuedTasksStartedAt = Date.now();
    await this.maybeStartQueuedTasks();
    const maybeStartQueuedTasksMs = Date.now() - maybeStartQueuedTasksStartedAt;

    let config = this.config.loadConfigOrDefault();
    let taskIndex = this.buildAgentTaskIndex(config);
    // Recompute the startup recovery candidate lists from a config snapshot. Hoisted into a
    // closure so the post-interrupt refresh below reuses the exact same status filters.
    const listStartupRecoveryCandidates = (
      sourceConfig: ProjectsConfig
    ): {
      awaitingReportTasks: AgentTaskWorkspaceEntry[];
      runningTasks: AgentTaskWorkspaceEntry[];
    } => ({
      awaitingReportTasks: this.listAgentTaskWorkspaces(sourceConfig).filter(
        (t) => t.taskStatus === "awaiting_report"
      ),
      runningTasks: this.listAgentTaskWorkspaces(sourceConfig).filter(
        (t) => t.taskStatus === "running"
      ),
    });
    let { awaitingReportTasks, runningTasks } = listStartupRecoveryCandidates(config);

    let interruptedInactiveWorkflowOwnerAtStartup = false;
    for (const task of [...awaitingReportTasks, ...runningTasks]) {
      if (!task.id) continue;
      if (
        await this.interruptTaskRecoveryForInactiveWorkflowOwner(
          task.id,
          config,
          "startup-inactive-workflow-owner-prepass",
          taskIndex,
          { scheduleQueueDrain: false }
        )
      ) {
        interruptedInactiveWorkflowOwnerAtStartup = true;
      }
    }
    if (interruptedInactiveWorkflowOwnerAtStartup) {
      // Refresh before descendant checks so a parent awaiting_report task does not stay
      // blocked by a child that this startup pass just interrupted.
      config = this.config.loadConfigOrDefault();
      taskIndex = this.buildAgentTaskIndex(config);
      ({ awaitingReportTasks, runningTasks } = listStartupRecoveryCandidates(config));
    }

    let resumedAwaitingReportCount = 0;
    let skippedAwaitingReportDueToActiveDescendants = 0;
    let failedAwaitingReportCount = 0;

    for (const task of awaitingReportTasks) {
      if (!task.id) continue;

      if (
        await this.interruptTaskRecoveryForInactiveWorkflowOwner(
          task.id,
          config,
          "startup-awaiting-report",
          taskIndex
        )
      ) {
        continue;
      }

      // Avoid resuming a task while it still has active descendants (it shouldn't report yet).
      const hasActiveDescendants = this.hasActiveDescendantAgentTasksUsingIndex(taskIndex, task.id);
      if (hasActiveDescendants) {
        skippedAwaitingReportDueToActiveDescendants += 1;
        continue;
      }

      const resumed = await this.promptTaskForRequiredCompletionTool(task.id, {
        reason: "startup",
      });
      if (!resumed) {
        failedAwaitingReportCount += 1;
        continue;
      }

      resumedAwaitingReportCount += 1;
    }

    let resumedRunningCount = 0;
    let skippedRunningDueToActiveDescendants = 0;
    let failedRunningCount = 0;

    for (const task of runningTasks) {
      if (!task.id) continue;
      if (
        await this.interruptTaskRecoveryForInactiveWorkflowOwner(
          task.id,
          config,
          "startup-running",
          taskIndex
        )
      ) {
        continue;
      }

      // Best-effort: if mux restarted mid-stream, nudge the agent to continue and report.
      // Only do this when the task has no running descendants, to avoid duplicate spawns.
      const hasActiveDescendants = this.hasActiveDescendantAgentTasksUsingIndex(taskIndex, task.id);
      if (hasActiveDescendants) {
        skippedRunningDueToActiveDescendants += 1;
        continue;
      }

      const isPlanLike = await this.isPlanLikeTaskWorkspace({
        projectPath: task.projectPath,
        workspace: task,
      });

      const model = task.taskModelString ?? defaultModel;
      const agentId = resolveTaskAgentIdForResume(task);
      log.info("[startup] Resuming running task", {
        taskId: task.id,
        taskName: task.name,
        projectPath: task.projectPath,
        model,
        agentId,
        isPlanLike,
      });
      const resumeStartedAt = Date.now();
      const restartCompletionInstruction = isPlanLike
        ? "When you have a final plan, call propose_plan exactly once."
        : "When you have a final answer, call agent_report exactly once.";
      const sendResult = await this.workspaceService.sendMessage(
        task.id,
        "Mux restarted while this task was running. Continue where you left off. " +
          restartCompletionInstruction,
        {
          model,
          agentId,
          thinkingLevel: task.taskThinkingLevel,
          experiments: task.taskExperiments,
        },
        { synthetic: true, agentInitiated: true }
      );
      const durationMs = Date.now() - resumeStartedAt;
      if (!sendResult.success) {
        failedRunningCount += 1;
        log.error("Failed to resume running task on startup", {
          taskId: task.id,
          taskName: task.name,
          projectPath: task.projectPath,
          model,
          agentId,
          isPlanLike,
          durationMs,
          error: sendResult.error,
        });
        continue;
      }

      resumedRunningCount += 1;
      log.info("[startup] Resumed running task", {
        taskId: task.id,
        taskName: task.name,
        projectPath: task.projectPath,
        model,
        agentId,
        isPlanLike,
        durationMs,
      });
    }

    if (interruptedInactiveWorkflowOwnerAtStartup) {
      // Startup queue draining already ran before these interruptions freed slots.
      // Run it once more after recovery prompts so unrelated queued work is not stranded.
      await this.maybeStartQueuedTasks();
      config = this.config.loadConfigOrDefault();
    }

    // Restart-safety for git patch artifacts:
    // - If mux crashed mid-generation, patch artifacts can be left "pending".
    // - Completed tasks can be stranded in config until cleanup runs again, so restart should
    //   resume artifact generation and re-run the deletion pass.
    const completedReportTasks = this.listAgentTaskWorkspaces(config).filter(
      (task) => hasCompletedAgentReport(task) && typeof task.id === "string" && task.id.length > 0
    );

    const patchGenerationRecoveryStartedAt = Date.now();
    for (const task of completedReportTasks) {
      if (!task.parentWorkspaceId) continue;
      try {
        await this.gitPatchArtifactService.maybeStartGeneration(
          task.parentWorkspaceId,
          task.id!,
          (wsId) => this.requestReportedTaskCleanupRecheck(wsId)
        );
      } catch (error: unknown) {
        log.error("Failed to resume subagent git patch generation on startup", {
          parentWorkspaceId: task.parentWorkspaceId,
          childWorkspaceId: task.id,
          error,
        });
      }
    }
    const patchGenerationRecoveryMs = Date.now() - patchGenerationRecoveryStartedAt;

    // Restart-safety for grouped best-of completion: if child report artifacts already exist
    // on disk after a restart, there may be no later child stream-end to finalize the pending
    // parent task tool call. Re-run the deferred parent delivery/finalization pass first so
    // cleanup rechecks do not stay blocked forever behind a stale input-available partial.
    const bestOfRecoveryStartedAt = Date.now();
    const bestOfParentWorkspaceIds = new Set<string>();
    for (const task of completedReportTasks) {
      const parentWorkspaceId = coerceNonEmptyString(task.parentWorkspaceId);
      if (!parentWorkspaceId || (task.bestOf?.total ?? 1) <= 1) {
        continue;
      }
      if (this.aiService.isStreaming(parentWorkspaceId)) {
        continue;
      }
      bestOfParentWorkspaceIds.add(parentWorkspaceId);
    }
    for (const parentWorkspaceId of bestOfParentWorkspaceIds) {
      await this.deliverDeferredBestOfReportsForParent(parentWorkspaceId);
    }
    const bestOfRecoveryMs = Date.now() - bestOfRecoveryStartedAt;

    // Best-effort completed-report ancestor recheck after restart.
    const cleanupReportedTasksStartedAt = Date.now();
    for (const task of completedReportTasks) {
      if (!task.id) continue;
      await this.cleanupReportedLeafTask(task.id);
    }
    const cleanupReportedTasksMs = Date.now() - cleanupReportedTasksStartedAt;

    log.info("[startup] TaskService.initialize completed", {
      totalMs: Date.now() - startupStartedAt,
      maybeStartQueuedTasksMs,
      awaitingReportTaskCount: awaitingReportTasks.length,
      resumedAwaitingReportCount,
      skippedAwaitingReportDueToActiveDescendants,
      failedAwaitingReportCount,
      runningTaskCount: runningTasks.length,
      resumedRunningCount,
      skippedRunningDueToActiveDescendants,
      failedRunningCount,
      completedReportTaskCount: completedReportTasks.length,
      patchGenerationRecoveryMs,
      bestOfParentRecoveryCount: bestOfParentWorkspaceIds.size,
      bestOfRecoveryMs,
      cleanupReportedTasksMs,
    });
  }

  private async hasAcceptedInitialTaskPrompt(workspaceId: string): Promise<boolean> {
    assert(workspaceId.length > 0, "hasAcceptedInitialTaskPrompt: workspaceId must be non-empty");

    const historyResult = await this.historyService.getHistoryFromLatestBoundary(workspaceId);
    if (!historyResult.success) {
      log.warn("Failed to inspect task history during stale starting recovery", {
        workspaceId,
        error: historyResult.error,
      });
      return false;
    }

    return historyResult.data.some((message) => message.role === "user");
  }

  private startWorkspaceInit(workspaceId: string, projectPath: string): InitLogger {
    assert(workspaceId.length > 0, "startWorkspaceInit: workspaceId must be non-empty");
    assert(projectPath.length > 0, "startWorkspaceInit: projectPath must be non-empty");

    this.initStateManager.startInit(workspaceId, projectPath);
    return {
      logStep: (message: string) => this.initStateManager.appendOutput(workspaceId, message, false),
      logStdout: (line: string) => this.initStateManager.appendOutput(workspaceId, line, false),
      logStderr: (line: string) => this.initStateManager.appendOutput(workspaceId, line, true),
      logComplete: (exitCode: number) => void this.initStateManager.endInit(workspaceId, exitCode),
      enterHookPhase: () => this.initStateManager.enterHookPhase(workspaceId),
    };
  }

  async createMany(
    argsList: TaskCreateArgs[],
    options: TaskCreateManyOptions = {}
  ): Promise<Result<TaskCreateResult[], string>> {
    if (argsList.length === 0) {
      return Ok([]);
    }

    // sharedWorkspacePath is set for honored isolation: "none" plans; the entry is persisted
    // pointing at the parent's checkout and startReservedAgentTask reuses it without fork/init.
    const plans: Array<
      TaskLaunchPlan & { status: "queued" | "starting"; sharedWorkspacePath?: string }
    > = [];
    const results: TaskCreateResult[] = [];

    await using _lock = await this.mutex.acquire();

    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    let reservedActiveCount =
      this.countActiveAgentTasks(cfg) + (await this.countActiveWorkspaceTurns());

    for (const args of argsList) {
      const parentWorkspaceId = coerceNonEmptyString(args.parentWorkspaceId);
      if (!parentWorkspaceId) return Err("Task.createMany: parentWorkspaceId is required");
      if (args.kind !== "agent") return Err("Task.createMany: unsupported kind");

      const prompt = coerceNonEmptyString(args.prompt);
      if (!prompt) return Err("Task.createMany: prompt is required");

      const normalizedAgentId = normalizeAgentId(args.agentId ?? args.agentType, "");
      if (!normalizedAgentId) return Err("Task.createMany: agentId is required");
      const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
      if (!parsedAgentId.success) {
        return Err(`Task.createMany: invalid agentId (${normalizedAgentId})`);
      }
      const agentId = parsedAgentId.data;
      const agentType = agentId;

      let normalizedBestOf: TaskCreateArgs["bestOf"];
      const bestOf = args.bestOf;
      if (bestOf) {
        const groupId = coerceNonEmptyString(bestOf.groupId);
        if (!groupId)
          return Err("Task.createMany: bestOf.groupId is required when bestOf is provided");
        if (!Number.isInteger(bestOf.index) || bestOf.index < 0) {
          return Err("Task.createMany: bestOf.index must be a non-negative integer");
        }
        if (!Number.isInteger(bestOf.total) || bestOf.total < 2) {
          return Err("Task.createMany: bestOf.total must be an integer >= 2");
        }
        if (bestOf.index >= bestOf.total) {
          return Err("Task.createMany: bestOf.index must be less than bestOf.total");
        }
        const kind = normalizeTaskGroupKind(bestOf.kind);
        const label = normalizeTaskGroupLabel(bestOf.label);
        if (kind === TASK_GROUP_KIND.VARIANTS && !label) {
          return Err("Task.createMany: bestOf.label is required when bestOf.kind is variants");
        }
        if (kind !== TASK_GROUP_KIND.VARIANTS && label) {
          return Err("Task.createMany: bestOf.label is only allowed when bestOf.kind is variants");
        }
        normalizedBestOf = {
          groupId,
          index: bestOf.index,
          total: bestOf.total,
          kind,
          ...(label ? { label } : {}),
        };
      }

      const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
      if (!parentMetaResult.success) {
        return Err(`Task.createMany: parent workspace not found (${parentMetaResult.error})`);
      }
      const parentMeta = parentMetaResult.data;

      const taskProjectConfig = cfg.projects.get(stripTrailingSlashes(parentMeta.projectPath));
      if (!taskProjectConfig?.trusted) {
        return Err(
          "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
        );
      }

      const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
      if (parentEntry?.workspace.taskStatus === "reported") {
        return Err("Task.createMany: cannot spawn new tasks after agent_report");
      }

      const requestedDepth = this.getTaskDepth(cfg, parentWorkspaceId) + 1;
      if (requestedDepth > taskSettings.maxTaskNestingDepth) {
        return Err(
          `Task.createMany: maxTaskNestingDepth exceeded (requestedDepth=${requestedDepth}, max=${taskSettings.maxTaskNestingDepth})`
        );
      }

      const taskId = this.config.generateStableId();
      const workspaceName = buildAgentWorkspaceName(agentId, taskId);
      const nameValidation = validateWorkspaceName(workspaceName);
      if (!nameValidation.valid) {
        return Err(
          `Task.createMany: generated workspace name invalid (${nameValidation.error ?? "unknown error"})`
        );
      }

      const { taskModelString, canonicalModel, effectiveThinkingLevel } =
        this.resolveTaskAISettings({
          cfg,
          parentMeta,
          agentId,
          modelString: args.modelString,
          thinkingLevel: args.thinkingLevel,
          parentRuntimeAiSettings: args.parentRuntimeAiSettings,
        });

      const parentRuntimeConfig = parentMeta.runtimeConfig;
      const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;
      // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) resolve the
      // parent's REAL checkout when the parent is itself an isolation: "none" task (see create()).
      const runtime = createRuntimeForWorkspace({
        runtimeConfig: taskRuntimeConfig,
        projectPath: parentMeta.projectPath,
        name: parentMeta.name,
        namedWorkspacePath: coerceNonEmptyString(parentEntry?.workspace.path),
      });
      // Prefer the parent's persisted checkout path over the name-derived one: when the parent is
      // itself an isolation: "none" task, its name is synthetic and the derived path does not
      // exist — its real checkout is the persisted (shared) path.
      const isInPlace = parentMeta.projectPath === parentMeta.name;
      const parentWorkspacePath = isInPlace
        ? parentMeta.projectPath
        : (coerceNonEmptyString(parentEntry?.workspace.path) ??
          runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name));

      // isolation: "none" — same gating as create(): only worktree/SSH single-project parents
      // share the parent checkout; everything else falls back to the normal fork path.
      const taskRuntimeMode = getRuntimeType(taskRuntimeConfig);
      const parentIsMultiProject = (parentMeta.projects?.length ?? 0) > 1;
      const useSharedWorkspace =
        args.isolation === "none" &&
        runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
        !parentIsMultiProject;
      const sharedWorkspacePath = useSharedWorkspace ? parentWorkspacePath : undefined;
      // Branch actually checked out in the parent's checkout (see create() for rationale).
      const parentIsSharedTask = parentEntry?.workspace.taskIsolation === "none";
      const parentBranchName = parentIsSharedTask
        ? (coerceNonEmptyString(parentEntry?.workspace.taskTrunkBranch) ??
          coerceNonEmptyString(parentMeta.name))
        : coerceNonEmptyString(parentMeta.name);
      if (args.isolation === "none" && !useSharedWorkspace) {
        log.debug("Task.createMany: isolation=none not honored; falling back to fork", {
          taskId,
          runtimeMode: taskRuntimeMode,
          parentIsMultiProject,
        });
      }

      const getRunnableHint = async (): Promise<string> => {
        try {
          const allAgents = await discoverAgentDefinitions(runtime, parentWorkspacePath);
          const runnableIds = (
            await Promise.all(
              allAgents.map(async (agent) => {
                try {
                  const frontmatter = await resolveAgentFrontmatter(
                    runtime,
                    parentWorkspacePath,
                    agent.id,
                    { skipScopesAbove: getSkipScopesAboveForKnownScope(agent.scope) }
                  );
                  if (frontmatter.subagent?.runnable !== true) return null;
                  return isAgentEffectivelyDisabled({
                    cfg,
                    agentId: agent.id,
                    resolvedFrontmatter: frontmatter,
                  })
                    ? null
                    : agent.id;
                } catch {
                  return null;
                }
              })
            )
          ).filter((id): id is string => typeof id === "string");
          return runnableIds.length > 0
            ? `Runnable agentIds: ${runnableIds.join(", ")}`
            : "No runnable agents available";
        } catch {
          return "Could not discover available agents";
        }
      };

      let skipInitHook = false;
      try {
        const frontmatter = await resolveAgentFrontmatter(runtime, parentWorkspacePath, agentId);
        if (frontmatter.subagent?.runnable !== true) {
          const hint = await getRunnableHint();
          return Err(
            `Task.createMany: agentId is not runnable as a sub-agent (${agentId}). ${hint}`
          );
        }
        if (isAgentEffectivelyDisabled({ cfg, agentId, resolvedFrontmatter: frontmatter })) {
          const hint = await getRunnableHint();
          return Err(`Task.createMany: agentId is disabled (${agentId}). ${hint}`);
        }
        skipInitHook = frontmatter.subagent?.skip_init_hook === true;
      } catch {
        const hint = await getRunnableHint();
        return Err(`Task.createMany: unknown agentId (${agentId}). ${hint}`);
      }

      const status: "queued" | "starting" =
        reservedActiveCount >= taskSettings.maxParallelAgentTasks ? "queued" : "starting";
      if (status === "starting") reservedActiveCount += 1;

      const createdAt = getIsoNow();
      plans.push({
        taskId,
        parentWorkspaceId,
        parentMeta,
        agentId,
        agentType,
        start: { kind: "sendMessage", prompt },
        title: args.title,
        workspaceName,
        createdAt,
        taskRuntimeConfig,
        parentRuntimeConfig,
        taskModelString,
        canonicalModel,
        effectiveThinkingLevel,
        skipInitHook,
        workflowTask: args.workflowTask,
        bestOf: normalizedBestOf,
        experiments: args.experiments,
        onRefusal: args.onRefusal,
        status,
        ...(sharedWorkspacePath != null ? { sharedWorkspacePath } : {}),
        // Real branch checked out in the parent's checkout: persisted as taskTrunkBranch and used
        // by orchestrateFork's create-fallback when the fork cannot detect a source branch
        // (a shared parent's synthetic name never names a real branch). Gated to shared parents
        // to keep the existing branch-discovery fallback otherwise.
        ...(parentIsSharedTask && parentBranchName != null
          ? { preferredTrunkBranch: parentBranchName }
          : {}),
      });
      results.push({ taskId, kind: "agent", status });
    }

    for (const [index, result] of results.entries()) {
      // Workflow callers durably checkpoint returned task IDs before task records are persisted.
      // If config persistence fails afterward, replay sees a started step whose task is not found
      // and restarts it instead of duplicating an already-launched child after a crash.
      await options.onTaskReserved?.(index, result);
    }

    await this.config.editConfig((config) => {
      for (const plan of plans) {
        const runtime = createRuntimeForWorkspace({
          runtimeConfig: plan.taskRuntimeConfig,
          projectPath: plan.parentMeta.projectPath,
          name: plan.parentMeta.name,
        });
        const workspacePath =
          plan.sharedWorkspacePath ??
          runtime.getWorkspacePath(plan.parentMeta.projectPath, plan.workspaceName);
        const trunkBranch =
          coerceNonEmptyString(plan.preferredTrunkBranch) ??
          coerceNonEmptyString(plan.parentMeta.name);
        if (!trunkBranch) {
          throw new Error("Task.createMany: parent workspace name missing");
        }
        let projectConfig = config.projects.get(plan.parentMeta.projectPath);
        if (!projectConfig) {
          projectConfig = { workspaces: [] };
          config.projects.set(plan.parentMeta.projectPath, projectConfig);
        }
        projectConfig.workspaces.push({
          path: workspacePath,
          id: plan.taskId,
          name: plan.workspaceName,
          title: plan.title,
          createdAt: plan.createdAt,
          runtimeConfig: plan.taskRuntimeConfig,
          aiSettings:
            plan.effectiveThinkingLevel !== undefined
              ? { model: plan.canonicalModel, thinkingLevel: plan.effectiveThinkingLevel }
              : undefined,
          parentWorkspaceId: plan.parentWorkspaceId,
          agentId: plan.agentId,
          agentType: plan.agentType,
          workflowTask: plan.workflowTask,
          bestOf: plan.bestOf,
          taskStatus: plan.status,
          taskPrompt: plan.start.kind === "sendMessage" ? plan.start.prompt : undefined,
          taskTrunkBranch: trunkBranch,
          taskModelString: plan.taskModelString,
          taskThinkingLevel: plan.effectiveThinkingLevel,
          taskOnRefusal: plan.onRefusal,
          taskExperiments: plan.experiments,
          taskIsolation: plan.sharedWorkspacePath != null ? "none" : undefined,
          projects: plan.parentMeta.projects,
        });
      }
      return config;
    });

    for (const result of results) {
      await this.emitWorkspaceMetadata(result.taskId);
    }
    for (const plan of plans) {
      if (plan.status === "starting") {
        this.scheduleReservedTaskLaunch(plan);
      }
    }
    if (plans.some((plan) => plan.status === "queued")) {
      this.scheduleMaybeStartQueuedTasks();
    }

    return Ok(results);
  }

  private async cleanupMaterializedTaskWorkspace(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string,
    options?: {
      /**
       * Skip physical workspace deletion. Required for isolation: "none" tasks whose runtime
       * resolves this task's name to the shared parent checkout (e.g. SSHRuntime.deleteWorkspace
       * goes through the persisted-path override) — deleting it would destroy the parent's
       * working tree. Session/config cleanup still runs.
       */
      preservePhysicalWorkspace?: boolean;
    }
  ): Promise<void> {
    assert(projectPath.length > 0, "cleanupMaterializedTaskWorkspace requires projectPath");
    assert(workspaceName.length > 0, "cleanupMaterializedTaskWorkspace requires workspaceName");
    assert(taskId.length > 0, "cleanupMaterializedTaskWorkspace requires taskId");

    if (options?.preservePhysicalWorkspace) {
      log.debug("Task launch cleanup: preserving shared parent checkout", { taskId });
    } else {
      try {
        const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
        if (!deleteResult.success) {
          log.error("Task launch cleanup: failed to delete materialized workspace", {
            taskId,
            error: deleteResult.error,
          });
        }
      } catch (error: unknown) {
        log.error("Task launch cleanup: runtime.deleteWorkspace threw", {
          taskId,
          error: getErrorMessage(error),
        });
      }
    }

    try {
      const sessionDir = this.config.getSessionDir(taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task launch cleanup: failed to remove session directory", {
        taskId,
        error: getErrorMessage(error),
      });
    }
  }

  private async getExistingMaterializedTaskLaunch(
    plan: TaskLaunchPlan,
    sourceRuntime: Runtime,
    workspace: WorkspaceConfigEntry
  ): Promise<MaterializedTaskLaunch | null> {
    const workspacePath =
      coerceNonEmptyString(workspace.path) ??
      sourceRuntime.getWorkspacePath(plan.parentMeta.projectPath, plan.workspaceName);
    if (!(await runtimePathExists(sourceRuntime, workspacePath))) {
      return null;
    }

    const forkedRuntimeConfig = workspace.runtimeConfig ?? plan.taskRuntimeConfig;
    const runtimeForTaskWorkspace = createRuntimeForWorkspace({
      runtimeConfig: forkedRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      name: plan.workspaceName,
      namedWorkspacePath: workspacePath,
    });
    const trunkBranch =
      coerceNonEmptyString(workspace.taskTrunkBranch) ??
      coerceNonEmptyString(plan.preferredTrunkBranch) ??
      coerceNonEmptyString(plan.parentMeta.name) ??
      plan.workspaceName;

    return {
      workspacePath,
      trunkBranch,
      forkedRuntimeConfig,
      runtimeForTaskWorkspace,
      inheritedProjects: workspace.projects ?? plan.parentMeta.projects,
    };
  }

  private async runProjectForkExclusive<T>(projectPath: string, fn: () => Promise<T>): Promise<T> {
    assert(projectPath.length > 0, "runProjectForkExclusive requires projectPath");

    const previousLaunch =
      this.reservedTaskLaunchByProjectPath.get(projectPath) ?? Promise.resolve();
    const run = previousLaunch.catch(() => undefined).then(fn);
    const trackedLaunch = run
      .then(
        () => undefined,
        () => undefined
      )
      .finally(() => {
        if (this.reservedTaskLaunchByProjectPath.get(projectPath) === trackedLaunch) {
          this.reservedTaskLaunchByProjectPath.delete(projectPath);
        }
      });
    this.reservedTaskLaunchByProjectPath.set(projectPath, trackedLaunch);
    return await run;
  }

  private async materializeReservedTaskWorkspace(
    plan: TaskLaunchPlan,
    sourceRuntime: Runtime,
    initLogger: InitLogger
  ): Promise<MaterializedTaskLaunch | null> {
    const entry = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
    if (entry?.workspace.taskStatus !== "starting") {
      return null;
    }

    const existing = await this.getExistingMaterializedTaskLaunch(
      plan,
      sourceRuntime,
      entry.workspace
    );
    if (existing) {
      taskQueueDebug("TaskService.startReservedAgentTask reusing materialized workspace", {
        taskId: plan.taskId,
        workspacePath: existing.workspacePath,
      });
      return existing;
    }

    const projectPath = stripTrailingSlashes(plan.parentMeta.projectPath);
    return await this.runProjectForkExclusive(projectPath, async () => {
      const entryBeforeFork = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
      if (entryBeforeFork?.workspace.taskStatus !== "starting") {
        return null;
      }

      const forkResult = await orchestrateFork({
        sourceRuntime,
        projectPath: plan.parentMeta.projectPath,
        sourceWorkspaceName: plan.parentMeta.name,
        newWorkspaceName: plan.workspaceName,
        initLogger,
        config: this.config,
        sourceWorkspaceId: plan.parentWorkspaceId,
        sourceRuntimeConfig: plan.parentRuntimeConfig,
        parentMetadata: plan.parentMeta,
        allowCreateFallback: true,
        ...(plan.preferredTrunkBranch != null
          ? { preferredTrunkBranch: plan.preferredTrunkBranch }
          : {}),
        trusted:
          this.config
            .loadConfigOrDefault()
            .projects.get(stripTrailingSlashes(plan.parentMeta.projectPath))?.trusted ?? false,
        multiProjectExperimentEnabled: this.workspaceService.isExperimentEnabled(
          EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
        ),
      });

      if (!forkResult.success) {
        throw new Error(`Task fork failed: ${forkResult.error}`);
      }

      return {
        workspacePath: forkResult.data.workspacePath,
        trunkBranch: forkResult.data.trunkBranch,
        forkedRuntimeConfig: forkResult.data.forkedRuntimeConfig,
        runtimeForTaskWorkspace: forkResult.data.targetRuntime,
        inheritedProjects: forkResult.data.projects,
        ...(forkResult.data.sourceRuntimeConfigUpdate != null
          ? { sourceRuntimeConfigUpdate: forkResult.data.sourceRuntimeConfigUpdate }
          : {}),
      };
    });
  }

  private scheduleReservedTaskLaunch(plan: TaskLaunchPlan): void {
    assert(plan.taskId.length > 0, "scheduleReservedTaskLaunch requires taskId");
    void this.enqueueReservedTaskLaunch(plan).catch((error: unknown) => {
      log.error("Failed to launch reserved task", { taskId: plan.taskId, error });
      void this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error));
    });
  }

  private scheduleMaybeStartQueuedTasks(): void {
    void this.maybeStartQueuedTasks().catch((error: unknown) => {
      log.error("TaskService.maybeStartQueuedTasks failed", { error });
    });
  }

  private async markTaskLaunchFailed(taskId: string, message: string): Promise<void> {
    assert(taskId.length > 0, "markTaskLaunchFailed requires taskId");
    await this.editWorkspaceEntry(
      taskId,
      (ws) => {
        ws.taskStatus = "interrupted";
        ws.taskLaunchError = message;
      },
      { allowMissing: true }
    );
    await this.emitWorkspaceMetadata(taskId);
    this.rejectWaiters(taskId, new Error(message));
    this.scheduleMaybeStartQueuedTasks();
  }

  private async startReservedAgentTask(plan: TaskLaunchPlan): Promise<void> {
    assert(plan.taskId.length > 0, "startReservedAgentTask requires taskId");
    assert(plan.parentWorkspaceId.length > 0, "startReservedAgentTask requires parentWorkspaceId");
    if (plan.start.kind === "sendMessage") {
      assert(plan.start.prompt.length > 0, "startReservedAgentTask requires prompt");
    }

    const entryAtStart = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
    if (entryAtStart?.workspace.taskStatus !== "starting") {
      return;
    }

    // isolation: "none" tasks were queued pointing at the parent's checkout. When that checkout
    // still exists, materialization reuses it (no fork); if it disappeared, materialization falls
    // back to forking a real workspace and the shared flag must be cleared below.
    const taskWasShared = entryAtStart.workspace.taskIsolation === "none";
    const persistedSharedPath = taskWasShared
      ? coerceNonEmptyString(entryAtStart.workspace.path)
      : undefined;

    const initLogger = this.startWorkspaceInit(plan.taskId, plan.parentMeta.projectPath);
    // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) fork from the
    // parent's REAL checkout when the parent is itself an isolation: "none" task (see create()).
    const parentEntryForLaunch = findWorkspaceEntry(
      this.config.loadConfigOrDefault(),
      plan.parentWorkspaceId
    );
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: plan.taskRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      name: plan.parentMeta.name,
      namedWorkspacePath: coerceNonEmptyString(parentEntryForLaunch?.workspace.path),
    });

    let materialized: MaterializedTaskLaunch | null;
    try {
      materialized = await this.materializeReservedTaskWorkspace(plan, runtime, initLogger);
    } catch (error: unknown) {
      initLogger.logComplete(-1);
      throw error;
    }
    if (!materialized) {
      initLogger.logComplete(-1);
      return;
    }

    // Reuse of the persisted shared path means the task still runs in the parent's checkout;
    // any other materialized path means the fork fallback created a real (deletable) workspace.
    const sharesParentCheckout =
      taskWasShared && materialized.workspacePath === persistedSharedPath;

    const entryAfterMaterialize = findWorkspaceEntry(
      this.config.loadConfigOrDefault(),
      plan.taskId
    );
    if (!entryAfterMaterialize) {
      initLogger.logComplete(-1);
      await this.cleanupMaterializedTaskWorkspace(
        materialized.runtimeForTaskWorkspace,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        plan.taskId,
        { preservePhysicalWorkspace: sharesParentCheckout }
      );
      return;
    }
    if (entryAfterMaterialize.workspace.taskStatus !== "starting") {
      initLogger.logComplete(-1);
      return;
    }

    if (materialized.sourceRuntimeConfigUpdate) {
      await this.config.updateWorkspaceMetadata(plan.parentWorkspaceId, {
        runtimeConfig: materialized.sourceRuntimeConfigUpdate,
      });
      await this.emitWorkspaceMetadata(plan.parentWorkspaceId);
    }

    const {
      workspacePath,
      trunkBranch,
      forkedRuntimeConfig,
      runtimeForTaskWorkspace,
      inheritedProjects,
    } = materialized;

    this.configureMultiProjectRuntimeEnvResolver(runtimeForTaskWorkspace);
    const taskBaseCommitShaByProjectPath = await readTaskBaseCommitShaByProjectPath({
      workspaceId: plan.taskId,
      workspaceName: plan.workspaceName,
      workspacePath,
      runtimeConfig: forkedRuntimeConfig,
      projectPath: plan.parentMeta.projectPath,
      projectName: plan.parentMeta.projectName,
      projects: inheritedProjects,
      runtime: runtimeForTaskWorkspace,
    });
    const taskBaseCommitSha = taskBaseCommitShaByProjectPath[plan.parentMeta.projectPath];

    await this.editWorkspaceEntry(
      plan.taskId,
      (ws) => {
        if (ws.taskStatus !== "starting") {
          return;
        }
        ws.path = workspacePath;
        ws.runtimeConfig = forkedRuntimeConfig;
        ws.taskTrunkBranch = trunkBranch;
        ws.taskBaseCommitSha = taskBaseCommitSha ?? undefined;
        ws.taskBaseCommitShaByProjectPath = taskBaseCommitShaByProjectPath;
        ws.projects = inheritedProjects;
        // The shared parent checkout was gone, so this task had to fork a real workspace.
        // Clear the shared flag so removal cleans up the new worktree.
        if (taskWasShared && !sharesParentCheckout) {
          ws.taskIsolation = undefined;
        }
      },
      { allowMissing: true }
    );
    await this.emitWorkspaceMetadata(plan.taskId);

    const entryBeforeSend = findWorkspaceEntry(this.config.loadConfigOrDefault(), plan.taskId);
    if (!entryBeforeSend) {
      initLogger.logComplete(-1);
      await this.cleanupMaterializedTaskWorkspace(
        runtimeForTaskWorkspace,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        plan.taskId,
        { preservePhysicalWorkspace: sharesParentCheckout }
      );
      return;
    }
    if (entryBeforeSend.workspace.taskStatus !== "starting") {
      initLogger.logComplete(-1);
      return;
    }

    if (sharesParentCheckout) {
      // The parent's checkout is already initialized and live; re-running init would redundantly
      // (and possibly disruptively) mutate it. Skip init entirely.
      initLogger.logStep("Sharing parent workspace (isolation: none) — skipping fork and init");
      initLogger.logComplete(0);
    } else {
      const secrets = await secretsToRecord(
        this.config.getEffectiveSecrets(plan.parentMeta.projectPath),
        this.opResolver
      );
      runBackgroundInit(
        runtimeForTaskWorkspace,
        {
          projectPath: plan.parentMeta.projectPath,
          branchName: plan.workspaceName,
          trunkBranch,
          workspacePath,
          initLogger,
          env: secrets,
          skipInitHook: plan.skipInitHook,
          trusted:
            this.config
              .loadConfigOrDefault()
              .projects.get(stripTrailingSlashes(plan.parentMeta.projectPath))?.trusted ?? false,
        },
        plan.taskId
      );
    }

    const startOptions = {
      model: plan.taskModelString,
      agentId: plan.agentId,
      thinkingLevel: plan.effectiveThinkingLevel,
      experiments: plan.experiments,
    };
    const sendResult =
      plan.start.kind === "sendMessage"
        ? await this.workspaceService.sendMessage(plan.taskId, plan.start.prompt, startOptions, {
            allowQueuedAgentTask: true,
            agentInitiated: true,
          })
        : await this.workspaceService.resumeStream(plan.taskId, startOptions, {
            allowQueuedAgentTask: true,
            agentInitiated: true,
          });
    if (!sendResult.success) {
      const message =
        typeof sendResult.error === "string"
          ? sendResult.error
          : formatSendMessageError(sendResult.error).message;
      await this.cleanupMaterializedTaskWorkspace(
        runtimeForTaskWorkspace,
        plan.parentMeta.projectPath,
        plan.workspaceName,
        plan.taskId,
        { preservePhysicalWorkspace: sharesParentCheckout }
      );
      throw new Error(message);
    }

    await this.setTaskStatus(plan.taskId, "running");
    this.scheduleMaybeStartQueuedTasks();
  }

  async createWorkspaceTurn(
    args: WorkspaceTurnCreateArgs
  ): Promise<Result<WorkspaceTurnCreateResult, string>> {
    const ownerWorkspaceId = coerceNonEmptyString(args.ownerWorkspaceId);
    if (!ownerWorkspaceId) {
      return Err("Task.createWorkspaceTurn: ownerWorkspaceId is required");
    }
    const prompt = coerceNonEmptyString(args.prompt);
    if (!prompt) {
      return Err("Task.createWorkspaceTurn: prompt is required");
    }
    const title = coerceNonEmptyString(args.title) ?? "Workspace task";
    const mode = args.workspace?.mode ?? "new";
    if (mode !== "new" && mode !== "fork" && mode !== "existing") {
      return Err("Task.createWorkspaceTurn: unsupported workspace mode");
    }

    await using _lock = await this.mutex.acquire();

    const parentMetaResult = await this.aiService.getWorkspaceMetadata(ownerWorkspaceId);
    if (!parentMetaResult.success) {
      return Err(`Task.createWorkspaceTurn: owner workspace not found (${parentMetaResult.error})`);
    }
    const parentMeta = parentMetaResult.data;
    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;
    const taskProjectConfig = cfg.projects.get(stripTrailingSlashes(parentMeta.projectPath));
    if ((parentMeta.projects?.length ?? 0) > 1) {
      // WorkspaceService.create only materializes one project checkout; fail loudly instead of
      // silently dropping secondary repos from a multi-project caller's task context.
      return Err("Task.createWorkspaceTurn: multi-project workspace turns are not supported yet");
    }
    if (!taskProjectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }

    const allWorkspaceTurns = await this.taskHandleStore.listAllWorkspaceTurns();
    const ownerWorkspaceTurns = allWorkspaceTurns.filter(
      (record) => record.ownerWorkspaceId === ownerWorkspaceId
    );
    const activeWorkspaceTurnCount = await this.countActiveWorkspaceTurns(allWorkspaceTurns);
    const activeAgentCount = this.countActiveAgentTasks(cfg);
    if (activeAgentCount + activeWorkspaceTurnCount >= taskSettings.maxParallelAgentTasks) {
      return Err(
        `Task.createWorkspaceTurn: maxParallelAgentTasks exceeded (active=${activeAgentCount + activeWorkspaceTurnCount}, max=${taskSettings.maxParallelAgentTasks})`
      );
    }

    const handleId = `${WORKSPACE_TURN_TASK_ID_PREFIX}${this.config.generateStableId()}`;
    const turnId = this.config.generateStableId();
    const createdAt = getIsoNow();
    let targetWorkspaceId: string;
    let createdWorkspace = false;

    if (mode === "fork") {
      return Err('Task.createWorkspaceTurn: workspace.mode="fork" is not supported yet');
    }

    if (mode === "existing") {
      const existingWorkspaceId = coerceNonEmptyString(args.workspace?.workspaceId);
      if (!existingWorkspaceId) {
        return Err("Task.createWorkspaceTurn: workspace.workspaceId is required for existing mode");
      }
      const ownsExistingWorkspace = ownerWorkspaceTurns.some(
        (record) => record.createdWorkspace && record.workspaceId === existingWorkspaceId
      );
      if (!ownsExistingWorkspace) {
        return Err("Task.createWorkspaceTurn: invalid_scope for existing workspace");
      }
      if (this.aiService.isStreaming(existingWorkspaceId)) {
        return Err("Task.createWorkspaceTurn: existing workspace is busy; wait until it is idle");
      }
      targetWorkspaceId = existingWorkspaceId;
    } else {
      const tags = {
        "mux.taskHandleId": handleId,
        "mux.taskOwnerWorkspaceId": ownerWorkspaceId,
        "mux.taskTurnId": turnId,
      };
      const createResult = await this.workspaceService.create(
        parentMeta.projectPath,
        args.workspace?.branchName,
        args.workspace?.trunkBranch ?? parentMeta.name,
        title,
        parentMeta.runtimeConfig,
        parentMeta.subProjectPath,
        false,
        tags
      );
      if (!createResult.success) {
        return Err(`Task.createWorkspaceTurn: workspace create failed (${createResult.error})`);
      }
      targetWorkspaceId = createResult.data.metadata.id;
      createdWorkspace = true;
    }

    const model =
      coerceNonEmptyString(args.modelString) ??
      coerceNonEmptyString(args.parentRuntimeAiSettings?.modelString) ??
      coerceNonEmptyString(parentMeta.aiSettingsByAgent?.exec?.model) ??
      coerceNonEmptyString(parentMeta.aiSettings?.model) ??
      defaultModel;
    const thinkingLevel =
      args.thinkingLevel != null
        ? resolveThinkingInput(args.thinkingLevel, normalizeToCanonical(model))
        : (args.parentRuntimeAiSettings?.thinkingLevel ??
          parentMeta.aiSettingsByAgent?.exec?.thinkingLevel ??
          parentMeta.aiSettings?.thinkingLevel);

    const record: WorkspaceTurnTaskHandleRecord = {
      kind: "workspace_turn",
      handleId,
      ownerWorkspaceId,
      workspaceId: targetWorkspaceId,
      turnId,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      createdWorkspace,
      disposableWorkspace: createdWorkspace && args.workspace?.disposable === true,
      title,
      prompt,
      modelString: model,
      ...(thinkingLevel != null ? { thinkingLevel } : {}),
    };
    await this.taskHandleStore.upsertWorkspaceTurn(record);
    this.activeWorkspaceTurnHandleByWorkspaceId.set(targetWorkspaceId, {
      handleId,
      ownerWorkspaceId,
    });

    const sendResult = await this.workspaceService.sendMessage(
      targetWorkspaceId,
      prompt,
      {
        model,
        agentId: "exec",
        ...(thinkingLevel != null ? { thinkingLevel } : {}),
        muxMetadata: this.buildWorkspaceTurnMuxMetadata(record),
        experiments: args.experiments,
      },
      {
        startStreamInBackground: true,
        requireIdle: true,
        onAcceptedPreStreamFailure: async (sendError) => {
          const error = formatSendMessageError(sendError).message;
          const current = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
          if (current == null || (current.status !== "starting" && current.status !== "running")) {
            return;
          }
          const next: WorkspaceTurnTaskHandleRecord = {
            ...current,
            status: "error",
            updatedAt: getIsoNow(),
            error,
          };
          await this.settleWorkspaceTurn({
            record: current,
            next,
            waiterSettlement: { status: "error", error: new Error(error) },
          });
        },
        agentInitiated: true,
      }
    );

    if (!sendResult.success) {
      const error = formatSendMessageError(sendResult.error).message;
      const next: WorkspaceTurnTaskHandleRecord = {
        ...record,
        status: "error",
        updatedAt: getIsoNow(),
        error,
      };
      await this.settleWorkspaceTurn({
        record,
        next,
        waiterSettlement: { status: "error", error: new Error(error) },
      });
      return Err(`Task.createWorkspaceTurn: send failed (${error})`);
    }

    return Ok({
      taskId: handleId,
      kind: "workspace_turn",
      status: "running",
      workspaceId: targetWorkspaceId,
    });
  }

  async create(args: TaskCreateArgs): Promise<Result<TaskCreateResult, string>> {
    const parentWorkspaceId = coerceNonEmptyString(args.parentWorkspaceId);
    if (!parentWorkspaceId) {
      return Err("Task.create: parentWorkspaceId is required");
    }
    if (args.kind !== "agent") {
      return Err("Task.create: unsupported kind");
    }

    const prompt = coerceNonEmptyString(args.prompt);
    if (!prompt) {
      return Err("Task.create: prompt is required");
    }

    const normalizedAgentId = normalizeAgentId(args.agentId ?? args.agentType, "");
    if (!normalizedAgentId) {
      return Err("Task.create: agentId is required");
    }

    const parsedAgentId = AgentIdSchema.safeParse(normalizedAgentId);
    if (!parsedAgentId.success) {
      return Err(`Task.create: invalid agentId (${normalizedAgentId})`);
    }

    let normalizedBestOf: TaskCreateArgs["bestOf"];
    const bestOf = args.bestOf;
    if (bestOf) {
      const groupId = coerceNonEmptyString(bestOf.groupId);
      if (!groupId) {
        return Err("Task.create: bestOf.groupId is required when bestOf is provided");
      }
      if (!Number.isInteger(bestOf.index) || bestOf.index < 0) {
        return Err("Task.create: bestOf.index must be a non-negative integer");
      }
      if (!Number.isInteger(bestOf.total) || bestOf.total < 2) {
        return Err("Task.create: bestOf.total must be an integer >= 2");
      }
      if (bestOf.index >= bestOf.total) {
        return Err("Task.create: bestOf.index must be less than bestOf.total");
      }

      const kind = normalizeTaskGroupKind(bestOf.kind);
      const label = normalizeTaskGroupLabel(bestOf.label);
      if (kind === TASK_GROUP_KIND.VARIANTS && !label) {
        return Err("Task.create: bestOf.label is required when bestOf.kind is variants");
      }
      if (kind !== TASK_GROUP_KIND.VARIANTS && label) {
        return Err("Task.create: bestOf.label is only allowed when bestOf.kind is variants");
      }

      normalizedBestOf = {
        groupId,
        index: bestOf.index,
        total: bestOf.total,
        kind,
        ...(label ? { label } : {}),
      };
    }

    const agentId = parsedAgentId.data;
    const agentType = agentId; // Legacy alias for on-disk compatibility.

    await using _lock = await this.mutex.acquire();

    // Validate parent exists and fetch runtime context.
    const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
    if (!parentMetaResult.success) {
      return Err(`Task.create: parent workspace not found (${parentMetaResult.error})`);
    }
    const parentMeta = parentMetaResult.data;

    // Enforce nesting depth.
    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = cfg.taskSettings ?? DEFAULT_TASK_SETTINGS;

    // Trust gate: block task creation for untrusted projects.
    // The frontend shows a confirmation dialog for primary workspace creation,
    // but task spawning bypasses the UI — enforce trust here as defense-in-depth.
    const taskProjectConfig = cfg.projects.get(stripTrailingSlashes(parentMeta.projectPath));
    if (!taskProjectConfig?.trusted) {
      return Err(
        "This project must be trusted before creating workspaces. Trust the project in Settings → Security, or create a workspace from the project page."
      );
    }

    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    if (parentEntry?.workspace.taskStatus === "reported") {
      return Err("Task.create: cannot spawn new tasks after agent_report");
    }

    const requestedDepth = this.getTaskDepth(cfg, parentWorkspaceId) + 1;
    if (requestedDepth > taskSettings.maxTaskNestingDepth) {
      return Err(
        `Task.create: maxTaskNestingDepth exceeded (requestedDepth=${requestedDepth}, max=${taskSettings.maxTaskNestingDepth})`
      );
    }

    // Enforce parallelism (global).
    const activeCount = this.countActiveAgentTasks(cfg) + (await this.countActiveWorkspaceTurns());
    const shouldQueue = activeCount >= taskSettings.maxParallelAgentTasks;

    const taskId = this.config.generateStableId();
    const workspaceName = buildAgentWorkspaceName(agentId, taskId);

    const nameValidation = validateWorkspaceName(workspaceName);
    if (!nameValidation.valid) {
      return Err(
        `Task.create: generated workspace name invalid (${nameValidation.error ?? "unknown error"})`
      );
    }

    const { taskModelString, canonicalModel, effectiveThinkingLevel } = this.resolveTaskAISettings({
      cfg,
      parentMeta,
      agentId,
      modelString: args.modelString,
      thinkingLevel: args.thinkingLevel,
      parentRuntimeAiSettings: args.parentRuntimeAiSettings,
    });

    const parentRuntimeConfig = parentMeta.runtimeConfig;
    const taskRuntimeConfig: RuntimeConfig = parentRuntimeConfig;

    // Supply the parent's persisted path so override-aware runtimes (worktree/SSH) resolve the
    // parent's REAL checkout — critical when the parent is itself an isolation: "none" task whose
    // synthetic name has no derived checkout (agent discovery + fork source both depend on it).
    const runtime = createRuntimeForWorkspace({
      runtimeConfig: taskRuntimeConfig,
      projectPath: parentMeta.projectPath,
      name: parentMeta.name,
      namedWorkspacePath: coerceNonEmptyString(parentEntry?.workspace.path),
    });

    // Validate the agent definition exists and is runnable as a sub-agent.
    // Prefer the parent's persisted checkout path over the name-derived one: when the parent is
    // itself an isolation: "none" task, its name is synthetic and the derived path does not exist —
    // its real checkout is the persisted (shared) path. Persisted paths are canonical elsewhere too
    // (see runtimeHelpers.resolveWorkspaceRootPath).
    const isInPlace = parentMeta.projectPath === parentMeta.name;
    const parentWorkspacePath = isInPlace
      ? parentMeta.projectPath
      : (coerceNonEmptyString(parentEntry?.workspace.path) ??
        runtime.getWorkspacePath(parentMeta.projectPath, parentMeta.name));

    // isolation: "none" — run the sub-agent directly in the parent workspace's checkout instead of
    // forking a new one. Only honored on runtimes where the fork creates a separate checkout we can
    // safely bypass (worktree/SSH) and for single-project parents; otherwise fall back to forking.
    const taskRuntimeMode = getRuntimeType(taskRuntimeConfig);
    const parentIsMultiProject = (parentMeta.projects?.length ?? 0) > 1;
    const useSharedWorkspace =
      args.isolation === "none" &&
      runtimeModeSupportsSharedTaskWorkspace(taskRuntimeMode) &&
      !parentIsMultiProject;
    // The branch actually checked out in the parent's checkout. When the parent is itself an
    // isolation: "none" task, parentMeta.name is a synthetic agent workspace name with no real
    // branch — the shared checkout sits on the parent's own persisted taskTrunkBranch. Persisting
    // the real branch keeps dequeue fork-fallbacks (preferredTrunkBranch) on an existing base.
    const parentIsSharedTask = parentEntry?.workspace.taskIsolation === "none";
    const parentBranchName = parentIsSharedTask
      ? (coerceNonEmptyString(parentEntry?.workspace.taskTrunkBranch) ??
        coerceNonEmptyString(parentMeta.name))
      : coerceNonEmptyString(parentMeta.name);
    if (args.isolation === "none" && !useSharedWorkspace) {
      log.debug("Task.create: isolation=none not honored; falling back to fork", {
        taskId,
        runtimeMode: taskRuntimeMode,
        parentIsMultiProject,
      });
    }

    // Helper to build error hint with all available runnable agents.
    // NOTE: This resolves frontmatter inheritance so same-name overrides (e.g. project exec.md
    // with base: exec) still count as runnable.
    const getRunnableHint = async (): Promise<string> => {
      try {
        const allAgents = await discoverAgentDefinitions(runtime, parentWorkspacePath);

        const runnableIds = (
          await Promise.all(
            allAgents.map(async (agent) => {
              try {
                const frontmatter = await resolveAgentFrontmatter(
                  runtime,
                  parentWorkspacePath,
                  agent.id,
                  {
                    skipScopesAbove: getSkipScopesAboveForKnownScope(agent.scope),
                  }
                );
                if (frontmatter.subagent?.runnable !== true) {
                  return null;
                }

                const effectivelyDisabled = isAgentEffectivelyDisabled({
                  cfg,
                  agentId: agent.id,
                  resolvedFrontmatter: frontmatter,
                });
                return effectivelyDisabled ? null : agent.id;
              } catch {
                return null;
              }
            })
          )
        ).filter((id): id is string => typeof id === "string");

        return runnableIds.length > 0
          ? `Runnable agentIds: ${runnableIds.join(", ")}`
          : "No runnable agents available";
      } catch {
        return "Could not discover available agents";
      }
    };

    let skipInitHook = false;
    try {
      const frontmatter = await resolveAgentFrontmatter(runtime, parentWorkspacePath, agentId);
      if (frontmatter.subagent?.runnable !== true) {
        const hint = await getRunnableHint();
        return Err(`Task.create: agentId is not runnable as a sub-agent (${agentId}). ${hint}`);
      }

      if (
        isAgentEffectivelyDisabled({
          cfg,
          agentId,
          resolvedFrontmatter: frontmatter,
        })
      ) {
        const hint = await getRunnableHint();
        return Err(`Task.create: agentId is disabled (${agentId}). ${hint}`);
      }
      skipInitHook = frontmatter.subagent?.skip_init_hook === true;
    } catch {
      const hint = await getRunnableHint();
      return Err(`Task.create: unknown agentId (${agentId}). ${hint}`);
    }

    const createdAt = getIsoNow();

    taskQueueDebug("TaskService.create decision", {
      parentWorkspaceId,
      taskId,
      agentId,
      workspaceName,
      createdAt,
      activeCount,
      maxParallelAgentTasks: taskSettings.maxParallelAgentTasks,
      shouldQueue,
      runtimeType: taskRuntimeConfig.type,
      workflowRunId: args.workflowTask?.runId,
      workflowStepId: args.workflowTask?.stepId,
      promptLength: prompt.length,
      model: taskModelString,
      thinkingLevel: effectiveThinkingLevel,
    });

    if (shouldQueue) {
      const trunkBranch = parentBranchName;
      if (!trunkBranch) {
        return Err("Task.create: parent workspace name missing (cannot queue task)");
      }

      // NOTE: Queued tasks are persisted immediately, but their workspace is created later
      // when a parallel slot is available. This ensures queued tasks don't create worktrees
      // or run init hooks until they actually start.
      // Shared-workspace (isolation: "none") tasks point at the parent's existing checkout, so the
      // dequeue path sees the directory already exists and skips fork + init.
      const workspacePath = useSharedWorkspace
        ? parentWorkspacePath
        : runtime.getWorkspacePath(parentMeta.projectPath, workspaceName);

      taskQueueDebug("TaskService.create queued (persist-only)", {
        taskId,
        workspaceName,
        parentWorkspaceId,
        trunkBranch,
        workspacePath,
      });

      await this.config.editConfig((config) => {
        let projectConfig = config.projects.get(parentMeta.projectPath);
        if (!projectConfig) {
          projectConfig = { workspaces: [] };
          config.projects.set(parentMeta.projectPath, projectConfig);
        }

        projectConfig.workspaces.push({
          path: workspacePath,
          id: taskId,
          name: workspaceName,
          title: args.title,
          createdAt,
          runtimeConfig: taskRuntimeConfig,
          aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
          parentWorkspaceId,
          agentId,
          agentType,
          workflowTask: args.workflowTask,
          bestOf: normalizedBestOf,
          taskStatus: "queued",
          taskPrompt: prompt,
          taskTrunkBranch: trunkBranch,
          taskModelString,
          taskThinkingLevel: effectiveThinkingLevel,
          taskOnRefusal: args.onRefusal,
          taskExperiments: args.experiments,
          taskIsolation: useSharedWorkspace ? "none" : undefined,
          projects: parentMeta.projects,
        });
        return config;
      });

      // Emit metadata update so the UI sees the workspace immediately.
      await this.emitWorkspaceMetadata(taskId);

      // NOTE: Do NOT persist the prompt into chat history until the task actually starts.
      // Otherwise the frontend treats "last message is user" as an interrupted stream and
      // will auto-retry / backoff-spam resume attempts while the task is queued.
      taskQueueDebug("TaskService.create queued persisted (prompt stored in config)", {
        taskId,
        workspaceName,
      });

      // Schedule queue processing (best-effort).
      void this.maybeStartQueuedTasks();
      taskQueueDebug("TaskService.create queued scheduled maybeStartQueuedTasks", { taskId });
      return Ok({ taskId, kind: "agent", status: "queued" });
    }

    const initLogger = this.startWorkspaceInit(taskId, parentMeta.projectPath);

    let workspacePath: string;
    let trunkBranch: string;
    let forkedRuntimeConfig: RuntimeConfig;
    let runtimeForTaskWorkspace: Runtime;
    let forkedFromSource: boolean;
    let inheritedProjects: ProjectRef[] | undefined;

    if (useSharedWorkspace) {
      // isolation: "none" — run the sub-agent directly in the parent workspace's checkout instead
      // of forking. Mirrors local-runtime semantics for worktree/SSH so read-only analysis (or
      // prompt-isolated work) skips the fork + init overhead and sees the parent's uncommitted work.
      //
      // SAFETY: the task still gets a unique workspace name, and workspace deletion is keyed on that
      // name (runtime.deleteWorkspace(projectPath, name)), so removing this task never deletes the
      // shared parent checkout. workspaceService.remove additionally skips physical deletion for
      // tasks persisted with taskIsolation === "none".
      workspacePath = parentWorkspacePath;
      trunkBranch = parentBranchName ?? "main";
      forkedRuntimeConfig = parentRuntimeConfig;
      forkedFromSource = false;
      inheritedProjects = parentMeta.projects;
      // Build the runtime with the child's identity but the parent's checkout path. Worktree/SSH
      // runtimes honor this persisted path override (see *Runtime.getWorkspacePath), so cwd
      // resolution and ensureReady land in the shared parent checkout instead of a name-derived
      // directory that was never created. This mirrors the runtime rebuilt from the persisted entry.
      runtimeForTaskWorkspace = createRuntimeForWorkspace({
        runtimeConfig: parentRuntimeConfig,
        projectPath: parentMeta.projectPath,
        name: workspaceName,
        namedWorkspacePath: parentWorkspacePath,
      });
      initLogger.logStep("Sharing parent workspace (isolation: none) — skipping fork and init");
      initLogger.logComplete(0);
    } else {
      // Note: Local project-dir runtimes share the same directory (unsafe by design).
      // For worktree/ssh runtimes we attempt a fork first; otherwise fall back to createWorkspace.
      const forkResult = await orchestrateFork({
        sourceRuntime: runtime,
        projectPath: parentMeta.projectPath,
        sourceWorkspaceName: parentMeta.name,
        newWorkspaceName: workspaceName,
        initLogger,
        config: this.config,
        sourceWorkspaceId: parentWorkspaceId,
        sourceRuntimeConfig: parentRuntimeConfig,
        parentMetadata: parentMeta,
        allowCreateFallback: true,
        // Create-fallback base when the fork cannot detect a source branch — a shared parent's
        // synthetic name never names a real branch, so supply the actual checked-out branch.
        // Gated to shared parents to keep the existing branch-discovery fallback otherwise.
        ...(parentIsSharedTask && parentBranchName != null
          ? { preferredTrunkBranch: parentBranchName }
          : {}),
        trusted:
          this.config
            .loadConfigOrDefault()
            .projects.get(stripTrailingSlashes(parentMeta.projectPath))?.trusted ?? false,
        multiProjectExperimentEnabled: this.workspaceService.isExperimentEnabled(
          EXPERIMENT_IDS.MULTI_PROJECT_WORKSPACES
        ),
      });

      if (forkResult.success && forkResult.data.sourceRuntimeConfigUpdate) {
        await this.config.updateWorkspaceMetadata(parentWorkspaceId, {
          runtimeConfig: forkResult.data.sourceRuntimeConfigUpdate,
        });
        // Ensure UI gets the updated runtimeConfig for the parent workspace.
        await this.emitWorkspaceMetadata(parentWorkspaceId);
      }

      if (!forkResult.success) {
        initLogger.logComplete(-1);
        return Err(`Task fork failed: ${forkResult.error}`);
      }

      workspacePath = forkResult.data.workspacePath;
      trunkBranch = forkResult.data.trunkBranch;
      forkedRuntimeConfig = forkResult.data.forkedRuntimeConfig;
      runtimeForTaskWorkspace = forkResult.data.targetRuntime;
      forkedFromSource = forkResult.data.forkedFromSource;
      inheritedProjects = forkResult.data.projects;
    }

    // Multi-project forks need per-project secrets for each runtime's init hook.
    this.configureMultiProjectRuntimeEnvResolver(runtimeForTaskWorkspace);

    const taskBaseCommitShaByProjectPath = await readTaskBaseCommitShaByProjectPath({
      workspaceId: taskId,
      workspaceName,
      workspacePath,
      runtimeConfig: forkedRuntimeConfig,
      projectPath: parentMeta.projectPath,
      projectName: parentMeta.projectName,
      projects: inheritedProjects,
      runtime: runtimeForTaskWorkspace,
    });
    const taskBaseCommitSha = taskBaseCommitShaByProjectPath[parentMeta.projectPath];

    taskQueueDebug("TaskService.create started (workspace created)", {
      taskId,
      workspaceName,
      workspacePath,
      trunkBranch,
      forkSuccess: forkedFromSource,
    });

    // Persist workspace entry before starting work so it's durable across crashes.
    await this.config.editConfig((config) => {
      let projectConfig = config.projects.get(parentMeta.projectPath);
      if (!projectConfig) {
        projectConfig = { workspaces: [] };
        config.projects.set(parentMeta.projectPath, projectConfig);
      }

      projectConfig.workspaces.push({
        path: workspacePath,
        id: taskId,
        name: workspaceName,
        title: args.title,
        createdAt,
        runtimeConfig: forkedRuntimeConfig,
        aiSettings: { model: canonicalModel, thinkingLevel: effectiveThinkingLevel },
        agentId,
        parentWorkspaceId,
        agentType,
        workflowTask: args.workflowTask,
        bestOf: normalizedBestOf,
        taskStatus: "running",
        taskTrunkBranch: trunkBranch,
        taskBaseCommitSha: taskBaseCommitSha ?? undefined,
        taskBaseCommitShaByProjectPath,
        taskModelString,
        taskThinkingLevel: effectiveThinkingLevel,
        taskOnRefusal: args.onRefusal,
        taskExperiments: args.experiments,
        taskIsolation: useSharedWorkspace ? "none" : undefined,
        projects: inheritedProjects,
      });
      return config;
    });

    // Emit metadata update so the UI sees the workspace immediately.
    await this.emitWorkspaceMetadata(taskId);

    // Kick init (best-effort, async). Shared-workspace (isolation: "none") tasks reuse the parent's
    // already-initialized checkout, so re-running init would redundantly (and possibly disruptively)
    // mutate the live parent workspace — skip it entirely.
    if (!useSharedWorkspace) {
      const secrets = await secretsToRecord(
        this.config.getEffectiveSecrets(parentMeta.projectPath),
        this.opResolver
      );
      runBackgroundInit(
        runtimeForTaskWorkspace,
        {
          projectPath: parentMeta.projectPath,
          branchName: workspaceName,
          trunkBranch,
          workspacePath,
          initLogger,
          env: secrets,
          skipInitHook,
          trusted:
            this.config
              .loadConfigOrDefault()
              .projects.get(stripTrailingSlashes(parentMeta.projectPath))?.trusted ?? false,
        },
        taskId
      );
    }

    // Start immediately (counts towards parallel limit).
    const sendResult = await this.workspaceService.sendMessage(
      taskId,
      prompt,
      {
        model: taskModelString,
        agentId,
        thinkingLevel: effectiveThinkingLevel,
        experiments: args.experiments,
      },
      { agentInitiated: true }
    );
    if (!sendResult.success) {
      const message =
        typeof sendResult.error === "string"
          ? sendResult.error
          : formatSendMessageError(sendResult.error).message;
      await this.rollbackFailedTaskCreate(
        runtimeForTaskWorkspace,
        parentMeta.projectPath,
        workspaceName,
        taskId,
        { preservePhysicalWorkspace: useSharedWorkspace }
      );
      return Err(message);
    }

    return Ok({ taskId, kind: "agent", status: "running" });
  }

  async terminateDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<Result<TerminateAgentTaskResult, string>> {
    assert(
      ancestorWorkspaceId.length > 0,
      "terminateDescendantAgentTask: ancestorWorkspaceId must be non-empty"
    );
    assert(taskId.length > 0, "terminateDescendantAgentTask: taskId must be non-empty");

    const terminatedTaskIds: string[] = [];

    {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const entry = findWorkspaceEntry(cfg, taskId);
      if (!entry?.workspace.parentWorkspaceId) {
        return Err("Task not found");
      }

      const index = this.buildAgentTaskIndex(cfg);
      if (
        !this.isDescendantAgentTaskUsingParentById(index.parentById, ancestorWorkspaceId, taskId)
      ) {
        return Err("Task is not a descendant of this workspace");
      }

      // Terminate the entire subtree to avoid orphaned descendant tasks.
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, taskId);
      const toTerminate = Array.from(new Set([taskId, ...descendants]));

      // Delete leaves first to avoid leaving children with missing parents.
      const parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of toTerminate) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
      }
      toTerminate.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const terminationError = new Error("Task terminated");

      for (const id of toTerminate) {
        // Best-effort: stop any active stream immediately to avoid further token usage.
        try {
          const stopResult = await this.aiService.stopStream(id, { abandonPartial: true });
          if (!stopResult.success) {
            log.debug("terminateDescendantAgentTask: stopStream failed", { taskId: id });
          }
        } catch (error: unknown) {
          log.debug("terminateDescendantAgentTask: stopStream threw", { taskId: id, error });
        }

        this.completedReportsByTaskId.delete(id);
        this.rejectWaiters(id, terminationError);

        const removeResult = await this.workspaceService.remove(id, true);
        if (!removeResult.success) {
          return Err(`Failed to remove task workspace (${id}): ${removeResult.error}`);
        }

        terminatedTaskIds.push(id);
      }
    }

    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    return Ok({ terminatedTaskIds });
  }

  /** Best-effort final recheck for any completed workflow children still deferred by cleanup gates. */
  async markWorkflowRunEnded(workflowRunId: string): Promise<void> {
    assert(workflowRunId.length > 0, "markWorkflowRunEnded: workflowRunId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const completedTaskIds: string[] = [];
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        if (
          workspace.id &&
          workspace.workflowTask?.runId === workflowRunId &&
          hasCompletedAgentReport(workspace)
        ) {
          completedTaskIds.push(workspace.id);
        }
      }
    }
    for (const taskId of completedTaskIds) {
      await this.cleanupReportedLeafTask(taskId);
    }
  }

  /**
   * Interrupt all descendant agent tasks for a workspace (leaf-first).
   *
   * Rationale: when a user hard-interrupts a parent workspace, descendants must
   * also stop so they cannot later auto-resume the interrupted parent.
   *
   * Keep interrupted task workspaces on disk so users can inspect or manually
   * resume them later.
   *
   * Legacy naming note: this method retains the original "terminate" name for
   * compatibility with existing call sites.
   */
  async terminateAllDescendantAgentTasks(
    workspaceId: string,
    options?: { workflowRunId?: string }
  ): Promise<string[]> {
    assert(
      workspaceId.length > 0,
      "terminateAllDescendantAgentTasks: workspaceId must be non-empty"
    );

    const interruptedTaskIds: string[] = [];

    {
      await using _lock = await this.mutex.acquire();

      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const descendants = this.listDescendantAgentTaskIdsFromIndex(index, workspaceId).filter(
        (taskId) =>
          options?.workflowRunId == null ||
          this.isWorkflowRunDescendant(index, taskId, options.workflowRunId)
      );
      if (descendants.length === 0) {
        return interruptedTaskIds;
      }

      // Interrupt leaves first to avoid descendant/ancestor status races.
      const parentById = index.parentById;
      const depthById = new Map<string, number>();
      for (const id of descendants) {
        depthById.set(id, this.getTaskDepthFromParentById(parentById, id));
      }
      descendants.sort((a, b) => (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0));

      const interruptionError = new Error("Parent workspace interrupted");

      for (const id of descendants) {
        // Best-effort: clear queue first. AgentSession stream-end cleanup auto-flushes
        // queued messages, so descendants must not keep pending input after a hard interrupt.
        try {
          const clearQueueResult = this.workspaceService.clearQueue(id);
          if (!clearQueueResult.success) {
            log.debug("terminateAllDescendantAgentTasks: clearQueue failed", {
              taskId: id,
              error: clearQueueResult.error,
            });
          }
        } catch (error: unknown) {
          log.debug("terminateAllDescendantAgentTasks: clearQueue threw", { taskId: id, error });
        }

        // Best-effort: stop any active stream immediately to avoid further token usage
        // while preserving commit-worthy partial progress for inspection/resume.
        try {
          const stopResult = await this.aiService.stopStream(id, { abandonPartial: false });
          if (!stopResult.success) {
            log.debug("terminateAllDescendantAgentTasks: stopStream failed", { taskId: id });
          }
        } catch (error: unknown) {
          log.debug("terminateAllDescendantAgentTasks: stopStream threw", { taskId: id, error });
        }

        let preservedCompletedDescendant = false;
        const updated = await this.editWorkspaceEntry(
          id,
          (ws) => {
            preservedCompletedDescendant =
              this.applyInterruptedTaskStatus(ws) === "preserved-completed-report";
          },
          { allowMissing: true }
        );
        if (!updated) {
          // Missing descendants should still reject prompt waiters promptly so task_await does
          // not hang until timeout after a parent hard interrupt races with external cleanup.
          this.rejectWaiters(id, interruptionError);
          log.debug("terminateAllDescendantAgentTasks: descendant workspace missing", {
            taskId: id,
          });
          continue;
        }

        if (preservedCompletedDescendant) {
          log.debug("terminateAllDescendantAgentTasks: preserving completed descendant report", {
            taskId: id,
          });
          continue;
        }

        // Report monotonicity: descendants that did not complete a report must reject waiters
        // once the interrupt status transition is persisted.
        this.rejectWaiters(id, interruptionError);
        interruptedTaskIds.push(id);
      }
    }

    for (const taskId of interruptedTaskIds) {
      await this.emitWorkspaceMetadata(taskId);
    }

    // Free slots and start any queued tasks (best-effort).
    await this.maybeStartQueuedTasks();

    return interruptedTaskIds;
  }

  async cleanupReportedDescendantsAfterArchive(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "cleanupReportedDescendantsAfterArchive: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    const completedDescendants = this.listCompletedDescendantAgentTaskIds(index, workspaceId);
    if (completedDescendants.length === 0) {
      return;
    }

    const depthById = new Map<string, number>();
    for (const descendantId of completedDescendants) {
      depthById.set(descendantId, this.getTaskDepthFromParentById(index.parentById, descendantId));
    }
    completedDescendants.sort((a, b) => {
      const depthDelta = (depthById.get(b) ?? 0) - (depthById.get(a) ?? 0);
      return depthDelta !== 0 ? depthDelta : a.localeCompare(b);
    });

    log.debug("cleanupReportedDescendantsAfterArchive: rechecking completed descendants", {
      workspaceId,
      descendantCount: completedDescendants.length,
    });

    for (const descendantId of completedDescendants) {
      try {
        log.debug("cleanupReportedDescendantsAfterArchive: rechecking descendant", {
          workspaceId,
          descendantWorkspaceId: descendantId,
        });
        await this.cleanupReportedLeafTask(descendantId);
      } catch (error: unknown) {
        log.error("cleanupReportedDescendantsAfterArchive: failed to clean up descendant", {
          workspaceId,
          descendantWorkspaceId: descendantId,
          error,
        });
      }
    }
  }

  private async rollbackFailedTaskCreate(
    runtime: Runtime,
    projectPath: string,
    workspaceName: string,
    taskId: string,
    options?: {
      /**
       * Skip physical workspace deletion. Required for isolation: "none" tasks whose runtime
       * resolves this task's name to the shared parent checkout (e.g. SSHRuntime.deleteWorkspace
       * goes through the persisted-path override) — deleting it would destroy the parent's
       * working tree. Session/config cleanup still runs.
       */
      preservePhysicalWorkspace?: boolean;
    }
  ): Promise<void> {
    try {
      await this.config.removeWorkspace(taskId);
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove workspace from config", {
        taskId,
        error: getErrorMessage(error),
      });
    }

    this.workspaceService.emit("metadata", { workspaceId: taskId, metadata: null });

    if (options?.preservePhysicalWorkspace) {
      log.debug("Task.create rollback: preserving shared parent checkout", { taskId });
    } else {
      try {
        const deleteResult = await runtime.deleteWorkspace(projectPath, workspaceName, true);
        if (!deleteResult.success) {
          log.error("Task.create rollback: failed to delete workspace", {
            taskId,
            error: deleteResult.error,
          });
        }
      } catch (error: unknown) {
        log.error("Task.create rollback: runtime.deleteWorkspace threw", {
          taskId,
          error: getErrorMessage(error),
        });
      }
    }

    try {
      const sessionDir = this.config.getSessionDir(taskId);
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
    } catch (error: unknown) {
      log.error("Task.create rollback: failed to remove session directory", {
        taskId,
        error: getErrorMessage(error),
      });
    }
  }

  private isForegroundAwaiting(workspaceId: string): boolean {
    const count = this.foregroundAwaitCountByWorkspaceId.get(workspaceId);
    return typeof count === "number" && count > 0;
  }

  private startForegroundAwait(workspaceId: string): () => void {
    assert(workspaceId.length > 0, "startForegroundAwait: workspaceId must be non-empty");

    const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
    assert(
      Number.isInteger(current) && current >= 0,
      "startForegroundAwait: expected non-negative integer counter"
    );

    this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current + 1);

    return () => {
      const current = this.foregroundAwaitCountByWorkspaceId.get(workspaceId) ?? 0;
      assert(
        Number.isInteger(current) && current > 0,
        "startForegroundAwait cleanup: expected positive integer counter"
      );
      if (current <= 1) {
        this.foregroundAwaitCountByWorkspaceId.delete(workspaceId);
      } else {
        this.foregroundAwaitCountByWorkspaceId.set(workspaceId, current - 1);
      }
    };
  }

  private registerBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    let set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set) {
      set = new Set();
      this.backgroundableForegroundWaitersByWorkspaceId.set(workspaceId, set);
    }
    set.add(waiter);
  }

  private unregisterBackgroundableForegroundWaiter(
    workspaceId: string,
    waiter: BackgroundableForegroundWaiter
  ): void {
    const set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) {
      this.backgroundableForegroundWaitersByWorkspaceId.delete(workspaceId);
    }
  }

  /**
   * Reject all foreground task waiters for a workspace that opted into backgrounding
   * when a new message is queued. Returns the number of waiters signaled.
   * Safe to call repeatedly — already-cleaned-up waiters are skipped.
   */
  backgroundForegroundWaitsForWorkspace(workspaceId: string): number {
    const set = this.backgroundableForegroundWaitersByWorkspaceId.get(workspaceId);
    if (!set || set.size === 0) return 0;

    const waiters = [...set];
    let count = 0;
    for (const waiter of waiters) {
      try {
        this.markTaskQueueBackgrounded(waiter.taskId);
        waiter.reject(new ForegroundWaitBackgroundedError());
        count++;
      } catch {
        // waiter already resolved/rejected — ignore
      }
    }
    return count;
  }

  private buildWorkspaceTurnWaitResult(
    record: WorkspaceTurnTaskHandleRecord
  ): WorkspaceTurnWaitResult {
    assert(record.handleId.length > 0, "workspace turn record requires handleId");
    assert(record.workspaceId.length > 0, "workspace turn record requires workspaceId");
    return {
      taskId: record.handleId,
      workspaceId: record.workspaceId,
      reportMarkdown:
        record.reportMarkdown ?? "Workspace turn completed without final text output.",
      title: record.title,
      messageId: record.messageId,
      finalMessageRef: record.finalMessageRef,
    };
  }

  private settleWorkspaceTurnWaiters(
    handleId: string,
    settlement:
      | { status: "completed"; result: WorkspaceTurnWaitResult }
      | { status: "error"; error: Error }
  ): void {
    assert(handleId.length > 0, "settleWorkspaceTurnWaiters requires handleId");
    const waiters = this.pendingWorkspaceTurnWaitersByHandleId.get(handleId) ?? [];
    this.pendingWorkspaceTurnWaitersByHandleId.delete(handleId);
    for (const waiter of waiters) {
      if (settlement.status === "completed") {
        waiter.resolve(settlement.result);
      } else {
        waiter.reject(settlement.error);
      }
    }
  }

  private async cleanupDisposableWorkspaceTurn(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<void> {
    if (!record.disposableWorkspace) return;
    try {
      const removeResult = await this.workspaceService.remove(record.workspaceId, true);
      if (!removeResult.success) {
        log.error("Workspace turn cleanup: failed to remove disposable workspace", {
          handleId: record.handleId,
          workspaceId: record.workspaceId,
          error: removeResult.error,
        });
      }
    } catch (error: unknown) {
      log.error("Workspace turn cleanup: workspaceService.remove threw", {
        handleId: record.handleId,
        workspaceId: record.workspaceId,
        error: getErrorMessage(error),
      });
    }
  }

  private isTerminalWorkspaceTurnStatus(status: WorkspaceTurnTaskStatus): boolean {
    return status === "completed" || status === "interrupted" || status === "error";
  }

  private async settleWorkspaceTurn(params: {
    record: WorkspaceTurnTaskHandleRecord;
    next: WorkspaceTurnTaskHandleRecord;
    waiterSettlement:
      | { status: "completed"; result: WorkspaceTurnWaitResult }
      | { status: "error"; error: Error };
  }): Promise<void> {
    assert(
      params.next.handleId === params.record.handleId,
      "settleWorkspaceTurn requires stable handleId"
    );
    assert(
      params.next.workspaceId === params.record.workspaceId,
      "settleWorkspaceTurn requires stable workspaceId"
    );

    await this.workspaceTurnSettlementLocks.withLock(params.record.handleId, async () => {
      const current = await this.taskHandleStore.getWorkspaceTurn(
        params.record.ownerWorkspaceId,
        params.record.handleId
      );
      if (current == null) {
        return;
      }
      assert(
        current.workspaceId === params.record.workspaceId,
        "settleWorkspaceTurn requires current record to match workspaceId"
      );

      if (this.isTerminalWorkspaceTurnStatus(current.status)) {
        const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(params.record.workspaceId);
        if (
          active?.handleId === params.record.handleId &&
          active.ownerWorkspaceId === params.record.ownerWorkspaceId
        ) {
          this.activeWorkspaceTurnHandleByWorkspaceId.delete(params.record.workspaceId);
        }
        this.settleWorkspaceTurnWaiters(
          current.handleId,
          current.status === "completed"
            ? { status: "completed", result: this.buildWorkspaceTurnWaitResult(current) }
            : {
                status: "error",
                error: new Error(
                  current.error ??
                    (current.status === "interrupted"
                      ? "Workspace turn interrupted"
                      : "Workspace turn failed")
                ),
              }
        );
        this.markTaskForegroundRelevant(current.handleId);
        return;
      }

      await this.taskHandleStore.upsertWorkspaceTurn(params.next);
      const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(params.record.workspaceId);
      if (
        active?.handleId === params.record.handleId &&
        active.ownerWorkspaceId === params.record.ownerWorkspaceId
      ) {
        this.activeWorkspaceTurnHandleByWorkspaceId.delete(params.record.workspaceId);
      }
      this.settleWorkspaceTurnWaiters(params.record.handleId, params.waiterSettlement);
      this.markTaskForegroundRelevant(params.record.handleId);
      await this.cleanupDisposableWorkspaceTurn(params.next);
      this.scheduleMaybeStartQueuedTasks();
    });
  }

  async waitForWorkspaceTurn(
    handleId: string,
    options: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      requestingWorkspaceId: string;
      backgroundOnMessageQueued?: boolean;
    }
  ): Promise<WorkspaceTurnWaitResult> {
    assert(handleId.length > 0, "waitForWorkspaceTurn: handleId must be non-empty");
    assert(
      options.requestingWorkspaceId.length > 0,
      "waitForWorkspaceTurn: requestingWorkspaceId must be non-empty"
    );
    const timeoutMs = options.timeoutMs ?? 120_000;
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForWorkspaceTurn: timeoutMs invalid");

    this.markTaskForegroundRelevant(handleId);

    return await new Promise<WorkspaceTurnWaitResult>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let abortListener: (() => void) | null = null;
      let stopBlockingRequester: (() => void) | null = this.startForegroundAwait(
        options.requestingWorkspaceId
      );
      const shouldBackgroundOnQueuedMessage = options.backgroundOnMessageQueued ?? true;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        if (abortListener) {
          options.abortSignal?.removeEventListener("abort", abortListener);
          abortListener = null;
        }
        if (waiterEntry.backgroundOnMessageQueued && waiterEntry.requestingWorkspaceId) {
          this.unregisterBackgroundableForegroundWaiter(
            waiterEntry.requestingWorkspaceId,
            waiterEntry
          );
        }
        const waiters = this.pendingWorkspaceTurnWaitersByHandleId.get(handleId) ?? [];
        const nextWaiters = waiters.filter((waiter) => waiter !== waiterEntry);
        if (nextWaiters.length === 0) {
          this.pendingWorkspaceTurnWaitersByHandleId.delete(handleId);
        } else {
          this.pendingWorkspaceTurnWaitersByHandleId.set(handleId, nextWaiters);
        }
        if (stopBlockingRequester) {
          try {
            stopBlockingRequester();
          } finally {
            stopBlockingRequester = null;
          }
        }
      };
      const waiterEntry: WorkspaceTurnWaiter = {
        taskId: handleId,
        handleId,
        requestingWorkspaceId: options.requestingWorkspaceId,
        backgroundOnMessageQueued: shouldBackgroundOnQueuedMessage,
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      };

      const waiters = this.pendingWorkspaceTurnWaitersByHandleId.get(handleId) ?? [];
      waiters.push(waiterEntry);
      this.pendingWorkspaceTurnWaitersByHandleId.set(handleId, waiters);
      if (shouldBackgroundOnQueuedMessage) {
        this.registerBackgroundableForegroundWaiter(options.requestingWorkspaceId, waiterEntry);
      }

      if (options.abortSignal?.aborted) {
        waiterEntry.reject(new Error("Interrupted"));
        return;
      }
      abortListener = () => waiterEntry.reject(new Error("Interrupted"));
      options.abortSignal?.addEventListener("abort", abortListener, { once: true });
      timer = setTimeout(
        () => waiterEntry.reject(new Error("Timed out waiting for workspace turn")),
        timeoutMs
      );

      void (async () => {
        const record = await this.taskHandleStore.getWorkspaceTurn(
          options.requestingWorkspaceId,
          handleId
        );
        if (settled) return;
        if (record == null) {
          waiterEntry.reject(new Error("Workspace turn not found or out of scope"));
          return;
        }
        if (record.status === "completed") {
          waiterEntry.resolve(this.buildWorkspaceTurnWaitResult(record));
          return;
        }
        if (record.status === "error") {
          waiterEntry.reject(new Error(record.error ?? "Workspace turn failed"));
          return;
        }
        if (record.status === "interrupted") {
          waiterEntry.reject(new Error("Workspace turn interrupted"));
        }
      })().catch((error: unknown) => {
        waiterEntry.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async waitForAgentReport(
    taskId: string,
    options?: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      requestingWorkspaceId?: string;
      backgroundOnMessageQueued?: boolean;
    }
  ): Promise<{ reportMarkdown: string; title?: string; structuredOutput?: unknown }> {
    assert(taskId.length > 0, "waitForAgentReport: taskId must be non-empty");

    // Report monotonicity invariant: check the in-memory cache before any status-based
    // interruption handling so a finalized report stays awaitable once observed.
    const cached = this.completedReportsByTaskId.get(taskId);
    if (cached) {
      return {
        reportMarkdown: cached.reportMarkdown,
        title: cached.title,
        structuredOutput: cached.structuredOutput,
      };
    }

    const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000; // 10 minutes
    assert(Number.isFinite(timeoutMs) && timeoutMs > 0, "waitForAgentReport: timeoutMs invalid");

    const requestingWorkspaceId = coerceNonEmptyString(options?.requestingWorkspaceId);
    if (requestingWorkspaceId) {
      // A renewed foreground wait means this task is blocking again unless re-backgrounded later.
      this.markTaskForegroundRelevant(taskId);
    }

    const tryReadPersistedReport = async (): Promise<{
      reportMarkdown: string;
      structuredOutput?: unknown;
      title?: string;
    } | null> => {
      if (!requestingWorkspaceId) {
        return null;
      }

      const sessionDir = this.config.getSessionDir(requestingWorkspaceId);
      const artifact = await readSubagentReportArtifact(sessionDir, taskId);
      if (!artifact) {
        return null;
      }

      // Cache for the current process (best-effort). Disk is the source of truth.
      this.completedReportsByTaskId.set(taskId, {
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        structuredOutput: artifact.structuredOutput,
        workflowOwnedAncestorWorkspaceIds: artifact.workflowOwnedAncestorWorkspaceIds,
        ancestorWorkspaceIds: artifact.ancestorWorkspaceIds,
      });
      this.enforceCompletedReportCacheLimit();

      return {
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        structuredOutput: artifact.structuredOutput,
      };
    };

    // Persisted terminal failures (e.g. model_refusal) are checked AFTER reports —
    // report monotonicity — and surface as rejections, never as reportMarkdown.
    const tryReadPersistedFailureError = async (): Promise<Error | null> => {
      if (!requestingWorkspaceId) {
        return null;
      }

      const sessionDir = this.config.getSessionDir(requestingWorkspaceId);
      const failure = await readSubagentFailureArtifact(sessionDir, taskId);
      return failure ? new Error(failure.errorMessage) : null;
    };

    // Fast-path: if the task is already gone (cleanup) or already reported (restart), return the
    // persisted artifact from the requesting workspace session dir.
    const cfg = this.config.loadConfigOrDefault();
    const taskWorkspaceEntry = findWorkspaceEntry(cfg, taskId);
    const taskStatus = taskWorkspaceEntry?.workspace.taskStatus;

    if (!taskWorkspaceEntry || taskStatus === "reported") {
      const persisted = await tryReadPersistedReport();
      if (persisted) {
        return persisted;
      }

      const persistedFailure = await tryReadPersistedFailureError();
      if (persistedFailure) {
        throw persistedFailure;
      }

      throw new Error("Task not found");
    }

    if (taskStatus === "interrupted") {
      const persisted = await tryReadPersistedReport();
      if (persisted) {
        return persisted;
      }

      // Report monotonicity: interrupted tasks can still be streaming while stream-end
      // finalization persists agent_report. Waiters should keep waiting in that window.
      if (!this.aiService.isStreaming(taskId)) {
        throw new Error(taskWorkspaceEntry.workspace.taskLaunchError ?? "Task interrupted");
      }
    }

    return await new Promise<{
      reportMarkdown: string;
      title?: string;
      structuredOutput?: unknown;
    }>((resolve, reject) => {
      void (async () => {
        // Validate existence early to avoid waiting on never-resolving task IDs.
        const cfg = this.config.loadConfigOrDefault();
        const taskWorkspaceEntry = findWorkspaceEntry(cfg, taskId);
        if (!taskWorkspaceEntry) {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

          const persistedFailure = await tryReadPersistedFailureError();
          reject(persistedFailure ?? new Error("Task not found"));
          return;
        }

        if (taskWorkspaceEntry.workspace.taskStatus === "reported") {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

          const persistedFailure = await tryReadPersistedFailureError();
          reject(persistedFailure ?? new Error("Task not found"));
          return;
        }

        if (taskWorkspaceEntry.workspace.taskStatus === "interrupted") {
          const persisted = await tryReadPersistedReport();
          if (persisted) {
            resolve(persisted);
            return;
          }

          // Report monotonicity: an interrupted task may still be in stream-end teardown,
          // so keep the waiter alive while the stream is active.
          if (!this.aiService.isStreaming(taskId)) {
            reject(new Error(taskWorkspaceEntry.workspace.taskLaunchError ?? "Task interrupted"));
            return;
          }
        }

        let timeout: ReturnType<typeof setTimeout> | null = null;
        let startWaiter: PendingTaskStartWaiter | null = null;
        let abortListener: (() => void) | null = null;
        let stopBlockingRequester: (() => void) | null = requestingWorkspaceId
          ? this.startForegroundAwait(requestingWorkspaceId)
          : null;

        const startReportTimeout = () => {
          if (timeout) return;
          timeout = setTimeout(() => {
            // Prefer a persisted terminal failure over a generic timeout so late
            // awaits surface the typed failure (e.g. model_refusal) even when the
            // live rejection was missed (restart/cleanup windows).
            void (async () => {
              const persistedFailure = await tryReadPersistedFailureError().catch(() => null);
              entry.cleanup();
              reject(persistedFailure ?? new Error("Timed out waiting for agent_report"));
            })();
          }, timeoutMs);
        };

        const cleanupStartWaiter = () => {
          if (!startWaiter) return;
          startWaiter.cleanup();
          startWaiter = null;
        };

        const entry: PendingTaskWaiter = {
          taskId,
          requestingWorkspaceId: undefined,
          backgroundOnMessageQueued: false,
          resolve: (report) => {
            entry.cleanup();
            resolve(report);
          },
          reject: (error) => {
            entry.cleanup();
            reject(error);
          },
          cleanup: () => {
            if (entry.requestingWorkspaceId && entry.backgroundOnMessageQueued) {
              this.unregisterBackgroundableForegroundWaiter(entry.requestingWorkspaceId, entry);
            }

            const current = this.pendingWaitersByTaskId.get(taskId);
            if (current) {
              const next = current.filter((w) => w !== entry);
              if (next.length === 0) {
                this.pendingWaitersByTaskId.delete(taskId);
              } else {
                this.pendingWaitersByTaskId.set(taskId, next);
              }
            }

            cleanupStartWaiter();

            if (timeout) {
              clearTimeout(timeout);
              timeout = null;
            }

            if (abortListener && options?.abortSignal) {
              options.abortSignal.removeEventListener("abort", abortListener);
              abortListener = null;
            }

            if (stopBlockingRequester) {
              try {
                stopBlockingRequester();
              } finally {
                stopBlockingRequester = null;
              }
            }
          },
        };

        const list = this.pendingWaitersByTaskId.get(taskId) ?? [];
        list.push(entry);
        this.pendingWaitersByTaskId.set(taskId, list);

        const shouldBackgroundOnQueuedMessage = Boolean(
          requestingWorkspaceId && (options?.backgroundOnMessageQueued ?? true)
        );
        entry.requestingWorkspaceId = requestingWorkspaceId;
        entry.backgroundOnMessageQueued = shouldBackgroundOnQueuedMessage;

        if (shouldBackgroundOnQueuedMessage && requestingWorkspaceId) {
          this.registerBackgroundableForegroundWaiter(requestingWorkspaceId, entry);
        }

        // Don't start the execution timeout while the task is still queued/starting.
        // The timer starts once the child actually begins running (queued/starting -> running).
        const initialStatus = taskWorkspaceEntry.workspace.taskStatus;
        if (initialStatus === "queued" || initialStatus === "starting") {
          const startWaiterEntry: PendingTaskStartWaiter = {
            start: startReportTimeout,
            cleanup: () => {
              const currentStartWaiters = this.pendingStartWaitersByTaskId.get(taskId);
              if (currentStartWaiters) {
                const next = currentStartWaiters.filter((w) => w !== startWaiterEntry);
                if (next.length === 0) {
                  this.pendingStartWaitersByTaskId.delete(taskId);
                } else {
                  this.pendingStartWaitersByTaskId.set(taskId, next);
                }
              }
            },
          };
          startWaiter = startWaiterEntry;

          const currentStartWaiters = this.pendingStartWaitersByTaskId.get(taskId) ?? [];
          currentStartWaiters.push(startWaiterEntry);
          this.pendingStartWaitersByTaskId.set(taskId, currentStartWaiters);

          // Close the race where the task starts between the initial config read and registering the waiter.
          const cfgAfterRegister = this.config.loadConfigOrDefault();
          const afterEntry = findWorkspaceEntry(cfgAfterRegister, taskId);
          if (
            afterEntry?.workspace.taskStatus !== "queued" &&
            afterEntry?.workspace.taskStatus !== "starting"
          ) {
            cleanupStartWaiter();
            startReportTimeout();
          }

          // If the awaited task is queued and the caller is blocked in the foreground, ensure the
          // scheduler runs after the waiter is registered. This avoids deadlocks when
          // maxParallelAgentTasks is low.
          if (requestingWorkspaceId) {
            this.scheduleMaybeStartQueuedTasks();
          }
        } else {
          startReportTimeout();
        }

        if (initialStatus === "awaiting_report") {
          // Reuse the standard completion reminder when a waiter attaches instead of carrying a
          // separate waiter-only recovery mode and prompt string.
          void this.workspaceEventLocks
            .withLock(taskId, async () => {
              await this.promptTaskForRequiredCompletionTool(taskId);
            })
            .catch((error: unknown) => {
              log.error("Failed to resume awaiting_report task for waiter", {
                taskId,
                error,
              });
            });
        }
        if (options?.abortSignal) {
          if (options.abortSignal.aborted) {
            entry.cleanup();
            reject(new Error("Interrupted"));
            return;
          }

          abortListener = () => {
            entry.cleanup();
            reject(new Error("Interrupted"));
          };
          options.abortSignal.addEventListener("abort", abortListener, { once: true });
        }
      })().catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  getAgentTaskStatus(taskId: string): AgentTaskStatus | null {
    assert(taskId.length > 0, "getAgentTaskStatus: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
    const status = entry?.workspace.taskStatus;
    return status ?? null;
  }

  getAgentTaskTimestamps(taskId: string): AgentTaskTimestamps | null {
    assert(taskId.length > 0, "getAgentTaskTimestamps: taskId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, taskId);
    if (!entry) {
      return null;
    }

    return {
      createdAt: entry.workspace.createdAt,
      reportedAt: entry.workspace.reportedAt,
    };
  }

  getAgentTaskStatuses(taskIds: string[]): Map<string, AgentTaskStatusLookup> {
    for (const taskId of taskIds) {
      assert(taskId.length > 0, "getAgentTaskStatuses: taskId must be non-empty");
    }

    if (taskIds.length === 0) {
      return new Map<string, AgentTaskStatusLookup>();
    }

    const cfg = this.config.loadConfigOrDefault();
    const statuses = new Map<string, AgentTaskStatusLookup>();

    for (const taskId of taskIds) {
      const entry = findWorkspaceEntry(cfg, taskId);
      statuses.set(taskId, {
        exists: entry != null,
        taskStatus: entry?.workspace.taskStatus ?? null,
      });
    }

    return statuses;
  }

  hasActiveDescendantAgentTasksForWorkspace(workspaceId: string): boolean {
    assert(
      workspaceId.length > 0,
      "hasActiveDescendantAgentTasksForWorkspace: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    return this.hasActiveDescendantAgentTasks(cfg, workspaceId);
  }

  hasPreservedCompletedDescendants(workspaceId: string): boolean {
    assert(
      workspaceId.length > 0,
      "hasPreservedCompletedDescendants: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const taskSettings = normalizeTaskSettings(cfg.taskSettings);
    if (!taskSettings.preserveSubagentsUntilArchive) {
      return false;
    }

    const index = this.buildAgentTaskIndex(cfg);
    const completedDescendants = this.listCompletedDescendantAgentTaskIds(index, workspaceId);
    return completedDescendants.some(
      (descendantId) =>
        !this.isWorkflowOwnedTaskUsingIndex(index, descendantId) &&
        !this.hasArchivedAncestor(index, cfg, descendantId)
    );
  }

  // This ignores archive state and preserveSubagentsUntilArchive so callers can detect
  // completed descendants that are still waiting on cleanup prerequisites.
  hasCompletedDescendants(workspaceId: string): boolean {
    assert(workspaceId.length > 0, "hasCompletedDescendants: workspaceId must be non-empty");

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    return this.listCompletedDescendantAgentTaskIds(index, workspaceId).length > 0;
  }

  listActiveDescendantAgentTaskIds(
    workspaceId: string,
    options: { excludeWorkflowTasks?: boolean } = {}
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listActiveDescendantAgentTaskIds: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);

    const activeStatuses = new Set<AgentTaskStatus>([
      "queued",
      "starting",
      "running",
      "awaiting_report",
    ]);
    const result: string[] = [];
    const stack: Array<{ taskId: string; workflowOwned: boolean }> = [
      ...(index.childrenByParent.get(workspaceId) ?? []).map((taskId) => ({
        taskId,
        workflowOwned: false,
      })),
    ];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      const workflowOwned = next.workflowOwned || entry?.workflowTask != null;
      const status = entry?.taskStatus;
      if (
        status &&
        activeStatuses.has(status) &&
        !(options.excludeWorkflowTasks && workflowOwned)
      ) {
        result.push(next.taskId);
      }
      const children = index.childrenByParent.get(next.taskId);
      if (children) {
        for (const child of children) {
          stack.push({ taskId: child, workflowOwned });
        }
      }
    }
    return result;
  }

  async getWorkspaceTurnSnapshot(
    ownerWorkspaceId: string,
    handleId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    if (!isWorkspaceTurnTaskId(handleId)) {
      return null;
    }
    const record = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
    if (
      record != null &&
      (record.status === "starting" || record.status === "running") &&
      !this.isLiveWorkspaceTurn(record)
    ) {
      await this.settleStaleWorkspaceTurn(record);
      return await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
    }
    return record;
  }

  async listWorkspaceTurnTasks(
    ownerWorkspaceId: string,
    options: { statuses?: readonly WorkspaceTurnTaskStatus[] } = {}
  ): Promise<WorkspaceTurnTaskHandleRecord[]> {
    const records = await this.taskHandleStore.listWorkspaceTurns(ownerWorkspaceId, options);
    const statuses = options.statuses != null ? new Set(options.statuses) : null;
    const result: WorkspaceTurnTaskHandleRecord[] = [];
    for (const record of records) {
      if (
        (record.status === "starting" || record.status === "running") &&
        !this.isLiveWorkspaceTurn(record)
      ) {
        await this.settleStaleWorkspaceTurn(record);
        const latest = await this.taskHandleStore.getWorkspaceTurn(
          record.ownerWorkspaceId,
          record.handleId
        );
        if (latest != null && (statuses == null || statuses.has(latest.status))) {
          result.push(latest);
        }
        continue;
      }
      result.push(record);
    }
    return result;
  }

  async interruptWorkspaceTurn(
    ownerWorkspaceId: string,
    handleId: string
  ): Promise<Result<{ workspaceId: string }, string>> {
    const record = await this.taskHandleStore.getWorkspaceTurn(ownerWorkspaceId, handleId);
    if (record == null) {
      return Err("Workspace turn not found or out of scope");
    }
    if (record.status === "completed" || record.status === "error") {
      return Err(`Workspace turn is already ${record.status} and cannot be interrupted.`);
    }
    try {
      await this.aiService.stopStream(record.workspaceId, { abandonPartial: false });
    } catch (error: unknown) {
      log.debug("interruptWorkspaceTurn: stopStream threw", { handleId, error });
    }
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "interrupted",
      updatedAt: getIsoNow(),
    };
    await this.settleWorkspaceTurn({
      record,
      next,
      waiterSettlement: { status: "error", error: new Error("Workspace turn interrupted") },
    });
    return Ok({ workspaceId: record.workspaceId });
  }

  listDescendantAgentTasks(
    workspaceId: string,
    options?: { statuses?: AgentTaskStatus[]; excludeWorkflowTasks?: boolean }
  ): DescendantAgentTaskInfo[] {
    assert(workspaceId.length > 0, "listDescendantAgentTasks: workspaceId must be non-empty");

    const statuses = options?.statuses;
    const statusFilter = statuses && statuses.length > 0 ? new Set(statuses) : null;

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);

    const result: DescendantAgentTaskInfo[] = [];

    const stack: Array<{ taskId: string; depth: number; workflowOwned: boolean }> = [];
    for (const childTaskId of index.childrenByParent.get(workspaceId) ?? []) {
      stack.push({ taskId: childTaskId, depth: 1, workflowOwned: false });
    }

    while (stack.length > 0) {
      const next = stack.pop()!;
      const entry = index.byId.get(next.taskId);
      if (!entry) continue;

      assert(
        entry.parentWorkspaceId,
        `listDescendantAgentTasks: task ${next.taskId} is missing parentWorkspaceId`
      );

      const workflowOwned = next.workflowOwned || entry.workflowTask != null;
      const status: AgentTaskStatus = entry.taskStatus ?? "running";
      if (
        (!statusFilter || statusFilter.has(status)) &&
        !(options?.excludeWorkflowTasks === true && workflowOwned)
      ) {
        result.push({
          taskId: next.taskId,
          status,
          parentWorkspaceId: entry.parentWorkspaceId,
          agentType: entry.agentType,
          workspaceName: entry.name,
          title: entry.title,
          createdAt: entry.createdAt,
          modelString: entry.aiSettings?.model,
          thinkingLevel: entry.aiSettings?.thinkingLevel,
          depth: next.depth,
        });
      }

      for (const childTaskId of index.childrenByParent.get(next.taskId) ?? []) {
        stack.push({ taskId: childTaskId, depth: next.depth + 1, workflowOwned });
      }
    }

    // Stable ordering: oldest first, then depth (ties by taskId for determinism).
    result.sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (aTime !== bTime) return aTime - bTime;
      if (a.depth !== b.depth) return a.depth - b.depth;
      return a.taskId.localeCompare(b.taskId);
    });

    return result;
  }

  async filterDescendantAgentTaskIds(
    ancestorWorkspaceId: string,
    taskIds: string[]
  ): Promise<string[]> {
    assert(
      ancestorWorkspaceId.length > 0,
      "filterDescendantAgentTaskIds: ancestorWorkspaceId required"
    );
    assert(Array.isArray(taskIds), "filterDescendantAgentTaskIds: taskIds must be an array");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;

    const result: string[] = [];
    const maybePersisted: string[] = [];

    for (const taskId of taskIds) {
      if (typeof taskId !== "string" || taskId.length === 0) continue;

      if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
        result.push(taskId);
        continue;
      }

      const cached = this.completedReportsByTaskId.get(taskId);
      if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
        result.push(taskId);
        continue;
      }

      maybePersisted.push(taskId);
    }

    if (maybePersisted.length === 0) {
      return result;
    }

    // Terminal failures persist in a separate artifacts file (a failure must
    // never masquerade as a completed report), so scope checks must consult
    // BOTH: a background-failed child that was cleaned up or lost to a restart
    // must stay in scope for task_await so waitForAgentReport can surface the
    // persisted typed failure instead of degrading to invalid_scope/not_found.
    const sessionDir = this.config.getSessionDir(ancestorWorkspaceId);
    const [reports, failures] = await Promise.all([
      readSubagentReportArtifactsFile(sessionDir),
      readSubagentFailureArtifactsFile(sessionDir),
    ]);
    for (const taskId of maybePersisted) {
      if (
        hasAncestorWorkspaceId(reports.artifactsByChildTaskId[taskId], ancestorWorkspaceId) ||
        hasAncestorWorkspaceId(failures.failuresByChildTaskId[taskId], ancestorWorkspaceId)
      ) {
        result.push(taskId);
      }
    }

    return result;
  }

  private listDescendantAgentTaskIdsFromIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): string[] {
    assert(
      workspaceId.length > 0,
      "listDescendantAgentTaskIdsFromIndex: workspaceId must be non-empty"
    );

    const result: string[] = [];
    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      result.push(next);
      const children = index.childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }
    return result;
  }

  private isWorkflowRunDescendant(
    index: AgentTaskIndex,
    taskId: string,
    workflowRunId: string
  ): boolean {
    let current: string | undefined = taskId;
    for (let i = 0; current != null && i < 32; i++) {
      const entry = index.byId.get(current);
      if (entry?.workflowTask?.runId === workflowRunId) {
        return true;
      }
      current = index.parentById.get(current);
    }
    return false;
  }

  private listCompletedDescendantAgentTaskIds(
    index: AgentTaskIndex,
    workspaceId: string
  ): string[] {
    return this.listDescendantAgentTaskIdsFromIndex(index, workspaceId).filter((taskId) => {
      const entry = index.byId.get(taskId);
      return entry != null && hasCompletedAgentReport(entry);
    });
  }

  async isWorkflowOwnedDescendantAgentTask(
    ancestorWorkspaceId: string,
    taskId: string
  ): Promise<boolean> {
    assert(
      ancestorWorkspaceId.length > 0,
      "isWorkflowOwnedDescendantAgentTask: ancestorWorkspaceId required"
    );
    assert(taskId.length > 0, "isWorkflowOwnedDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const indexResult = this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
      this.buildAgentTaskIndex(cfg),
      ancestorWorkspaceId,
      taskId
    );
    if (indexResult != null) {
      return indexResult;
    }

    const cached = this.completedReportsByTaskId.get(taskId);
    if (hasWorkflowOwnedAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return true;
    }
    if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return false;
    }

    const sessionDir = this.config.getSessionDir(ancestorWorkspaceId);
    const persisted = await readSubagentReportArtifactsFile(sessionDir);
    const entry = persisted.artifactsByChildTaskId[taskId];
    if (entry != null) {
      return hasWorkflowOwnedAncestorWorkspaceId(entry, ancestorWorkspaceId);
    }

    // A workflow-owned child that failed terminally leaves only a failure
    // artifact. It must stay excluded from direct task_await after cleanup,
    // matching live behavior: its failure is consumed through the workflow run.
    const failures = await readSubagentFailureArtifactsFile(sessionDir);
    return hasWorkflowOwnedAncestorWorkspaceId(
      failures.failuresByChildTaskId[taskId],
      ancestorWorkspaceId
    );
  }

  private getWorkflowOwnedDescendantAgentTaskUsingIndex(
    index: AgentTaskIndex,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean | null {
    let current = taskId;
    let workflowOwned = false;

    for (let i = 0; i < 32; i++) {
      const entry = index.byId.get(current);
      workflowOwned ||= entry?.workflowTask != null;

      const parent = index.parentById.get(current);
      if (!parent) return null;
      if (parent === ancestorWorkspaceId) return workflowOwned;
      current = parent;
    }

    throw new Error(
      `getWorkflowOwnedDescendantAgentTaskUsingIndex: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  async isDescendantAgentTask(ancestorWorkspaceId: string, taskId: string): Promise<boolean> {
    assert(ancestorWorkspaceId.length > 0, "isDescendantAgentTask: ancestorWorkspaceId required");
    assert(taskId.length > 0, "isDescendantAgentTask: taskId required");

    const cfg = this.config.loadConfigOrDefault();
    const parentById = this.buildAgentTaskIndex(cfg).parentById;
    if (this.isDescendantAgentTaskUsingParentById(parentById, ancestorWorkspaceId, taskId)) {
      return true;
    }

    // The task workspace may have been removed after it settled (cleanup/restart). Preserve scope
    // checks by consulting persisted report AND failure artifacts in the ancestor session dir —
    // a terminally-failed child must stay awaitable so its typed failure can be surfaced.
    const cached = this.completedReportsByTaskId.get(taskId);
    if (hasAncestorWorkspaceId(cached, ancestorWorkspaceId)) {
      return true;
    }

    const sessionDir = this.config.getSessionDir(ancestorWorkspaceId);
    const [reports, failures] = await Promise.all([
      readSubagentReportArtifactsFile(sessionDir),
      readSubagentFailureArtifactsFile(sessionDir),
    ]);
    return (
      hasAncestorWorkspaceId(reports.artifactsByChildTaskId[taskId], ancestorWorkspaceId) ||
      hasAncestorWorkspaceId(failures.failuresByChildTaskId[taskId], ancestorWorkspaceId)
    );
  }

  private isDescendantAgentTaskUsingParentById(
    parentById: Map<string, string>,
    ancestorWorkspaceId: string,
    taskId: string
  ): boolean {
    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return false;
      if (parent === ancestorWorkspaceId) return true;
      current = parent;
    }

    throw new Error(
      `isDescendantAgentTaskUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  // --- Internal orchestration ---

  private listAncestorWorkspaceIdsUsingParentById(
    parentById: Map<string, string>,
    taskId: string
  ): string[] {
    const ancestors: string[] = [];

    let current = taskId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) return ancestors;
      ancestors.push(parent);
      current = parent;
    }

    throw new Error(
      `listAncestorWorkspaceIdsUsingParentById: possible parentWorkspaceId cycle starting at ${taskId}`
    );
  }

  private listAgentTaskWorkspaces(
    config: ReturnType<Config["loadConfigOrDefault"]>
  ): AgentTaskWorkspaceEntry[] {
    const tasks: AgentTaskWorkspaceEntry[] = [];
    for (const [projectPath, project] of config.projects) {
      for (const workspace of project.workspaces) {
        if (!workspace.id) continue;
        if (!workspace.parentWorkspaceId) continue;
        tasks.push({ ...workspace, projectPath });
      }
    }
    return tasks;
  }

  private buildAgentTaskIndex(config: ReturnType<Config["loadConfigOrDefault"]>): AgentTaskIndex {
    const byId = new Map<string, AgentTaskWorkspaceEntry>();
    const childrenByParent = new Map<string, string[]>();
    const parentById = new Map<string, string>();

    for (const task of this.listAgentTaskWorkspaces(config)) {
      const taskId = task.id!;
      byId.set(taskId, task);

      const parent = task.parentWorkspaceId;
      if (!parent) continue;

      parentById.set(taskId, parent);
      const list = childrenByParent.get(parent) ?? [];
      list.push(taskId);
      childrenByParent.set(parent, list);
    }

    return { byId, childrenByParent, parentById };
  }

  private hasArchivedAncestor(
    index: AgentTaskIndex,
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): boolean {
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      workspaceId
    );
    return ancestorWorkspaceIds.some((ancestorWorkspaceId) => {
      const entry = findWorkspaceEntry(config, ancestorWorkspaceId);
      return (
        entry != null &&
        isWorkspaceArchived(entry.workspace.archivedAt, entry.workspace.unarchivedAt)
      );
    });
  }

  private isWorkflowOwnedTaskUsingIndex(index: AgentTaskIndex, taskId: string): boolean {
    assert(taskId.length > 0, "isWorkflowOwnedTaskUsingIndex: taskId must be non-empty");
    return this.findWorkflowTaskOwnerInAncestry(index, taskId) != null;
  }

  private isActiveWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): boolean {
    if (record.status === "running" && this.isForegroundAwaiting(record.workspaceId)) {
      return false;
    }
    return record.status === "starting" || record.status === "running";
  }

  private isLiveWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): boolean {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(record.workspaceId);
    return (
      (active?.handleId === record.handleId &&
        active.ownerWorkspaceId === record.ownerWorkspaceId) ||
      this.aiService.isStreaming(record.workspaceId) ||
      this.workspaceService.hasPendingQueuedOrPreparingTurn(record.workspaceId)
    );
  }

  private async settleStaleWorkspaceTurn(record: WorkspaceTurnTaskHandleRecord): Promise<void> {
    if (record.status !== "starting" && record.status !== "running") {
      return;
    }
    const recovered = await this.recoverTerminalWorkspaceTurnFromHistory(record);
    if (recovered != null) {
      await this.settleWorkspaceTurn({
        record,
        next: recovered,
        waiterSettlement:
          recovered.status === "completed"
            ? { status: "completed", result: this.buildWorkspaceTurnWaitResult(recovered) }
            : { status: "error", error: new Error(recovered.error ?? "Workspace turn failed") },
      });
      return;
    }

    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "interrupted",
      updatedAt: getIsoNow(),
      error: "Workspace turn interrupted after restart",
    };
    await this.settleWorkspaceTurn({
      record,
      next,
      waiterSettlement: {
        status: "error",
        error: new Error("Workspace turn interrupted after restart"),
      },
    });
  }

  private async countActiveWorkspaceTurns(
    records?: readonly WorkspaceTurnTaskHandleRecord[]
  ): Promise<number> {
    const candidateWorkspaceTurns =
      records ??
      (await this.taskHandleStore.listAllWorkspaceTurns({
        statuses: ["starting", "running"],
      }));
    let count = 0;
    for (const record of candidateWorkspaceTurns) {
      if (!this.isActiveWorkspaceTurn(record)) {
        continue;
      }
      if (!this.isLiveWorkspaceTurn(record)) {
        await this.settleStaleWorkspaceTurn(record);
        continue;
      }
      count += 1;
    }
    return count;
  }

  private async listActiveWorkspaceTurnTaskIdsForOwner(
    ownerWorkspaceId: string
  ): Promise<string[]> {
    const records = await this.taskHandleStore.listWorkspaceTurns(ownerWorkspaceId, {
      statuses: ["starting", "running"],
    });
    const taskIds: string[] = [];
    for (const record of records) {
      if (record.status !== "starting" && record.status !== "running") {
        continue;
      }
      if (!this.isLiveWorkspaceTurn(record)) {
        await this.settleStaleWorkspaceTurn(record);
        continue;
      }
      taskIds.push(record.handleId);
    }
    return taskIds;
  }

  private countActiveAgentTasks(config: ReturnType<Config["loadConfigOrDefault"]>): number {
    let activeCount = 0;
    for (const task of this.listAgentTaskWorkspaces(config)) {
      const status: AgentTaskStatus = task.taskStatus ?? "running";
      // If this task workspace is blocked in a foreground wait, do not count it towards parallelism.
      // This prevents deadlocks where a task spawns a nested task in the foreground while
      // maxParallelAgentTasks is low (e.g. 1).
      // Note: StreamManager can still report isStreaming() while a tool call is executing, so
      // isStreaming is not a reliable signal for "actively doing work" here.
      if (status === "running" && task.id && this.isForegroundAwaiting(task.id)) {
        continue;
      }
      if (status === "starting" || status === "running" || status === "awaiting_report") {
        activeCount += 1;
        continue;
      }

      // Defensive: task status and runtime stream state can be briefly out of sync during
      // termination/cleanup boundaries. Count streaming tasks as active so we never exceed
      // the configured parallel limit.
      if (task.id && this.aiService.isStreaming(task.id)) {
        activeCount += 1;
      }
    }

    return activeCount;
  }

  private hasActiveDescendantAgentTasks(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): boolean {
    return this.hasActiveDescendantAgentTasksUsingIndex(
      this.buildAgentTaskIndex(config),
      workspaceId
    );
  }

  private hasActiveDescendantAgentTasksUsingIndex(
    index: AgentTaskIndex,
    workspaceId: string
  ): boolean {
    assert(
      workspaceId.length > 0,
      "hasActiveDescendantAgentTasksUsingIndex: workspaceId must be non-empty"
    );

    const activeStatuses = new Set<AgentTaskStatus>([
      "queued",
      "starting",
      "running",
      "awaiting_report",
    ]);
    const stack: string[] = [...(index.childrenByParent.get(workspaceId) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop()!;
      const status = index.byId.get(next)?.taskStatus;
      if (status && activeStatuses.has(status)) {
        return true;
      }
      const children = index.childrenByParent.get(next);
      if (children) {
        for (const child of children) {
          stack.push(child);
        }
      }
    }

    return false;
  }

  /**
   * Topology predicate: does this workspace still have child agent-task nodes in config?
   * Unlike hasActiveDescendantAgentTasks (which checks runtime activity for scheduling),
   * this checks structural tree shape — any child node blocks parent deletion regardless
   * of its status.
   */
  private hasChildAgentTasks(index: AgentTaskIndex, workspaceId: string): boolean {
    return (index.childrenByParent.get(workspaceId)?.length ?? 0) > 0;
  }

  private getTaskDepth(
    config: ReturnType<Config["loadConfigOrDefault"]>,
    workspaceId: string
  ): number {
    assert(workspaceId.length > 0, "getTaskDepth: workspaceId must be non-empty");

    return this.getTaskDepthFromParentById(
      this.buildAgentTaskIndex(config).parentById,
      workspaceId
    );
  }

  private getTaskDepthFromParentById(parentById: Map<string, string>, workspaceId: string): number {
    let depth = 0;
    let current = workspaceId;
    for (let i = 0; i < 32; i++) {
      const parent = parentById.get(current);
      if (!parent) break;
      depth += 1;
      current = parent;
    }

    if (depth >= 32) {
      throw new Error(
        `getTaskDepthFromParentById: possible parentWorkspaceId cycle starting at ${workspaceId}`
      );
    }

    return depth;
  }

  async maybeStartQueuedTasks(): Promise<void> {
    const existingRun = this.maybeStartQueuedTasksInFlight;
    if (existingRun != null) {
      this.maybeStartQueuedTasksRerunRequested = true;
      await existingRun;
      return;
    }

    // A foreground task waiter registers itself in waitForAgentReport's async setup. Yield once so
    // immediate scheduler calls from the same turn see that foreground-awaiting state and avoid a
    // nested-task deadlock at maxParallelAgentTasks=1.
    await Promise.resolve();
    const existingRunAfterYield = this.maybeStartQueuedTasksInFlight;
    if (existingRunAfterYield != null) {
      this.maybeStartQueuedTasksRerunRequested = true;
      await existingRunAfterYield;
      return;
    }

    const run = (async () => {
      do {
        this.maybeStartQueuedTasksRerunRequested = false;
        await this.maybeStartQueuedTasksFromReservations();
      } while (this.maybeStartQueuedTasksRerunRequested);
    })().finally(() => {
      if (this.maybeStartQueuedTasksInFlight === run) {
        this.maybeStartQueuedTasksInFlight = undefined;
      }
    });
    this.maybeStartQueuedTasksInFlight = run;
    await run;
  }

  private async maybeStartQueuedTasksFromReservations(): Promise<void> {
    const plans: TaskLaunchPlan[] = [];

    {
      await using _lock = await this.mutex.acquire();

      let config = this.config.loadConfigOrDefault();
      const taskSettings: TaskSettings = config.taskSettings ?? DEFAULT_TASK_SETTINGS;
      const listQueuedTasks = (sourceConfig: ProjectsConfig): AgentTaskWorkspaceEntry[] =>
        this.listAgentTaskWorkspaces(sourceConfig)
          .filter((task) => task.taskStatus === "queued" && typeof task.id === "string")
          .sort((a, b) => {
            const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
            const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
            return aTime - bTime;
          });
      let taskIndex = this.buildAgentTaskIndex(config);
      let queuedTasks = listQueuedTasks(config);

      let interruptedInactiveWorkflowQueuedTask = false;
      for (const task of queuedTasks) {
        const taskId = task.id;
        assert(taskId != null && taskId.length > 0, "queued task id is required");
        if (
          await this.interruptTaskRecoveryForInactiveWorkflowOwner(
            taskId,
            config,
            "queued-inactive-workflow-owner-prepass",
            taskIndex,
            { scheduleQueueDrain: false }
          )
        ) {
          interruptedInactiveWorkflowQueuedTask = true;
        }
      }
      if (interruptedInactiveWorkflowQueuedTask) {
        config = this.config.loadConfigOrDefault();
        taskIndex = this.buildAgentTaskIndex(config);
        queuedTasks = listQueuedTasks(config);
      }

      const availableSlots = Math.max(
        0,
        taskSettings.maxParallelAgentTasks -
          (this.countActiveAgentTasks(config) + (await this.countActiveWorkspaceTurns()))
      );
      taskQueueDebug("TaskService.maybeStartQueuedTasks reservation summary", {
        maxParallelAgentTasks: taskSettings.maxParallelAgentTasks,
        availableSlots,
      });
      if (availableSlots === 0) return;

      let reservedSlots = 0;
      for (const task of queuedTasks) {
        if (reservedSlots >= availableSlots) {
          break;
        }
        const taskId = task.id;
        assert(taskId != null && taskId.length > 0, "queued task id is required");
        if (
          await this.interruptTaskRecoveryForInactiveWorkflowOwner(
            taskId,
            config,
            "queued-launch",
            taskIndex,
            { scheduleQueueDrain: false }
          )
        ) {
          continue;
        }

        if (this.aiService.isStreaming(taskId)) {
          await this.setTaskStatus(taskId, "running");
          reservedSlots += 1;
          continue;
        }

        const queuedPrompt = coerceNonEmptyString(task.taskPrompt);
        const start: TaskLaunchStart = queuedPrompt
          ? { kind: "sendMessage", prompt: queuedPrompt }
          : { kind: "resumeStream" };
        if (start.kind === "resumeStream") {
          // Older queued task records stored the initial prompt only in chat history.
          // Keep those upgrade-safe by resuming the existing pending stream instead of failing launch.
          taskQueueDebug("TaskService.maybeStartQueuedTasks legacy resumeStream reservation", {
            taskId,
          });
        }

        const parentWorkspaceId = coerceNonEmptyString(task.parentWorkspaceId);
        if (!parentWorkspaceId) {
          await this.markTaskLaunchFailed(taskId, "Queued task missing parentWorkspaceId");
          continue;
        }

        const parentEntry = findWorkspaceEntry(config, parentWorkspaceId);
        if (!parentEntry) {
          await this.markTaskLaunchFailed(taskId, "Queued task parent not found");
          continue;
        }
        const parentWorkspaceName = coerceNonEmptyString(parentEntry.workspace.name);
        if (!parentWorkspaceName) {
          await this.markTaskLaunchFailed(taskId, "Queued task parent missing workspace name");
          continue;
        }

        const taskRuntimeConfig = task.runtimeConfig ?? parentEntry.workspace.runtimeConfig;
        const parentRuntimeConfig = parentEntry.workspace.runtimeConfig ?? taskRuntimeConfig;
        if (!taskRuntimeConfig || !parentRuntimeConfig) {
          await this.markTaskLaunchFailed(taskId, "Queued task missing runtimeConfig");
          continue;
        }

        const normalizedTaskProjectPath = stripTrailingSlashes(task.projectPath);
        const taskProjectConfig = config.projects.get(normalizedTaskProjectPath);
        if (!taskProjectConfig?.trusted) {
          await this.markTaskLaunchFailed(taskId, "Task skipped: project is not trusted");
          continue;
        }
        const untrustedSecondaryProject =
          Array.isArray(task.projects) && task.projects.length > 1
            ? task.projects.find((project) => {
                const normalizedProjectPath = stripTrailingSlashes(project.projectPath);
                if (normalizedProjectPath === normalizedTaskProjectPath) {
                  return false;
                }
                return !(config.projects.get(normalizedProjectPath)?.trusted ?? false);
              })
            : undefined;
        if (untrustedSecondaryProject) {
          await this.markTaskLaunchFailed(
            taskId,
            `Task skipped: project ${untrustedSecondaryProject.projectPath} is not trusted`
          );
          continue;
        }

        const parentMetaResult = await this.aiService.getWorkspaceMetadata(parentWorkspaceId);
        const parentMeta = parentMetaResult.success
          ? parentMetaResult.data
          : ({
              id: parentWorkspaceId,
              name: parentWorkspaceName,
              projectPath: parentEntry.projectPath,
              projectName:
                parentEntry.workspace.projects?.find(
                  (project) =>
                    stripTrailingSlashes(project.projectPath) ===
                    stripTrailingSlashes(parentEntry.projectPath)
                )?.projectName ??
                parentEntry.projectPath.split("/").filter(Boolean).at(-1) ??
                parentEntry.projectPath,
              runtimeConfig: parentRuntimeConfig,
              projects: parentEntry.workspace.projects,
            } satisfies WorkspaceMetadata);

        const agentId = resolveTaskAgentIdForResume(task);
        assert(agentId.length > 0, "queued task agentId is required");
        let skipInitHook = false;
        try {
          const parentRuntime = createRuntimeForWorkspace({
            runtimeConfig: parentRuntimeConfig,
            projectPath: parentEntry.projectPath,
            name: parentWorkspaceName,
          });
          const parentWorkspacePath =
            coerceNonEmptyString(parentEntry.workspace.path) ??
            parentRuntime.getWorkspacePath(parentEntry.projectPath, parentWorkspaceName);
          const frontmatter = await resolveAgentFrontmatter(
            parentRuntime,
            parentWorkspacePath,
            agentId
          );
          skipInitHook = frontmatter.subagent?.skip_init_hook === true;
        } catch (error: unknown) {
          log.debug("Queued task: failed to resolve skip_init_hook during reservation", {
            taskId,
            agentId,
            error: getErrorMessage(error),
          });
        }

        const workspaceName = coerceNonEmptyString(task.name);
        if (!workspaceName) {
          await this.markTaskLaunchFailed(taskId, "Queued task missing workspace name");
          continue;
        }

        const canonicalModel =
          coerceNonEmptyString(task.aiSettings?.model) ??
          normalizeToCanonical(task.taskModelString ?? defaultModel);
        const createdAt = task.createdAt ?? getIsoNow();
        await this.editWorkspaceEntry(taskId, (workspace) => {
          workspace.taskStatus = "starting";
        });
        reservedSlots += 1;

        plans.push({
          taskId,
          parentWorkspaceId,
          parentMeta,
          agentId,
          agentType: task.agentType ?? agentId,
          start,
          title: task.title ?? workspaceName,
          workspaceName,
          createdAt,
          taskRuntimeConfig,
          parentRuntimeConfig,
          taskModelString: task.taskModelString ?? defaultModel,
          canonicalModel,
          effectiveThinkingLevel: task.taskThinkingLevel,
          skipInitHook,
          preferredTrunkBranch: task.taskTrunkBranch,
          workflowTask: task.workflowTask,
          bestOf: task.bestOf,
          experiments: task.taskExperiments,
        });
      }
    }

    await Promise.allSettled(
      plans.map(async (plan) => {
        try {
          await this.enqueueReservedTaskLaunch(plan);
        } catch (error: unknown) {
          log.error("Failed to launch dequeued task", { taskId: plan.taskId, error });
          await this.markTaskLaunchFailed(plan.taskId, getErrorMessage(error));
        }
      })
    );
  }

  private async enqueueReservedTaskLaunch(plan: TaskLaunchPlan): Promise<void> {
    assert(plan.taskId.length > 0, "enqueueReservedTaskLaunch requires taskId");
    await this.startReservedAgentTask(plan);
  }

  private async setTaskStatus(workspaceId: string, status: AgentTaskStatus): Promise<void> {
    assert(workspaceId.length > 0, "setTaskStatus: workspaceId must be non-empty");

    await this.editWorkspaceEntry(workspaceId, (ws) => {
      ws.taskStatus = status;
      if (status === "running") {
        ws.taskPrompt = undefined;
      }
    });

    await this.emitWorkspaceMetadata(workspaceId);

    if (status === "running") {
      const waiters = this.pendingStartWaitersByTaskId.get(workspaceId);
      if (!waiters || waiters.length === 0) return;
      this.pendingStartWaitersByTaskId.delete(workspaceId);
      for (const waiter of waiters) {
        try {
          waiter.start();
        } catch (error: unknown) {
          log.error("Task start waiter callback failed", { workspaceId, error });
        }
      }
    }
  }

  /**
   * Reset interrupt + auto-resume state for a workspace (called when user sends a real message).
   */
  resetAutoResumeCount(workspaceId: string): void {
    assert(workspaceId.length > 0, "resetAutoResumeCount: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.delete(workspaceId);
  }

  /** Mark a parent workspace as hard-interrupted by the user. */
  markParentWorkspaceInterrupted(workspaceId: string): void {
    assert(workspaceId.length > 0, "markParentWorkspaceInterrupted: workspaceId must be non-empty");
    this.consecutiveAutoResumes.delete(workspaceId);
    this.interruptedParentWorkspaceIds.add(workspaceId);
  }

  /**
   * If a preserved descendant task workspace was previously interrupted and the user manually
   * resumes it, restore taskStatus=running so stream-end finalization can proceed normally.
   *
   * Returns true only when a state transition happened.
   */
  async markInterruptedTaskRunning(workspaceId: string): Promise<boolean> {
    assert(workspaceId.length > 0, "markInterruptedTaskRunning: workspaceId must be non-empty");

    const configAtStart = this.config.loadConfigOrDefault();
    const entryAtStart = findWorkspaceEntry(configAtStart, workspaceId);
    if (!entryAtStart?.workspace.parentWorkspaceId) {
      return false;
    }
    if (entryAtStart.workspace.taskStatus !== "interrupted") {
      return false;
    }

    let transitionedToRunning = false;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        // Only descendant task workspaces have task lifecycle status.
        if (!ws.parentWorkspaceId) {
          return;
        }
        if (ws.taskStatus !== "interrupted") {
          return;
        }

        // Preserve taskPrompt here: interrupted queued tasks store their only initial
        // prompt in config. If send/resume fails, restoreInterruptedTaskAfterResumeFailure
        // must be able to retain that original prompt for inspection/retry.
        ws.taskStatus = "running";
        // A user-initiated resume is a fresh chance: clear the recovery budget so a
        // breaker-tripped task doesn't instantly re-fail on its first recovery prompt.
        delete ws.taskRecoveryAttempts;
        transitionedToRunning = true;
      },
      { allowMissing: true }
    );

    if (!transitionedToRunning) {
      return false;
    }

    await this.emitWorkspaceMetadata(workspaceId);
    return true;
  }

  /**
   * Revert a pre-stream interrupted->running transition when send/resume fails to start
   * or complete. This preserves fail-fast interrupted semantics for task_await.
   */
  async restoreInterruptedTaskAfterResumeFailure(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "restoreInterruptedTaskAfterResumeFailure: workspaceId must be non-empty"
    );

    let revertedToInterrupted = false;
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        if (!ws.parentWorkspaceId) {
          return;
        }
        if (ws.taskStatus !== "running") {
          return;
        }

        ws.taskStatus = "interrupted";
        ws.reportedAt = undefined;
        revertedToInterrupted = true;
      },
      { allowMissing: true }
    );

    if (!revertedToInterrupted) {
      return;
    }

    await this.emitWorkspaceMetadata(workspaceId);
  }

  private buildCompletionToolRecoveryMessage(
    completionToolName: "agent_report" | "propose_plan",
    options?: {
      reason?: "startup" | "stream_end" | "error";
      error?: Pick<ErrorEvent, "error" | "errorType">;
    }
  ): string {
    const completionToolLabel =
      completionToolName === "propose_plan" ? "propose_plan" : "agent_report";
    const completionInstruction = getTaskCompletionInstruction({ completionToolName });
    const noExtraWorkInstruction =
      completionToolName === "propose_plan"
        ? "Do not continue planning or call other tools."
        : "Do not continue investigating or call other tools.";

    switch (options?.reason) {
      case "startup":
        return `This task is awaiting its final ${completionToolLabel}. ${noExtraWorkInstruction} ${completionInstruction}`;
      case "error": {
        const errorType = options.error?.errorType
          ? ` (last error: ${options.error.errorType})`
          : "";
        return `The previous ${completionToolLabel} attempt failed${errorType}. ${noExtraWorkInstruction} ${completionInstruction}`;
      }
      case "stream_end":
      default:
        return `Your stream ended without calling ${completionToolLabel}. ${noExtraWorkInstruction} ${completionInstruction}`;
    }
  }

  private async promptTaskForRequiredCompletionTool(
    workspaceId: string,
    options?: {
      reason?: "startup" | "stream_end" | "error";
      error?: Pick<ErrorEvent, "error" | "errorType">;
    }
  ): Promise<boolean> {
    assert(
      workspaceId.length > 0,
      "promptTaskForRequiredCompletionTool: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return false;
    }
    if (entry.workspace.taskStatus !== "awaiting_report") {
      return false;
    }
    const taskIndex = this.buildAgentTaskIndex(cfg);
    if (
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        `completion-tool-${options?.reason ?? "unknown"}`,
        taskIndex
      )
    ) {
      return false;
    }
    if (this.hasActiveDescendantAgentTasksUsingIndex(taskIndex, workspaceId)) {
      return false;
    }
    if (this.aiService.isStreaming(workspaceId)) {
      return true;
    }

    const isPlanLike = await this.isPlanLikeTaskWorkspace(entry);
    const completionToolName = isPlanLike ? "propose_plan" : "agent_report";

    // Persisted circuit breaker: a task that keeps consuming recovery prompts
    // without ever completing is stuck (repeated empty output, repeated
    // length-truncated turns, or a model that never calls its completion
    // tool). Interrupt it with a descriptive error instead of prompting
    // forever. The counter lives on the workspace entry so restart loops stay
    // bounded too; finalizeAgentTaskReport clears it on success.
    const recoveryAttempts = entry.workspace.taskRecoveryAttempts ?? 0;
    if (recoveryAttempts >= MAX_TASK_RECOVERY_ATTEMPTS) {
      const lastError = options?.error
        ? ` Last error (${options.error.errorType ?? "unknown"}): ${options.error.error}`
        : "";
      log.error("Task exceeded its recovery attempt budget; interrupting task", {
        workspaceId,
        taskName: entry.workspace.name,
        recoveryAttempts,
        limit: MAX_TASK_RECOVERY_ATTEMPTS,
        reason: options?.reason,
      });
      await this.failAgentTaskTerminally(workspaceId, entry, {
        errorType: "task_recovery_limit",
        errorMessage: `Task interrupted after ${MAX_TASK_RECOVERY_ATTEMPTS} recovery attempts without a successful ${completionToolName}.${lastError} The task model may be unable to complete this request; try a different model or a simpler prompt.`,
      });
      return false;
    }
    // Consume budget before sending so a crash mid-send still counts the attempt.
    // Read the fresh value inside the mutator (not the entry-time snapshot above)
    // so concurrent edits cannot lose an increment.
    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        ws.taskRecoveryAttempts = (ws.taskRecoveryAttempts ?? 0) + 1;
      },
      { allowMissing: true }
    );

    const model = entry.workspace.taskModelString ?? defaultModel;
    const agentId = resolveTaskAgentIdForResume(entry.workspace);
    const startedAt = Date.now();
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      this.buildCompletionToolRecoveryMessage(completionToolName, options),
      {
        model,
        agentId,
        thinkingLevel: entry.workspace.taskThinkingLevel,
        experiments: entry.workspace.taskExperiments,
        toolPolicy: [{ regex_match: `^${completionToolName}$`, action: "require" }],
      },
      { synthetic: true, agentInitiated: true }
    );
    const durationMs = Date.now() - startedAt;
    if (!sendResult.success) {
      log.error("Failed to prompt task for required completion tool", {
        workspaceId,
        taskName: entry.workspace.name,
        projectPath: entry.projectPath,
        completionToolName,
        reason: options?.reason,
        model,
        agentId,
        durationMs,
        sendError: sendResult.error,
        priorErrorType: options?.error?.errorType,
        priorError: options?.error?.error,
      });
      return false;
    }

    log.info("Prompted task for required completion tool", {
      workspaceId,
      taskName: entry.workspace.name,
      projectPath: entry.projectPath,
      completionToolName,
      reason: options?.reason,
      model,
      agentId,
      durationMs,
    });
    return true;
  }

  private async promptTaskForBackgroundAwait(
    workspaceId: string,
    params: { taskIds: string[]; workflowRunIds: string[] }
  ): Promise<boolean> {
    assert(workspaceId.length > 0, "promptTaskForBackgroundAwait requires workspaceId");
    assert(
      params.taskIds.length > 0 || params.workflowRunIds.length > 0,
      "promptTaskForBackgroundAwait requires at least one awaitable target"
    );

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return false;
    }

    const model = entry.workspace.taskModelString ?? defaultModel;
    const agentId = entry.workspace.agentId ?? TASK_RECOVERY_FALLBACK_AGENT_ID;
    const sendResult = await this.workspaceService.sendMessage(
      workspaceId,
      buildBackgroundAwaitPrompt(params),
      {
        model,
        agentId,
        thinkingLevel: entry.workspace.taskThinkingLevel,
        experiments: entry.workspace.taskExperiments,
      },
      { synthetic: true, agentInitiated: true }
    );
    if (!sendResult.success) {
      log.error("Failed to prompt task for active background awaitables", {
        workspaceId,
        taskName: entry.workspace.name,
        taskIds: params.taskIds,
        workflowRunIds: params.workflowRunIds,
        model,
        agentId,
        error: sendResult.error,
      });
      return false;
    }
    return true;
  }

  private buildWorkspaceTurnMuxMetadata(
    record: Pick<WorkspaceTurnTaskHandleRecord, "handleId" | "ownerWorkspaceId" | "turnId">
  ): WorkspaceTurnMuxMetadata {
    return {
      type: "workspace-turn-task",
      taskHandleId: record.handleId,
      ownerWorkspaceId: record.ownerWorkspaceId,
      turnId: record.turnId,
    };
  }

  private getWorkspaceTurnMetadataFromValue(
    muxMetadata: unknown
  ): { taskHandleId: string; ownerWorkspaceId: string; turnId: string } | null {
    if (typeof muxMetadata !== "object" || muxMetadata == null || Array.isArray(muxMetadata)) {
      return null;
    }
    const data = muxMetadata as Record<string, unknown>;
    if (data.type !== "workspace-turn-task") {
      return null;
    }
    const taskHandleId = coerceNonEmptyString(data.taskHandleId);
    const ownerWorkspaceId = coerceNonEmptyString(data.ownerWorkspaceId);
    const turnId = coerceNonEmptyString(data.turnId);
    if (!taskHandleId || !ownerWorkspaceId || !turnId) {
      return null;
    }
    return { taskHandleId, ownerWorkspaceId, turnId };
  }

  private getWorkspaceTurnMetadata(
    event: StreamEndEvent
  ): { taskHandleId: string; ownerWorkspaceId: string; turnId: string } | null {
    return this.getWorkspaceTurnMetadataFromValue(event.metadata.muxMetadata);
  }

  private buildWorkspaceTurnReportMarkdown(event: StreamEndEvent): string {
    const text = event.parts
      .filter(
        (part): part is Extract<(typeof event.parts)[number], { type: "text" }> =>
          part.type === "text"
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    return text.length > 0 ? text : "Workspace turn completed without final text output.";
  }

  private buildWorkspaceTurnFinalMessageRef(event: StreamEndEvent): WorkspaceTurnFinalMessageRef {
    const textCharCount = event.parts
      .filter(
        (part): part is Extract<(typeof event.parts)[number], { type: "text" }> =>
          part.type === "text"
      )
      .reduce((sum, part) => sum + part.text.length, 0);
    const usage = event.metadata.usage;
    return {
      messageId: event.messageId,
      model: event.metadata.model,
      agentId: event.metadata.agentId,
      finishReason: event.metadata.finishReason,
      ...(usage != null
        ? {
            usageSummary: {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              totalTokens: usage.totalTokens,
            },
          }
        : {}),
      partCount: event.parts.length,
      textCharCount,
    };
  }

  private buildWorkspaceTurnStreamEndEventFromHistory(
    record: WorkspaceTurnTaskHandleRecord,
    message: MuxMessage
  ): StreamEndEvent | null {
    if (message.role !== "assistant" || message.metadata?.partial === true) {
      return null;
    }
    const metadata = this.getWorkspaceTurnMetadataFromValue(message.metadata?.muxMetadata);
    if (
      metadata == null ||
      metadata.taskHandleId !== record.handleId ||
      metadata.ownerWorkspaceId !== record.ownerWorkspaceId ||
      metadata.turnId !== record.turnId
    ) {
      return null;
    }
    return {
      type: "stream-end",
      workspaceId: record.workspaceId,
      messageId: message.id,
      metadata: {
        ...message.metadata,
        model: coerceNonEmptyString(message.metadata?.model) ?? record.modelString ?? defaultModel,
      },
      parts: message.parts as StreamEndEvent["parts"],
    };
  }

  private buildTerminalWorkspaceTurnRecordFromEvent(
    record: WorkspaceTurnTaskHandleRecord,
    event: StreamEndEvent
  ): WorkspaceTurnTaskHandleRecord {
    // Truncated/non-stop provider finishes are partial output, not a completed delegated turn.
    if (event.metadata.finishReason != null && event.metadata.finishReason !== "stop") {
      return {
        ...record,
        status: "error",
        updatedAt: getIsoNow(),
        messageId: event.messageId,
        error: `Workspace turn ended before completion (finishReason: ${event.metadata.finishReason})`,
        finalMessageRef: this.buildWorkspaceTurnFinalMessageRef(event),
        finalMessage: {
          messageId: event.messageId,
          metadata: event.metadata,
        },
      };
    }
    return {
      ...record,
      status: "completed",
      updatedAt: getIsoNow(),
      messageId: event.messageId,
      reportMarkdown: this.buildWorkspaceTurnReportMarkdown(event),
      finalMessageRef: this.buildWorkspaceTurnFinalMessageRef(event),
      finalMessage: {
        messageId: event.messageId,
        metadata: event.metadata,
      },
    };
  }

  private isDeferredWorkspaceTurnMessage(
    record: WorkspaceTurnTaskHandleRecord,
    messageId: string
  ): boolean {
    assert(messageId.length > 0, "isDeferredWorkspaceTurnMessage requires messageId");
    return record.deferredMessageIds?.includes(messageId) === true;
  }

  private async recoverTerminalWorkspaceTurnFromHistory(
    record: WorkspaceTurnTaskHandleRecord
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    const historyResult = await this.historyService.getHistoryFromLatestBoundary(
      record.workspaceId
    );
    if (!historyResult.success) {
      log.warn("Workspace turn stale recovery could not read history", {
        handleId: record.handleId,
        workspaceId: record.workspaceId,
        error: historyResult.error,
      });
      return null;
    }
    for (const message of historyResult.data.toReversed()) {
      if (this.isDeferredWorkspaceTurnMessage(record, message.id)) {
        continue;
      }
      const event = this.buildWorkspaceTurnStreamEndEventFromHistory(record, message);
      if (event != null) {
        return this.buildTerminalWorkspaceTurnRecordFromEvent(record, event);
      }
    }
    return null;
  }

  private async markWorkspaceTurnStreamEndDeferred(event: StreamEndEvent): Promise<void> {
    const metadata = this.getWorkspaceTurnMetadata(event);
    if (metadata == null) {
      return;
    }
    await this.workspaceTurnSettlementLocks.withLock(metadata.taskHandleId, async () => {
      const record = await this.taskHandleStore.getWorkspaceTurn(
        metadata.ownerWorkspaceId,
        metadata.taskHandleId
      );
      if (
        record == null ||
        record.workspaceId !== event.workspaceId ||
        record.turnId !== metadata.turnId ||
        !this.isActiveWorkspaceTurn(record) ||
        this.isDeferredWorkspaceTurnMessage(record, event.messageId)
      ) {
        return;
      }
      await this.taskHandleStore.upsertWorkspaceTurn({
        ...record,
        updatedAt: getIsoNow(),
        deferredMessageIds: [...(record.deferredMessageIds ?? []), event.messageId],
      });
    });
  }

  private resolveWorkspaceTurnMuxMetadataForStreamEnd(
    event: StreamEndEvent
  ): WorkspaceTurnMuxMetadata | undefined {
    const metadata = this.getWorkspaceTurnMetadata(event);
    if (metadata == null) {
      return undefined;
    }
    return {
      type: "workspace-turn-task",
      ...metadata,
    };
  }

  private async interruptWorkspaceTurnFromUncorrelatedStreamEnd(
    event: StreamEndEvent
  ): Promise<boolean> {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(event.workspaceId);
    if (active == null) {
      return false;
    }
    const record = await this.taskHandleStore.getWorkspaceTurn(
      active.ownerWorkspaceId,
      active.handleId
    );
    if (record == null) {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      log.warn("Ignoring missing uncorrelated workspace turn stream-end handle", {
        workspaceId: event.workspaceId,
        taskHandleId: active.handleId,
      });
      return true;
    }
    if (record.workspaceId !== event.workspaceId) {
      log.warn("Ignoring out-of-scope uncorrelated workspace turn stream-end", {
        workspaceId: event.workspaceId,
        taskHandleId: record.handleId,
      });
      return false;
    }
    if (record.status !== "starting" && record.status !== "running") {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      return true;
    }

    const error = "Workspace turn superseded by an uncorrelated workspace stream-end";
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "interrupted",
      updatedAt: getIsoNow(),
      messageId: event.messageId,
      error,
    };
    await this.settleWorkspaceTurn({
      record,
      next,
      waiterSettlement: { status: "error", error: new Error(error) },
    });
    return true;
  }

  private async finalizeWorkspaceTurnFromStreamEnd(event: StreamEndEvent): Promise<boolean> {
    const metadata = this.getWorkspaceTurnMetadata(event);
    if (metadata == null) {
      if (event.metadata.muxMetadata != null) {
        return false;
      }
      return await this.interruptWorkspaceTurnFromUncorrelatedStreamEnd(event);
    }
    const record = await this.taskHandleStore.getWorkspaceTurn(
      metadata.ownerWorkspaceId,
      metadata.taskHandleId
    );
    if (record == null) {
      log.warn("Ignoring missing workspace turn stream-end handle", {
        workspaceId: event.workspaceId,
        taskHandleId: metadata.taskHandleId,
      });
      return true;
    }
    if (record.workspaceId !== event.workspaceId || record.turnId !== metadata.turnId) {
      log.warn("Ignoring out-of-scope workspace turn stream-end", {
        workspaceId: event.workspaceId,
        taskHandleId: metadata.taskHandleId,
      });
      return true;
    }
    if (this.isDeferredWorkspaceTurnMessage(record, event.messageId)) {
      return true;
    }

    const next = this.buildTerminalWorkspaceTurnRecordFromEvent(record, event);
    await this.settleWorkspaceTurn({
      record,
      next,
      waiterSettlement:
        next.status === "completed"
          ? { status: "completed", result: this.buildWorkspaceTurnWaitResult(next) }
          : { status: "error", error: new Error(next.error ?? "Workspace turn failed") },
    });
    return true;
  }

  private async handleStreamEnd(event: StreamEndEvent): Promise<void> {
    const workspaceId = event.workspaceId;

    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry) return;
    const taskIndex = this.buildAgentTaskIndex(cfg);

    // Parent workspaces must not end while they have active background tasks/workflows.
    // Enforce by auto-resuming the stream with a directive to await outstanding work.
    if (!entry.workspace.parentWorkspaceId) {
      const hasActiveDescendants = this.hasActiveDescendantAgentTasksUsingIndex(
        taskIndex,
        workspaceId
      );
      const referencedWorkflowRunIds = await this.listAgentReferencedWorkflowRunIds(
        workspaceId,
        event.parts,
        event.messageId
      );
      let activeWorkflowRunIds = await this.listActiveBackgroundWorkflowRunIds(
        workspaceId,
        referencedWorkflowRunIds
      );
      let activeWorkspaceTurnIds = await this.listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
      if (!hasActiveDescendants) {
        // Foreground best-of children can finish while the parent task tool call is still pending,
        // which temporarily blocks their leaf cleanup and may defer synthetic fallback delivery.
        // Recheck both once the parent stream reaches a descendant-free stream-end.
        await this.deliverDeferredBestOfReportsForParent(workspaceId);
        await this.requestReportedChildCleanupRechecks(workspaceId);
        if (activeWorkflowRunIds.length === 0 && activeWorkspaceTurnIds.length === 0) {
          if (await this.finalizeWorkspaceTurnFromStreamEnd(event)) {
            return;
          }
          this.consecutiveAutoResumes.delete(workspaceId);
          return;
        }
      }

      await this.markWorkspaceTurnStreamEndDeferred(event);

      if (this.aiService.isStreaming(workspaceId)) {
        return;
      }

      if (this.interruptedParentWorkspaceIds.has(workspaceId)) {
        log.debug("Skipping parent auto-resume after hard interrupt", { workspaceId });
        return;
      }

      // Workflow-owned descendants report through the workflow runner; parent nudges must not
      // bypass that journal/final-result path by asking the model to task_await those child tasks
      // directly. Instead, await the owning workflow run when one is still active.
      // Foreground waits can also be backgrounded at runtime when users queue another message.
      let activeTaskIds = [
        ...this.listActiveDescendantAgentTaskIds(workspaceId, {
          excludeWorkflowTasks: true,
        }),
        ...activeWorkspaceTurnIds,
      ];
      const queueBackgroundedTaskIds = new Set(
        activeTaskIds.filter((id) => this.isTaskQueueBackgrounded(id))
      );
      const getBlockingTaskIds = (taskIds: string[]) =>
        taskIds.filter((id) => !queueBackgroundedTaskIds.has(id));
      const consumeQueueBackgroundedExemptions = () => {
        for (const taskId of new Set([...activeTaskIds, ...queueBackgroundedTaskIds])) {
          this.markTaskForegroundRelevant(taskId);
        }
      };
      let blockingTaskIds = getBlockingTaskIds(activeTaskIds);

      if (blockingTaskIds.length === 0 && activeWorkflowRunIds.length === 0) {
        if (await this.finalizeWorkspaceTurnFromStreamEnd(event)) {
          return;
        }
        this.consecutiveAutoResumes.delete(workspaceId);
        consumeQueueBackgroundedExemptions();
        log.debug("Skipping parent auto-resume: all active descendants were queue-backgrounded", {
          workspaceId,
        });
        return;
      }

      // If the parent already has a follow-up turn queued or starting (for example, the user
      // interrupted with new context), do not inject a synthetic task_await warning mid-handoff.
      if (this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)) {
        consumeQueueBackgroundedExemptions();
        log.debug("Skipping parent auto-resume: follow-up turn already queued or preparing", {
          workspaceId,
        });
        return;
      }

      const resumeOptions = await this.resolveParentAutoResumeOptions(
        workspaceId,
        entry,
        defaultModel,
        event.metadata
      );

      activeWorkspaceTurnIds = await this.listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
      activeTaskIds = [
        ...this.listActiveDescendantAgentTaskIds(workspaceId, {
          excludeWorkflowTasks: true,
        }),
        ...activeWorkspaceTurnIds,
      ];
      blockingTaskIds = getBlockingTaskIds(activeTaskIds);
      activeWorkflowRunIds = await this.listActiveBackgroundWorkflowRunIds(
        workspaceId,
        activeWorkflowRunIds
      );
      if (blockingTaskIds.length === 0 && activeWorkflowRunIds.length === 0) {
        if (await this.finalizeWorkspaceTurnFromStreamEnd(event)) {
          return;
        }
        this.consecutiveAutoResumes.delete(workspaceId);
        consumeQueueBackgroundedExemptions();
        return;
      }
      if (
        this.aiService.isStreaming(workspaceId) ||
        this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
      ) {
        consumeQueueBackgroundedExemptions();
        log.debug("Skipping parent auto-resume: workspace is no longer idle", { workspaceId });
        return;
      }

      // Check for auto-resume flood protection after the final active-work recheck so stale
      // workflow completions do not consume the retry budget.
      const resumeCount = this.consecutiveAutoResumes.get(workspaceId) ?? 0;
      if (resumeCount >= MAX_CONSECUTIVE_PARENT_AUTO_RESUMES) {
        consumeQueueBackgroundedExemptions();
        log.warn("Auto-resume limit reached for parent workspace with active background work", {
          workspaceId,
          resumeCount,
          activeTaskIds: blockingTaskIds,
          activeWorkflowRunIds,
          limit: MAX_CONSECUTIVE_PARENT_AUTO_RESUMES,
        });
        return;
      }
      this.consecutiveAutoResumes.set(workspaceId, resumeCount + 1);

      const prompt = buildBackgroundAwaitPrompt({
        taskIds: blockingTaskIds,
        workflowRunIds: activeWorkflowRunIds,
      });
      const workspaceTurnMuxMetadata = this.resolveWorkspaceTurnMuxMetadataForStreamEnd(event);
      const sendOptions = {
        model: resumeOptions.model,
        agentId: resumeOptions.agentId,
        thinkingLevel: resumeOptions.thinkingLevel,
        ...(workspaceTurnMuxMetadata != null ? { muxMetadata: workspaceTurnMuxMetadata } : {}),
      };
      let sendResult = await this.workspaceService.sendMessage(
        workspaceId,
        prompt,
        sendOptions,
        // Skip auto-resume counter reset — this IS an auto-resume, not a user message.
        { skipAutoResumeReset: true, synthetic: true, agentInitiated: true, requireIdle: true }
      );
      if (!sendResult.success && isWorkspaceBusyIdleOnlySend(sendResult.error)) {
        activeWorkspaceTurnIds = await this.listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
        activeTaskIds = [
          ...this.listActiveDescendantAgentTaskIds(workspaceId, {
            excludeWorkflowTasks: true,
          }),
          ...activeWorkspaceTurnIds,
        ];
        blockingTaskIds = getBlockingTaskIds(activeTaskIds);
        activeWorkflowRunIds = await this.listActiveBackgroundWorkflowRunIds(
          workspaceId,
          activeWorkflowRunIds
        );
        if (blockingTaskIds.length === 0 && activeWorkflowRunIds.length === 0) {
          if (await this.finalizeWorkspaceTurnFromStreamEnd(event)) {
            return;
          }
          this.consecutiveAutoResumes.delete(workspaceId);
          consumeQueueBackgroundedExemptions();
          return;
        }
        if (
          this.aiService.isStreaming(workspaceId) ||
          this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
        ) {
          if (resumeCount === 0) {
            this.consecutiveAutoResumes.delete(workspaceId);
          } else {
            this.consecutiveAutoResumes.set(workspaceId, resumeCount);
          }
          consumeQueueBackgroundedExemptions();
          log.debug("Skipping parent auto-resume fallback: workspace is no longer idle", {
            workspaceId,
          });
          return;
        }

        // AgentSession can still be in COMPLETING when StreamManager has emitted stream-end.
        // Queue this nudge rather than dropping the only await prompt for active background work.
        sendResult = await this.workspaceService.sendMessage(
          workspaceId,
          buildBackgroundAwaitPrompt({
            taskIds: blockingTaskIds,
            workflowRunIds: activeWorkflowRunIds,
          }),
          sendOptions,
          {
            skipAutoResumeReset: true,
            synthetic: true,
            agentInitiated: true,
          }
        );
      }
      consumeQueueBackgroundedExemptions();
      if (!sendResult.success) {
        if (resumeCount === 0) {
          this.consecutiveAutoResumes.delete(workspaceId);
        } else {
          this.consecutiveAutoResumes.set(workspaceId, resumeCount);
        }
        log.error("Failed to resume parent with active background work", {
          workspaceId,
          error: sendResult.error,
        });
      }
      return;
    }

    if (await this.finalizeWorkspaceTurnFromStreamEnd(event)) {
      return;
    }

    const status = entry.workspace.taskStatus;
    const reportArgs = this.findAgentReportArgsInParts(event.parts);

    // Stream-end settlement: interrupted tasks must settle all pending waiters.
    // Report present → finalize (resolve waiters). No report → reject waiters promptly.
    if (status === "interrupted") {
      await this.settleInterruptedTaskAtStreamEnd(workspaceId, entry, reportArgs);
      return;
    }
    if (status === "reported") {
      await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      return;
    }

    if (
      reportArgs == null &&
      (await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        "stream-end",
        taskIndex
      ))
    ) {
      return;
    }

    const isPlanLike = await this.isPlanLikeTaskWorkspace(entry);

    // Never allow a task to finish/report while it still has active descendant tasks.
    // We'll auto-resume this task once the last descendant reports.
    const hasActiveDescendants = this.hasActiveDescendantAgentTasksUsingIndex(
      taskIndex,
      workspaceId
    );
    if (hasActiveDescendants) {
      if (status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running");
      }
      return;
    }

    const taskReferencedWorkflowRunIds = await this.listAgentReferencedWorkflowRunIds(
      workspaceId,
      event.parts,
      event.messageId
    );
    const taskActiveWorkflowRunIds = await this.listBlockingBackgroundWorkflowRunIds(
      workspaceId,
      taskReferencedWorkflowRunIds,
      event.parts
    );
    const taskActiveWorkspaceTurnIds =
      await this.listActiveWorkspaceTurnTaskIdsForOwner(workspaceId);
    if (taskActiveWorkflowRunIds.length > 0 || taskActiveWorkspaceTurnIds.length > 0) {
      if (status === "awaiting_report") {
        await this.setTaskStatus(workspaceId, "running");
      }
      await this.promptTaskForBackgroundAwait(workspaceId, {
        taskIds: taskActiveWorkspaceTurnIds,
        workflowRunIds: taskActiveWorkflowRunIds,
      });
      return;
    }

    if (reportArgs) {
      const finalization = await this.finalizeAgentTaskReport(workspaceId, entry, reportArgs);
      if (finalization.finalized) {
        await this.finalizeTerminationPhaseForReportedTask(workspaceId);
      }
      return;
    }

    const proposePlanResult = this.findProposePlanSuccessInParts(event.parts);
    if (isPlanLike && proposePlanResult) {
      await this.handleSuccessfulProposePlanAutoHandoff({
        workspaceId,
        entry,
        proposePlanResult,
      });
      return;
    }

    // Only infer an implicit report from a clean natural stop. Length-truncated or other
    // provider finish reasons still go through explicit completion-tool recovery so partial
    // assistant text cannot prematurely finalize the task.
    const requiresStructuredOutput = entry.workspace.workflowTask?.outputSchema !== undefined;
    if (
      !requiresStructuredOutput &&
      !isPlanLike &&
      status !== "awaiting_report" &&
      event.metadata.finishReason === "stop"
    ) {
      const implicitReportArgs = this.findImplicitAgentReportArgsInParts(event.parts);
      if (implicitReportArgs) {
        const finalization = await this.finalizeAgentTaskReport(
          workspaceId,
          entry,
          implicitReportArgs
        );
        if (finalization.finalized) {
          await this.finalizeTerminationPhaseForReportedTask(workspaceId);
        }
        return;
      }
    }

    if (status !== "awaiting_report") {
      await this.setTaskStatus(workspaceId, "awaiting_report");
    }

    await this.promptTaskForRequiredCompletionTool(workspaceId, { reason: "stream_end" });
  }

  private async finalizeWorkspaceTurnFromStreamAbort(event: StreamAbortEvent): Promise<boolean> {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(event.workspaceId);
    if (active == null) {
      return false;
    }
    const record = await this.taskHandleStore.getWorkspaceTurn(
      active.ownerWorkspaceId,
      active.handleId
    );
    if (record == null) {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      return true;
    }
    if (!this.isActiveWorkspaceTurn(record)) {
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(event.workspaceId);
      return true;
    }
    if (event.abortReason !== "user") {
      return true;
    }
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "interrupted",
      updatedAt: getIsoNow(),
    };
    await this.settleWorkspaceTurn({
      record,
      next,
      waiterSettlement: { status: "error", error: new Error("Workspace turn interrupted") },
    });
    return true;
  }

  private async handleStreamAbort(event: StreamAbortEvent): Promise<void> {
    await this.finalizeWorkspaceTurnFromStreamAbort(event);
  }

  private async getActiveWorkspaceTurnRecordForWorkspace(
    workspaceId: string
  ): Promise<WorkspaceTurnTaskHandleRecord | null> {
    const active = this.activeWorkspaceTurnHandleByWorkspaceId.get(workspaceId);
    if (active != null) {
      const record = await this.taskHandleStore.getWorkspaceTurn(
        active.ownerWorkspaceId,
        active.handleId
      );
      if (record != null) {
        return record;
      }
      this.activeWorkspaceTurnHandleByWorkspaceId.delete(workspaceId);
    }

    const records = await this.taskHandleStore.listAllWorkspaceTurns({
      statuses: ["starting", "running"],
    });
    return records.toReversed().find((record) => record.workspaceId === workspaceId) ?? null;
  }

  private async hasRecoverableWorkspaceTurnRetryInFlight(workspaceId: string): Promise<boolean> {
    await this.workspaceService.waitForPendingStreamErrorRecoveryDecision(workspaceId);
    return (
      this.aiService.isStreaming(workspaceId) ||
      this.workspaceService.hasPendingQueuedOrPreparingTurn(workspaceId)
    );
  }

  private async finalizeWorkspaceTurnFromStreamError(event: ErrorEvent): Promise<boolean> {
    const record = await this.getActiveWorkspaceTurnRecordForWorkspace(event.workspaceId);
    if (record == null) {
      return false;
    }
    if (
      event.errorType != null &&
      WORKSPACE_TURN_RECOVERABLE_STREAM_ERRORS.has(event.errorType) &&
      (await this.hasRecoverableWorkspaceTurnRetryInFlight(record.workspaceId))
    ) {
      return true;
    }
    const next: WorkspaceTurnTaskHandleRecord = {
      ...record,
      status: "error",
      updatedAt: getIsoNow(),
      error: event.error,
    };
    await this.settleWorkspaceTurn({
      record,
      next,
      waiterSettlement: { status: "error", error: new Error(event.error) },
    });
    return true;
  }

  private async handleTaskStreamError(event: ErrorEvent): Promise<void> {
    if (await this.finalizeWorkspaceTurnFromStreamError(event)) {
      return;
    }
    const workspaceId = event.workspaceId;
    const cfg = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(cfg, workspaceId);
    if (!entry?.workspace.parentWorkspaceId) {
      return;
    }

    const status = entry.workspace.taskStatus;
    // Stream errors only need settlement handling while the task is mid-run
    // (running) or waiting on its completion tool (awaiting_report).
    if (status !== "running" && status !== "awaiting_report") {
      return;
    }
    const taskIndex = this.buildAgentTaskIndex(cfg);

    if (
      await this.interruptTaskRecoveryForInactiveWorkflowOwner(
        workspaceId,
        cfg,
        "stream-error",
        taskIndex
      )
    ) {
      return;
    }

    if (this.hasActiveDescendantAgentTasksUsingIndex(taskIndex, workspaceId)) {
      return;
    }

    const isNonRetryable =
      event.errorType != null && isNonRetryableStreamError({ type: event.errorType });

    // Terminal provider outcomes (e.g. model_refusal) settle the task even during its
    // first `running` turn — previously only awaiting_report settled, leaving the
    // parent's waitForAgentReport to block until timeout. Deliberately an allow-list
    // rather than "all non-retryable":
    // - `aborted` is a steerable user pause, not a terminal failure.
    // - `context_exceeded` has in-session recovery (compaction retry, post-compaction
    //   retry, exec-subagent hard restart in AgentSession.handleStreamError) listening
    //   on the same error event; settling here would race that recovery and interrupt
    //   a child that was about to continue.
    const settlesRunningTask =
      event.errorType != null && RUNNING_TASK_TERMINAL_STREAM_ERRORS.has(event.errorType);

    if (isNonRetryable && (status === "awaiting_report" || settlesRunningTask)) {
      log.error("Task hit a non-retryable stream error; interrupting task", {
        workspaceId,
        taskStatus: status,
        errorType: event.errorType,
        error: event.error,
      });
      await this.failAgentTaskTerminally(workspaceId, entry, {
        errorType: event.errorType ?? "unknown",
        errorMessage: event.error,
      });
      return;
    }

    if (status !== "awaiting_report") {
      // Retryable errors during `running` are handled by the agent session's
      // retry loop; TaskService only intervenes once the task owes its report.
      return;
    }

    log.warn(
      "Task awaiting required completion tool hit a stream error; retrying report-only recovery",
      {
        workspaceId,
        errorType: event.errorType,
        error: event.error,
      }
    );

    await this.promptTaskForRequiredCompletionTool(workspaceId, {
      reason: "error",
      error: event,
    });
  }

  /**
   * Terminal settlement for a child task whose stream failed with a
   * non-retryable error: mark interrupted with a descriptive launch error,
   * persist a durable failure artifact in every ancestor session dir (so
   * background children, restarts, and post-cleanup task_awaits observe the
   * typed failure), then reject pending waiters with the failure message.
   */
  private async failAgentTaskTerminally(
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string }
  ): Promise<void> {
    assert(workspaceId.length > 0, "failAgentTaskTerminally: workspaceId must be non-empty");
    assert(
      failure.errorMessage.length > 0,
      "failAgentTaskTerminally: errorMessage must be non-empty"
    );

    await this.editWorkspaceEntry(
      workspaceId,
      (ws) => {
        ws.taskStatus = "interrupted";
        ws.taskLaunchError = failure.errorMessage;
      },
      { allowMissing: true }
    );
    await this.emitWorkspaceMetadata(workspaceId);

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (parentWorkspaceId) {
      const cfg = this.config.loadConfigOrDefault();
      const index = this.buildAgentTaskIndex(cfg);
      const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
        index.parentById,
        workspaceId
      );
      const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
        (ancestorWorkspaceId) =>
          this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
            index,
            ancestorWorkspaceId,
            workspaceId
          ) === true
      );

      const persistedAtMs = Date.now();
      for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
        try {
          await upsertSubagentFailureArtifact({
            workspaceId: ancestorWorkspaceId,
            workspaceSessionDir: this.config.getSessionDir(ancestorWorkspaceId),
            childTaskId: workspaceId,
            parentWorkspaceId,
            ancestorWorkspaceIds,
            workflowOwnedAncestorWorkspaceIds,
            errorType: failure.errorType,
            errorMessage: failure.errorMessage,
            model: entry.workspace.taskModelString,
            nowMs: persistedAtMs,
          });
        } catch (error: unknown) {
          log.error("Failed to persist subagent failure artifact", {
            workspaceId: ancestorWorkspaceId,
            childTaskId: workspaceId,
            error,
          });
        }
      }
    }

    // Captured before settlement: rejectWaiters consumes the pending waiters
    // that prove a parent turn is actively listening for this task.
    const hadForegroundWaiters = (this.pendingWaitersByTaskId.get(workspaceId)?.length ?? 0) > 0;

    await this.settleInterruptedTaskAtStreamEnd(workspaceId, entry, null, {
      rejectionError: new Error(failure.errorMessage),
    });

    // Free this task's concurrency slot for queued siblings.
    this.scheduleMaybeStartQueuedTasks();

    await this.maybeResumeParentAfterTerminalChildFailure(
      workspaceId,
      entry,
      failure,
      hadForegroundWaiters
    );
  }

  /**
   * Background-spawned children may have no pending waiter to reject, and the
   * parent stream typically already returned early because the child was still
   * active. The report path delivers into the parent context and wakes idle
   * parents (deliverReportToParent + post-report auto-resume), so terminal
   * failures must too — otherwise an idle parent stays at taskStatus "running"
   * until a timeout or manual task_await, or worse: a later sibling's report
   * wakes it with COMPLETED_BACKGROUND_SUBAGENT_HANDOFF_PROMPT and the fanout
   * looks fully successful. Two mirrored halves:
   *
   * 1. Always append a synthetic mux_subagent_failure message to the parent
   *    history (the durable context delivery — survives any wake-up ordering).
   * 2. Auto-resume the parent only when this was the last active child and the
   *    parent is idle (same gates as the post-report auto-resume).
   */
  private async maybeResumeParentAfterTerminalChildFailure(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry },
    failure: { errorType: string; errorMessage: string },
    hadForegroundWaiters: boolean
  ): Promise<void> {
    const parentWorkspaceId = childEntry.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return;
    }
    // An active waiter (foreground task tool call or task_await) already
    // surfaced the rejection to the parent's in-flight turn.
    if (hadForegroundWaiters) {
      return;
    }
    // Workflow-owned children propagate failures through the WorkflowRunner
    // step result; do not also deliver a generic failure handoff.
    if (childEntry.workspace.workflowTask != null) {
      return;
    }

    const cfg = this.config.loadConfigOrDefault();
    const parentEntry = findWorkspaceEntry(cfg, parentWorkspaceId);
    if (!parentEntry) {
      return;
    }

    // Durable context delivery, mirroring deliverReportToParent's synthetic
    // append: the failure must be visible to the parent's next turn regardless
    // of whether THIS settlement wakes it or a later sibling report/failure
    // (whose handoff prompt won't restate this child's details) does.
    const failureMessage = createMuxMessage(
      createTaskFailureMessageId(),
      "user",
      formatSubagentFailureUserMessage({
        childWorkspaceId,
        agentType: coerceNonEmptyString(childEntry.workspace.agentType) ?? "agent",
        errorType: failure.errorType,
        errorMessage: failure.errorMessage,
      }),
      { timestamp: Date.now(), synthetic: true }
    );
    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      failureMessage
    );
    if (!appendResult.success) {
      log.error("Failed to append synthetic subagent failure to parent history", {
        parentWorkspaceId,
        childWorkspaceId,
        error: appendResult.error,
      });
    }

    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(cfg, parentWorkspaceId);
    if (!hasActiveDescendants) {
      this.consecutiveAutoResumes.delete(parentWorkspaceId);
    }
    if (this.interruptedParentWorkspaceIds.has(parentWorkspaceId)) {
      log.debug("Skipping terminal-failure parent auto-resume after hard interrupt", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return;
    }
    if (hasActiveDescendants) {
      // Remaining active children wake the parent when the last one settles
      // (report delivery or another terminal failure); the failure message
      // appended above keeps this child's outcome in that turn's context.
      return;
    }
    if (this.aiService.isStreaming(parentWorkspaceId)) {
      // A streaming parent picks the appended failure message up on its next
      // turn (or sooner via a task_await rejection / persisted artifact).
      return;
    }

    const resumeOptions = await this.resolveParentAutoResumeOptions(
      parentWorkspaceId,
      parentEntry,
      childEntry.workspace.taskModelString ?? defaultModel
    );
    const sendResult = await this.workspaceService.sendMessage(
      parentWorkspaceId,
      FAILED_BACKGROUND_SUBAGENT_HANDOFF_PROMPT,
      {
        model: resumeOptions.model,
        agentId: resumeOptions.agentId,
        thinkingLevel: resumeOptions.thinkingLevel,
      },
      // Skip auto-resume counter reset — this IS an auto-resume, not a user message.
      { skipAutoResumeReset: true, synthetic: true, agentInitiated: true }
    );
    if (!sendResult.success) {
      log.error("Failed to auto-resume parent after terminal child failure", {
        parentWorkspaceId,
        childWorkspaceId,
        error: sendResult.error,
      });
    }
  }

  /**
   * Stream-end settlement for interrupted tasks. Guarantees every pending waiter
   * is settled exactly once: resolved if an agent_report exists, rejected otherwise.
   * No waiter should depend on timeout to discover terminal interruption.
   */
  private async settleInterruptedTaskAtStreamEnd(
    workspaceId: string,
    entry: { projectPath: string; workspace: WorkspaceConfigEntry },
    reportArgs: { reportMarkdown: string; title?: string; structuredOutput?: unknown } | null,
    options?: { rejectionError?: Error }
  ): Promise<void> {
    if (reportArgs) {
      const finalization = await this.finalizeAgentTaskReport(workspaceId, entry, reportArgs);
      if (!finalization.finalized) {
        this.rejectWaiters(workspaceId, new Error(finalization.message));
      }
      return;
    }

    this.rejectWaiters(workspaceId, options?.rejectionError ?? new Error("Task interrupted"));

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    const bestOf = entry.workspace.bestOf;
    if (
      parentWorkspaceId &&
      bestOf?.total != null &&
      bestOf.total > 1 &&
      !this.aiService.isStreaming(parentWorkspaceId)
    ) {
      await this.deliverDeferredBestOfSiblingReports({
        parentWorkspaceId,
        groupId: bestOf.groupId,
        total: bestOf.total,
      });
    }
  }

  private async handleSuccessfulProposePlanAutoHandoff(args: {
    workspaceId: string;
    entry: { projectPath: string; workspace: WorkspaceConfigEntry };
    proposePlanResult: { planPath: string };
  }): Promise<void> {
    assert(
      args.workspaceId.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: workspaceId must be non-empty"
    );
    assert(
      args.proposePlanResult.planPath.length > 0,
      "handleSuccessfulProposePlanAutoHandoff: planPath must be non-empty"
    );

    if (this.handoffInProgress.has(args.workspaceId)) {
      log.debug("Skipping duplicate plan-task auto-handoff", { workspaceId: args.workspaceId });
      return;
    }

    this.handoffInProgress.add(args.workspaceId);

    try {
      let planSummary: { content: string; path: string } | null = null;

      try {
        const info = await this.workspaceService.getInfo(args.workspaceId);
        if (!info) {
          log.error("Plan-task auto-handoff could not read workspace metadata", {
            workspaceId: args.workspaceId,
          });
        } else {
          const runtime = createRuntimeForWorkspace(info);
          const planResult = await readPlanFile(
            runtime,
            info.name,
            info.projectName,
            args.workspaceId
          );
          if (planResult.exists) {
            planSummary = { content: planResult.content, path: planResult.path };
          } else {
            log.error("Plan-task auto-handoff did not find plan file content", {
              workspaceId: args.workspaceId,
              planPath: args.proposePlanResult.planPath,
            });
          }
        }
      } catch (error: unknown) {
        log.error("Plan-task auto-handoff failed to read plan file", {
          workspaceId: args.workspaceId,
          planPath: args.proposePlanResult.planPath,
          error,
        });
      }

      const targetAgentId = "exec" as const;

      const summaryContent = planSummary
        ? `# Plan\n\n${planSummary.content}\n\nNote: This chat already contains the full plan; no need to re-open the plan file.\n\n---\n\n*Plan file preserved at:* \`${planSummary.path}\``
        : `A plan was proposed at ${args.proposePlanResult.planPath}. Read the plan file and implement it.`;

      const summaryMessage = createMuxMessage(
        createCompactionSummaryMessageId(),
        "assistant",
        summaryContent,
        {
          timestamp: Date.now(),
          compacted: "user",
          agentId: "plan",
        }
      );

      const replaceHistoryResult = await this.workspaceService.replaceHistory(
        args.workspaceId,
        summaryMessage,
        {
          mode: "append-compaction-boundary",
          deletePlanFile: false,
        }
      );
      if (!replaceHistoryResult.success) {
        log.error("Plan-task auto-handoff failed to compact history", {
          workspaceId: args.workspaceId,
          error: replaceHistoryResult.error,
        });
      }

      // Use the same sub-agent resolution as Task.create so Plan to Exec honors
      // subagentAiDefaults before UI agent defaults, then inherits the plan task settings.
      const { taskModelString, canonicalModel, effectiveThinkingLevel } =
        this.resolveTaskAISettings({
          cfg: this.config.loadConfigOrDefault(),
          parentMeta: {},
          agentId: targetAgentId,
          parentRuntimeAiSettings: {
            modelString: args.entry.workspace.taskModelString,
            thinkingLevel: args.entry.workspace.taskThinkingLevel,
          },
        });

      await this.editWorkspaceEntry(args.workspaceId, (workspace) => {
        workspace.agentId = targetAgentId;
        workspace.agentType = targetAgentId;
        workspace.aiSettings = { model: canonicalModel, thinkingLevel: effectiveThinkingLevel };
        workspace.taskModelString = taskModelString;
        workspace.taskThinkingLevel = effectiveThinkingLevel;
        // A successful propose_plan is a successful completion-tool outcome: the
        // exec phase starts with a fresh recovery budget rather than inheriting
        // whatever the plan phase consumed.
        delete workspace.taskRecoveryAttempts;
      });

      await this.setTaskStatus(args.workspaceId, "running");

      try {
        const sendKickoffResult = await this.workspaceService.sendMessage(
          args.workspaceId,
          "Implement the plan.",
          {
            model: taskModelString,
            agentId: targetAgentId,
            thinkingLevel: effectiveThinkingLevel,
            experiments: args.entry.workspace.taskExperiments,
          },
          { synthetic: true, agentInitiated: true }
        );
        if (!sendKickoffResult.success) {
          // Keep status as "running" so the restart handler in initialize() can
          // re-attempt the kickoff on next startup, rather than moving to
          // "awaiting_report" which could finalize the task prematurely.
          log.error(
            "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
            {
              workspaceId: args.workspaceId,
              targetAgentId,
              error: sendKickoffResult.error,
            }
          );
        }
      } catch (error: unknown) {
        // Same as above: leave status as "running" for restart recovery.
        log.error(
          "Plan-task auto-handoff failed to send kickoff message; task stays running for retry on restart",
          {
            workspaceId: args.workspaceId,
            targetAgentId,
            error,
          }
        );
      }
    } catch (error: unknown) {
      log.error("Plan-task auto-handoff failed", {
        workspaceId: args.workspaceId,
        planPath: args.proposePlanResult.planPath,
        error,
      });
    } finally {
      this.handoffInProgress.delete(args.workspaceId);
    }
  }

  private async finalizeTerminationPhaseForReportedTask(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "finalizeTerminationPhaseForReportedTask: workspaceId must be non-empty"
    );

    await this.cleanupReportedLeafTask(workspaceId);
  }

  private async maybeStartPatchGenerationForReportedTask(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "maybeStartPatchGenerationForReportedTask: workspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const parentWorkspaceId = findWorkspaceEntry(cfg, workspaceId)?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return;
    }

    try {
      await this.gitPatchArtifactService.maybeStartGeneration(
        parentWorkspaceId,
        workspaceId,
        (wsId) => this.requestReportedTaskCleanupRecheck(wsId)
      );
    } catch (error: unknown) {
      log.error("Failed to start subagent git patch generation", {
        parentWorkspaceId,
        childWorkspaceId: workspaceId,
        error,
      });
    }
  }

  private requestReportedTaskCleanupRecheck(workspaceId: string): Promise<void> {
    assert(
      workspaceId.length > 0,
      "requestReportedTaskCleanupRecheck: workspaceId must be non-empty"
    );

    return this.workspaceEventLocks.withLock(workspaceId, async () => {
      await this.cleanupReportedLeafTask(workspaceId);
    });
  }

  private async requestReportedChildCleanupRechecks(parentWorkspaceId: string): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "requestReportedChildCleanupRechecks: parentWorkspaceId must be non-empty"
    );

    const cfg = this.config.loadConfigOrDefault();
    const reportedChildTaskIds: string[] = [];
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        const workspaceId = coerceNonEmptyString(workspace.id);
        if (!workspaceId || workspace.parentWorkspaceId !== parentWorkspaceId) {
          continue;
        }
        if (!hasCompletedAgentReport(workspace)) {
          continue;
        }
        reportedChildTaskIds.push(workspaceId);
      }
    }

    for (const workspaceId of reportedChildTaskIds) {
      await this.requestReportedTaskCleanupRecheck(workspaceId);
    }
  }

  private async deliverDeferredBestOfReportsForParent(parentWorkspaceId: string): Promise<void> {
    assert(
      parentWorkspaceId.length > 0,
      "deliverDeferredBestOfReportsForParent: parentWorkspaceId must be non-empty"
    );

    const pendingGroup = await this.resolvePendingBestOfGroupForParent(parentWorkspaceId);
    if (!pendingGroup) {
      return;
    }

    await this.deliverDeferredBestOfSiblingReports({
      parentWorkspaceId,
      groupId: pendingGroup.groupId,
      total: pendingGroup.total,
    });
  }

  private async resolvePendingBestOfGroupForParent(
    parentWorkspaceId: string
  ): Promise<{ groupId: string; total: number } | null> {
    const partial = await this.historyService.readPartial(parentWorkspaceId);
    if (!partial) {
      return null;
    }

    const pendingParts = partial.parts.filter(
      (part): part is DynamicToolPart & { toolName: "task"; state: "input-available" } =>
        isDynamicToolPart(part) && part.toolName === "task" && part.state === "input-available"
    );
    if (pendingParts.length !== 1) {
      return null;
    }

    const parsedInput = TaskToolArgsSchema.safeParse(pendingParts[0].input);
    if (!parsedInput.success) {
      return null;
    }

    const requestedTotal = getTaskGroupCount(parsedInput.data);
    if (requestedTotal <= 1) {
      return null;
    }

    const requestedAgentId = coerceNonEmptyString(
      parsedInput.data.agentId ?? parsedInput.data.subagent_type
    )?.toLowerCase();
    const requestedTitle = coerceNonEmptyString(parsedInput.data.title);
    const partialStartedAt =
      typeof partial.metadata?.timestamp === "number" ? partial.metadata.timestamp : undefined;

    const cfg = this.config.loadConfigOrDefault();
    const groups = new Map<string, { groupId: string; total: number; createdAtMs: number[] }>();
    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        if (workspace.parentWorkspaceId !== parentWorkspaceId) {
          continue;
        }

        const groupId = coerceNonEmptyString(workspace.bestOf?.groupId);
        const total = workspace.bestOf?.total;
        if (!groupId || total !== requestedTotal) {
          continue;
        }

        const workspaceAgentId = resolvePersistedAgentId(workspace, "");
        if (requestedAgentId && workspaceAgentId && workspaceAgentId !== requestedAgentId) {
          continue;
        }

        const workspaceTitle = coerceNonEmptyString(workspace.title);
        if (requestedTitle && workspaceTitle && workspaceTitle !== requestedTitle) {
          continue;
        }

        const entry = groups.get(groupId) ?? { groupId, total, createdAtMs: [] };
        const createdAtMs =
          typeof workspace.createdAt === "string" ? Date.parse(workspace.createdAt) : Number.NaN;
        if (Number.isFinite(createdAtMs)) {
          entry.createdAtMs.push(createdAtMs);
        }
        groups.set(groupId, entry);
      }
    }

    const matchingGroups = Array.from(groups.values());
    const startedAfterPartial = (group: { createdAtMs: number[] }): boolean => {
      if (partialStartedAt == null) {
        return true;
      }

      return (
        group.createdAtMs.length > 0 &&
        group.createdAtMs.every((createdAtMs) => createdAtMs >= partialStartedAt)
      );
    };
    if (matchingGroups.length === 0) {
      return null;
    }
    if (matchingGroups.length === 1) {
      return startedAfterPartial(matchingGroups[0]) ? matchingGroups[0] : null;
    }
    if (partialStartedAt == null) {
      return null;
    }

    const recentMatchingGroups = matchingGroups.filter((group) => startedAfterPartial(group));
    return recentMatchingGroups.length === 1 ? recentMatchingGroups[0] : null;
  }

  private async deliverDeferredBestOfSiblingReports(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
  }): Promise<void> {
    assert(
      params.parentWorkspaceId.length > 0,
      "deliverDeferredBestOfSiblingReports: parentWorkspaceId must be non-empty"
    );

    const cleanupTaskIds = new Set<string>();
    await this.deferredBestOfLocks.withLock(params.parentWorkspaceId, async () => {
      const cfg = this.config.loadConfigOrDefault();
      const siblings = this.listBestOfSiblingTasks({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
      });
      const groupedOutput = await this.buildBestOfCompletedTaskToolOutput({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        total: params.total,
      });
      if (groupedOutput) {
        const representativeTaskId = siblings[0]?.taskId;
        if (representativeTaskId) {
          const finalization = await this.tryFinalizePendingTaskToolCallInPartial(
            params.parentWorkspaceId,
            groupedOutput,
            representativeTaskId,
            findWorkspaceEntry(cfg, representativeTaskId)
          );
          if (finalization.kind === "finalized") {
            for (const taskId of finalization.taskIds) {
              cleanupTaskIds.add(taskId);
            }
            return;
          }
        }
      }

      if (
        await this.shouldDeferBestOfFallback({
          parentWorkspaceId: params.parentWorkspaceId,
          groupId: params.groupId,
          total: params.total,
        })
      ) {
        return;
      }

      const parentTaskToolState = await this.getTaskToolPartialState(params.parentWorkspaceId);
      const syntheticReportTaskIds = new Set<string>();
      const historyResult = await this.historyService.getHistoryFromLatestBoundary(
        params.parentWorkspaceId
      );
      if (historyResult.success) {
        for (const message of historyResult.data) {
          if (message.role !== "user" || message.metadata?.synthetic !== true) {
            continue;
          }
          const text = message.parts
            .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          if (!text.includes("<mux_subagent_report>")) {
            continue;
          }
          for (const match of text.matchAll(/<task_id>([^<]+)<\/task_id>/g)) {
            const taskId = coerceNonEmptyString(match[1]);
            if (taskId) {
              syntheticReportTaskIds.add(taskId);
            }
          }
        }
      }

      const parentSessionDir = this.config.getSessionDir(params.parentWorkspaceId);
      for (const sibling of siblings) {
        if (
          parentTaskToolState.referencedTaskIds.has(sibling.taskId) ||
          syntheticReportTaskIds.has(sibling.taskId)
        ) {
          continue;
        }
        if (!(sibling.taskStatus === "reported" || sibling.taskStatus === "interrupted")) {
          continue;
        }

        const artifact = await readSubagentReportArtifact(parentSessionDir, sibling.taskId);
        if (!artifact) {
          continue;
        }

        const siblingCleanupTaskIds = await this.deliverReportToParentUnlocked(
          params.parentWorkspaceId,
          sibling.taskId,
          findWorkspaceEntry(cfg, sibling.taskId),
          {
            reportMarkdown: artifact.reportMarkdown,
            ...(artifact.title !== undefined ? { title: artifact.title } : {}),
            ...(artifact.structuredOutput !== undefined
              ? { structuredOutput: artifact.structuredOutput }
              : {}),
          }
        );
        for (const taskId of siblingCleanupTaskIds) {
          cleanupTaskIds.add(taskId);
        }
      }
    });

    for (const taskId of cleanupTaskIds) {
      await this.requestReportedTaskCleanupRecheck(taskId);
    }
  }

  private async getChildReportCostCents(childWorkspaceId: string): Promise<number> {
    assert(childWorkspaceId.trim().length > 0, "getChildReportCostCents requires childWorkspaceId");
    if (!this.sessionUsageService) {
      return 0;
    }

    try {
      const childUsage = await this.sessionUsageService.getSessionUsage(childWorkspaceId);
      if (!childUsage) {
        return 0;
      }
      return Math.max(
        0,
        Math.round((getTotalCost(sumUsageHistory(Object.values(childUsage.byModel))) ?? 0) * 100)
      );
    } catch (error) {
      log.warn("Failed to read child usage for goal attribution", { childWorkspaceId, error });
      return 0;
    }
  }

  private async attributeChildReportToParentGoal(
    parentWorkspaceId: string,
    childWorkspaceId: string
  ): Promise<void> {
    assert(
      parentWorkspaceId.trim().length > 0,
      "attributeChildReportToParentGoal requires parentWorkspaceId"
    );
    assert(
      childWorkspaceId.trim().length > 0,
      "attributeChildReportToParentGoal requires childWorkspaceId"
    );
    if (!this.workspaceGoalService) {
      return;
    }

    const childCostCents = await this.getChildReportCostCents(childWorkspaceId);
    const attribution = await this.workspaceGoalService.attributeChildReport({
      parentWorkspaceId,
      childWorkspaceId,
      childCostCents,
    });
    if (!attribution?.causedBudgetLimit) {
      return;
    }

    this.workspaceService.emitChatEvent(parentWorkspaceId, {
      type: "goal-budget-limited",
      workspaceId: parentWorkspaceId,
      goalId: attribution.goalAfter.goalId,
      causedByChild: true,
      childWorkspaceId,
      message: "Child workspace exceeded the parent's goal budget.",
    });
  }

  private async shouldAllowLegacyInvalidWorkflowOutputSchema(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined
  ): Promise<boolean> {
    const workflowTask = childEntry?.workspace.workflowTask;
    if (workflowTask?.outputSchema === undefined) {
      return false;
    }
    if (validateJsonSchemaSubsetSchema(workflowTask.outputSchema).success) {
      return false;
    }
    const parentWorkspaceId = childEntry?.workspace.parentWorkspaceId;
    if (parentWorkspaceId == null) {
      return false;
    }

    try {
      const runStore = new WorkflowRunStore({
        sessionDir: this.config.getSessionDir(parentWorkspaceId),
      });
      const run = await runStore.getRun(workflowTask.runId);
      return run.agentOutputSchemaRequired !== true;
    } catch (error) {
      log.debug("Could not determine legacy workflow schema validation policy", {
        childWorkspaceId,
        workflowRunId: workflowTask.runId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  private async finalizeAgentTaskReport(
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    reportArgs: { reportMarkdown: string; title?: string; structuredOutput?: unknown }
  ): Promise<AgentReportFinalizationResult> {
    this.markTaskForegroundRelevant(childWorkspaceId);

    assert(
      childWorkspaceId.length > 0,
      "finalizeAgentTaskReport: childWorkspaceId must be non-empty"
    );
    assert(
      typeof reportArgs.reportMarkdown === "string" && reportArgs.reportMarkdown.length > 0,
      "finalizeAgentTaskReport: reportMarkdown must be non-empty"
    );

    const cfgBeforeReport = this.config.loadConfigOrDefault();
    const latestEntryBeforeReport =
      findWorkspaceEntry(cfgBeforeReport, childWorkspaceId) ?? childEntry;
    const statusBefore = latestEntryBeforeReport?.workspace.taskStatus;
    if (statusBefore === "reported") {
      return { finalized: true };
    }

    const allowLegacyInvalidOutputSchema = await this.shouldAllowLegacyInvalidWorkflowOutputSchema(
      childWorkspaceId,
      latestEntryBeforeReport
    );
    const validationMessage = validateWorkflowAgentReportStructuredOutput({
      workflowTask: latestEntryBeforeReport?.workspace.workflowTask,
      reportArgs,
      allowLegacyInvalidOutputSchema,
    });
    if (validationMessage != null) {
      log.warn("Rejecting invalid workflow agent_report structured output", {
        childWorkspaceId,
        workflowTask: latestEntryBeforeReport?.workspace.workflowTask,
        message: validationMessage,
      });
      if (statusBefore === "interrupted") {
        return {
          finalized: false,
          reason: "terminal_interrupted",
          message: validationMessage,
        };
      }

      await this.editWorkspaceEntry(
        childWorkspaceId,
        (ws) => {
          ws.taskStatus = "awaiting_report";
          ws.reportedAt = undefined;
        },
        { allowMissing: true }
      );
      await this.emitWorkspaceMetadata(childWorkspaceId);
      await this.promptTaskForRequiredCompletionTool(childWorkspaceId, {
        reason: "error",
        error: { error: validationMessage, errorType: "unknown" },
      });
      return {
        finalized: false,
        reason: "invalid_structured_output",
        message: validationMessage,
      };
    }

    // Notify clients immediately even if we can't delete the workspace yet.
    await this.editWorkspaceEntry(
      childWorkspaceId,
      (ws) => {
        ws.taskStatus = "reported";
        ws.reportedAt = getIsoNow();
        // Successful completion resets the persisted recovery circuit breaker.
        delete ws.taskRecoveryAttempts;
      },
      { allowMissing: true }
    );

    await this.emitWorkspaceMetadata(childWorkspaceId);

    // NOTE: Stream continues — we intentionally do NOT abort it.
    // Deterministic termination is enforced by StreamManager stopWhen logic that
    // waits for an agent_report tool result where output.success === true at the
    // step boundary (preserving usage accounting). recordSessionUsage runs when
    // the stream ends naturally.

    const cfgAfterReport = this.config.loadConfigOrDefault();
    const latestChildEntry = findWorkspaceEntry(cfgAfterReport, childWorkspaceId) ?? childEntry;
    const parentWorkspaceId = latestChildEntry?.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      const reason = latestChildEntry
        ? "missing parentWorkspaceId"
        : "workspace not found in config";
      log.debug("Ignoring agent_report: workspace is not an agent task", {
        childWorkspaceId,
        reason,
      });
      // Best-effort: resolve any foreground waiters even if we can't deliver to a parent.
      this.resolveWaiters(childWorkspaceId, reportArgs);
      void this.maybeStartQueuedTasks();
      return { finalized: true };
    }

    const isWorkflowOwnedChildReport = latestChildEntry?.workspace.workflowTask != null;

    const indexAfterReport = this.buildAgentTaskIndex(cfgAfterReport);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      indexAfterReport.parentById,
      childWorkspaceId
    );
    const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
      (ancestorWorkspaceId) =>
        this.getWorkflowOwnedDescendantAgentTaskUsingIndex(
          indexAfterReport,
          ancestorWorkspaceId,
          childWorkspaceId
        ) === true
    );

    // Persist the completed report in the session dirs of all ancestors so `task_await` can
    // retrieve it after cleanup/restart (even if the task workspace itself is deleted).
    const persistedAtMs = Date.now();
    for (const ancestorWorkspaceId of ancestorWorkspaceIds) {
      try {
        const ancestorSessionDir = this.config.getSessionDir(ancestorWorkspaceId);
        await upsertSubagentReportArtifact({
          workspaceId: ancestorWorkspaceId,
          workspaceSessionDir: ancestorSessionDir,
          childTaskId: childWorkspaceId,
          parentWorkspaceId,
          ancestorWorkspaceIds,
          workflowOwnedAncestorWorkspaceIds,
          reportMarkdown: reportArgs.reportMarkdown,
          model: latestChildEntry?.workspace.taskModelString,
          thinkingLevel: latestChildEntry?.workspace.taskThinkingLevel,
          title: reportArgs.title,
          structuredOutput: reportArgs.structuredOutput,
          nowMs: persistedAtMs,
        });
      } catch (error: unknown) {
        log.error("Failed to persist subagent report artifact", {
          workspaceId: ancestorWorkspaceId,
          childTaskId: childWorkspaceId,
          error,
        });
      }
    }

    // Goal attribution is informational; if it throws (permissions failure,
    // disk-full, corrupted extensionMetadata.json in pushSnapshot), execution
    // would otherwise exit before reaching deliverReportToParent / waiter
    // resolution / queue drain — leaving the parent's task_await waiting
    // indefinitely (Coder-agents-review P1 DEREM-14). Match the
    // upsertSubagentReportArtifact pattern above: log and continue.
    try {
      await this.attributeChildReportToParentGoal(parentWorkspaceId, childWorkspaceId);
    } catch (error: unknown) {
      log.error("Failed to attribute child report to parent goal", {
        parentWorkspaceId,
        childWorkspaceId,
        error,
      });
    }

    await this.maybeStartPatchGenerationForReportedTask(childWorkspaceId);

    await this.deliverReportToParent(
      parentWorkspaceId,
      childWorkspaceId,
      latestChildEntry,
      reportArgs
    );

    // Resolve foreground waiters.
    const hadForegroundWaiters = this.resolveWaiters(childWorkspaceId, reportArgs);

    // Free slot and start queued tasks.
    await this.maybeStartQueuedTasks();

    // Auto-resume any parent stream that was waiting on a task tool call (restart-safe).
    const postCfg = this.config.loadConfigOrDefault();
    const parentEntry = findWorkspaceEntry(postCfg, parentWorkspaceId);
    if (!parentEntry) {
      // Parent may have been cleaned up (e.g. it already reported and this was its last descendant).
      return { finalized: true };
    }
    const hasActiveDescendants = this.hasActiveDescendantAgentTasks(postCfg, parentWorkspaceId);
    if (!hasActiveDescendants) {
      this.consecutiveAutoResumes.delete(parentWorkspaceId);
    }

    if (this.interruptedParentWorkspaceIds.has(parentWorkspaceId)) {
      log.debug("Skipping post-report parent auto-resume after hard interrupt", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return { finalized: true };
    }

    if (hadForegroundWaiters) {
      log.debug("Skipping post-report parent auto-resume: report delivered to foreground waiter", {
        parentWorkspaceId,
        childWorkspaceId,
      });
    }

    if (isWorkflowOwnedChildReport) {
      // Workflow-owned tasks report through WorkflowRunner's journal/final-result path. Do not
      // also nudge the parent model with a generic background-subagent handoff.
      log.debug("Skipping post-report parent auto-resume for workflow-owned child", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return { finalized: true };
    }

    if (
      !hadForegroundWaiters &&
      !hasActiveDescendants &&
      !this.aiService.isStreaming(parentWorkspaceId)
    ) {
      const resumeOptions = await this.resolveParentAutoResumeOptions(
        parentWorkspaceId,
        parentEntry,
        latestChildEntry?.workspace.taskModelString ?? defaultModel
      );
      const sendResult = await this.workspaceService.sendMessage(
        parentWorkspaceId,
        COMPLETED_BACKGROUND_SUBAGENT_HANDOFF_PROMPT,
        {
          model: resumeOptions.model,
          agentId: resumeOptions.agentId,
          thinkingLevel: resumeOptions.thinkingLevel,
        },
        // Skip auto-resume counter reset — this IS an auto-resume, not a user message.
        { skipAutoResumeReset: true, synthetic: true, agentInitiated: true }
      );
      if (!sendResult.success) {
        log.error("Failed to auto-resume parent after agent_report", {
          parentWorkspaceId,
          error: sendResult.error,
        });
      }
    }

    return { finalized: true };
  }

  private enforceCompletedReportCacheLimit(): void {
    while (this.completedReportsByTaskId.size > COMPLETED_REPORT_CACHE_MAX_ENTRIES) {
      const first = this.completedReportsByTaskId.keys().next();
      if (first.done) break;
      this.completedReportsByTaskId.delete(first.value);
    }
  }

  private resolveWaiters(
    taskId: string,
    report: { reportMarkdown: string; title?: string; structuredOutput?: unknown }
  ): boolean {
    this.markTaskForegroundRelevant(taskId);

    const cfg = this.config.loadConfigOrDefault();
    const index = this.buildAgentTaskIndex(cfg);
    const ancestorWorkspaceIds = this.listAncestorWorkspaceIdsUsingParentById(
      index.parentById,
      taskId
    );
    const workflowOwnedAncestorWorkspaceIds = ancestorWorkspaceIds.filter(
      (ancestorWorkspaceId) =>
        this.getWorkflowOwnedDescendantAgentTaskUsingIndex(index, ancestorWorkspaceId, taskId) ===
        true
    );

    this.completedReportsByTaskId.set(taskId, {
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      structuredOutput: report.structuredOutput,
      ancestorWorkspaceIds,
      workflowOwnedAncestorWorkspaceIds,
    });
    this.enforceCompletedReportCacheLimit();

    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return false;
    }

    this.pendingWaitersByTaskId.delete(taskId);
    for (const waiter of waiters) {
      try {
        waiter.cleanup();
        waiter.resolve(report);
      } catch {
        // ignore
      }
    }

    return true;
  }

  private rejectWaiters(taskId: string, error: Error): void {
    this.markTaskForegroundRelevant(taskId);

    const waiters = this.pendingWaitersByTaskId.get(taskId);
    if (!waiters || waiters.length === 0) {
      return;
    }

    for (const waiter of [...waiters]) {
      try {
        waiter.reject(error);
      } catch (rejectError: unknown) {
        log.error("Task waiter reject callback failed", { taskId, error: rejectError });
      }
    }
  }

  private findProposePlanSuccessInParts(parts: readonly unknown[]): { planPath: string } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "propose_plan") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;

      const planPath =
        typeof part.output === "object" &&
        part.output !== null &&
        "planPath" in part.output &&
        typeof (part.output as { planPath?: unknown }).planPath === "string"
          ? (part.output as { planPath: string }).planPath.trim()
          : "";
      if (!planPath) continue;

      return { planPath };
    }
    return null;
  }

  private findImplicitAgentReportArgsInParts(
    parts: readonly unknown[]
  ): { reportMarkdown: string } | null {
    let reportMarkdown = "";
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const maybeText = part as { type?: unknown; text?: unknown };
      if (maybeText.type !== "text" || typeof maybeText.text !== "string") continue;
      reportMarkdown += maybeText.text;
    }

    const trimmedReport = reportMarkdown.trim();
    if (trimmedReport.length === 0) {
      return null;
    }

    return { reportMarkdown: trimmedReport };
  }

  private findAgentReportArgsInParts(
    parts: readonly unknown[]
  ): { reportMarkdown: string; title?: string; structuredOutput?: unknown } | null {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      if (!isDynamicToolPart(part)) continue;
      if (part.toolName !== "agent_report") continue;
      if (part.state !== "output-available") continue;
      if (!isSuccessfulToolResult(part.output)) continue;
      const outputReport = AgentReportSubmittedReportSchema.safeParse(
        typeof part.output === "object" && part.output !== null && "report" in part.output
          ? (part.output as { report?: unknown }).report
          : undefined
      );
      if (outputReport.success) {
        return outputReport.data;
      }

      const parsedWorkflowArgs = AgentReportWorkflowInlineToolArgsSchema.safeParse(part.input);
      if (parsedWorkflowArgs.success) {
        return {
          reportMarkdown: parsedWorkflowArgs.data.reportMarkdown,
          title: parsedWorkflowArgs.data.title ?? undefined,
          structuredOutput: parsedWorkflowArgs.data.structuredOutput,
        };
      }

      const parsedInlineArgs = AgentReportInlineToolArgsSchema.safeParse(part.input);
      if (!parsedInlineArgs.success) continue;
      // Normalize null → undefined at the schema boundary so downstream
      // code that expects `title?: string` doesn't need to handle null.
      return {
        reportMarkdown: parsedInlineArgs.data.reportMarkdown,
        title: parsedInlineArgs.data.title ?? undefined,
      };
    }
    return null;
  }

  private listBestOfSiblingTasks(params: { parentWorkspaceId: string; groupId: string }): Array<{
    taskId: string;
    index: number;
    agentId?: string;
    agentType?: string;
    kind: TaskGroupKind;
    label?: string;
    taskStatus?: WorkspaceConfigEntry["taskStatus"];
  }> {
    const cfg = this.config.loadConfigOrDefault();
    const siblings: Array<{
      taskId: string;
      index: number;
      agentId?: string;
      agentType?: string;
      kind: TaskGroupKind;
      label?: string;
      taskStatus?: WorkspaceConfigEntry["taskStatus"];
    }> = [];

    for (const project of cfg.projects.values()) {
      for (const workspace of project.workspaces) {
        const taskId = coerceNonEmptyString(workspace.id);
        if (!taskId) {
          continue;
        }
        if (workspace.parentWorkspaceId !== params.parentWorkspaceId) {
          continue;
        }
        if (workspace.bestOf?.groupId !== params.groupId) {
          continue;
        }
        if (!Number.isInteger(workspace.bestOf.index)) {
          continue;
        }

        siblings.push({
          taskId,
          index: workspace.bestOf.index,
          agentId: coerceNonEmptyString(workspace.agentId),
          agentType: coerceNonEmptyString(workspace.agentType),
          kind: normalizeTaskGroupKind(workspace.bestOf.kind),
          ...(normalizeTaskGroupLabel(workspace.bestOf.label)
            ? { label: normalizeTaskGroupLabel(workspace.bestOf.label) }
            : {}),
          taskStatus: workspace.taskStatus,
        });
      }
    }

    siblings.sort(
      (left, right) => left.index - right.index || left.taskId.localeCompare(right.taskId)
    );
    return siblings;
  }

  private async buildBestOfCompletedTaskToolOutput(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
  }): Promise<z.infer<typeof TaskToolResultSchema> | null> {
    const siblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    if (siblings.length === 0) {
      return null;
    }
    if (siblings.length > params.total) {
      log.error("buildBestOfCompletedTaskToolOutput: found more siblings than requested", {
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        siblingCount: siblings.length,
        requestedTotal: params.total,
      });
      return null;
    }

    // Best-of creation can fail or be interrupted after only some candidates are spawned.
    // When recovering an interrupted parent stream, finalize against the siblings that
    // actually exist so the parent task tool call does not stay pending forever.
    const parentSessionDir = this.config.getSessionDir(params.parentWorkspaceId);
    const reports: Array<{
      taskId: string;
      reportMarkdown: string;
      structuredOutput?: unknown;
      title?: string;
      agentId?: string;
      agentType?: string;
      groupKind?: TaskGroupKind;
      label?: string;
    }> = [];

    for (const sibling of siblings) {
      const artifact = await readSubagentReportArtifact(parentSessionDir, sibling.taskId);
      if (!artifact) {
        return null;
      }

      reports.push({
        taskId: sibling.taskId,
        reportMarkdown: artifact.reportMarkdown,
        title: artifact.title,
        structuredOutput: artifact.structuredOutput,
        agentId: sibling.agentId,
        agentType: sibling.agentType,
        groupKind: sibling.kind,
        label: sibling.label,
      });
    }

    const output = {
      status: "completed" as const,
      taskIds: siblings.map((sibling) => sibling.taskId),
      reports,
    };
    const parsed = TaskToolResultSchema.safeParse(output);
    if (!parsed.success) {
      log.error("buildBestOfCompletedTaskToolOutput: invalid grouped task output", {
        error: parsed.error.message,
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
      });
      return null;
    }

    return parsed.data;
  }

  private async getTaskToolPartialState(workspaceId: string): Promise<{
    pendingBestOfTaskToolCount: number;
    pendingTaskToolCount: number;
    referencedTaskIds: Set<string>;
  }> {
    const partial = await this.historyService.readPartial(workspaceId);
    const referencedTaskIds = new Set<string>();
    if (!partial) {
      return {
        pendingBestOfTaskToolCount: 0,
        pendingTaskToolCount: 0,
        referencedTaskIds,
      };
    }

    let pendingBestOfTaskToolCount = 0;
    let pendingTaskToolCount = 0;
    for (const part of partial.parts) {
      if (!isDynamicToolPart(part) || part.toolName !== "task") {
        continue;
      }

      if (part.state === "input-available") {
        pendingTaskToolCount += 1;
        const parsedInput = TaskToolArgsSchema.safeParse(part.input);
        if (parsedInput.success && getTaskGroupCount(parsedInput.data) > 1) {
          pendingBestOfTaskToolCount += 1;
        }
        continue;
      }
      if (part.state !== "output-available") {
        continue;
      }

      const parsedOutput = TaskToolResultSchema.safeParse(part.output);
      if (!parsedOutput.success) {
        continue;
      }

      const output = parsedOutput.data;
      if (typeof output.taskId === "string") {
        referencedTaskIds.add(output.taskId);
      }
      if (Array.isArray(output.taskIds)) {
        for (const taskId of output.taskIds) {
          referencedTaskIds.add(taskId);
        }
      }
      if ("tasks" in output && Array.isArray(output.tasks)) {
        for (const task of output.tasks) {
          referencedTaskIds.add(task.taskId);
        }
      }
      if ("reports" in output && Array.isArray(output.reports)) {
        for (const report of output.reports) {
          referencedTaskIds.add(report.taskId);
        }
      }
    }

    return {
      pendingBestOfTaskToolCount,
      pendingTaskToolCount,
      referencedTaskIds,
    };
  }

  private async shouldDeferBestOfFallback(params: {
    parentWorkspaceId: string;
    groupId: string;
    total: number;
  }): Promise<boolean> {
    const parentTaskToolState = await this.getTaskToolPartialState(params.parentWorkspaceId);
    if (
      parentTaskToolState.pendingBestOfTaskToolCount !== 1 ||
      parentTaskToolState.pendingTaskToolCount !== 1
    ) {
      return false;
    }

    const siblings = this.listBestOfSiblingTasks({
      parentWorkspaceId: params.parentWorkspaceId,
      groupId: params.groupId,
    });
    const hasRecoverableSibling = siblings.some((sibling) => {
      return (
        sibling.taskStatus === "queued" ||
        sibling.taskStatus === "starting" ||
        sibling.taskStatus === "running" ||
        sibling.taskStatus === "awaiting_report"
      );
    });
    if (hasRecoverableSibling) {
      return true;
    }

    return (
      (await this.buildBestOfCompletedTaskToolOutput({
        parentWorkspaceId: params.parentWorkspaceId,
        groupId: params.groupId,
        total: params.total,
      })) != null
    );
  }

  private async deliverReportToParent(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: { reportMarkdown: string; title?: string; structuredOutput?: unknown }
  ): Promise<void> {
    assert(
      childWorkspaceId.length > 0,
      "deliverReportToParent: childWorkspaceId must be non-empty"
    );

    let cleanupTaskIds: readonly string[] = [];
    const bestOfTotal = childEntry?.workspace.bestOf?.total ?? 1;
    if (bestOfTotal > 1) {
      await this.deferredBestOfLocks.withLock(parentWorkspaceId, async () => {
        cleanupTaskIds = await this.deliverReportToParentUnlocked(
          parentWorkspaceId,
          childWorkspaceId,
          childEntry,
          report
        );
      });
    } else {
      cleanupTaskIds = await this.deliverReportToParentUnlocked(
        parentWorkspaceId,
        childWorkspaceId,
        childEntry,
        report
      );
    }

    for (const taskId of cleanupTaskIds) {
      await this.requestReportedTaskCleanupRecheck(taskId);
    }
  }

  private async deliverReportToParentUnlocked(
    parentWorkspaceId: string,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined,
    report: { reportMarkdown: string; title?: string; structuredOutput?: unknown }
  ): Promise<readonly string[]> {
    const agentType = coerceNonEmptyString(childEntry?.workspace.agentType) ?? "agent";

    const output = {
      status: "completed" as const,
      taskId: childWorkspaceId,
      reportMarkdown: report.reportMarkdown,
      title: report.title,
      structuredOutput: report.structuredOutput,
      agentType,
    };
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success) {
      log.error("Task tool output schema validation failed", { error: parsedOutput.error.message });
      return [];
    }

    // If someone is actively awaiting this report (foreground task tool call or task_await),
    // skip injecting a synthetic history message to avoid duplicating the report in context.
    if (childWorkspaceId) {
      const waiters = this.pendingWaitersByTaskId.get(childWorkspaceId);
      if (waiters && waiters.length > 0) {
        return [];
      }
    }

    if (childEntry?.workspace.workflowTask != null) {
      log.debug("Skipping generic parent report delivery for workflow-owned child", {
        parentWorkspaceId,
        childWorkspaceId,
      });
      return [];
    }

    // Restart-safe: if the parent has a pending task tool call in partial.json (interrupted stream),
    // finalize it with the report. Avoid rewriting persisted history to keep earlier messages immutable.
    if (!this.aiService.isStreaming(parentWorkspaceId)) {
      const finalization = await this.tryFinalizePendingTaskToolCallInPartial(
        parentWorkspaceId,
        parsedOutput.data,
        childWorkspaceId,
        childEntry
      );
      if (finalization.kind === "finalized") {
        return finalization.taskIds.filter((taskId) => taskId !== childWorkspaceId);
      }

      if (childEntry?.workspace.bestOf?.total != null && childEntry.workspace.bestOf.total > 1) {
        const parentTaskToolState = await this.getTaskToolPartialState(parentWorkspaceId);

        // Concurrent sibling completions can arrive after another sibling already finalized
        // the grouped task output in the interrupted parent partial. Avoid appending an
        // extra synthetic fallback report once that grouped result already contains this child.
        if (parentTaskToolState.referencedTaskIds.has(childWorkspaceId)) {
          return [];
        }

        if (
          finalization.kind === "not_ready" &&
          (await this.shouldDeferBestOfFallback({
            parentWorkspaceId,
            groupId: childEntry.workspace.bestOf.groupId,
            total: childEntry.workspace.bestOf.total,
          }))
        ) {
          return [];
        }
      }
    }

    // Background tasks: append a synthetic user message containing the report so earlier history
    // remains immutable (append-only) and prompt caches can still reuse the prefix.
    const titlePrefix =
      typeof report.title === "string" && report.title.trim().length > 0
        ? report.title
        : `Subagent (${agentType}) report`;
    const reportContent = formatSubagentReportUserMessage({
      childWorkspaceId,
      agentType,
      title: titlePrefix,
      reportMarkdown: report.reportMarkdown,
      ...(report.structuredOutput !== undefined
        ? { structuredOutput: report.structuredOutput }
        : {}),
    });

    const messageId = createTaskReportMessageId();
    const reportMessage = createMuxMessage(messageId, "user", reportContent, {
      timestamp: Date.now(),
      synthetic: true,
    });

    const appendResult = await this.historyService.appendToHistory(
      parentWorkspaceId,
      reportMessage
    );
    if (!appendResult.success) {
      log.error("Failed to append synthetic subagent report to parent history", {
        parentWorkspaceId,
        error: appendResult.error,
      });
    }

    return [];
  }

  private async tryFinalizePendingTaskToolCallInPartial(
    workspaceId: string,
    output: unknown,
    childWorkspaceId: string,
    childEntry: { projectPath: string; workspace: WorkspaceConfigEntry } | null | undefined
  ): Promise<
    { kind: "finalized"; taskIds: readonly string[] } | { kind: "not_ready" } | { kind: "failed" }
  > {
    const parsedOutput = TaskToolResultSchema.safeParse(output);
    if (!parsedOutput.success || parsedOutput.data.status !== "completed") {
      log.error("tryFinalizePendingTaskToolCallInPartial: invalid output", {
        error: parsedOutput.success ? "status is not 'completed'" : parsedOutput.error.message,
      });
      return { kind: "failed" };
    }

    const partial = await this.historyService.readPartial(workspaceId);
    if (!partial) {
      return { kind: "failed" };
    }

    type PendingTaskToolPart = DynamicToolPart & { toolName: "task"; state: "input-available" };
    const pendingParts = partial.parts.filter(
      (p): p is PendingTaskToolPart =>
        isDynamicToolPart(p) && p.toolName === "task" && p.state === "input-available"
    );

    if (pendingParts.length === 0) {
      return { kind: "failed" };
    }
    if (pendingParts.length > 1) {
      log.error("tryFinalizePendingTaskToolCallInPartial: multiple pending task tool calls", {
        workspaceId,
      });
      return { kind: "failed" };
    }

    const toolCallId = pendingParts[0].toolCallId;

    const parsedInput = TaskToolArgsSchema.safeParse(pendingParts[0].input);
    if (!parsedInput.success) {
      log.error("tryFinalizePendingTaskToolCallInPartial: task input validation failed", {
        workspaceId,
        error: parsedInput.error.message,
      });
      return { kind: "failed" };
    }

    let finalizedOutput: z.infer<typeof TaskToolResultSchema> = parsedOutput.data;
    if (getTaskGroupCount(parsedInput.data) > 1) {
      const hasGroupedCompletedOutput =
        Array.isArray(parsedOutput.data.taskIds) &&
        "reports" in parsedOutput.data &&
        Array.isArray(parsedOutput.data.reports);
      if (hasGroupedCompletedOutput) {
        finalizedOutput = parsedOutput.data;
      } else {
        const bestOf = childEntry?.workspace.bestOf;
        if (!bestOf) {
          return { kind: "failed" };
        }

        const groupedOutput = await this.buildBestOfCompletedTaskToolOutput({
          parentWorkspaceId: workspaceId,
          groupId: bestOf.groupId,
          total: bestOf.total,
        });
        if (!groupedOutput) {
          return { kind: "not_ready" };
        }

        finalizedOutput = groupedOutput;
      }
    }

    const updated: MuxMessage = {
      ...partial,
      parts: partial.parts.map((part) => {
        if (!isDynamicToolPart(part)) return part;
        if (part.toolCallId !== toolCallId) return part;
        if (part.toolName !== "task") return part;
        if (part.state === "output-available") return part;
        return { ...part, state: "output-available" as const, output: finalizedOutput };
      }),
    };

    const writeResult = await this.historyService.writePartial(workspaceId, updated);
    if (!writeResult.success) {
      log.error("Failed to write finalized task tool output to partial", {
        workspaceId,
        error: writeResult.error,
      });
      return { kind: "failed" };
    }

    this.workspaceService.emit("chat", {
      workspaceId,
      message: {
        type: "tool-call-end",
        workspaceId,
        messageId: updated.id,
        toolCallId,
        toolName: "task",
        result: finalizedOutput,
        timestamp: Date.now(),
      },
    });

    if (Array.isArray(finalizedOutput.taskIds) && finalizedOutput.taskIds.length > 0) {
      return { kind: "finalized", taskIds: finalizedOutput.taskIds };
    }

    return {
      kind: "finalized",
      taskIds: finalizedOutput.taskId ? [finalizedOutput.taskId] : [childWorkspaceId],
    };
  }

  private async canCleanupReportedTask(
    workspaceId: string
  ): Promise<{ ok: true; parentWorkspaceId: string } | { ok: false; reason: string }> {
    assert(workspaceId.length > 0, "canCleanupReportedTask: workspaceId must be non-empty");

    const config = this.config.loadConfigOrDefault();
    const entry = findWorkspaceEntry(config, workspaceId);
    if (!entry) {
      return { ok: false, reason: "workspace_not_found" };
    }

    const parentWorkspaceId = entry.workspace.parentWorkspaceId;
    if (!parentWorkspaceId) {
      return { ok: false, reason: "missing_parent_workspace" };
    }

    if (!hasCompletedAgentReport(entry.workspace)) {
      return { ok: false, reason: "task_not_reported" };
    }

    if (entry.workspace.bestOf?.total != null && entry.workspace.bestOf.total > 1) {
      if (
        await this.shouldDeferBestOfFallback({
          parentWorkspaceId,
          groupId: entry.workspace.bestOf.groupId,
          total: entry.workspace.bestOf.total,
        })
      ) {
        return { ok: false, reason: "best_of_parent_partial_pending" };
      }
    }

    if (this.aiService.isStreaming(workspaceId)) {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; stream still active", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "still_streaming" };
    }

    // Topology gate: a completed task can only be cleaned up when it is a structural leaf
    // (has no child agent tasks in config). This stays status-agnostic so ancestor deletion
    // never orphans descendants that have not been pruned yet.
    const index = this.buildAgentTaskIndex(config);
    const isWorkflowOwnedTask = this.isWorkflowOwnedTaskUsingIndex(index, workspaceId);
    if (this.hasChildAgentTasks(index, workspaceId)) {
      return { ok: false, reason: "has_child_tasks" };
    }

    const parentSessionDir = this.config.getSessionDir(parentWorkspaceId);
    const patchArtifact = await readSubagentGitPatchArtifact(parentSessionDir, workspaceId);
    if (patchArtifact?.status === "pending") {
      log.debug("cleanupReportedLeafTask: deferring auto-delete; patch artifact pending", {
        workspaceId,
        parentWorkspaceId,
      });
      return { ok: false, reason: "patch_pending" };
    }

    // Workflow task results are persisted in the workflow run/report artifacts before cleanup,
    // so the user-level "preserve subagents until archive" setting should not keep those
    // transient worktrees around indefinitely.
    const taskSettings = normalizeTaskSettings(config.taskSettings);
    if (
      !isWorkflowOwnedTask &&
      taskSettings.preserveSubagentsUntilArchive &&
      !this.hasArchivedAncestor(index, config, workspaceId)
    ) {
      return { ok: false, reason: "preserved_until_archive" };
    }

    return { ok: true, parentWorkspaceId };
  }

  private async cleanupReportedLeafTask(workspaceId: string): Promise<void> {
    assert(workspaceId.length > 0, "cleanupReportedLeafTask: workspaceId must be non-empty");

    // Lineage reduction: each iteration removes exactly one completed leaf, then re-evaluates
    // the parent on fresh config. The structural-leaf gate in canCleanupReportedTask ensures
    // ancestors are only deleted after every child has been pruned.
    let currentWorkspaceId = workspaceId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 32; depth++) {
      if (visited.has(currentWorkspaceId)) {
        log.error("cleanupReportedLeafTask: possible parentWorkspaceId cycle", {
          workspaceId: currentWorkspaceId,
        });
        return;
      }
      visited.add(currentWorkspaceId);

      const cleanupEligibility = await this.canCleanupReportedTask(currentWorkspaceId);
      if (!cleanupEligibility.ok) {
        return;
      }

      const removeResult = await this.workspaceService.remove(currentWorkspaceId, true);
      if (!removeResult.success) {
        log.error("Failed to auto-delete completed task workspace", {
          workspaceId: currentWorkspaceId,
          error: removeResult.error,
        });
        return;
      }

      currentWorkspaceId = cleanupEligibility.parentWorkspaceId;
    }

    log.error("cleanupReportedLeafTask: exceeded max parent traversal depth", {
      workspaceId,
    });
  }
}
