import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { ExtensionMetadataService } from "./ExtensionMetadataService";
import type { ExtensionMetadataFile } from "@/node/utils/extensionMetadata";

const PREFIX = "mux-extension-metadata-test-";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface ExtensionMetadataServiceInternals {
  load: () => Promise<ExtensionMetadataFile>;
}

const addLoadDelay = (target: ExtensionMetadataService, delayMs: number): (() => void) => {
  const internals = target as unknown as ExtensionMetadataServiceInternals;
  const originalLoad = internals.load.bind(target);

  internals.load = async () => {
    const data = await originalLoad();
    await sleep(delayMs);
    return data;
  };

  return () => {
    internals.load = originalLoad;
  };
};

describe("ExtensionMetadataService", () => {
  let tempDir: string;
  let filePath: string;
  let service: ExtensionMetadataService;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), PREFIX));
    filePath = path.join(tempDir, "extensionMetadata.json");
    service = new ExtensionMetadataService(filePath);
    await service.initialize();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("updateRecency persists timestamp and getAllSnapshots mirrors it", async () => {
    const snapshot = await service.updateRecency("workspace-1", 123);
    expect(snapshot.recency).toBe(123);
    expect(snapshot.streaming).toBe(false);
    expect(snapshot.lastModel).toBeNull();
    expect(snapshot.lastThinkingLevel).toBeNull();
    expect(snapshot.agentStatus).toBeNull();

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-1")).toEqual(snapshot);
  });

  test("setAgentStatus persists status_set payload", async () => {
    const status = { emoji: "🔧", message: "Applying patch", url: "https://example.com/pr/123" };

    const snapshot = await service.setAgentStatus("workspace-3", status);
    expect(snapshot.agentStatus).toEqual(status);

    const withoutUrl = await service.setAgentStatus("workspace-3", {
      emoji: "✅",
      message: "Checks passed",
    });
    // status_set often omits url after the first call; keep the last known URL.
    expect(withoutUrl.agentStatus).toEqual({
      emoji: "✅",
      message: "Checks passed",
      url: status.url,
    });

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-3")?.agentStatus).toEqual(withoutUrl.agentStatus);

    const cleared = await service.setAgentStatus("workspace-3", null);
    expect(cleared.agentStatus).toBeNull();

    const afterClearWithoutUrl = await service.setAgentStatus("workspace-3", {
      emoji: "🧪",
      message: "Re-running",
    });
    expect(afterClearWithoutUrl.agentStatus).toEqual({
      emoji: "🧪",
      message: "Re-running",
      url: status.url,
    });
  });

  test("concurrent cross-workspace mutations preserve both workspace entries", async () => {
    const restoreLoad = addLoadDelay(service, 20);
    try {
      await Promise.all([
        service.updateRecency("ws-A", 100),
        service.setStreaming("ws-B", true, "anthropic/sonnet", "medium"),
      ]);
    } finally {
      restoreLoad();
    }

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.size).toBe(2);

    const workspaceA = snapshots.get("ws-A");
    expect(workspaceA).not.toBeUndefined();
    expect(workspaceA?.recency).toBe(100);
    expect(workspaceA?.streaming).toBe(false);

    const workspaceB = snapshots.get("ws-B");
    expect(workspaceB).not.toBeUndefined();
    expect(workspaceB?.streaming).toBe(true);
    expect(workspaceB?.lastModel).toBe("anthropic/sonnet");
    expect(workspaceB?.lastThinkingLevel).toBe("medium");
  });

  test("serializes many concurrent cross-workspace mutations without clobbering", async () => {
    const restoreLoad = addLoadDelay(service, 20);
    try {
      await Promise.all([
        service.updateRecency("ws-1", 101),
        service.setStreaming("ws-2", true, "anthropic/sonnet"),
        service.setAgentStatus("ws-3", { emoji: "⚙️", message: "Working" }),
        service.updateRecency("ws-4", 404),
        service.setStreaming("ws-5", false),
        service.setAgentStatus("ws-6", null),
        service.updateRecency("ws-7", 707),
        service.setStreaming("ws-8", true, "openai/gpt-5", "high"),
      ]);
    } finally {
      restoreLoad();
    }

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.size).toBe(8);
    expect(snapshots.get("ws-1")?.recency).toBe(101);
    expect(snapshots.get("ws-2")?.lastModel).toBe("anthropic/sonnet");
    expect(snapshots.get("ws-3")?.agentStatus).toEqual({ emoji: "⚙️", message: "Working" });
    expect(snapshots.get("ws-4")?.recency).toBe(404);
    expect(snapshots.get("ws-5")?.streaming).toBe(false);
    expect(snapshots.get("ws-6")?.agentStatus).toBeNull();
    expect(snapshots.get("ws-7")?.recency).toBe(707);
    expect(snapshots.get("ws-8")?.lastThinkingLevel).toBe("high");
  });

  test("setStreaming toggles status and remembers last model", async () => {
    await service.updateRecency("workspace-2", 200);
    const streaming = await service.setStreaming("workspace-2", true, "anthropic/sonnet", "high");
    expect(streaming.streaming).toBe(true);
    expect(streaming.lastModel).toBe("anthropic/sonnet");
    expect(streaming.lastThinkingLevel).toBe("high");
    expect(streaming.agentStatus).toBeNull();

    const cleared = await service.setStreaming("workspace-2", false);
    expect(cleared.streaming).toBe(false);
    expect(cleared.lastModel).toBe("anthropic/sonnet");
    expect(cleared.lastThinkingLevel).toBe("high");
    expect(cleared.agentStatus).toBeNull();

    const snapshots = await service.getAllSnapshots();
    expect(snapshots.get("workspace-2")).toEqual(cleared);
  });
});
