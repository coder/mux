import * as fs from "node:fs/promises";

import { AdvisorDescriptorSchema, AdvisorNameSchema } from "@/common/orpc/schemas";
import type {
  AdvisorDescriptor,
  AdvisorIssue,
  AdvisorName,
  AdvisorPackage,
  AdvisorScope,
} from "@/common/types/advisor";
import { getErrorMessage } from "@/common/utils/errors";
import type { Runtime } from "@/node/runtime/Runtime";
import { RemoteRuntime } from "@/node/runtime/RemoteRuntime";
import { shellQuote } from "@/node/runtime/backgroundCommands";
import { resolveGlobalRuntime } from "@/node/runtime/hostGlobalMuxHome";
import { log } from "@/node/services/log";
import { validateFileSize } from "@/node/services/tools/fileCommon";
import { execBuffered, readFileString, writeFileString } from "@/node/utils/runtime/helpers";

import { AdvisorParseError, parseAdvisorMarkdown } from "./parseAdvisorMarkdown";

/**
 * Advisor loader (configuration-as-code).
 *
 * Mirrors `agentSkillsService.ts` but trimmed to the two scopes advisors care
 * about and without any built-ins. Hot-reload semantics match skills: there is
 * intentionally no cache, so editing `.mux/advisors/<name>/ADVISOR.md` takes
 * effect on the next stream send without restarting Mux.
 *
 * Per-advisor parse failures never crash the list — they're collected into the
 * optional `invalidAdvisors` array (see {@link discoverAdvisorsDiagnostics}).
 * The `/advisor` slash command surfaces these to the user.
 */

export interface AdvisorsRoots {
  /** Project-scoped root (e.g. `<workspace>/.mux/advisors`). Wins over global on name collision. */
  projectRoot: string;
  /** Global root (e.g. `~/.mux/advisors`). */
  globalRoot: string;
}

export function getDefaultAdvisorsRoots(runtime: Runtime, workspacePath: string): AdvisorsRoots {
  if (!workspacePath) {
    throw new Error("getDefaultAdvisorsRoots: workspacePath is required");
  }

  return {
    projectRoot: runtime.normalizePath(".mux/advisors", workspacePath),
    globalRoot: `${runtime.getMuxHome()}/advisors`,
  };
}

interface AdvisorScanCandidate {
  scope: AdvisorScope;
  root: string;
  runtime: Runtime;
}

function buildScanCandidates(
  runtime: Runtime,
  workspacePath: string,
  roots: AdvisorsRoots
): AdvisorScanCandidate[] {
  // Global scope uses the host runtime so SSH/devcontainer projects still
  // resolve `~/.mux/advisors` on the operator's machine, not the remote.
  const globalRuntime = resolveGlobalRuntime(runtime, workspacePath);

  return [
    { scope: "project" as const, root: roots.projectRoot, runtime },
    { scope: "global" as const, root: roots.globalRoot, runtime: globalRuntime },
  ];
}

async function listAdvisorDirectoriesFromLocalFs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listAdvisorDirectoriesFromRuntime(
  runtime: Runtime,
  root: string,
  options: { cwd: string }
): Promise<string[]> {
  const quotedRoot = shellQuote(root);
  const command =
    `if [ -d ${quotedRoot} ]; then ` +
    `find -L ${quotedRoot} -mindepth 1 -maxdepth 1 -type d -exec basename {} \\; ; ` +
    `fi`;

  const result = await execBuffered(runtime, command, { cwd: options.cwd, timeout: 10 });
  if (result.exitCode !== 0) {
    log.warn(`Failed to read advisors directory ${root}: ${result.stderr || result.stdout}`);
    return [];
  }

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function readAdvisorPackageFromDir(
  runtime: Runtime,
  advisorDir: string,
  directoryName: AdvisorName,
  scope: AdvisorScope,
  options?: { invalidAdvisors?: AdvisorIssue[] }
): Promise<AdvisorPackage | null> {
  const advisorFilePath = runtime.normalizePath("ADVISOR.md", advisorDir);

  let stat;
  try {
    stat = await runtime.stat(advisorFilePath);
  } catch {
    options?.invalidAdvisors?.push({
      directoryName,
      scope,
      displayPath: advisorFilePath,
      message: "ADVISOR.md is missing or unreadable.",
      hint: "Create an ADVISOR.md file with YAML frontmatter (--- ... ---).",
    });
    return null;
  }

  if (stat.isDirectory) {
    options?.invalidAdvisors?.push({
      directoryName,
      scope,
      displayPath: advisorFilePath,
      message: "ADVISOR.md is a directory (expected a file).",
      hint: "Replace ADVISOR.md with a regular file.",
    });
    return null;
  }

  const sizeValidation = validateFileSize(stat);
  if (sizeValidation) {
    log.warn(`Skipping advisor '${directoryName}' (${scope}): ${sizeValidation.error}`);
    options?.invalidAdvisors?.push({
      directoryName,
      scope,
      displayPath: advisorFilePath,
      message: sizeValidation.error,
      hint: "Reduce ADVISOR.md size below 1MB.",
    });
    return null;
  }

  let content: string;
  try {
    content = await readFileString(runtime, advisorFilePath);
  } catch (err) {
    const message = getErrorMessage(err);
    log.warn(`Failed to read ADVISOR.md for ${directoryName}: ${message}`);
    options?.invalidAdvisors?.push({
      directoryName,
      scope,
      displayPath: advisorFilePath,
      message: `Failed to read ADVISOR.md: ${message}`,
      hint: "Check file permissions and ensure the file is UTF-8 text.",
    });
    return null;
  }

  try {
    const parsed = parseAdvisorMarkdown({
      content,
      byteSize: stat.size,
      directoryName,
    });

    return {
      scope,
      directoryName,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      sourcePath: advisorFilePath,
    };
  } catch (err) {
    const message = err instanceof AdvisorParseError ? err.message : getErrorMessage(err);
    log.warn(`Skipping invalid advisor '${directoryName}' (${scope}): ${message}`);
    options?.invalidAdvisors?.push({
      directoryName,
      scope,
      displayPath: advisorFilePath,
      message,
      hint: "Fix ADVISOR.md frontmatter (description + model required).",
    });
    return null;
  }
}

export interface DiscoverAdvisorsOptions {
  /** Override roots (used by tests to isolate from `~/.mux/advisors`). */
  roots?: AdvisorsRoots;
  /** Collector for diagnostic issues from malformed advisor files. */
  invalidAdvisors?: AdvisorIssue[];
}

/**
 * Discover the loaded `AdvisorPackage` list, project scope first then global.
 * Project advisors win on name collision (consistent with skills).
 */
export async function discoverAdvisors(
  runtime: Runtime,
  workspacePath: string,
  options?: DiscoverAdvisorsOptions
): Promise<AdvisorPackage[]> {
  if (!workspacePath) {
    throw new Error("discoverAdvisors: workspacePath is required");
  }

  const roots = options?.roots ?? getDefaultAdvisorsRoots(runtime, workspacePath);
  const byName = new Map<AdvisorName, AdvisorPackage>();

  for (const scan of buildScanCandidates(runtime, workspacePath, roots)) {
    let resolvedRoot: string;
    try {
      resolvedRoot = await scan.runtime.resolvePath(scan.root);
    } catch (err) {
      log.warn(`Failed to resolve advisors root ${scan.root}: ${getErrorMessage(err)}`);
      continue;
    }

    const directoryNames =
      scan.runtime instanceof RemoteRuntime
        ? await listAdvisorDirectoriesFromRuntime(scan.runtime, resolvedRoot, {
            cwd: workspacePath,
          })
        : await listAdvisorDirectoriesFromLocalFs(resolvedRoot);

    for (const directoryNameRaw of directoryNames) {
      const nameParsed = AdvisorNameSchema.safeParse(directoryNameRaw);
      if (!nameParsed.success) {
        log.warn(
          `Skipping invalid advisor directory name '${directoryNameRaw}' in ${resolvedRoot}`
        );
        options?.invalidAdvisors?.push({
          directoryName: directoryNameRaw,
          scope: scan.scope,
          displayPath: scan.runtime.normalizePath(directoryNameRaw, resolvedRoot),
          message:
            "Advisor directory name must be kebab-case (lowercase letters, digits, hyphens).",
          hint: "Rename the directory to satisfy the advisor name format.",
        });
        continue;
      }

      const directoryName = nameParsed.data;
      if (byName.has(directoryName)) {
        // Project advisor already won; skip the global duplicate silently.
        continue;
      }

      const advisorDir = scan.runtime.normalizePath(directoryName, resolvedRoot);
      const pkg = await readAdvisorPackageFromDir(
        scan.runtime,
        advisorDir,
        directoryName,
        scan.scope,
        { invalidAdvisors: options?.invalidAdvisors }
      );
      if (pkg != null) {
        byName.set(directoryName, pkg);
      }
    }
  }

  return Array.from(byName.values());
}

/** Distill an `AdvisorPackage` into the renderer-facing `AdvisorDescriptor`. */
export function toAdvisorDescriptor(pkg: AdvisorPackage): AdvisorDescriptor {
  const descriptor: AdvisorDescriptor = {
    name: pkg.directoryName,
    description: pkg.frontmatter.description,
    scope: pkg.scope,
    model: pkg.frontmatter.model,
    thinking: pkg.frontmatter.thinking,
    agents: pkg.frontmatter.agents,
    sourcePath: pkg.sourcePath,
  };

  // Tighten with AdvisorDescriptorSchema so renderer-bound payloads cannot
  // smuggle out unexpected fields if the package shape ever evolves.
  const validated = AdvisorDescriptorSchema.safeParse(descriptor);
  if (!validated.success) {
    throw new Error(
      `Internal error: AdvisorPackage failed descriptor validation: ${validated.error.message}`
    );
  }
  return validated.data;
}

/** Filter the discovered advisors to the subset visible to a specific agent. */
export function filterAdvisorsForAgent<T extends Pick<AdvisorPackage, "frontmatter">>(
  advisors: readonly T[],
  agentId: string
): T[] {
  return advisors.filter((advisor) => {
    const agents = advisor.frontmatter.agents;
    if (agents == null || agents.length === 0) {
      return true;
    }
    return agents.includes(agentId);
  });
}

export interface DiscoverAdvisorsDiagnosticsResult {
  advisors: AdvisorPackage[];
  invalidAdvisors: AdvisorIssue[];
}

/**
 * Like {@link discoverAdvisors}, but also returns the diagnostics for any
 * malformed entries. Used by `/advisor` to surface authoring errors inline.
 */
export async function discoverAdvisorsDiagnostics(
  runtime: Runtime,
  workspacePath: string,
  options?: Omit<DiscoverAdvisorsOptions, "invalidAdvisors">
): Promise<DiscoverAdvisorsDiagnosticsResult> {
  const invalidAdvisors: AdvisorIssue[] = [];
  const advisors = await discoverAdvisors(runtime, workspacePath, {
    ...options,
    invalidAdvisors,
  });
  return { advisors, invalidAdvisors };
}

/**
 * Default scaffold template for `/advisor init <name>`.
 *
 * The body intentionally lands as a no-op so the file is functional the
 * moment it's saved: edit description/model and the advisor is live.
 */
export const ADVISOR_SCAFFOLD_TEMPLATE = `---
description: Use for <describe the kind of problem this advisor is good at>.
model: anthropic:claude-opus-4-5
# thinking: high
# max_uses_per_turn: 3
# max_output_tokens: 16000
# agents: [exec, plan]
---

# Optional: extra system-prompt guidance for this advisor.
# Appended after the base advisor prompt. Leave blank to use the default.
`;

export interface ScaffoldAdvisorResult {
  /** Resolved absolute path to the newly-written ADVISOR.md. */
  sourcePath: string;
  /** Directory created/used for this advisor. */
  advisorDir: string;
}

/**
 * Create `.mux/advisors/<name>/ADVISOR.md` from {@link ADVISOR_SCAFFOLD_TEMPLATE}.
 * Refuses to overwrite an existing file. Used by `/advisor init <name>`.
 */
export async function scaffoldProjectAdvisor(
  runtime: Runtime,
  workspacePath: string,
  name: string,
  options?: { roots?: AdvisorsRoots }
): Promise<ScaffoldAdvisorResult> {
  const parsedName = AdvisorNameSchema.safeParse(name);
  if (!parsedName.success) {
    throw new Error(
      `Invalid advisor name '${name}'. Use lowercase letters, digits, and single hyphens (e.g., 'ml-fellow').`
    );
  }

  const roots = options?.roots ?? getDefaultAdvisorsRoots(runtime, workspacePath);
  const advisorDir = runtime.normalizePath(parsedName.data, roots.projectRoot);
  const advisorFilePath = runtime.normalizePath("ADVISOR.md", advisorDir);

  // ensureDir tolerates an existing scaffold directory; we still fail below
  // if ADVISOR.md itself is already present, so users never lose authored content.
  await runtime.ensureDir(advisorDir);

  let alreadyExists = false;
  try {
    await runtime.stat(advisorFilePath);
    alreadyExists = true;
  } catch {
    alreadyExists = false;
  }
  if (alreadyExists) {
    throw new Error(
      `Refusing to overwrite existing advisor file at ${advisorFilePath}. Edit it directly or delete it first.`
    );
  }

  await writeFileString(runtime, advisorFilePath, ADVISOR_SCAFFOLD_TEMPLATE);

  return { sourcePath: advisorFilePath, advisorDir };
}
