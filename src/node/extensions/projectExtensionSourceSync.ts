import { createHash } from "crypto";
import * as fs from "fs/promises";
import * as path from "path";

import { ProjectExtensionSourceLockSchema } from "@/common/extensions/sourceLocks";
import { installGitExtensionSource } from "@/node/extensions/gitExtensionSourceInstaller";

export interface SyncProjectExtensionLockSourcesInput {
  projectPath: string;
  muxRootDir: string;
  trusted: boolean;
  now?: number;
}

export interface SyncedProjectExtensionSource {
  extensionName: string;
  contentHash: string;
  activePath: string;
}

export interface SyncProjectExtensionLockSourcesResult {
  synced: SyncedProjectExtensionSource[];
}

export function getProjectExtensionActiveRootPath(muxRootDir: string, projectPath: string): string {
  return path.join(muxRootDir, "extensions", "projects", projectKey(projectPath));
}

export async function areProjectExtensionActiveSourcesCurrent(input: {
  projectPath: string;
  muxRootDir: string;
}): Promise<boolean> {
  const lockPath = path.join(input.projectPath, ".mux", "extensions.lock.json");
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }

  const lock = ProjectExtensionSourceLockSchema.parse(JSON.parse(raw));
  const activeRootDir = getProjectExtensionActiveRootPath(input.muxRootDir, input.projectPath);
  const declaredNames = new Set(Object.keys(lock.extensions));
  let entries: Array<{ name: string }>;
  try {
    entries = await fs.readdir(activeRootDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return declaredNames.size === 0;
    }
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOTDIR" || error.code === "ELOOP")
    ) {
      return false;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!declaredNames.has(entry.name)) return false;
  }
  for (const [extensionName, entry] of Object.entries(lock.extensions)) {
    const activePath = path.join(activeRootDir, extensionName);
    if ((await hashDirectoryIfPresent(activePath)) !== entry.source.contentHash) return false;
  }
  return true;
}

export async function syncProjectExtensionLockSources(
  input: SyncProjectExtensionLockSourcesInput
): Promise<SyncProjectExtensionLockSourcesResult> {
  if (!input.trusted) return { synced: [] };

  const lockPath = path.join(input.projectPath, ".mux", "extensions.lock.json");
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { synced: [] };
    }
    throw error;
  }

  const lock = ProjectExtensionSourceLockSchema.parse(JSON.parse(raw));
  const activeRootDir = getProjectExtensionActiveRootPath(input.muxRootDir, input.projectPath);
  await removeUndeclaredActiveExtensions(activeRootDir, new Set(Object.keys(lock.extensions)));
  const synced: SyncedProjectExtensionSource[] = [];

  for (const [extensionName, entry] of Object.entries(lock.extensions)) {
    if (entry.source.type === "git") {
      const subdir = entry.source.subdir ? `//${entry.source.subdir}` : "";
      const coordinate = `${entry.source.url}${subdir}@${entry.source.resolvedSha}`;
      const result = await installGitExtensionSource({
        coordinate,
        muxRootDir: input.muxRootDir,
        activeRootDir,
        writeGlobalLock: false,
        expectedExtensionName: extensionName,
        expectedContentHash: entry.source.contentHash,
        now: input.now,
      });
      synced.push({
        extensionName,
        contentHash: result.contentHash,
        activePath: result.activePath,
      });
      continue;
    }

    const sourcePath = path.join(input.projectPath, entry.source.path);
    await assertContainedDirectory(input.projectPath, sourcePath);
    const contentHash = await hashDirectory(sourcePath);
    if (contentHash !== entry.source.contentHash) {
      throw new Error(
        `Extension Source Lock expected ${entry.source.contentHash}, but vendored content hashed to ${contentHash}.`
      );
    }
    const activePath = path.join(activeRootDir, extensionName);
    if ((await hashDirectoryIfPresent(activePath)) !== contentHash) {
      await fs.rm(activePath, { recursive: true, force: true });
      await assertContainedDirectory(input.projectPath, sourcePath);
      await copyDirectory(sourcePath, activePath);
    }
    synced.push({ extensionName, contentHash, activePath });
  }

  return { synced };
}

async function hashDirectoryIfPresent(rootPath: string): Promise<string | null> {
  try {
    return await hashDirectory(rootPath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "ELOOP")
    ) {
      return null;
    }
    throw error;
  }
}

async function removeUndeclaredActiveExtensions(
  activeRootDir: string,
  declaredExtensionNames: ReadonlySet<string>
): Promise<void> {
  const entries = await fs
    .readdir(activeRootDir, { withFileTypes: true })
    .catch(async (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      if (
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTDIR" || error.code === "ELOOP")
      ) {
        await fs.rm(activeRootDir, { recursive: true, force: true });
        return [];
      }
      throw error;
    });

  for (const entry of entries) {
    if (declaredExtensionNames.has(entry.name)) continue;
    await fs.rm(path.join(activeRootDir, entry.name), { recursive: true, force: true });
  }
}

async function assertContainedDirectory(rootPath: string, candidatePath: string): Promise<void> {
  const [rootRealPath, candidateRealPath] = await Promise.all([
    fs.realpath(rootPath),
    fs.realpath(candidatePath),
  ]);
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Vendored Extension Source Lock path resolved outside the project.");
  }
  const stat = await fs.stat(candidateRealPath);
  if (!stat.isDirectory())
    throw new Error("Vendored Extension Source Lock path is not a directory.");

  const currentCandidateRealPath = await fs.realpath(candidatePath);
  if (path.normalize(currentCandidateRealPath) !== path.normalize(candidateRealPath)) {
    throw new Error("Vendored Extension Source Lock path changed during containment validation.");
  }
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

function projectKey(projectPath: string): string {
  return createHash("sha256").update(path.resolve(projectPath)).digest("hex").slice(0, 24);
}
