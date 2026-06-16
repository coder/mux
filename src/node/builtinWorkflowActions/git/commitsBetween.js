const s = mux.schema;

module.exports.metadata = {
  version: 1,
  description: "Return commits reachable from head but not from the trunk/base branch",
  effect: "read",
  inputSchema: s.nullable(
    s.object(
      {
        base: s.optional(s.string()),
        trunk: s.optional(s.string()),
        head: s.optional(s.string()),
        limit: s.optional(s.integer()),
      },
      { additionalProperties: false }
    )
  ),
  outputSchema: s.object(
    {
      base: s.string(),
      head: s.string(),
      mergeBase: s.string(),
      commits: s.array(
        s.object(
          {
            hash: s.string(),
            shortHash: s.string(),
            authorName: s.string(),
            authorEmail: s.string(),
            authoredAt: s.string(),
            subject: s.string(),
          },
          { additionalProperties: false }
        )
      ),
      count: s.integer(),
    },
    { additionalProperties: false }
  ),
  permissions: [{ kind: "command", command: "git log" }],
  timeoutMs: 10000,
};

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
  const commits = stdout
    .split("\x1e")
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record) => {
      const [hash, shortHash, authorName, authorEmail, authoredAt, subject] = record.split("\x1f");
      return { hash, shortHash, authorName, authorEmail, authoredAt, subject };
    });
  return { base, head, mergeBase, commits, count: commits.length };
};
