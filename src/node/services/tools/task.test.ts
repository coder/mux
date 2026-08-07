import { describe, it, expect, mock } from "bun:test";
import type { TaskCreatedEvent } from "@/common/types/stream";

import { tool } from "ai";
import { z } from "zod";

import { createTaskTool, markBuiltInTaskTool, isBuiltInTaskTool } from "./task";
import { createTestToolConfig, mockToolCallOptions, TestTempDir } from "./testHelpers";
import { Ok, Err } from "@/common/types/result";
import type { TaskService } from "@/node/services/taskService";

function expectQueuedOrRunningTaskToolResult(
  result: unknown,
  expected: { status: "queued" | "running"; taskId: string; workspaceId?: string }
): void {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();

  const obj = result as Record<string, unknown>;
  expect(obj.status).toBe(expected.status);
  if (expected.workspaceId != null) expect(obj.workspaceId).toBe(expected.workspaceId);
  expect(obj.taskId).toBe(expected.taskId);
  expect(typeof obj.note).toBe("string");
}

function expectGroupedQueuedOrRunningTaskToolResult(
  result: unknown,
  expected: { status: "queued" | "running"; taskIds: string[] }
): void {
  expect(result).toBeTruthy();
  expect(typeof result).toBe("object");
  expect(result).not.toBeNull();

  const obj = result as Record<string, unknown>;
  expect(obj.status).toBe(expected.status);
  expect(obj.taskIds).toEqual(expected.taskIds);
  expect(obj.tasks).toMatchObject(
    expected.taskIds.map((taskId) => ({
      taskId,
      status: expected.status,
    }))
  );
  expect(typeof obj.note).toBe("string");
}

describe("task tool", () => {
  it("uses runtime-aware description for local runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-local-description");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      muxEnv: { MUX_RUNTIME: "local" },
    });

    expect(tool.description).toContain("share the same working directory as the parent");
    expect(tool.description).toContain("can see uncommitted changes");
  });

  it("uses runtime-aware description for worktree runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-worktree-description");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      muxEnv: { MUX_RUNTIME: "worktree" },
    });

    expect(tool.description).toContain("forked workspace based on committed state");
    expect(tool.description).toContain("Uncommitted changes from the parent are not available");
  });

  // The advertised inputSchema is the raw (strict) Zod schema. A `.strict()` schema that omits
  // `isolation` rejects the field outright, proving it never enters LLM context for that runtime.
  const parseWithIsolation = (tool: ReturnType<typeof createTaskTool>) =>
    (tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      agentId: "explore",
      prompt: "look",
      title: "Look",
      isolation: "none",
    });

  it("omits the isolation parameter from the schema on local runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-local-isolation-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      muxEnv: { MUX_RUNTIME: "local" },
    });

    expect(parseWithIsolation(tool).success).toBe(false);
  });

  it("advertises the isolation parameter in the schema on worktree runtimes", () => {
    using tempDir = new TestTempDir("test-task-tool-worktree-isolation-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      muxEnv: { MUX_RUNTIME: "worktree" },
    });

    expect(parseWithIsolation(tool).success).toBe(true);
  });

  it("rejects unsupported workspace fork mode in the schema", () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-fork-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      muxEnv: { MUX_RUNTIME: "worktree" },
    });

    const parsed = (
      tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({
      kind: "workspace",
      prompt: "summarize the fork",
      title: "Workspace fork",
      workspace: { mode: "fork" },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects sticky retention for full workspace tasks", () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-sticky-schema");
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path),
      muxEnv: { MUX_RUNTIME: "worktree" },
    });

    const parsed = (
      tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    ).safeParse({
      kind: "workspace",
      prompt: "keep working",
      title: "Persistent workspace",
      sticky: true,
    });

    expect(parsed.success).toBe(false);
  });

  it("uses the strict workspace-only schema and background default in Project Chat", async () => {
    using tempDir = new TestTempDir("test-task-tool-project-chat-schema");
    const createWorkspaceTurn = mock((_args: Parameters<TaskService["createWorkspaceTurn"]>[0]) =>
      Ok({
        taskId: "wst_project-chat-turn",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "project-session_aaaaaaaaaa" }),
      projectChat: true,
      taskService,
    });
    const schema = tool.inputSchema as { safeParse: (value: unknown) => { success: boolean } };

    expect(
      schema.safeParse({ prompt: "implement", title: "Implementation", agentId: "exec" }).success
    ).toBe(false);
    const result: unknown = await Promise.resolve(
      tool.execute!(
        { kind: null, prompt: "implement", title: "Implementation", run_in_background: null },
        mockToolCallOptions
      )
    );

    expect(createWorkspaceTurn).toHaveBeenCalledTimes(1);
    expect(createWorkspaceTurn.mock.calls[0]?.[0]).toMatchObject({
      ownerWorkspaceId: "project-session_aaaaaaaaaa",
      attentionPolicy: "notify_on_terminal",
      workspace: { mode: "new" },
    });
    expect(result).toMatchObject({
      taskId: "wst_project-chat-turn",
      status: "running",
      workspaceId: "child-workspace",
    });
  });

  it("forwards Project Chat workspace runtime and display title overrides", async () => {
    using tempDir = new TestTempDir("test-task-tool-project-chat-runtime");
    const createWorkspaceTurn = mock((_args: Parameters<TaskService["createWorkspaceTurn"]>[0]) =>
      Ok({
        taskId: "wst_project-chat-runtime",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "project-session_aaaaaaaaaa" }),
      projectChat: true,
      taskService,
    });
    const runtimeConfig = {
      type: "ssh" as const,
      host: "devbox",
      srcBaseDir: "~/mux",
      identityFile: "~/.ssh/project",
      port: 2222,
    };

    await Promise.resolve(
      tool.execute!(
        {
          prompt: "implement",
          title: "Task handle",
          workspace: {
            mode: "new",
            projectPath: "/repo/packages/web",
            title: "Workspace display",
            runtimeConfig,
          },
        },
        mockToolCallOptions
      )
    );

    expect(createWorkspaceTurn).toHaveBeenCalledTimes(1);
    expect(createWorkspaceTurn.mock.calls[0]?.[0]).toMatchObject({
      title: "Task handle",
      workspace: {
        mode: "new",
        projectPath: "/repo/packages/web",
        title: "Workspace display",
        runtimeConfig,
      },
    });
  });

  it("strips strict-provider nulls before forwarding Project Chat runtime overrides", async () => {
    using tempDir = new TestTempDir("test-task-tool-project-chat-runtime-nulls");
    const createWorkspaceTurn = mock((_args: Parameters<TaskService["createWorkspaceTurn"]>[0]) =>
      Ok({
        taskId: "wst_project-chat-runtime-nulls",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;
    const tool = createTaskTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "project-session_aaaaaaaaaa" }),
      projectChat: true,
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        {
          prompt: "implement",
          title: "Task handle",
          workspace: {
            mode: "new",
            runtimeConfig: {
              type: "ssh",
              host: "devbox",
              srcBaseDir: "~/mux",
              bgOutputDir: null,
              identityFile: null,
              port: null,
              coder: null,
            },
          },
        },
        mockToolCallOptions
      )
    );

    expect(createWorkspaceTurn.mock.calls[0]?.[0]).toMatchObject({
      workspace: {
        mode: "new",
        runtimeConfig: { type: "ssh", host: "devbox", srcBaseDir: "~/mux" },
      },
    });
    expect(createWorkspaceTurn.mock.calls[0]?.[0].workspace?.runtimeConfig).toEqual({
      type: "ssh",
      host: "devbox",
      srcBaseDir: "~/mux",
    });
  });

  it("forwards grouped Project Chat AI overrides and returns resolved settings", async () => {
    using tempDir = new TestTempDir("test-task-tool-project-chat-ai");
    const createWorkspaceTurn = mock((_args: Parameters<TaskService["createWorkspaceTurn"]>[0]) =>
      Ok({
        taskId: "wst_project-chat-ai",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
        modelString: "openai:gpt-5.6-sol",
        thinkingLevel: "high" as const,
        reasoningMode: "pro" as const,
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;
    const taskTool = createTaskTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "project-session_aaaaaaaaaa" }),
      projectChat: true,
      taskService,
    });

    const result: unknown = await taskTool.execute!(
      {
        prompt: "implement",
        title: "Implementation",
        ai: {
          model: "openai:gpt-5.6-sol",
          thinking: "high",
          reasoningMode: "pro",
        },
      },
      mockToolCallOptions
    );

    expect(createWorkspaceTurn.mock.calls[0]?.[0]).toMatchObject({
      modelString: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
    expect(result).toMatchObject({
      modelString: "openai:gpt-5.6-sol",
      thinkingLevel: "high",
      reasoningMode: "pro",
    });
  });

  it("returns a foreground workspace-turn handle without waiting for terminal output", async () => {
    using tempDir = new TestTempDir("test-task-tool-project-chat-foreground-handle");
    const createWorkspaceTurn = mock((_args: Parameters<TaskService["createWorkspaceTurn"]>[0]) =>
      Ok({
        taskId: "wst_foreground",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const waitForWorkspaceTurn = mock(() =>
      Promise.resolve({ reportMarkdown: "terminal output must come from task_await" })
    );
    const taskService = { createWorkspaceTurn, waitForWorkspaceTurn } as unknown as TaskService;
    const taskTool = createTaskTool({
      ...createTestToolConfig(tempDir.path, { workspaceId: "project-session_aaaaaaaaaa" }),
      projectChat: true,
      taskService,
    });

    const result: unknown = await taskTool.execute!(
      {
        prompt: "create a report",
        title: "Report",
        run_in_background: false,
      },
      mockToolCallOptions
    );

    expect(createWorkspaceTurn).toHaveBeenCalledWith(
      expect.objectContaining({ attentionPolicy: "blocking_until_terminal" })
    );
    expect(waitForWorkspaceTurn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "running",
      taskId: "wst_foreground",
      workspaceId: "child-workspace",
      handleKind: "workspace_turn",
    });
    expect(result).not.toHaveProperty("reportMarkdown");
  });

  it("starts a background workspace turn without requiring a sub-agent id", async () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-turn");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createWorkspaceTurn = mock(() =>
      Ok({
        taskId: "exe_child-turn",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const create = mock(() => Err("sub-agent path should not be used"));
    const waitForWorkspaceTurn = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = {
      create,
      createWorkspaceTurn,
      waitForWorkspaceTurn,
    } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      muxEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "high" },
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          kind: "workspace",
          prompt: "summarize the repository",
          title: "Repository summary",
          run_in_background: true,
        },
        mockToolCallOptions
      )
    );

    expect(create).not.toHaveBeenCalled();
    expect(waitForWorkspaceTurn).not.toHaveBeenCalled();
    expect(createWorkspaceTurn).toHaveBeenCalledTimes(1);
    const createWorkspaceTurnCall = createWorkspaceTurn.mock.calls[0] as unknown[];
    expect(createWorkspaceTurnCall[0]).toMatchObject({
      ownerWorkspaceId: "parent-workspace",
      prompt: "summarize the repository",
      title: "Repository summary",
      parentRuntimeAiSettings: { modelString: "openai:gpt-4o-mini", thinkingLevel: "high" },
      workspace: { mode: "new" },
    });
    expect(result).toMatchObject({
      status: "running",
      taskId: "exe_child-turn",
      workspaceId: "child-workspace",
      handleKind: "workspace_turn",
    });
  });

  it("forwards workspace turn queue dispatch mode", async () => {
    using tempDir = new TestTempDir("test-task-tool-workspace-turn-queue-mode");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createWorkspaceTurn = mock(() =>
      Ok({
        taskId: "wst_child-turn",
        kind: "workspace_turn" as const,
        status: "queued" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;
    const tool = createTaskTool({ ...baseConfig, taskService });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          kind: "workspace",
          prompt: "follow up",
          title: "Follow-up",
          run_in_background: true,
          workspace: {
            mode: "existing",
            workspaceId: "child-workspace",
            queueDispatchMode: "turn-end",
          },
        },
        mockToolCallOptions
      )
    );

    expect(createWorkspaceTurn).toHaveBeenCalledTimes(1);
    const createWorkspaceTurnCall = createWorkspaceTurn.mock.calls[0] as unknown[];
    expect(createWorkspaceTurnCall[0]).toMatchObject({
      ownerWorkspaceId: "parent-workspace",
      workspace: {
        mode: "existing",
        workspaceId: "child-workspace",
        queueDispatchMode: "turn-end",
      },
    });
    expect(result).toMatchObject({
      status: "queued",
      taskId: "wst_child-turn",
      workspaceId: "child-workspace",
      handleKind: "workspace_turn",
    });
  });

  it("forwards isolation to taskService.create", async () => {
    using tempDir = new TestTempDir("test-task-tool-isolation-passthrough");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock((_: { isolation?: unknown }) =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      muxEnv: { MUX_RUNTIME: "worktree" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "read-only look",
          title: "Child task",
          run_in_background: true,
          isolation: "none",
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.isolation).toBe("none");
  });

  it("omits isolation from taskService.create when not provided", async () => {
    using tempDir = new TestTempDir("test-task-tool-isolation-default");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock((_: { isolation?: unknown }) =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      muxEnv: { MUX_RUNTIME: "worktree" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", title: "Child task", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.isolation).toBeUndefined();
  });

  it("forwards explicit sticky retention to taskService.create", async () => {
    using tempDir = new TestTempDir("test-task-tool-sticky-passthrough");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock((_: { sticky?: unknown }) =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;
    const tool = createTaskTool({ ...baseConfig, taskService });

    await Promise.resolve(
      tool.execute!(
        {
          agentId: "exec",
          prompt: "own the separate PR",
          title: "PR owner",
          run_in_background: true,
          sticky: true,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]?.sticky).toBe(true);
  });

  it("should return opaque task and explicit workspace ids in background", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({
        taskId: "exe_child",
        workspaceId: "child-workspace",
        kind: "agent" as const,
        status: "queued" as const,
      })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      muxEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "high" },
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", title: "Child task", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expectQueuedOrRunningTaskToolResult(result, {
      status: "queued",
      taskId: "exe_child",
      workspaceId: "child-workspace",
    });
  });

  it("passes parent MUX_MODEL_STRING/MUX_THINKING_LEVEL as a runtime fallback hint", async () => {
    using tempDir = new TestTempDir("test-task-tool-parent-ai-env");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(
      (_: {
        modelString?: unknown;
        thinkingLevel?: unknown;
        parentRuntimeAiSettings?: { modelString?: unknown; thinkingLevel?: unknown };
      }) => Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      muxEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "med" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        { subagent_type: "explore", prompt: "do it", title: "Child task", run_in_background: true },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0]?.[0];
    expect(createArgs).toBeDefined();
    expect(createArgs?.modelString).toBeUndefined();
    expect(createArgs?.thinkingLevel).toBeUndefined();
    expect(createArgs?.parentRuntimeAiSettings).toEqual({
      modelString: "openai:gpt-4o-mini",
      thinkingLevel: "medium",
    });
  });

  it("forwards a model alias and named thinking override to taskService.create", async () => {
    using tempDir = new TestTempDir("test-task-tool-model-thinking-override");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(
      (_: {
        modelString?: unknown;
        thinkingLevel?: unknown;
        parentRuntimeAiSettings?: { modelString?: unknown; thinkingLevel?: unknown };
      }) => Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      muxEnv: { MUX_MODEL_STRING: "openai:gpt-4o-mini", MUX_THINKING_LEVEL: "low" },
      taskService,
    });

    await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: true,
          // "sonnet" is an alias; the handler must resolve it like the UI does.
          model: "sonnet",
          thinking: "high",
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0]?.[0];
    expect(createArgs?.modelString).toBe("anthropic:claude-sonnet-5");
    expect(createArgs?.thinkingLevel).toBe("high");
    // Parent runtime hint is still forwarded so unspecified fields keep inheriting.
    expect(createArgs?.parentRuntimeAiSettings).toEqual({
      modelString: "openai:gpt-4o-mini",
      thinkingLevel: "low",
    });
  });

  it("forwards a numeric thinking override as a deferred index", async () => {
    using tempDir = new TestTempDir("test-task-tool-numeric-thinking");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock((_: { thinkingLevel?: unknown }) =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({ ...baseConfig, taskService });

    await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Child task",
          run_in_background: true,
          // Numeric indices stay deferred (resolved against the model in taskService).
          thinking: "2",
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(1);
    const createArgs = create.mock.calls[0]?.[0];
    expect(createArgs?.thinkingLevel).toBe(2);
  });

  it("rejects an invalid model override before spawning a task", async () => {
    using tempDir = new TestTempDir("test-task-tool-invalid-model");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "queued" as const })
    );
    const taskService = { create } as unknown as TaskService;

    const tool = createTaskTool({ ...baseConfig, taskService });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          {
            subagent_type: "explore",
            prompt: "do it",
            title: "Child task",
            run_in_background: true,
            model: "definitely-not-a-model",
          },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/invalid model/i);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("spawns best-of-n background tasks with shared grouping metadata", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-background");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createArgs: Array<{
      bestOf?: { groupId: string; index: number; total: number };
    }> = [];
    let createCount = 0;
    const create = mock((args: { bestOf?: { groupId: string; index: number; total: number } }) => {
      createArgs.push(args);
      createCount += 1;
      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare three approaches",
          title: "Best of 3",
          run_in_background: true,
          n: 3,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(3);
    expectGroupedQueuedOrRunningTaskToolResult(result, {
      status: "running",
      taskIds: ["child-task-1", "child-task-2", "child-task-3"],
    });

    const bestOfGroups = createArgs.map((args) => args.bestOf);
    expect(bestOfGroups).toHaveLength(3);
    expect(bestOfGroups[0]).toMatchObject({ index: 0, total: 3 });
    expect(bestOfGroups[1]).toMatchObject({ index: 1, total: 3 });
    expect(bestOfGroups[2]).toMatchObject({ index: 2, total: 3 });
    expect(typeof bestOfGroups[0]?.groupId).toBe("string");
    expect(bestOfGroups[0]?.groupId).toBe(bestOfGroups[1]?.groupId);
    expect(bestOfGroups[1]?.groupId).toBe(bestOfGroups[2]?.groupId);
  });

  it("spawns variants with per-variant prompts and labels", async () => {
    using tempDir = new TestTempDir("test-task-tool-variants-background");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createArgs: Array<{
      prompt: string;
      bestOf?: {
        groupId: string;
        index: number;
        total: number;
        kind?: string;
        label?: string;
      };
    }> = [];
    let createCount = 0;
    const create = mock(
      (args: {
        prompt: string;
        bestOf?: {
          groupId: string;
          index: number;
          total: number;
          kind?: string;
          label?: string;
        };
      }) => {
        createArgs.push(args);
        createCount += 1;
        return Ok({
          taskId: `child-task-${createCount}`,
          kind: "agent" as const,
          status: "running" as const,
        });
      }
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          agentId: "explore",
          prompt: "Review ${variant} for regressions in ${variant}",
          title: "Split review",
          run_in_background: true,
          variants: ["frontend", "backend"],
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(createArgs.map((args) => args.prompt)).toEqual([
      "Review frontend for regressions in frontend",
      "Review backend for regressions in backend",
    ]);
    const variantGroupId = createArgs[0]?.bestOf?.groupId;
    expect(typeof variantGroupId).toBe("string");
    expect(createArgs[0]?.bestOf).toMatchObject({
      groupId: variantGroupId,
      index: 0,
      total: 2,
      kind: "variants",
      label: "frontend",
    });
    expect(createArgs[1]?.bestOf).toMatchObject({
      groupId: variantGroupId,
      index: 1,
      total: 2,
      kind: "variants",
      label: "backend",
    });
    expectGroupedQueuedOrRunningTaskToolResult(result, {
      status: "running",
      taskIds: ["child-task-1", "child-task-2"],
    });
    const obj = result as {
      tasks?: Array<{ taskId: string; status: string; groupKind?: string; label?: string }>;
    };
    expect(obj.tasks).toEqual([
      {
        taskId: "child-task-1",
        status: "running",
        groupKind: "variants",
        label: "frontend",
      },
      {
        taskId: "child-task-2",
        status: "running",
        groupKind: "variants",
        label: "backend",
      },
    ]);
  });

  it("keeps grouped metadata when best-of task creation fails after only one candidate", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-single-partial-failure");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let createCount = 0;
    const create = mock(() => {
      createCount += 1;
      if (createCount === 2) {
        return Err("workspace creation failed");
      }

      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare two approaches",
          title: "Best of 2",
          run_in_background: false,
          n: 2,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(2);
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    const obj = result as Record<string, unknown>;
    expect(obj.status).toBe("running");
    expect(obj.taskIds).toEqual(["child-task-1"]);
    expect(obj.tasks).toMatchObject([{ taskId: "child-task-1", status: "running" }]);
    expect(typeof obj.note).toBe("string");
  });

  it("returns partial spawn metadata when best-of task creation fails mid-batch", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-partial-failure");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let createCount = 0;
    const create = mock(() => {
      createCount += 1;
      if (createCount === 3) {
        return Err("workspace creation failed");
      }

      return Ok({
        taskId: `child-task-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "compare three approaches",
          title: "Best of 3",
          run_in_background: false,
          n: 3,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledTimes(3);
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expect(result).toBeTruthy();
    expect(typeof result).toBe("object");
    expect(result).not.toBeNull();

    const obj = result as Record<string, unknown>;
    expect(obj.status).toBe("running");
    expect(obj.taskIds).toEqual(["child-task-1", "child-task-2"]);
    expect(obj.tasks).toMatchObject([
      { taskId: "child-task-1", status: "running" },
      { taskId: "child-task-2", status: "running" },
    ]);
    expect(typeof obj.note).toBe("string");
  });

  it("returns all best-of handles without waiting when blocking attention is requested", async () => {
    using tempDir = new TestTempDir("test-task-tool-best-of-foreground-handles");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    let createCount = 0;
    const create = mock((_args: Parameters<TaskService["create"]>[0]) => {
      createCount += 1;
      return Ok({
        taskId: `child-task-${createCount}`,
        workspaceId: `child-workspace-${createCount}`,
        kind: "agent" as const,
        status: "running" as const,
      });
    });
    const waitForAgentReport = mock(() =>
      Promise.resolve({ reportMarkdown: "terminal output must come from task_await" })
    );
    const taskService = { create, waitForAgentReport } as unknown as TaskService;
    const tool = createTaskTool({ ...baseConfig, taskService });

    const result: unknown = await tool.execute!(
      {
        subagent_type: "explore",
        prompt: "compare two approaches",
        title: "Best of 2",
        run_in_background: false,
        n: 2,
      },
      mockToolCallOptions
    );

    expect(create).toHaveBeenCalledTimes(2);
    for (const call of create.mock.calls) {
      expect(call[0]).toMatchObject({ attentionPolicy: "blocking_until_terminal" });
    }
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "running",
      taskIds: ["child-task-1", "child-task-2"],
      tasks: [
        { taskId: "child-task-1", workspaceId: "child-workspace-1", groupKind: "bestOf" },
        { taskId: "child-task-2", workspaceId: "child-workspace-2", groupKind: "bestOf" },
      ],
    });
    expect(result).not.toHaveProperty("reports");
  });

  it("should allow sub-agent workspaces to spawn nested tasks", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "child-workspace" });

    const create = mock(() =>
      Ok({ taskId: "grandchild-task", kind: "agent" as const, status: "queued" as const })
    );
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      enableAgentReport: true,
      taskService,
    });

    const result: unknown = await Promise.resolve(
      tool.execute!(
        {
          subagent_type: "explore",
          prompt: "do it",
          title: "Grandchild task",
          run_in_background: true,
        },
        mockToolCallOptions
      )
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentWorkspaceId: "child-workspace",
        kind: "agent",
        agentId: "explore",
        agentType: "explore",
      })
    );
    expectQueuedOrRunningTaskToolResult(result, { status: "queued", taskId: "grandchild-task" });
  });

  it("uses blocking attention and returns a handle when run_in_background is null", async () => {
    using tempDir = new TestTempDir("test-task-tool-null-background");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const events: TaskCreatedEvent[] = [];
    const create = mock((_args: Parameters<TaskService["create"]>[0]) =>
      Ok({
        taskId: "exe_child",
        workspaceId: "child-workspace",
        kind: "agent" as const,
        status: "running" as const,
      })
    );
    const waitForAgentReport = mock(() =>
      Promise.resolve({ reportMarkdown: "terminal output must come from task_await" })
    );
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      emitChatEvent: (event) => {
        if (event.type === "task-created") events.push(event);
      },
      taskService,
    });

    const result: unknown = await tool.execute!(
      {
        subagent_type: "explore",
        prompt: "do it",
        title: "Child task",
        run_in_background: null,
      },
      mockToolCallOptions
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ attentionPolicy: "blocking_until_terminal" })
    );
    expect(waitForAgentReport).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "task-created",
      workspaceId: "parent-workspace",
      toolCallId: mockToolCallOptions.toolCallId,
      taskId: "exe_child",
      taskWorkspaceId: "child-workspace",
    });
    expect(result).toMatchObject({
      status: "running",
      taskId: "exe_child",
      workspaceId: "child-workspace",
    });
    expect(result).not.toHaveProperty("reportMarkdown");
  });

  it("should throw when TaskService.create fails (e.g., depth limit)", async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() => Err("maxTaskNestingDepth exceeded"));
    const waitForAgentReport = mock(() => Promise.resolve({ reportMarkdown: "ignored" }));
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { subagent_type: "explore", prompt: "do it", title: "Child task" },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/maxTaskNestingDepth/i);
    }
  });

  it("should reject workspace turns while in plan agent", async () => {
    using tempDir = new TestTempDir("test-task-tool-plan-workspace");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const createWorkspaceTurn = mock(() =>
      Ok({
        taskId: "wst_child-turn",
        kind: "workspace_turn" as const,
        status: "running" as const,
        workspaceId: "child-workspace",
      })
    );
    const taskService = { createWorkspaceTurn } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      planFileOnly: true,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          {
            kind: "workspace",
            prompt: "implement it",
            title: "Workspace turn",
            run_in_background: true,
          },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/plan agent/i);
    }
    expect(createWorkspaceTurn).not.toHaveBeenCalled();
  });

  it('should reject spawning "exec" tasks while in plan agent', async () => {
    using tempDir = new TestTempDir("test-task-tool");
    const baseConfig = createTestToolConfig(tempDir.path, { workspaceId: "parent-workspace" });

    const create = mock(() =>
      Ok({ taskId: "child-task", kind: "agent" as const, status: "running" as const })
    );
    const waitForAgentReport = mock(() =>
      Promise.resolve({
        reportMarkdown: "Hello from child",
        title: "Result",
      })
    );
    const taskService = { create, waitForAgentReport } as unknown as TaskService;

    const tool = createTaskTool({
      ...baseConfig,
      planFileOnly: true,
      taskService,
    });

    let caught: unknown = null;
    try {
      await Promise.resolve(
        tool.execute!(
          { subagent_type: "exec", prompt: "do it", title: "Child task" },
          mockToolCallOptions
        )
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    if (caught instanceof Error) {
      expect(caught.message).toMatch(/plan agent/i);
    }
    expect(create).not.toHaveBeenCalled();
    expect(waitForAgentReport).not.toHaveBeenCalled();
  });
});

describe("built-in task marker", () => {
  function makeTool() {
    return tool({
      description: "task",
      inputSchema: z.object({ prompt: z.string() }),
      execute: () => Promise.resolve("ok"),
    });
  }

  it("marks and recognizes the built-in task tool", () => {
    const t = makeTool();
    expect(isBuiltInTaskTool(t)).toBe(false);
    markBuiltInTaskTool(t);
    expect(isBuiltInTaskTool(t)).toBe(true);
  });
});
