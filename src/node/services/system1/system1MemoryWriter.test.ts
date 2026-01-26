import { describe, expect, it } from "bun:test";
import type { LanguageModel } from "ai";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { MuxMessage } from "@/common/types/message";

import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getMemoryFilePathForProject } from "@/node/services/tools/memoryCommon";
import { runSystem1WriteProjectMemories } from "./system1MemoryWriter";

// NOTE: These tests do not exercise a real model.
// We inject a stub generateTextImpl that simulates the model calling the tools.

describe("system1MemoryWriter", () => {
  it("writes memory when the model calls memory_write", async () => {
    const runtime = createRuntime({ type: "local", srcBaseDir: process.cwd() });

    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "system1-memory-project-"));
    const muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "system1-memory-root-"));

    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = muxRoot;

    try {
      await fs.writeFile(
        path.join(muxRoot, "AGENTS.md"),
        "# Global\n\n- Prefer short diffs.\n",
        "utf8"
      );

      await fs.writeFile(path.join(projectDir, "AGENTS.md"), "# Agents\n", "utf8");

      const { memoriesDir, memoryPath } = getMemoryFilePathForProject(projectDir);
      await fs.mkdir(memoriesDir, { recursive: true });
      await fs.writeFile(memoryPath, "old", "utf8");

      const history: MuxMessage[] = [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "Remember this." }],
          metadata: { historySequence: 1 },
        },
      ];

      const result = await runSystem1WriteProjectMemories({
        runtime,
        agentDiscoveryPath: projectDir,
        runtimeTempDir: os.tmpdir(),
        model: {} as unknown as LanguageModel,
        modelString: "openai:gpt-5.1-codex-mini",
        providerOptions: {},
        workspaceId: "ws_1",
        workspaceName: "main",
        projectPath: projectDir,
        workspacePath: projectDir,
        history,
        timeoutMs: 5_000,
        generateTextImpl: async (args) => {
          const messages = (args as { messages?: unknown }).messages as
            | Array<{ content?: unknown }>
            | undefined;
          expect(Array.isArray(messages)).toBe(true);
          expect(typeof messages?.[0]?.content).toBe("string");

          const userMessage = messages?.[0]?.content as string;
          expect(userMessage).toContain("Global AGENTS.md");
          expect(userMessage).toContain("# Global");
          expect(userMessage).toContain("Project/workspace AGENTS.md");
          expect(userMessage).toContain("# Agents");

          const tools = (args as { tools?: unknown }).tools as Record<string, unknown> | undefined;
          expect(tools && "memory_write" in tools).toBe(true);

          const writeTool = tools!.memory_write as {
            execute: (input: unknown, options: unknown) => Promise<unknown>;
          };

          await writeTool.execute({ old_string: "old", new_string: "new" }, {});
          return { finishReason: "stop" };
        },
      });

      expect(result).toEqual({ finishReason: "stop", timedOut: false });
      expect(await fs.readFile(memoryPath, "utf8")).toBe("new");
    } finally {
      if (previousMuxRoot === undefined) {
        delete process.env.MUX_ROOT;
      } else {
        process.env.MUX_ROOT = previousMuxRoot;
      }
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.rm(muxRoot, { recursive: true, force: true });
    }
  });

  it("retries once with a reminder if the model does not call memory_write", async () => {
    const runtime = createRuntime({ type: "local", srcBaseDir: process.cwd() });

    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "system1-memory-project-"));
    const muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "system1-memory-root-"));

    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = muxRoot;

    try {
      await fs.writeFile(
        path.join(muxRoot, "AGENTS.md"),
        "# Global\n\n- Prefer short diffs.\n",
        "utf8"
      );

      await fs.writeFile(path.join(projectDir, "AGENTS.md"), "# Agents\n", "utf8");

      const { memoriesDir, memoryPath } = getMemoryFilePathForProject(projectDir);
      await fs.mkdir(memoriesDir, { recursive: true });
      await fs.writeFile(memoryPath, "old", "utf8");

      let calls = 0;

      const result = await runSystem1WriteProjectMemories({
        runtime,
        agentDiscoveryPath: projectDir,
        runtimeTempDir: os.tmpdir(),
        model: {} as unknown as LanguageModel,
        modelString: "openai:gpt-5.1-codex-mini",
        providerOptions: {},
        workspaceId: "ws_1",
        workspaceName: "main",
        projectPath: projectDir,
        workspacePath: projectDir,
        history: [],
        timeoutMs: 5_000,
        generateTextImpl: async (args) => {
          calls += 1;

          const messages = (args as { messages?: unknown }).messages as
            | Array<{ content?: unknown }>
            | undefined;
          expect(Array.isArray(messages)).toBe(true);

          if (calls === 1) {
            expect(messages!.length).toBe(1);
            return { finishReason: "stop" };
          }

          expect(messages!.length).toBe(2);
          expect(messages![1]?.content).toBe(
            "Reminder: You MUST call memory_write to persist the updated memory file. Do not output prose."
          );

          const tools = (args as { tools?: unknown }).tools as Record<string, unknown> | undefined;
          const writeTool = tools!.memory_write as {
            execute: (input: unknown, options: unknown) => Promise<unknown>;
          };

          await writeTool.execute({ old_string: "old", new_string: "new" }, {});
          return { finishReason: "stop" };
        },
      });

      expect(calls).toBe(2);
      expect(result).toEqual({ finishReason: "stop", timedOut: false });
      expect(await fs.readFile(memoryPath, "utf8")).toBe("new");
    } finally {
      if (previousMuxRoot === undefined) {
        delete process.env.MUX_ROOT;
      } else {
        process.env.MUX_ROOT = previousMuxRoot;
      }
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.rm(muxRoot, { recursive: true, force: true });
    }
  });

  it("supports CAS recovery by reading then writing", async () => {
    const runtime = createRuntime({ type: "local", srcBaseDir: process.cwd() });

    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "system1-memory-project-"));
    const muxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "system1-memory-root-"));

    const previousMuxRoot = process.env.MUX_ROOT;
    process.env.MUX_ROOT = muxRoot;

    try {
      await fs.writeFile(
        path.join(muxRoot, "AGENTS.md"),
        "# Global\n\n- Prefer short diffs.\n",
        "utf8"
      );

      await fs.writeFile(path.join(projectDir, "AGENTS.md"), "# Agents\n", "utf8");

      const { memoriesDir, memoryPath } = getMemoryFilePathForProject(projectDir);
      await fs.mkdir(memoriesDir, { recursive: true });
      await fs.writeFile(memoryPath, "A", "utf8");

      const result = await runSystem1WriteProjectMemories({
        runtime,
        agentDiscoveryPath: projectDir,
        runtimeTempDir: os.tmpdir(),
        model: {} as unknown as LanguageModel,
        modelString: "openai:gpt-5.1-codex-mini",
        providerOptions: {},
        workspaceId: "ws_1",
        workspaceName: "main",
        projectPath: projectDir,
        workspacePath: projectDir,
        history: [],
        timeoutMs: 5_000,
        generateTextImpl: async (args) => {
          const tools = (args as { tools?: unknown }).tools as Record<string, unknown> | undefined;

          const readTool = tools!.memory_read as {
            execute: (input: unknown, options: unknown) => Promise<unknown>;
          };
          const writeTool = tools!.memory_write as {
            execute: (input: unknown, options: unknown) => Promise<unknown>;
          };

          // Simulate another process updating the file after the prompt was constructed.
          await fs.writeFile(memoryPath, "B", "utf8");

          const firstAttempt = (await writeTool.execute(
            { old_string: "A", new_string: "C" },
            {}
          )) as { success: boolean };
          expect(firstAttempt.success).toBe(false);

          const latest = (await readTool.execute({}, {})) as { content?: unknown };
          expect(latest.content).toBe("B");

          await writeTool.execute({ old_string: "B", new_string: "C" }, {});
          return { finishReason: "stop" };
        },
      });

      expect(result).toEqual({ finishReason: "stop", timedOut: false });
      expect(await fs.readFile(memoryPath, "utf8")).toBe("C");
    } finally {
      if (previousMuxRoot === undefined) {
        delete process.env.MUX_ROOT;
      } else {
        process.env.MUX_ROOT = previousMuxRoot;
      }
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.rm(muxRoot, { recursive: true, force: true });
    }
  });
});
