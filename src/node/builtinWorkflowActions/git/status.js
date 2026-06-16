module.exports.metadata = {
  version: 1,
  description: "Return branch, upstream, and working tree status for the current Git repository",
  effect: "read",
  outputSchema: { type: "object" },
  permissions: [
    { kind: "command", command: "git status" },
    { kind: "command", command: "git rev-parse" },
  ],
  timeoutMs: 10000,
};

module.exports.execute = async function (rawInput, ctx) {
  const input = inputObject(rawInput);
  return await readStatus(ctx, input, { includeIgnored: input.includeIgnored !== false });
};
