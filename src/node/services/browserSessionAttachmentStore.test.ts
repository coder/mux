import * as os from "node:os";
import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { getMuxBrowserSessionId } from "@/common/utils/browserSession";
import { BrowserSessionAttachmentStore } from "@/node/services/browserSessionAttachmentStore";

describe("BrowserSessionAttachmentStore", () => {
  test("writes and reads deterministic attachment records", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-browser-attachment-store-"));
    try {
      const store = new BrowserSessionAttachmentStore(tempDir);
      store.writeAttachment("workspace-1", 40123);

      expect(store.getAttachment("workspace-1")).toEqual({
        workspaceId: "workspace-1",
        sessionId: getMuxBrowserSessionId("workspace-1"),
        streamPort: 40123,
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("ignores malformed persisted data instead of throwing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mux-browser-attachment-store-"));
    try {
      await writeFile(path.join(tempDir, "browser-session-attachments.json"), "not-json\n", "utf8");
      const store = new BrowserSessionAttachmentStore(tempDir);

      expect(store.getAttachment("workspace-1")).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
