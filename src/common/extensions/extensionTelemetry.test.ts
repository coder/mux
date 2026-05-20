import { describe, expect, test } from "bun:test";

import {
  EXTENSION_TELEMETRY_EVENTS,
  EXTENSION_TELEMETRY_FIELD_ALLOWLIST,
  type ExtensionTelemetryEventName,
  type ExtensionTelemetryProvenance,
  gateExtensionTelemetryEvent,
} from "./extensionTelemetry";
import type { RootKind } from "./manifestValidator";

const BUNDLED: ExtensionTelemetryProvenance = { rootKind: "bundled" };
const USER_GLOBAL: ExtensionTelemetryProvenance = { rootKind: "user-global" };
const PROJECT_LOCAL: ExtensionTelemetryProvenance = { rootKind: "project-local" };

const SCALAR_FIELD_VALUES: Record<string, string | number | boolean> = {
  rootKind: "bundled",
  diagnosticCode: "extension.identity.invalid",
  severity: "warn",
  reason: "appVersion",
};

const FORBIDDEN_FIELDS: Record<string, unknown> = {
  projectPath: "/home/user/secret-project",
  packageName: "@scope/super-secret-package",
  requestedPermissions: ["network", "skill.register"],
  filePath: "/etc/passwd",
  lockfileContents: "lockfile-data",
};

// Identifier fields are seeded with values matching the reserved prefix so
// the test can prove the rootKind gate (not the regex gate) rejects them
// under non-bundled provenance.
function buildRichProperties(event: ExtensionTelemetryEventName): Record<string, unknown> {
  const allowlist = EXTENSION_TELEMETRY_FIELD_ALLOWLIST[event];
  const properties: Record<string, unknown> = { ...FORBIDDEN_FIELDS };
  for (const [field, kind] of Object.entries(allowlist)) {
    if (kind === "identifier") {
      properties[field] = field === "contributionId" ? "mux.platform.demo-skill" : "mux.demo";
    } else if (field in SCALAR_FIELD_VALUES) {
      properties[field] = SCALAR_FIELD_VALUES[field];
    } else if (field.toLowerCase().includes("count") || field === "durationMs") {
      properties[field] = 42;
    } else {
      properties[field] = true;
    }
  }
  return properties;
}

describe("gateExtensionTelemetryEvent — allowlist", () => {
  test("drops fields outside the per-event allowlist regardless of provenance", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.discovery.completed",
      properties: {
        durationMs: 100,
        rootCount: 2,
        // Forbidden:
        projectPath: "/home/user/secret",
        packageName: "@scope/pkg",
        requestedPermissions: ["network"],
        filePath: "/etc/passwd",
        lockfileContents: "lock data",
        unknownField: "anything",
      },
      provenance: BUNDLED,
    });
    expect(result.properties).toEqual({ durationMs: 100, rootCount: 2 });
  });

  test("preserves scalar values (numbers, booleans, status enum strings)", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.discovery.failed",
      properties: { rootKind: "user-global", diagnosticCode: "extension.missing", durationMs: 0 },
      provenance: BUNDLED,
    });
    expect(result.properties).toEqual({
      rootKind: "user-global",
      diagnosticCode: "extension.missing",
      durationMs: 0,
    });
  });

  test("drops scalar fields with non-primitive values", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.discovery.completed",
      properties: {
        durationMs: 100,
        rootCount: { sneaky: "object" },
        extensionCount: ["array", "not", "allowed"],
      },
      provenance: BUNDLED,
    });
    expect(result.properties).toEqual({ durationMs: 100 });
  });
});

describe("gateExtensionTelemetryEvent — identifier gates", () => {
  test("emits identifier when both gates pass (mux.* + bundled)", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.approval.recorded",
      properties: { extensionId: "mux.platform.demo", rootKind: "bundled", capabilityCount: 3 },
      provenance: BUNDLED,
    });
    expect(result.properties).toEqual({
      extensionId: "mux.platform.demo",
      rootKind: "bundled",
      capabilityCount: 3,
    });
  });

  test("strips identifier when value matches mux.* but rootKind is user-global (third-party squatter)", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.approval.recorded",
      properties: { extensionId: "mux.evil", rootKind: "user-global", capabilityCount: 1 },
      provenance: USER_GLOBAL,
    });
    expect(result.properties).toEqual({ rootKind: "user-global", capabilityCount: 1 });
    expect(result.properties.extensionId).toBeUndefined();
  });

  test("strips identifier when value matches mux.* but rootKind is project-local", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.enabled.toggled",
      properties: { extensionId: "mux.platform.demo", rootKind: "project-local", enabled: true },
      provenance: PROJECT_LOCAL,
    });
    expect(result.properties.extensionId).toBeUndefined();
    expect(result.properties).toEqual({ rootKind: "project-local", enabled: true });
  });

  test("strips identifier when rootKind is bundled but value does not match mux.* (third-party id smuggled in)", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.approval.recorded",
      properties: { extensionId: "evil.demo", rootKind: "bundled", capabilityCount: 1 },
      provenance: BUNDLED,
    });
    expect(result.properties.extensionId).toBeUndefined();
    expect(result.properties).toEqual({ rootKind: "bundled", capabilityCount: 1 });
  });

  test("strips identifier when value is the literal `muxbar` (not a mux. namespace)", () => {
    // `muxbar` is not in the reserved namespace — only `mux` (bare) or `mux.*`.
    const result = gateExtensionTelemetryEvent({
      event: "extensions.migration.activated",
      properties: { extensionId: "muxbar", durationMs: 5 },
      provenance: BUNDLED,
    });
    expect(result.properties.extensionId).toBeUndefined();
    expect(result.properties).toEqual({ durationMs: 5 });
  });

  test("emits bare 'mux' as a valid reserved identity (matches ^mux(\\..*)?$)", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.migration.activated",
      properties: { extensionId: "mux", durationMs: 5 },
      provenance: BUNDLED,
    });
    expect(result.properties).toEqual({ extensionId: "mux", durationMs: 5 });
  });

  test("strips identifier when value is non-string", () => {
    const result = gateExtensionTelemetryEvent({
      event: "extensions.approval.recorded",
      properties: { extensionId: 42, rootKind: "bundled" },
      provenance: BUNDLED,
    });
    expect(result.properties.extensionId).toBeUndefined();
    expect(result.properties).toEqual({ rootKind: "bundled" });
  });
});

describe("gateExtensionTelemetryEvent — per-event security regression for v1 catalog", () => {
  const NON_BUNDLED_PROVENANCES: ReadonlyArray<{ name: string; rootKind: RootKind }> = [
    { name: "user-global", rootKind: "user-global" },
    { name: "project-local", rootKind: "project-local" },
  ];

  for (const event of EXTENSION_TELEMETRY_EVENTS) {
    for (const { name, rootKind } of NON_BUNDLED_PROVENANCES) {
      test(`event ${event} drops identifier fields under rootKind=${name}`, () => {
        const result = gateExtensionTelemetryEvent({
          event,
          properties: buildRichProperties(event),
          provenance: { rootKind },
        });

        expect(result.properties.extensionId).toBeUndefined();
        expect(result.properties.contributionId).toBeUndefined();
        for (const forbidden of Object.keys(FORBIDDEN_FIELDS)) {
          expect(result.properties[forbidden]).toBeUndefined();
        }

        const allowlist = EXTENSION_TELEMETRY_FIELD_ALLOWLIST[event];
        for (const [key, value] of Object.entries(result.properties)) {
          expect(allowlist[key]).toBe("scalar");
          const t = typeof value;
          expect(t === "number" || t === "boolean" || t === "string").toBe(true);
        }
      });
    }

    test(`event ${event} preserves scalar fields under rootKind=bundled`, () => {
      const result = gateExtensionTelemetryEvent({
        event,
        properties: buildRichProperties(event),
        provenance: BUNDLED,
      });
      const allowlist = EXTENSION_TELEMETRY_FIELD_ALLOWLIST[event];
      for (const [field, kind] of Object.entries(allowlist)) {
        if (kind === "scalar") {
          expect(result.properties[field]).toBeDefined();
        }
      }
      for (const forbidden of Object.keys(FORBIDDEN_FIELDS)) {
        expect(result.properties[forbidden]).toBeUndefined();
      }
    });
  }
});

describe("extension telemetry event names", () => {
  test("uses approval terminology instead of grant terminology", () => {
    expect(EXTENSION_TELEMETRY_EVENTS).toContain("extensions.approval.recorded");
    expect(EXTENSION_TELEMETRY_EVENTS).toContain("extensions.approval.revoked");
    expect(EXTENSION_TELEMETRY_EVENTS).not.toContain("extensions.grant.recorded");
    expect(EXTENSION_TELEMETRY_EVENTS).not.toContain("extensions.grant.revoked");
  });
});

describe("gateExtensionTelemetryEvent — v1 catalog completeness", () => {
  test("every event has an allowlist entry", () => {
    for (const event of EXTENSION_TELEMETRY_EVENTS) {
      expect(EXTENSION_TELEMETRY_FIELD_ALLOWLIST[event]).toBeDefined();
    }
  });

  test("no allowlisted field name overlaps with the never-emit set", () => {
    const FORBIDDEN = new Set([
      "projectPath",
      "packageName",
      "requestedPermissions",
      "filePath",
      "filePaths",
      "lockfile",
      "lockfileContents",
      "lockfileContent",
      "manifestJson",
      "packageJson",
    ]);
    for (const event of EXTENSION_TELEMETRY_EVENTS) {
      const allowlist = EXTENSION_TELEMETRY_FIELD_ALLOWLIST[event];
      for (const field of Object.keys(allowlist)) {
        expect(FORBIDDEN.has(field)).toBe(false);
      }
    }
  });
});
