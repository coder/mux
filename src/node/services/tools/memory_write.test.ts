import { beforeEach, afterEach, describe, expect, it } from "bun:test";
import type { ToolCallOptions } from "ai";

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { createMemoryWriteTool } from "./memory_write";
import { getMemoryFilePathForProject } from "./memoryCommon";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import { TestTempDir, createTestToolConfig } from "./testHelpers";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

describe("memory_write tool", () => {
  let originalMuxRoot: string | undefined;

  beforeEach(() => {
    originalMuxRoot = process.env.MUX_ROOT;
  });

  afterEach(() => {
    if (originalMuxRoot === undefined) {
      delete process.env.MUX_ROOT;
    } else {
      process.env.MUX_ROOT = originalMuxRoot;
    }
  });

  function createConfig(tempDir: string, projectPath: string): ToolConfiguration {
    const config = createTestToolConfig(tempDir);
    config.muxEnv = {
      MUX_PROJECT_PATH: projectPath,
      MUX_WORKSPACE_NAME: "test-workspace",
      MUX_RUNTIME: "local",
    };
    return config;
  }

  it("creates the memory file when old_string is empty and the file is empty", async () => {
    using muxRoot = new TestTempDir("test-memory-write");
    process.env.MUX_ROOT = muxRoot.path;

    const projectPath = path.join(muxRoot.path, "My Project");
    const config = createConfig(muxRoot.path, projectPath);

    const tool = createMemoryWriteTool(config);
    const result = await tool.execute!(
      { old_string: "", new_string: "hello", replace_count: 1 },
      mockToolCallOptions
    );

    expect(result).toEqual({ success: true });

    const { memoryPath } = getMemoryFilePathForProject(projectPath);
    expect(await fs.readFile(memoryPath, "utf8")).toBe("hello");
  });

  it("fails when old_string is empty but the file is not empty", async () => {
    using muxRoot = new TestTempDir("test-memory-write");
    process.env.MUX_ROOT = muxRoot.path;

    const projectPath = path.join(muxRoot.path, "project");
    const config = createConfig(muxRoot.path, projectPath);

    const tool = createMemoryWriteTool(config);

    const first = await tool.execute!(
      { old_string: "", new_string: "first", replace_count: 1 },
      mockToolCallOptions
    );
    expect(first).toEqual({ success: true });

    const second = await tool.execute!(
      { old_string: "", new_string: "second", replace_count: 1 },
      mockToolCallOptions
    );

    expect(second).toEqual({
      success: false,
      error:
        "old_string is empty but the memory file is not empty. Read the latest content and retry with old_string set to the full current file content.",
    });

    const { memoryPath } = getMemoryFilePathForProject(projectPath);
    expect(await fs.readFile(memoryPath, "utf8")).toBe("first");
  });

  it("replaces old_string with new_string", async () => {
    using muxRoot = new TestTempDir("test-memory-write");
    process.env.MUX_ROOT = muxRoot.path;

    const projectPath = path.join(muxRoot.path, "project");
    const { memoriesDir, memoryPath } = getMemoryFilePathForProject(projectPath);
    await fs.mkdir(memoriesDir, { recursive: true });
    await fs.writeFile(memoryPath, "alpha\nbeta\n", "utf8");

    const config = createConfig(muxRoot.path, projectPath);
    const tool = createMemoryWriteTool(config);

    const result = await tool.execute!(
      { old_string: "beta", new_string: "gamma" },
      mockToolCallOptions
    );
    expect(result).toEqual({ success: true });

    expect(await fs.readFile(memoryPath, "utf8")).toBe("alpha\ngamma\n");
  });

  it("fails when old_string is missing", async () => {
    using muxRoot = new TestTempDir("test-memory-write");
    process.env.MUX_ROOT = muxRoot.path;

    const projectPath = path.join(muxRoot.path, "project");
    const { memoriesDir, memoryPath } = getMemoryFilePathForProject(projectPath);
    await fs.mkdir(memoriesDir, { recursive: true });
    await fs.writeFile(memoryPath, "hello", "utf8");

    const config = createConfig(muxRoot.path, projectPath);
    const tool = createMemoryWriteTool(config);

    const result = await tool.execute!(
      { old_string: "not found", new_string: "ok" },
      mockToolCallOptions
    );

    expect(result).toEqual({
      success: false,
      error: "old_string not found in file. The text to replace must exist in the file.",
    });
  });

  it("fails when old_string is non-unique and replace_count is 1", async () => {
    using muxRoot = new TestTempDir("test-memory-write");
    process.env.MUX_ROOT = muxRoot.path;

    const projectPath = path.join(muxRoot.path, "project");
    const { memoriesDir, memoryPath } = getMemoryFilePathForProject(projectPath);
    await fs.mkdir(memoriesDir, { recursive: true });
    await fs.writeFile(memoryPath, "a a a", "utf8");

    const config = createConfig(muxRoot.path, projectPath);
    const tool = createMemoryWriteTool(config);

    const result = await tool.execute!(
      { old_string: "a", new_string: "b", replace_count: 1 },
      mockToolCallOptions
    );

    expect(result).toEqual({
      success: false,
      error:
        "old_string appears 3 times in the file. Either expand the context to make it unique or set replace_count to 3 or -1.",
    });
  });

  it("serializes concurrent writes via an in-process lock", async () => {
    using muxRoot = new TestTempDir("test-memory-write");
    process.env.MUX_ROOT = muxRoot.path;

    const projectPath = path.join(muxRoot.path, "project");
    const config = createConfig(muxRoot.path, projectPath);

    const tool = createMemoryWriteTool(config);

    const [a, b] = await Promise.all([
      tool.execute!({ old_string: "", new_string: "one" }, mockToolCallOptions),
      tool.execute!({ old_string: "", new_string: "two" }, mockToolCallOptions),
    ]);

    const successes = [a, b].filter((result): result is { success: true } =>
      Boolean(
        result && typeof result === "object" && "success" in result && result.success === true
      )
    );

    expect(successes.length).toBe(1);

    const { memoryPath } = getMemoryFilePathForProject(projectPath);
    const finalContent = await fs.readFile(memoryPath, "utf8");
    expect(["one", "two"]).toContain(finalContent);
  });
});
