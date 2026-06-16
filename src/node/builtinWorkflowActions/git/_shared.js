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
  const result = await ctx.execChecked("git", args);
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
  const originHead = await tryGit(ctx, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead != null && originHead.length > 0) return originHead;
  for (const candidate of ["main", "master", "trunk"]) {
    if ((await tryGit(ctx, ["rev-parse", "--verify", candidate])) != null) return candidate;
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
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0] || "";
      if (parts.length >= 3) {
        return { status, oldPath: parts[1], path: parts[2] };
      }
      return { status, path: parts[1] || "" };
    });
}

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

async function readStatus(ctx, input, options) {
  const includeIgnored = Boolean(options && options.includeIgnored);
  const requestedHead = optionalString(input.head) ?? "HEAD";
  const [headSha, requestedHeadSha, requestedHeadRef, stdout] = await Promise.all([
    tryGit(ctx, ["rev-parse", "--verify", "HEAD"]),
    tryGit(ctx, ["rev-parse", "--verify", requestedHead]),
    tryGit(ctx, ["rev-parse", "--symbolic-full-name", "--verify", requestedHead]),
    runGit(ctx, [
      "status",
      "--porcelain=v1",
      "-b",
      "-uall",
      includeIgnored ? "--ignored=traditional" : "--ignored=no",
      "--ahead-behind",
    ]),
  ]);
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0]?.startsWith("## ")
    ? parseBranchHeader(lines[0])
    : { branch: null, upstream: null, ahead: 0, behind: 0 };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const ignored = [];
  for (const line of lines.slice(
    header.branch == null && lines[0]?.startsWith("## ") !== true ? 0 : 1
  )) {
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
}
