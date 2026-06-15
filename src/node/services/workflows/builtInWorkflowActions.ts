import assert from "@/common/utils/assert";
import { buildWorkspaceHostActionStubSources } from "./workspaceHostActions";

const GIT_SHARED_HELPERS = String.raw`
function inputObject(input) {
  return input != null && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedLimit(value, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(1, Math.min(value, 1000));
}

async function runGit(ctx, args) {
  const result = await ctx.exec("git", args);
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error("git command output exceeded workflow action capture limit");
  }
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || "git command failed").trim());
  }
  return result.stdout.trimEnd();
}

async function tryGit(ctx, args) {
  const result = await ctx.exec("git", args);
  if (result.stdoutTruncated || result.stderrTruncated) {
    throw new Error("git command output exceeded workflow action capture limit");
  }
  return result.exitCode === 0 ? result.stdout.trimEnd() : null;
}

async function captureGit(ctx, args, allowedExitCodes) {
  const result = await ctx.exec("git", args);
  if (!allowedExitCodes.includes(result.exitCode)) {
    throw new Error((result.stderr || result.stdout || "git command failed").trim());
  }
  return {
    text: result.stdout.trimEnd(),
    truncated: result.stdoutTruncated || result.stderrTruncated,
  };
}

async function resolveBase(ctx, input) {
  const explicitBase = optionalString(input.base) ?? optionalString(input.trunk);
  if (explicitBase != null) return explicitBase;
  const originHead = await tryGit(ctx, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (originHead != null && originHead.length > 0) return originHead;
  for (const candidate of ["main", "master", "trunk"]) {
    if (await tryGit(ctx, ["rev-parse", "--verify", candidate]) != null) return candidate;
  }
  throw new Error("Unable to determine trunk branch; pass input.base or input.trunk");
}

async function tryResolveBase(ctx, input) {
  try {
    return await resolveBase(ctx, input);
  } catch {
    return null;
  }
}

async function resolveMergeBase(ctx, base, head) {
  return await runGit(ctx, ["merge-base", base, head]);
}

function parseNameStatus(stdout) {
  if (stdout.length === 0) return [];
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split("\t");
    const status = parts[0] || "";
    if (parts.length >= 3) {
      return { status, oldPath: parts[1], path: parts[2] };
    }
    return { status, path: parts[1] || "" };
  });
}
`;

const GIT_STATUS_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Return branch, upstream, and working tree status for the current Git repository",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "git status" }, { kind: "command", command: "git rev-parse" }],
  timeoutMs: 10000,
};

${GIT_SHARED_HELPERS}

function parseBranchHeader(line) {
  let branchText = line.slice(3);
  let ahead = 0;
  let behind = 0;
  const trackingMatch = branchText.match(/ \[(.+)\]$/);
  if (trackingMatch != null) {
    branchText = branchText.slice(0, -trackingMatch[0].length);
    for (const part of trackingMatch[1].split(", ")) {
      const aheadMatch = part.match(/^ahead (\d+)$/);
      const behindMatch = part.match(/^behind (\d+)$/);
      if (aheadMatch != null) ahead = Number(aheadMatch[1]);
      if (behindMatch != null) behind = Number(behindMatch[1]);
    }
  }
  const [rawBranch, upstream] = branchText.split("...");
  const branch = rawBranch.replace(/^No commits yet on /, "");
  return { branch, upstream: upstream || null, ahead, behind };
}

function parseStatusLine(line) {
  const index = line[0] || " ";
  const worktree = line[1] || " ";
  const rawPath = line.slice(3);
  const renameParts = rawPath.split(" -> ");
  return {
    status: (index + worktree).trim(),
    index,
    worktree,
    path: renameParts[renameParts.length - 1],
    oldPath: renameParts.length > 1 ? renameParts[0] : undefined,
  };
}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const includeIgnored = input.includeIgnored !== false;
  const requestedHead = optionalString(input.head) ?? "HEAD";
  const headSha = await tryGit(ctx, ["rev-parse", "--verify", "HEAD"]);
  const requestedHeadSha = await tryGit(ctx, ["rev-parse", "--verify", requestedHead]);
  const requestedHeadRef = await tryGit(ctx, [
    "rev-parse",
    "--symbolic-full-name",
    "--verify",
    requestedHead,
  ]);
  const stdout = await runGit(ctx, [
    "status",
    "--porcelain=v1",
    "-b",
    "-uall",
    includeIgnored ? "--ignored=traditional" : "--ignored=no",
    "--ahead-behind",
  ]);
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.startsWith("## ") ? parseBranchHeader(lines[0]) : { branch: null, upstream: null, ahead: 0, behind: 0 };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const ignored = [];
  for (const line of lines.slice(header.branch == null && lines[0]?.startsWith("## ") !== true ? 0 : 1)) {
    const file = parseStatusLine(line);
    if (file.index === "?" && file.worktree === "?") {
      untracked.push(file.path);
      continue;
    }
    if (file.index === "!" && file.worktree === "!") {
      ignored.push(file.path);
      continue;
    }
    if (file.index !== " " && file.index !== "?") staged.push(file);
    if (file.worktree !== " " && file.worktree !== "?") unstaged.push(file);
  }
  return {
    ...header,
    headSha,
    requestedHead,
    requestedHeadSha,
    requestedHeadRef,
    clean: staged.length === 0 && unstaged.length === 0 && untracked.length === 0,
    staged,
    unstaged,
    untracked,
    ignored,
  };
};
`;

const GIT_COMMITS_BETWEEN_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Return commits reachable from head but not from the trunk/base branch",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "git log" }],
  timeoutMs: 10000,
};

${GIT_SHARED_HELPERS}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const base = await resolveBase(ctx, input);
  const head = optionalString(input.head) ?? "HEAD";
  const limit = boundedLimit(input.limit, 100);
  const mergeBase = await resolveMergeBase(ctx, base, head);
  const stdout = await runGit(ctx, [
    "log",
    "--max-count=" + String(limit),
    "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
    mergeBase + ".." + head,
  ]);
  const commits = stdout.split("\x1e").map((record) => record.trim()).filter((record) => record.length > 0).map((record) => {
    const [hash, shortHash, authorName, authorEmail, authoredAt, subject] = record.split("\x1f");
    return { hash, shortHash, authorName, authorEmail, authoredAt, subject };
  });
  return { base, head, mergeBase, commits, count: commits.length };
};
`;

const GIT_DIFF_STAT_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Return git diff --stat output for branch, staged, and unstaged changes",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "git diff" }],
  timeoutMs: 10000,
};

${GIT_SHARED_HELPERS}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const head = optionalString(input.head) ?? "HEAD";
  const staged = await runGit(ctx, ["diff", "--stat", "--staged"]);
  const unstaged = await runGit(ctx, ["diff", "--stat"]);
  const base = await tryResolveBase(ctx, input);
  if (base == null) {
    return { base: null, head, mergeBase: null, branch: null, staged, unstaged };
  }
  const mergeBase = await resolveMergeBase(ctx, base, head);
  const branch = await runGit(ctx, ["diff", "--stat", mergeBase + ".." + head]);
  return { base, head, mergeBase, branch, staged, unstaged };
};
`;

const GIT_DIFF_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Return git diff output for branch, staged, and unstaged changes",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "git diff" }],
  timeoutMs: 10000,
};

${GIT_SHARED_HELPERS}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const head = optionalString(input.head) ?? "HEAD";
  const staged = await captureGit(ctx, ["diff", "--staged"], [0]);
  const unstaged = await captureGit(ctx, ["diff"], [0]);
  const base = await tryResolveBase(ctx, input);
  if (base == null) {
    return {
      base: null,
      head,
      mergeBase: null,
      branch: "",
      staged: staged.text,
      unstaged: unstaged.text,
      truncated: { branch: false, staged: staged.truncated, unstaged: unstaged.truncated },
    };
  }
  const mergeBase = await resolveMergeBase(ctx, base, head);
  const branch = await captureGit(ctx, ["diff", mergeBase + ".." + head], [0]);
  return {
    base,
    head,
    mergeBase,
    branch: branch.text,
    staged: staged.text,
    unstaged: unstaged.text,
    truncated: {
      branch: branch.truncated,
      staged: staged.truncated,
      unstaged: unstaged.truncated,
    },
  };
};
`;

const GIT_CHANGED_FILES_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Return changed file lists for branch, staged, unstaged, and untracked Git state",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "git diff" }, { kind: "command", command: "git ls-files" }],
  timeoutMs: 10000,
};

${GIT_SHARED_HELPERS}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const head = optionalString(input.head) ?? "HEAD";
  const staged = parseNameStatus(await runGit(ctx, ["diff", "--name-status", "--staged"]));
  const unstaged = parseNameStatus(await runGit(ctx, ["diff", "--name-status"]));
  const untrackedOutput = await runGit(ctx, ["ls-files", "--others", "--exclude-standard"]);
  const untracked = untrackedOutput.length === 0 ? [] : untrackedOutput.split(/\r?\n/).filter(Boolean);
  const base = await tryResolveBase(ctx, input);
  if (base == null) {
    return { base: null, head, mergeBase: null, branch: [], staged, unstaged, untracked };
  }
  const mergeBase = await resolveMergeBase(ctx, base, head);
  const branch = parseNameStatus(await runGit(ctx, ["diff", "--name-status", mergeBase + ".." + head]));
  return { base, head, mergeBase, branch, staged, unstaged, untracked };
};
`;

const SECURITY_SHARED_HELPERS = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SECURITY_ROOT = ".mux/security";
const SCHEMA_VERSION = 1;
const GENERATED_START = "<!-- mux-security-generated:start -->";
const GENERATED_END = "<!-- mux-security-generated:end -->";

function inputObject(input) {
  return input != null && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sha256Text(text) {
  return "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(label + " must be a non-empty relative path");
  }
  if (path.isAbsolute(value)) {
    throw new Error(label + " must not be absolute");
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(label + " must not traverse outside the workspace");
  }
  return normalized;
}

function assertSafeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value) || !/[A-Za-z0-9]/.test(value)) {
    throw new Error(label + " must contain letters or numbers and only letters, numbers, dot, underscore, or dash");
  }
  if (value === "latest") {
    throw new Error(label + " must not use reserved id latest");
  }
  return value;
}

function workspacePath(ctx, relativePath) {
  const safe = assertSafeRelativePath(relativePath, "path");
  return path.join(ctx.cwd, safe);
}

function pathEscapesRoot(relativePath) {
  return relativePath === ".." || relativePath.startsWith(".." + path.sep) || path.isAbsolute(relativePath);
}

function assertUnderWorkspace(ctx, absolutePath, label) {
  const workspace = fs.realpathSync(ctx.cwd);
  const relative = path.relative(workspace, absolutePath);
  if (pathEscapesRoot(relative)) {
    throw new Error(label + " escapes the workspace");
  }
}

function assertPotentialPathUnderWorkspace(ctx, absolutePath, label) {
  const workspace = fs.realpathSync(ctx.cwd);
  const relative = path.relative(workspace, path.resolve(absolutePath));
  if (pathEscapesRoot(relative)) {
    throw new Error(label + " escapes the workspace");
  }
}

function assertSecurityRootRealPath(ctx, rootReal) {
  assertUnderWorkspace(ctx, rootReal, SECURITY_ROOT);
  if (path.relative(fs.realpathSync(ctx.cwd), rootReal) === "") {
    throw new Error(SECURITY_ROOT + " must not resolve to the workspace root");
  }
}

function ensureSecurityRoot(ctx) {
  const root = path.join(ctx.cwd, SECURITY_ROOT);
  fs.mkdirSync(root, { recursive: true });
  const rootReal = fs.realpathSync(root);
  assertSecurityRootRealPath(ctx, rootReal);
  // Keep scanner artifacts local/private by default and avoid dirtying the worktree
  // before an opt-in --fix phase attempts to apply workflow-owned patches.
  const gitignorePath = path.join(root, ".gitignore");
  try {
    if (fs.readFileSync(gitignorePath, "utf-8") !== "*\n") fs.writeFileSync(gitignorePath, "*\n", "utf-8");
  } catch (error) {
    if (!error || error.code !== "ENOENT") throw error;
    fs.writeFileSync(gitignorePath, "*\n", "utf-8");
  }
  return root;
}

function securityPath(ctx, relativePath) {
  const root = ensureSecurityRoot(ctx);
  const safe = assertSafeRelativePath(relativePath, "security artifact path");
  const target = path.join(root, safe);
  const relative = path.relative(root, target);
  if (relative === "" || pathEscapesRoot(relative)) {
    throw new Error("security artifact path escapes " + SECURITY_ROOT);
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const parentReal = fs.realpathSync(parent);
  const rootReal = fs.realpathSync(root);
  const parentRelative = path.relative(rootReal, parentReal);
  if (pathEscapesRoot(parentRelative)) {
    throw new Error("security artifact parent escapes " + SECURITY_ROOT);
  }
  return target;
}

function readSecurityFileTextIfPresent(ctx, relativePath) {
  const safe = assertSafeRelativePath(relativePath, "security artifact path");
  const root = path.join(ctx.cwd, SECURITY_ROOT);
  let rootReal;
  try {
    rootReal = fs.realpathSync(root);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  assertSecurityRootRealPath(ctx, rootReal);
  const target = path.join(root, safe);
  try {
    const targetReal = fs.realpathSync(target);
    const relative = path.relative(rootReal, targetReal);
    if (pathEscapesRoot(relative)) {
      throw new Error("security artifact path escapes " + SECURITY_ROOT);
    }
    return fs.readFileSync(targetReal, "utf-8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function readJsonIfPresent(ctx, relativePath) {
  try {
    const text = readSecurityFileTextIfPresent(ctx, relativePath);
    return { value: text == null ? null : JSON.parse(text), diagnostic: null };
  } catch (error) {
    return { value: null, diagnostic: { path: SECURITY_ROOT + "/" + relativePath, message: String(error && error.message || error) } };
  }
}

function atomicWriteText(ctx, relativePath, text) {
  const target = securityPath(ctx, relativePath);
  const tmp = target + ".tmp-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, target);
  return SECURITY_ROOT + "/" + assertSafeRelativePath(relativePath, "security artifact path");
}

function atomicWriteJson(ctx, relativePath, value) {
  return atomicWriteText(ctx, relativePath, JSON.stringify(value, null, 2) + "\n");
}

function generatedThreatModelMarkdown(markdown) {
  const body = typeof markdown === "string" && markdown.trim().length > 0 ? markdown.trim() : "# Security Threat Model\n\nNo threat model content was generated.";
  return GENERATED_START + "\n" + body + "\n" + GENERATED_END + "\n";
}

function mergeGeneratedBlock(existing, generated) {
  const start = existing.indexOf(GENERATED_START);
  const end = existing.indexOf(GENERATED_END);
  if (start === -1 || end === -1 || end < start) return generated;
  return existing.slice(0, start) + generated.trimEnd() + existing.slice(end + GENERATED_END.length);
}

function normalizeFinding(finding) {
  const item = inputObject(finding);
  const fingerprints = inputObject(item.fingerprints);
  const primary = typeof fingerprints.primary === "string" ? fingerprints.primary : typeof item.primaryFingerprint === "string" ? item.primaryFingerprint : "";
  return { id: typeof item.id === "string" ? item.id : "", ruleId: typeof item.ruleId === "string" ? item.ruleId : "", fingerprints: Object.assign({}, fingerprints, { primary: primary }), raw: item };
}
`;

const SECURITY_LOAD_STATE_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Load cached security scanner state from .mux/security",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [{ kind: "filesystem", access: "read", path: ".mux/security" }],
  timeoutMs: 10000,
};

${SECURITY_SHARED_HELPERS}

module.exports.execute = async function (_rawInput, ctx) {
  const diagnostics = [];
  const cache = readJsonIfPresent(ctx, "cache.json");
  const index = readJsonIfPresent(ctx, "threat-model.index.json");
  const overrides = readJsonIfPresent(ctx, "overrides/overrides.json");
  for (const result of [cache, index, overrides]) {
    if (result.diagnostic) diagnostics.push(result.diagnostic);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    securityRoot: SECURITY_ROOT,
    cache: cache.value && typeof cache.value === "object" ? cache.value : { schemaVersion: SCHEMA_VERSION, findings: {}, coverage: {} },
    threatModelIndex: index.value && typeof index.value === "object" ? index.value : { schemaVersion: SCHEMA_VERSION, sections: [] },
    overrides: overrides.value && typeof overrides.value === "object" ? overrides.value : { schemaVersion: SCHEMA_VERSION, overrides: {} },
    diagnostics,
  };
};
`;

const SECURITY_HASH_FILES_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Compute SHA-256 hashes for workspace-relative files used by the security scanner",
  effect: "read",
  inputSchema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
  outputSchema: { type: "object" },
  permissions: [{ kind: "filesystem", access: "read", path: "." }],
  timeoutMs: 10000,
};

${SECURITY_SHARED_HELPERS}

function isJsTsPath(filePath) {
  return /\.[cm]?[jt]sx?$/.test(filePath);
}

function normalizeJsTsForSemanticHash(source) {
  return String(source)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\s+/g, "");
}

function semanticSectionsForJsTs(source) {
  const normalized = normalizeJsTsForSemanticHash(source);
  if (normalized.length === 0) return [];
  return [{ id: "file", semanticSha256: sha256Text(normalized) }];
}

function semanticHashForFile(filePath, data) {
  if (!isJsTsPath(filePath)) return { semanticSha256: null, semanticSections: [] };
  const source = data.toString("utf-8");
  const normalized = normalizeJsTsForSemanticHash(source);
  return {
    semanticSha256: normalized.length > 0 ? sha256Text(normalized) : null,
    semanticSections: semanticSectionsForJsTs(source),
  };
}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const results = [];
  for (const file of asArray(input.files)) {
    const safe = assertSafeRelativePath(file, "file path");
    const absolute = workspacePath(ctx, safe);
    const parent = path.dirname(absolute);
    if (fs.existsSync(parent)) {
      assertUnderWorkspace(ctx, fs.realpathSync(parent), "file path");
    } else {
      assertPotentialPathUnderWorkspace(ctx, parent, "file path");
    }
    try {
      const targetReal = fs.realpathSync(absolute);
      assertUnderWorkspace(ctx, targetReal, "file path");
      const data = fs.readFileSync(targetReal);
      const semantic = semanticHashForFile(safe, data);
      results.push({ path: safe, sha256: "sha256:" + crypto.createHash("sha256").update(data).digest("hex"), sizeBytes: data.length, missing: false, semanticSha256: semantic.semanticSha256, semanticSections: semantic.semanticSections });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        results.push({ path: safe, sha256: null, sizeBytes: 0, missing: true, semanticSha256: null, semanticSections: [] });
      } else {
        throw error;
      }
    }
  }
  return { schemaVersion: SCHEMA_VERSION, files: results };
};
`;

const SECURITY_MATCH_FINDINGS_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Match candidate security findings against cached fingerprints",
  effect: "read",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  timeoutMs: 10000,
};

${SECURITY_SHARED_HELPERS}

const STRONG_FINGERPRINT_KEYS = ["semanticAst", "matchBased", "scopeOffset", "contextWindow"];

function fingerprintValue(fingerprints, key) {
  const value = fingerprints[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

const SUPPRESSIVE_OVERRIDE_STATUSES = new Set(["false_positive", "accepted_risk", "ignored"]);

function normalizeOverrides(rawOverrides) {
  const root = inputObject(rawOverrides);
  return inputObject(root.overrides && typeof root.overrides === "object" ? root.overrides : root);
}

function overrideFor(overrides, findingId) {
  if (typeof findingId !== "string" || findingId.length === 0) return null;
  const override = inputObject(overrides[findingId]);
  const status = typeof override.status === "string" ? override.status : "";
  if (status.length === 0) return null;
  return {
    status,
    reason: typeof override.reason === "string" ? override.reason : "",
    expiresAt: typeof override.expiresAt === "string" ? override.expiresAt : null,
  };
}

function attachOverride(decision, overrides) {
  const override = overrideFor(overrides, decision.findingId) || overrideFor(overrides, decision.candidateId);
  if (!override) return decision;
  return Object.assign({}, decision, {
    override,
    reason: decision.reason + "; human override status " + override.status,
  });
}

const CACHE_VERIFICATION_SKIP_STATUSES = new Set(["verified", "false_positive", "accepted_risk", "ignored"]);

function cachedProofState(cacheFindings, findingId) {
  const record = inputObject(cacheFindings[findingId]);
  const status = typeof record.status === "string" && record.status.length > 0 ? record.status : "";
  if (status === "fixed" || CACHE_VERIFICATION_SKIP_STATUSES.has(status)) return status;
  const proof = inputObject(record.proof);
  return typeof proof.state === "string" && proof.state.length > 0 ? proof.state : status;
}

function shouldVerifyDecision(decision, cacheFindings) {
  if (decision.override && SUPPRESSIVE_OVERRIDE_STATUSES.has(decision.override.status)) return false;
  if (decision.match === "new") return true;
  if (decision.match === "exact" || decision.match === "strong") {
    return !CACHE_VERIFICATION_SKIP_STATUSES.has(cachedProofState(cacheFindings, decision.findingId));
  }
  return false;
}

module.exports.execute = async function (rawInput) {
  const input = inputObject(rawInput);
  const candidates = asArray(input.candidates).map(normalizeFinding);
  const cacheFindings = inputObject(input.cache && input.cache.findings);
  const overrides = normalizeOverrides(input.overrides);
  const byPrimaryFingerprint = new Map();
  const cachedRecords = [];
  for (const [id, record] of Object.entries(cacheFindings)) {
    const item = inputObject(record);
    const fingerprints = inputObject(item.fingerprints);
    const ruleId = typeof item.ruleId === "string" ? item.ruleId : "";
    cachedRecords.push({ id, ruleId, fingerprints, aliases: asArray(item.aliases) });
    for (const fp of [fingerprints.primary].concat(asArray(item.aliases))) {
      if (typeof fp === "string" && fp.length > 0) byPrimaryFingerprint.set(fp, id);
    }
  }
  const aliasUpdates = [];
  const decisions = candidates.map((candidate, index) => {
    const primary = fingerprintValue(candidate.fingerprints, "primary");
    const exactMatchId = primary ? byPrimaryFingerprint.get(primary) : undefined;
    if (exactMatchId) {
      return {
        index,
        candidateId: candidate.id || null,
        match: "exact",
        findingId: exactMatchId,
        reason: "primary fingerprint or alias matched cached finding",
      };
    }

    for (const cached of cachedRecords) {
      if (cached.ruleId.length === 0 || cached.ruleId !== candidate.ruleId) continue;
      for (const key of STRONG_FINGERPRINT_KEYS) {
        const candidateFingerprint = fingerprintValue(candidate.fingerprints, key);
        const cachedFingerprint = fingerprintValue(cached.fingerprints, key);
        if (candidateFingerprint != null && candidateFingerprint === cachedFingerprint) {
          if (primary != null && primary !== fingerprintValue(cached.fingerprints, "primary") && !cached.aliases.includes(primary)) {
            aliasUpdates.push({ findingId: cached.id, addAlias: primary });
          }
          return {
            index,
            candidateId: candidate.id || null,
            match: "strong",
            findingId: cached.id,
            reason: key + " fingerprint matched cached finding with the same ruleId",
          };
        }
      }
    }

    return {
      index,
      candidateId: candidate.id || null,
      match: "new",
      findingId: candidate.id || "candidate-" + String(index + 1),
      reason: "no cached fingerprint matched",
    };
  });
  const decisionsWithOverrides = decisions.map((decision) => attachOverride(decision, overrides));
  return {
    schemaVersion: SCHEMA_VERSION,
    decisions: decisionsWithOverrides,
    verify: decisionsWithOverrides.filter((decision) => shouldVerifyDecision(decision, cacheFindings)).map((decision) => decision.findingId),
    aliasUpdates,
  };
};
`;

const SECURITY_WRITE_THREAT_MODEL_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Write the generated security threat model under .mux/security",
  effect: "workspace",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [{ kind: "filesystem", access: "write", path: ".mux/security" }],
  timeoutMs: 10000,
};

${SECURITY_SHARED_HELPERS}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const generated = generatedThreatModelMarkdown(input.markdown);
  const existing = readSecurityFileTextIfPresent(ctx, "threat-model.md") || "";
  const markdownPath = atomicWriteText(ctx, "threat-model.md", mergeGeneratedBlock(existing, generated));
  const index = inputObject(input.index);
  const indexPath = atomicWriteJson(ctx, "threat-model.index.json", { schemaVersion: SCHEMA_VERSION, generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : null, sections: asArray(index.sections), diagnostics: asArray(index.diagnostics) });
  return { schemaVersion: SCHEMA_VERSION, paths: { threatModel: markdownPath, threatModelIndex: indexPath } };
};

module.exports.reconcile = module.exports.execute;
`;

const SECURITY_WRITE_EVIDENCE_BUNDLE_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Write a security scanner proof bundle under .mux/security/evidence",
  effect: "workspace",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [{ kind: "filesystem", access: "write", path: ".mux/security" }],
  timeoutMs: 10000,
};

${SECURITY_SHARED_HELPERS}

function redactText(text) {
  return String(text)
    .replace(/([A-Za-z0-9_]*TOKEN[A-Za-z0-9_]*=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/([A-Za-z0-9_]*KEY[A-Za-z0-9_]*=)[^\s]+/gi, "$1[REDACTED]")
    .replace(/([A-Za-z0-9_]*SECRET[A-Za-z0-9_]*=)[^\s]+/gi, "$1[REDACTED]");
}

const RESERVED_EVIDENCE_FILE_NAMES = new Set(["evidence.json", "transcript.txt", "baseline.json", "post-state.json"]);

function writeBundleText(ctx, findingId, name, text, options) {
  const safeName = assertSafeRelativePath(name, "evidence file path");
  if (safeName.includes("/")) {
    throw new Error("evidence file path must be a file name");
  }
  const allowReserved = options && options.allowReserved === true;
  if (!allowReserved && RESERVED_EVIDENCE_FILE_NAMES.has(safeName)) {
    throw new Error("poc script name must not overwrite reserved evidence file " + safeName);
  }
  const relativePath = "evidence/" + findingId + "/" + safeName;
  const redacted = redactText(text);
  const artifactPath = atomicWriteText(ctx, relativePath, redacted);
  return { path: artifactPath, sha256: sha256Text(redacted) };
}

function writeBundleJson(ctx, findingId, name, value) {
  return writeBundleText(ctx, findingId, name, JSON.stringify(value, null, 2) + "\n", { allowReserved: true });
}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const findingId = assertSafeId(input.findingId, "findingId");
  const transcript = writeBundleText(ctx, findingId, "transcript.txt", typeof input.transcript === "string" ? input.transcript : "", { allowReserved: true });
  const baseline = writeBundleJson(ctx, findingId, "baseline.json", inputObject(input.baseline));
  const postState = writeBundleJson(ctx, findingId, "post-state.json", inputObject(input.postState));
  const scripts = {};
  const pocScripts = inputObject(input.pocScripts);
  for (const [name, script] of Object.entries(pocScripts)) {
    scripts[name] = writeBundleText(ctx, findingId, name, typeof script === "string" ? script : String(script));
  }
  const evidence = Object.assign({}, inputObject(input.evidence), {
    schemaVersion: SCHEMA_VERSION,
    findingId,
    transcriptSha256: transcript.sha256,
    baselineSha256: baseline.sha256,
    postStateSha256: postState.sha256,
    scripts: Object.fromEntries(Object.entries(scripts).map(([name, result]) => [name, { path: result.path, sha256: result.sha256 }])),
  });
  const evidenceResult = writeBundleJson(ctx, findingId, "evidence.json", evidence);
  return {
    schemaVersion: SCHEMA_VERSION,
    findingId,
    evidencePath: evidenceResult.path,
    transcriptPath: transcript.path,
    baselinePath: baseline.path,
    postStatePath: postState.path,
    evidenceDigest: evidenceResult.sha256,
    scriptPaths: Object.fromEntries(Object.entries(scripts).map(([name, result]) => [name, result.path])),
  };
};

module.exports.reconcile = module.exports.execute;
`;

const SECURITY_WRITE_STATE_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Write security scanner cache and run report under .mux/security",
  effect: "workspace",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [{ kind: "filesystem", access: "write", path: ".mux/security" }],
  timeoutMs: 10000,
};

${SECURITY_SHARED_HELPERS}

function mergeSecurityCache(existing, incoming) {
  const merged = Object.assign(
    { schemaVersion: SCHEMA_VERSION, scannerVersion: "mux-security-scan/v1", fingerprintVersion: "mux-sec-fp/v1", findings: {}, coverage: {} },
    inputObject(existing),
    inputObject(incoming)
  );
  merged.findings = Object.assign({}, inputObject(existing && existing.findings), inputObject(incoming && incoming.findings));
  merged.coverage = Object.assign({}, inputObject(existing && existing.coverage), inputObject(incoming && incoming.coverage));
  return merged;
}

function allocateRunDir(_ctx, requested, input) {
  if (typeof requested === "string" && requested.length > 0) return "runs/" + assertSafeId(requested, "runDirId");
  const stableInput = JSON.stringify({
    reportMarkdown: typeof input.reportMarkdown === "string" ? input.reportMarkdown : "",
    structuredOutput: inputObject(input.structuredOutput),
  });
  const digest = crypto.createHash("sha256").update(stableInput).digest("hex").slice(0, 12);
  return "runs/run-" + digest;
}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const cache = inputObject(input.cache);
  const previousCache = inputObject(readJsonIfPresent(ctx, "cache.json").value);
  const cachePath = atomicWriteJson(ctx, "cache.json", mergeSecurityCache(previousCache, cache));
  const runDir = allocateRunDir(ctx, input.runDirId, input);
  const reportPath = atomicWriteText(ctx, runDir + "/report.md", typeof input.reportMarkdown === "string" ? input.reportMarkdown : "# Security Scan\n\nNo report was generated.\n");
  const structuredOutputPath = atomicWriteJson(ctx, runDir + "/structured-output.json", inputObject(input.structuredOutput));
  const latestPath = atomicWriteJson(ctx, "runs/latest", { schemaVersion: SCHEMA_VERSION, runDir, reportPath, structuredOutputPath });
  return { schemaVersion: SCHEMA_VERSION, runDir: SECURITY_ROOT + "/" + runDir, paths: { cache: cachePath, report: reportPath, structuredOutput: structuredOutputPath, latest: latestPath } };
};

module.exports.reconcile = module.exports.execute;
`;

const WORKFLOWS_START_SOURCE = String.raw`
module.exports.metadata = {
  version: 1,
  description: "Start a child workflow from the current workflow and wait for its terminal result",
  effect: "workspace",
  inputSchema: {
    type: "object",
    required: ["name"],
    properties: {
      name: { type: "string" },
      args: {},
    },
  },
  outputSchema: { type: "object" },
  timeoutMs: 86400000,
};

module.exports.execute = async function () {
  throw new Error("workflows.start is executed by the workflow runner");
};
`;

const STATIC_BUILT_IN_WORKFLOW_ACTION_SOURCES: Record<string, string> = {
  "workflows.start": WORKFLOWS_START_SOURCE,
  "git.status": GIT_STATUS_SOURCE,
  "git.commitsBetween": GIT_COMMITS_BETWEEN_SOURCE,
  "git.diff": GIT_DIFF_SOURCE,
  "git.diffStat": GIT_DIFF_STAT_SOURCE,
  "git.changedFiles": GIT_CHANGED_FILES_SOURCE,
  "security.loadState": SECURITY_LOAD_STATE_SOURCE,
  "security.hashFiles": SECURITY_HASH_FILES_SOURCE,
  "security.matchFindings": SECURITY_MATCH_FINDINGS_SOURCE,
  "security.writeThreatModel": SECURITY_WRITE_THREAT_MODEL_SOURCE,
  "security.writeEvidenceBundle": SECURITY_WRITE_EVIDENCE_BUNDLE_SOURCE,
  "security.writeState": SECURITY_WRITE_STATE_SOURCE,
};

// workspace.* host actions: generated stubs carrying real metadata; the
// implementations run in-process via WorkflowActionRunner host dispatch.
const HOST_ACTION_STUB_SOURCES = buildWorkspaceHostActionStubSources();

// Startup check: a misnamed host-action stub must never silently shadow a
// static built-in action source (the spread below would mask it).
for (const name of Object.keys(HOST_ACTION_STUB_SOURCES)) {
  assert(
    !Object.prototype.hasOwnProperty.call(STATIC_BUILT_IN_WORKFLOW_ACTION_SOURCES, name),
    `Host action stub "${name}" collides with a static built-in workflow action`
  );
}

export const BUILT_IN_WORKFLOW_ACTION_SOURCES: Record<string, string> = {
  ...STATIC_BUILT_IN_WORKFLOW_ACTION_SOURCES,
  ...HOST_ACTION_STUB_SOURCES,
};
