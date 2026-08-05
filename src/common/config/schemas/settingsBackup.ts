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

export const CREDENTIAL_URL_PARAMETER_NAMES: ReadonlySet<string> = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "appsecret",
  "auth",
  "authcode",
  "authorization",
  "authtoken",
  "awsaccesskeyid",
  "awssecretaccesskey",
  "bearer",
  "bearertoken",
  "clientkey",
  "clientsecret",
  "consumersecret",
  "credential",
  "credentials",
  "idtoken",
  "jwt",
  "oauthcode",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "secretkey",
  "sessionid",
  "signature",
  "token",
  "xamzcredential",
  "xamzsignature",
]);

function parametersContainCredential(
  parameters: URLSearchParams,
  names: ReadonlySet<string>
): boolean {
  for (const [name, value] of parameters) {
    const normalizedName = name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (value !== "" && names.has(normalizedName)) return true;
  }
  return false;
}

function fragmentContainsCredential(fragment: string, names: ReadonlySet<string>): boolean {
  if (parametersContainCredential(new URLSearchParams(fragment), names)) return true;
  const queryStart = fragment.indexOf("?");
  return (
    queryStart >= 0 &&
    parametersContainCredential(new URLSearchParams(fragment.slice(queryStart + 1)), names)
  );
}

export function hasCredentialUrlParameters(
  rawUrl: string,
  names: ReadonlySet<string> = CREDENTIAL_URL_PARAMETER_NAMES
): boolean {
  const fragmentStart = rawUrl.indexOf("#");
  const beforeFragment = fragmentStart >= 0 ? rawUrl.slice(0, fragmentStart) : rawUrl;
  const queryStart = beforeFragment.indexOf("?");
  const query = queryStart >= 0 ? beforeFragment.slice(queryStart + 1) : "";
  const fragment = fragmentStart >= 0 ? rawUrl.slice(fragmentStart + 1) : "";
  return (
    parametersContainCredential(new URLSearchParams(query), names) ||
    fragmentContainsCredential(fragment, names)
  );
}

/**
 * Repository URLs are persisted in config and cache git metadata, so userinfo credentials and
 * known credential parameters are rejected. SSH usernames are routing data; scp-like remotes have
 * no password field and remain allowed.
 */
export function hasUrlCredentials(repoUrl: string): boolean {
  if (hasCredentialUrlParameters(repoUrl)) return true;
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
