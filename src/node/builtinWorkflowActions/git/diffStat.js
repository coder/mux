const s = mux.schema;

module.exports.metadata = {
  version: 1,
  description: "Return git diff --stat output for branch, staged, and unstaged changes",
  effect: "read",
  inputSchema: s.nullable(
    s.object(
      {
        base: s.optional(s.string()),
        trunk: s.optional(s.string()),
        head: s.optional(s.string()),
      },
      { additionalProperties: false }
    )
  ),
  outputSchema: s.object(
    {
      base: s.nullable(s.string()),
      head: s.string(),
      mergeBase: s.nullable(s.string()),
      branch: s.nullable(s.string()),
      staged: s.string(),
      unstaged: s.string(),
    },
    { additionalProperties: false }
  ),
  permissions: [{ kind: "command", command: "git diff" }],
  timeoutMs: 10000,
};

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
