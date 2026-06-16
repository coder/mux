export const metadata = {
  version: 1,
  description: "Read a GitHub issue body and comments as markdown",
  effect: "external",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "gh issue view" }],
  timeoutMs: 60000,
};

function formatConversation(comments) {
  if (!Array.isArray(comments) || comments.length === 0) return "(no issue comments)";
  return comments
    .map((comment) => "### Comment by " + ((comment.author && comment.author.login) || "unknown") + "\n\n" + (comment.body || ""))
    .join("\n\n---\n\n");
}

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = repositoryFromInput(input);
  const number = requiredIssueNumber(input.number);
  const args = ["issue", "view", String(number), "--json", "number,title,url,state,body,author,comments,labels"];
  if (repository) args.push("--repo", repository);
  const issue = await ctx.execJson("gh", args);
  return {
    repository: repository || null,
    number,
    issue: normalizeIssue(issue),
    conversationMarkdown: formatConversation(issue.comments),
  };
}
