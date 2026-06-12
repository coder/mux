import { describe, expect, it } from "bun:test";

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import type { Tool } from "ai";

import { MEMORY_CONSOLIDATION_OP_BUDGET } from "@/common/constants/memory";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import { Config } from "@/node/config";
import { createConsolidationMemoryTool, type MemoryConsolidationOp } from "./memoryConsolidation";
import { memoryLogicalKey, MemoryMetaService } from "./memoryMeta";
import { MemoryService, type MemoryScopeContext } from "./memoryService";
import { TestTempDir, mockToolCallOptions } from "./tools/testHelpers";

/**
 * Behavior under test: the consolidation rails (scope restriction, pin
 * protection, op budget, dry-run interception, journal) enforced by the
 * guarded memory tool — in code, independent of the model and the agent
 * prompt.
 */

interface Fixture extends Disposable {
  muxHome: string;
  metaService: MemoryMetaService;
  memoryService: MemoryService;
  ctx: MemoryScopeContext;
  journal: MemoryConsolidationOp[];
  tool: Tool;
  globalMemoryDir: string;
}

async function createFixture(options?: { dryRun?: boolean }): Promise<Fixture> {
  const tempDir = new TestTempDir("test-memory-consolidation");
  const muxHome = path.join(tempDir.path, "mux-home");
  const globalMemoryDir = path.join(muxHome, "memory");
  await fsPromises.mkdir(globalMemoryDir, { recursive: true });

  const metaService = new MemoryMetaService(muxHome);
  const memoryService = new MemoryService(new Config(muxHome), metaService);
  // runtime: null + checkoutCwd: "" → project scope structurally disabled,
  // mirroring the v1 consolidation context.
  const ctx: MemoryScopeContext = {
    runtime: null,
    checkoutCwd: "",
    workspaceId: "ws-consolidation",
    projectPath: "/projects/consolidation",
  };
  const journal: MemoryConsolidationOp[] = [];
  return {
    muxHome,
    metaService,
    memoryService,
    ctx,
    journal,
    globalMemoryDir,
    tool: createConsolidationMemoryTool({
      memoryService,
      metaService,
      ctx,
      dryRun: options?.dryRun ?? false,
      journal,
    }),
    [Symbol.dispose]() {
      tempDir[Symbol.dispose]();
    },
  };
}

function pathExists(target: string): Promise<boolean> {
  return fsPromises.access(target).then(
    () => true,
    () => false
  );
}

type MemoryExecuteResult = { success: true; output: string } | { success: false; error: string };

async function execute(tool: Tool, input: Record<string, unknown>): Promise<MemoryExecuteResult> {
  const parsed = TOOL_DEFINITIONS.memory.schema.parse(input);
  return (await tool.execute!(parsed, mockToolCallOptions)) as MemoryExecuteResult;
}

describe("consolidation memory tool rails", () => {
  it("applies in-scope mutations and journals them", async () => {
    using fixture = await createFixture();
    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/lesson.md",
      file_text: "a durable lesson\n",
    });
    expect(result.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.globalMemoryDir, "lesson.md"), "utf-8")
    ).toContain("durable lesson");
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/global/lesson.md", applied: true, note: undefined },
    ]);
  });

  it("rejects project-scope mutations but allows reads to pass through", async () => {
    using fixture = await createFixture();
    const mutation = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/project/note.md",
    });
    expect(mutation.success).toBe(false);
    if (!mutation.success) expect(mutation.error).toContain("only /memories/workspace/");
    expect(fixture.journal[0]?.applied).toBe(false);

    // Reads are unguarded: project-scope view fails inside MemoryService
    // (scope disabled in this ctx) — not via the consolidation guard.
    const read = await execute(fixture.tool, { command: "view", path: "/memories/global/" });
    expect(read.success).toBe(true);
  });

  it("never deletes or renames pinned files but allows editing them", async () => {
    using fixture = await createFixture();
    await fsPromises.writeFile(path.join(fixture.globalMemoryDir, "pinned.md"), "keep me\n");
    await fixture.metaService.setPinned(
      memoryLogicalKey("global", "pinned.md", {
        projectPath: fixture.ctx.projectPath,
        workspaceId: fixture.ctx.workspaceId,
      }),
      true
    );

    const deletion = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/pinned.md",
    });
    expect(deletion.success).toBe(false);
    if (!deletion.success) expect(deletion.error).toContain("pinned");

    const rename = await execute(fixture.tool, {
      command: "rename",
      old_path: "/memories/global/pinned.md",
      new_path: "/memories/global/moved.md",
    });
    expect(rename.success).toBe(false);

    const edit = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/pinned.md",
      old_str: "keep me",
      new_str: "keep me, polished",
    });
    expect(edit.success).toBe(true);
    expect(
      await fsPromises.readFile(path.join(fixture.globalMemoryDir, "pinned.md"), "utf-8")
    ).toContain("polished");
  });

  it("exhausts the mutation budget and rejects further mutations while reads continue", async () => {
    using fixture = await createFixture();
    for (let i = 0; i < MEMORY_CONSOLIDATION_OP_BUDGET; i++) {
      const result = await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/file-${i}.md`,
        file_text: "x\n",
      });
      expect(result.success).toBe(true);
    }

    const overBudget = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/one-too-many.md",
      file_text: "x\n",
    });
    expect(overBudget.success).toBe(false);
    if (!overBudget.success) expect(overBudget.error).toContain("budget");
    expect(await pathExists(path.join(fixture.globalMemoryDir, "one-too-many.md"))).toBe(false);

    const read = await execute(fixture.tool, { command: "view", path: "/memories/global/" });
    expect(read.success).toBe(true);
  });

  it("dry-run journals proposed mutations without touching disk and still consumes budget", async () => {
    using fixture = await createFixture({ dryRun: true });
    const result = await execute(fixture.tool, {
      command: "create",
      path: "/memories/global/proposed.md",
      file_text: "x\n",
    });
    expect(result.success).toBe(true);
    expect(await pathExists(path.join(fixture.globalMemoryDir, "proposed.md"))).toBe(false);
    expect(fixture.journal).toEqual([
      { command: "create", path: "/memories/global/proposed.md", applied: false, note: "dry-run" },
    ]);

    // Budget parity with real runs: dry-run proposals are budgeted too.
    for (let i = 1; i < MEMORY_CONSOLIDATION_OP_BUDGET; i++) {
      await execute(fixture.tool, {
        command: "create",
        path: `/memories/global/p-${i}.md`,
        file_text: "x\n",
      });
    }
    const overBudget = await execute(fixture.tool, {
      command: "delete",
      path: "/memories/global/proposed.md",
    });
    expect(overBudget.success).toBe(false);
  });

  it("journals failed dispatches as unapplied with the error note", async () => {
    using fixture = await createFixture();
    const result = await execute(fixture.tool, {
      command: "str_replace",
      path: "/memories/global/missing.md",
      old_str: "nothing",
      new_str: "something",
    });
    expect(result.success).toBe(false);
    expect(fixture.journal).toHaveLength(1);
    expect(fixture.journal[0]?.applied).toBe(false);
    expect(fixture.journal[0]?.note).toBeDefined();
  });
});
