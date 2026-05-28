import { z } from "zod";
import { ExtensionRuntimeIdSchema } from "@/common/orpc/schemas/extension";
import type { ExtensionDiagnostic } from "./manifestValidator";

export const GLOBAL_EXTENSION_STATE_SCHEMA_VERSION = 1 as const;

const LegacyDistributionIdentitySchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
  })
  .strict();

export const ApprovalRecordSchema = z
  .object({
    grantedPermissions: z.array(z.string()),
    requestedPermissionsHash: z.string().min(1),
    // Legacy pre-v1 state stored distribution metadata on approval records.
    // Accept and strip it so old approvals survive the v1 boundary.
    approvedDistributionIdentity: LegacyDistributionIdentitySchema.optional(),
  })
  .strict()
  .transform(({ grantedPermissions, requestedPermissionsHash }) => ({
    grantedPermissions,
    requestedPermissionsHash,
  }));

export const ExtensionStateRecordSchema = z
  .object({
    enabled: z.boolean().optional(),
    approval: ApprovalRecordSchema.optional(),
    grant: ApprovalRecordSchema.optional(),
  })
  .strict()
  .transform(({ enabled, approval, grant }) => ({
    ...(enabled !== undefined ? { enabled } : {}),
    ...((approval ?? grant) ? { approval: approval ?? grant } : {}),
  }));

export const GlobalExtensionStateSchema = z
  .object({
    schemaVersion: z.literal(GLOBAL_EXTENSION_STATE_SCHEMA_VERSION),
    extensions: z.record(ExtensionRuntimeIdSchema, ExtensionStateRecordSchema).optional(),
  })
  .strict();

export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;
export type ExtensionStateRecord = z.infer<typeof ExtensionStateRecordSchema>;

export interface NormalizedGlobalExtensionState {
  schemaVersion: typeof GLOBAL_EXTENSION_STATE_SCHEMA_VERSION;
  extensions: Record<string, ExtensionStateRecord>;
}

export interface NormalizeGlobalExtensionStateResult {
  state: NormalizedGlobalExtensionState;
  diagnostics: ExtensionDiagnostic[];
  // True when the on-disk block carries an unknown schemaVersion. Callers
  // must preserve the original block on disk (no destructive write).
  schemaVersionMismatch: boolean;
}

export interface NormalizeGlobalExtensionStateOptions {
  now?: number;
}

function emptyResult(
  extra?: Partial<NormalizeGlobalExtensionStateResult>
): NormalizeGlobalExtensionStateResult {
  return {
    state: { schemaVersion: GLOBAL_EXTENSION_STATE_SCHEMA_VERSION, extensions: {} },
    diagnostics: [],
    schemaVersionMismatch: false,
    ...extra,
  };
}

export function normalizeGlobalExtensionState(
  raw: unknown,
  options: NormalizeGlobalExtensionStateOptions = {}
): NormalizeGlobalExtensionStateResult {
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
          message: "Global extension state block is malformed; treating as empty.",
          occurredAt: now,
        },
      ],
    });
  }

  const obj = raw as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;

  if (schemaVersion !== GLOBAL_EXTENSION_STATE_SCHEMA_VERSION) {
    return emptyResult({
      schemaVersionMismatch: true,
      diagnostics: [
        {
          code: "extension.state.schema_version.unsupported",
          severity: "info",
          message: `Global extension state schemaVersion ${String(
            schemaVersion
          )} is not supported by this build; treating as empty and preserving the file on disk.`,
          occurredAt: now,
        },
      ],
    });
  }

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
          message: `Dropping global extension state record with invalid Extension Identity "${extensionId}".`,
          occurredAt: now,
        });
        continue;
      }
      const recordOk = ExtensionStateRecordSchema.safeParse(rawRecord);
      if (!recordOk.success) {
        diagnostics.push({
          code: "extension.state.record.invalid",
          severity: "info",
          message: `Dropping malformed global extension state record for "${extensionId}".`,
          extensionId,
          occurredAt: now,
        });
        continue;
      }
      extensions[extensionId] = recordOk.data;
    }
  }

  return {
    state: { schemaVersion: GLOBAL_EXTENSION_STATE_SCHEMA_VERSION, extensions },
    diagnostics,
    schemaVersionMismatch: false,
  };
}
