import { z } from "zod";
import {
  SettingsBackupInputSchema,
  SettingsBackupSchema,
} from "@/common/config/schemas/settingsBackup";
import { ResultSchema } from "./result";

/**
 * An MCP command a restore would introduce or change. `token` binds the approval to this
 * exact command text, so an approval cannot carry over to a command the repository
 * changed after the user read it.
 */
export const BackupCommandApprovalSchema = z.object({
  path: z.string(),
  command: z.string(),
  token: z.string(),
});

export const BackupOperationErrorSchema = z.object({
  code: z.enum([
    "AUTH_FAILED",
    "REMOTE_UNREACHABLE",
    "REPOSITORY_CHANGED",
    "INVALID_BACKUP",
    "SECRET_DETECTED",
    "COMMAND_APPROVAL_REQUIRED",
    "IO_ERROR",
    "GIT_ERROR",
  ]),
  message: z.string(),
  files: z.array(z.string()).nullish(),
  /** Echo back on the next push to approve exactly the payload that was blocked. */
  secretApproval: z.string().nullish(),
  /**
   * On COMMAND_APPROVAL_REQUIRED: every command the restore needs approved, so a restore
   * attempted without a preview, or after the backup drifted, can present the current
   * list instead of a stale or empty one.
   */
  commandApprovals: z.array(BackupCommandApprovalSchema).nullish(),
  /**
   * Set when a restore fails after its safety snapshot completed: files may already have
   * been overwritten, and the snapshot is the only recovery path, so a failure report
   * that omitted it would hide the copy the user needs.
   */
  snapshotPath: z.string().nullish(),
});

export const BackupFileChangeSchema = z.object({
  path: z.string(),
  status: z.string(),
});

export const BackupCredentialKindSchema = z.enum(["ssh", "gh", "ambient"]);

const BackupResult = <T extends z.ZodTypeAny>(schema: T) =>
  ResultSchema(schema, BackupOperationErrorSchema);

export const backup = {
  getSettings: {
    output: SettingsBackupSchema.nullable(),
  },
  saveSettings: {
    input: SettingsBackupInputSchema,
    output: BackupResult(SettingsBackupSchema),
  },
  validate: {
    input: SettingsBackupInputSchema,
    output: BackupResult(
      z.object({
        reachable: z.literal(true),
        credential: BackupCredentialKindSchema,
        empty: z.boolean(),
      })
    ),
  },
  preview: {
    input: SettingsBackupInputSchema,
    output: BackupResult(
      z.object({
        pushChanges: z.array(BackupFileChangeSchema),
        restoreChanges: z.array(BackupFileChangeSchema),
        localOnlyFiles: z.array(z.string()),
        redactions: z.array(z.string()),
        commandApprovals: z.array(BackupCommandApprovalSchema),
      })
    ),
  },
  push: {
    input: SettingsBackupInputSchema.extend({
      approvedSecretDigest: z.string().nullish(),
    }),
    output: BackupResult(
      z.object({
        commit: z.string(),
        changed: z.boolean(),
        credential: BackupCredentialKindSchema,
        redactions: z.array(z.string()),
      })
    ),
  },
  restore: {
    input: SettingsBackupInputSchema.extend({
      approvedCommandTokens: z.array(z.string()).nullish(),
    }),
    output: BackupResult(
      z.object({
        commit: z.string(),
        snapshotPath: z.string(),
        changedFiles: z.array(z.string()),
        localOnlyFiles: z.array(z.string()),
      })
    ),
  },
};

export type { SettingsBackupInput } from "@/common/config/schemas/settingsBackup";
export type BackupOperationError = z.infer<typeof BackupOperationErrorSchema>;
export type BackupFileChange = z.infer<typeof BackupFileChangeSchema>;
export type BackupCommandApproval = z.infer<typeof BackupCommandApprovalSchema>;
export type BackupCredentialKind = z.infer<typeof BackupCredentialKindSchema>;
