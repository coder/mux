import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "bun:test";

import type { MuxMessage } from "@/common/types/message";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import type { RuntimeConfig } from "@/common/types/runtime";

import { MemoryWriterPolicy, type MemoryWriterStreamContext } from "./memoryWriterPolicy";

function createContext(overrides?: Partial<MemoryWriterStreamContext>): MemoryWriterStreamContext {
  const runtimeConfig = { type: "local", srcBaseDir: "/tmp" } as unknown as RuntimeConfig;

  return {
    workspaceId: "ws_1",
    messageId: "msg_1",
    workspaceName: "main",
    projectPath: "/tmp/project",
    runtimeConfig,
    modelString: "openai:gpt-5.1-codex-mini",
    muxProviderOptions: {} as unknown as MuxProviderOptions,
    system1Enabled: true,
    ...overrides,
  };
}

describe("MemoryWriterPolicy", () => {
  const MEMORY_WRITER_STATE_FILE_NAME = "system1-memory-writer-state.json";

  async function withTempSessionsDir(fn: (sessionsDir: string) => Promise<void>): Promise<void> {
    const sessionsDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-memory-writer-sessions-"));

    try {
      await fn(sessionsDir);
    } finally {
      await fs.rm(sessionsDir, { recursive: true, force: true });
    }
  }

  function createTestConfig(params: {
    sessionsDir: string;
    interval: number;
    configOverrides?: Record<string, unknown>;
  }) {
    return {
      getSessionDir: (workspaceId: string) => path.join(params.sessionsDir, workspaceId),
      loadConfigOrDefault: () => ({
        projects: new Map(),
        taskSettings: { ...DEFAULT_TASK_SETTINGS, memoryWriterIntervalMessages: params.interval },
        ...(params.configOverrides ?? {}),
      }),
      loadProvidersConfig: () => null,
    };
  }

  it("runs every N assistant turns", async () => {
    await withTempSessionsDir(async (sessionsDir) => {
      let getHistoryCalls = 0;
      let createModelCalls = 0;

      const policy = new MemoryWriterPolicy(
        createTestConfig({ sessionsDir, interval: 2 }),
        {
          getHistory: (): Promise<
            { success: true; data: MuxMessage[] } | { success: false; error: string }
          > => {
            getHistoryCalls += 1;
            return Promise.resolve({ success: true, data: [] });
          },
        },
        () => {
          createModelCalls += 1;
          return Promise.resolve(undefined);
        }
      );

      await policy.onAssistantStreamEnd(createContext({ messageId: "msg_1" }));
      expect(getHistoryCalls).toBe(0);

      await policy.onAssistantStreamEnd(createContext({ messageId: "msg_2" }));
      expect(getHistoryCalls).toBe(1);
      expect(createModelCalls).toBe(1);
    });
  });

  it("persists scheduling state across restarts", async () => {
    await withTempSessionsDir(async (sessionsDir) => {
      let getHistoryCalls = 0;

      const historyService = {
        getHistory: (): Promise<
          { success: true; data: MuxMessage[] } | { success: false; error: string }
        > => {
          getHistoryCalls += 1;
          return Promise.resolve({ success: true, data: [] });
        },
      };

      const config = createTestConfig({ sessionsDir, interval: 2 });

      const policy1 = new MemoryWriterPolicy(config, historyService, () =>
        Promise.resolve(undefined)
      );
      await policy1.onAssistantStreamEnd(createContext({ messageId: "msg_1" }));
      expect(getHistoryCalls).toBe(0);

      const statePath = path.join(sessionsDir, "ws_1", MEMORY_WRITER_STATE_FILE_NAME);
      const state1 = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        turnsSinceLastRun?: unknown;
      };
      expect(state1.turnsSinceLastRun).toBe(1);

      // Simulate app restart by constructing a new policy instance.
      const policy2 = new MemoryWriterPolicy(config, historyService, () =>
        Promise.resolve(undefined)
      );
      await policy2.onAssistantStreamEnd(createContext({ messageId: "msg_2" }));
      expect(getHistoryCalls).toBe(1);

      const state2 = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        lastRunCompletedAt?: unknown;
      };
      expect(typeof state2.lastRunCompletedAt).toBe("number");
    });
  });

  it("treats an incomplete run as a crash and runs on the next turn", async () => {
    await withTempSessionsDir(async (sessionsDir) => {
      const statePath = path.join(sessionsDir, "ws_1", MEMORY_WRITER_STATE_FILE_NAME);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(
        statePath,
        JSON.stringify(
          {
            schemaVersion: 1,
            turnsSinceLastRun: 0,
            lastRunStartedAt: Date.now(),
          },
          null,
          2
        ),
        "utf8"
      );

      let getHistoryCalls = 0;

      const policy = new MemoryWriterPolicy(
        createTestConfig({ sessionsDir, interval: 5 }),
        {
          getHistory: (): Promise<
            { success: true; data: MuxMessage[] } | { success: false; error: string }
          > => {
            getHistoryCalls += 1;
            return Promise.resolve({ success: true, data: [] });
          },
        },
        () => Promise.resolve(undefined)
      );

      await policy.onAssistantStreamEnd(createContext({ messageId: "msg_1" }));
      expect(getHistoryCalls).toBe(1);

      const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
        lastRunCompletedAt?: unknown;
      };
      expect(typeof state.lastRunCompletedAt).toBe("number");
    });
  });

  it("dedupes while a run is in-flight", async () => {
    await withTempSessionsDir(async (sessionsDir) => {
      let resolveHistory!: () => void;
      const historyBarrier = new Promise<void>((resolve) => {
        resolveHistory = () => resolve();
      });

      let resolveHistoryCalled!: () => void;
      const historyCalled = new Promise<void>((resolve) => {
        resolveHistoryCalled = () => resolve();
      });

      let getHistoryCalls = 0;

      const policy = new MemoryWriterPolicy(
        createTestConfig({ sessionsDir, interval: 1 }),
        {
          getHistory: async (): Promise<
            { success: true; data: MuxMessage[] } | { success: false; error: string }
          > => {
            getHistoryCalls += 1;

            if (getHistoryCalls === 1) {
              resolveHistoryCalled();
              await historyBarrier;
            }

            return { success: true, data: [] };
          },
        },
        () => Promise.resolve(undefined)
      );

      const first = policy.onAssistantStreamEnd(createContext({ messageId: "msg_1" }));

      await historyCalled;
      expect(getHistoryCalls).toBe(1);

      await policy.onAssistantStreamEnd(createContext({ messageId: "msg_2" }));
      expect(getHistoryCalls).toBe(1);

      resolveHistory();
      await first;

      await policy.onAssistantStreamEnd(createContext({ messageId: "msg_3" }));
      expect(getHistoryCalls).toBe(2);
    });
  });

  it("uses agentAiDefaults.system1_memory_writer model overrides", async () => {
    await withTempSessionsDir(async (sessionsDir) => {
      let lastModelString: string | undefined;

      const policy = new MemoryWriterPolicy(
        createTestConfig({
          sessionsDir,
          interval: 1,
          configOverrides: {
            agentAiDefaults: {
              system1_memory_writer: {
                modelString: "google:gemini-3-flash-preview",
                thinkingLevel: "high",
              },
            },
          },
        }),
        {
          getHistory: (): Promise<
            { success: true; data: MuxMessage[] } | { success: false; error: string }
          > => Promise.resolve({ success: true, data: [] }),
        },
        (modelString) => {
          lastModelString = modelString;
          return Promise.resolve(undefined);
        }
      );

      await policy.onAssistantStreamEnd(
        createContext({ messageId: "msg_1", modelString: "openai:gpt-5.1-codex-mini" })
      );

      expect(lastModelString).toBe("google:gemini-3-flash-preview");
    });
  });

  it("skips when System1 is disabled", async () => {
    await withTempSessionsDir(async (sessionsDir) => {
      let getHistoryCalls = 0;

      const policy = new MemoryWriterPolicy(
        createTestConfig({ sessionsDir, interval: 1 }),
        {
          getHistory: (): Promise<
            { success: true; data: MuxMessage[] } | { success: false; error: string }
          > => {
            getHistoryCalls += 1;
            return Promise.resolve({ success: true, data: [] });
          },
        },
        () => Promise.resolve(undefined)
      );

      await policy.onAssistantStreamEnd(createContext({ system1Enabled: false }));
      expect(getHistoryCalls).toBe(0);
    });
  });
});
