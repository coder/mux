const s = mux.schema;

module.exports.metadata = {
  version: 1,
  description: "Return changed file lists for branch, staged, unstaged, and untracked Git state",
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
      branch: s.array(
        s.object(
          {
            status: s.string(),
            path: s.string(),
            oldPath: s.optional(s.string()),
          },
          { additionalProperties: false }
        )
      ),
      staged: s.array(
        s.object(
          {
            status: s.string(),
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
            path: s.string(),
            oldPath: s.optional(s.string()),
          },
          { additionalProperties: false }
        )
      ),
      untracked: s.array(s.string()),
    },
    { additionalProperties: false }
  ),
  permissions: [
    { kind: "command", command: "git diff" },
    { kind: "command", command: "git ls-files" },
  ],
  timeoutMs: 10000,
};

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const head = optionalString(input.head) ?? "HEAD";
  const staged = parseNameStatus(await runGit(ctx, ["diff", "--name-status", "--staged"]));
  const unstaged = parseNameStatus(await runGit(ctx, ["diff", "--name-status"]));
  const untrackedOutput = await runGit(ctx, ["ls-files", "--others", "--exclude-standard"]);
  const untracked =
    untrackedOutput.length === 0 ? [] : untrackedOutput.split(/\r?\n/).filter(Boolean);
  const base = await tryResolveBase(ctx, input);
  if (base == null) {
    return { base: null, head, mergeBase: null, branch: [], staged, unstaged, untracked };
  }
  const mergeBase = await resolveMergeBase(ctx, base, head);
  const branch = parseNameStatus(
    await runGit(ctx, ["diff", "--name-status", mergeBase + ".." + head])
  );
  return { base, head, mergeBase, branch, staged, unstaged, untracked };
};
