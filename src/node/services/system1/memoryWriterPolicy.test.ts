import { DEFAULT_TASK_SETTINGS } from "@/common/types/tasks";
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
  it("runs every N assistant turns", async () => {
    let getHistoryCalls = 0;
    let createModelCalls = 0;

    const policy = new MemoryWriterPolicy(
      {
        loadConfigOrDefault: () => ({
          projects: new Map(),
          taskSettings: { ...DEFAULT_TASK_SETTINGS, memoryWriterIntervalMessages: 2 },
        }),
      },
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

    const first = policy.onAssistantStreamEnd(createContext({ messageId: "msg_1" }));
    expect(first).toBeUndefined();
    expect(getHistoryCalls).toBe(0);

    const second = policy.onAssistantStreamEnd(createContext({ messageId: "msg_2" }));
    expect(second).toBeDefined();
    await second;

    expect(getHistoryCalls).toBe(1);
    expect(createModelCalls).toBe(1);
  });

  it("dedupes while a run is in-flight", async () => {
    let resolveHistory!: () => void;
    const historyBarrier = new Promise<void>((resolve) => {
      resolveHistory = () => resolve();
    });

    let getHistoryCalls = 0;

    const policy = new MemoryWriterPolicy(
      {
        loadConfigOrDefault: () => ({
          projects: new Map(),
          taskSettings: { ...DEFAULT_TASK_SETTINGS, memoryWriterIntervalMessages: 1 },
        }),
      },
      {
        getHistory: async (): Promise<
          { success: true; data: MuxMessage[] } | { success: false; error: string }
        > => {
          getHistoryCalls += 1;

          if (getHistoryCalls === 1) {
            await historyBarrier;
          }

          return { success: true, data: [] };
        },
      },
      () => Promise.resolve(undefined)
    );

    const first = policy.onAssistantStreamEnd(createContext({ messageId: "msg_1" }));
    expect(first).toBeDefined();

    // Allow the async runner to reach getHistory.
    await Promise.resolve();
    expect(getHistoryCalls).toBe(1);

    const second = policy.onAssistantStreamEnd(createContext({ messageId: "msg_2" }));
    expect(second).toBeUndefined();

    expect(getHistoryCalls).toBe(1);

    resolveHistory();
    await first;

    const third = policy.onAssistantStreamEnd(createContext({ messageId: "msg_3" }));
    expect(third).toBeDefined();
    await third;

    expect(getHistoryCalls).toBe(2);
  });

  it("skips when System1 is disabled", () => {
    let getHistoryCalls = 0;

    const policy = new MemoryWriterPolicy(
      {
        loadConfigOrDefault: () => ({
          projects: new Map(),
          taskSettings: { ...DEFAULT_TASK_SETTINGS, memoryWriterIntervalMessages: 1 },
        }),
      },
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

    const result = policy.onAssistantStreamEnd(createContext({ system1Enabled: false }));
    expect(result).toBeUndefined();
    expect(getHistoryCalls).toBe(0);
  });
});
