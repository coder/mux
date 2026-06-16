const s = mux.schema;

export const metadata = {
  version: 1,
  description: "Read a GitHub issue body and comments as markdown",
  effect: "read",
  inputSchema: s.object(
    {
      repository: s.optional(s.string()),
      owner: s.optional(s.string()),
      repo: s.optional(s.string()),
      number: s.integer(),
      maxComments: s.optional(s.integer()),
      issueBodyCharBudget: s.optional(s.integer()),
      bodyCharBudget: s.optional(s.integer()),
      commentBodyCharBudget: s.optional(s.integer()),
    },
    { additionalProperties: false }
  ),
  outputSchema: s.object(
    {
      repository: s.nullable(s.string()),
      number: s.integer(),
      issue: s.object(
        {
          number: s.integer(),
          safeId: s.string(),
          title: s.string(),
          url: s.string(),
          state: s.string(),
          body: s.string(),
          author: s.nullable(s.string()),
          createdAt: s.nullable(s.string()),
          updatedAt: s.nullable(s.string()),
          labelNames: s.array(s.string()),
        },
        { additionalProperties: false }
      ),
      conversationMarkdown: s.string(),
      limits: s.object(
        {
          maxComments: s.integer(),
          issueBodyBudget: s.integer(),
          commentBodyBudget: s.integer(),
          hasOmittedComments: s.boolean(),
        },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  ),
  permissions: [
    { kind: "command", command: "gh issue view" },
    { kind: "command", command: "gh api" },
  ],
  timeoutMs: 60000,
};

function repositoryPartsForComments(repository, issue) {
  if (repository) return splitRepository(repository);
  const match =
    typeof issue.url === "string"
      ? issue.url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+$/)
      : null;
  if (!match) throw new Error("repository or a GitHub issue URL is required to read comments");
  return { owner: match[1], repo: match[2] };
}

function formatConversation(comments, commentBodyBudget, hasOmittedComments) {
  const visibleComments = Array.isArray(comments) ? comments : [];
  if (visibleComments.length === 0) return "(no issue comments)";
  const markdown = visibleComments
    .map(
      (comment) =>
        "### Comment by " +
        ((comment.user && comment.user.login) ||
          (comment.author && comment.author.login) ||
          "unknown") +
        "\n\n" +
        truncateText(comment.body || "", commentBodyBudget)
    )
    .join("\n\n---\n\n");
  return hasOmittedComments ? markdown + "\n\n[omitted additional comments]" : markdown;
}

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = repositoryFromInput(input);
  const number = requiredIssueNumber(input.number);
  const maxComments = boundedLimit(input.maxComments, 100);
  const issueBodyBudget = boundedIssueViewBodyCaptureBytes(
    boundedCharBudget(input.issueBodyCharBudget ?? input.bodyCharBudget, 10000)
  );
  const commentBodyBudget = boundedCommentBodyCaptureBytes(
    boundedCharBudget(input.commentBodyCharBudget, 10000)
  );
  const issueFields = ["number", "title", "url", "state", "body", "author", "labels"];
  let issue;
  let comments;
  if (repository) {
    const parts = splitRepository(repository);
    [issue, comments] = await Promise.all([
      getIssueView(ctx, repository, number, issueFields, { bodyCharBudget: issueBodyBudget }),
      listComments(ctx, parts.owner, parts.repo, number, {
        limit: maxComments + 1,
        bodyCharBudget: commentBodyBudget,
      }),
    ]);
  } else {
    issue = await getIssueView(ctx, repository, number, issueFields, {
      bodyCharBudget: issueBodyBudget,
    });
    const parts = repositoryPartsForComments(repository, issue);
    comments = await listComments(ctx, parts.owner, parts.repo, number, {
      limit: maxComments + 1,
      bodyCharBudget: commentBodyBudget,
    });
  }
  const visibleComments = comments.slice(0, maxComments);
  const hasOmittedComments = comments.length > visibleComments.length;
  const normalizedIssue = normalizeIssue(issue);
  return {
    repository: repository || null,
    number,
    issue: { ...normalizedIssue, body: truncateText(normalizedIssue.body, issueBodyBudget) },
    conversationMarkdown: formatConversation(
      visibleComments,
      commentBodyBudget,
      hasOmittedComments
    ),
    limits: { maxComments, issueBodyBudget, commentBodyBudget, hasOmittedComments },
  };
}
