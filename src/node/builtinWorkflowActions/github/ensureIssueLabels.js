export const metadata = {
  version: 1,
  description: "Idempotently add and remove GitHub issue labels",
  effect: "external",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  permissions: [{ kind: "command", command: "gh issue edit" }, { kind: "command", command: "gh issue view" }],
  timeoutMs: 60000,
};

async function getLabelNames(ctx, repository, number) {
  const args = ["issue", "view", String(number), "--json", "labels"];
  if (repository) args.push("--repo", repository);
  const issue = await ctx.execJson("gh", args);
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
  if (missingAddLabels.length > 0 || presentRemoveLabels.length > 0) {
    const args = ["issue", "edit", String(number)];
    if (repository) args.push("--repo", repository);
    for (const label of missingAddLabels) args.push("--add-label", label);
    for (const label of presentRemoveLabels) args.push("--remove-label", label);
    await ctx.execChecked("gh", args);
  }
  const after = await getLabelNames(ctx, repository, number);
  return {
    changed: missingAddLabels.length > 0 || presentRemoveLabels.length > 0,
    before,
    after,
    added: missingAddLabels,
    removed: presentRemoveLabels,
  };
}

export const reconcile = execute;
