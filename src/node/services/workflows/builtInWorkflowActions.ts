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

export const BUILT_IN_WORKFLOW_ACTION_SOURCES = {
  "git.status": GIT_STATUS_SOURCE,
  "git.commitsBetween": GIT_COMMITS_BETWEEN_SOURCE,
  "git.diff": GIT_DIFF_SOURCE,
  "git.diffStat": GIT_DIFF_STAT_SOURCE,
  "git.changedFiles": GIT_CHANGED_FILES_SOURCE,
} as const;
