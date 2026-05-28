import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { z } from "zod";

import type * as extensionRegistrySchemas from "@/common/orpc/schemas/extensionRegistry";
import {
  __setExtensionDiagnosticsLogSink,
  classifyDiagnostic,
  logSnapshotDiagnostics,
} from "./extensionDiagnostics";

type RegistrySnapshot = z.infer<typeof extensionRegistrySchemas.RegistrySnapshotSchema>;
type RootDiscoveryResult = z.infer<typeof extensionRegistrySchemas.RootDiscoveryResultSchema>;
type DiscoveredExtension = z.infer<typeof extensionRegistrySchemas.DiscoveredExtensionSchema>;
type ExtensionDiagnostic = z.infer<typeof extensionRegistrySchemas.ExtensionDiagnosticSchema>;

interface CapturedEntry {
  severity: "error" | "warn" | "info";
  args: unknown[];
}

function makeRoot(overrides: Partial<RootDiscoveryResult> = {}): RootDiscoveryResult {
  return {
    rootId: overrides.rootId ?? "root-id",
    kind: overrides.kind ?? "user-global",
    path: overrides.path ?? "/path/to/root",
    trusted: overrides.trusted ?? true,
    rootExists: overrides.rootExists ?? true,
    state: overrides.state ?? "ready",
    extensions: overrides.extensions ?? [],
    diagnostics: overrides.diagnostics ?? [],
  };
}

function makeExtension(overrides: Partial<DiscoveredExtension> = {}): DiscoveredExtension {
  return {
    extensionId: "vendor.demo",
    rootId: "user-root",
    rootKind: "user-global",
    isCore: false,
    modulePath: "/p",
    manifest: {
      manifestVersion: 1,
      id: "vendor.demo",
      displayName: "Demo Extension",
      description: undefined,
      publisher: undefined,
      homepage: undefined,
      requestedPermissions: [],
      contributions: [],
    },
    contributions: [],
    diagnostics: [],
    enabled: false,
    granted: false,
    activated: false,
    ...overrides,
  };
}

function makeSnapshot(roots: RootDiscoveryResult[]): RegistrySnapshot {
  return {
    generatedAt: 1000,
    roots,
    availableContributions: [],
    resolverDiagnostics: [],
    descriptors: [],
    permissions: {},
    staleRecords: [],
  };
}

function diag(overrides: Partial<ExtensionDiagnostic>): ExtensionDiagnostic {
  return {
    code: overrides.code ?? "unknown.code",
    severity: overrides.severity ?? "error",
    message: overrides.message ?? "boom",
    extensionId: overrides.extensionId,
    contributionRef: overrides.contributionRef,
    suggestedAction: overrides.suggestedAction,
    occurredAt: overrides.occurredAt ?? 0,
  };
}

describe("classifyDiagnostic", () => {
  test("maps blocking manifest errors to extension-invalid", () => {
    expect(classifyDiagnostic(diag({ code: "manifest.invalid" }))).toBe("extension-invalid");
    expect(classifyDiagnostic(diag({ code: "manifest.version.unsupported" }))).toBe(
      "extension-invalid"
    );
    expect(classifyDiagnostic(diag({ code: "extension.identity.invalid" }))).toBe(
      "extension-invalid"
    );
    expect(classifyDiagnostic(diag({ code: "extension.identity.reserved" }))).toBe(
      "extension-invalid"
    );
    expect(classifyDiagnostic(diag({ code: "extension.package.invalid" }))).toBe(
      "extension-invalid"
    );
  });

  test("maps contribution.invalid family to contribution-invalid", () => {
    expect(classifyDiagnostic(diag({ code: "contribution.invalid" }))).toBe("contribution-invalid");
    expect(classifyDiagnostic(diag({ code: "contribution.body.missing" }))).toBe(
      "contribution-invalid"
    );
    expect(classifyDiagnostic(diag({ code: "contribution.body.invalid" }))).toBe(
      "contribution-invalid"
    );
    expect(classifyDiagnostic(diag({ code: "contribution.body.timeout" }))).toBe(
      "contribution-invalid"
    );
  });

  test("maps identity conflicts to identity-conflict / contribution-conflict", () => {
    expect(classifyDiagnostic(diag({ code: "extension.identity.conflict" }))).toBe(
      "identity-conflict"
    );
    expect(classifyDiagnostic(diag({ code: "contribution.identity.conflict" }))).toBe(
      "contribution-conflict"
    );
  });

  test("maps root failure codes to root-failure", () => {
    expect(classifyDiagnostic(diag({ code: "root.discovery.timeout" }))).toBe("root-failure");
    expect(classifyDiagnostic(diag({ code: "root.package.invalid" }))).toBe("root-failure");
  });

  test("returns null for codes outside the matrix", () => {
    expect(classifyDiagnostic(diag({ code: "manifest.unknown_field", severity: "info" }))).toBe(
      null
    );
    expect(classifyDiagnostic(diag({ code: "totally.unknown" }))).toBe(null);
  });
});

describe("logSnapshotDiagnostics", () => {
  let captured: CapturedEntry[] = [];

  beforeEach(() => {
    captured = [];
    __setExtensionDiagnosticsLogSink({
      error: (...args) => captured.push({ severity: "error", args }),
      warn: (...args) => captured.push({ severity: "warn", args }),
      info: (...args) => captured.push({ severity: "info", args }),
    });
  });

  afterEach(() => {
    __setExtensionDiagnosticsLogSink(null);
  });

  function logFields(entry: CapturedEntry): Record<string, unknown> {
    return entry.args[1] as Record<string, unknown>;
  }

  test("RootFailure: logs at error and includes rootId + code", () => {
    logSnapshotDiagnostics(
      makeSnapshot([
        makeRoot({
          rootId: "root-1",
          kind: "user-global",
          state: "failed",
          diagnostics: [
            diag({
              code: "root.discovery.timeout",
              severity: "error",
              message: "timeout",
              occurredAt: 50,
            }),
          ],
        }),
      ])
    );
    const errors = captured.filter((c) => c.severity === "error");
    expect(errors).toHaveLength(1);
    const fields = logFields(errors[0]);
    expect(fields.kind).toBe("root-failure");
    expect(fields.code).toBe("root.discovery.timeout");
    expect(fields.rootId).toBe("root-1");
    expect(fields.component).toBe("extensions");
  });

  test("RootInitMissing: logs at info when user-global root does not exist", () => {
    logSnapshotDiagnostics(
      makeSnapshot([
        makeRoot({
          rootId: "user-root",
          kind: "user-global",
          rootExists: false,
        }),
      ])
    );
    const infos = captured.filter(
      (c) => c.severity === "info" && (logFields(c).kind as string) === "root-init-missing"
    );
    expect(infos).toHaveLength(1);
    expect(logFields(infos[0]).code).toBe("root.init.missing");
    expect(logFields(infos[0]).rootId).toBe("user-root");
  });

  test("ExtensionInvalid: logs at error and includes extensionId", () => {
    const ext = makeExtension({
      diagnostics: [
        diag({
          code: "manifest.invalid",
          severity: "error",
          message: "bad manifest",
          extensionId: "vendor.demo",
        }),
      ],
    });
    logSnapshotDiagnostics(
      makeSnapshot([
        makeRoot({
          rootId: "root-1",
          extensions: [ext],
        }),
      ])
    );
    const errors = captured.filter((c) => c.severity === "error");
    expect(errors.some((e) => logFields(e).kind === "extension-invalid")).toBe(true);
    const fields = errors.find((e) => logFields(e).kind === "extension-invalid")!;
    expect(logFields(fields).extensionId).toBe("vendor.demo");
    expect(logFields(fields).rootId).toBe("root-1");
  });

  test("ContributionInvalid: logs at warn", () => {
    const ext = makeExtension({
      diagnostics: [
        diag({
          code: "contribution.invalid",
          severity: "warn",
          message: "bad contribution",
        }),
      ],
    });
    logSnapshotDiagnostics(makeSnapshot([makeRoot({ rootId: "r", extensions: [ext] })]));
    const warns = captured.filter(
      (c) => c.severity === "warn" && logFields(c).kind === "contribution-invalid"
    );
    expect(warns).toHaveLength(1);
    expect(logFields(warns[0]).code).toBe("contribution.invalid");
  });

  test("IdentityConflict: logs at error", () => {
    const ext = makeExtension({
      diagnostics: [
        diag({
          code: "extension.identity.conflict",
          severity: "error",
          message: "duplicate identity",
        }),
      ],
    });
    logSnapshotDiagnostics(makeSnapshot([makeRoot({ rootId: "r", extensions: [ext] })]));
    const errors = captured.filter(
      (c) => c.severity === "error" && logFields(c).kind === "identity-conflict"
    );
    expect(errors).toHaveLength(1);
  });

  test("ContributionConflict: logs at warn", () => {
    const ext = makeExtension({
      diagnostics: [
        diag({
          code: "contribution.identity.conflict",
          severity: "warn",
          message: "dup contribution",
          contributionRef: { type: "skills", id: "demo" },
        }),
      ],
    });
    logSnapshotDiagnostics(makeSnapshot([makeRoot({ rootId: "r", extensions: [ext] })]));
    const warns = captured.filter(
      (c) => c.severity === "warn" && logFields(c).kind === "contribution-conflict"
    );
    expect(warns).toHaveLength(1);
    expect(logFields(warns[0]).contributionId).toBe("demo");
  });

  test("Drift: logs at info when permissions are non-fresh", () => {
    const ext = makeExtension();
    const snapshot = makeSnapshot([makeRoot({ rootId: "r", extensions: [ext] })]);
    snapshot.permissions = {
      [ext.extensionId]: {
        effectivePermissions: [],
        pendingNew: ["secrets.read"],
        contributions: [],
        driftStatus: "permissions-changed",
        isStale: false,
      },
    };
    logSnapshotDiagnostics(snapshot);
    const infos = captured.filter((c) => c.severity === "info" && logFields(c).kind === "drift");
    expect(infos).toHaveLength(1);
    expect(logFields(infos[0]).extensionId).toBe(ext.extensionId);
    expect(logFields(infos[0]).rootId).toBe("r");
    expect(String(logFields(infos[0]).message)).toContain("Capability approvals");
    expect(String(logFields(infos[0]).message)).toContain("awaiting re-approval");
    expect(String(logFields(infos[0]).message)).not.toContain("Operational permissions");
    expect(String(logFields(infos[0]).message)).not.toContain("re-grant");
  });

  test("SupportLevelInspectionOnly: logs at info for untrusted project-local root", () => {
    logSnapshotDiagnostics(
      makeSnapshot([
        makeRoot({
          rootId: "proj-root",
          kind: "project-local",
          rootExists: true,
          trusted: false,
        }),
      ])
    );
    const infos = captured.filter(
      (c) =>
        c.severity === "info" &&
        logFields(c).kind === "support-level-inspection-only" &&
        logFields(c).code === "root.inspection_only"
    );
    expect(infos).toHaveLength(1);
  });

  test("SupportLevelInspectionOnly: logs at info for non-skill contributions", () => {
    const ext = makeExtension({
      manifest: {
        manifestVersion: 1,
        id: "vendor.demo",
        displayName: "Demo",
        description: undefined,
        publisher: undefined,
        homepage: undefined,
        requestedPermissions: [],
        contributions: [
          { type: "themes", id: "demo.theme", index: 0, descriptor: {} },
          { type: "agents", id: "demo-agent", index: 1, descriptor: {} },
          { type: "skills", id: "demo.skill", index: 2, descriptor: {} },
        ],
      },
    });
    logSnapshotDiagnostics(makeSnapshot([makeRoot({ rootId: "r", extensions: [ext] })]));
    const infos = captured.filter(
      (c) =>
        c.severity === "info" &&
        logFields(c).kind === "support-level-inspection-only" &&
        logFields(c).code === "contribution.support_level.inspection_only"
    );
    // Theme and agent contributions are inspection-only; skills is capability-consumed.
    expect(infos).toHaveLength(2);
    expect(infos.map((info) => logFields(info).contributionId).sort()).toEqual([
      "demo-agent",
      "demo.theme",
    ]);
  });

  test("structured fields: every entry carries component=extensions plus rootId, extensionId, contributionId, code", () => {
    const ext = makeExtension({
      diagnostics: [diag({ code: "manifest.invalid", severity: "error", message: "x" })],
    });
    logSnapshotDiagnostics(makeSnapshot([makeRoot({ rootId: "root-A", extensions: [ext] })]));
    expect(captured.length).toBeGreaterThan(0);
    for (const entry of captured) {
      const fields = logFields(entry);
      expect(fields.component).toBe("extensions");
      expect(typeof fields.code).toBe("string");
      expect("rootId" in fields).toBe(true);
      expect("extensionId" in fields).toBe(true);
      expect("contributionId" in fields).toBe(true);
    }
  });
});
