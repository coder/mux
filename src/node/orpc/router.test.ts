import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { Config } from "@/node/config";
import type { ORPCContext } from "./context";
import { router } from "./router";

describe("router workspace goal validation", () => {
  test("goal routes do not touch goal files for unknown workspaces", async () => {
    const getGoal = mock(() => Promise.resolve({ goalId: "should-not-read" }));
    const clearGoal = mock(() => Promise.resolve({ goalId: "should-not-clear" }));
    const setGoal = mock(() =>
      Promise.resolve({ success: true, data: { goalId: "should-not-set" } })
    );
    const context = {
      workspaceService: {
        getInfo: mock(() => Promise.resolve(null)),
      },
      workspaceGoalService: {
        getGoal,
        clearGoal,
        setGoal,
      },
    } as unknown as ORPCContext;
    const client = createRouterClient(router(), { context });

    const goalResult = await Promise.resolve(
      client.workspace.getGoal({ workspaceId: "../../tmp/not-a-workspace" })
    );
    expect(goalResult).toEqual({ goal: null });
    const clearResult = await Promise.resolve(
      client.workspace.clearGoal({ workspaceId: "../../tmp/not-a-workspace" })
    );
    expect(clearResult).toEqual({ cleared: false });
    const setResult = await Promise.resolve(
      client.workspace.setGoal({
        workspaceId: "../../tmp/not-a-workspace",
        objective: "do not write",
      })
    );
    expect(setResult).toEqual({
      success: false,
      error: { type: "invalid_transition", message: "Workspace not found." },
    });

    expect(getGoal).not.toHaveBeenCalled();
    expect(setGoal).not.toHaveBeenCalled();
    expect(clearGoal).not.toHaveBeenCalled();
  });
});

describe("router config.saveConfig", () => {
  let tempDir: string;
  let config: Config;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mux-router-test-"));
    config = new Config(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createContext(): ORPCContext {
    // saveConfig only touches Config and TaskService, so this partial context keeps the
    // router-level test focused on the config mutation under test.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Other services are not used by saveConfig.
    return {
      config,
      taskService: {
        maybeStartQueuedTasks: () => Promise.resolve(undefined),
      },
    } as ORPCContext;
  }

  test("preserves agent enable flags when a mirrored legacy subagent entry is removed", async () => {
    await config.editConfig((current) => ({
      ...current,
      agentAiDefaults: {
        foo: {
          modelString: "anthropic:claude-3-5-sonnet",
          thinkingLevel: "high",
          enabled: true,
          advisorEnabled: true,
        },
      },
      subagentAiDefaults: {
        foo: {
          modelString: "anthropic:claude-3-5-sonnet",
          thinkingLevel: "high",
        },
      },
    }));

    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      taskSettings: DEFAULT_TASK_SETTINGS,
      subagentAiDefaults: {},
    });

    const saved = config.loadConfigOrDefault();

    expect(saved.agentAiDefaults?.foo?.modelString).toBeUndefined();
    expect(saved.agentAiDefaults?.foo?.thinkingLevel).toBeUndefined();
    expect(saved.agentAiDefaults?.foo?.enabled).toBe(true);
    expect(saved.agentAiDefaults?.foo?.advisorEnabled).toBe(true);
    expect(saved.subagentAiDefaults?.foo).toBeUndefined();
  });

  test("persists the full-width chat transcript config flag", async () => {
    const client = createRouterClient(router(), { context: createContext() });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);

    await client.config.updateChatTranscriptFullWidth({ enabled: true });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(true);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBe(true);

    await client.config.updateChatTranscriptFullWidth({ enabled: false });

    expect((await client.config.getConfig()).chatTranscriptFullWidth).toBe(false);
    expect(config.loadConfigOrDefault().chatTranscriptFullWidth).toBeUndefined();
  });

  test("preserves optional task settings when a save omits them", async () => {
    await config.editConfig((current) => ({
      ...current,
      taskSettings: {
        ...DEFAULT_TASK_SETTINGS,
        preserveSubagentsUntilArchive: true,
        proposePlanImplementReplacesChatHistory: true,
      },
    }));

    const client = createRouterClient(router(), { context: createContext() });

    await client.config.saveConfig({
      // Simulate an older/unrelated settings client that only sends the originally required
      // task limits. Optional task flags must stay sticky, or the sub-agent preservation toggle
      // silently turns itself off before cleanup evaluates it.
      taskSettings: {
        maxParallelAgentTasks: 4,
        maxTaskNestingDepth: 5,
      },
      advisorModelString: null,
    });

    const saved = config.loadConfigOrDefault();
    const savedTaskSettings = saved.taskSettings;
    if (!savedTaskSettings) {
      throw new Error("Expected saved task settings");
    }

    expect(savedTaskSettings.maxParallelAgentTasks).toBe(4);
    expect(savedTaskSettings.maxTaskNestingDepth).toBe(5);
    expect(savedTaskSettings.preserveSubagentsUntilArchive).toBe(true);
    expect(savedTaskSettings.proposePlanImplementReplacesChatHistory).toBe(true);
  });
});
