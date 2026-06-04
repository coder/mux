import { describe, expect, test } from "bun:test";

import { buildWorkflowResultContextMessage } from "@/common/utils/workflowRunMessages";
import {
  buildWorkflowRunCardMessage,
  filterWorkflowDisplayOnlyMessages,
  getWorkflowRunCardProjection,
  hasWorkflowRunToolCallMessage,
} from "./workflowRunMessages";
import type { MuxMessage } from "@/common/types/message";
import type { WorkflowRunRecord } from "@/common/types/workflow";

describe("buildWorkflowRunCardMessage", () => {
  test("builds a stable workflow_run card message with the current durable run", () => {
    const run: WorkflowRunRecord = {
      id: "wfr_reload",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in",
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "reload" },
      status: "completed",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:01.000Z",
      events: [],
      steps: [],
    };

    const message = buildWorkflowRunCardMessage(
      { name: run.definition.name, args: run.args },
      { runId: run.id, status: run.status, result: { reportMarkdown: "done" }, run },
      123
    );

    expect(message.id).toBe("workflow-run-wfr_reload");
    expect(message.parts[0]).toMatchObject({
      type: "dynamic-tool",
      toolName: "workflow_run",
      input: { name: "deep-research", args: { topic: "reload" }, run_in_background: true },
      output: { status: "completed", runId: "wfr_reload", result: { reportMarkdown: "done" }, run },
    });
  });

  test("omits stale historical errors from completed retry result context", () => {
    const run: WorkflowRunRecord = {
      id: "wfr_retried",
      workspaceId: "workspace-1",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in",
        executable: true,
      },
      definitionSource: "export default function workflow() { return null; }",
      definitionHash: "sha256:test",
      args: { topic: "retry" },
      status: "completed",
      createdAt: "2026-05-29T00:00:00.000Z",
      updatedAt: "2026-05-29T00:00:04.000Z",
      events: [
        {
          sequence: 1,
          type: "error",
          at: "2026-05-29T00:00:00.000Z",
          message: "Execution interrupted",
        },
        {
          sequence: 2,
          type: "status",
          at: "2026-05-29T00:00:01.000Z",
          status: "failed",
        },
        {
          sequence: 3,
          type: "status",
          at: "2026-05-29T00:00:02.000Z",
          status: "running",
        },
        {
          sequence: 4,
          type: "result",
          at: "2026-05-29T00:00:03.000Z",
          result: { reportMarkdown: "retried successfully" },
        },
        {
          sequence: 5,
          type: "status",
          at: "2026-05-29T00:00:04.000Z",
          status: "completed",
        },
      ],
      steps: [],
    };

    const message = buildWorkflowResultContextMessage({
      rawCommand: "/deep-research retry",
      name: "deep-research",
      runId: run.id,
      status: run.status,
      result: null,
      run,
    });

    expect(message).toContain("retried successfully");
    expect(message).toContain('"status": "completed"');
    expect(message).not.toContain("Execution interrupted");
  });

  test("filters durable workflow UI-only rows while preserving workflow results", () => {
    const trigger: MuxMessage = {
      id: "workflow-command",
      role: "user",
      parts: [{ type: "text", text: "/deep-research mux" }],
      metadata: {
        historySequence: 1,
        muxMetadata: {
          type: "workflow-trigger-display",
          rawCommand: "/deep-research mux",
          runId: "wfr_1",
        },
      },
    };
    const card = buildWorkflowRunCardMessage(
      { name: "deep-research", args: { input: "mux" } },
      { runId: "wfr_1", status: "running", result: null },
      2
    );
    card.metadata = {
      historySequence: 2,
      muxMetadata: { type: "workflow-run-card-display", runId: "wfr_1" },
    };
    const result: MuxMessage = {
      id: "workflow-result",
      role: "user",
      parts: [{ type: "text", text: "/deep-research mux\n\n<mux_workflow_result />" }],
      metadata: {
        historySequence: 3,
        muxMetadata: { type: "workflow-result", rawCommand: "/deep-research mux", runId: "wfr_1" },
      },
    };

    expect(filterWorkflowDisplayOnlyMessages([trigger, card, result])).toEqual([result]);
  });

  test("detects existing persisted workflow_run tool calls by run id or in-flight input", () => {
    const run = {
      id: "wfr_existing",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      args: { topic: "reload" },
    };
    const completedMessage = buildWorkflowRunCardMessage(
      { name: run.definition.name, args: run.args },
      { runId: run.id, status: "completed", result: { reportMarkdown: "done" } },
      123
    );
    const inFlightMessage: MuxMessage = {
      id: "assistant_1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call_1",
          toolName: "workflow_run",
          state: "input-available",
          input: { name: "deep-research", args: { topic: "reload" } },
        },
      ],
    };

    expect(hasWorkflowRunToolCallMessage([completedMessage], run)).toBe(true);
    expect(hasWorkflowRunToolCallMessage([inFlightMessage], run)).toBe(true);
    expect(hasWorkflowRunToolCallMessage([completedMessage], { ...run, id: "wfr_missing" })).toBe(
      false
    );
  });

  test("does not project workflow runs that are no longer anchored in the transcript", () => {
    const run = {
      id: "wfr_discarded",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      args: { topic: "discarded" },
      status: "completed" as const,
    };

    expect(getWorkflowRunCardProjection([], run)).toEqual({
      shouldProject: false,
      existingMessage: null,
    });
  });

  test("uses workflow card metadata as a repairable transcript anchor", () => {
    const run = {
      id: "wfr_metadata_anchor",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      args: { topic: "metadata" },
      status: "completed" as const,
    };
    const malformedCard = buildWorkflowRunCardMessage(
      { name: run.definition.name, args: run.args },
      { runId: run.id, status: "running", result: null },
      123
    );
    malformedCard.metadata = {
      historySequence: 7,
      muxMetadata: { type: "workflow-run-card-display", runId: run.id },
    };
    const part = malformedCard.parts[0];
    if (part?.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected workflow card dynamic tool part");
    }
    part.output = { status: "running" };

    expect(getWorkflowRunCardProjection([malformedCard], run)).toEqual({
      shouldProject: true,
      existingMessage: malformedCard,
    });
  });

  test("uses workflow trigger rows as anchors to repair missing cards", () => {
    const run = {
      id: "wfr_trigger_anchor",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      args: { topic: "trigger" },
      status: "completed" as const,
    };
    const trigger: MuxMessage = {
      id: "workflow-run-command-wfr_trigger_anchor",
      role: "user",
      parts: [{ type: "text", text: "/deep-research trigger" }],
      metadata: {
        historySequence: 6,
        muxMetadata: {
          type: "workflow-trigger-display",
          rawCommand: "/deep-research trigger",
          runId: run.id,
        },
      },
    };

    expect(getWorkflowRunCardProjection([trigger], run)).toEqual({
      shouldProject: true,
      existingMessage: trigger,
    });
  });

  test("projects updated terminal workflow cards while preserving the existing card slot", () => {
    const run = {
      id: "wfr_refresh",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      args: { topic: "reload" },
      status: "completed" as const,
    };
    const staleMessage = buildWorkflowRunCardMessage(
      { name: run.definition.name, args: run.args },
      { runId: run.id, status: "running", result: null },
      123
    );
    staleMessage.metadata = {
      historySequence: 42,
      muxMetadata: { type: "workflow-run-card-display", runId: run.id },
    };

    const projection = getWorkflowRunCardProjection([staleMessage], run);

    expect(projection).toEqual({ shouldProject: true, existingMessage: staleMessage });
  });

  test("does not project cards already owned by assistant workflow tool calls", () => {
    const run = {
      id: "wfr_running",
      definition: {
        name: "deep-research",
        description: "Deep research",
        scope: "built-in" as const,
        executable: true,
      },
      args: { topic: "reload" },
      status: "running" as const,
    };
    const inFlightMessage: MuxMessage = {
      id: "assistant_1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call_1",
          toolName: "workflow_run",
          state: "input-available",
          input: { name: "deep-research", args: { topic: "reload" } },
        },
      ],
    };
    const completedAssistantMessage: MuxMessage = {
      id: "assistant_2",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolCallId: "call_2",
          toolName: "workflow_run",
          state: "output-available",
          input: { name: "deep-research", args: { topic: "reload" } },
          output: { runId: run.id, status: "completed", result: { reportMarkdown: "done" } },
        },
      ],
    };

    expect(getWorkflowRunCardProjection([inFlightMessage], run)).toEqual({
      shouldProject: false,
      existingMessage: null,
    });
    expect(
      getWorkflowRunCardProjection([completedAssistantMessage], { ...run, status: "completed" })
    ).toEqual({
      shouldProject: false,
      existingMessage: null,
    });
  });
});
