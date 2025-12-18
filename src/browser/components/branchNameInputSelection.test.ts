import { describe, expect, test } from "bun:test";

import { inferExactExistingBranchSelection } from "./branchNameInputSelection";

describe("inferExactExistingBranchSelection", () => {
  test("returns local selection on exact local match", () => {
    const selection = inferExactExistingBranchSelection({
      value: "feature/foo",
      localBranches: ["main", "feature/foo"],
      remoteGroups: [{ remote: "origin", branches: ["feature/foo"] }],
    });

    expect(selection).toEqual({ kind: "local", branch: "feature/foo" });
  });

  test("returns remote selection on exact remote match", () => {
    const selection = inferExactExistingBranchSelection({
      value: "feature/foo",
      localBranches: ["main"],
      remoteGroups: [{ remote: "origin", branches: ["feature/foo"] }],
    });

    expect(selection).toEqual({ kind: "remote", remote: "origin", branch: "feature/foo" });
  });

  test("prefers origin when multiple remotes contain the same branch", () => {
    const selection = inferExactExistingBranchSelection({
      value: "feature/foo",
      localBranches: [],
      remoteGroups: [
        { remote: "upstream", branches: ["feature/foo"] },
        { remote: "origin", branches: ["feature/foo"] },
      ],
    });

    expect(selection).toEqual({ kind: "remote", remote: "origin", branch: "feature/foo" });
  });

  test("returns null when there is no exact match", () => {
    const selection = inferExactExistingBranchSelection({
      value: "feature/foo",
      localBranches: ["main"],
      remoteGroups: [{ remote: "origin", branches: ["feature/bar"] }],
    });

    expect(selection).toBeNull();
  });
});
