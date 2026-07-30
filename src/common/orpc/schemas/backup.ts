import { z } from "zod";
import { ResultSchema } from "./result";

export const SettingsBackupSchema = z.object({
  repoUrl: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  path: z.string().trim().min(1),
  lastPushedCommit: z.string().nullish(),
  lastRestoredCommit: z.string().nullish(),
});

export const BackupOperationErrorSchema = z.object({
  code: z.enum([
    "AUTH_FAILED",
    "REMOTE_UNREACHABLE",
    "REPOSITORY_CHANGED",
    "INVALID_BACKUP",
    "SECRET_DETECTED",
    "IO_ERROR",
    "GIT_ERROR",
  ]),
  message: z.string(),
  files: z.array(z.string()).nullish(),
});

export const BackupFileChangeSchema = z.object({
  path: z.string(),
  status: z.string(),
});

export const BackupCredentialKindSchema = z.enum(["ssh", "gh", "token", "ambient"]);

const SettingsBackupInputSchema = SettingsBackupSchema.omit({
  lastPushedCommit: true,
  lastRestoredCommit: true,
});

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
      })
    ),
  },
  push: {
    input: SettingsBackupInputSchema.extend({
      allowSecrets: z.boolean().nullish(),
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
    input: SettingsBackupInputSchema,
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

export type SettingsBackup = z.infer<typeof SettingsBackupSchema>;
export type SettingsBackupInput = z.infer<typeof SettingsBackupInputSchema>;
export type BackupOperationError = z.infer<typeof BackupOperationErrorSchema>;
export type BackupFileChange = z.infer<typeof BackupFileChangeSchema>;
export type BackupCredentialKind = z.infer<typeof BackupCredentialKindSchema>;
