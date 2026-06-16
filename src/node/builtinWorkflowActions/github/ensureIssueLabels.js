const s = mux.schema;

export const metadata = {
  version: 1,
  description: "Idempotently add and remove GitHub issue labels",
  effect: "external",
  inputSchema: s.object(
    {
      repository: s.optional(s.string()),
      owner: s.optional(s.string()),
      repo: s.optional(s.string()),
      number: s.integer(),
      addLabels: s.optional(s.array(s.string())),
      removeLabels: s.optional(s.array(s.string())),
    },
    { additionalProperties: false }
  ),
  outputSchema: s.object(
    {
      changed: s.boolean(),
      before: s.array(s.string()),
      after: s.array(s.string()),
      added: s.array(s.string()),
      removed: s.array(s.string()),
    },
    { additionalProperties: false }
  ),
  permissions: [
    { kind: "command", command: "gh issue edit" },
    { kind: "command", command: "gh issue view" },
  ],
  timeoutMs: 60000,
};

async function getLabelNames(ctx, repository, number) {
  const issue = await getIssueView(ctx, repository, number, ["labels"]);
  return normalizeIssue(issue).labelNames;
}

export async function execute(rawInput, ctx) {
  const input = inputObject(rawInput);
  const repository = repositoryFromInput(input);
  const number = requiredIssueNumber(input.number);
  const addLabels = stringList(input.addLabels);
  const removeLabels = stringList(input.removeLabels);
  const before = await getLabelNames(ctx, repository, number);
  const missingAddLabels = addLabels.filter((label) => !before.includes(label));
  const presentRemoveLabels = removeLabels.filter((label) => before.includes(label));
  if (missingAddLabels.length === 0 && presentRemoveLabels.length === 0) {
    return { changed: false, before, after: before, added: [], removed: [] };
  }
  const args = ["issue", "edit", String(number)];
  if (repository) args.push("--repo", repository);
  for (const label of missingAddLabels) args.push("--add-label", label);
  for (const label of presentRemoveLabels) args.push("--remove-label", label);
  await ctx.execChecked("gh", args);
  const after = before.filter((label) => !presentRemoveLabels.includes(label));
  for (const label of missingAddLabels) {
    if (!after.includes(label)) after.push(label);
  }
  return {
    changed: true,
    before,
    after,
    added: missingAddLabels,
    removed: presentRemoveLabels,
  };
}

export async function reconcile(input, ctx) {
  return await execute(input, ctx);
}
