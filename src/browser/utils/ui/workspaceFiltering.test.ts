import { describe, it, expect } from "@jest/globals";
import {
  partitionWorkspacesByAge,
  formatDaysThreshold,
  AGE_THRESHOLDS_DAYS,
} from "./workspaceFiltering";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";

describe("partitionWorkspacesByAge", () => {
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  const createWorkspace = (id: string): FrontendWorkspaceMetadata => ({
    id,
    name: `workspace-${id}`,
    projectName: "test-project",
    projectPath: "/test/project",
    namedWorkspacePath: `/test/project/workspace-${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
  });

  // Helper to get all "old" workspaces (all buckets combined)
  const getAllOld = (buckets: FrontendWorkspaceMetadata[][]) => buckets.flat();

  it("should partition workspaces into recent and old based on 24-hour threshold", () => {
    const workspaces = [
      createWorkspace("recent1"),
      createWorkspace("old1"),
      createWorkspace("recent2"),
      createWorkspace("old2"),
    ];

    const workspaceRecency = {
      recent1: now - 1000, // 1 second ago
      old1: now - ONE_DAY_MS - 1000, // 24 hours and 1 second ago
      recent2: now - 12 * 60 * 60 * 1000, // 12 hours ago
      old2: now - 2 * ONE_DAY_MS, // 2 days ago
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(2);
    expect(recent.map((w) => w.id)).toEqual(expect.arrayContaining(["recent1", "recent2"]));

    expect(old).toHaveLength(2);
    expect(old.map((w) => w.id)).toEqual(expect.arrayContaining(["old1", "old2"]));
  });

  it("should treat workspaces with no recency timestamp as old", () => {
    const workspaces = [createWorkspace("no-activity"), createWorkspace("recent")];

    const workspaceRecency = {
      recent: now - 1000,
      // no-activity has no timestamp
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("recent");

    expect(old).toHaveLength(1);
    expect(old[0].id).toBe("no-activity");
  });

  it("should handle empty workspace list", () => {
    const { recent, buckets } = partitionWorkspacesByAge([], {});

    expect(recent).toHaveLength(0);
    expect(buckets).toHaveLength(AGE_THRESHOLDS_DAYS.length);
    expect(buckets.every((b) => b.length === 0)).toBe(true);
  });

  it("should handle workspace at exactly 24 hours (should show as recent due to always-show-one rule)", () => {
    const workspaces = [createWorkspace("exactly-24h")];

    const workspaceRecency = {
      "exactly-24h": now - ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    // Even though it's exactly 24 hours old, it should show as recent (always show at least one)
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("exactly-24h");
    expect(old).toHaveLength(0);
  });

  it("should preserve workspace order within partitions", () => {
    const workspaces = [
      createWorkspace("recent"),
      createWorkspace("old1"),
      createWorkspace("old2"),
      createWorkspace("old3"),
    ];

    const workspaceRecency = {
      recent: now - 1000,
      old1: now - 2 * ONE_DAY_MS,
      old2: now - 3 * ONE_DAY_MS,
      old3: now - 4 * ONE_DAY_MS,
    };

    const { buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(old.map((w) => w.id)).toEqual(["old1", "old2", "old3"]);
  });

  it("should always show at least one workspace when all are old", () => {
    const workspaces = [createWorkspace("old1"), createWorkspace("old2"), createWorkspace("old3")];

    const workspaceRecency = {
      old1: now - 2 * ONE_DAY_MS,
      old2: now - 3 * ONE_DAY_MS,
      old3: now - 4 * ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    // Most recent should be moved to recent section
    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("old1");

    // Remaining should stay in old section
    expect(old).toHaveLength(2);
    expect(old.map((w) => w.id)).toEqual(["old2", "old3"]);
  });

  it("should partition into correct age buckets", () => {
    const workspaces = [
      createWorkspace("recent"), // < 1 day
      createWorkspace("bucket0"), // 1-7 days
      createWorkspace("bucket1"), // 7-30 days
      createWorkspace("bucket2"), // > 30 days
    ];

    const workspaceRecency = {
      recent: now - 12 * 60 * 60 * 1000, // 12 hours
      bucket0: now - 3 * ONE_DAY_MS, // 3 days (1-7 day bucket)
      bucket1: now - 15 * ONE_DAY_MS, // 15 days (7-30 day bucket)
      bucket2: now - 60 * ONE_DAY_MS, // 60 days (>30 day bucket)
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);

    expect(recent).toHaveLength(1);
    expect(recent[0].id).toBe("recent");

    expect(buckets[0]).toHaveLength(1);
    expect(buckets[0][0].id).toBe("bucket0");

    expect(buckets[1]).toHaveLength(1);
    expect(buckets[1][0].id).toBe("bucket1");

    expect(buckets[2]).toHaveLength(1);
    expect(buckets[2][0].id).toBe("bucket2");
  });
});

describe("formatDaysThreshold", () => {
  it("should format singular day correctly", () => {
    expect(formatDaysThreshold(1)).toBe("1 day");
  });

  it("should format plural days correctly", () => {
    expect(formatDaysThreshold(7)).toBe("7 days");
    expect(formatDaysThreshold(30)).toBe("30 days");
  });
});
