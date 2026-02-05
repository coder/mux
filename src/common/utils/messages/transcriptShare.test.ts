import { describe, expect, it } from "bun:test";
import type { MuxMessage } from "@/common/types/message";
import { buildChatJsonlForSharing } from "./transcriptShare";

function splitJsonlLines(jsonl: string): string[] {
  return jsonl.split("\n").filter((line) => line.trim().length > 0);
}

describe("buildChatJsonlForSharing", () => {
  it("strips tool output and sets state back to input-available when includeToolOutput=false", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "bash",
            state: "output-available",
            input: { script: "echo hi" },
            output: { success: true, output: "hi" },
          },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { includeToolOutput: false });
    expect(jsonl.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];
    expect(part.type).toBe("dynamic-tool");

    if (part.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }

    expect(part.state).toBe("input-available");
    expect(part).not.toHaveProperty("output");

    // Original messages should be unchanged (no mutation during stripping)
    const originalPart = messages[0].parts[0];
    if (originalPart.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }
    expect(originalPart.state).toBe("output-available");
    expect(originalPart).toHaveProperty("output");
  });

  it("strips nestedCalls output and sets nestedCalls state back to input-available when includeToolOutput=false", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "code_execution",
            state: "input-available",
            input: { code: "console.log('hi')" },
            nestedCalls: [
              {
                toolCallId: "nested-1",
                toolName: "bash",
                input: { script: "echo nested" },
                output: { success: true, output: "nested" },
                state: "output-available",
              },
            ],
          },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { includeToolOutput: false });
    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];

    if (part.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }

    expect(part.state).toBe("input-available");
    expect(part.nestedCalls?.[0].state).toBe("input-available");
    expect(part.nestedCalls?.[0]).not.toHaveProperty("output");

    // Original nested call should still include output
    const originalPart = messages[0].parts[0];
    if (originalPart.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }
    expect(originalPart.nestedCalls?.[0].state).toBe("output-available");
    expect(originalPart.nestedCalls?.[0]).toHaveProperty("output");
  });

  it("leaves messages unchanged when includeToolOutput=true", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "bash",
            state: "output-available",
            input: { script: "echo hi" },
            output: { success: true, output: "hi" },
            nestedCalls: [
              {
                toolCallId: "nested-1",
                toolName: "file_read",
                input: { file_path: "/tmp/demo.txt" },
                output: { success: true, content: "hello" },
                state: "output-available",
              },
            ],
          },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { includeToolOutput: true });
    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;

    expect(parsed).toEqual(messages[0]);
  });

  it("inlines planContent into propose_plan tool output when planSnapshot matches", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "propose_plan",
            state: "output-available",
            input: { title: "My Plan" },
            output: { success: true, planPath: "/tmp/plan.md", message: "Plan saved" },
          },
        ],
      },
    ];

    const planSnapshot = { path: "/tmp/plan.md", content: "# My Plan\n\n- Step 1" };

    const jsonl = buildChatJsonlForSharing(messages, {
      includeToolOutput: true,
      planSnapshot,
    });

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];

    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected completed tool part");
    }

    const output = part.output;
    if (output === null || typeof output !== "object") {
      throw new Error("Expected tool output object");
    }

    expect((output as Record<string, unknown>).planContent).toBe(planSnapshot.content);

    // Original messages should be unchanged (no mutation during injection)
    const originalPart = messages[0].parts[0];
    if (originalPart.type !== "dynamic-tool" || originalPart.state !== "output-available") {
      throw new Error("Expected completed tool part");
    }

    const originalOutput = originalPart.output;
    if (originalOutput === null || typeof originalOutput !== "object") {
      throw new Error("Expected tool output object");
    }

    expect((originalOutput as Record<string, unknown>).planContent).toBeUndefined();
  });

  it("inlines planContent even when propose_plan planPath uses ~ but planSnapshot.path is resolved", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "propose_plan",
            state: "output-available",
            input: { title: "My Plan" },
            output: {
              success: true,
              planPath: "~/.mux/plans/p/w.md",
              message: "Plan saved",
            },
          },
        ],
      },
    ];

    const planSnapshot = {
      path: "/home/user/.mux/plans/p/w.md",
      content: "# My Plan\n\n- Step 1",
    };

    const jsonl = buildChatJsonlForSharing(messages, {
      includeToolOutput: true,
      planSnapshot,
    });

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];

    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected completed tool part");
    }

    const output = part.output;
    if (output === null || typeof output !== "object") {
      throw new Error("Expected tool output object");
    }

    expect((output as Record<string, unknown>).planContent).toBe(planSnapshot.content);
  });

  it("inlines planContent even when propose_plan planPath uses Windows-style slashes", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "propose_plan",
            state: "output-available",
            input: { title: "My Plan" },
            output: {
              success: true,
              planPath: "~\\.mux\\plans\\p\\w.md",
              message: "Plan saved",
            },
          },
        ],
      },
    ];

    const planSnapshot = {
      path: "C:\\Users\\user\\.mux\\plans\\p\\w.md",
      content: "# My Plan\n\n- Step 1",
    };

    const jsonl = buildChatJsonlForSharing(messages, {
      includeToolOutput: true,
      planSnapshot,
    });

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];

    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected completed tool part");
    }

    const output = part.output;
    if (output === null || typeof output !== "object") {
      throw new Error("Expected tool output object");
    }

    expect((output as Record<string, unknown>).planContent).toBe(planSnapshot.content);
  });

  it("inlines planContent even when planSnapshot.path differs from propose_plan planPath", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "propose_plan",
            state: "output-available",
            input: { title: "My Plan" },
            output: { success: true, planPath: "/tmp/plan.md", message: "Plan saved" },
          },
        ],
      },
    ];

    const planSnapshot = {
      path: "/completely/different/plan.md",
      content: "# My Plan\n\n- Step 1",
    };

    const jsonl = buildChatJsonlForSharing(messages, {
      includeToolOutput: true,
      planSnapshot,
    });

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];

    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected completed tool part");
    }

    const output = part.output;
    if (output === null || typeof output !== "object") {
      throw new Error("Expected tool output object");
    }

    expect((output as Record<string, unknown>).planContent).toBe(planSnapshot.content);
  });

  it("preserves propose_plan output (with planContent) while stripping other tool outputs when includeToolOutput=false", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-plan",
            toolName: "propose_plan",
            state: "output-available",
            input: { title: "My Plan" },
            output: { success: true, planPath: "/tmp/plan.md", message: "Plan saved" },
          },
          {
            type: "dynamic-tool",
            toolCallId: "tc-bash",
            toolName: "bash",
            state: "output-available",
            input: { script: "echo hi" },
            output: { success: true, output: "hi" },
          },
        ],
      },
    ];

    const planSnapshot = { path: "/tmp/plan.md", content: "# My Plan\n\n- Step 1" };

    const jsonl = buildChatJsonlForSharing(messages, {
      includeToolOutput: false,
      planSnapshot,
    });

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;

    const planPart = parsed.parts[0];
    if (planPart.type !== "dynamic-tool" || planPart.state !== "output-available") {
      throw new Error("Expected completed propose_plan tool part");
    }

    const planOutput = planPart.output;
    if (planOutput === null || typeof planOutput !== "object") {
      throw new Error("Expected propose_plan output object");
    }

    expect((planOutput as Record<string, unknown>).planContent).toBe(planSnapshot.content);

    const strippedPart = parsed.parts[1];
    if (strippedPart.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }

    expect(strippedPart.state).toBe("input-available");
    expect(strippedPart).not.toHaveProperty("output");

    // Original messages should be unchanged (no mutation during injection/stripping)
    const originalPlanPart = messages[0].parts[0];
    if (originalPlanPart.type !== "dynamic-tool" || originalPlanPart.state !== "output-available") {
      throw new Error("Expected completed propose_plan tool part");
    }

    const originalPlanOutput = originalPlanPart.output;
    if (originalPlanOutput === null || typeof originalPlanOutput !== "object") {
      throw new Error("Expected propose_plan output object");
    }

    expect((originalPlanOutput as Record<string, unknown>).planContent).toBeUndefined();

    const originalStrippedPart = messages[0].parts[1];
    if (originalStrippedPart.type !== "dynamic-tool") {
      throw new Error("Expected tool part");
    }

    expect(originalStrippedPart.state).toBe("output-available");
    expect(originalStrippedPart).toHaveProperty("output");
  });
  it("does not overwrite propose_plan planContent when already present", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "propose_plan",
            state: "output-available",
            input: { title: "My Plan" },
            output: {
              success: true,
              planPath: "/tmp/plan.md",
              message: "Plan saved",
              planContent: "# Existing Plan\n\nDo the thing.",
            },
          },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, {
      includeToolOutput: true,
      planSnapshot: { path: "/tmp/plan.md", content: "# New Plan" },
    });

    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;
    const part = parsed.parts[0];

    if (part.type !== "dynamic-tool" || part.state !== "output-available") {
      throw new Error("Expected completed tool part");
    }

    const output = part.output;
    if (output === null || typeof output !== "object") {
      throw new Error("Expected tool output object");
    }

    expect((output as Record<string, unknown>).planContent).toBe(
      "# Existing Plan\n\nDo the thing."
    );
  });

  it("injects workspaceId into each message when provided", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { workspaceId: "ws-123" });
    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage & { workspaceId?: string };

    expect(parsed.workspaceId).toBe("ws-123");
    expect((messages[0] as MuxMessage & { workspaceId?: string }).workspaceId).toBeUndefined();
  });

  it("returns empty string for empty messages array", () => {
    expect(buildChatJsonlForSharing([])).toBe("");
  });

  it("merges adjacent text/reasoning parts to keep transcripts small", () => {
    const messages: MuxMessage[] = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "a", timestamp: 1 },
          { type: "reasoning", text: "b", timestamp: 2 },
          {
            type: "dynamic-tool",
            toolCallId: "tc-1",
            toolName: "bash",
            state: "input-available",
            input: { script: "echo hi" },
          },
          { type: "text", text: "hello", timestamp: 3 },
          { type: "text", text: " world", timestamp: 4 },
          { type: "reasoning", text: "c" },
        ],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages, { includeToolOutput: true });
    const parsed = JSON.parse(splitJsonlLines(jsonl)[0]) as MuxMessage;

    expect(parsed.parts).toEqual([
      { type: "reasoning", text: "ab", timestamp: 1 },
      {
        type: "dynamic-tool",
        toolCallId: "tc-1",
        toolName: "bash",
        state: "input-available",
        input: { script: "echo hi" },
      },
      { type: "text", text: "hello world", timestamp: 3 },
      { type: "reasoning", text: "c" },
    ]);

    // Original messages should be unchanged (no mutation during compaction)
    expect(messages[0].parts).toHaveLength(6);
  });

  it("produces valid JSONL (each line parses, trailing newline)", () => {
    const messages: MuxMessage[] = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [{ type: "text", text: "world" }],
      },
    ];

    const jsonl = buildChatJsonlForSharing(messages);
    expect(jsonl.endsWith("\n")).toBe(true);

    const lines = splitJsonlLines(jsonl);
    expect(lines).toHaveLength(messages.length);

    const parsed = lines.map((line) => JSON.parse(line) as MuxMessage);
    expect(parsed).toEqual(messages);
  });
});
