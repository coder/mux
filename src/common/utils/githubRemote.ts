export interface GitHubRemoteIdentity {
  owner: string;
  repo: string;
}

const GITHUB_SEGMENT_PATTERN = /^[A-Za-z0-9_.-]+$/;

function parsePath(pathname: string): GitHubRemoteIdentity | null {
  const normalized = pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = normalized.split("/");
  if (
    segments.length !== 2 ||
    !segments[0] ||
    !segments[1] ||
    !GITHUB_SEGMENT_PATTERN.test(segments[0]) ||
    !GITHUB_SEGMENT_PATTERN.test(segments[1])
  ) {
    return null;
  }
  return { owner: segments[0], repo: segments[1] };
}

export function parseGitHubRemote(remote: string): GitHubRemoteIdentity | null {
  const trimmed = remote.trim();
  if (!trimmed) {
    return null;
  }

  const scpMatch = /^(?:[^@\s]+@)?github\.com:(.+)$/i.exec(trimmed);
  if (scpMatch) {
    return parsePath(scpMatch[1]);
  }

  try {
    const url = new URL(trimmed);
    if (url.hostname.toLowerCase() !== "github.com") {
      return null;
    }
    if (url.protocol !== "https:" && url.protocol !== "ssh:") {
      return null;
    }
    return parsePath(url.pathname);
  } catch {
    return null;
  }
}
