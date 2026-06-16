const s = mux.schema;

export const metadata = {
  version: 1,
  description: "Create or update a GitHub issue comment selected by marker",
  effect: "external",
  inputSchema: s.object(
    {
      repository: s.optional(s.string()),
      owner: s.optional(s.string()),
      repo: s.optional(s.string()),
      number: s.integer(),
      marker: s.string(),
      body: s.string(),
    },
    { additionalProperties: false }
  ),
  outputSchema: s.object(
    {
      action: s.enum(["created", "updated"]),
      commentId: s.nullable(s.integer()),
      url: s.nullable(s.string()),
    },
    { additionalProperties: false }
  ),
  permissions: [{ kind: "command", command: "gh api" }],
  timeoutMs: 60000,
};

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = requiredRepository(input);
  const parts = splitRepository(repository);
  const number = requiredIssueNumber(input.number);
  const marker = requiredString(input.marker, "marker");
  const body = requiredString(input.body, "body");
  const existing = await findComment(
    ctx,
    parts.owner,
    parts.repo,
    number,
    (comment) => typeof comment.body === "string" && comment.body.includes(marker)
  );
  const payload = await ctx.writeTempJson({ body });
  if (existing) {
    await ctx.execChecked("gh", [
      "api",
      "-X",
      "PATCH",
      "repos/" + parts.owner + "/" + parts.repo + "/issues/comments/" + existing.id,
      "--input",
      payload.path,
    ]);
    return { action: "updated", commentId: existing.id, url: existing.html_url || null };
  }
  const created = await ctx.execJson("gh", [
    "api",
    "-X",
    "POST",
    "repos/" + parts.owner + "/" + parts.repo + "/issues/" + number + "/comments",
    "--input",
    payload.path,
  ]);
  return { action: "created", commentId: created.id || null, url: created.html_url || null };
}

export async function reconcile(input, ctx) {
  return await execute(input, ctx);
}
