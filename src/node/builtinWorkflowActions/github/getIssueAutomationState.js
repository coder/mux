const s = mux.schema;

export const metadata = {
  version: 1,
  description: "Read GitHub issue automation marker comments and done labels",
  effect: "read",
  inputSchema: s.object(
    {
      repository: s.optional(s.string()),
      owner: s.optional(s.string()),
      repo: s.optional(s.string()),
      number: s.integer(),
      doneLabels: s.optional(s.array(s.string())),
      marker: s.string(),
      markerKey: s.string(),
      promptVersion: s.optional(s.string()),
    },
    { additionalProperties: false }
  ),
  outputSchema: s.object(
    {
      done: s.boolean(),
      promptStarted: s.boolean(),
      reportPosted: s.boolean(),
      labelNames: s.array(s.string()),
      markerComments: s.array(
        s.object(
          {
            id: s.integer(),
            url: s.nullable(s.string()),
            status: s.string(),
          },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  ),
  permissions: [
    { kind: "command", command: "gh api" },
    { kind: "command", command: "gh issue view" },
  ],
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
  const [issue, comments] = await Promise.all([
    getIssueView(ctx, repository, number, ["labels"]),
    listComments(ctx, parts.owner, parts.repo, number),
  ]);
  const labelNames = normalizeIssue(issue).labelNames;
  const matching = comments.filter((comment) =>
    isMatchingMarker(comment.body, marker, markerKey, promptVersion)
  );
  const statuses = matching.map((comment) => markerStatus(comment.body)).filter(Boolean);
  return {
    done: doneLabels.some((label) => labelNames.includes(label)),
    promptStarted: statuses.includes("prompt-started"),
    reportPosted: statuses.includes("report-posted"),
    labelNames,
    markerComments: matching.map((comment) => ({
      id: comment.id,
      url: comment.html_url || null,
      status: markerStatus(comment.body),
    })),
  };
}
