import { z } from "zod";

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

/**
 * `https://TOKEN@host/repo.git` is a credential pasted into a URL: saving it would persist
 * the token in config.json and in the cache clone's `remote.origin.url`, and backups must
 * never store a credential. An ssh username (`git@`) is routing, not a secret, so ssh URLs
 * keep theirs; a password is rejected on every scheme. scp-like remotes (`git@host:path`)
 * fail to parse here and carry no password channel, so they pass.
 */
export function hasUrlCredentials(repoUrl: string): boolean {
  try {
    const url = new URL(repoUrl);
    return url.password !== "" || (url.protocol !== "ssh:" && url.username !== "");
  } catch {
    return false;
  }
}

/**
 * One definition for the persisted `settingsBackup` key and the IPC shape. Two schemas
 * would let config.json hold a value the `getSettings` response then rejects, leaving the
 * Backup screen unable to load what the user saved.
 */
export const SettingsBackupSchema = z.object({
  repoUrl: z
    .string()
    .trim()
    .min(1)
    .refine((value) => !hasUrlCredentials(value), {
      message: "Remove the credential embedded in the repository URL",
    }),
  branch: z.string().trim().min(1),
  path: z
    .string()
    .trim()
    .min(1)
    .refine(isValidBackupPath, { message: "Enter a subdirectory inside the repository" }),
  lastPushedCommit: z.string().optional(),
  lastRestoredCommit: z.string().optional(),
});

export type SettingsBackup = z.infer<typeof SettingsBackupSchema>;
