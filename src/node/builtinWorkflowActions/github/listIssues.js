export const metadata = {
  version: 1,
  description: "List GitHub issues with reusable label/state filters",
  effect: "external",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "gh issue list" }],
  timeoutMs: 60000,
};

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = repositoryFromInput(input);
  const state = optionalString(input.state) || "open";
  const includeLabels = stringList(input.includeLabels);
  const excludeLabels = stringList(input.excludeLabels);
  const limit = boundedLimit(input.limit, 1000);
  const args = [
    "issue",
    "list",
    "--state",
    state,
    "--limit",
    String(limit),
    "--json",
    "number,title,url,state,labels,body,author,createdAt,updatedAt",
  ];
  if (repository) args.push("--repo", repository);
  for (const label of includeLabels) args.push("--label", label);
  const issues = (await ctx.execJson("gh", args))
    .map(normalizeIssue)
    .filter((issue) => includeLabels.every((label) => issue.labelNames.includes(label)))
    .filter((issue) => excludeLabels.every((label) => !issue.labelNames.includes(label)))
    .sort((a, b) => a.number - b.number);
  return { repository: repository || null, filters: { state, includeLabels, excludeLabels, limit }, issues };
}
