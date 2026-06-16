const s = mux.schema;

module.exports.metadata = {
  version: 1,
  description: "Return a compact review-ready Git context snapshot",
  effect: "read",
  inputSchema: s.nullable(
    s.object(
      {
        base: s.optional(s.string()),
        trunk: s.optional(s.string()),
        head: s.optional(s.string()),
        includeIgnored: s.optional(s.boolean()),
        includeCommits: s.optional(s.boolean()),
        commitLimit: s.optional(s.integer()),
        commitsLimit: s.optional(s.integer()),
        diffCharBudget: s.optional(s.integer()),
        metadataCharBudget: s.optional(s.integer()),
      },
      { additionalProperties: false }
    )
  ),
  outputSchema: s.object(
    {
      base: s.nullable(s.string()),
      head: s.string(),
      mergeBase: s.nullable(s.string()),
      status: s.nullable(
        s.object({
          branch: s.nullable(s.string()),
          clean: s.boolean(),
          staged: s.array(s.object({ path: s.string() })),
          unstaged: s.array(s.object({ path: s.string() })),
          untracked: s.array(s.string()),
        })
      ),
      changedFiles: s.object({
        branch: s.array(s.object({ path: s.string() })),
        staged: s.array(s.object({ path: s.string() })),
        unstaged: s.array(s.object({ path: s.string() })),
        untracked: s.array(s.string()),
        all: s.array(s.string()),
      }),
      diffStat: s.object({
        branch: s.string(),
        staged: s.string(),
        unstaged: s.string(),
      }),
      diff: s.object({
        branch: s.string(),
        staged: s.string(),
        unstaged: s.string(),
        truncated: s.object({
          branch: s.boolean(),
          staged: s.boolean(),
          unstaged: s.boolean(),
        }),
        workflowBudgetChars: s.integer(),
        workflowCompactions: s.array(s.object({ field: s.string() })),
      }),
      commits: s.object({
        commits: s.array(s.object({ hash: s.string(), subject: s.string() })),
        count: s.integer(),
      }),
      failures: s.array(s.object({ action: s.string(), error: s.string() })),
      flags: s.object({
        hasChanges: s.boolean(),
        hasUncommittedChanges: s.boolean(),
        hasUntrackedChanges: s.boolean(),
        hasOnlyUntrackedChanges: s.boolean(),
        clean: s.boolean(),
      }),
      rendered: s.object({
        snapshotMarkdown: s.string(),
        diffMarkdown: s.string(),
        compactJson: s.string(),
      }),
      compactions: s.array(s.object({ field: s.string() })),
    },
    { additionalProperties: false }
  ),
  permissions: [
    { kind: "command", command: "git status" },
    { kind: "command", command: "git diff" },
    { kind: "command", command: "git log" },
    { kind: "command", command: "git ls-files" },
  ],
  // Aggregate review snapshots can spawn several git commands; allow CI filesystems to breathe.
  timeoutMs: 30000,
};

const DEFAULT_DIFF_CHAR_BUDGET = 60000;
const DEFAULT_METADATA_CHAR_BUDGET = 20000;
const DIFF_FIELDS = ["branch", "staged", "unstaged"];

function boundedInt(value, fallback, min, max) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(min, Math.min(value, max));
}

async function readGitReviewContext(ctx, input, diffBudget) {
  const head = optionalString(input.head) ?? "HEAD";
  const base = await tryResolveBase(ctx, input);
  const mergeBase = base == null ? null : await resolveMergeBase(ctx, base, head);
  const [stagedFiles, unstagedFiles, untrackedOutput] = await Promise.all([
    runGit(ctx, ["diff", "--name-status", "--staged"]).then(parseNameStatus),
    runGit(ctx, ["diff", "--name-status"]).then(parseNameStatus),
    captureGit(ctx, ["ls-files", "--others", "--exclude-standard"], [0]),
  ]);
  const untracked =
    untrackedOutput.text.length === 0 ? [] : untrackedOutput.text.split(/\r?\n/).filter(Boolean);
  const shouldReadDiff = diffBudget > 0;
  const branchFilesPromise =
    mergeBase == null
      ? Promise.resolve([])
      : runGit(ctx, ["diff", "--name-status", mergeBase + ".." + head]).then(parseNameStatus);
  const branchDiffPromise =
    mergeBase == null
      ? Promise.resolve({ text: "", truncated: false })
      : shouldReadDiff
        ? captureGit(ctx, ["diff", mergeBase + ".." + head], [0])
        : branchFilesPromise.then((branchFiles) => ({
            text: "",
            truncated: branchFiles.length > 0,
          }));
  // Keep ctx.exec fan-out bounded; the action runner tracks each spawned child.
  const [branchFiles, stagedDiff, unstagedDiff, branchDiff] = await Promise.all([
    branchFilesPromise,
    shouldReadDiff
      ? captureGit(ctx, ["diff", "--staged"], [0])
      : { text: "", truncated: stagedFiles.length > 0 },
    shouldReadDiff
      ? captureGit(ctx, ["diff"], [0])
      : { text: "", truncated: unstagedFiles.length > 0 },
    branchDiffPromise,
  ]);
  const [stagedStat, unstagedStat, branchStat, commits] = await Promise.all([
    runGit(ctx, ["diff", "--stat", "--staged"]),
    runGit(ctx, ["diff", "--stat"]),
    mergeBase == null ? "" : runGit(ctx, ["diff", "--stat", mergeBase + ".." + head]),
    input.includeCommits === true && mergeBase != null
      ? readCommits(
          ctx,
          mergeBase,
          head,
          boundedInt(input.commitLimit ?? input.commitsLimit, 20, 1, 100)
        )
      : [],
  ]);
  return {
    base,
    head,
    mergeBase,
    changedFiles: {
      base,
      head,
      mergeBase,
      branch: branchFiles,
      staged: stagedFiles,
      unstaged: unstagedFiles,
      untracked,
    },
    diffStat: {
      base,
      head,
      mergeBase,
      branch: branchStat,
      staged: stagedStat,
      unstaged: unstagedStat,
    },
    diff: {
      base,
      head,
      mergeBase,
      branch: branchDiff.text,
      staged: stagedDiff.text,
      unstaged: unstagedDiff.text,
      truncated: {
        branch: branchDiff.truncated,
        staged: stagedDiff.truncated,
        unstaged: unstagedDiff.truncated,
      },
    },
    commits: { base, head, mergeBase, commits, count: commits.length },
  };
}

async function readCommits(ctx, mergeBase, head, limit) {
  const stdout = await runGit(ctx, [
    "log",
    "--max-count=" + String(limit),
    "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%s%x1e",
    mergeBase + ".." + head,
  ]);
  return stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, shortHash, authorName, authorEmail, authoredAt, subject] = record.split("\x1f");
      return { hash, shortHash, authorName, authorEmail, authoredAt, subject };
    });
}

function allChangedFiles(changedFiles, status) {
  const files = [];
  addFileEntries(files, changedFiles.branch);
  addFileEntries(files, changedFiles.staged);
  addFileEntries(files, changedFiles.unstaged);
  addFilePaths(files, changedFiles.untracked);
  addFileEntries(files, status && status.staged);
  addFileEntries(files, status && status.unstaged);
  addFilePaths(files, status && status.untracked);
  return files;
}

function addFileEntries(files, entries) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      addFilePath(files, entry.path);
      addFilePath(files, entry.oldPath);
    }
  }
}

function addFilePaths(files, paths) {
  if (!Array.isArray(paths)) return;
  for (const path of paths) addFilePath(files, path);
}

function addFilePath(files, path) {
  if (typeof path !== "string") return;
  const trimmed = path.trim();
  if (trimmed.length === 0 || files.includes(trimmed)) return;
  files.push(trimmed);
}

function compactDiff(diff, budget) {
  const compacted = {
    base: diff.base,
    head: diff.head,
    mergeBase: diff.mergeBase,
    truncated: diff.truncated,
    workflowBudgetChars: budget,
    workflowCompactions: [],
  };
  let remaining = budget;
  for (const field of DIFF_FIELDS) {
    const value = diff[field];
    if (typeof value !== "string") {
      compacted[field] = value;
      continue;
    }
    const included = Math.max(0, Math.min(value.length, remaining));
    compacted[field] =
      included === value.length
        ? value
        : value.slice(0, included) +
          "\n\n[Workflow prompt budget omitted the rest of the " +
          field +
          " diff.]";
    remaining -= included;
    if (included < value.length)
      compacted.workflowCompactions.push({
        field,
        originalChars: value.length,
        includedChars: included,
      });
  }
  return compacted;
}

function compactText(value, limit) {
  if (typeof value !== "string" || value.length <= limit) return value;
  return (
    value.slice(0, limit) +
    "\n\n[Workflow metadata budget omitted " +
    (value.length - limit) +
    " chars.]"
  );
}

function renderSnapshot(context, files, failures) {
  const sections = [];
  const status = context.status || {};
  sections.push(
    "Repository status: branch " +
      (status.branch || "unknown") +
      (status.upstream ? " tracking " + status.upstream : "") +
      "; staged " +
      arrayLength(status.staged) +
      "; unstaged " +
      arrayLength(status.unstaged) +
      "; untracked " +
      arrayLength(status.untracked)
  );
  if (files.length > 0) sections.push("Changed files: " + files.join(", "));
  if (
    context.commits &&
    Array.isArray(context.commits.commits) &&
    context.commits.commits.length > 0
  ) {
    sections.push(
      "Commits since " +
        (context.commits.base || "unknown") +
        ":\n" +
        context.commits.commits
          .map((commit) => "- " + (commit.shortHash || "unknown") + " " + (commit.subject || ""))
          .join("\n")
    );
  }
  const statSections = [];
  if (hasText(context.diffStat && context.diffStat.branch))
    statSections.push("Branch diff stat:\n" + context.diffStat.branch);
  if (hasText(context.diffStat && context.diffStat.staged))
    statSections.push("Staged diff stat:\n" + context.diffStat.staged);
  if (hasText(context.diffStat && context.diffStat.unstaged))
    statSections.push("Unstaged diff stat:\n" + context.diffStat.unstaged);
  if (statSections.length > 0) sections.push(statSections.join("\n\n"));
  if (arrayLength(status.untracked) > 0)
    sections.push(
      "Untracked file contents are not included in the automatic diff snapshot; only their paths are visible."
    );
  if (failures.length > 0)
    sections.push(
      "Git context warnings:\n" +
        failures.map((failure) => "- " + failure.action + ": " + failure.error).join("\n")
    );
  return sections.join("\n\n");
}

function renderDiff(diff) {
  const parts = [];
  if (hasText(diff.branch))
    parts.push(
      "Branch diff (" +
        (diff.base || "unknown") +
        ".." +
        (diff.head || "unknown") +
        ")\n" +
        diff.branch
    );
  if (hasText(diff.staged)) parts.push("Staged diff\n" + diff.staged);
  if (hasText(diff.unstaged)) parts.push("Unstaged diff\n" + diff.unstaged);
  return parts.join("\n\n");
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}
function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const failures = [];
  let status = null;
  let context = null;
  const diffBudget = boundedInt(input.diffCharBudget, DEFAULT_DIFF_CHAR_BUDGET, 0, 500000);
  try {
    status = await readStatus(ctx, input, { includeIgnored: input.includeIgnored === true });
  } catch (error) {
    failures.push({ action: "git.status", error: String((error && error.message) || error) });
  }
  try {
    context = await readGitReviewContext(ctx, input, diffBudget);
  } catch (error) {
    failures.push({
      action: "git.reviewContext",
      error: String((error && error.message) || error),
    });
    context = {
      base: null,
      head: optionalString(input.head) ?? "HEAD",
      mergeBase: null,
      changedFiles: { branch: [], staged: [], unstaged: [], untracked: [] },
      diffStat: { branch: "", staged: "", unstaged: "" },
      diff: {
        branch: "",
        staged: "",
        unstaged: "",
        truncated: { branch: false, staged: false, unstaged: false },
      },
      commits: { commits: [], count: 0 },
    };
  }
  const files = allChangedFiles(context.changedFiles, status);
  context.changedFiles.all = files;
  context.status = status;
  context.failures = failures;
  const compactedDiff = compactDiff(context.diff, diffBudget);
  const flags = {
    hasChanges:
      files.length > 0 ||
      hasText(context.diff.branch) ||
      hasText(context.diff.staged) ||
      hasText(context.diff.unstaged),
    hasUncommittedChanges:
      arrayLength(status && status.staged) > 0 ||
      arrayLength(status && status.unstaged) > 0 ||
      arrayLength(status && status.untracked) > 0,
    hasUntrackedChanges:
      arrayLength(status && status.untracked) > 0 ||
      arrayLength(context.changedFiles.untracked) > 0,
    hasOnlyUntrackedChanges:
      files.length > 0 &&
      arrayLength(context.changedFiles.branch) === 0 &&
      arrayLength(context.changedFiles.staged) === 0 &&
      arrayLength(context.changedFiles.unstaged) === 0 &&
      !hasText(context.diff.branch) &&
      !hasText(context.diff.staged) &&
      !hasText(context.diff.unstaged),
    clean: Boolean(status && status.clean),
  };
  const snapshotMarkdown = compactText(
    renderSnapshot(context, files, failures),
    boundedInt(input.metadataCharBudget, DEFAULT_METADATA_CHAR_BUDGET, 0, 500000)
  );
  return Object.assign({}, context, {
    diff: compactedDiff,
    flags,
    rendered: {
      snapshotMarkdown,
      diffMarkdown: renderDiff(compactedDiff),
      compactJson: JSON.stringify(
        { status, changedFiles: context.changedFiles, diffStat: context.diffStat, failures, flags },
        null,
        2
      ),
    },
    compactions: compactedDiff.workflowCompactions,
  });
};
