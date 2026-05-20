import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";

import {
  EXTENSION_SOURCE_LOCK_SCHEMA_VERSION,
  GlobalExtensionSourceLockSchema,
  type GlobalExtensionSourceLock,
} from "@/common/extensions/sourceLocks";
import { validateStaticManifest } from "@/common/extensions/manifestValidator";
import { extractStaticManifestFromFile } from "@/node/extensions/staticManifestExtractor";

const execFileAsync = promisify(execFile);

const WINDOWS_ABSOLUTE_PATH_REGEX = /^[A-Za-z]:[/\\]/;

export interface InstallGitExtensionSourceInput {
  coordinate: string;
  muxRootDir: string;
  activeRootDir?: string;
  writeGlobalLock?: boolean;
  expectedExtensionName?: string;
  expectedContentHash?: string;
  now?: number;
}

export interface InstallGitExtensionSourceResult {
  extensionName: string;
  resolvedSha: string;
  contentHash: string;
  storePath: string;
  activePath: string;
}

interface ParsedGitCoordinate {
  url: string;
  ref: string;
  subdir?: string;
}

export async function installGitExtensionSource(
  input: InstallGitExtensionSourceInput
): Promise<InstallGitExtensionSourceResult> {
  const parsed = parseGitCoordinate(input.coordinate);
  const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-extension-git-"));
  try {
    await git(["clone", "--quiet", "--", parsed.url, cloneDir], os.tmpdir());
    await git(["checkout", "--quiet", parsed.ref], cloneDir);
    const resolvedSha = await git(["rev-parse", "HEAD"], cloneDir);
    const sourcePath = parsed.subdir ? path.join(cloneDir, parsed.subdir) : cloneDir;
    await assertContainedDirectory(cloneDir, sourcePath);

    const entrypointPath = path.join(sourcePath, "extension.ts");
    const entrypointRealPath = await assertContainedRegularFile(
      sourcePath,
      entrypointPath,
      "extension.ts"
    );
    const extraction = await extractStaticManifestFromFile(
      entrypointRealPath,
      input.now ?? Date.now()
    );
    if (!extraction.ok) {
      throw new Error(extraction.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }
    const rawName = extraction.manifest.name;
    if (typeof rawName !== "string") {
      throw new Error("Static Manifest must include a string manifest.name.");
    }
    const validation = validateStaticManifest({
      rawManifest: extraction.manifest,
      extensionName: rawName,
      rootKind: "user-global",
      now: input.now ?? Date.now(),
    });
    if (!validation.ok) {
      throw new Error(validation.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
    }
    if (input.expectedExtensionName && validation.manifest.id !== input.expectedExtensionName) {
      throw new Error(
        `Extension Source Lock expected ${input.expectedExtensionName}, but manifest.name is ${validation.manifest.id}.`
      );
    }

    const contentHash = await hashDirectory(sourcePath);
    if (input.expectedContentHash && contentHash !== input.expectedContentHash) {
      throw new Error(
        `Extension Source Lock expected ${input.expectedContentHash}, but fetched content hashed to ${contentHash}.`
      );
    }
    const extensionsRoot = path.join(input.muxRootDir, "extensions");
    const storePath = path.join(extensionsRoot, "store", contentHash.replace(/:/gu, "-"));
    const activeRootDir = input.activeRootDir ?? path.join(extensionsRoot, "global");
    const activePath = path.join(activeRootDir, validation.manifest.id);
    await materializeStoreDirectory({ sourcePath, storePath, contentHash });
    await fs.rm(activePath, { recursive: true, force: true });
    await copyDirectory(storePath, activePath);

    if (input.writeGlobalLock !== false) {
      const lockPath = path.join(extensionsRoot, "lock.json");
      const lock = await readGlobalLock(lockPath);
      lock.extensions[validation.manifest.id] = {
        source: {
          type: "git",
          url: parsed.url,
          ref: parsed.ref,
          resolvedSha,
          ...(parsed.subdir ? { subdir: parsed.subdir } : {}),
          contentHash,
        },
      };
      await fs.mkdir(path.dirname(lockPath), { recursive: true });
      await fs.writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
    }

    return {
      extensionName: validation.manifest.id,
      resolvedSha,
      contentHash,
      storePath,
      activePath,
    };
  } finally {
    await fs.rm(cloneDir, { recursive: true, force: true });
  }
}

function parseGitCoordinate(coordinate: string): ParsedGitCoordinate {
  const refIndex = coordinate.lastIndexOf("@");
  if (refIndex <= 0 || refIndex === coordinate.length - 1) {
    throw new Error("Git extension coordinates must include @ref.");
  }
  const source = coordinate.slice(0, refIndex);
  const ref = coordinate.slice(refIndex + 1);
  const subdirMarkerStart = source.includes("://") ? source.indexOf("://") + 3 : 0;
  const subdirIndex = source.indexOf("//", subdirMarkerStart);
  const url = subdirIndex === -1 ? source : source.slice(0, subdirIndex);
  const subdir = subdirIndex === -1 ? undefined : source.slice(subdirIndex + 2);
  if (!url) throw new Error("Git extension coordinates must include a git URL or path.");
  if (
    subdir !== undefined &&
    (!subdir ||
      path.isAbsolute(subdir) ||
      WINDOWS_ABSOLUTE_PATH_REGEX.test(subdir) ||
      subdir.split(/[\\/]/u).includes(".."))
  ) {
    throw new Error("Git extension coordinate subdir must be a contained relative path.");
  }
  return { url: normalizeGitUrl(url), ref, ...(subdir ? { subdir } : {}) };
}

export function normalizeGitUrl(url: string): string {
  if (!url.startsWith("github.com/")) return url;
  return url.endsWith(".git") ? `https://${url}` : `https://${url}.git`;
}

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

async function assertContainedDirectory(rootPath: string, candidatePath: string): Promise<void> {
  const [rootRealPath, candidateRealPath] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(candidatePath),
  ]);
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Git extension subdir resolved outside the cloned source.");
  }
  const stat = await fs.stat(candidateRealPath);
  if (!stat.isDirectory()) throw new Error("Git extension source path is not a directory.");
}

async function assertContainedRegularFile(
  rootPath: string,
  candidatePath: string,
  label: string
): Promise<string> {
  const [rootRealPath, linkStat] = await Promise.all([
    fs.realpath(rootPath),
    fs.lstat(candidatePath),
  ]);
  if (!linkStat.isFile()) {
    throw new Error(`${label} must be a regular file inside the Extension source.`);
  }

  const candidateRealPath = await fs.realpath(candidatePath);
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} resolved outside the Extension source.`);
  }
  return candidateRealPath;
}

async function hashDirectory(rootPath: string): Promise<string> {
  const hash = createHash("sha256");
  for (const filePath of await listFiles(rootPath)) {
    const relativePath = path.relative(rootPath, filePath).split(path.sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }
  return `sha256:${hash.digest("base64url")}`;
}

async function listFiles(rootPath: string): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

async function materializeStoreDirectory(input: {
  sourcePath: string;
  storePath: string;
  contentHash: string;
}): Promise<void> {
  let shouldCopy = false;
  try {
    const existingHash = await hashDirectory(input.storePath);
    shouldCopy = existingHash !== input.contentHash;
  } catch {
    shouldCopy = true;
  }

  if (!shouldCopy) return;
  await fs.rm(input.storePath, { recursive: true, force: true });
  await copyDirectory(input.sourcePath, input.storePath);
}

async function copyDirectory(sourcePath: string, destinationPath: string): Promise<void> {
  await fs.mkdir(destinationPath, { recursive: true });
  const entries = await fs.readdir(sourcePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const sourceEntry = path.join(sourcePath, entry.name);
    const destinationEntry = path.join(destinationPath, entry.name);
    if (entry.isDirectory()) {
      await copyDirectory(sourceEntry, destinationEntry);
    } else if (entry.isFile()) {
      await fs.copyFile(sourceEntry, destinationEntry);
    }
  }
}

async function readGlobalLock(lockPath: string): Promise<GlobalExtensionSourceLock> {
  try {
    const content = await fs.readFile(lockPath, "utf-8");
    return GlobalExtensionSourceLockSchema.parse(JSON.parse(content));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { schemaVersion: EXTENSION_SOURCE_LOCK_SCHEMA_VERSION, extensions: {} };
    }
    throw error;
  }
}
