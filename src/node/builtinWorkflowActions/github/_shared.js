const ISSUE_BODY_CAPTURE_BUDGET = 4000;
const ISSUE_VIEW_BODY_CAPTURE_BYTES = 50000;
// Keep list responses under ctx.execJson's 64 KiB stdout capture limit; issue
// metadata also needs room, so body text gets a smaller shared byte budget.
const ISSUE_LIST_BODY_CAPTURE_BYTES = 24000;
const COMMENT_PAGE_SIZE = 10;
const COMMENT_PAGE_BODY_CAPTURE_BYTES = 50000;
const COMMENT_BODY_CAPTURE_BUDGET = 4000;
const DEFAULT_COMMENT_LIMIT = 100;

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

function boundedCharBudget(value, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.max(0, Math.min(value, 100000));
}

function boundedIssueListBodyCaptureBytes(limit, bodyCharBudget) {
  const perIssueBudget = Math.floor(ISSUE_LIST_BODY_CAPTURE_BYTES / Math.max(1, limit));
  return Math.max(0, Math.min(bodyCharBudget, ISSUE_BODY_CAPTURE_BUDGET, perIssueBudget));
}

function boundedIssueViewBodyCaptureBytes(bodyCharBudget) {
  return Math.max(0, Math.min(bodyCharBudget, ISSUE_VIEW_BODY_CAPTURE_BYTES));
}

function commentPageSizeForBodyBudget(bodyCharBudget) {
  const safeBudget = Math.max(1, bodyCharBudget);
  return Math.max(
    1,
    Math.min(COMMENT_PAGE_SIZE, Math.floor(COMMENT_PAGE_BODY_CAPTURE_BYTES / safeBudget))
  );
}

function boundedCommentBodyCaptureBytes(bodyCharBudget) {
  const pageSize = commentPageSizeForBodyBudget(bodyCharBudget);
  const perCommentBudget = Math.floor(COMMENT_PAGE_BODY_CAPTURE_BYTES / pageSize);
  return Math.max(0, Math.min(bodyCharBudget, perCommentBudget));
}

function commentBodyCaptureBudget(options) {
  return boundedCommentBodyCaptureBytes(
    boundedCharBudget(options && options.bodyCharBudget, COMMENT_BODY_CAPTURE_BUDGET)
  );
}

function commentPageSize(options) {
  return commentPageSizeForBodyBudget(commentBodyCaptureBudget(options));
}

function utf8TruncateJqDefinitions() {
  return (
    "def mux_truncate_utf8($limit): " +
    "reduce explode[] as $codepoint ({ bytes: 0, codepoints: [] }; " +
    "($codepoint | [.] | implode | utf8bytelength) as $byteLength | " +
    "if .bytes + $byteLength <= $limit then " +
    "{ bytes: (.bytes + $byteLength), codepoints: (.codepoints + [$codepoint]) } " +
    "else . end) | .codepoints | implode; " +
    "def mux_truncate_utf8_with_marker($limit): " +
    "if utf8bytelength > $limit then " +
    '(mux_truncate_utf8($limit) + "\\n\\n[truncated by mux after " + ($limit | tostring) + " bytes]") ' +
    "else . end; "
  );
}

function issueBodyJq(byteBudget) {
  return (
    utf8TruncateJqDefinitions() +
    `.body = ((.body // "") | mux_truncate_utf8_with_marker(${byteBudget}))`
  );
}

function commentsPageJq(byteBudget) {
  return (
    utf8TruncateJqDefinitions() +
    `[.[] | { id, html_url, user, author, body: ((.body // "") | mux_truncate_utf8_with_marker(${byteBudget})) }]`
  );
}

function issueListBodyJq(byteBudget) {
  return (
    "def mux_truncate_utf8($limit): " +
    "reduce explode[] as $codepoint ({ bytes: 0, codepoints: [] }; " +
    "($codepoint | [.] | implode | utf8bytelength) as $byteLength | " +
    "if .bytes + $byteLength <= $limit then " +
    "{ bytes: (.bytes + $byteLength), codepoints: (.codepoints + [$codepoint]) } " +
    "else . end) | .codepoints | implode; " +
    `map(.body = ((.body // "") | mux_truncate_utf8(${byteBudget})))`
  );
}

function quoteSearchLabel(label) {
  return '"' + label.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function excludedLabelSearchQuery(labels) {
  return labels.map((label) => "-label:" + quoteSearchLabel(label)).join(" ");
}

function truncateText(value, budget) {
  const text = typeof value === "string" ? value : "";
  if (text.length <= budget) return text;
  return text.slice(0, budget) + "\n\n[truncated " + (text.length - budget) + " chars]";
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
  return (
    typeof body === "string" && body.includes(markerCommentNeedle(marker, markerKey, promptVersion))
  );
}

function markerStatus(body) {
  const match = typeof body === "string" ? body.match(/status=([a-z0-9_-]+)/i) : null;
  return match ? match[1] : "";
}

async function getIssueView(ctx, repository, number, fields, options) {
  const args = ["issue", "view", String(number), "--json", fields.join(",")];
  if (repository) args.push("--repo", repository);
  if (fields.includes("body")) {
    const bodyCaptureBudget = boundedIssueViewBodyCaptureBytes(
      boundedCharBudget(options && options.bodyCharBudget, ISSUE_BODY_CAPTURE_BUDGET)
    );
    args.push("--jq", issueBodyJq(bodyCaptureBudget));
  }
  return await ctx.execJson("gh", args);
}

async function fetchCommentsPage(ctx, owner, repo, number, page, options) {
  const bodyCaptureBudget = commentBodyCaptureBudget(options);
  const pageSize = commentPageSize(options);
  return await ctx.execJson("gh", [
    "api",
    "repos/" +
      owner +
      "/" +
      repo +
      "/issues/" +
      number +
      "/comments?per_page=" +
      pageSize +
      "&page=" +
      page,
    "--jq",
    commentsPageJq(bodyCaptureBudget),
  ]);
}

// Marker lookups must scan busy issues beyond the first 100 comments; each page
// is still body-truncated before stdout capture.
async function listComments(ctx, owner, repo, number, options) {
  const comments = [];
  const limit = Number.isInteger(options && options.limit)
    ? boundedLimit(options.limit, DEFAULT_COMMENT_LIMIT)
    : null;
  const pageSize = commentPageSize(options);
  for (let page = 1; ; page += 1) {
    const pageComments = await fetchCommentsPage(ctx, owner, repo, number, page, options);
    for (const comment of pageComments) {
      comments.push(comment);
      if (limit != null && comments.length >= limit) return comments;
    }
    if (pageComments.length < pageSize) break;
  }
  return comments;
}

async function findComment(ctx, owner, repo, number, predicate, options) {
  const pageSize = commentPageSize(options);
  for (let page = 1; ; page += 1) {
    const pageComments = await fetchCommentsPage(ctx, owner, repo, number, page, options);
    const match = pageComments.find(predicate);
    if (match) return match;
    if (pageComments.length < pageSize) break;
  }
  return undefined;
}
