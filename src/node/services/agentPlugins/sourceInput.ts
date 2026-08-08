import { GITHUB_SHORTHAND_PATTERN, normalizeRepoUrlForClone } from "@/node/utils/gitUrls";

/**
 * Agent Plugin install source grammar.
 *
 * Accepted inputs (one text field):
 * - `owner/repo` — GitHub shorthand
 * - `owner/repo@ref` — shorthand with a branch, tag, or full 40-hex commit SHA
 * - `owner/repo/sub/path[@ref]` — shorthand with a monorepo subpath (parsed
 *   and persisted from day one; the v1 installer rejects subpath installs)
 * - any git remote URL (`https://…`, `ssh://…`, `git@host:path`, `file://…`,
 *   absolute local paths) — passed to git unchanged; refs for URL inputs come
 *   from the separate ref field because `@` is ambiguous inside URLs
 */

export interface ParsedAgentPluginSourceInput {
  /** Normalized git clone URL. */
  url: string;
  /** Branch/tag name or full commit SHA parsed from `@ref` shorthand. */
  ref?: string;
  /** Repo-relative plugin directory parsed from shorthand (monorepo installs; v2). */
  subpath?: string;
}

const FULL_COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i;

/** True when `ref` is a full 40-hex commit SHA (short SHAs cannot be fetched shallowly). */
export function isFullCommitSha(ref: string): boolean {
  return FULL_COMMIT_SHA_PATTERN.test(ref);
}

function isUrlLike(input: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    return true; // protocol URLs: https://, ssh://, git://, file://, …
  }
  if (input.startsWith("git@")) {
    return true; // common SCP-style form
  }
  if (input.startsWith("/") || input.startsWith("~") || /^[a-zA-Z]:[\\/]/.test(input)) {
    return true; // absolute local paths (incl. Windows drive letters)
  }
  // Other SCP-style forms ([user@]host:path). Exclude `owner/repo@ref`
  // shorthand, which has no colon.
  return /^[a-zA-Z0-9._-]+@[^:]+:.+$/.test(input);
}

/**
 * Parse the Add Plugin source input. Throws with a user-facing message when
 * the input matches no accepted form.
 */
export function parseAgentPluginSourceInput(rawInput: string): ParsedAgentPluginSourceInput {
  const input = rawInput.trim();
  if (input.length === 0) {
    throw new Error("Enter a git URL or owner/repo shorthand.");
  }

  if (isUrlLike(input)) {
    // normalizeRepoUrlForClone strips query strings/fragments from URL-like inputs.
    return { url: normalizeRepoUrlForClone(input) };
  }

  if (input.startsWith(".")) {
    throw new Error(
      `'${input}' looks like a relative path. Use an absolute path, a git URL, or owner/repo shorthand.`
    );
  }

  // Shorthand: owner/repo[/sub/path][@ref]. Split the ref at the first `@` —
  // GitHub owner/repo segments cannot contain `@`.
  const atIndex = input.indexOf("@");
  const pathPart = atIndex === -1 ? input : input.slice(0, atIndex);
  const refPart = atIndex === -1 ? undefined : input.slice(atIndex + 1);

  if (refPart?.length === 0) {
    throw new Error("Ref after '@' must not be empty (use owner/repo@branch, @tag, or @sha).");
  }

  const segments = pathPart.split("/");
  if (segments.length < 2 || segments.some((segment) => segment.length === 0)) {
    throw new Error(
      `'${input}' is not a git URL or owner/repo shorthand. Examples: coder/mux, coder/mux@main, https://github.com/coder/mux.git`
    );
  }

  const ownerRepo = `${segments[0]}/${segments[1]}`;
  if (!GITHUB_SHORTHAND_PATTERN.test(ownerRepo)) {
    throw new Error(`'${ownerRepo}' is not a valid owner/repo shorthand.`);
  }

  const subpath = segments.slice(2).join("/");
  return {
    url: normalizeRepoUrlForClone(ownerRepo),
    ...(refPart !== undefined ? { ref: refPart } : {}),
    ...(subpath.length > 0 ? { subpath } : {}),
  };
}
