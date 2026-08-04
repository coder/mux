import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as jsonc from "jsonc-parser";
import {
  UserPreferencesSchema,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";
import { isWindowsUnusableSegment } from "@/common/config/schemas/settingsBackup";
import type { BackupCommandApproval } from "@/common/orpc/schemas/backup";

export const BACKUP_SCHEMA_VERSION = 1;
const BACKUP_MANIFEST_FILE = "manifest.json";
/**
 * A payload is read wholly into memory on both sides, and the repository side is written by
 * whoever can push to the branch, so an oversized entry would crash the main process during
 * a plain Preview. Settings are text, so these bounds are far above any real backup.
 */
export const MAX_BACKUP_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_BACKUP_TOTAL_BYTES = 64 * 1024 * 1024;
export const REDACTED_BACKUP_VALUE = "__MUX_BACKUP_REDACTED__";

const FORBIDDEN_BASENAMES = new Set(
  [
    "providers.jsonc",
    "secrets.json",
    "mcp-oauth.json",
    "server.lock",
    "serverAuthSessions.json",
    "AGENTS.local.md",
    "memory-meta.json",
  ].map((name) => name.toLowerCase())
);

/** Case-insensitive: a differently-cased name resolves to the same file on Windows and macOS. */
function isForbiddenBasename(name: string): boolean {
  return FORBIDDEN_BASENAMES.has(name.toLowerCase());
}

/**
 * No hidden file is portable settings content, and the recursive collections (`skills/`,
 * `memory/global/`) would otherwise sweep up whatever a directory happens to contain. The
 * names that show up there are credential and tooling files: `.env` and its variants,
 * `.netrc`, `.npmrc`, and the `.git` directory of a skill installed by cloning, which holds
 * an object database and remote URLs with credentials. The secret scanner is not a safety
 * net for these, because a value like `PASSWORD=hunter2` matches none of its patterns.
 *
 * Applied to every path segment, so a hidden directory is not backed up either, and shared
 * with payload validation so a backup cannot deliver one back.
 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}
const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[A-Za-z0-9_-]{35,}/,
  /\bxoxb-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
] as const;

export interface BackupFile {
  path: string;
  content: Buffer;
  executable?: boolean;
}

export interface BackupManifestFile {
  path: string;
  sha256: string;
  executable?: boolean;
}

export interface BackupManifest {
  schemaVersion: typeof BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  muxVersion: string;
  sourceLabel: string;
  files: BackupManifestFile[];
}

export interface BackupPayload {
  manifest: BackupManifest;
  files: BackupFile[];
  redactions: string[];
}

export interface CreateBackupPayloadOptions {
  muxRoot: string;
  preferences?: UserPreferences;
  muxVersion: string;
  sourceLabel: string;
  exportedAt?: string;
  /**
   * Return detected secrets in the payload instead of throwing, so a caller that
   * owns the user-facing override can decide whether to proceed.
   */
  reportSecrets?: boolean;
  /**
   * Keep MCP credentials verbatim. Only for the local safety snapshot: a redacted
   * snapshot cannot restore a credential whose server the restore removed, and the
   * snapshot never leaves this machine.
   */
  keepLocalSecrets?: boolean;
}

export interface RestoreBackupPayloadOptions {
  muxRoot: string;
  payload: BackupPayload;
  approvedCommandTokens?: readonly string[];
}

export class BackupCommandApprovalRequiredError extends Error {
  readonly code = "COMMAND_APPROVAL_REQUIRED";

  constructor(readonly approvals: readonly BackupCommandApproval[]) {
    super(
      "This backup would replace executable MCP commands. Review and approve them before restoring."
    );
    this.name = "BackupCommandApprovalRequiredError";
  }

  /** The paths the UI lists, matching how `SECRET_DETECTED` reports blocked files. */
  get files(): string[] {
    return this.approvals.map((approval) => `${approval.path}: ${approval.command}`);
  }
}

export interface RestoreBackupPayloadResult {
  /**
   * The backup's preferences document, unmerged and absent when the payload carries none.
   * Merging belongs to the caller so it can read the current config inside the same
   * serialized edit that writes the result.
   */
  backupPreferences?: unknown;
  localOnlyFiles: string[];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function toPosixPath(...parts: string[]): string {
  return parts.join("/");
}

function isAllowedPayloadPath(relativePath: string): boolean {
  if (relativePath === "AGENTS.md" || relativePath === "mcp.jsonc") return true;
  if (relativePath === "preferences.json") return true;
  if (/^agents\/[^/]+\.md$/.test(relativePath)) return true;
  if (/^skills\/.+/.test(relativePath)) return true;
  return /^memory\/global\/.+/.test(relativePath);
}

/**
 * Local safety snapshots use `portable: false` so cross-platform filename checks cannot block
 * a restore while protecting a file valid on the current filesystem. Containment and allowlist
 * checks still apply.
 */
function assertAllowedPayloadPath(
  relativePath: string,
  options: { portable: boolean } = { portable: true }
): void {
  if (
    !isAllowedPayloadPath(relativePath) ||
    path.isAbsolute(relativePath) ||
    // Payload paths are always posix. A backslash is an ordinary filename character
    // here but a separator on Windows, so `skills/..\..\evil` would escape the
    // destination once path.join runs there. A local snapshot never travels, and
    // resolveContainedPath still rejects traversal and symlinked ancestors either way.
    (options.portable && relativePath.includes("\\")) ||
    relativePath
      .split("/")
      .some(
        (segment) =>
          segment === ".." ||
          isHiddenName(segment) ||
          (options.portable && isWindowsUnusableSegment(segment))
      ) ||
    isForbiddenBasename(path.posix.basename(relativePath))
  ) {
    throw new Error(`Backup contains disallowed path '${relativePath}'`);
  }
}

async function lstatOrNull(target: string) {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/**
 * Every collected local path that is the same file as a given payload path, absent when the
 * payload path names nothing collected, which is the ordinary case of a file restore creates.
 *
 * Comparing the spellings cannot answer this. On a case-insensitive or normalization-folding
 * volume `skills/demo/Foo.md` and `skills/demo/foo.md` are one file, and on a case-sensitive
 * one they are two, so folding is wrong on the second and a literal match is wrong on the
 * first. Only the filesystem knows which it is, so ask it: paths name one file when it
 * reports one identity for them. All of them are kept, because a hard link means an identity
 * can have any number of names and writing the file changes what every one of them reads.
 */
async function localFilesOverwrittenByPayload(
  muxRoot: string,
  localPaths: Iterable<string>,
  payloadPaths: Iterable<string>
): Promise<Map<string, string[]>> {
  const byIdentity = new Map<string, string[]>();
  for (const localPath of localPaths) {
    const identity = await fileIdentity(muxRoot, localPath);
    if (identity === null) continue;
    const names = byIdentity.get(identity);
    if (names === undefined) byIdentity.set(identity, [localPath]);
    else names.push(localPath);
  }
  const overwritten = new Map<string, string[]>();
  for (const payloadPath of payloadPaths) {
    const identity = await fileIdentity(muxRoot, payloadPath);
    const names = identity === null ? undefined : byIdentity.get(identity);
    if (names !== undefined) overwritten.set(payloadPath, names);
  }
  return overwritten;
}

async function fileIdentity(muxRoot: string, relativePath: string): Promise<string | null> {
  const stat = await lstatOrNull(path.join(muxRoot, ...relativePath.split("/")));
  return stat === null ? null : `${stat.dev}:${stat.ino}`;
}

/**
 * Local files a restore of this payload would leave untouched: the ones that share no name
 * with a restored path and are not the same file as one under another spelling.
 */
export async function localOnlyPayloadFiles(
  muxRoot: string,
  localPaths: Iterable<string>,
  restoredPaths: ReadonlySet<string>
): Promise<{ localOnly: string[]; overwritten: Map<string, string[]> }> {
  const locals = [...localPaths];
  const overwritten = await localFilesOverwrittenByPayload(muxRoot, locals, restoredPaths);
  const overwrittenLocals = new Set([...overwritten.values()].flat());
  return {
    localOnly: locals
      .filter((file) => !restoredPaths.has(file) && !overwrittenLocals.has(file))
      .sort(),
    overwritten,
  };
}

/**
 * Joins a posix relative path onto a root, rejecting any component that is a symlink.
 * Git stores symlinks (mode 120000), so a backup repository can contain one; reading or
 * writing through it would escape the directory this feature is allowed to touch.
 */
export async function resolveContainedPath(root: string, relativePath: string): Promise<string> {
  const segments = relativePath.split("/");
  let current = root;
  for (const [index, segment] of segments.entries()) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Backup contains disallowed path '${relativePath}'`);
    }
    current = path.join(current, segment);
    const existing = await lstatOrNull(current);
    if (existing?.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink '${relativePath}'`);
    }
    // A non-directory in the middle of the path would make mkdir fail mid-write.
    if (index < segments.length - 1 && existing !== null && !existing.isDirectory()) {
      throw new Error(`Cannot use '${relativePath}': a parent path is not a directory`);
    }
  }
  return current;
}

function megabytes(bytes: number): string {
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

/** Checked before each read, so an oversized entry is never buffered. */
function createByteBudget() {
  let used = 0;
  return function take(relativePath: string, size: number): void {
    if (size > MAX_BACKUP_FILE_BYTES) {
      throw new Error(
        `'${relativePath}' is larger than the ${megabytes(MAX_BACKUP_FILE_BYTES)} limit for one backup file`
      );
    }
    used += size;
    if (used > MAX_BACKUP_TOTAL_BYTES) {
      throw new Error(`Backup is larger than the ${megabytes(MAX_BACKUP_TOTAL_BYTES)} total limit`);
    }
  };
}

type ByteBudget = ReturnType<typeof createByteBudget>;

/**
 * Two paths collide when the filesystem cannot tell them apart, so the comparison has to fold
 * the same things a filesystem does. Case is the obvious one, and macOS also normalizes: NFC
 * `café.md` and its NFD spelling are one file there while they differ byte for byte, so
 * case-folding alone would let the second entry silently overwrite the first.
 */
function collisionKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Confirms the path just opened still holds no symlink between the root and the file, and that
 * the file it named is the file the handle holds.
 *
 * `O_NOFOLLOW` covers only the last component and Node exposes no `openat`, so an ancestor
 * directory swapped for a symlink between the checks and the open cannot be prevented, only
 * detected. Comparing the opened handle's identity with the identity the verified walk arrives
 * at is what does the detecting: a component put back after the open still leaves a different
 * file in hand.
 *
 * What this closes is a backup repository choosing a path that escapes the root, and a symlink
 * planted under the root beforehand. It is not atomic, and it does not claim to be: every check
 * here re-resolves a pathname, so a local process that can rename the root repeatedly while a
 * restore runs can still thread its way between them. Closing that needs directory-relative
 * opens (`openat`/`O_PATH`), which Node does not expose. A process with that access can write
 * these files directly anyway, so the pathname checks are the boundary that pays off.
 */
async function assertOpenedFileContained(
  root: BackupRoot,
  relativePath: string,
  opened: { dev: number; ino: number }
): Promise<void> {
  // The root is checked by identity, not by name: `realpath` returned a pathname, and a
  // pathname can be made to point somewhere else afterwards. Node cannot pin a directory, so
  // the check is that the canonical root is still the same directory this operation started on.
  const rootStat = await fs.lstat(root.path);
  if (rootStat.isSymbolicLink() || rootStat.dev !== root.dev || rootStat.ino !== root.ino) {
    throw new Error(`Refusing to use '${relativePath}': the backup root was replaced`);
  }
  let current = root.path;
  let last: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    last = await fs.lstat(current);
    if (last.isSymbolicLink()) throw new Error(`Refusing to follow symlink '${relativePath}'`);
  }
  if (last === undefined || last.dev !== opened.dev || last.ino !== opened.ino) {
    throw new Error(`Refusing to use '${relativePath}': it was replaced while being opened`);
  }
}

/**
 * Resolved once where an operation begins, so every open and check below it uses that result.
 * The root being a symlink is then neither refused nor traversed again: a user is free to keep
 * `~/.mux` on another volume, and swapping that link partway through cannot move an operation
 * already under way onto a different tree. Only the components below the root are held to the
 * no-symlink rule.
 */
interface BackupRoot {
  path: string;
  dev: number;
  ino: number;
}

async function resolveRoot(root: string): Promise<BackupRoot> {
  const canonical = await fs.realpath(root);
  const stat = await fs.lstat(canonical);
  if (!stat.isDirectory()) throw new Error(`'${root}' is not a directory`);
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

function noFollowFlag(): number {
  // Absent on Windows, where a file cannot be swapped for a junction this way.
  return fs.constants.O_NOFOLLOW ?? 0;
}

function absolutePathOf(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

/**
 * Reads a file through one handle, so the size that was checked is the size that is read.
 * Reopening the path after a `stat` lets a file that grew in between defeat the byte budget,
 * and lets a symlink installed in between be followed after the checks said there was none.
 * The window is ordinary rather than adversarial here: agents write under this root while a
 * Preview or Push is running.
 */
async function readCheckedFile(
  root: BackupRoot,
  relativePath: string,
  charge: (size: number) => void
): Promise<{ content: Buffer; mode: number; identity: FileIdentityStat }> {
  const handle = await fs.open(
    absolutePathOf(root.path, relativePath),
    fs.constants.O_RDONLY | noFollowFlag()
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Refusing to read '${relativePath}': not a regular file`);
    await assertOpenedFileContained(root, relativePath, stat);
    charge(stat.size);
    const content = Buffer.alloc(stat.size);
    let filled = 0;
    while (filled < stat.size) {
      const { bytesRead } = await handle.read(content, filled, stat.size - filled, filled);
      // A file truncated while being read yields short, which is the bound holding rather
      // than an error: the caller's checksum decides whether the result is usable.
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return {
      content: filled === stat.size ? content : content.subarray(0, filled),
      mode: stat.mode,
      identity: { dev: stat.dev, ino: stat.ino, nlink: stat.nlink },
    };
  } finally {
    await handle.close();
  }
}

interface FileIdentityStat {
  dev: number;
  ino: number;
  nlink: number;
}

/**
 * `nlink` says how many names a file has but not where they are, so a single read cannot
 * tell an alias inside the root from one outside it. The collection as a whole can: when
 * every name a file has was itself collected, all its aliases are inside the backed-up set,
 * and any excess means a name somewhere this walk cannot see. A hard link to a file outside
 * the root carries that file's bytes past the allowlist the same way the symlinks this
 * feature already refuses would, so the unprovable case is refused too. Aliases inside the
 * set stay allowed: they are how a case-folding volume's one-file-many-spellings behaves,
 * and every one of them is content the backup already carries.
 */
function createHardLinkTracker() {
  const identities = new Map<string, { nlink: number; names: string[] }>();
  return {
    record(relativePath: string, identity: FileIdentityStat): void {
      if (identity.nlink <= 1) return;
      const key = `${identity.dev}:${identity.ino}`;
      const entry = identities.get(key);
      if (entry === undefined) {
        identities.set(key, { nlink: identity.nlink, names: [relativePath] });
      } else {
        entry.names.push(relativePath);
      }
    },
    assertContained(): void {
      for (const { nlink, names } of identities.values()) {
        if (nlink > names.length) {
          throw new Error(
            `Refusing to use '${names[0] ?? ""}': it is hard-linked to a file outside the backed-up files`
          );
        }
      }
    },
  };
}

type HardLinkTracker = ReturnType<typeof createHardLinkTracker>;

/**
 * Writes a file through one handle, opened without following a symlink and verified to be the
 * file inside the root that was planned before anything is written to it. Deliberately not
 * `O_TRUNC`: truncation happens after the verification, so a destination that turned out to be
 * somewhere else is not emptied on the way to finding that out. The mode is set on the handle
 * rather than the path for the same reason.
 */
async function writeCheckedFile(
  root: BackupRoot,
  relativePath: string,
  content: Buffer,
  executable: boolean
): Promise<void> {
  const destination = absolutePathOf(root.path, relativePath);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const { handle, stat } = await openSeveredWriteHandle(root, relativePath, destination);
  try {
    await handle.truncate(0);
    let written = 0;
    while (written < content.length) {
      // A short write resolves successfully, so the count decides when the file is complete:
      // treating the first call as the whole write would publish a truncated file as a
      // finished one.
      const { bytesWritten } = await handle.write(
        content,
        written,
        content.length - written,
        written
      );
      if (bytesWritten === 0) {
        throw new Error(`Could not finish writing '${relativePath}'`);
      }
      written += bytesWritten;
    }
    // Git records one bit per file, so mirror `chmod +x` / `chmod -x` and leave the read and
    // write bits to the local umask rather than inventing a source mode.
    const next = executable ? stat.mode | ((stat.mode & 0o444) >> 2) : stat.mode & ~0o111;
    if (next !== stat.mode) await handle.chmod(next);
  } finally {
    await handle.close();
  }
}

/**
 * Opens the destination for writing, verified to be the planned file inside the root, and
 * never a name shared with another one. Writing through a multi-link file updates every one
 * of its names, and `nlink` cannot say whether one of them is outside the root, where a
 * write would land backup-controlled bytes in a file the containment walk never approved.
 * Instead of refusing, the name is severed: unlinked and recreated exclusively, so the write
 * lands in a fresh file only this name reads. On the volumes whose behavior in-root aliases
 * simulate, all spellings are one directory entry and severing is indistinguishable from
 * writing in place.
 */
async function openSeveredWriteHandle(
  root: BackupRoot,
  relativePath: string,
  destination: string
): Promise<{ handle: fs.FileHandle; stat: Stats }> {
  const opened = await fs.open(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | noFollowFlag()
  );
  try {
    const stat = await opened.stat();
    await assertOpenedFileContained(root, relativePath, stat);
    if (stat.nlink <= 1) return { handle: opened, stat };
  } catch (error) {
    await opened.close();
    throw error;
  }
  await opened.close();
  await fs.unlink(destination);
  const fresh = await fs.open(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag()
  );
  try {
    const stat = await fresh.stat();
    await assertOpenedFileContained(root, relativePath, stat);
    return { handle: fresh, stat };
  } catch (error) {
    await fresh.close();
    throw error;
  }
}

async function readBackupFile(
  root: BackupRoot,
  relativePath: string,
  budget: ByteBudget,
  links: HardLinkTracker
): Promise<BackupFile> {
  const { content, mode, identity } = await readCheckedFile(root, relativePath, (size) =>
    budget(relativePath, size)
  );
  links.record(relativePath, identity);
  return { path: relativePath, content, executable: (mode & 0o111) !== 0 };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * lstat, not stat: a symlinked entry would let the closed allowlist export whatever it
 * points at (`AGENTS.md -> ~/company-secrets.txt`). Symlinks are not backed up.
 */
async function isRegularFile(filePath: string): Promise<boolean> {
  return (await lstatOrNull(filePath))?.isFile() === true;
}

async function collectDirectory(
  root: BackupRoot,
  relativeRoot: string,
  filter: (relativePath: string, entry: Dirent) => boolean,
  output: BackupFile[],
  budget: ByteBudget,
  links: HardLinkTracker
): Promise<void> {
  const absoluteRoot = path.join(root.path, ...relativeRoot.split("/"));
  // A symlinked collection root would let readdir walk outside MUX_ROOT, and restore
  // refuses to write through symlinks anyway, so they are simply not backed up.
  if ((await lstatOrNull(absoluteRoot))?.isSymbolicLink() === true) return;

  let entries: Dirent[];
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (isHiddenName(entry.name)) continue;
    const relativePath = toPosixPath(relativeRoot, entry.name);
    if (!filter(relativePath, entry)) continue;
    if (entry.isDirectory()) {
      await collectDirectory(root, relativePath, filter, output, budget, links);
    } else if (entry.isFile() && !isForbiddenBasename(entry.name)) {
      output.push(await readBackupFile(root, relativePath, budget, links));
    }
  }
}

export async function collectAllowlistedFiles(muxRoot: string): Promise<BackupFile[]> {
  const root = await resolveRoot(muxRoot);
  const files: BackupFile[] = [];
  const budget = createByteBudget();
  const links = createHardLinkTracker();
  for (const relativePath of ["AGENTS.md", "mcp.jsonc"]) {
    if (await isRegularFile(path.join(root.path, relativePath))) {
      files.push(await readBackupFile(root, relativePath, budget, links));
    }
  }

  await collectDirectory(
    root,
    "agents",
    (relativePath, entry) => entry.isDirectory() || /^agents\/[^/]+\.md$/.test(relativePath),
    files,
    budget,
    links
  );
  await collectDirectory(root, "skills", () => true, files, budget, links);
  await collectDirectory(root, "memory/global", () => true, files, budget, links);
  links.assertContained();
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function serializeBackupPreferences(preferences: unknown): Buffer {
  return Buffer.from(
    `${JSON.stringify(projectBackupPreferences(preferences), null, 2)}\n`,
    "utf-8"
  );
}

type Appearance = NonNullable<UserPreferences["appearance"]>;

/**
 * `editorConfig` is excluded on purpose. `customCommand` is executed as a shell command
 * by `EditorService.openInEditor`, so restoring it from a repository would let whoever
 * can write to that repository run a command here. The editor is machine-local anyway,
 * since its binary has to exist on the machine.
 */
const BACKED_UP_APPEARANCE_FIELDS = [
  "theme",
  "transcriptDensity",
  "bashCollapsedSummaryMode",
  "terminalFontConfig",
  "vimEnabled",
] as const satisfies ReadonlyArray<keyof Appearance>;

function projectAppearance(value: Appearance | undefined): Appearance | undefined {
  if (!value) return undefined;
  const projected: Appearance = {};
  for (const field of BACKED_UP_APPEARANCE_FIELDS) {
    if (value[field] !== undefined) {
      Object.assign(projected, { [field]: copyJson(value[field]) });
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

type BackupProviderOptions = NonNullable<NonNullable<UserPreferences["ai"]>["providerOptions"]>;

/**
 * Of the providers `UserPreferencesSchema` can hold, only `anthropic` has a closed
 * `z.object` schema, so parsing already dropped undeclared keys. `google` is
 * `z.record(z.string(), z.unknown())`, which would carry an `apiKey` straight into the
 * backup, so it is excluded. A provider added later is excluded until it is listed here,
 * which fails closed, and `satisfies` rejects a name the preferences schema cannot hold.
 */
const BACKED_UP_PROVIDER_OPTIONS = ["anthropic"] as const satisfies ReadonlyArray<
  keyof BackupProviderOptions
>;

function projectProviderOptions(value: unknown): BackupProviderOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const provider of BACKED_UP_PROVIDER_OPTIONS) {
    if (source[provider] !== undefined) projected[provider] = copyJson(source[provider]);
  }
  return Object.keys(projected).length > 0 ? (projected as BackupProviderOptions) : undefined;
}

export function projectBackupPreferences(value: unknown): UserPreferences {
  const parsed = UserPreferencesSchema.parse(value ?? {});
  const projected: UserPreferences = {};

  const appearance = projectAppearance(parsed.appearance);
  if (appearance !== undefined) projected.appearance = appearance;
  if (parsed.navigation?.launchBehavior !== undefined) {
    projected.navigation = { launchBehavior: parsed.navigation.launchBehavior };
  }
  if (parsed.ai) {
    const ai: NonNullable<UserPreferences["ai"]> = {};
    if (parsed.ai.globalDefaults !== undefined) {
      ai.globalDefaults = copyJson(parsed.ai.globalDefaults);
    }
    const providerOptions = projectProviderOptions(parsed.ai.providerOptions);
    if (providerOptions !== undefined) ai.providerOptions = providerOptions;
    if (parsed.ai.autoCompactionThresholdByModel !== undefined) {
      ai.autoCompactionThresholdByModel = copyJson(parsed.ai.autoCompactionThresholdByModel);
    }
    if (Object.keys(ai).length > 0) projected.ai = ai;
  }
  if (parsed.review?.includeUncommitted !== undefined) {
    projected.review = { includeUncommitted: parsed.review.includeUncommitted };
  }

  return projected;
}

type AiPreferences = NonNullable<UserPreferences["ai"]>;

/**
 * Provider options merge per provider rather than wholesale, because the record-typed
 * providers are deliberately excluded from a backup. Replacing the object would delete
 * settings the backup never had the chance to carry.
 */
function mergeAiPreferences(current: AiPreferences | undefined, projected: AiPreferences) {
  const merged: AiPreferences = { ...current, ...projected };
  if (projected.providerOptions !== undefined) {
    merged.providerOptions = { ...current?.providerOptions, ...projected.providerOptions };
  }
  return merged;
}

export function mergeBackupPreferences(
  current: UserPreferences | undefined,
  backup: unknown
): UserPreferences {
  const projected = projectBackupPreferences(backup);
  return UserPreferencesSchema.parse({
    ...(current ?? {}),
    ...(projected.appearance
      ? { appearance: { ...current?.appearance, ...projected.appearance } }
      : {}),
    ...(projected.navigation
      ? { navigation: { ...current?.navigation, ...projected.navigation } }
      : {}),
    ...(projected.ai ? { ai: mergeAiPreferences(current?.ai, projected.ai) } : {}),
    ...(projected.review ? { review: { ...current?.review, ...projected.review } } : {}),
  });
}

/**
 * `MCPHeaderValue` is `string | { secret }` (src/common/types/mcp.ts), so Mux sends a plain
 * string verbatim and never interpolates it: only the reference form is portable. Exactly one
 * key, because a sibling property inside the reference would be published verbatim and is a
 * place to hide a credential that `resolveHeaders` would never read.
 */
function isPortableReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 1 && typeof record.secret === "string" && record.secret.trim() !== "";
}

/**
 * `jsonc.parse` collapses duplicate keys but `jsonc.modify` rewrites only one occurrence,
 * so a duplicated header would leave the second credential in the exported file. Redaction
 * cannot be guaranteed complete for such a file, so refuse it instead.
 */
function assertNoDuplicateKeys(tree: jsonc.Node, fileName: string): void {
  const visit = (node: jsonc.Node): void => {
    if (node.type === "object") {
      const names = new Set<string>();
      for (const property of node.children ?? []) {
        const name: unknown = property.children?.[0]?.value;
        if (typeof name === "string") {
          if (names.has(name)) throw new Error(`Invalid ${fileName}: duplicate key '${name}'`);
          names.add(name);
        }
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

function parseJsoncObjectWithTree(
  raw: string,
  fileName: string
): { parsed: Record<string, unknown>; tree: jsonc.Node } {
  const errors: jsonc.ParseError[] = [];
  const parsed: unknown = jsonc.parse(raw, errors);
  const tree = jsonc.parseTree(raw);
  if (
    errors.length > 0 ||
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    tree?.type !== "object"
  ) {
    throw new Error(`Invalid ${fileName}`);
  }
  assertNoDuplicateKeys(tree, fileName);
  return { parsed: parsed as Record<string, unknown>, tree };
}

function parseJsoncObject(raw: string, fileName: string): Record<string, unknown> {
  return parseJsoncObjectWithTree(raw, fileName).parsed;
}

const JSONC_EDIT_OPTIONS: jsonc.ModificationOptions = {
  formattingOptions: { tabSize: 2, insertSpaces: true },
};

/**
 * Rewrites values in place with jsonc edits, leaving the rest of the document as it was.
 * Restore needs that: it writes the file the user just previewed, not a reformatted copy.
 */
function applyJsoncEdits(text: string, edits: Array<{ path: jsonc.JSONPath; value: unknown }>) {
  let result = text;
  for (const edit of edits) {
    result = jsonc.applyEdits(
      result,
      jsonc.modify(result, edit.path, edit.value, JSONC_EDIT_OPTIONS)
    );
  }
  return result;
}

/**
 * `McpConfigService.readConfigFile` enumerates `servers` with `Object.entries`, so an array or
 * a string there becomes runnable servers named by index rather than being ignored. A document
 * like that cannot be projected field by field, so an export redacts the whole map and a
 * restore refuses the backup instead of passing a shape the runtime accepts through unexamined.
 * A falsy value is not this case: the runtime returns no servers at all for it.
 */
function isUnsupportedServerMap(value: unknown): boolean {
  return Boolean(value) && (typeof value !== "object" || Array.isArray(value));
}

/**
 * Fields Mux itself reads (`McpConfigService.normalizeEntry`), with the type it reads them as.
 * Anything else in the document, at any depth, is replaced with the marker: `normalizeEntry`
 * ignores an unrecognised field such as `env` or `args`, so nobody here can say whether its
 * value is a credential, and `{ "API_KEY": "hunter2" }` is not something a scanner can catch.
 * Restore puts the local value back at that exact path, so a field only Mux ignores is not
 * lost from a machine that already has it.
 */
const PORTABLE_SERVER_FIELDS: Record<string, (value: unknown) => boolean> = {
  transport: (value) =>
    value === "stdio" || value === "http" || value === "sse" || value === "auto",
  disabled: (value) => typeof value === "boolean",
  toolAllowlist: (value) => Array.isArray(value) && value.every((tool) => typeof tool === "string"),
};

/**
 * A jsonc edit keeps every comment, and a comment is prose the projection cannot inspect, so a
 * local `// token=hunter2` beside a server would be published verbatim and the scanner would
 * not recognise it either. Reserializing publishes only the values this file kept.
 */
function serializeProjectedMcp(text: string): Buffer {
  const projected: unknown = jsonc.parse(text);
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) {
    throw new Error("Invalid mcp.jsonc");
  }
  return Buffer.from(`${JSON.stringify(projected, null, 2)}\n`, "utf-8");
}

function redactMcpConfig(content: Buffer): { content: Buffer; redactions: string[] } {
  const text = content.toString("utf-8");
  const { parsed: root, tree } = parseJsoncObjectWithTree(text, "mcp.jsonc");
  const redactions: string[] = [];
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];

  function redact(jsonPath: jsonc.JSONPath): void {
    edits.push({ path: jsonPath, value: REDACTED_BACKUP_VALUE });
    redactions.push(jsonPath.join("."));
  }

  // Names come from the document rather than the parse result throughout, because
  // `jsonc.parse` drops a `__proto__` key while the text keeps it. Enumerating the parsed
  // object would leave such a key, and its value, published verbatim.
  for (const key of objectKeyNames(tree, [])) {
    if (key !== "servers") redact([key]);
  }

  const servers = readOwn(root, "servers");
  if (isUnsupportedServerMap(servers)) redact(["servers"]);
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return { content: serializeProjectedMcp(applyJsoncEdits(text, edits)), redactions };
  }
  const serverRecord = servers as Record<string, unknown>;

  for (const serverName of objectKeyNames(tree, ["servers"])) {
    const rawServer = readOwn(serverRecord, serverName);
    // A bare string entry is the stdio command itself (mcpConfigService.normalizeEntry). An
    // entry the parser dropped, or one of any other shape, cannot be inspected field by field.
    if (typeof rawServer !== "object" || rawServer === null || Array.isArray(rawServer)) {
      redact(["servers", serverName]);
      continue;
    }
    const server = rawServer as Record<string, unknown>;

    for (const field of objectKeyNames(tree, ["servers", serverName])) {
      const fieldPath: jsonc.JSONPath = ["servers", serverName, field];
      const value = readOwn(server, field);
      const isPortableField = PORTABLE_SERVER_FIELDS[field];
      if (isPortableField) {
        // Read as the wrong type, `normalizeEntry` ignores it, which makes it another place
        // to hide a value nobody reads.
        if (!isPortableField(value)) redact(fieldPath);
        continue;
      }
      if (field === "headers") {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          redact(fieldPath);
          continue;
        }
        const headers = value as Record<string, unknown>;
        for (const headerName of objectKeyNames(tree, fieldPath)) {
          if (!isPortableReference(readOwn(headers, headerName))) {
            redact([...fieldPath, headerName]);
          }
        }
        continue;
      }
      // Everything else, `command` and `url` included, is replaced wholesale and never parsed
      // for the credential inside it. A command is arbitrary shell text handed to
      // `runtime.exec()`, so deciding which fragments are secret means reimplementing the
      // argument grammar of every tool a user might invoke. A url is no better: the credential
      // can sit in the userinfo, a query value, the path (`/access/abc123`), the fragment, or
      // the hostname of a per-tenant endpoint, each spelled however the provider chose, and a
      // low-entropy token defeats the scanner too. Neither is very portable anyway, and restore
      // puts the local value back at that exact path.
      redact(fieldPath);
    }
  }
  return { content: serializeProjectedMcp(applyJsoncEdits(text, edits)), redactions };
}

/** Reports what a payload had redacted, so reading one back describes the same paths. */
function findMcpRedactions(content: Buffer): string[] {
  const { parsed: root, tree } = parseJsoncObjectWithTree(content.toString("utf-8"), "mcp.jsonc");
  const redactions: string[] = [];

  function walk(value: unknown, jsonPath: jsonc.JSONPath): void {
    if (typeof value === "string") {
      if (containsRedaction(value)) redactions.push(jsonPath.join("."));
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    for (const key of objectKeyNames(tree, jsonPath)) {
      walk(readOwn(record, key), [...jsonPath, key]);
    }
  }

  walk(root, []);
  return redactions;
}

/**
 * Documentation is the only thing a recursive collection publishes without asking. `skills/`
 * and `memory/global/` hold whatever the user put there, and no content scanner can decide
 * whether an arbitrary file is a credential: `{"password":"hunter2"}` has no distinguishing
 * shape. So the gate is structural rather than pattern-based, and anything outside the
 * documented set is surfaced for review instead of being published or silently dropped.
 */
const AUTO_PUBLISHED_RECURSIVE_FILE = /\.(?:md|mdx|markdown|txt)$/i;

/** A name promising credentials earns review even when the extension is documentation. */
const CREDENTIAL_PATH_HINT =
  /(?:^|[^a-z])(?:credential|credentials|secret|secrets|password|passwords|token|tokens|apikey|netrc|keychain|htpasswd)(?:[^a-z]|$)/i;

function isRecursivelyCollected(filePath: string): boolean {
  return filePath.startsWith("skills/") || filePath.startsWith("memory/global/");
}

/**
 * Files a push must not publish until the user approves this exact payload. Not all of them
 * hold a secret: the structural cases are suspicion rather than detection.
 */
export function scanBackupFilesForSecrets(files: readonly BackupFile[]): string[] {
  return files
    .filter((file) => {
      const content = file.content.toString("utf-8");
      if (SECRET_PATTERNS.some((pattern) => pattern.test(content))) return true;
      if (!isRecursivelyCollected(file.path)) return false;
      return !AUTO_PUBLISHED_RECURSIVE_FILE.test(file.path) || CREDENTIAL_PATH_HINT.test(file.path);
    })
    .map((file) => file.path)
    .sort();
}

/**
 * Binds an override to the exact bytes it was shown for. A bare boolean would let approval of
 * one blocked set authorize a later push whose payload another window changed in between.
 */
export function backupSecretApprovalDigest(
  files: readonly BackupFile[],
  flaggedPaths: readonly string[]
): string {
  const flagged = new Set(flaggedPaths);
  // JSON for the same reason as backupCommandApprovalToken: no delimiter is unambiguous
  // once a component can contain it. Paths are portable-checked today, but the digest must
  // not depend on that staying true.
  const parts = files
    .filter((file) => flagged.has(file.path))
    .map((file) => [file.path, sha256(file.content)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256(Buffer.from(JSON.stringify(parts), "utf-8"));
}

export async function createBackupPayload(
  options: CreateBackupPayloadOptions
): Promise<BackupPayload> {
  const files = await collectAllowlistedFiles(options.muxRoot);
  const redactions: string[] = [];
  const mcpFile = files.find((file) => file.path === "mcp.jsonc");
  if (mcpFile && options.keepLocalSecrets !== true) {
    const redacted = redactMcpConfig(mcpFile.content);
    mcpFile.content = redacted.content;
    redactions.push(...redacted.redactions);
  }
  files.push({
    path: "preferences.json",
    content: serializeBackupPreferences(options.preferences),
  });
  files.sort((a, b) => a.path.localeCompare(b.path));

  if (options.reportSecrets !== true) {
    const secretFiles = scanBackupFilesForSecrets(files);
    if (secretFiles.length > 0) {
      throw new Error(`Backup contains possible secrets in: ${secretFiles.join(", ")}`);
    }
  }

  return {
    manifest: {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      exportedAt: options.exportedAt ?? new Date().toISOString(),
      muxVersion: normalizeMuxVersion(options.muxVersion),
      sourceLabel: options.sourceLabel,
      files: files.map((file) => ({
        path: file.path,
        sha256: sha256(file.content),
        ...(file.executable === true ? { executable: true } : {}),
      })),
    },
    files,
    redactions,
  };
}

function sameManifestContent(a: BackupManifest, b: BackupManifest): boolean {
  if (a.files.length !== b.files.length) return false;
  return a.files.every(
    (file, index) =>
      file.path === b.files[index]?.path &&
      file.sha256 === b.files[index]?.sha256 &&
      (file.executable === true) === (b.files[index]?.executable === true)
  );
}

/** Null when the directory is not there yet, which is the ordinary first push. */
async function resolveRootIfPresent(root: string): Promise<BackupRoot | null> {
  try {
    return await resolveRoot(root);
  } catch {
    return null;
  }
}

async function readManifestIfPresent(
  destinationDir: BackupRoot | null
): Promise<{ manifest: BackupManifest; raw: string } | null> {
  if (destinationDir === null) return null;
  try {
    await resolveContainedPath(destinationDir.path, BACKUP_MANIFEST_FILE);
    // Reading this only avoids a no-op commit, so an oversized one is ignored rather than
    // buffered: the push replaces it either way.
    const raw = (
      await readCheckedFile(destinationDir, BACKUP_MANIFEST_FILE, (size) => {
        if (size > MAX_BACKUP_FILE_BYTES) {
          throw new Error(`'${BACKUP_MANIFEST_FILE}' is larger than the reuse limit`);
        }
      })
    ).content.toString("utf-8");
    return { manifest: parseManifest(raw), raw };
  } catch {
    return null;
  }
}

function normalizeMuxVersion(value: string | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/**
 * Read-time budgets bound what is buffered; this bounds what is published, which is not the
 * same set: `preferences.json` is generated after collection, and redaction rewrites content.
 * Without it a push could commit a payload that every later Preview rejects as oversized.
 */
function assertPayloadWithinLimits(files: readonly BackupFile[], manifestJson: string): void {
  // Manifest first, matching the order the reader charges them, so a payload that writes
  // cannot be one that every later read rejects.
  const budget = createByteBudget();
  budget(BACKUP_MANIFEST_FILE, Buffer.byteLength(manifestJson, "utf-8"));
  for (const file of files) budget(file.path, file.content.length);
}

export async function writeBackupPayload(
  destinationDir: string,
  payload: BackupPayload,
  options: { portable?: boolean } = {}
): Promise<void> {
  const portable = options.portable !== false;
  const claimed = new Set<string>();
  for (const file of payload.files) {
    assertAllowedPayloadPath(file.path, { portable });
    // A published backup is read on filesystems that fold case and normalization, so a
    // collision only a case-sensitive source can produce would make it unreadable elsewhere.
    // A local snapshot goes back to the filesystem the files were just collected from, where
    // two names that coexist are two files by definition, so folding them would refuse to
    // snapshot a perfectly valid `Foo.md` beside `foo.md` and block the restore entirely.
    const claim = portable ? collisionKey(file.path) : file.path;
    if (claimed.has(claim)) throw new Error(`Duplicate backup path '${file.path}'`);
    claimed.add(claim);
  }
  // Reuse the previous manifest when content hashes match. Otherwise changing
  // export metadata would produce a commit with no settings changes.
  const previous = await readManifestIfPresent(await resolveRootIfPresent(destinationDir));
  const reusable = previous && sameManifestContent(previous.manifest, payload.manifest);
  const manifestJson = reusable ? previous.raw : `${JSON.stringify(payload.manifest, null, 2)}\n`;
  assertPayloadWithinLimits(payload.files, manifestJson);

  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });
  const root = await resolveRoot(destinationDir);
  for (const file of payload.files) {
    await resolveContainedPath(root.path, file.path);
    await writeCheckedFile(root, file.path, file.content, file.executable === true);
  }
  await writeCheckedFile(root, BACKUP_MANIFEST_FILE, Buffer.from(manifestJson, "utf-8"), false);
}

function parseManifest(raw: string): BackupManifest {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid backup manifest");
  }
  const manifest = value as Partial<BackupManifest>;
  if (
    manifest.schemaVersion !== BACKUP_SCHEMA_VERSION ||
    typeof manifest.exportedAt !== "string" ||
    typeof manifest.muxVersion !== "string" ||
    typeof manifest.sourceLabel !== "string" ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Invalid backup manifest");
  }
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file.path !== "string" ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      (file.executable !== undefined && typeof file.executable !== "boolean")
    ) {
      throw new Error("Invalid backup manifest file entry");
    }
    assertAllowedPayloadPath(file.path);
  }
  return manifest as BackupManifest;
}

export async function backupPayloadExists(sourceDir: string): Promise<boolean> {
  return await fileExists(path.join(sourceDir, BACKUP_MANIFEST_FILE));
}

export class BackupInvalidPayloadError extends Error {
  readonly code = "INVALID_BACKUP";

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "BackupInvalidPayloadError";
  }
}

/** An fs failure carries an errno string; a validation failure does not. */
function isFilesystemError(error: unknown): boolean {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

/**
 * Wraps validation failures so the service reports repository corruption as
 * `INVALID_BACKUP` rather than the `IO_ERROR` fallback. A genuine filesystem failure keeps
 * its own error, so a local disk problem is not blamed on the repository.
 */
export async function readBackupPayload(sourceDir: string): Promise<BackupPayload> {
  try {
    return await readBackupPayloadUnchecked(sourceDir);
  } catch (error) {
    if (isFilesystemError(error)) throw error;
    throw new BackupInvalidPayloadError(error);
  }
}

/**
 * An absent file here means the manifest describes content the repository does not have,
 * which is a corrupt backup rather than a local disk problem. Any other errno still belongs
 * to the local filesystem and keeps its own error.
 */
async function readManifestEntry(
  sourceDir: BackupRoot,
  relativePath: string,
  budget: ByteBudget
): Promise<Buffer> {
  try {
    await resolveContainedPath(sourceDir.path, relativePath);
    return (
      await readCheckedFile(sourceDir, relativePath, (size) => {
        budget(relativePath, size);
      })
    ).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Backup is missing '${relativePath}'`);
    }
    throw error;
  }
}

async function readBackupPayloadUnchecked(sourceDir: string): Promise<BackupPayload> {
  const budget = createByteBudget();
  const root = await resolveRoot(sourceDir);
  await resolveContainedPath(root.path, BACKUP_MANIFEST_FILE);
  // The manifest is the first thing read from a repository anyone with write access can
  // change, so it is charged to the same budget before it is parsed.
  const manifestRaw = await readCheckedFile(root, BACKUP_MANIFEST_FILE, (size) => {
    budget(BACKUP_MANIFEST_FILE, size);
  });
  const manifest = parseManifest(manifestRaw.content.toString("utf-8"));
  const files: BackupFile[] = [];
  const seen = new Set<string>();
  for (const manifestFile of manifest.files) {
    const key = collisionKey(manifestFile.path);
    if (seen.has(key)) throw new Error(`Duplicate backup path '${manifestFile.path}'`);
    seen.add(key);
    const content = await readManifestEntry(root, manifestFile.path, budget);
    if (sha256(content) !== manifestFile.sha256) {
      throw new Error(`Backup checksum mismatch for '${manifestFile.path}'`);
    }
    files.push({
      path: manifestFile.path,
      content,
      ...(manifestFile.executable === true ? { executable: true } : {}),
    });
  }
  // Parse every structured entry here so a malformed backup is rejected before restore
  // writes anything. Otherwise a later parse failure leaves a half-restored install.
  for (const file of files) {
    if (file.path === "preferences.json") {
      projectBackupPreferences(JSON.parse(file.content.toString("utf-8")));
    }
    if (file.path === "mcp.jsonc") {
      parseJsoncObject(file.content.toString("utf-8"), "backup mcp.jsonc");
    }
  }
  const mcpFile = files.find((file) => file.path === "mcp.jsonc");
  return { manifest, files, redactions: mcpFile ? findMcpRedactions(mcpFile.content) : [] };
}

function containsRedaction(value: string): boolean {
  return (
    value.includes(REDACTED_BACKUP_VALUE) ||
    value.includes(encodeURIComponent(REDACTED_BACKUP_VALUE))
  );
}

/**
 * Collects the edits that put locally-held values back where the backup carries a
 * redaction marker, so re-reading a backup never destroys a working credential.
 *
 * A marker makes the WHOLE scalar locally owned, so a non-secret change the backup
 * made inside that same string is deliberately not restored. Splicing the local
 * credential into backup-controlled text would let a tampered backup move the local
 * secret to a different host or binary.
 */
function collectRedactionRestoreEdits(
  backup: unknown,
  local: unknown,
  currentPath: jsonc.JSONPath,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  resolvedServers: ReadonlySet<string> = new Set()
): void {
  // Only the paths handled by command or header resolution are skipped, so a mixed entry
  // can still rehydrate its other redacted values. A dropped entry is skipped wholesale,
  // since a nested edit would resurrect what it removed.
  if (resolvedServers.has(currentPath.join("\u0000"))) return;
  if (typeof backup === "string" && containsRedaction(backup)) {
    if (local !== undefined) edits.push({ path: currentPath, value: local });
    return;
  }
  if (Array.isArray(backup)) {
    const localArray = Array.isArray(local) ? local : [];
    backup.forEach((value, index) =>
      collectRedactionRestoreEdits(
        value,
        localArray[index],
        [...currentPath, index],
        edits,
        resolvedServers
      )
    );
    return;
  }
  if (backup && typeof backup === "object") {
    const localRecord =
      local && typeof local === "object" && !Array.isArray(local)
        ? (local as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(backup as Record<string, unknown>)) {
      collectRedactionRestoreEdits(
        value,
        readOwn(localRecord, key),
        [...currentPath, key],
        edits,
        resolvedServers
      );
    }
  }
}

/** Shared by preview and restore so the preview cannot promise a different result. */
export async function resolveRestoredContent(muxRoot: string, file: BackupFile): Promise<Buffer> {
  return file.path === "mcp.jsonc" ? await restoreMcpFile(muxRoot, file.content) : file.content;
}

/**
 * Restore reads the local `mcp.jsonc` to rehydrate the values a backup never carries, so it
 * goes through the same checked handle as every other read here: a symlink at that path would
 * otherwise be followed, and an oversized local file would skip the byte budget.
 * A missing or unreadable file leaves nothing to rehydrate rather than failing the restore.
 */
async function readLocalMcpText(muxRoot: string): Promise<string | null> {
  try {
    const root = await resolveRoot(muxRoot);
    const budget = createByteBudget();
    const { content } = await readCheckedFile(root, "mcp.jsonc", (size) =>
      budget("mcp.jsonc", size)
    );
    return content.toString("utf-8");
  } catch {
    return null;
  }
}

interface ServerCommand {
  command: string;
  enabled: boolean;
  /** False when `normalizeEntry` gives a non-empty URL precedence over this command. */
  runnable: boolean;
}

/**
 * Mirrors `McpConfigService.normalizeEntry`: a stdio server is either a bare command
 * string or an object carrying `command`. An empty command cannot run anything, so it is
 * not tracked. A disabled entry IS tracked, because `MCPServerManager.applyServerOverrides`
 * lets a workspace `enabledServers` override start a project-disabled server.
 */
function readServerCommand(value: unknown): ServerCommand | undefined {
  const raw = typeof value === "string" ? value : undefined;
  if (raw !== undefined) {
    if (raw.trim() === "" || raw === REDACTED_BACKUP_VALUE) return undefined;
    return { command: raw, enabled: true, runnable: true };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const command = record.command;
  if (typeof command !== "string" || command.trim() === "") return undefined;
  // The marker is a placeholder rather than command text: it either rehydrates to the local
  // value or stays unrunnable, so there is nothing for the user to read and approve.
  if (command === REDACTED_BACKUP_VALUE) return undefined;
  const url = record.url;
  return {
    command,
    enabled: record.disabled !== true,
    runnable: !(typeof url === "string" && url !== ""),
  };
}

/**
 * Only for the local file, where a malformed config holds no recoverable commands and
 * every incoming one is therefore new. The backup's own copy must never be read this way:
 * treating an unparseable payload as "no commands" would let it skip the approval gate.
 */
function readLocalServerCommands(content: string): Map<string, ServerCommand> {
  try {
    return readServerCommands(content);
  } catch {
    return new Map();
  }
}

function readServerCommands(content: string): Map<string, ServerCommand> {
  const commands = new Map<string, ServerCommand>();
  const servers = parseJsoncObject(content, "mcp.jsonc").servers;
  if (isUnsupportedServerMap(servers)) {
    throw new BackupInvalidPayloadError(
      new Error(
        "Cannot restore: the backup's mcp.jsonc lists servers as something other than an object"
      )
    );
  }
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return commands;
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    const entry = readServerCommand(server);
    if (entry !== undefined) commands.set(name, entry);
  }
  return commands;
}

/** Binds an approval to the exact command text the user read. */
export function backupCommandApprovalToken(serverPath: string, command: string): string {
  // JSON, not delimiter-joined: both components come from JSONC strings, whose escapes can
  // produce any character including NUL, so no delimiter makes concatenation unambiguous
  // and a crafted pair could collide with a different command's token.
  return sha256(Buffer.from(JSON.stringify([serverPath, command]), "utf-8"));
}

/**
 * MCP commands a restore would make runnable, or newly runnable. Those strings reach
 * `runtime.exec()` when the server next starts, so a repository the user does not fully
 * control must not be able to change them without the user reading the exact text first.
 * A command is exempt only when the local config already holds identical text and the
 * restore does not enable it, which covers both an unchanged command and one whose whole
 * scalar the redaction rehydration kept locally authoritative.
 */
export async function collectMcpCommandApprovals(
  muxRoot: string,
  files: readonly BackupFile[]
): Promise<BackupCommandApproval[]> {
  const file = files.find((candidate) => candidate.path === "mcp.jsonc");
  if (!file) return [];

  const restored = await resolveRestoredContent(muxRoot, file);
  const incoming = readServerCommands(restored.toString("utf-8"));
  const localText = await readLocalMcpText(muxRoot);
  const local =
    localText === null ? new Map<string, ServerCommand>() : readLocalServerCommands(localText);

  const approvals: BackupCommandApproval[] = [];
  for (const [name, entry] of incoming) {
    const current = local.get(name);
    // Identical text still needs approval if the restore makes a dormant command runnable.
    const makesItRun =
      entry.enabled &&
      entry.runnable &&
      (current?.enabled === false || current?.runnable === false);
    if (current?.command === entry.command && !makesItRun) continue;
    const serverPath = `servers.${name}.command`;
    approvals.push({
      path: serverPath,
      command: entry.command,
      token: backupCommandApprovalToken(serverPath, entry.command),
    });
  }
  return approvals;
}

export function assertBackupCommandsApproved(
  approvals: readonly BackupCommandApproval[],
  approvedTokens: readonly string[] | null | undefined
): void {
  const approved = new Set(approvedTokens ?? []);
  const unapproved = approvals.filter((approval) => !approved.has(approval.token));
  // The full list, not just the unapproved rest: the UI resends tokens only for the
  // commands it displays, so an error carrying a subset would drop the already-approved
  // tokens from the retry and turn them back into the next round's unapproved rest.
  if (unapproved.length > 0) throw new BackupCommandApprovalRequiredError(approvals);
}

async function restoreMcpFile(muxRoot: string, content: Buffer): Promise<Buffer> {
  const backupText = content.toString("utf-8");
  // Deliberately not gated on a marker being present: `resolveRestoredHeaders` has to inspect
  // a marker-free backup too, since a bare `{secret: NAME}` header carries no marker yet
  // still resolves against local data.
  const { parsed: backup, tree: backupTree } = parseJsoncObjectWithTree(
    backupText,
    "backup mcp.jsonc"
  );
  const localText = await readLocalMcpText(muxRoot);
  let local: Record<string, unknown> = {};
  if (localText !== null) {
    try {
      local = parseJsoncObject(localText, "local mcp.jsonc");
    } catch {
      // A corrupt local file holds no recoverable values, and it must not block the
      // restore that would replace it.
      local = {};
    }
  }
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];
  const resolved = resolveRestoredCommands(backup, local, edits);
  for (const path of resolveRestoredHeaders(backup, local, backupTree, edits, resolved)) {
    resolved.add(path);
  }
  collectRedactionRestoreEdits(backup, local, [], edits, resolved);
  return Buffer.from(applyJsoncEdits(backupText, edits), "utf-8");
}

/**
 * A command is never exported, so every stdio entry in a backup holds the marker. The local
 * command is put back regardless of which supported shape either side uses, since a server
 * stored as an object here can be a bare string there and vice versa.
 *
 * With no local command there is nothing to put back, and leaving the marker would make
 * `McpConfigService.normalizeEntry` treat it as an enabled command that
 * `MCPServerManager` then tries to execute, so the command is removed. That takes the whole
 * entry with it unless the entry is also an HTTP server, which restores on its own.
 *
 * Returns the exact paths handled here so the generic redaction walk skips them, leaving a
 * mixed entry's other redactions to rehydrate normally.
 */
function resolveRestoredCommands(
  backup: Record<string, unknown>,
  local: Record<string, unknown>,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
    const isBareMarker = entry === REDACTED_BACKUP_VALUE;
    const isObjectMarker = !isBareMarker && readRecord(entry)?.command === REDACTED_BACKUP_VALUE;
    if (!isBareMarker && !isObjectMarker) continue;

    const localEntry = readOwn(localServers, name);
    const localCommand = readAnyServerCommand(localEntry);
    if (localCommand === undefined) {
      // `normalizeEntry` gives a url precedence over a command, so a mixed object is an HTTP
      // server whose command is already ignored. Drop only the command and keep the url,
      // headers, disabled state, and allowlist that do restore. What counts is the url the
      // entry ends up with: a url is never exported either, so a marker with nothing local to
      // put back leaves the entry with neither a command nor an endpoint, and it goes whole.
      // `normalizeEntry` tests the url for truthiness, so mirror that exactly: only `url: ""`
      // is still stdio, while whitespace is truthy there and would load as an http entry.
      const url = isObjectMarker ? restoredServerUrl(entry, readRecord(localEntry)) : undefined;
      const hasUrl = url !== undefined && url !== "" && !containsRedaction(url);
      const removed: jsonc.JSONPath = hasUrl ? ["servers", name, "command"] : ["servers", name];
      edits.push({ path: removed, value: undefined });
      handled.add(removed.join("\u0000"));
      continue;
    }
    const commandPath = isBareMarker ? ["servers", name] : ["servers", name, "command"];
    edits.push({ path: commandPath, value: localCommand });
    handled.add(commandPath.join("\u0000"));
  }
  return handled;
}

/**
 * A restored header value is only ever the local value at that exact path, or nothing.
 *
 * `MCPServerManager.resolveHeaders` resolves both a literal header and a `{secret: NAME}`
 * reference against local data, then sends the result to whatever `url` the entry carries.
 * Deciding per value shape which ones are safe to carry over from a backup does not work:
 * a marker, a marker standing in for the whole `headers` object, a bare reference in a
 * marker-free file, and a reference the backup adds next to a url it chose are all the same
 * defect. So nothing the backup writes under `headers` survives unless the local file
 * already holds it at the same path, which makes the shape irrelevant.
 *
 * A local value is only put back when the restored entry still points at the endpoint the
 * local config already sends that header to. Otherwise the header is dropped, leaving an
 * entry that cannot authenticate rather than one that authenticates somewhere the user never
 * approved. Only header names the backup itself lists are considered, so a restore never
 * introduces a local header the backup did not have.
 *
 * Returns the paths handled here so the generic redaction walk leaves them alone.
 */
function resolveRestoredHeaders(
  backup: Record<string, unknown>,
  local: Record<string, unknown>,
  backupTree: jsonc.Node,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>,
  resolvedServers: ReadonlySet<string>
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
    // An entry command resolution already removed has no headers left to decide about, and
    // `jsonc.modify` cannot address a path whose parent this edit list deletes.
    if (resolvedServers.has(["servers", name].join("\u0000"))) continue;
    const rawHeaders = readRecord(entry)?.headers;
    if (rawHeaders === undefined) continue;
    const localServer = readRecord(readOwn(localServers, name));
    const headersPath: jsonc.JSONPath = ["servers", name, "headers"];
    // The whole subtree is withheld from the generic walk, so no header can be rehydrated
    // by a path this function did not decide on.
    handled.add(headersPath.join("\u0000"));

    const headers = readRecord(rawHeaders);
    const endpointMatches = restoredServerUrl(entry, localServer) === readUrl(localServer);
    if (!headers || !endpointMatches) {
      edits.push({ path: headersPath, value: undefined });
      continue;
    }

    const localHeaders = readRecord(localServer?.headers) ?? {};
    // Names come from the document, not the parsed object, because `jsonc.parse` drops a
    // `__proto__` key while the text keeps it. Enumerating the parse result would leave that
    // header, and its marker, untouched in the restored file.
    const names = objectKeyNames(backupTree, ["servers", name, "headers"]);
    const restored: Record<string, unknown> = {};
    for (const headerName of names) {
      if (!hasOwn(localHeaders, headerName)) continue;
      restored[headerName] = localHeaders[headerName];
    }

    if (names.length !== Object.keys(restored).length) {
      // Something has to go: a header with no local counterpart, a duplicate key, or a name
      // the parser hides. Replacing the whole value is the only edit that reliably removes
      // it, since `jsonc.modify` cannot address a key it cannot see.
      edits.push({ path: headersPath, value: restored });
      continue;
    }
    for (const [headerName, value] of Object.entries(restored)) {
      // Skipping an already-identical value keeps `jsonc.modify` from reformatting a header
      // the restore would not have changed.
      if (JSON.stringify(readOwn(headers, headerName)) === JSON.stringify(value)) continue;
      edits.push({ path: [...headersPath, headerName], value });
    }
  }
  return handled;
}

/**
 * Own key names as the document spells them. `jsonc.parse` drops a `__proto__` key while the
 * text keeps it, so a walk over the parse result cannot see, or edit, every key present.
 */
function objectKeyNames(tree: jsonc.Node | undefined, jsonPath: jsonc.JSONPath): string[] {
  if (!tree) return [];
  const node = jsonPath.length === 0 ? tree : jsonc.findNodeAtLocation(tree, jsonPath);
  if (node?.type !== "object") return [];
  return (node.children ?? []).flatMap((property) => {
    const key: unknown = property.children?.[0]?.value;
    return typeof key === "string" ? [key] : [];
  });
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Header and server names come from the backup, so a name like `constructor` would otherwise
 * read an `Object.prototype` member and hand a function to `jsonc.modify`.
 */
function readOwn(record: Record<string, unknown>, key: string): unknown {
  return hasOwn(record, key) ? record[key] : undefined;
}

/** The url the restored entry ends up with, since a redacted url is itself put back from local. */
function restoredServerUrl(
  backupEntry: unknown,
  localServer: Record<string, unknown> | undefined
): string | undefined {
  const backupUrl = readUrl(readRecord(backupEntry));
  const localUrl = readUrl(localServer);
  if (backupUrl !== undefined && containsRedaction(backupUrl) && localUrl !== undefined) {
    return localUrl;
  }
  return backupUrl;
}

function readUrl(server: Record<string, unknown> | undefined): string | undefined {
  const url = server?.url;
  return typeof url === "string" ? url : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The command text of either supported shape, enabled or not, ignoring the marker. */
function readAnyServerCommand(value: unknown): string | undefined {
  const command =
    typeof value === "string"
      ? value
      : value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).command
        : undefined;
  if (typeof command !== "string" || command === REDACTED_BACKUP_VALUE) return undefined;
  return command.trim() === "" ? undefined : command;
}

interface RestorePlan {
  /** Resolved by the plan and reused for the writes, so the two cannot disagree on the tree. */
  root: BackupRoot;
  writes: Array<{ path: string; content: Buffer; executable: boolean }>;
  backupPreferences: unknown;
}

/**
 * Everything a restore can reject before it writes anything, so a path or a limit that
 * refuses the payload cannot leave a half-restored install behind. `BackupService.restore`
 * runs this ahead of the safety snapshot too: a refused restore changes nothing, so it must
 * not leave an unredacted copy of the local settings behind either.
 */
export async function planRestoreWrites(
  muxRoot: string,
  payload: BackupPayload
): Promise<RestorePlan> {
  const root = await resolveRoot(muxRoot);
  let backupPreferences: unknown;
  const writes: RestorePlan["writes"] = [];
  const claimed = new Set<string>();
  // Restoring rehydrates local values into repository-controlled text, so what gets written is
  // not what was read and bounded. A payload made of markers is small however many large local
  // values it asks for, so the result is charged to the same budget as any other backup byte.
  const budget = createByteBudget();
  for (const file of payload.files) {
    assertAllowedPayloadPath(file.path);
    if (file.path === "preferences.json") {
      // Projected here so a document the merge would reject cannot reach the write loop, but
      // kept unmerged: the merge belongs to the config edit, against the config as it is when
      // that edit runs rather than as it was before the restore.
      const parsed: unknown = JSON.parse(file.content.toString("utf-8"));
      projectBackupPreferences(parsed);
      backupPreferences = parsed;
      continue;
    }
    const destination = await resolveContainedPath(root.path, file.path);
    const existing = await lstatOrNull(destination);
    if (existing?.isDirectory() === true) {
      throw new Error(`Cannot restore '${file.path}': a directory already exists there`);
    }
    // Two claims per entry, because two names reach one file two different ways. Folding the
    // path catches the pair a case-insensitive or normalizing volume would merge, which no
    // filesystem here can be asked about because neither name exists yet. An identity catches
    // the pair that is already one file, which no spelling reveals: hard links. Either way a
    // write goes through to the same bytes, so the entry written last would decide what both
    // names hold and neither entry would be restored as the backup recorded it.
    for (const claim of [
      collisionKey(destination),
      existing === null ? null : `${existing.dev}:${existing.ino}`,
    ]) {
      if (claim === null) continue;
      if (claimed.has(claim)) {
        throw new Error(`Cannot restore '${file.path}': another entry resolves to the same file`);
      }
      claimed.add(claim);
    }
    const content = await resolveRestoredContent(root.path, file);
    budget(file.path, content.byteLength);
    writes.push({ path: file.path, content, executable: file.executable === true });
  }
  return { root, writes, backupPreferences };
}

export async function restoreBackupPayload(
  options: RestoreBackupPayloadOptions
): Promise<RestoreBackupPayloadResult> {
  const localPaths = new Set(
    (await collectAllowlistedFiles(options.muxRoot)).map((file) => file.path)
  );
  const restoredPaths = new Set(
    options.payload.files
      .filter((file) => file.path !== "preferences.json")
      .map((file) => file.path)
  );
  // Recomputed here rather than trusted from the preview, so an approval cannot authorize
  // a command the repository changed between the preview and this restore.
  assertBackupCommandsApproved(
    await collectMcpCommandApprovals(options.muxRoot, options.payload.files),
    options.approvedCommandTokens
  );

  const plan = await planRestoreWrites(options.muxRoot, options.payload);
  // Before the writes, like the preview that showed the user this restore: the report says
  // which local files the backup does not cover, and a multi-link destination the write loop
  // severs below would otherwise flip from covered to local-only between the two.
  const { localOnly } = await localOnlyPayloadFiles(options.muxRoot, localPaths, restoredPaths);

  for (const write of plan.writes) {
    await writeCheckedFile(plan.root, write.path, write.content, write.executable);
  }

  return { backupPreferences: plan.backupPreferences, localOnlyFiles: localOnly };
}
