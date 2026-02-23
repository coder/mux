import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import * as path from "path";
import { ExtensionMetadataService } from "./ExtensionMetadataService";

const PREFIX = "mux-extension-metadata-test-";

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
