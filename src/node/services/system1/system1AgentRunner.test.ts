import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";
import * as os from "node:os";

import { createRuntime } from "@/node/runtime/runtimeFactory";
import { runSystem1KeepRangesForBashOutput } from "./system1AgentRunner";

// NOTE: These tests do not exercise a real model.
// We inject a stub generateTextImpl that simulates the model calling the tool.

describe("system1AgentRunner", () => {
  it("returns keep ranges when the model calls system1_keep_ranges", async () => {
    const runtime = createRuntime({ type: "local", srcBaseDir: process.cwd() });

    const result = await runSystem1KeepRangesForBashOutput({
      runtime,
      agentDiscoveryPath: process.cwd(),
      runtimeTempDir: os.tmpdir(),
      model: {} as unknown as LanguageModel,
      modelString: "openai:gpt-5.1-codex-mini",
      providerOptions: {},
      script: "echo hi",
      numberedOutput: "0001| hi\n0002| ERROR: bad\n0003| at x",
      maxKeptLines: 10,
      timeoutMs: 5_000,
      generateTextImpl: async (args) => {
        // Ensure the runner forces tool usage.
        expect((args as { toolChoice?: unknown }).toolChoice).toEqual({
          type: "tool",
          toolName: "system1_keep_ranges",
        });

        const tools = (args as { tools?: unknown }).tools as Record<string, unknown> | undefined;
        expect(tools && "system1_keep_ranges" in tools).toBe(true);

        // Simulate the model calling the tool.
        const keepRangesTool = tools!.system1_keep_ranges as {
          execute: (input: unknown, options: unknown) => Promise<unknown>;
        };

        await keepRangesTool.execute({ keep_ranges: [{ start: 2, end: 3, reason: "error" }] }, {});

        return { finishReason: "stop" };
      },
    });

    expect(result).toEqual({
      keepRanges: [{ start: 2, end: 3, reason: "error" }],
      finishReason: "stop",
      timedOut: false,
    });
  });

  it("returns undefined when the model does not call the tool", async () => {
    const runtime = createRuntime({ type: "local", srcBaseDir: process.cwd() });

    const result = await runSystem1KeepRangesForBashOutput({
      runtime,
      agentDiscoveryPath: process.cwd(),
      runtimeTempDir: os.tmpdir(),
      model: {} as unknown as LanguageModel,
      modelString: "openai:gpt-5.1-codex-mini",
      providerOptions: {},
      script: "echo hi",
      numberedOutput: "0001| hi",
      maxKeptLines: 10,
      timeoutMs: 5_000,
      generateTextImpl: () => Promise.resolve({ finishReason: "stop" }),
    });

    expect(result).toBeUndefined();
  });

  it("returns undefined on AbortError", async () => {
    const runtime = createRuntime({ type: "local", srcBaseDir: process.cwd() });

    const result = await runSystem1KeepRangesForBashOutput({
      runtime,
      agentDiscoveryPath: process.cwd(),
      runtimeTempDir: os.tmpdir(),
      model: {} as unknown as LanguageModel,
      modelString: "openai:gpt-5.1-codex-mini",
      providerOptions: {},
      script: "echo hi",
      numberedOutput: "0001| hi",
      maxKeptLines: 10,
      timeoutMs: 5_000,
      generateTextImpl: () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      },
    });

    expect(result).toBeUndefined();
  });
});
