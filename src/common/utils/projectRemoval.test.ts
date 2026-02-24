import { describe, expect, it } from "bun:test";
import { getProjectWorkspaceCounts } from "./projectRemoval";

describe("getProjectWorkspaceCounts", () => {
  it("returns zero counts for empty array", () => {
    expect(getProjectWorkspaceCounts([])).toEqual({ activeCount: 0, archivedCount: 0 });
  });

  it("counts all as active when none are archived", () => {
    const workspaces = [
      { archivedAt: undefined, unarchivedAt: undefined },
      { archivedAt: undefined, unarchivedAt: undefined },
    ];

    expect(getProjectWorkspaceCounts(workspaces)).toEqual({ activeCount: 2, archivedCount: 0 });
  });

  it("counts all as archived when all are archived", () => {
    const workspaces = [
      { archivedAt: "2024-01-01T00:00:00Z" },
      { archivedAt: "2024-01-02T00:00:00Z" },
    ];

    expect(getProjectWorkspaceCounts(workspaces)).toEqual({ activeCount: 0, archivedCount: 2 });
  });

  it("distinguishes active and archived", () => {
    const workspaces = [
      { archivedAt: undefined },
      { archivedAt: "2024-01-01T00:00:00Z" },
      { archivedAt: "2024-01-01T00:00:00Z", unarchivedAt: "2024-01-02T00:00:00Z" },
    ];

    expect(getProjectWorkspaceCounts(workspaces)).toEqual({ activeCount: 2, archivedCount: 1 });
  });
});
