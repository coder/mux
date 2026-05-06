import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRouterClient } from "@orpc/server";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import { Config } from "@/node/config";
import type { ORPCContext } from "./context";
import { router } from "./router";

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
