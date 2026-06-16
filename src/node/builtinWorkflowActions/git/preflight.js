module.exports.metadata = {
  version: 1,
  description: "Validate that the current Git checkout is safe for workflow patch application",
  effect: "read",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [
    { kind: "command", command: "git status" },
    { kind: "command", command: "git rev-parse" },
  ],
  timeoutMs: 10000,
};

function normalizedBranch(branch) {
  if (typeof branch !== "string") return "";
  const trimmed = branch.trim();
  return trimmed && trimmed !== "HEAD (no branch)" ? trimmed : "";
}

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const status = await readStatus(ctx, input);
  const expectedBranch = optionalString(input.expectedBranch);
  const expectedHeadSha = optionalString(input.expectedHeadSha);
  const requireClean = input.requireClean !== false && input.allowDirty !== true;
  if (expectedBranch && normalizedBranch(status.branch) !== expectedBranch) {
    return {
      ok: false,
      reason:
        "Current branch " +
        (status.branch || "unknown") +
        " does not match expected branch " +
        expectedBranch,
      status,
      expectedBranch,
      expectedHeadSha,
    };
  }
  if (expectedHeadSha && status.headSha !== expectedHeadSha) {
    return {
      ok: false,
      reason:
        "Current HEAD " +
        (status.headSha || "unknown") +
        " does not match expected HEAD " +
        expectedHeadSha,
      status,
      expectedBranch,
      expectedHeadSha,
    };
  }
  if (requireClean && !status.clean) {
    return {
      ok: false,
      reason: "Current worktree is dirty; commit or stash changes before applying workflow patches",
      status,
      expectedBranch,
      expectedHeadSha,
    };
  }
  return { ok: true, reason: "", status, expectedBranch, expectedHeadSha };
};
