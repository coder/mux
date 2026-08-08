import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import writeFileAtomic from "write-file-atomic";

import {
  AgentPluginRegistryFileSchema,
  type AgentPluginGitSource,
  type AgentPluginInstallEntry,
} from "@/common/config/schemas/agentPluginInstalls";
import { isValidAgentPluginName } from "@/common/utils/agentPluginName";
import type {
  AgentPluginInstallPreview,
  AgentPluginListItem,
  AgentPluginManifestSummary,
  AgentPluginPreviewMcpServer,
  AgentPluginPreviewSkill,
  AgentPluginUpdateCheck,
} from "@/common/orpc/schemas/agentPlugins";
import assert from "@/common/utils/assert";
import { getErrorMessage } from "@/common/utils/errors";
import type { Config } from "@/node/config";
import { parseSkillMarkdown } from "@/node/services/agentSkills/parseSkillMarkdown";
import { log } from "@/node/services/log";
import type { MCPServerManager } from "@/node/services/mcpServerManager";
import type { WorkspaceMcpOverridesService } from "@/node/services/workspaceMcpOverridesService";
import { execFileAsync } from "@/node/utils/disposableExec";
import {
  discoverAgentPluginAt,
  discoverAgentPlugins,
  type AgentPluginContainer,
  type AgentPluginInfo,
} from "./discovery";
import type { AgentPluginManifest } from "./manifest";
import {
  buildPluginServerKey,
  computePluginInstanceId,
  getPluginDataPath,
  loadPluginMcpServers,
} from "./mcpConfig";
import { isFullCommitSha, parseAgentPluginSourceInput } from "./sourceInput";

/**
 * Managed Agent Plugin installer (agent-plugins experiment; global scope only).
 *
 * Flow: parse input → shallow clone to a staging dir under ~/.mux →
 * validate the STAGED clone with the same manifest/component discovery used
 * at runtime → return a consent preview → on confirm, re-clone the exact SHA,
 * promote into ~/.mux/plugins/<name>, and record a registry entry
 * ({source, ref, lockedSha}) in ~/.mux/plugins.json.
 *
 * The registry is a standalone file (NOT a config.json section): older builds
 * rebuild config.json from known fields on save, so a downgrade would drop an
 * embedded registry — and owning the file lets writes THROW on failure so
 * install/update/uninstall can roll back instead of silently succeeding with
 * an unpersisted registry.
 *
 * Invariants:
 * - The installer NEVER writes into a project checkout (v1 is global-only).
 * - `lockedSha` is what runs; branches are only a tracking channel for the
 *   update badge. Nothing auto-applies.
 * - Update = temp clone + wholesale directory swap (rename-old → promote-new
 *   → delete-old), never in-place `git pull` — local edits to a managed
 *   plugin dir are discarded on update.
 * - Applying an update or uninstalling recycles that plugin's running MCP
 *   servers: content can change behind an unchanged stdio command line, so
 *   the config-signature check cannot notice (correctness, not polish).
 * - Failure paths must leave no partial state: staging dirs are cleaned up,
 *   and promote + registry-write failures roll back.
 */

/** Registry file name under the mux home dir. */
const REGISTRY_FILE_NAME = "plugins.json";

/** Preview/staging clones live here — NOT under ~/.mux/plugins, which discovery scans. */
const STAGING_DIR_NAME = "plugin-staging";

/** Staging dirs left behind by crashes are reclaimed after this age. */
const STALE_STAGING_MAX_AGE_MS = 60 * 60 * 1000;

const LS_REMOTE_TIMEOUT_MS = 30_000;
const CLONE_TIMEOUT_MS = 120_000;

/** Result of resolving a user-supplied ref against the remote. */
interface ResolvedRemoteRef {
  ref: string;
  refType: "branch" | "tag" | "commit";
  /** Peeled commit SHA for branch/tag; the ref itself for commit. */
  sha: string;
}

function gitEnv(): Record<string, string> {
  // Fail fast instead of hanging on credential prompts: installs run from the
  // UI with no terminal attached (acceptance: "private repo without auth" must
  // fail cleanly).
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  if (process.env.GIT_SSH_COMMAND === undefined) {
    env.GIT_SSH_COMMAND = "ssh -oBatchMode=yes";
  }
  return env;
}

async function runGit(args: string[], opts?: { timeoutMs?: number }): Promise<string> {
  using proc = execFileAsync("git", args, {
    env: gitEnv(),
    timeoutMs: opts?.timeoutMs ?? CLONE_TIMEOUT_MS,
  });
  const { stdout } = await proc.result;
  return stdout;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fsPromises.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function shortenHome(absPath: string): string {
  const home = os.homedir();
  if (absPath === home) {
    return "~";
  }
  return absPath.startsWith(home + path.sep) ? `~${absPath.slice(home.length)}` : absPath;
}

function manifestSummary(manifest: AgentPluginManifest): AgentPluginManifestSummary {
  return {
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.author?.name !== undefined ? { authorName: manifest.author.name } : {}),
    ...(manifest.homepage !== undefined ? { homepage: manifest.homepage } : {}),
    ...(manifest.repository !== undefined ? { repository: manifest.repository } : {}),
    ...(manifest.license !== undefined ? { license: manifest.license } : {}),
  };
}

export class AgentPluginInstallService {
  private readonly containerDir: string;
  private readonly stagingRoot: string;
  private readonly registryFile: string;
  /** Serializes mutations (install/update/uninstall) so directory swaps and registry writes cannot interleave. */
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly deps: {
      isEnabled: () => boolean;
      /** Recycles running MCP servers whose config key starts with the given prefix. */
      mcpServerManager?: MCPServerManager;
      /** Used to prune plugin server keys from per-workspace overrides on uninstall. */
      workspaceMcpOverridesService?: WorkspaceMcpOverridesService;
    }
  ) {
    assert(path.isAbsolute(config.rootDir), "AgentPluginInstallService: rootDir must be absolute");
    this.containerDir = path.join(config.rootDir, "plugins");
    this.stagingRoot = path.join(config.rootDir, STAGING_DIR_NAME);
    this.registryFile = path.join(config.rootDir, REGISTRY_FILE_NAME);
  }

  // ---------------------------------------------------------------------
  // Registry persistence (~/.mux/plugins.json)
  // ---------------------------------------------------------------------

  /**
   * Lenient-on-read: a missing/corrupt file or invalid entries degrade to
   * "unmanaged dirs" rather than an error (discovery stays the source of
   * truth for what loads; the registry only annotates). Name validation in
   * the schema doubles as a filesystem-safety gate — a traversal name like
   * `..` must never reach targetPathFor.
   */
  private async readRegistry(): Promise<AgentPluginInstallEntry[]> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.registryFile, "utf8");
    } catch {
      return [];
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      log.warn("Ignoring unparseable plugin registry file", {
        file: this.registryFile,
        error: getErrorMessage(error),
      });
      return [];
    }

    const wrapper = AgentPluginRegistryFileSchema.safeParse(parsedJson);
    if (wrapper.success) {
      return wrapper.data.plugins;
    }

    // Salvage valid entries individually so one bad entry cannot hide the rest.
    const rawEntries =
      typeof parsedJson === "object" &&
      parsedJson !== null &&
      Array.isArray((parsedJson as { plugins?: unknown }).plugins)
        ? (parsedJson as { plugins: unknown[] }).plugins
        : [];
    const entries: AgentPluginInstallEntry[] = [];
    for (const rawEntry of rawEntries) {
      const parsed = AgentPluginRegistryFileSchema.shape.plugins.element.safeParse(rawEntry);
      if (parsed.success) {
        entries.push(parsed.data);
      } else {
        log.warn("Dropping invalid managed plugin registry entry", {
          entry: rawEntry,
          error: parsed.error.message,
        });
      }
    }
    return entries;
  }

  /**
   * Atomic write that THROWS on failure (unlike Config.saveConfig's
   * log-and-swallow) so callers can roll back filesystem changes instead of
   * reporting success with an unpersisted registry.
   */
  private async writeRegistry(entries: AgentPluginInstallEntry[]): Promise<void> {
    await writeFileAtomic(
      this.registryFile,
      JSON.stringify({ plugins: entries }, null, 2),
      "utf-8"
    );
  }

  private assertEnabled(): void {
    if (!this.deps.isEnabled()) {
      throw new Error("Agent Plugins experiment is not enabled.");
    }
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn, fn);
    this.mutationQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Lexical install location — the identity `computePluginInstanceId` hashes
   * for global plugins. The name grammar excludes `.`/`..`/separators, so a
   * malformed registry entry can never resolve outside the container (this
   * path is deleted recursively on uninstall).
   */
  private targetPathFor(name: string): string {
    assert(isValidAgentPluginName(name), `invalid plugin name: ${JSON.stringify(name)}`);
    const target = path.join(this.containerDir, name);
    assert(
      path.dirname(target) === this.containerDir,
      "targetPathFor: resolved path must be an immediate child of the container"
    );
    return target;
  }

  private instanceIdFor(name: string): string {
    return computePluginInstanceId(this.targetPathFor(name));
  }

  // ---------------------------------------------------------------------
  // Staging helpers
  // ---------------------------------------------------------------------

  /**
   * Staging lives under ~/.mux (same filesystem as the container) so promote
   * is a plain rename, and outside ~/.mux/plugins so a staged clone can never
   * be discovered as an installed plugin.
   */
  private async createStagingDir(): Promise<string> {
    await fsPromises.mkdir(this.stagingRoot, { recursive: true });
    await this.purgeStaleStaging();
    return fsPromises.mkdtemp(path.join(this.stagingRoot, "stage-"));
  }

  /** Best-effort reclaim of staging dirs orphaned by crashes. */
  private async purgeStaleStaging(): Promise<void> {
    try {
      const now = Date.now();
      for (const entry of await fsPromises.readdir(this.stagingRoot)) {
        const entryPath = path.join(this.stagingRoot, entry);
        try {
          const stat = await fsPromises.stat(entryPath);
          if (now - stat.mtimeMs > STALE_STAGING_MAX_AGE_MS) {
            await fsPromises.rm(entryPath, { recursive: true, force: true });
          }
        } catch {
          // Entry vanished or is unreadable — skip.
        }
      }
    } catch {
      // Missing staging root is fine.
    }
  }

  private async removeDir(dirPath: string): Promise<void> {
    await fsPromises.rm(dirPath, { recursive: true, force: true });
  }

  // ---------------------------------------------------------------------
  // Git plumbing
  // ---------------------------------------------------------------------

  /** Resolve what a preview/install/update should check out, via `git ls-remote` (no fetch). */
  private async resolveRemoteRef(url: string, ref: string | undefined): Promise<ResolvedRemoteRef> {
    if (ref !== undefined && isFullCommitSha(ref)) {
      return { ref: ref.toLowerCase(), refType: "commit", sha: ref.toLowerCase() };
    }
    if (ref === undefined) {
      // Remote default branch: `ls-remote --symref <url> HEAD` prints
      //   ref: refs/heads/<default>\tHEAD
      //   <sha>\tHEAD
      const output = await this.lsRemote(url, ["--symref", url, "HEAD"]);
      const symrefMatch = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(output);
      const shaMatch = /^([0-9a-f]{40})\s+HEAD$/m.exec(output);
      if (!symrefMatch || !shaMatch) {
        throw new Error(`Could not determine the default branch of ${url}.`);
      }
      return { ref: symrefMatch[1], refType: "branch", sha: shaMatch[1] };
    }

    if (/^[0-9a-f]{7,39}$/i.test(ref)) {
      // A short SHA can't be fetched shallowly and can't be resolved by ls-remote.
      throw new Error(
        `'${ref}' looks like an abbreviated commit SHA. Use the full 40-character SHA, a branch, or a tag.`
      );
    }

    const output = await this.lsRemote(url, [
      url,
      `refs/heads/${ref}`,
      `refs/tags/${ref}`,
      `refs/tags/${ref}^{}`,
    ]);
    const lines = output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    let branchSha: string | undefined;
    let tagSha: string | undefined;
    let peeledTagSha: string | undefined;
    for (const line of lines) {
      const [sha, refName] = line.split(/\s+/);
      if (!sha || !refName) continue;
      if (refName === `refs/heads/${ref}`) branchSha = sha;
      else if (refName === `refs/tags/${ref}^{}`) peeledTagSha = sha;
      else if (refName === `refs/tags/${ref}`) tagSha = sha;
    }

    if (branchSha !== undefined) {
      return { ref, refType: "branch", sha: branchSha };
    }
    // Annotated tags list both the tag object and the peeled commit (^{});
    // lockedSha must be the commit so it can be compared against `rev-parse HEAD`.
    const resolvedTagSha = peeledTagSha ?? tagSha;
    if (resolvedTagSha !== undefined) {
      return { ref, refType: "tag", sha: resolvedTagSha };
    }
    throw new Error(`Ref '${ref}' was not found on the remote (no matching branch or tag).`);
  }

  private async lsRemote(url: string, args: string[]): Promise<string> {
    try {
      return await runGit(["ls-remote", ...args], { timeoutMs: LS_REMOTE_TIMEOUT_MS });
    } catch (error) {
      throw new Error(`Could not reach ${url}: ${getErrorMessage(error)}`);
    }
  }

  /** Shallow-clone `resolved` into a fresh staging dir; returns { dir, sha } with sha = HEAD. */
  private async cloneResolved(
    url: string,
    resolved: ResolvedRemoteRef
  ): Promise<{ dir: string; sha: string }> {
    const dir = await this.createStagingDir();
    try {
      if (resolved.refType === "commit") {
        await this.fetchExactSha(url, resolved.sha, dir);
      } else {
        await runGit([
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--branch",
          resolved.ref,
          "-c",
          "advice.detachedHead=false",
          url,
          dir,
        ]);
      }
      const sha = (await runGit(["-C", dir, "rev-parse", "HEAD"])).trim();
      assert(isFullCommitSha(sha), "cloneResolved: rev-parse HEAD must be a full SHA");
      return { dir, sha };
    } catch (error) {
      await this.removeDir(dir);
      throw new Error(`Failed to clone ${url}: ${getErrorMessage(error)}`);
    }
  }

  /**
   * Clone exactly `sha` (what the user consented to). Prefers a direct SHA
   * fetch (GitHub allows it); falls back to cloning the tracking ref and
   * verifying HEAD still matches, so a remote that moved between preview and
   * install fails loudly instead of installing unreviewed content.
   */
  private async cloneExactSha(source: AgentPluginGitSource, sha: string): Promise<string> {
    const dir = await this.createStagingDir();
    try {
      try {
        await this.fetchExactSha(source.url, sha, dir);
      } catch {
        if (source.refType === "commit") {
          throw new Error(`Could not fetch commit ${sha} from ${source.url}.`);
        }
        // fetchExactSha left an initialized repo behind; git clone refuses a
        // non-empty destination, so reset the staging dir before falling back.
        await this.removeDir(dir);
        await fsPromises.mkdir(dir, { recursive: true });
        await runGit([
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--branch",
          source.ref,
          "-c",
          "advice.detachedHead=false",
          source.url,
          dir,
        ]);
      }
      const head = (await runGit(["-C", dir, "rev-parse", "HEAD"])).trim();
      if (head !== sha) {
        throw new Error(
          `The remote moved since the preview (expected ${sha.slice(0, 12)}, got ${head.slice(0, 12)}). Run the preview again.`
        );
      }
      return dir;
    } catch (error) {
      await this.removeDir(dir);
      throw error instanceof Error ? error : new Error(getErrorMessage(error));
    }
  }

  private async fetchExactSha(url: string, sha: string, dir: string): Promise<void> {
    await runGit(["init", "--quiet", dir]);
    await runGit(["-C", dir, "remote", "add", "origin", url]);
    await runGit(["-C", dir, "fetch", "--depth", "1", "origin", sha]);
    await runGit([
      "-C",
      dir,
      "-c",
      "advice.detachedHead=false",
      "checkout",
      "--quiet",
      "FETCH_HEAD",
    ]);
  }

  // ---------------------------------------------------------------------
  // Staged-clone validation + preview assembly
  // ---------------------------------------------------------------------

  /**
   * Run the exact runtime validation (manifest + component discovery) against
   * a staged clone. Throws user-facing errors for non-plugins, including a
   * clear message for Claude Code plugin/marketplace repos (explicit non-goal).
   */
  private async validateStagedClone(stagedDir: string): Promise<{
    plugin: AgentPluginInfo;
    warnings: string[];
  }> {
    const hasManifest = await pathExists(path.join(stagedDir, "plugin.json"));
    if (!hasManifest) {
      if (
        (await pathExists(path.join(stagedDir, ".claude-plugin", "plugin.json"))) ||
        (await pathExists(path.join(stagedDir, ".claude-plugin", "marketplace.json")))
      ) {
        throw new Error(
          "This repository is a Claude Code plugin or marketplace (found .claude-plugin/). Mux implements the vendor-neutral Agent Plugins 1.0.0 format and cannot install Claude Code collections."
        );
      }
      throw new Error(
        "No plugin.json found at the repository root. The repo is not an Agent Plugin — if the plugin lives in a subdirectory, monorepo subpath installs land in v2."
      );
    }

    const { plugin, diagnostics } = await discoverAgentPluginAt({
      pluginDir: stagedDir,
      scope: "global",
    });
    if (!plugin) {
      const reasons = diagnostics.map((d) => d.message);
      throw new Error(
        reasons.length > 0 ? `Invalid plugin: ${reasons.join("; ")}` : "Invalid plugin manifest."
      );
    }
    return { plugin, warnings: diagnostics.map((d) => d.message) };
  }

  private async collectSkills(
    skillsDir: string | undefined,
    warnings: string[]
  ): Promise<AgentPluginPreviewSkill[]> {
    if (skillsDir === undefined) {
      return [];
    }
    const skills: AgentPluginPreviewSkill[] = [];
    let entries: string[] = [];
    try {
      entries = (await fsPromises.readdir(skillsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
    for (const dirName of entries) {
      const skillPath = path.join(skillsDir, dirName, "SKILL.md");
      // Missing SKILL.md → not a skill dir; skip silently like runtime discovery.
      let stat;
      try {
        stat = await fsPromises.stat(skillPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      try {
        const content = await fsPromises.readFile(skillPath, "utf8");
        const parsed = parseSkillMarkdown({ content, byteSize: stat.size });
        skills.push({
          name: parsed.frontmatter.name,
          ...(parsed.frontmatter.description !== undefined
            ? { description: parsed.frontmatter.description }
            : {}),
        });
      } catch (error) {
        warnings.push(`skills/${dirName}: ${getErrorMessage(error)}`);
      }
    }
    return skills;
  }

  /**
   * Normalize the staged plugin's mcp.json into the preview list. Uses the
   * FINAL instance identity so `PLUGIN_DATA` paths shown to the user match
   * what will run; staged-root path fragments are rewritten to the final
   * install path for readability.
   */
  private async collectMcpServers(
    plugin: AgentPluginInfo,
    finalTargetPath: string,
    instanceId: string,
    warnings: string[]
  ): Promise<AgentPluginPreviewMcpServer[]> {
    if (plugin.mcpConfigPath === undefined) {
      return [];
    }
    const { servers, diagnostics } = await loadPluginMcpServers(plugin, {
      muxHome: this.config.rootDir,
      instanceId,
    });
    warnings.push(...diagnostics.map((d) => d.message));

    const rewrite = (value: string): string => value.split(plugin.rootPath).join(finalTargetPath);

    const result: AgentPluginPreviewMcpServer[] = [];
    for (const info of Object.values(servers)) {
      assert(info.plugin !== undefined, "plugin server info must carry provenance");
      if (info.transport === "stdio") {
        const commandLine = [info.command, ...(info.args ?? [])].map(rewrite).join(" ");
        const envKeys = Object.keys(info.env ?? {}).filter(
          (key) => key !== "PLUGIN_ROOT" && key !== "PLUGIN_DATA"
        );
        result.push({
          serverName: info.plugin.serverName,
          transport: "stdio",
          summary: envKeys.length > 0 ? `${commandLine} (env: ${envKeys.join(", ")})` : commandLine,
        });
      } else {
        result.push({
          serverName: info.plugin.serverName,
          transport: info.transport === "http" ? "http" : "sse",
          summary: info.url,
        });
      }
    }
    return result.sort((a, b) => a.serverName.localeCompare(b.serverName));
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Stage + validate an install without writing anything permanent. The
   * staged clone is deleted before returning (stateless preview): install
   * re-fetches the exact consented SHA, so cancelling leaves no state.
   */
  async preview(args: {
    input: string;
    ref?: string | undefined;
    subpath?: string | undefined;
  }): Promise<AgentPluginInstallPreview> {
    this.assertEnabled();

    const parsed = parseAgentPluginSourceInput(args.input);
    const explicitRef = args.ref?.trim() ?? "";
    if (explicitRef.length > 0 && parsed.ref !== undefined && parsed.ref !== explicitRef) {
      throw new Error(
        `Conflicting refs: '@${parsed.ref}' in the source and '${explicitRef}' in the ref field.`
      );
    }
    const ref = parsed.ref ?? (explicitRef.length > 0 ? explicitRef : undefined);
    const subpath = parsed.subpath ?? (args.subpath?.trim() ? args.subpath.trim() : undefined);
    if (subpath !== undefined) {
      // Approved v1 scope: the descriptor grammar knows subpaths, installs don't.
      throw new Error(
        "Monorepo subpath installs land in v2. Point at a repo whose root is the plugin."
      );
    }

    const resolved = await this.resolveRemoteRef(parsed.url, ref);
    const { dir: stagedDir, sha } = await this.cloneResolved(parsed.url, resolved);
    try {
      const { plugin, warnings } = await this.validateStagedClone(stagedDir);
      const targetPath = this.targetPathFor(plugin.name);
      await this.assertNoCollision(plugin.name);

      const skills = await this.collectSkills(plugin.skillsDir, warnings);
      const mcpServers = await this.collectMcpServers(
        plugin,
        targetPath,
        this.instanceIdFor(plugin.name),
        warnings
      );

      if (resolved.refType === "tag" && sha !== resolved.sha) {
        warnings.push(
          `Tag '${resolved.ref}' moved between resolution and clone — installing ${sha.slice(0, 12)}.`
        );
      }

      const source: AgentPluginGitSource = {
        type: "git",
        url: parsed.url,
        ref: resolved.ref,
        refType: resolved.refType,
      };
      return {
        source,
        lockedSha: sha,
        manifest: manifestSummary(plugin.manifest),
        skills,
        mcpServers,
        warnings,
        targetPath: shortenHome(targetPath),
      };
    } finally {
      await this.removeDir(stagedDir);
    }
  }

  private async assertNoCollision(name: string): Promise<void> {
    const registry = await this.readRegistry();
    if (registry.some((entry) => entry.name === name)) {
      throw new Error(`A managed plugin named '${name}' is already installed. Uninstall it first.`);
    }
    if (await pathExists(this.targetPathFor(name))) {
      // Never overwrite: an unmanaged dir may hold local work.
      throw new Error(
        `${shortenHome(this.targetPathFor(name))} already exists. Remove the directory first — the installer never overwrites.`
      );
    }
  }

  /** Fetch the consented SHA, validate again, promote into the container, and record the registry entry. */
  async install(args: {
    source: AgentPluginGitSource;
    expectedSha: string;
  }): Promise<AgentPluginInstallEntry> {
    this.assertEnabled();
    assert(isFullCommitSha(args.expectedSha), "install: expectedSha must be a full commit SHA");
    if (args.source.subpath !== undefined) {
      throw new Error("Monorepo subpath installs land in v2.");
    }

    return this.runExclusive(async () => {
      const stagedDir = await this.cloneExactSha(args.source, args.expectedSha);
      try {
        const { plugin } = await this.validateStagedClone(stagedDir);
        const name = plugin.name;
        await this.assertNoCollision(name);
        const targetPath = this.targetPathFor(name);

        // The installed tree is a plain content snapshot: the registry holds
        // all provenance, and updates replace the directory wholesale, so a
        // .git dir would only invite in-place edits that updates discard.
        await this.removeDir(path.join(stagedDir, ".git"));

        await fsPromises.mkdir(this.containerDir, { recursive: true });
        await fsPromises.rename(stagedDir, targetPath);

        const entry: AgentPluginInstallEntry = {
          name,
          scope: "global",
          source: args.source,
          lockedSha: args.expectedSha,
          installedAt: new Date().toISOString(),
          manifest: {
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
        try {
          const registry = await this.readRegistry();
          await this.writeRegistry([...registry.filter((e) => e.name !== name), entry]);
        } catch (error) {
          // No partial state: a promote without a registry entry would look
          // like an unmanaged dir and block reinstall.
          await this.removeDir(targetPath);
          throw new Error(`Failed to persist the plugin registry: ${getErrorMessage(error)}`);
        }
        log.info(`Installed agent plugin '${name}' at ${args.expectedSha.slice(0, 12)}`);
        return entry;
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }

  /** Managed registry entries merged with unmanaged plugins found by global discovery. */
  async list(): Promise<AgentPluginListItem[]> {
    this.assertEnabled();

    const registry = await this.readRegistry();
    const containers: AgentPluginContainer[] = [
      { path: this.containerDir, scope: "global" },
      { path: path.join(os.homedir(), ".agents", "plugins"), scope: "global" },
    ];
    const { plugins } = await discoverAgentPlugins(containers);

    const items: AgentPluginListItem[] = [];
    const managedByName = new Map(registry.map((entry) => [entry.name, entry]));

    for (const plugin of plugins) {
      const isManagedLocation =
        plugin.containerPath === this.containerDir && managedByName.has(plugin.dirName);
      const entry = isManagedLocation ? managedByName.get(plugin.dirName) : undefined;
      if (entry) {
        managedByName.delete(plugin.dirName);
      }

      const warnings: string[] = [];
      const skillCount = (await this.collectSkills(plugin.skillsDir, warnings)).length;
      let mcpServerCount = 0;
      if (plugin.mcpConfigPath !== undefined) {
        try {
          const { servers } = await loadPluginMcpServers(plugin, {
            muxHome: this.config.rootDir,
            instanceId: computePluginInstanceId(path.join(plugin.containerPath, plugin.dirName)),
          });
          mcpServerCount = Object.keys(servers).length;
        } catch (error) {
          log.warn(`Agent plugin ${plugin.rootPath}: failed to count MCP servers`, { error });
        }
      }

      items.push({
        name: plugin.name,
        managed: entry !== undefined,
        present: true,
        location: shortenHome(path.join(plugin.containerPath, plugin.dirName)),
        ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
        ...(plugin.manifest.description !== undefined
          ? { description: plugin.manifest.description }
          : {}),
        ...(entry !== undefined
          ? {
              source: entry.source,
              lockedSha: entry.lockedSha,
              installedAt: entry.installedAt,
              ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
            }
          : {}),
        skillCount,
        mcpServerCount,
      });
    }

    // Registry entries whose directory vanished (self-heal display; uninstall still works).
    for (const entry of managedByName.values()) {
      items.push({
        name: entry.name,
        managed: true,
        present: false,
        location: shortenHome(this.targetPathFor(entry.name)),
        ...(entry.manifest?.version !== undefined ? { version: entry.manifest.version } : {}),
        ...(entry.manifest?.description !== undefined
          ? { description: entry.manifest.description }
          : {}),
        source: entry.source,
        lockedSha: entry.lockedSha,
        installedAt: entry.installedAt,
        ...(entry.updatedAt !== undefined ? { updatedAt: entry.updatedAt } : {}),
        skillCount: 0,
        mcpServerCount: 0,
      });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Uninstall: delete dir + registry entry + prune that plugin's per-workspace
   * MCP overrides (reinstall re-attaches the same instanceId, so stale
   * overrides would silently re-enable servers — violating default-disabled).
   * PLUGIN_DATA is preserved unless `deletePluginData` is set.
   */
  async uninstall(args: { name: string; deletePluginData: boolean }): Promise<void> {
    this.assertEnabled();

    return this.runExclusive(async () => {
      const registry = await this.readRegistry();
      const entry = registry.find((e) => e.name === args.name);
      if (!entry) {
        throw new Error(`'${args.name}' is not a managed plugin install.`);
      }

      const targetPath = this.targetPathFor(entry.name);
      const instanceId = this.instanceIdFor(entry.name);
      const serverKeyPrefix = buildPluginServerKey(instanceId, "");

      // Stop running servers before deleting the tree out from under them.
      await this.deps.mcpServerManager?.stopServersWithKeyPrefix(serverKeyPrefix);

      // Registry first: if the write fails, the plugin stays fully installed
      // and the API reports the error (no half-removed state).
      await this.writeRegistry(registry.filter((e) => e.name !== entry.name));
      await this.removeDir(targetPath);

      await this.pruneWorkspaceOverrides(serverKeyPrefix);

      if (args.deletePluginData) {
        await this.removeDir(getPluginDataPath(this.config.rootDir, instanceId));
      }
      log.info(`Uninstalled agent plugin '${entry.name}'`);
    });
  }

  /**
   * Remove `plugin:<instanceId>:*` keys from every local workspace's MCP
   * overrides. Best-effort per workspace: a missing checkout must not block
   * uninstall. Remote runtimes are skipped — they never see plugin servers
   * (resolveAgentPluginsMcpContext returns null off-host).
   */
  private async pruneWorkspaceOverrides(serverKeyPrefix: string): Promise<void> {
    const overridesService = this.deps.workspaceMcpOverridesService;
    if (!overridesService) {
      return;
    }
    const allMetadata = await this.config.getAllWorkspaceMetadata();
    for (const metadata of allMetadata) {
      const runtimeType = metadata.runtimeConfig.type;
      if (runtimeType !== "local" && runtimeType !== "worktree") {
        continue;
      }
      try {
        const overrides = await overridesService.getOverridesForWorkspace(metadata.id);
        const dropKey = (key: string) => key.startsWith(serverKeyPrefix);
        const enabledServers = overrides.enabledServers?.filter((key) => !dropKey(key));
        const disabledServers = overrides.disabledServers?.filter((key) => !dropKey(key));
        const toolAllowlist = overrides.toolAllowlist
          ? Object.fromEntries(
              Object.entries(overrides.toolAllowlist).filter(([key]) => !dropKey(key))
            )
          : undefined;

        const changed =
          (overrides.enabledServers?.length ?? 0) !== (enabledServers?.length ?? 0) ||
          (overrides.disabledServers?.length ?? 0) !== (disabledServers?.length ?? 0) ||
          Object.keys(overrides.toolAllowlist ?? {}).length !==
            Object.keys(toolAllowlist ?? {}).length;
        if (!changed) {
          continue;
        }
        await overridesService.setOverridesForWorkspace(metadata.id, {
          ...(enabledServers !== undefined ? { enabledServers } : {}),
          ...(disabledServers !== undefined ? { disabledServers } : {}),
          ...(toolAllowlist !== undefined ? { toolAllowlist } : {}),
        });
      } catch (error) {
        log.warn("Failed to prune plugin MCP overrides for workspace", {
          workspaceId: metadata.id,
          error: getErrorMessage(error),
        });
      }
    }
  }

  /**
   * Compare each managed entry's tracking ref against `lockedSha` via
   * `git ls-remote` (no fetch). Runs on Settings-section open and on the
   * explicit "Check for updates" action only — no background timers.
   */
  async checkUpdates(): Promise<AgentPluginUpdateCheck[]> {
    this.assertEnabled();

    const registry = await this.readRegistry();
    return Promise.all(
      registry.map(async (entry): Promise<AgentPluginUpdateCheck> => {
        if (entry.source.refType === "commit") {
          return { name: entry.name, status: "pinned" };
        }
        try {
          const resolved = await this.resolveRemoteRef(entry.source.url, entry.source.ref);
          if (resolved.refType !== entry.source.refType) {
            // e.g. a tracked branch was deleted and a tag with the same name exists now.
            return {
              name: entry.name,
              status: "error",
              message: `Tracked ${entry.source.refType} '${entry.source.ref}' is now a ${resolved.refType} on the remote.`,
            };
          }
          if (resolved.sha === entry.lockedSha) {
            return { name: entry.name, status: "up-to-date" };
          }
          return {
            name: entry.name,
            // A moved tag is suspicious (tags are supposed to be immutable) — warn, don't just offer.
            status: entry.source.refType === "tag" ? "tag-moved" : "update-available",
            remoteSha: resolved.sha,
          };
        } catch (error) {
          return { name: entry.name, status: "error", message: getErrorMessage(error) };
        }
      })
    );
  }

  /**
   * Apply an update: temp clone at the new SHA → re-validate → wholesale
   * directory swap (rename-old → promote-new → delete-old) → bump lockedSha →
   * recycle that plugin's MCP servers. Never an in-place `git pull`; local
   * edits to the managed dir are discarded.
   */
  async update(args: { name: string }): Promise<AgentPluginInstallEntry> {
    this.assertEnabled();

    return this.runExclusive(async () => {
      const registry = await this.readRegistry();
      const entry = registry.find((e) => e.name === args.name);
      if (!entry) {
        throw new Error(`'${args.name}' is not a managed plugin install.`);
      }
      if (entry.source.refType === "commit") {
        throw new Error(
          `'${entry.name}' is pinned to commit ${entry.lockedSha.slice(0, 12)}; uninstall and reinstall to change it.`
        );
      }

      const resolved = await this.resolveRemoteRef(entry.source.url, entry.source.ref);
      if (resolved.sha === entry.lockedSha) {
        return entry; // Already current.
      }

      const stagedDir = await this.cloneExactSha(entry.source, resolved.sha);
      try {
        const { plugin } = await this.validateStagedClone(stagedDir);
        if (plugin.name !== entry.name) {
          // Container-entry names are identity (instanceId, PLUGIN_DATA,
          // workspace overrides hash the path) — never rename on update.
          throw new Error(
            `The plugin renamed itself upstream ('${entry.name}' → '${plugin.name}'). Uninstall and reinstall to adopt the new name.`
          );
        }
        await this.removeDir(path.join(stagedDir, ".git"));

        const targetPath = this.targetPathFor(entry.name);
        const trashDir = path.join(this.stagingRoot, `trash-${Date.now()}-${entry.name}`);
        const hadOldTree = await pathExists(targetPath);
        if (hadOldTree) {
          await fsPromises.rename(targetPath, trashDir);
        }
        try {
          await fsPromises.mkdir(this.containerDir, { recursive: true });
          await fsPromises.rename(stagedDir, targetPath);
        } catch (error) {
          if (hadOldTree) {
            // Roll the old tree back so a failed swap never leaves the plugin missing.
            await fsPromises.rename(trashDir, targetPath).catch((rollbackError: unknown) => {
              log.error("Failed to roll back plugin dir after failed update swap", {
                targetPath,
                rollbackError,
              });
            });
          }
          throw error;
        }
        if (hadOldTree) {
          await this.removeDir(trashDir);
        }

        const updated: AgentPluginInstallEntry = {
          ...entry,
          lockedSha: resolved.sha,
          updatedAt: new Date().toISOString(),
          manifest: {
            ...(plugin.manifest.version !== undefined ? { version: plugin.manifest.version } : {}),
            ...(plugin.manifest.description !== undefined
              ? { description: plugin.manifest.description }
              : {}),
          },
        };
        // The new tree is already promoted; a failed write surfaces as an
        // error and the stale lockedSha keeps the update badge visible, so
        // retrying the update self-heals the mismatch.
        await this.writeRegistry(registry.map((e) => (e.name === entry.name ? updated : e)));

        // Content changed behind a stable path (and possibly an unchanged
        // stdio command line) — the signature check cannot see it, so recycle
        // explicitly. Servers restart on next use, default-disabled state and
        // workspace overrides are untouched (identity is the lexical path).
        await this.deps.mcpServerManager?.stopServersWithKeyPrefix(
          buildPluginServerKey(this.instanceIdFor(entry.name), "")
        );

        log.info(
          `Updated agent plugin '${entry.name}' ${entry.lockedSha.slice(0, 12)} → ${resolved.sha.slice(0, 12)}`
        );
        return updated;
      } finally {
        await this.removeDir(stagedDir);
      }
    });
  }
}
