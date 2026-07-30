import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as jsonc from "jsonc-parser";
import {
  UserPreferencesSchema,
  type UserPreferences,
} from "@/common/config/schemas/userPreferences";

export const BACKUP_SCHEMA_VERSION = 1;
export const REDACTED_BACKUP_VALUE = "__MUX_BACKUP_REDACTED__";

const FORBIDDEN_BASENAMES = new Set([
  "providers.jsonc",
  "secrets.json",
  "mcp-oauth.json",
  "server.lock",
  "serverAuthSessions.json",
  "AGENTS.local.md",
  "memory-meta.json",
]);
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
  /** Skills ship runnable scripts, so losing the execute bit breaks them on restore. */
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
}

export interface RestoreBackupPayloadOptions {
  muxRoot: string;
  payload: BackupPayload;
  currentPreferences?: UserPreferences;
}

export interface RestoreBackupPayloadResult {
  preferences: UserPreferences;
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

function assertAllowedPayloadPath(relativePath: string): void {
  if (
    !isAllowedPayloadPath(relativePath) ||
    path.isAbsolute(relativePath) ||
    // Payload paths are always posix. A backslash is an ordinary filename character
    // here but a separator on Windows, so `skills/..\..\evil` would escape the
    // destination once path.join runs there.
    relativePath.includes("\\") ||
    relativePath.split("/").includes("..") ||
    FORBIDDEN_BASENAMES.has(path.posix.basename(relativePath))
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
  let current = root;
  for (const segment of relativePath.split("/")) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Backup contains disallowed path '${relativePath}'`);
    }
    current = path.join(current, segment);
    if ((await lstatOrNull(current))?.isSymbolicLink()) {
      throw new Error(`Refusing to follow symlink '${relativePath}'`);
    }
  }
  return current;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function collectDirectory(
  root: string,
  relativeRoot: string,
  filter: (relativePath: string, entry: Dirent) => boolean,
  output: BackupFile[]
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(path.join(root, relativeRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = toPosixPath(relativeRoot, entry.name);
    if (!filter(relativePath, entry)) continue;
    if (entry.isDirectory()) {
      await collectDirectory(root, relativePath, filter, output);
    } else if (entry.isFile() && !FORBIDDEN_BASENAMES.has(entry.name)) {
      const absolutePath = path.join(root, ...relativePath.split("/"));
      const stat = await fs.stat(absolutePath);
      output.push({
        path: relativePath,
        content: await fs.readFile(absolutePath),
        executable: (stat.mode & 0o111) !== 0,
      });
    }
  }
}

export async function collectAllowlistedFiles(muxRoot: string): Promise<BackupFile[]> {
  const files: BackupFile[] = [];
  for (const relativePath of ["AGENTS.md", "mcp.jsonc"]) {
    const absolutePath = path.join(muxRoot, relativePath);
    if (await fileExists(absolutePath)) {
      files.push({ path: relativePath, content: await fs.readFile(absolutePath) });
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

export function projectBackupPreferences(value: unknown): UserPreferences {
  const parsed = UserPreferencesSchema.parse(value ?? {});
  const projected: UserPreferences = {};

  if (parsed.appearance) projected.appearance = copyJson(parsed.appearance);
  if (parsed.navigation?.launchBehavior !== undefined) {
    projected.navigation = { launchBehavior: parsed.navigation.launchBehavior };
  }
  if (parsed.ai) {
    const ai: NonNullable<UserPreferences["ai"]> = {};
    if (parsed.ai.globalDefaults !== undefined) {
      ai.globalDefaults = copyJson(parsed.ai.globalDefaults);
    }
    if (parsed.ai.providerOptions !== undefined) {
      ai.providerOptions = copyJson(parsed.ai.providerOptions);
    }
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
    ...(projected.ai ? { ai: { ...current?.ai, ...projected.ai } } : {}),
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
 * Matches a bare `key` too, because Google-style MCP endpoints carry the credential
 * as `?key=...` rather than a name containing "token" or "api_key".
 */
function isSensitiveParamName(name: string): boolean {
  return /(?:^|[_-])(?:key|token|secret|password|auth|credential|apikey)(?:$|[_-])/i.test(name);
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

const CREDENTIAL_ARGUMENT_PATTERNS = [
  // --api-key sk-live-1, --api-key=sk-live-1
  /(--?[\w-]*(?:key|token|secret|password|auth|credential)[\w-]*[= ])(\S+)/gi,
  // API_KEY=sk-live-1 npx server
  /(\b\w+(?:key|token|secret|password|auth|credential)\w*=)(\S+)/gi,
  // --header "Authorization: Bearer sk-live-1"
  /(\bBearer\s+)([^\s"']+)/gi,
];

/**
 * A stdio MCP server carries its credential in the command line, so redact the value
 * after a credential-bearing flag. `$VAR` survives because the command is run through
 * a shell, which expands it on whichever machine restores the backup.
 */
function redactCommandCredentials(command: string): { value: string; redacted: boolean } {
  let redacted = false;
  let value = command;
  for (const pattern of CREDENTIAL_ARGUMENT_PATTERNS) {
    value = value.replace(pattern, (match, flag: string, secret: string) => {
      if (/^["']?\$/.test(secret) || secret === REDACTED_BACKUP_VALUE) return match;
      redacted = true;
      return `${flag}${REDACTED_BACKUP_VALUE}`;
    });
  }
  return { value, redacted };
}

function parseJsoncObject(raw: string, fileName: string): Record<string, unknown> {
  const errors: jsonc.ParseError[] = [];
  const parsed: unknown = jsonc.parse(raw, errors);
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${fileName}`);
  }
  return parsed as Record<string, unknown>;
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
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [serverName, rawServer] of Object.entries(servers as Record<string, unknown>)) {
      // A bare string entry is the stdio command itself (mcpConfigService.normalizeEntry).
      if (typeof rawServer === "string") {
        const redactedEntry = redactCommandCredentials(rawServer);
        if (redactedEntry.redacted) {
          edits.push({ path: ["servers", serverName], value: redactedEntry.value });
          redactions.push(`servers.${serverName}`);
        }
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
        const redactedCommand = redactCommandCredentials(server.command);
        if (redactedCommand.redacted) {
          edits.push({ path: ["servers", serverName, "command"], value: redactedCommand.value });
          redactions.push(`servers.${serverName}.command`);
        }
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

export function scanBackupFilesForSecrets(files: readonly BackupFile[]): string[] {
  return files
    .filter((file) => {
      const content = file.content.toString("utf-8");
      return SECRET_PATTERNS.some((pattern) => pattern.test(content));
    })
    .map((file) => file.path)
    .sort();
}

export async function createBackupPayload(
  options: CreateBackupPayloadOptions
): Promise<BackupPayload> {
  const files = await collectAllowlistedFiles(options.muxRoot);
  const redactions: string[] = [];
  const mcpFile = files.find((file) => file.path === "mcp.jsonc");
  if (mcpFile) {
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
    const raw = await fs.readFile(path.join(destinationDir, "manifest.json"), "utf-8");
    return { manifest: parseManifest(raw), raw };
  } catch {
    return null;
  }
}

function normalizeMuxVersion(value: string | undefined): string {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/** Mirrors `chmod +x`: execute follows read, so a private file stays private. */
async function addExecuteBit(filePath: string): Promise<void> {
  const { mode } = await fs.stat(filePath);
  await fs.chmod(filePath, mode | ((mode & 0o444) >> 2));
}

export async function writeBackupPayload(
  destinationDir: string,
  payload: BackupPayload
): Promise<void> {
  for (const file of payload.files) assertAllowedPayloadPath(file.path);
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
    if (file.executable === true) await addExecuteBit(destination);
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

export async function readBackupPayload(sourceDir: string): Promise<BackupPayload> {
  const manifest = parseManifest(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf-8"));
  const files: BackupFile[] = [];
  const seen = new Set<string>();
  for (const manifestFile of manifest.files) {
    if (seen.has(manifestFile.path))
      throw new Error(`Duplicate backup path '${manifestFile.path}'`);
    seen.add(manifestFile.path);
    const content = await fs.readFile(await resolveContainedPath(sourceDir, manifestFile.path));
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
 */
function collectRedactionRestoreEdits(
  backup: unknown,
  local: unknown,
  currentPath: jsonc.JSONPath,
  edits: Array<{ path: jsonc.JSONPath; value: unknown }>
): void {
  if (typeof backup === "string" && containsRedaction(backup)) {
    if (local !== undefined) edits.push({ path: currentPath, value: local });
    return;
  }
  if (Array.isArray(backup)) {
    const localArray = Array.isArray(local) ? local : [];
    backup.forEach((value, index) =>
      collectRedactionRestoreEdits(value, localArray[index], [...currentPath, index], edits)
    );
    return;
  }
  if (backup && typeof backup === "object") {
    const localRecord =
      local && typeof local === "object" && !Array.isArray(local)
        ? (local as Record<string, unknown>)
        : {};
    for (const [key, value] of Object.entries(backup as Record<string, unknown>)) {
      collectRedactionRestoreEdits(value, localRecord[key], [...currentPath, key], edits);
    }
  }
}

/** Content restore would write for this entry, after putting local values back. */
export async function resolveRestoredContent(muxRoot: string, file: BackupFile): Promise<Buffer> {
  return file.path === "mcp.jsonc" ? await restoreMcpFile(muxRoot, file.content) : file.content;
}

async function restoreMcpFile(muxRoot: string, content: Buffer): Promise<Buffer> {
  const backupText = content.toString("utf-8");
  const backup = parseJsoncObject(backupText, "backup mcp.jsonc");
  const localPath = path.join(muxRoot, "mcp.jsonc");
  let local: Record<string, unknown> = {};
  if (await fileExists(localPath)) {
    local = parseJsoncObject(await fs.readFile(localPath, "utf-8"), "local mcp.jsonc");
  }
  const edits: Array<{ path: jsonc.JSONPath; value: unknown }> = [];
  collectRedactionRestoreEdits(backup, local, [], edits);
  return Buffer.from(applyJsoncEdits(backupText, edits), "utf-8");
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
  let preferences = options.currentPreferences ?? {};

  for (const file of options.payload.files) {
    assertAllowedPayloadPath(file.path);
    if (file.path === "preferences.json") {
      preferences = mergeBackupPreferences(
        options.currentPreferences,
        JSON.parse(file.content.toString("utf-8")) as unknown
      );
      continue;
    }
    const destination = await resolveContainedPath(options.muxRoot, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const content = await resolveRestoredContent(options.muxRoot, file);
    await fs.writeFile(destination, content);
    if (file.executable === true) await addExecuteBit(destination);
  }

  return {
    preferences,
    localOnlyFiles: [...localPaths].filter((file) => !restoredPaths.has(file)).sort(),
  };
}
