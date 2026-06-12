import { describe, it, expect } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "ai";
import { Config } from "@/node/config";
import { LocalRuntime } from "@/node/runtime/LocalRuntime";
import type { InitStateManager } from "@/node/services/initStateManager";
import { MemoryService } from "@/node/services/memoryService";
import { MemoryMetaService } from "@/node/services/memoryMeta";
import { createMemoryTool, resolveMemoryAccessPolicy } from "./memory";
import { TestTempDir, createTestToolConfig, mockToolCallOptions } from "./testHelpers";
import type { MemoryToolResult } from "@/common/types/tools";
import type { MemoryScopeAccess, MemoryScope } from "@/common/constants/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { getToolsForModel, type ToolConfiguration } from "@/common/utils/tools/tools";

function pathExists(target: string): Promise<boolean> {
  return fsPromises.access(target).then(
    () => true,
    () => false
  );
}

interface MemoryToolFixture extends Disposable {
  muxHome: string;
  checkout: string;
  config: ToolConfiguration;
  tool: Tool;
}

async function createFixture(options?: {
  memoryAccess?: MemoryScopeAccess;
}): Promise<MemoryToolFixture> {
  const tempDir = new TestTempDir("test-memory-tool");
  const muxHome = path.join(tempDir.path, "mux-home");
  const checkout = path.join(tempDir.path, "checkout");
  await fsPromises.mkdir(muxHome, { recursive: true });
  await fsPromises.mkdir(checkout, { recursive: true });
  const config = createTestToolConfig(checkout, { workspaceId: "ws-tool" });
  config.runtime = new LocalRuntime(checkout);
  config.memoryService = new MemoryService(new Config(muxHome), new MemoryMetaService(muxHome));
  config.memoryAccess = options?.memoryAccess ?? {
    global: "readwrite",
    project: "readwrite",
    workspace: "readwrite",
  };
  return {
    muxHome,
    checkout,
    config,
    tool: createMemoryTool(config),
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

describe("memory tool sub-project workspaces", () => {
  it("resolves project memory from the checkout root, not the execution cwd", async () => {
    using fixture = await createFixture();
    // Simulate a sub-project workspace: tools execute in <checkout>/packages/app
    // while the checkout root is <checkout>. Project memories must live at the
    // checkout root so the Memory tab / hot-set (which resolve the root) see them.
    const subProjectCwd = path.join(fixture.checkout, "packages", "app");
    await fsPromises.mkdir(subProjectCwd, { recursive: true });
    fixture.config.cwd = subProjectCwd;
    fixture.config.workspaceCheckoutRootPath = fixture.checkout;
    const tool = createMemoryTool(fixture.config);

    const result = await run(tool, {
      command: "create",
      path: "/memories/project/facts.md",
      file_text: "root-anchored",
    });
    expect(result.success).toBe(true);
    expect(await pathExists(path.join(fixture.checkout, ".mux", "memory", "facts.md"))).toBe(true);
    expect(await pathExists(path.join(subProjectCwd, ".mux", "memory", "facts.md"))).toBe(false);
  });
});

async function run(tool: Tool, input: Record<string, unknown>): Promise<MemoryToolResult> {
  const parsed = TOOL_DEFINITIONS.memory.schema.parse(input);
  return (await tool.execute!(parsed, mockToolCallOptions)) as MemoryToolResult;
}

describe("memory tool", () => {
  describe("command dispatch", () => {
    it("creates, views, edits, renames and deletes through the tool surface", async () => {
      using fixture = await createFixture();

      const created = await run(fixture.tool, {
        command: "create",
        path: "/memories/global/notes.md",
        file_text: "line one",
      });
      expect(created.success).toBe(true);
      expect(await pathExists(path.join(fixture.muxHome, "memory", "notes.md"))).toBe(true);

      const inserted = await run(fixture.tool, {
        command: "insert",
        path: "/memories/global/notes.md",
        insert_line: 1,
        insert_text: "line two",
      });
      expect(inserted.success).toBe(true);

      const replaced = await run(fixture.tool, {
        command: "str_replace",
        path: "/memories/global/notes.md",
        old_str: "line two",
        new_str: "line 2",
      });
      expect(replaced.success).toBe(true);

      const viewed = await run(fixture.tool, {
        command: "view",
        path: "/memories/global/notes.md",
      });
      expect(viewed).toEqual({ success: true, output: "1\tline one\n2\tline 2" });

      const renamed = await run(fixture.tool, {
        command: "rename",
        old_path: "/memories/global/notes.md",
        new_path: "/memories/global/renamed.md",
      });
      expect(renamed.success).toBe(true);

      const deleted = await run(fixture.tool, {
        command: "delete",
        path: "/memories/global/renamed.md",
      });
      expect(deleted.success).toBe(true);
      expect(await pathExists(path.join(fixture.muxHome, "memory", "renamed.md"))).toBe(false);
    });

    it("returns recoverable errors for missing required fields", async () => {
      using fixture = await createFixture();
      const cases: Array<Record<string, unknown>> = [
        { command: "view" },
        { command: "create", path: "/memories/global/x.md" },
        { command: "str_replace", path: "/memories/global/x.md" },
        { command: "insert", path: "/memories/global/x.md", insert_text: "y" },
        { command: "delete" },
        { command: "rename", new_path: "/memories/global/y.md" },
      ];
      for (const input of cases) {
        const result = await run(fixture.tool, input);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toContain("requires");
        }
      }
    });

    it("falls back to 'path' as the rename source", async () => {
      using fixture = await createFixture();
      await run(fixture.tool, {
        command: "create",
        path: "/memories/global/src.md",
        file_text: "x",
      });
      const renamed = await run(fixture.tool, {
        command: "rename",
        path: "/memories/global/src.md",
        new_path: "/memories/global/dst.md",
      });
      expect(renamed.success).toBe(true);
    });
  });

  describe("schema alias shims", () => {
    it("normalizes file_path/content/old_string/new_string to canonical fields", () => {
      const parsed = TOOL_DEFINITIONS.memory.schema.parse({
        command: "create",
        file_path: "/memories/global/a.md",
        content: "body",
        old_string: "from",
        new_string: "to",
      });
      expect(parsed.path).toBe("/memories/global/a.md");
      expect(parsed.file_text).toBe("body");
      expect(parsed.old_str).toBe("from");
      expect(parsed.new_str).toBe("to");
    });
  });

  describe("mode / sub-agent write policy matrix", () => {
    const MUTATING_INPUTS: Array<(scope: MemoryScope) => Record<string, unknown>> = [
      (scope) => ({ command: "create", path: `/memories/${scope}/m.md`, file_text: "x" }),
      (scope) => ({ command: "str_replace", path: `/memories/${scope}/m.md`, old_str: "a" }),
      (scope) => ({
        command: "insert",
        path: `/memories/${scope}/m.md`,
        insert_line: 0,
        insert_text: "x",
      }),
      (scope) => ({ command: "delete", path: `/memories/${scope}/m.md` }),
      (scope) => ({
        command: "rename",
        old_path: `/memories/${scope}/m.md`,
        new_path: `/memories/${scope}/n.md`,
      }),
    ];

    const MATRIX: Array<{ name: string; access: MemoryScopeAccess }> = [
      {
        name: "exec-like",
        access: resolveMemoryAccessPolicy({ planLike: false, editingCapable: true }),
      },
      {
        name: "plan-like",
        access: resolveMemoryAccessPolicy({ planLike: true, editingCapable: true }),
      },
      {
        name: "read-only",
        access: resolveMemoryAccessPolicy({ planLike: false, editingCapable: false }),
      },
    ];

    for (const { name, access } of MATRIX) {
      for (const scope of ["global", "project", "workspace"] as const) {
        const writable = access[scope] === "readwrite";

        it(`${name}: mutating commands on ${scope} scope are ${writable ? "allowed" : "rejected"}`, async () => {
          using fixture = await createFixture({ memoryAccess: access });
          for (const makeInput of MUTATING_INPUTS) {
            const result = await run(fixture.tool, makeInput(scope));
            if (writable) {
              // The command may still fail for state reasons (e.g. missing
              // file), but never with the read-only policy error.
              if (!result.success) {
                expect(result.error).not.toContain("read-only");
              }
            } else {
              expect(result.success).toBe(false);
              if (!result.success) {
                expect(result.error).toContain("read-only");
              }
            }
          }
        });

        it(`${name}: view on ${scope} scope is always allowed`, async () => {
          using fixture = await createFixture({ memoryAccess: access });
          const result = await run(fixture.tool, { command: "view", path: `/memories/${scope}` });
          expect(result.success).toBe(true);
        });
      }
    }

    it("defaults to read-only when no memoryAccess policy is configured", async () => {
      using fixture = await createFixture();
      fixture.config.memoryAccess = undefined;
      const tool = createMemoryTool(fixture.config);
      const result = await run(tool, {
        command: "create",
        path: "/memories/global/x.md",
        file_text: "x",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("read-only");
      }
    });
  });

  describe("policy derivation", () => {
    it("maps the three agent classes onto the locked write matrix", () => {
      expect(resolveMemoryAccessPolicy({ planLike: false, editingCapable: true })).toEqual({
        global: "readwrite",
        project: "readwrite",
        workspace: "readwrite",
      });
      expect(resolveMemoryAccessPolicy({ planLike: true, editingCapable: true })).toEqual({
        global: "readwrite",
        project: "read",
        workspace: "readwrite",
      });
      expect(resolveMemoryAccessPolicy({ planLike: false, editingCapable: false })).toEqual({
        global: "read",
        project: "read",
        workspace: "read",
      });
    });
  });

  describe("experiment gating", () => {
    async function getRegisteredTools(options: {
      memoryService?: MemoryService;
      memoryExperiment?: boolean;
    }): Promise<string[]> {
      using tempDir = new TestTempDir("test-memory-gating");
      const workspaceSessionDir = path.join(tempDir.path, "session");
      await fsPromises.mkdir(workspaceSessionDir, { recursive: true });
      const initStateManager = {
        waitForInit: () => Promise.resolve(),
      } as unknown as InitStateManager;
      const tools = await getToolsForModel(
        "noop:model",
        {
          cwd: tempDir.path,
          runtime: new LocalRuntime(tempDir.path),
          runtimeTempDir: tempDir.path,
          workspaceSessionDir,
          memoryService: options.memoryService,
          experiments: { memory: options.memoryExperiment },
        },
        "ws-gating",
        initStateManager
      );
      return Object.keys(tools);
    }

    it("registers the memory tool when the experiment is on", async () => {
      using tempDir = new TestTempDir("test-memory-home");
      const memoryService = new MemoryService(
        new Config(tempDir.path),
        new MemoryMetaService(tempDir.path)
      );
      const tools = await getRegisteredTools({ memoryService, memoryExperiment: true });
      expect(tools).toContain("memory");
    });

    it("omits the memory tool when the experiment is off", async () => {
      using tempDir = new TestTempDir("test-memory-home");
      const memoryService = new MemoryService(
        new Config(tempDir.path),
        new MemoryMetaService(tempDir.path)
      );
      const tools = await getRegisteredTools({ memoryService, memoryExperiment: false });
      expect(tools).not.toContain("memory");
    });

    it("omits the memory tool when no MemoryService is configured", async () => {
      const tools = await getRegisteredTools({ memoryExperiment: true });
      expect(tools).not.toContain("memory");
    });
  });
});
