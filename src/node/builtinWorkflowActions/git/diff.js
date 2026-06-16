const s = mux.schema;

module.exports.metadata = {
  version: 1,
  description: "Return git diff output for branch, staged, and unstaged changes",
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
      branch: s.string(),
      staged: s.string(),
      unstaged: s.string(),
      truncated: s.object(
        {
          branch: s.boolean(),
          staged: s.boolean(),
          unstaged: s.boolean(),
        },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  ),
  permissions: [{ kind: "command", command: "git diff" }],
  timeoutMs: 10000,
};

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
