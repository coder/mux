import type { z } from "zod";

import { requiresReapproval } from "@/common/extensions/approvalDrift";
import {
  extensionIdFromPermissionKey,
  rootIdFromPermissionKey,
} from "@/common/extensions/extensionPermissionKey";
import type * as extensionRegistrySchemas from "@/common/orpc/schemas/extensionRegistry";

type RegistrySnapshot = z.infer<typeof extensionRegistrySchemas.RegistrySnapshotSchema>;
type RootDiscoveryResult = z.infer<typeof extensionRegistrySchemas.RootDiscoveryResultSchema>;
type ExtensionDiagnostic = z.infer<typeof extensionRegistrySchemas.ExtensionDiagnosticSchema>;
/**
 * Diagnostic kinds defined by the v1 surfacing matrix. Each kind maps to a
 * fixed log severity and a fixed set of UI surfaces (header / root subsection
 * / card). See US-025 for the full matrix.
 */
export type DiagnosticKind =
  | "root-failure"
  | "root-init-missing"
  | "extension-invalid"
  | "contribution-invalid"
  | "identity-conflict"
  | "contribution-conflict"
  | "drift"
  | "support-level-inspection-only";

const ROOT_FAILURE_CODES = new Set(["root.discovery.timeout", "root.package.invalid"]);

// v1 contribution types that are capability-consumed end-to-end. Anything else
// is inspection-only in v1, mirroring the support level rendered on the card.
const AVAILABLE_TYPES = new Set(["skills"]);

const EXTENSION_INVALID_CODES = new Set([
  "manifest.invalid",
  "manifest.version.unsupported",
  "manifest.contributes.unknown_key",
  "extension.identity.invalid",
  "extension.identity.reserved",
  "extension.package.invalid",
  "extension.missing",
  "extension.state.malformed",
  "extension.state.schema_version.unsupported",
  "extension.state.record.invalid",
]);

const CONTRIBUTION_INVALID_CODES = new Set([
  "contribution.invalid",
  "contribution.body.missing",
  "contribution.body.invalid",
  "contribution.body.timeout",
]);

/**
 * Classify a backend-issued diagnostic into one of the matrix kinds. Returns
 * null when the code does not map to any kind in the matrix (e.g.,
 * `manifest.unknown_field`, which is purely informational and only logged).
 */
export function classifyDiagnostic(diagnostic: ExtensionDiagnostic): DiagnosticKind | null {
  if (diagnostic.code === "extension.identity.conflict") return "identity-conflict";
  if (diagnostic.code === "contribution.identity.conflict") return "contribution-conflict";
  if (ROOT_FAILURE_CODES.has(diagnostic.code)) return "root-failure";
  if (EXTENSION_INVALID_CODES.has(diagnostic.code)) return "extension-invalid";
  if (CONTRIBUTION_INVALID_CODES.has(diagnostic.code)) return "contribution-invalid";
  return null;
}

export interface DiagnosticLogContext {
  rootId: string | null;
  extensionId?: string | null;
  contributionId?: string | null;
}

interface StructuredLogFields {
  component: "extensions";
  code: string;
  kind: DiagnosticKind | "unclassified";
  rootId: string | null;
  extensionId: string | null;
  contributionId: string | null;
  message: string;
  suggestedAction?: string;
  occurredAt: number;
}

interface LogSink {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
}

const defaultSink: LogSink = {
  error: (...args) => console.error(...args),
  warn: (...args) => console.warn(...args),
  info: (...args) => console.info(...args),
};

let sink: LogSink = defaultSink;

/**
 * Test seam: replace the log sink so unit tests can assert on structured
 * fields without coupling to console internals.
 */
export function __setExtensionDiagnosticsLogSink(next: LogSink | null): void {
  sink = next ?? defaultSink;
}

function emit(severity: "error" | "warn" | "info", fields: StructuredLogFields): void {
  const tag = `[extensions/${fields.kind}]`;
  if (severity === "error") sink.error(tag, fields);
  else if (severity === "warn") sink.warn(tag, fields);
  else sink.info(tag, fields);
}

function buildFields(
  diagnostic: ExtensionDiagnostic,
  kind: DiagnosticKind | "unclassified",
  context: DiagnosticLogContext
): StructuredLogFields {
  return {
    component: "extensions",
    code: diagnostic.code,
    kind,
    rootId: context.rootId,
    extensionId: context.extensionId ?? diagnostic.extensionId ?? null,
    contributionId: context.contributionId ?? diagnostic.contributionRef?.id ?? null,
    message: diagnostic.message,
    suggestedAction: diagnostic.suggestedAction ?? undefined,
    occurredAt: diagnostic.occurredAt,
  };
}

/**
 * Log a single backend-issued diagnostic at its declared severity. Unknown
 * codes still land in the log so support tickets can attribute them, just
 * tagged as "unclassified".
 */
export function logDiagnostic(
  diagnostic: ExtensionDiagnostic,
  context: DiagnosticLogContext
): void {
  const kind = classifyDiagnostic(diagnostic) ?? "unclassified";
  emit(diagnostic.severity, buildFields(diagnostic, kind, context));
}

interface SyntheticEvent {
  kind: DiagnosticKind;
  code: string;
  severity: "error" | "warn" | "info";
  message: string;
  rootId: string | null;
  extensionId?: string | null;
  contributionId?: string | null;
  occurredAt: number;
}

function emitSynthetic(event: SyntheticEvent): void {
  emit(event.severity, {
    component: "extensions",
    code: event.code,
    kind: event.kind,
    rootId: event.rootId,
    extensionId: event.extensionId ?? null,
    contributionId: event.contributionId ?? null,
    message: event.message,
    occurredAt: event.occurredAt,
  });
}

/**
 * Walk a snapshot and emit one structured log entry per matrix-relevant
 * diagnostic and per derived state (RootInitMissing, RootFailure without a
 * specific code, Drift, SupportLevelInspectionOnly). Designed to be called
 * once per snapshot replacement; previous-snapshot diagnostics never leak
 * because we operate on the new snapshot only.
 */
export function logSnapshotDiagnostics(snapshot: RegistrySnapshot): void {
  const now = snapshot.generatedAt;

  for (const root of snapshot.roots) {
    for (const diagnostic of root.diagnostics) {
      logDiagnostic(diagnostic, { rootId: root.rootId });
    }

    if (root.kind === "user-global" && !root.rootExists) {
      emitSynthetic({
        kind: "root-init-missing",
        code: "root.init.missing",
        severity: "info",
        message: `User-global Extensions root has not been initialized at ${root.path}.`,
        rootId: root.rootId,
        occurredAt: now,
      });
    }

    if (root.kind === "project-local" && root.rootExists && !root.trusted) {
      emitSynthetic({
        kind: "support-level-inspection-only",
        code: "root.inspection_only",
        severity: "info",
        message: `Project-local Extensions root at ${root.path} is untrusted; contained Extensions are inspection-only.`,
        rootId: root.rootId,
        occurredAt: now,
      });
    }

    if (root.state === "failed" && root.diagnostics.length === 0) {
      emitSynthetic({
        kind: "root-failure",
        code: "root.discovery.failed",
        severity: "error",
        message: `Extension Root discovery failed for ${root.path}.`,
        rootId: root.rootId,
        occurredAt: now,
      });
    }

    for (const ext of root.extensions) {
      for (const diagnostic of ext.diagnostics) {
        logDiagnostic(diagnostic, {
          rootId: root.rootId,
          extensionId: ext.extensionId,
        });
      }
      for (const contribution of ext.manifest.contributions) {
        if (!AVAILABLE_TYPES.has(contribution.type)) {
          emitSynthetic({
            kind: "support-level-inspection-only",
            code: "contribution.support_level.inspection_only",
            severity: "info",
            message: `Contribution ${contribution.type}/${contribution.id} is recognized but not capability-consumed in v1; shown in inspection-only mode.`,
            rootId: root.rootId,
            extensionId: ext.extensionId,
            contributionId: contribution.id,
            occurredAt: now,
          });
        }
      }
    }
  }

  for (const diagnostic of snapshot.resolverDiagnostics) {
    logDiagnostic(diagnostic, { rootId: null });
  }

  for (const [permissionKey, permissions] of Object.entries(snapshot.permissions)) {
    if (!permissions) continue;
    if (requiresReapproval(permissions)) {
      const extensionId = extensionIdFromPermissionKey(permissionKey);
      emitSynthetic({
        kind: "drift",
        code: "permissions.drift",
        severity: "info",
        message: `Capability approvals for ${extensionId} have drifted (${permissions.driftStatus ?? "pending-new"}); awaiting re-approval.`,
        rootId:
          rootIdFromPermissionKey(permissionKey) ?? findRootIdForExtension(snapshot, extensionId),
        extensionId,
        occurredAt: now,
      });
    }
  }
}

function findRootIdForExtension(snapshot: RegistrySnapshot, extensionId: string): string | null {
  for (const root of snapshot.roots) {
    if (root.extensions.some((e) => e.extensionId === extensionId)) return root.rootId;
  }
  return null;
}

const ROOT_MIRROR_KINDS: ReadonlySet<DiagnosticKind> = new Set([
  "extension-invalid",
  "identity-conflict",
  "root-failure",
]);

/**
 * Pull the matrix-classified diagnostics off a root for the Diagnostics panel
 * inside RootSubsection. Blocking error kinds (extension-invalid /
 * identity-conflict / root-failure) are mirrored from cards into the root
 * list so the user can find them without expanding every card; warn-severity
 * contribution kinds stay on the card to avoid duplicate rendering.
 */
export function rootSubsectionDiagnostics(
  root: RootDiscoveryResult
): readonly ExtensionDiagnostic[] {
  const collected: ExtensionDiagnostic[] = [...root.diagnostics];
  for (const ext of root.extensions) {
    for (const d of ext.diagnostics) {
      const kind = classifyDiagnostic(d);
      if (kind && ROOT_MIRROR_KINDS.has(kind)) collected.push(d);
    }
  }
  return collected;
}
