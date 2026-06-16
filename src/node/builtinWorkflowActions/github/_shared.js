function inputObject(input) {
  return input != null && typeof input === "object" && !Array.isArray(input) ? input : {};
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function requiredString(value, name) {
  const text = optionalString(value);
  if (!text) throw new Error(name + " must be a non-empty string");
  return text;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function repositoryFromInput(input) {
  const repository = optionalString(input.repository);
  if (repository) return repository;
  const owner = optionalString(input.owner);
  const repo = optionalString(input.repo);
  return owner && repo ? owner + "/" + repo : undefined;
}

function requiredRepository(input) {
  const repository = repositoryFromInput(input);
  if (!repository) throw new Error("repository or owner/repo is required");
  return repository;
}

function splitRepository(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("repository must use owner/repo format");
  }
  return { owner: parts[0], repo: parts[1] };
}

function requiredIssueNumber(value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("number must be a positive integer issue number");
  }
  return value;
}

function boundedLimit(value, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(1, Math.min(value, 1000));
}

function normalizeIssue(issue) {
  const labelNames = Array.isArray(issue.labels)
    ? issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter((name) => typeof name === "string" && name.length > 0)
    : [];
  return {
    number: issue.number,
    safeId: "issue-" + issue.number,
    title: issue.title || "",
    url: issue.url || "",
    state: issue.state || "",
    body: issue.body || "",
    author: issue.author && issue.author.login ? issue.author.login : null,
    createdAt: issue.createdAt || null,
    updatedAt: issue.updatedAt || null,
    labelNames,
  };
}

function markerCommentNeedle(marker, markerKey, promptVersion) {
  return "<!-- " + marker + " key=" + markerKey + " promptVersion=" + promptVersion;
}

function isMatchingMarker(body, marker, markerKey, promptVersion) {
  return typeof body === "string" && body.includes(markerCommentNeedle(marker, markerKey, promptVersion));
}

function markerStatus(body) {
  const match = typeof body === "string" ? body.match(/status=([a-z0-9_-]+)/i) : null;
  return match ? match[1] : "";
}

async function listComments(ctx, owner, repo, number) {
  const comments = [];
  for (let page = 1; page <= 10; page += 1) {
    const pageComments = await ctx.execJson("gh", [
      "api",
      "repos/" + owner + "/" + repo + "/issues/" + number + "/comments?per_page=100&page=" + page,
    ]);
    comments.push(...pageComments);
    if (pageComments.length < 100) break;
  }
  return comments;
}
