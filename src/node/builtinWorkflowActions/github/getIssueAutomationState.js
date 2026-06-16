export const metadata = {
  version: 1,
  description: "Read GitHub issue automation marker comments and done labels",
  effect: "external",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "gh api" }, { kind: "command", command: "gh issue view" }],
  timeoutMs: 60000,
};

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = requiredRepository(input);
  const parts = splitRepository(repository);
  const number = requiredIssueNumber(input.number);
  const doneLabels = stringList(input.doneLabels);
  const marker = requiredString(input.marker, "marker");
  const markerKey = requiredString(input.markerKey, "markerKey");
  const promptVersion = optionalString(input.promptVersion) || "v1";
  const issue = await ctx.execJson("gh", ["issue", "view", String(number), "--repo", repository, "--json", "labels"]);
  const labelNames = normalizeIssue(issue).labelNames;
  const matching = (await listComments(ctx, parts.owner, parts.repo, number)).filter((comment) =>
    isMatchingMarker(comment.body, marker, markerKey, promptVersion)
  );
  const statuses = matching.map((comment) => markerStatus(comment.body)).filter(Boolean);
  return {
    done: doneLabels.some((label) => labelNames.includes(label)),
    promptStarted: statuses.includes("prompt-started"),
    reportPosted: statuses.includes("report-posted"),
    labelNames,
    markerComments: matching.map((comment) => ({ id: comment.id, url: comment.html_url || null, status: markerStatus(comment.body) })),
  };
}
