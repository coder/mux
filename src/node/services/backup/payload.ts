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
  /\bxoxb-[A-Za-z0-9-]{10,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
] as const;

export interface BackupFile {
  path: string;
  content: Buffer;
}

export interface BackupManifestFile {
  path: string;
  sha256: string;
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
    relativePath.split("/").includes("..") ||
    FORBIDDEN_BASENAMES.has(path.posix.basename(relativePath))
  ) {
    throw new Error(`Backup contains disallowed path '${relativePath}'`);
  }
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
      output.push({
        path: relativePath,
        content: await fs.readFile(path.join(root, ...relativePath.split("/"))),
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

function isPortableReference(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return (
      trimmed.startsWith("op://") ||
      /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(trimmed) ||
      /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ||
      /^env(?::|:\/\/)[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (typeof record.secret === "string" && record.secret.trim().length > 0) ||
    (typeof record.op === "string" && record.op.startsWith("op://"))
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
    if (
      /(?:token|api[_-]?key|secret|password|auth|credential)/i.test(name) &&
      value &&
      !isPortableReference(value)
    ) {
      url.searchParams.set(name, REDACTED_BACKUP_VALUE);
      redacted = true;
    }
  }
  return { value: redacted ? url.toString() : rawUrl, redacted };
}

function parseJsoncObject(raw: string, fileName: string): Record<string, unknown> {
  const errors: jsonc.ParseError[] = [];
  const parsed: unknown = jsonc.parse(raw, errors);
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${fileName}`);
  }
  return parsed as Record<string, unknown>;
}

function redactMcpConfig(content: Buffer): { content: Buffer; redactions: string[] } {
  const root = parseJsoncObject(content.toString("utf-8"), "mcp.jsonc");
  const redactions: string[] = [];
  const servers = root.servers;
  if (servers && typeof servers === "object" && !Array.isArray(servers)) {
    for (const [serverName, rawServer] of Object.entries(servers as Record<string, unknown>)) {
      if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
      const server = rawServer as Record<string, unknown>;
      const headers = server.headers;
      if (headers && typeof headers === "object" && !Array.isArray(headers)) {
        for (const [headerName, value] of Object.entries(headers as Record<string, unknown>)) {
          if (!isPortableReference(value)) {
            (headers as Record<string, unknown>)[headerName] = REDACTED_BACKUP_VALUE;
            redactions.push(`servers.${serverName}.headers.${headerName}`);
          }
        }
      }
      if (typeof server.url === "string") {
        const redactedUrl = redactInlineUrl(server.url);
        if (redactedUrl.redacted) {
          server.url = redactedUrl.value;
          redactions.push(`servers.${serverName}.url`);
        }
      }
    }
  }
  return {
    content: Buffer.from(`${JSON.stringify(root, null, 2)}\n`, "utf-8"),
    redactions,
  };
}

function findMcpRedactions(content: Buffer): string[] {
  const root = parseJsoncObject(content.toString("utf-8"), "mcp.jsonc");
  const redactions: string[] = [];
  const servers = root.servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return redactions;

  for (const [serverName, rawServer] of Object.entries(servers as Record<string, unknown>)) {
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
      muxVersion: options.muxVersion,
      sourceLabel: options.sourceLabel,
      files: files.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
    },
    files,
    redactions,
  };
}

function sameManifestContent(a: BackupManifest, b: BackupManifest): boolean {
  if (a.files.length !== b.files.length) return false;
  return a.files.every(
    (file, index) => file.path === b.files[index]?.path && file.sha256 === b.files[index]?.sha256
  );
}

async function readManifestIfPresent(destinationDir: string): Promise<BackupManifest | null> {
  try {
    return parseManifest(await fs.readFile(path.join(destinationDir, "manifest.json"), "utf-8"));
  } catch {
    return null;
  }
}

export async function writeBackupPayload(
  destinationDir: string,
  payload: BackupPayload
): Promise<void> {
  for (const file of payload.files) assertAllowedPayloadPath(file.path);
  // Reuse the previous manifest when the content hashes match. `exportedAt` and
  // `muxVersion` would otherwise differ on every export, so an unchanged backup
  // would produce a commit that only churns the timestamp.
  const previous = await readManifestIfPresent(destinationDir);
  const manifest =
    previous && sameManifestContent(previous, payload.manifest) ? previous : payload.manifest;

  await fs.rm(destinationDir, { recursive: true, force: true });
  await fs.mkdir(destinationDir, { recursive: true });
  for (const file of payload.files) {
    const destination = path.join(destinationDir, ...file.path.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, file.content);
  }
  await fs.writeFile(
    path.join(destinationDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8"
  );
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
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error("Invalid backup manifest file entry");
    }
    assertAllowedPayloadPath(file.path);
  }
  return manifest as BackupManifest;
}

export async function readBackupPayload(sourceDir: string): Promise<BackupPayload> {
  const manifest = parseManifest(await fs.readFile(path.join(sourceDir, "manifest.json"), "utf-8"));
  const files: BackupFile[] = [];
  const seen = new Set<string>();
  for (const manifestFile of manifest.files) {
    if (seen.has(manifestFile.path))
      throw new Error(`Duplicate backup path '${manifestFile.path}'`);
    seen.add(manifestFile.path);
    const content = await fs.readFile(path.join(sourceDir, ...manifestFile.path.split("/")));
    if (sha256(content) !== manifestFile.sha256) {
      throw new Error(`Backup checksum mismatch for '${manifestFile.path}'`);
    }
    files.push({ path: manifestFile.path, content });
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

function restoreRedactedValues(backup: unknown, local: unknown): unknown {
  if (typeof backup === "string" && containsRedaction(backup)) {
    return local === undefined ? backup : local;
  }
  if (Array.isArray(backup)) {
    const localArray = Array.isArray(local) ? local : [];
    return backup.map((value, index) => restoreRedactedValues(value, localArray[index]));
  }
  if (backup && typeof backup === "object") {
    const localRecord =
      local && typeof local === "object" && !Array.isArray(local)
        ? (local as Record<string, unknown>)
        : {};
    return Object.fromEntries(
      Object.entries(backup as Record<string, unknown>).map(([key, value]) => [
        key,
        restoreRedactedValues(value, localRecord[key]),
      ])
    );
  }
  return backup;
}

async function restoreMcpFile(muxRoot: string, content: Buffer): Promise<Buffer> {
  const backup = parseJsoncObject(content.toString("utf-8"), "backup mcp.jsonc");
  const localPath = path.join(muxRoot, "mcp.jsonc");
  let local: Record<string, unknown> = {};
  if (await fileExists(localPath)) {
    local = parseJsoncObject(await fs.readFile(localPath, "utf-8"), "local mcp.jsonc");
  }
  return Buffer.from(`${JSON.stringify(restoreRedactedValues(backup, local), null, 2)}\n`, "utf-8");
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
    const destination = path.join(options.muxRoot, ...file.path.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const content =
      file.path === "mcp.jsonc"
        ? await restoreMcpFile(options.muxRoot, file.content)
        : file.content;
    await fs.writeFile(destination, content);
  }

  return {
    preferences,
    localOnlyFiles: [...localPaths].filter((file) => !restoredPaths.has(file)).sort(),
  };
}
