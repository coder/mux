import { describe, expect, test } from "bun:test";
import type { Tool } from "ai";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { InitStateManager } from "@/node/services/initStateManager";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import { setTodosForSessionDir } from "@/node/services/tools/todo";

import { MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD } from "./internalToolResultFields";
import { getToolsForModel } from "./tools";

type ToolExecuteFn = (args?: unknown, options?: unknown) => Promise<unknown>;

function getExecute(tool: unknown): ToolExecuteFn {
  if (!tool || typeof tool !== "object" || !("execute" in tool)) {
    throw new Error("Tool is missing execute()");
  }

  const execute = (tool as { execute?: unknown }).execute;
  if (typeof execute !== "function") {
    throw new Error("Tool execute() is not a function");
  }

  return execute as ToolExecuteFn;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a plain object tool result");
  }

  return value as Record<string, unknown>;
}

describe("getToolsForModel - model-only notifications", () => {
  test("injects __mux_notifications into tool results after 5 tool calls", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ws-"));

    try {
      await setTodosForSessionDir("ws-1", workspaceSessionDir, [
        { content: "Completed", status: "completed" },
        { content: "In progress", status: "in_progress" },
        { content: "Pending", status: "pending" },
      ]);

      const runtime = new LocalRuntime(process.cwd());
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;

      const tools = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          workspaceSessionDir,
        },
        "ws-1",
        initStateManager
      );

      const todoReadExecute = getExecute(tools.todo_read);

      for (let i = 0; i < 4; i += 1) {
        const result = asRecord(await todoReadExecute());
        expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result).toBe(false);
      }

      const fifth = asRecord(await todoReadExecute());
      expect(Array.isArray(fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD])).toBe(true);
      expect(String((fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD] as unknown[])[0])).toContain(
        "Current TODO List"
      );
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });

  test("does not enable notification injection when workspaceSessionDir is missing", async () => {
    const runtime = new LocalRuntime(process.cwd());
    const initStateManager = {
      waitForInit: () => Promise.resolve(),
    } as unknown as InitStateManager;

    const dummyTool = {
      // eslint-disable-next-line @typescript-eslint/require-await
      execute: async () => ({ ok: true }),
    } as unknown as Tool;

    const tools = await getToolsForModel(
      "noop:model",
      {
        cwd: process.cwd(),
        runtime,
        runtimeTempDir: "/tmp",
      },
      "ws-1",
      initStateManager,
      undefined,
      { dummy: dummyTool }
    );

    const dummyExecute = getExecute(tools.dummy);

    for (let i = 0; i < 5; i += 1) {
      const result = asRecord(await dummyExecute());
      expect(MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD in result).toBe(false);
    }
  });

  test("only attaches notifications to plain-object tool results", async () => {
    const workspaceSessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-ws-"));

    try {
      await setTodosForSessionDir("ws-1", workspaceSessionDir, [
        { content: "In progress", status: "in_progress" },
      ]);

      const runtime = new LocalRuntime(process.cwd());
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;

      const stringTool = {
        // eslint-disable-next-line @typescript-eslint/require-await
        execute: async () => "ok",
      } as unknown as Tool;

      const tools = await getToolsForModel(
        "noop:model",
        {
          cwd: process.cwd(),
          runtime,
          runtimeTempDir: "/tmp",
          workspaceSessionDir,
        },
        "ws-1",
        initStateManager,
        undefined,
        { string_tool: stringTool }
      );

      const stringExecute = getExecute(tools.string_tool);
      const todoReadExecute = getExecute(tools.todo_read);

      for (let i = 0; i < 4; i += 1) {
        const result = await stringExecute();
        expect(result).toBe("ok");
      }

      const fifth = asRecord(await todoReadExecute());
      expect(Array.isArray(fifth[MODEL_ONLY_TOOL_NOTIFICATIONS_FIELD])).toBe(true);
    } finally {
      await fs.rm(workspaceSessionDir, { recursive: true, force: true });
    }
  });
});
