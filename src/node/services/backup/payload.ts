import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
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
    // destination once path.join runs there. A local snapshot never travels, and the
    // containment check below resolves the real path either way.
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

async function readBackupFile(root: string, relativePath: string): Promise<BackupFile> {
  const absolutePath = path.join(root, ...relativePath.split("/"));
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    content: await fs.readFile(absolutePath),
    executable: (stat.mode & 0o111) !== 0,
  };
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
  root: string,
  relativeRoot: string,
  filter: (relativePath: string, entry: Dirent) => boolean,
  output: BackupFile[]
): Promise<void> {
  const absoluteRoot = path.join(root, ...relativeRoot.split("/"));
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
      await collectDirectory(root, relativePath, filter, output);
    } else if (entry.isFile() && !isForbiddenBasename(entry.name)) {
      output.push(await readBackupFile(root, relativePath));
    }
  }
}

export async function collectAllowlistedFiles(muxRoot: string): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  for (const relativePath of ["AGENTS.md", "mcp.jsonc"]) {
    if (await isRegularFile(path.join(muxRoot, relativePath))) {
      files.push(await readBackupFile(muxRoot, relativePath));
    }
  }

  await collectDirectory(
    muxRoot,
    "agents",
    (relativePath, entry) => entry.isDirectory() || /^agents\/[^/]+\.md$/.test(relativePath),
    files
  );
  await collectDirectory(muxRoot, "skills", () => true, files);
  await collectDirectory(muxRoot, "memory/global", () => true, files);
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

/**
 * Providers whose option schema is a closed `z.object`, so parsing already dropped
 * undeclared keys. The rest (`google`, `ollama`, `openrouter`) are
 * `z.record(z.string(), z.unknown())`, which would carry an `apiKey` straight into the
 * backup, so they are excluded. A provider added later is excluded until it is listed
 * here, which fails closed.
 */
const BACKED_UP_PROVIDER_OPTIONS = ["anthropic", "openai", "xai"] as const;

type BackupProviderOptions = NonNullable<NonNullable<UserPreferences["ai"]>["providerOptions"]>;

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
 * `MCPHeaderValue` is `string | { secret }` (src/common/types/mcp.ts), so Mux sends a
 * plain string verbatim and never interpolates it. Only the object forms are portable.
 */
function isPortableReference(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record.secret === "string" && record.secret.trim().length > 0) ||
    (typeof record.op === "string" && record.op.startsWith("op://"))
  );
}

/**
 * Matches bare `key` for Google-style endpoints and splits camelCase credential names.
 * It deliberately over-matches names like `tokenCount`: failing closed is safer because
 * low-entropy credentials may evade the secret scanner.
 */
function isSensitiveParamName(name: string): boolean {
  const separated = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2");
  return /(?:^|[_-])(?:key|token|secret|password|auth|credential|apikey)(?:$|[_-])/i.test(
    separated
  );
}

function decodeUrlComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactInlineUrl(rawUrl: string): { value: string; redacted: boolean } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { value: rawUrl, redacted: false };
  }

  let redacted = false;
  if (url.username && !isPortableReference(decodeUrlComponent(url.username))) {
    url.username = REDACTED_BACKUP_VALUE;
    redacted = true;
  }
  if (url.password && !isPortableReference(decodeUrlComponent(url.password))) {
    url.password = REDACTED_BACKUP_VALUE;
    redacted = true;
  }
  for (const [name, value] of url.searchParams) {
    if (isSensitiveParamName(name) && value && !isPortableReference(value)) {
      url.searchParams.set(name, REDACTED_BACKUP_VALUE);
      redacted = true;
    }
  }
  return { value: redacted ? url.toString() : rawUrl, redacted };
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
 * Rewrites values in place with jsonc edits. mcp.jsonc is a commented format, so
 * reserializing it through JSON.stringify would silently delete the user's comments.
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

function redactMcpConfig(content: Buffer): { content: Buffer; redactions: string[] } {
  const text = content.toString("utf-8");
  const root = parseJsoncObject(text, "mcp.jsonc");
  const redactions: string[] = [];
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];
  const servers = root.servers;
  // Every stdio `command` is replaced wholesale, never parsed for credentials. A command is
  // arbitrary shell text handed to `runtime.exec()`, so deciding which of its fragments are
  // secret means reimplementing the argument grammar of every tool a user might invoke, and
  // any gap publishes a credential. It is also barely portable, since it names binaries and
  // paths that exist on one machine. Local-only, like `appearance.editorConfig`.
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [serverName, rawServer] of Object.entries(servers as Record<string, unknown>)) {
      // A bare string entry is the stdio command itself (mcpConfigService.normalizeEntry).
      if (typeof rawServer === "string") {
        edits.push({ path: ["servers", serverName], value: REDACTED_BACKUP_VALUE });
        redactions.push(`servers.${serverName}`);
        continue;
      }
      if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
      const server = rawServer as Record<string, unknown>;
      const headers = server.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        for (const [headerName, value] of Object.entries(headers as Record<string, unknown>)) {
          if (!isPortableReference(value)) {
            edits.push({
              path: ["servers", serverName, "headers", headerName],
              value: REDACTED_BACKUP_VALUE,
            });
            redactions.push(`servers.${serverName}.headers.${headerName}`);
          }
        }
      }
      if (typeof server.url === "string") {
        const redactedUrl = redactInlineUrl(server.url);
        if (redactedUrl.redacted) {
          edits.push({ path: ["servers", serverName, "url"], value: redactedUrl.value });
          redactions.push(`servers.${serverName}.url`);
        }
      }
      if (typeof server.command === "string") {
        edits.push({ path: ["servers", serverName, "command"], value: REDACTED_BACKUP_VALUE });
        redactions.push(`servers.${serverName}.command`);
      }
    }
  }
  return { content: Buffer.from(applyJsoncEdits(text, edits), "utf-8"), redactions };
}

function findMcpRedactions(content: Buffer): string[] {
  const root = parseJsoncObject(content.toString("utf-8"), "mcp.jsonc");
  const redactions: string[] = [];
  const servers = root.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return redactions;

  for (const [serverName, rawServer] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof rawServer === "string") {
      if (containsRedaction(rawServer)) redactions.push(`servers.${serverName}`);
      continue;
    }
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
    const server = rawServer as Record<string, unknown>;
    const headers = server.headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      for (const [headerName, value] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof value === "string" && containsRedaction(value)) {
          redactions.push(`servers.${serverName}.headers.${headerName}`);
        }
      }
    }
    if (typeof server.url === "string" && containsRedaction(server.url)) {
      redactions.push(`servers.${serverName}.url`);
    }
    if (typeof server.command === "string" && containsRedaction(server.command)) {
      redactions.push(`servers.${serverName}.command`);
    }
  }
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

/**
 * A name promising credentials is worth review even as documentation, because notes named
 * this way usually contain the thing they are named after.
 */
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
  const parts = files
    .filter((file) => flagged.has(file.path))
    .map((file) => `${file.path}\0${sha256(file.content)}`)
    .sort();
  return sha256(Buffer.from(parts.join("\n"), "utf-8"));
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

  const secretFiles = scanBackupFilesForSecrets(files);
  if (secretFiles.length > 0 && options.reportSecrets !== true) {
    throw new Error(`Backup contains possible secrets in: ${secretFiles.join(", ")}`);
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

async function readManifestIfPresent(
  destinationDir: string
): Promise<{ manifest: BackupManifest; raw: string } | null> {
  try {
    const raw = await fs.readFile(
      await resolveContainedPath(destinationDir, "manifest.json"),
      "utf-8"
    );
    return { manifest: parseManifest(raw), raw };
  } catch {
    return null;
  }
}

function normalizeMuxVersion(value: string | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/**
 * Git records one bit per file, so mirror `chmod +x` / `chmod -x` and leave the
 * read and write bits to the local umask rather than inventing a source mode.
 */
async function applyExecuteBit(filePath: string, executable: boolean): Promise<void> {
  const { mode } = await fs.stat(filePath);
  const next = executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;
  if (next !== mode) await fs.chmod(filePath, next);
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
    // Case-folded: a collision only a case-sensitive source can produce would make the
    // published backup unreadable everywhere, including here.
    const claim = file.path.toLowerCase();
    if (claimed.has(claim)) throw new Error(`Duplicate backup path '${file.path}'`);
    claimed.add(claim);
  }
  // Reuse the previous manifest when content hashes match. Otherwise changing
  // export metadata would produce a commit with no settings changes.
  const previous = await readManifestIfPresent(destinationDir);
  const reusable = previous && sameManifestContent(previous.manifest, payload.manifest);
  const manifestJson = reusable ? previous.raw : `${JSON.stringify(payload.manifest, null, 2)}\n`;

  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });
  for (const file of payload.files) {
    const destination = await resolveContainedPath(destinationDir, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content);
    await applyExecuteBit(destination, file.executable === true);
  }
  await fs.writeFile(path.join(destinationDir, "manifest.json"), manifestJson, "utf-8");
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
  return await fileExists(path.join(sourceDir, "manifest.json"));
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
async function readManifestEntry(sourceDir: string, relativePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(await resolveContainedPath(sourceDir, relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Backup is missing '${relativePath}'`);
    }
    throw error;
  }
}

async function readBackupPayloadUnchecked(sourceDir: string): Promise<BackupPayload> {
  const manifestPath = await resolveContainedPath(sourceDir, "manifest.json");
  const manifest = parseManifest(await fs.readFile(manifestPath, "utf-8"));
  const files: BackupFile[] = [];
  const seen = new Set<string>();
  for (const manifestFile of manifest.files) {
    // Case-folded, because two entries differing only in case resolve to one file on a
    // case-insensitive filesystem and the second would silently overwrite the first.
    const key = manifestFile.path.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate backup path '${manifestFile.path}'`);
    seen.add(key);
    const content = await readManifestEntry(sourceDir, manifestFile.path);
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
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return commands;
  for (const [name, server] of Object.entries(servers as Record<string, unknown>)) {
    const entry = readServerCommand(server);
    if (entry !== undefined) commands.set(name, entry);
  }
  return commands;
}

/** Binds an approval to the exact command text the user read. */
export function backupCommandApprovalToken(serverPath: string, command: string): string {
  return sha256(Buffer.from(`${serverPath}\0${command}`, "utf-8"));
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
  const localPath = path.join(muxRoot, "mcp.jsonc");
  const local = (await fileExists(localPath))
    ? readLocalServerCommands(await fs.readFile(localPath, "utf-8"))
    : new Map<string, ServerCommand>();

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
  if (unapproved.length > 0) throw new BackupCommandApprovalRequiredError(unapproved);
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
  const localPath = path.join(muxRoot, "mcp.jsonc");
  let local: Record<string, unknown> = {};
  if (await fileExists(localPath)) {
    try {
      local = parseJsoncObject(await fs.readFile(localPath, "utf-8"), "local mcp.jsonc");
    } catch {
      // A corrupt local file holds no recoverable values, and it must not block the
      // restore that would replace it.
      local = {};
    }
  }
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];
  const resolved = resolveRestoredCommands(backup, local, edits);
  for (const path of resolveRestoredHeaders(backup, local, backupTree, edits)) resolved.add(path);
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

    const localCommand = readAnyServerCommand(readOwn(localServers, name));
    if (localCommand === undefined) {
      // `normalizeEntry` gives a url precedence over a command, so a mixed object is an HTTP
      // server whose command is already ignored. Drop only the command and keep the url,
      // headers, disabled state, and allowlist that do restore. `normalizeEntry` tests the
      // url for truthiness, so mirror that exactly: only `url: ""` is still stdio, while
      // whitespace is truthy there and would load as an http entry.
      const url = isObjectMarker ? readUrl(readRecord(entry)) : undefined;
      const hasUrl = url !== undefined && url !== "";
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
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>
): Set<string> {
  const handled = new Set<string>();
  const servers = readRecord(backup.servers);
  if (!servers) return handled;
  const localServers = readRecord(local.servers) ?? {};

  for (const [name, entry] of Object.entries(servers)) {
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
    const names = headerNamesInText(backupTree, name);
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

/** Header names as the document spells them, including any the parser drops. */
function headerNamesInText(tree: jsonc.Node | undefined, serverName: string): string[] {
  if (!tree) return [];
  const node = jsonc.findNodeAtLocation(tree, ["servers", serverName, "headers"]);
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
  let backupPreferences: unknown;

  // Recomputed here rather than trusted from the preview, so an approval cannot authorize
  // a command the repository changed between the preview and this restore.
  assertBackupCommandsApproved(
    await collectMcpCommandApprovals(options.muxRoot, options.payload.files),
    options.approvedCommandTokens
  );

  // Resolve every destination and its content before the first write, so a path
  // rejected late cannot leave a half-restored install behind.
  const writes: Array<{ destination: string; content: Buffer; executable: boolean }> = [];
  const claimed = new Set<string>();
  for (const file of options.payload.files) {
    assertAllowedPayloadPath(file.path);
    if (file.path === "preferences.json") {
      // Parsed here so malformed JSON fails before the first write, but left unmerged.
      backupPreferences = JSON.parse(file.content.toString("utf-8")) as unknown;
      continue;
    }
    const destination = await resolveContainedPath(options.muxRoot, file.path);
    if ((await lstatOrNull(destination))?.isDirectory() === true) {
      throw new Error(`Cannot restore '${file.path}': a directory already exists there`);
    }
    // Case-folded: two entries differing only in case are one file on Windows and macOS.
    const claim = destination.toLowerCase();
    if (claimed.has(claim)) {
      throw new Error(`Cannot restore '${file.path}': another entry resolves to the same file`);
    }
    claimed.add(claim);
    writes.push({
      destination,
      content: await resolveRestoredContent(options.muxRoot, file),
      executable: file.executable === true,
    });
  }

  for (const write of writes) {
    await fs.mkdir(path.dirname(write.destination), { recursive: true });
    await fs.writeFile(write.destination, write.content);
    await applyExecuteBit(write.destination, write.executable);
  }

  return {
    backupPreferences,
    localOnlyFiles: [...localPaths].filter((file) => !restoredPaths.has(file)).sort(),
  };
}
