const s = mux.schema;

module.exports.metadata = {
  version: 1,
  description: "Return branch, upstream, and working tree status for the current Git repository",
  effect: "read",
  inputSchema: s.nullable(
    s.object(
      {
        includeIgnored: s.optional(s.boolean()),
        head: s.optional(s.string()),
      },
      { additionalProperties: false }
    )
  ),
  outputSchema: s.object(
    {
      branch: s.nullable(s.string()),
      upstream: s.nullable(s.string()),
      ahead: s.integer(),
      behind: s.integer(),
      headSha: s.nullable(s.string()),
      requestedHead: s.string(),
      requestedHeadSha: s.nullable(s.string()),
      requestedHeadRef: s.nullable(s.string()),
      clean: s.boolean(),
      staged: s.array(
        s.object(
          {
            status: s.string(),
            index: s.string(),
            worktree: s.string(),
            path: s.string(),
            oldPath: s.optional(s.string()),
          },
          { additionalProperties: false }
        )
      ),
      unstaged: s.array(
        s.object(
          {
            status: s.string(),
            index: s.string(),
            worktree: s.string(),
            path: s.string(),
            oldPath: s.optional(s.string()),
          },
          { additionalProperties: false }
        )
      ),
      untracked: s.array(s.string()),
      ignored: s.array(s.string()),
    },
    { additionalProperties: false }
  ),
  permissions: [
    { kind: "command", command: "git status" },
    { kind: "command", command: "git rev-parse" },
  ],
  timeoutMs: 10000,
};

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  return await readStatus(ctx, input, { includeIgnored: input.includeIgnored === true });
};
