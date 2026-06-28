import { describe, expect, it } from "bun:test";
import type { ModelMessage } from "ai";
import { stripWorkflowRunRecordsFromModelMessages } from "./stripWorkflowRunRecordsFromModelMessages";

const INLINE_SOURCE = "export default function inlineSecretWorkflow() {}\n";

const runRecord = {
  id: "wfr_demo",
  source: INLINE_SOURCE,
  events: [{ sequence: 1, type: "log", at: "2026-01-01T00:00:00.000Z", message: "noisy" }],
};

describe("stripWorkflowRunRecordsFromModelMessages", () => {
  it("strips run records from same-turn workflow tool results", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "workflow_run",
            output: {
              type: "json",
              value: { status: "running", runId: "wfr_demo", result: null, run: runRecord },
            },
          },
        ],
      },
    ];

    const result = stripWorkflowRunRecordsFromModelMessages(messages);

    expect(result).not.toBe(messages);
    const part = result[0]?.role === "tool" ? result[0].content[0] : undefined;
    expect(part?.type === "tool-result" ? part.output : undefined).toEqual({
      type: "json",
      value: { status: "running", runId: "wfr_demo", result: null },
    });
  });

  it("does not redact original inline workflow tool-call inputs", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-inline",
            toolName: "workflow_run",
            input: { script_source: INLINE_SOURCE, args: {} },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-inline",
            toolName: "workflow_run",
            output: {
              type: "json",
              value: { status: "running", runId: "wfr_demo", result: null, run: runRecord },
            },
          },
        ],
      },
    ];

    const result = stripWorkflowRunRecordsFromModelMessages(messages);

    expect(JSON.stringify(result[0])).toContain("inlineSecretWorkflow");
    expect(JSON.stringify(result[1])).not.toContain("inlineSecretWorkflow");
  });

  it("returns the original array when no workflow tool results carry a run record", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            // Non-workflow tools may legitimately output a `run` key; it must survive.
            output: { type: "json", value: { success: true, run: "value preserved" } },
          },
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "workflow_run",
            output: { type: "json", value: { status: "completed", runId: "wfr_demo" } },
          },
        ],
      },
    ];

    expect(stripWorkflowRunRecordsFromModelMessages(messages)).toBe(messages);
  });
});
