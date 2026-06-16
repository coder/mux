module.exports.metadata = {
  version: 1,
  description: "Return changed file lists for branch, staged, unstaged, and untracked Git state",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [
    { kind: "command", command: "git diff" },
    { kind: "command", command: "git ls-files" },
  ],
  timeoutMs: 10000,
};

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  const head = optionalString(input.head) ?? "HEAD";
  const staged = parseNameStatus(await runGit(ctx, ["diff", "--name-status", "--staged"]));
  const unstaged = parseNameStatus(await runGit(ctx, ["diff", "--name-status"]));
  const untrackedOutput = await runGit(ctx, ["ls-files", "--others", "--exclude-standard"]);
  const untracked =
    untrackedOutput.length === 0 ? [] : untrackedOutput.split(/\r?\n/).filter(Boolean);
  const base = await tryResolveBase(ctx, input);
  if (base == null) {
    return { base: null, head, mergeBase: null, branch: [], staged, unstaged, untracked };
  }
  const mergeBase = await resolveMergeBase(ctx, base, head);
  const branch = parseNameStatus(
    await runGit(ctx, ["diff", "--name-status", mergeBase + ".." + head])
  );
  return { base, head, mergeBase, branch, staged, unstaged, untracked };
};
