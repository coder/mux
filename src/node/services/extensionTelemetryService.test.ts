import { describe, expect, test } from "bun:test";

import { ExtensionTelemetryLayer } from "./extensionTelemetryService";
import type { ExtensionTelemetryEventName } from "@/common/extensions/extensionTelemetry";

interface RecordedCall {
  event: ExtensionTelemetryEventName;
  properties: Record<string, string | number | boolean>;
}

function createRecordingSink(): {
  calls: RecordedCall[];
  captureExtensionEvent: (
    event: ExtensionTelemetryEventName,
    properties: Record<string, string | number | boolean>
  ) => void;
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    captureExtensionEvent(event, properties) {
      calls.push({ event, properties: { ...properties } });
    },
  };
}

describe("ExtensionTelemetryLayer", () => {
  test("forwards gated payload to underlying sink", () => {
    const sink = createRecordingSink();
    const layer = new ExtensionTelemetryLayer(sink);

    layer.capture({
      event: "extensions.discovery.completed",
      properties: { durationMs: 150, rootCount: 3, extensionCount: 7, cacheHit: false },
      provenance: { rootKind: "bundled" },
    });

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toEqual({
      event: "extensions.discovery.completed",
      properties: { durationMs: 150, rootCount: 3, extensionCount: 7, cacheHit: false },
    });
  });

  test("strips identifier fields under non-bundled provenance before forwarding", () => {
    const sink = createRecordingSink();
    const layer = new ExtensionTelemetryLayer(sink);

    layer.capture({
      event: "extensions.approval.recorded",
      properties: { extensionId: "mux.evil", rootKind: "user-global", capabilityCount: 2 },
      provenance: { rootKind: "user-global" },
    });

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].properties.extensionId).toBeUndefined();
    expect(sink.calls[0].properties).toEqual({ rootKind: "user-global", capabilityCount: 2 });
  });

  test("forwards an empty property bag when every input field is rejected", () => {
    const sink = createRecordingSink();
    const layer = new ExtensionTelemetryLayer(sink);

    layer.capture({
      event: "extensions.cache.hit",
      properties: {
        // Forbidden fields the gate must drop:
        projectPath: "/home/user/secret",
        packageName: "@scope/pkg",
        requestedPermissions: ["network"],
      },
      provenance: { rootKind: "user-global" },
    });

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toEqual({
      event: "extensions.cache.hit",
      properties: {},
    });
  });

  test("emits identifier when both provenance gates pass", () => {
    const sink = createRecordingSink();
    const layer = new ExtensionTelemetryLayer(sink);

    layer.capture({
      event: "extensions.diagnostic.emitted",
      properties: {
        extensionId: "mux.platform.demo",
        contributionId: "mux.platform.demo-skill",
        diagnosticCode: "extension.identity.invalid",
        severity: "warn",
        rootKind: "bundled",
      },
      provenance: { rootKind: "bundled" },
    });

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].properties).toEqual({
      extensionId: "mux.platform.demo",
      contributionId: "mux.platform.demo-skill",
      diagnosticCode: "extension.identity.invalid",
      severity: "warn",
      rootKind: "bundled",
    });
  });
});
