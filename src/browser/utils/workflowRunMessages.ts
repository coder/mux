import { addEphemeralMessage } from "@/browser/stores/WorkspaceStore";
import type { MuxMessage } from "@/common/types/message";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import assert from "@/common/utils/assert";
import {
  buildWorkflowRunCardMessage,
  filterWorkflowDisplayOnlyMessages,
  type WorkflowRunCardInput,
  type WorkflowRunCardResult,
} from "@/common/utils/workflowRunMessages";

export { buildWorkflowRunCardMessage, filterWorkflowDisplayOnlyMessages };
export type { WorkflowRunCardInput, WorkflowRunCardResult };

function getLatestWorkflowResult(run: WorkflowRunRecord): unknown {
  return run.events.findLast((event) => event.type === "result")?.result ?? null;
}

function getOutputRunId(output: unknown): string | null {
  if (output != null && typeof output === "object") {
    const runId = (output as Record<string, unknown>).runId;
    if (typeof runId === "string" && runId.length > 0) {
      return runId;
    }
  }
  return null;
}

function getWorkflowInput(input: unknown): WorkflowRunCardInput | null {
  if (input != null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    if (typeof record.name === "string" && record.name.length > 0) {
      return { name: record.name, args: record.args ?? {} };
    }
  }
  return null;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function getProjectedWorkflowRunCardMessageId(runId: string): string {
  assert(runId.length > 0, "getProjectedWorkflowRunCardMessageId: run id is required");
  return `workflow-run-${runId}`;
}

export function findProjectedWorkflowRunCardMessage(
  messages: readonly MuxMessage[],
  runId: string
): MuxMessage | null {
  assert(runId.length > 0, "findProjectedWorkflowRunCardMessage: run id is required");
  const messageId = getProjectedWorkflowRunCardMessageId(runId);
  return (
    messages.find(
      (message) =>
        message.id === messageId &&
        message.parts.some(
          (part) =>
            part.type === "dynamic-tool" &&
            part.toolName === "workflow_run" &&
            part.state === "output-available" &&
            getOutputRunId(part.output) === runId
        )
    ) ?? null
  );
}

export function hasWorkflowRunToolCallMessage(
  messages: readonly MuxMessage[],
  run: Pick<WorkflowRunRecord, "id" | "definition" | "args">
): boolean {
  assert(run.id.length > 0, "hasWorkflowRunToolCallMessage: run id is required");
  return messages.some((message) =>
    message.parts.some((part) => {
      if (part.type !== "dynamic-tool" || part.toolName !== "workflow_run") {
        return false;
      }
      if (part.state === "output-available") {
        return getOutputRunId(part.output) === run.id;
      }
      const input = getWorkflowInput(part.input);
      return input?.name === run.definition.name && jsonEqual(input.args, run.args);
    })
  );
}

export function getWorkflowRunCardProjection(
  messages: readonly MuxMessage[],
  run: Pick<WorkflowRunRecord, "id" | "definition" | "args" | "status">
): { shouldProject: boolean; existingMessage: MuxMessage | null } {
  assert(run.id.length > 0, "getWorkflowRunCardProjection: run id is required");
  const existingMessage = findProjectedWorkflowRunCardMessage(messages, run.id);
  if (existingMessage != null) {
    return { shouldProject: true, existingMessage };
  }

  // Normal assistant workflow_run tool calls render and refresh themselves. Only synthetic
  // projected cards should be replaced here; otherwise we would duplicate model-started cards.
  if (hasWorkflowRunToolCallMessage(messages, run)) {
    return { shouldProject: false, existingMessage: null };
  }

  return { shouldProject: true, existingMessage: null };
}

export function addWorkflowRunCardMessage(
  workspaceId: string,
  input: WorkflowRunCardInput,
  result: WorkflowRunCardResult,
  options?: { existingMessage?: MuxMessage | null }
): void {
  assert(workspaceId.length > 0, "addWorkflowRunCardMessage: workspaceId is required");
  const message = buildWorkflowRunCardMessage(input, result);
  if (options?.existingMessage?.metadata != null) {
    message.metadata = options.existingMessage.metadata;
  }
  addEphemeralMessage(workspaceId, message);
}

export function addWorkflowRunCardMessageForRun(
  workspaceId: string,
  run: WorkflowRunRecord,
  options?: { existingMessage?: MuxMessage | null }
): void {
  addWorkflowRunCardMessage(
    workspaceId,
    { name: run.definition.name, args: run.args },
    { runId: run.id, status: run.status, result: getLatestWorkflowResult(run), run },
    options
  );
}
