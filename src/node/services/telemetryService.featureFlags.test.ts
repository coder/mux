import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { TelemetryService } from "./telemetryService";
import type { TelemetryEventPayload } from "@/common/telemetry/payload";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

describe("TelemetryService feature flag properties", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-telemetry-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test("capture includes $feature/<flagKey> properties when set", () => {
    const telemetry = new TelemetryService(tempDir);

    const capture = mock((_args: unknown) => undefined);

    // NOTE: TelemetryService only checks that client + distinctId are set.
    // We set them directly to avoid any real network calls.
    // @ts-expect-error - Accessing private property for test
    telemetry.client = { capture };
    // @ts-expect-error - Accessing private property for test
    telemetry.distinctId = "distinct-id";

    telemetry.setFeatureFlagVariant("post-compaction-context", "test");

    const payload: TelemetryEventPayload = {
      event: "message_sent",
      properties: {
        workspaceId: "workspace-id",
        model: "test-model",
        mode: "exec",
        message_length_b2: 128,
        runtimeType: "local",
        frontendPlatform: {
          userAgent: "ua",
          platform: "platform",
        },
        thinkingLevel: "off",
      },
    };

    telemetry.capture(payload);

    expect(capture).toHaveBeenCalled();

    const call = capture.mock.calls[0]?.[0] as { properties?: Record<string, unknown> } | undefined;
    expect(call?.properties).toBeDefined();
    expect(call?.properties?.["$feature/post-compaction-context"]).toBe("test");
  });
});
