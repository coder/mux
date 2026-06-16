const s = mux.schema;

export const metadata = {
  version: 1,
  description: "List GitHub issues with reusable label/state filters",
  effect: "read",
  inputSchema: s.nullable(
    s.object(
      {
        repository: s.optional(s.string()),
        owner: s.optional(s.string()),
        repo: s.optional(s.string()),
        state: s.optional(s.string()),
        includeLabels: s.optional(s.array(s.string())),
        excludeLabels: s.optional(s.array(s.string())),
        limit: s.optional(s.integer()),
        includeBody: s.optional(s.boolean()),
        bodyCharBudget: s.optional(s.integer()),
      },
      { additionalProperties: false }
    )
  ),
  outputSchema: s.object(
    {
      repository: s.nullable(s.string()),
      filters: s.object(
        {
          state: s.string(),
          includeLabels: s.array(s.string()),
          excludeLabels: s.array(s.string()),
          limit: s.integer(),
          includeBody: s.boolean(),
          bodyCharBudget: s.integer(),
        },
        { additionalProperties: false }
      ),
      issues: s.array(
        s.object(
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
        )
      ),
    },
    { additionalProperties: false }
  ),
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
  const includeBody = input.includeBody === true;
  const bodyCharBudget = boundedCharBudget(input.bodyCharBudget, 2000);
  const jsonFields =
    "number,title,url,state,labels,author,createdAt,updatedAt" + (includeBody ? ",body" : "");
  const args = ["issue", "list", "--state", state, "--limit", String(limit), "--json", jsonFields];
  if (repository) args.push("--repo", repository);
  for (const label of includeLabels) args.push("--label", label);
  const issues = (await ctx.execJson("gh", args))
    .map(normalizeIssue)
    .map((issue) => ({
      ...issue,
      body: includeBody ? truncateText(issue.body, bodyCharBudget) : "",
    }))
    .filter((issue) => includeLabels.every((label) => issue.labelNames.includes(label)))
    .filter((issue) => excludeLabels.every((label) => !issue.labelNames.includes(label)))
    .sort((a, b) => a.number - b.number);
  return {
    repository: repository || null,
    filters: { state, includeLabels, excludeLabels, limit, includeBody, bodyCharBudget },
    issues,
  };
}
