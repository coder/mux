export type ExistingBranchSelection =
  | { kind: "local"; branch: string }
  | { kind: "remote"; remote: string; branch: string };

/**
 * Best-effort parsing for persisted/IPC values.
 *
 * Back-compat: older versions stored the branch name as a plain string.
 */
export function parseExistingBranchSelection(value: unknown): ExistingBranchSelection | null {
  if (typeof value === "string") {
    const branch = value.trim();
    if (branch.length === 0) return null;
    return { kind: "local", branch };
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;

    const kind = record.kind;
    const branch = typeof record.branch === "string" ? record.branch.trim() : "";

    if (kind === "local") {
      return branch.length > 0 ? { kind: "local", branch } : null;
    }

    if (kind === "remote") {
      const remote = typeof record.remote === "string" ? record.remote.trim() : "";
      if (remote.length === 0 || branch.length === 0) return null;
      return { kind: "remote", remote, branch };
    }
  }

  return null;
}
