import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { createFileEditInsertTool } from "./file_edit_insert";
import type { FileEditInsertToolArgs, FileEditInsertToolResult } from "@/common/types/tools";
import type { ToolCallOptions } from "ai";
import { createRuntime } from "@/node/runtime/runtimeFactory";
import { getTestDeps } from "./testHelpers";

const mockToolCallOptions: ToolCallOptions = {
  toolCallId: "test-call-id",
  messages: [],
};

function createTestTool(cwd: string) {
  return createFileEditInsertTool({
    ...getTestDeps(),
    cwd,
    runtime: createRuntime({ type: "local", srcBaseDir: cwd }),
    runtimeTempDir: cwd,
  });
}

describe("file_edit_insert tool", () => {
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-edit-insert-"));
    testFilePath = path.join(testDir, "test.txt");
    await fs.writeFile(testFilePath, "Line 1\nLine 3");
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("inserts content using before guard", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      file_path: path.relative(testDir, testFilePath),
      content: "Line 2\n",
      before: "Line 1\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    const updated = await fs.readFile(testFilePath, "utf-8");
    expect(updated).toBe("Line 1\nLine 2\nLine 3");
  });

  it("inserts content using after guard", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      file_path: path.relative(testDir, testFilePath),
      content: "Header\n",
      after: "Line 1",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(true);
    expect(await fs.readFile(testFilePath, "utf-8")).toBe("Header\nLine 1\nLine 3");
  });

  it("fails when guard matches multiple times", async () => {
    await fs.writeFile(testFilePath, "repeat\nrepeat\nrepeat\n");
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      file_path: path.relative(testDir, testFilePath),
      content: "middle\n",
      before: "repeat\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("multiple times");
    }
  });

  it("fails when both before and after are provided", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      file_path: path.relative(testDir, testFilePath),
      content: "oops",
      before: "Line 1",
      after: "Line 3",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("only one of before or after");
    }
  });

  it("creates a new file without requiring create flag or guards", async () => {
    const newFile = path.join(testDir, "new.txt");
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      file_path: path.relative(testDir, newFile),
      content: "Hello world!\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(true);
    expect(await fs.readFile(newFile, "utf-8")).toBe("Hello world!\n");
  });

  it("fails when no guards are provided", async () => {
    const tool = createTestTool(testDir);
    const args: FileEditInsertToolArgs = {
      file_path: path.relative(testDir, testFilePath),
      content: "noop",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Provide either a before or after guard");
    }
  });
});

describe("file_edit_insert plan mode enforcement", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-mode-insert-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("blocks creating non-plan files when in plan mode", async () => {
    const planFilePath = path.join(testDir, "sessions", "workspace", "plan.md");
    const otherFilePath = path.join(testDir, "workspace", "main.ts");
    const workspaceCwd = path.join(testDir, "workspace");

    // Create workspace directory
    await fs.mkdir(workspaceCwd, { recursive: true });

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: workspaceCwd,
      runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
      runtimeTempDir: testDir,
      mode: "plan",
      planFilePath: planFilePath,
    });

    const args: FileEditInsertToolArgs = {
      file_path: otherFilePath,
      content: "console.log('test');",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("In plan mode, only the plan file can be edited");
    }
  });

  it("allows creating plan file when in plan mode", async () => {
    const planFilePath = path.join(testDir, "plan.md");
    const workspaceCwd = path.join(testDir, "workspace");

    // Create workspace directory
    await fs.mkdir(workspaceCwd, { recursive: true });

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: workspaceCwd,
      runtime: createRuntime({ type: "local", srcBaseDir: workspaceCwd }),
      runtimeTempDir: testDir,
      mode: "plan",
      planFilePath: planFilePath,
    });

    const args: FileEditInsertToolArgs = {
      file_path: planFilePath,
      content: "# My Plan\n\n- Step 1\n- Step 2\n",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(planFilePath, "utf-8")).toBe("# My Plan\n\n- Step 1\n- Step 2\n");
  });

  it("allows editing any file in exec mode", async () => {
    const testFilePath = path.join(testDir, "main.ts");
    await fs.writeFile(testFilePath, "const x = 1;");

    const tool = createFileEditInsertTool({
      ...getTestDeps(),
      cwd: testDir,
      runtime: createRuntime({ type: "local", srcBaseDir: testDir }),
      runtimeTempDir: testDir,
      mode: "exec",
    });

    const args: FileEditInsertToolArgs = {
      file_path: testFilePath,
      content: "// header\n",
      after: "const x = 1;",
    };

    const result = (await tool.execute!(args, mockToolCallOptions)) as FileEditInsertToolResult;

    expect(result.success).toBe(true);
    expect(await fs.readFile(testFilePath, "utf-8")).toBe("// header\nconst x = 1;");
  });
});
