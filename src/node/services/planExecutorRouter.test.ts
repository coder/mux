import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";

import { routePlanToExecutor } from "./planExecutorRouter";

describe("planExecutorRouter", () => {
  it("returns orchestrator when select_executor chooses orchestrator", async () => {
    let calls = 0;

    const decision = await routePlanToExecutor({
      model: {} as unknown as LanguageModel,
      planContent: "Update backend, frontend, and tests in parallel.",
      timeoutMs: 5_000,
      generateTextImpl: async (args) => {
        calls += 1;

        expect((args as { toolChoice?: unknown }).toolChoice).toEqual({
          type: "tool",
          toolName: "select_executor",
        });

        const tools = (args as { tools?: unknown }).tools as Record<string, unknown>;
        const selectExecutorTool = tools.select_executor as {
          execute: (input: unknown, options: unknown) => Promise<unknown>;
        };

        await selectExecutorTool.execute(
          {
            target: "orchestrator",
            reasoning: "Plan spans independent workstreams.",
          },
          {}
        );

        return { finishReason: "stop" };
      },
    });

    expect(calls).toBe(1);
    expect(decision).toEqual({
      target: "orchestrator",
      reasoning: "Plan spans independent workstreams.",
    });
  });

  it("retries once with a reminder when no tool call is produced", async () => {
    let calls = 0;

    const decision = await routePlanToExecutor({
      model: {} as unknown as LanguageModel,
      planContent: "Single-file refactor.",
      timeoutMs: 5_000,
      generateTextImpl: async (args) => {
        calls += 1;

        const messages = (args as { messages?: unknown }).messages as
          | Array<{ content?: unknown }>
          | undefined;
        expect(Array.isArray(messages)).toBe(true);

        if (calls === 1) {
          expect(messages?.length).toBe(1);
          return { finishReason: "stop" };
        }

        expect(messages?.length).toBe(2);
        expect(messages?.[1]?.content).toBe(
          "Reminder: You MUST call select_executor exactly once. Do not output any text."
        );

        const tools = (args as { tools?: unknown }).tools as Record<string, unknown>;
        const selectExecutorTool = tools.select_executor as {
          execute: (input: unknown, options: unknown) => Promise<unknown>;
        };

        await selectExecutorTool.execute(
          {
            target: "exec",
            reasoning: "Plan is focused and sequential.",
          },
          {}
        );

        return { finishReason: "stop" };
      },
    });

    expect(calls).toBe(2);
    expect(decision).toEqual({
      target: "exec",
      reasoning: "Plan is focused and sequential.",
    });
  });

  it("defaults to exec when the model never calls select_executor", async () => {
    const decision = await routePlanToExecutor({
      model: {} as unknown as LanguageModel,
      planContent: "Any plan",
      timeoutMs: 5_000,
      generateTextImpl: () => {
        return Promise.resolve({ finishReason: "stop" });
      },
    });

    expect(decision).toEqual({ target: "exec" });
  });
});
