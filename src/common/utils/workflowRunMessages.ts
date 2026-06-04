import type { MuxMessage } from "@/common/types/message";
import type { WorkflowRunRecord } from "@/common/types/workflow";
import assert from "@/common/utils/assert";

export const WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE = "workflow-trigger-display";
export const WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE = "workflow-run-card-display";
export const WORKFLOW_RESULT_METADATA_TYPE = "workflow-result";

export const WORKFLOW_RESULT_XML_TAG = "mux_workflow_result";

function getWorkflowResultValue(result: unknown, run: WorkflowRunRecord | null): unknown {
  if (result != null) {
    return result;
  }
  return run?.events.findLast((event) => event.type === "result")?.result ?? result;
}

function getWorkflowError(input: {
  run: WorkflowRunRecord | null;
  status: string;
  resultValue: unknown;
}): string | undefined {
  if (input.status !== "failed" && input.resultValue != null) {
    return undefined;
  }
  return input.run?.events.findLast((event) => event.type === "error")?.message;
}

function getWorkflowResultField(value: unknown, field: string): unknown {
  if (value != null && typeof value === "object") {
    return (value as Record<string, unknown>)[field];
  }
  return undefined;
}

function stringifyWorkflowResultPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return JSON.stringify({ error: "Workflow result could not be serialized." }, null, 2);
  }
}

export function buildWorkflowResultContextMessage(input: {
  rawCommand: string;
  name: string;
  runId: string;
  status: string;
  result: unknown;
  run: WorkflowRunRecord | null;
}): string {
  assert(
    input.rawCommand.trim().length > 0,
    "buildWorkflowResultContextMessage: rawCommand required"
  );
  assert(input.name.length > 0, "buildWorkflowResultContextMessage: workflow name required");
  assert(input.runId.length > 0, "buildWorkflowResultContextMessage: runId required");

  const resultValue = getWorkflowResultValue(input.result, input.run);
  const reportMarkdown = getWorkflowResultField(resultValue, "reportMarkdown");
  const structuredOutput = getWorkflowResultField(resultValue, "structuredOutput");
  const workflowError = getWorkflowError({
    run: input.run,
    status: input.status,
    resultValue,
  });
  const payload = {
    workflow: {
      name: input.name,
      runId: input.runId,
      status: input.status,
    },
    ...(typeof reportMarkdown === "string" ? { reportMarkdown } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(resultValue != null ? { result: resultValue } : {}),
    ...(workflowError ? { error: workflowError } : {}),
  };

  return [
    "The workflow below has finished. Continue the agent turn for the original request using this workflow result. Do not merely restate the raw payload; synthesize the next answer or action from it.",
    `Original workflow command: ${input.rawCommand}`,
    `<${WORKFLOW_RESULT_XML_TAG}>\n${stringifyWorkflowResultPayload(payload)}\n</${WORKFLOW_RESULT_XML_TAG}>`,
  ].join("\n\n");
}

export interface WorkflowRunCardInput {
  name: string;
  args: unknown;
}

export interface WorkflowRunCardResult {
  runId: string;
  status: string;
  result: unknown;
  run?: WorkflowRunRecord;
}

type WorkflowRunToolPart = Extract<MuxMessage["parts"][number], { type: "dynamic-tool" }>;

export function isWorkflowTriggerDisplayMessage(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === WORKFLOW_TRIGGER_DISPLAY_METADATA_TYPE;
}

export function isWorkflowRunCardDisplayMessage(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === WORKFLOW_RUN_CARD_DISPLAY_METADATA_TYPE;
}

export function isWorkflowResultMessage(message: MuxMessage): boolean {
  return message.metadata?.muxMetadata?.type === WORKFLOW_RESULT_METADATA_TYPE;
}

export function isWorkflowDisplayOnlyMessage(message: MuxMessage): boolean {
  return isWorkflowTriggerDisplayMessage(message) || isWorkflowRunCardDisplayMessage(message);
}

export function filterWorkflowDisplayOnlyMessages(messages: MuxMessage[]): MuxMessage[] {
  if (!messages.some(isWorkflowDisplayOnlyMessage)) {
    return messages;
  }
  return messages.filter((message) => !isWorkflowDisplayOnlyMessage(message));
}

export function buildWorkflowRunToolPart(
  input: WorkflowRunCardInput,
  result: WorkflowRunCardResult,
  now = Date.now()
): WorkflowRunToolPart {
  assert(input.name.length > 0, "buildWorkflowRunToolPart: workflow name is required");
  assert(result.runId.length > 0, "buildWorkflowRunToolPart: runId is required");

  return {
    type: "dynamic-tool",
    toolCallId: `workflow-run-${result.runId}`,
    toolName: "workflow_run",
    state: "output-available",
    input: {
      name: input.name,
      args: input.args,
      run_in_background: true,
    },
    output: {
      status: result.status,
      runId: result.runId,
      result: result.result,
      ...(result.run != null ? { run: result.run } : {}),
    },
    timestamp: now,
  };
}

export function buildWorkflowRunCardMessage(
  input: WorkflowRunCardInput,
  result: WorkflowRunCardResult,
  now = Date.now()
): MuxMessage {
  const toolPart = buildWorkflowRunToolPart(input, result, now);
  return {
    id: toolPart.toolCallId,
    role: "assistant",
    parts: [toolPart],
    metadata: {
      historySequence: Number.MAX_SAFE_INTEGER,
      timestamp: now,
    },
  };
}
