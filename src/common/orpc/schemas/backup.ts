import { z } from "zod";
import { ResultSchema } from "./result";

/**
 * Backup paths must be portable to Git for Windows. This rejects reserved device names,
 * forbidden characters, and trailing dots or spaces for both managed and payload paths.
 */
const WINDOWS_RESERVED_NAMES =
  /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i;
const WINDOWS_INVALID_CHARACTERS = new Set([...'<>:"|?*']);

export function isWindowsUnusableSegment(segment: string): boolean {
  if (WINDOWS_RESERVED_NAMES.test(segment) || /[. ]$/.test(segment)) return true;
  return [...segment].some(
    (character) =>
      WINDOWS_INVALID_CHARACTERS.has(character) || (character.codePointAt(0) ?? 0) < 0x20
  );
}

/**
 * The managed subdirectory scopes every write and every `git clean`, so it must be a
 * real subdirectory. `.`, `..`, absolute paths, and backslashes would let a backup
 * reach outside the directory Mux is allowed to own.
 */
export function isValidBackupPath(value: string): boolean {
  const segments = value.split("/").filter((segment) => segment !== "");
  return (
    segments.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        // Writing into the cache clone's own git directory could install hooks.
        segment.toLowerCase() === ".git" ||
        isWindowsUnusableSegment(segment)
    )
  );
}

export const SettingsBackupSchema = z.object({
  repoUrl: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  path: z
    .string()
    .trim()
    .min(1)
    .refine(isValidBackupPath, { message: "Enter a subdirectory inside the repository" }),
  lastPushedCommit: z.string().optional(),
  lastRestoredCommit: z.string().optional(),
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
});

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

export type SettingsBackup = z.infer<typeof SettingsBackupSchema>;
export type SettingsBackupInput = z.infer<typeof SettingsBackupInputSchema>;
export type BackupOperationError = z.infer<typeof BackupOperationErrorSchema>;
export type BackupFileChange = z.infer<typeof BackupFileChangeSchema>;
export type BackupCommandApproval = z.infer<typeof BackupCommandApprovalSchema>;
export type BackupCredentialKind = z.infer<typeof BackupCredentialKindSchema>;
