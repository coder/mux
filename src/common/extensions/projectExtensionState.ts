import { z } from "zod";
import { ExtensionRuntimeIdSchema } from "@/common/orpc/schemas/extension";
import { ExtensionStateRecordSchema, type ExtensionStateRecord } from "./globalExtensionState";
import type { ExtensionDiagnostic } from "./manifestValidator";

export const PROJECT_EXTENSION_STATE_SCHEMA_VERSION = 1 as const;

export const ProjectExtensionStateSchema = z
  .object({
    schemaVersion: z.literal(PROJECT_EXTENSION_STATE_SCHEMA_VERSION),
    rootTrusted: z.boolean().optional(),
    extensions: z.record(ExtensionRuntimeIdSchema, ExtensionStateRecordSchema).optional(),
  })
  .strict();

export interface NormalizedProjectExtensionState {
  schemaVersion: typeof PROJECT_EXTENSION_STATE_SCHEMA_VERSION;
  rootTrusted: boolean;
  extensions: Record<string, ExtensionStateRecord>;
}

export interface NormalizeProjectExtensionStateResult {
  state: NormalizedProjectExtensionState;
  diagnostics: ExtensionDiagnostic[];
  // True when the on-disk block carries an unknown schemaVersion. Callers
  // must preserve the original block on disk (no destructive write) until an
  // explicit user mutation rewrites it at the current schemaVersion.
  schemaVersionMismatch: boolean;
}

export interface NormalizeProjectExtensionStateOptions {
  now?: number;
}

function emptyResult(
  extra?: Partial<NormalizeProjectExtensionStateResult>
): NormalizeProjectExtensionStateResult {
  return {
    state: {
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
      rootTrusted: false,
      extensions: {},
    },
    diagnostics: [],
    schemaVersionMismatch: false,
    ...extra,
  };
}

export function normalizeProjectExtensionState(
  raw: unknown,
  options: NormalizeProjectExtensionStateOptions = {}
): NormalizeProjectExtensionStateResult {
  const now = options.now ?? Date.now();

  if (raw == null) {
    return emptyResult();
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    return emptyResult({
      diagnostics: [
        {
          code: "extension.state.malformed",
          severity: "info",
          message: "Project-local extension state block is malformed; treating as empty.",
          occurredAt: now,
        },
      ],
    });
  }

  const obj = raw as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;

  if (schemaVersion !== PROJECT_EXTENSION_STATE_SCHEMA_VERSION) {
    return emptyResult({
      schemaVersionMismatch: true,
      diagnostics: [
        {
          code: "extension.state.schema_version.unsupported",
          severity: "info",
          message: `Project-local extension state schemaVersion ${String(
            schemaVersion
          )} is not supported by this build; treating as empty and preserving the file on disk.`,
          occurredAt: now,
        },
      ],
    });
  }

  // Empty state never implies trust: a non-boolean rootTrusted means the
  // file is malformed at the gate that decides trust, so treat as empty
  // rather than coercing.
  if (obj.rootTrusted !== undefined && typeof obj.rootTrusted !== "boolean") {
    return emptyResult({
      diagnostics: [
        {
          code: "extension.state.malformed",
          severity: "info",
          message: "Project-local extension state has non-boolean rootTrusted; treating as empty.",
          occurredAt: now,
        },
      ],
    });
  }

  const rootTrusted = obj.rootTrusted === true;

  const diagnostics: ExtensionDiagnostic[] = [];
  const extensions: Record<string, ExtensionStateRecord> = {};
  const rawExtensions = obj.extensions;

  if (rawExtensions != null && typeof rawExtensions === "object" && !Array.isArray(rawExtensions)) {
    for (const [extensionId, rawRecord] of Object.entries(
      rawExtensions as Record<string, unknown>
    )) {
      const idOk = ExtensionRuntimeIdSchema.safeParse(extensionId);
      if (!idOk.success) {
        diagnostics.push({
          code: "extension.state.record.invalid",
          severity: "info",
          message: `Dropping project-local extension state record with invalid Extension Identity "${extensionId}".`,
          occurredAt: now,
        });
        continue;
      }
      const recordOk = ExtensionStateRecordSchema.safeParse(rawRecord);
      if (!recordOk.success) {
        diagnostics.push({
          code: "extension.state.record.invalid",
          severity: "info",
          message: `Dropping malformed project-local extension state record for "${extensionId}".`,
          extensionId,
          occurredAt: now,
        });
        continue;
      }
      extensions[extensionId] = recordOk.data;
    }
  }

  return {
    state: {
      schemaVersion: PROJECT_EXTENSION_STATE_SCHEMA_VERSION,
      rootTrusted,
      extensions,
    },
    diagnostics,
    schemaVersionMismatch: false,
  };
}
