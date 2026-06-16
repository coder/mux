const s = mux.schema;

export const metadata = {
  version: 1,
  description:
    "Verify that a GitHub issue comment URL belongs to an issue and contains expected text",
  effect: "read",
  inputSchema: s.object(
    {
      repository: s.optional(s.string()),
      owner: s.optional(s.string()),
      repo: s.optional(s.string()),
      number: s.integer(),
      url: s.string(),
      requiredBodyIncludes: s.optional(s.array(s.string())),
    },
    { additionalProperties: false }
  ),
  outputSchema: s.object(
    {
      verified: s.boolean(),
      reason: s.string(),
      missing: s.optional(s.array(s.string())),
      url: s.optional(s.string()),
      commentId: s.optional(s.union([s.integer(), s.string()])),
    },
    { additionalProperties: false }
  ),
  permissions: [{ kind: "command", command: "gh api" }],
  timeoutMs: 60000,
};

function parseCommentUrl(url) {
  const match = String(url || "").match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)#issuecomment-(\d+)$/
  );
  return match
    ? { owner: match[1], repo: match[2], number: Number(match[3]), commentId: match[4] }
    : null;
}

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = requiredRepository(input);
  const parts = splitRepository(repository);
  const number = requiredIssueNumber(input.number);
  const parsed = parseCommentUrl(requiredString(input.url, "url"));
  if (
    !parsed ||
    parsed.owner !== parts.owner ||
    parsed.repo !== parts.repo ||
    parsed.number !== number
  ) {
    return { verified: false, reason: "comment-url-does-not-match-issue" };
  }
  const comment = await ctx.execJson("gh", [
    "api",
    "repos/" + parts.owner + "/" + parts.repo + "/issues/comments/" + parsed.commentId,
  ]);
  const includes = stringList(input.requiredBodyIncludes);
  const missing = includes.filter(
    (text) => typeof comment.body !== "string" || !comment.body.includes(text)
  );
  if (missing.length > 0)
    return {
      verified: false,
      reason: "missing-required-body-text",
      missing,
      url: comment.html_url || input.url,
    };
  return {
    verified: true,
    reason: "",
    url: comment.html_url || input.url,
    commentId: comment.id || parsed.commentId,
  };
}
