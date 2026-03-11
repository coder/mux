import { describe, it, expect } from "@jest/globals";
import {
  partitionWorkspacesByAge,
  formatDaysThreshold,
  AGE_THRESHOLDS_DAYS,
  buildSortedWorkspacesByProject,
  computeWorkspaceDepthMap,
  computeAgentRowRenderMeta,
  filterVisibleAgentRows,
  partitionWorkspacesBySection,
  sortSectionsByLinkedList,
} from "./workspaceFiltering";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import type { ProjectConfig, SectionConfig } from "@/common/types/project";
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

  it("should place a workspace at exactly 24 hours in the older-than-1-day tiers", () => {
    const workspaces = [createWorkspace("exactly-24h")];

    const workspaceRecency = {
      "exactly-24h": now - ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(0);
    expect(old).toHaveLength(1);
    expect(old[0]?.id).toBe("exactly-24h");
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

  it("should keep all workspaces in old tiers when all are older than 1 day", () => {
    const workspaces = [createWorkspace("old1"), createWorkspace("old2"), createWorkspace("old3")];

    const workspaceRecency = {
      old1: now - 2 * ONE_DAY_MS,
      old2: now - 3 * ONE_DAY_MS,
      old3: now - 4 * ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(0);
    expect(old).toHaveLength(3);
    expect(old.map((w) => w.id)).toEqual(["old1", "old2", "old3"]);
  });

  it("should keep a lone workspace older than 1 day out of the recent section", () => {
    const workspaces = [createWorkspace("only-old")];

    const workspaceRecency = {
      "only-old": now - 2 * ONE_DAY_MS,
    };

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, workspaceRecency);
    const old = getAllOld(buckets);

    expect(recent).toHaveLength(0);
    expect(old).toHaveLength(1);
    expect(old[0]?.id).toBe("only-old");
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

describe("partitionWorkspacesByAge hierarchy grouping", () => {
  const now = Date.now();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  const createWorkspace = (
    id: string,
    opts?: {
      parentWorkspaceId?: string;
      taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
    }
  ): FrontendWorkspaceMetadata => ({
    id,
    name: `workspace-${id}`,
    projectName: "test-project",
    projectPath: "/test/project",
    namedWorkspacePath: `/test/project/workspace-${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: opts?.parentWorkspaceId,
    taskStatus: opts?.taskStatus,
  });

  it("keeps sub-agents in old tiers when their parent is older than one day", () => {
    const workspaces = [
      createWorkspace("old-parent"),
      createWorkspace("recent-active-child", {
        parentWorkspaceId: "old-parent",
        taskStatus: "running",
      }),
      createWorkspace("recent-completed-child", {
        parentWorkspaceId: "old-parent",
        taskStatus: "reported",
      }),
    ];

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, {
      "old-parent": now - 2 * ONE_DAY_MS,
      "recent-active-child": now - 60 * 60 * 1000,
      "recent-completed-child": now - 30 * 60 * 1000,
    });

    expect(recent).toHaveLength(0);
    expect(buckets[0].map((workspace) => workspace.id)).toEqual([
      "old-parent",
      "recent-active-child",
      "recent-completed-child",
    ]);
  });

  it("keeps sub-agents in the recent tier when their parent is recent", () => {
    const workspaces = [
      createWorkspace("recent-parent"),
      createWorkspace("old-active-child", {
        parentWorkspaceId: "recent-parent",
        taskStatus: "running",
      }),
      createWorkspace("old-completed-child", {
        parentWorkspaceId: "recent-parent",
        taskStatus: "reported",
      }),
    ];

    const { recent, buckets } = partitionWorkspacesByAge(workspaces, {
      "recent-parent": now - 60 * 60 * 1000,
      "old-active-child": now - 8 * ONE_DAY_MS,
      "old-completed-child": now - 15 * ONE_DAY_MS,
    });

    expect(recent.map((workspace) => workspace.id)).toEqual([
      "recent-parent",
      "old-active-child",
      "old-completed-child",
    ]);
    expect(buckets.flat()).toHaveLength(0);
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

describe("buildSortedWorkspacesByProject", () => {
  const createWorkspace = (
    id: string,
    projectPath: string,
    isInitializing?: boolean,
    parentWorkspaceId?: string
  ): FrontendWorkspaceMetadata => ({
    id,
    name: `workspace-${id}`,
    projectName: projectPath.split("/").pop() ?? "unknown",
    projectPath,
    namedWorkspacePath: `${projectPath}/workspace-${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    isInitializing,
    parentWorkspaceId,
  });

  it("should include workspaces from persisted config", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(1);
    expect(result.get("/project/a")?.[0].id).toBe("ws1");
  });

  it("should include pending workspaces not yet in config", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
      ["pending1", createWorkspace("pending1", "/project/a", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(2);
    expect(result.get("/project/a")?.map((w) => w.id)).toContain("ws1");
    expect(result.get("/project/a")?.map((w) => w.id)).toContain("pending1");
  });

  it("should handle multiple concurrent pending workspaces", () => {
    const projects = new Map<string, ProjectConfig>([["/project/a", { workspaces: [] }]]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["pending1", createWorkspace("pending1", "/project/a", true)],
      ["pending2", createWorkspace("pending2", "/project/a", true)],
      ["pending3", createWorkspace("pending3", "/project/a", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(3);
  });

  it("should add pending workspaces for projects not yet in config", () => {
    const projects = new Map<string, ProjectConfig>();
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["pending1", createWorkspace("pending1", "/new/project", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/new/project")).toHaveLength(1);
    expect(result.get("/new/project")?.[0].id).toBe("pending1");
  });

  it("should use stable tie-breakers when recency is equal", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/ws1", id: "ws1" },
            { path: "/a/ws2", id: "ws2" },
            { path: "/a/ws3", id: "ws3" },
          ],
        },
      ],
    ]);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      [
        "ws1",
        {
          ...createWorkspace("ws1", "/project/a"),
          name: "beta",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
      [
        "ws2",
        {
          ...createWorkspace("ws2", "/project/a"),
          name: "alpha",
          createdAt: "2021-01-01T00:00:00.000Z",
        },
      ],
      [
        "ws3",
        {
          ...createWorkspace("ws3", "/project/a"),
          name: "aardvark",
          createdAt: "2020-01-01T00:00:00.000Z",
        },
      ],
    ]);

    // No recency timestamps → all ties
    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    // Tie-break order: createdAt desc, then name asc, then id asc
    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["ws2", "ws3", "ws1"]);
  });

  it("should sort workspaces by recency (most recent first)", () => {
    const now = Date.now();
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/ws1", id: "ws1" },
            { path: "/a/ws2", id: "ws2" },
            { path: "/a/ws3", id: "ws3" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
      ["ws2", createWorkspace("ws2", "/project/a")],
      ["ws3", createWorkspace("ws3", "/project/a")],
    ]);
    const recency = {
      ws1: now - 3000, // oldest
      ws2: now - 1000, // newest
      ws3: now - 2000, // middle
    };

    const result = buildSortedWorkspacesByProject(projects, metadata, recency);

    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["ws2", "ws3", "ws1"]);
  });

  it("should flatten child workspaces directly under their parent", () => {
    const now = Date.now();
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child1", id: "child1" },
            { path: "/a/child2", id: "child2" },
            { path: "/a/grand", id: "grand" },
          ],
        },
      ],
    ]);

    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["root", createWorkspace("root", "/project/a")],
      ["child1", createWorkspace("child1", "/project/a", undefined, "root")],
      ["child2", createWorkspace("child2", "/project/a", undefined, "root")],
      ["grand", createWorkspace("grand", "/project/a", undefined, "child1")],
    ]);

    // Child workspaces are more recent than the parent, but should still render below it.
    const recency = {
      child1: now - 1000,
      child2: now - 2000,
      grand: now - 3000,
      root: now - 4000,
    };

    const result = buildSortedWorkspacesByProject(projects, metadata, recency);
    expect(result.get("/project/a")?.map((w) => w.id)).toEqual([
      "root",
      "child1",
      "grand",
      "child2",
    ]);
  });

  it("keeps reachable descendants visible even for deep parent chains", () => {
    const depth = 40;
    const workspaces = Array.from({ length: depth + 1 }, (_, index) => ({
      path: `/a/ws-${index}`,
      id: `ws-${index}`,
    }));
    const projects = new Map<string, ProjectConfig>([["/project/a", { workspaces }]]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>(
      Array.from({ length: depth + 1 }, (_, index) => {
        const parentWorkspaceId = index === 0 ? undefined : `ws-${index - 1}`;
        return [
          `ws-${index}`,
          createWorkspace(`ws-${index}`, "/project/a", undefined, parentWorkspaceId),
        ] as const;
      })
    );

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")?.map((workspace) => workspace.id)).toEqual(
      Array.from({ length: depth + 1 }, (_, index) => `ws-${index}`)
    );
  });

  it("hides orphaned children whose parent is missing from active metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child", id: "child" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["child", createWorkspace("child", "/project/a", undefined, "root")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toEqual([]);
  });

  it("hides transitive descendants when an ancestor is missing from active metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child", id: "child" },
            { path: "/a/grand", id: "grand" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["child", createWorkspace("child", "/project/a", undefined, "root")],
      ["grand", createWorkspace("grand", "/project/a", undefined, "child")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toEqual([]);
  });

  it("keeps unrelated roots visible while hiding orphaned descendants", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/orphan", id: "orphan" },
            { path: "/a/standalone", id: "standalone" },
          ],
        },
      ],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["orphan", createWorkspace("orphan", "/project/a", undefined, "root")],
      ["standalone", createWorkspace("standalone", "/project/a")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")?.map((w) => w.id)).toEqual(["standalone"]);
  });

  it("reattaches hidden descendants when their parent returns to active metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      [
        "/project/a",
        {
          workspaces: [
            { path: "/a/root", id: "root" },
            { path: "/a/child", id: "child" },
          ],
        },
      ],
    ]);
    const child = createWorkspace("child", "/project/a", undefined, "root");

    const withoutParent = buildSortedWorkspacesByProject(
      projects,
      new Map<string, FrontendWorkspaceMetadata>([["child", child]]),
      {}
    );
    expect(withoutParent.get("/project/a")).toEqual([]);

    const withParent = buildSortedWorkspacesByProject(
      projects,
      new Map<string, FrontendWorkspaceMetadata>([
        ["root", createWorkspace("root", "/project/a")],
        ["child", child],
      ]),
      {}
    );

    expect(withParent.get("/project/a")?.map((w) => w.id)).toEqual(["root", "child"]);
  });

  it("should not duplicate workspaces that exist in both config and have creating status", () => {
    // Edge case: workspace was saved to config but still reports isInitializing
    // (this shouldn't happen in practice but tests defensive coding)
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a", true)],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(1);
    expect(result.get("/project/a")?.[0].id).toBe("ws1");
  });

  it("should skip workspaces with no id in config", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/legacy" }, { path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>([
      ["ws1", createWorkspace("ws1", "/project/a")],
    ]);

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(1);
    expect(result.get("/project/a")?.[0].id).toBe("ws1");
  });

  it("should skip config workspaces with no matching metadata", () => {
    const projects = new Map<string, ProjectConfig>([
      ["/project/a", { workspaces: [{ path: "/a/ws1", id: "ws1" }] }],
    ]);
    const metadata = new Map<string, FrontendWorkspaceMetadata>(); // empty

    const result = buildSortedWorkspacesByProject(projects, metadata, {});

    expect(result.get("/project/a")).toHaveLength(0);
  });
});

describe("sub-agent row render metadata", () => {
  const createWorkspace = (
    id: string,
    options?: {
      parentWorkspaceId?: string;
      taskStatus?: FrontendWorkspaceMetadata["taskStatus"];
      reportedAt?: string;
    }
  ): FrontendWorkspaceMetadata => ({
    id,
    name: `workspace-${id}`,
    projectName: "test-project",
    projectPath: "/test/project",
    namedWorkspacePath: `/test/project/workspace-${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    parentWorkspaceId: options?.parentWorkspaceId,
    taskStatus: options?.taskStatus,
    reportedAt: options?.reportedAt,
  });

  it("assigns middle/last connector positions for a parent with three active children", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-1", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("child-2", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("child-3", { parentWorkspaceId: "parent", taskStatus: "awaiting_report" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-1")?.connectorPosition).toBe("middle");
    expect(metadataByWorkspaceId.get("child-2")?.connectorPosition).toBe("middle");
    expect(metadataByWorkspaceId.get("child-3")?.connectorPosition).toBe("last");

    expect(metadataByWorkspaceId.get("child-1")?.depth).toBe(1);
    expect(metadataByWorkspaceId.get("child-1")?.rowKind).toBe("subagent");
    expect(metadataByWorkspaceId.get("parent")?.rowKind).toBe("primary");
  });

  it("animates the shared trunk through the lowest running child", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-1", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("child-2", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("child-3", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("child-4", { parentWorkspaceId: "parent", taskStatus: "queued" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-1")?.connectorStartsAtParent).toBe(true);
    expect(metadataByWorkspaceId.get("child-2")?.connectorStartsAtParent).toBe(false);

    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-3")?.sharedTrunkActiveThroughRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-4")?.sharedTrunkActiveThroughRow).toBe(false);

    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveBelowRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveBelowRow).toBe(true);
    expect(metadataByWorkspaceId.get("child-3")?.sharedTrunkActiveBelowRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-4")?.sharedTrunkActiveBelowRow).toBe(false);
  });

  it("does not animate shared trunk segments when no children are running", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-1", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("child-2", { parentWorkspaceId: "parent", taskStatus: "awaiting_report" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveThroughRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveThroughRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-1")?.sharedTrunkActiveBelowRow).toBe(false);
    expect(metadataByWorkspaceId.get("child-2")?.sharedTrunkActiveBelowRow).toBe(false);
  });

  it("assigns single connector position for an only child", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("only-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("only-child")?.connectorPosition).toBe("single");
  });

  it("hides reported children by default when parent is not expanded", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("active-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("reported-child-1", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      createWorkspace("reported-child-2", { parentWorkspaceId: "parent", taskStatus: "reported" }),
    ];

    const visible = filterVisibleAgentRows(flattened);
    expect(visible.map((workspace) => workspace.id)).toEqual(["parent", "active-child"]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.has("reported-child-1")).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.hasHiddenCompletedChildren).toBe(true);
    expect(metadataByWorkspaceId.get("parent")?.visibleCompletedChildrenCount).toBe(0);
  });

  it("shows reported children when parent is expanded", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("active-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("reported-child-1", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      createWorkspace("reported-child-2", { parentWorkspaceId: "parent", taskStatus: "reported" }),
    ];

    const expandedParentIds = new Set<string>(["parent"]);
    const visible = filterVisibleAgentRows(flattened, expandedParentIds);
    expect(visible.map((workspace) => workspace.id)).toEqual([
      "parent",
      "active-child",
      "reported-child-1",
      "reported-child-2",
    ]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(
      flattened,
      depthByWorkspaceId,
      expandedParentIds
    );

    expect(metadataByWorkspaceId.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.visibleCompletedChildrenCount).toBe(2);
  });

  it("treats interrupted children with reportedAt as completed children", () => {
    const completedAt = "2026-03-09T11:05:58.780Z";
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("active-child", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("corrupted-completed-child", {
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
        reportedAt: completedAt,
      }),
      createWorkspace("reported-child", {
        parentWorkspaceId: "parent",
        taskStatus: "reported",
        reportedAt: completedAt,
      }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const collapsedVisible = filterVisibleAgentRows(flattened);
    expect(collapsedVisible.map((workspace) => workspace.id)).toEqual(["parent", "active-child"]);

    const collapsedMeta = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(collapsedMeta.get("parent")?.hasHiddenCompletedChildren).toBe(true);
    expect(collapsedMeta.get("parent")?.visibleCompletedChildrenCount).toBe(0);
    expect(collapsedMeta.has("corrupted-completed-child")).toBe(false);

    const expandedParentIds = new Set<string>(["parent"]);
    const expandedVisible = filterVisibleAgentRows(flattened, expandedParentIds);
    expect(expandedVisible.map((workspace) => workspace.id)).toEqual([
      "parent",
      "active-child",
      "corrupted-completed-child",
      "reported-child",
    ]);

    const expandedMeta = computeAgentRowRenderMeta(
      flattened,
      depthByWorkspaceId,
      expandedParentIds
    );
    expect(expandedMeta.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(expandedMeta.get("parent")?.visibleCompletedChildrenCount).toBe(2);
  });

  it("keeps running children with stale reportedAt visible and out of completed counts", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("resumed-child", {
        parentWorkspaceId: "parent",
        taskStatus: "running",
        reportedAt: "2026-03-09T11:05:58.780Z",
      }),
    ];

    const visible = filterVisibleAgentRows(flattened);
    expect(visible.map((workspace) => workspace.id)).toEqual(["parent", "resumed-child"]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(metadataByWorkspaceId.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.visibleCompletedChildrenCount).toBe(0);
    expect(metadataByWorkspaceId.has("resumed-child")).toBe(true);
  });

  it("keeps unfinished interrupted children visible and out of completed counts", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("unfinished-interrupted-child", {
        parentWorkspaceId: "parent",
        taskStatus: "interrupted",
      }),
    ];

    const visible = filterVisibleAgentRows(flattened);
    expect(visible.map((workspace) => workspace.id)).toEqual([
      "parent",
      "unfinished-interrupted-child",
    ]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(metadataByWorkspaceId.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(metadataByWorkspaceId.get("parent")?.visibleCompletedChildrenCount).toBe(0);
    expect(metadataByWorkspaceId.has("unfinished-interrupted-child")).toBe(true);
  });

  it("tracks hidden-completed state correctly across collapsed and expanded parent rows", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("reported-child", { parentWorkspaceId: "parent", taskStatus: "reported" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const collapsedMeta = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(collapsedMeta.get("parent")?.hasHiddenCompletedChildren).toBe(true);
    expect(collapsedMeta.get("parent")?.visibleCompletedChildrenCount).toBe(0);

    const expandedMeta = computeAgentRowRenderMeta(
      flattened,
      depthByWorkspaceId,
      new Set<string>(["parent"])
    );
    expect(expandedMeta.get("parent")?.hasHiddenCompletedChildren).toBe(false);
    expect(expandedMeta.get("parent")?.visibleCompletedChildrenCount).toBe(1);
  });

  it("propagates ancestor trunk continuation metadata for nested rows", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("gc-2", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("child-b", { parentWorkspaceId: "parent", taskStatus: "queued" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-a")?.connectorPosition).toBe("middle");
    expect(metadataByWorkspaceId.get("child-b")?.connectorPosition).toBe("last");
    expect(metadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([
      { depth: 1, active: false },
    ]);
    expect(metadataByWorkspaceId.get("gc-2")?.ancestorTrunks).toEqual([
      { depth: 1, active: false },
    ]);
  });

  it("does not propagate ancestor trunk metadata when parent branch does not continue", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("gc-2", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
    ];

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const metadataByWorkspaceId = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);

    expect(metadataByWorkspaceId.get("child-a")?.connectorPosition).toBe("single");
    expect(metadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([]);
    expect(metadataByWorkspaceId.get("gc-2")?.ancestorTrunks).toEqual([]);
  });

  it("marks ancestor trunk continuation as active through nested rows when lower siblings run", () => {
    const flattenedWithRunningSibling = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("child-b", { parentWorkspaceId: "parent", taskStatus: "running" }),
    ];

    const runningDepthByWorkspaceId = computeWorkspaceDepthMap(flattenedWithRunningSibling);
    const runningMetadataByWorkspaceId = computeAgentRowRenderMeta(
      flattenedWithRunningSibling,
      runningDepthByWorkspaceId
    );
    expect(runningMetadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([
      { depth: 1, active: true },
    ]);

    const flattenedWithoutRunningSibling = [
      createWorkspace("parent"),
      createWorkspace("child-a", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      createWorkspace("gc-1", { parentWorkspaceId: "child-a", taskStatus: "queued" }),
      createWorkspace("child-b", { parentWorkspaceId: "parent", taskStatus: "queued" }),
    ];
    const inactiveDepthByWorkspaceId = computeWorkspaceDepthMap(flattenedWithoutRunningSibling);
    const inactiveMetadataByWorkspaceId = computeAgentRowRenderMeta(
      flattenedWithoutRunningSibling,
      inactiveDepthByWorkspaceId
    );
    expect(inactiveMetadataByWorkspaceId.get("gc-1")?.ancestorTrunks).toEqual([
      { depth: 1, active: false },
    ]);
  });

  it("preserves mixed active+reported child ordering while filtering", () => {
    const flattened = [
      createWorkspace("parent"),
      createWorkspace("active-1", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("reported-1", { parentWorkspaceId: "parent", taskStatus: "reported" }),
      createWorkspace("active-2", { parentWorkspaceId: "parent", taskStatus: "running" }),
      createWorkspace("reported-2", { parentWorkspaceId: "parent", taskStatus: "reported" }),
    ];

    const collapsedVisible = filterVisibleAgentRows(flattened);
    expect(collapsedVisible.map((workspace) => workspace.id)).toEqual([
      "parent",
      "active-1",
      "active-2",
    ]);

    const depthByWorkspaceId = computeWorkspaceDepthMap(flattened);
    const collapsedMeta = computeAgentRowRenderMeta(flattened, depthByWorkspaceId);
    expect(collapsedMeta.get("active-1")?.connectorPosition).toBe("middle");
    expect(collapsedMeta.get("active-2")?.connectorPosition).toBe("last");

    const expandedParentIds = new Set<string>(["parent"]);
    const expandedVisible = filterVisibleAgentRows(flattened, expandedParentIds);
    expect(expandedVisible.map((workspace) => workspace.id)).toEqual([
      "parent",
      "active-1",
      "reported-1",
      "active-2",
      "reported-2",
    ]);

    const expandedMeta = computeAgentRowRenderMeta(
      flattened,
      depthByWorkspaceId,
      expandedParentIds
    );
    expect(expandedMeta.get("active-1")?.connectorPosition).toBe("middle");
    expect(expandedMeta.get("reported-1")?.connectorPosition).toBe("middle");
    expect(expandedMeta.get("active-2")?.connectorPosition).toBe("middle");
    expect(expandedMeta.get("reported-2")?.connectorPosition).toBe("last");
  });
});

describe("sortSectionsByLinkedList", () => {
  it("should sort sections by nextId linked list", () => {
    const sections: SectionConfig[] = [
      { id: "c", name: "C", nextId: null },
      { id: "a", name: "A", nextId: "b" },
      { id: "b", name: "B", nextId: "c" },
    ];

    const sorted = sortSectionsByLinkedList(sections);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("should handle empty array", () => {
    expect(sortSectionsByLinkedList([])).toEqual([]);
  });

  it("should handle single section", () => {
    const sections: SectionConfig[] = [{ id: "only", name: "Only", nextId: null }];
    const sorted = sortSectionsByLinkedList(sections);
    expect(sorted.map((s) => s.id)).toEqual(["only"]);
  });

  it("should handle reordered sections (C, A, B order)", () => {
    // After reorder to C->A->B, the pointers should be: C->A->B->null
    const sections: SectionConfig[] = [
      { id: "a", name: "A", nextId: "b" },
      { id: "b", name: "B", nextId: null },
      { id: "c", name: "C", nextId: "a" },
    ];

    const sorted = sortSectionsByLinkedList(sections);
    expect(sorted.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("should append orphaned sections", () => {
    // Section "orphan" is not in the linked list
    const sections: SectionConfig[] = [
      { id: "a", name: "A", nextId: "b" },
      { id: "b", name: "B", nextId: null },
      { id: "orphan", name: "Orphan", nextId: "nonexistent" },
    ];

    const sorted = sortSectionsByLinkedList(sections);
    expect(sorted.map((s) => s.id)).toEqual(["a", "b", "orphan"]);
  });
});

describe("partitionWorkspacesBySection", () => {
  const createWorkspace = (
    id: string,
    sectionId?: string,
    parentWorkspaceId?: string
  ): FrontendWorkspaceMetadata => ({
    id,
    name: `workspace-${id}`,
    projectName: "test-project",
    projectPath: "/test/project",
    namedWorkspacePath: `/test/project/workspace-${id}`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    sectionId,
    parentWorkspaceId,
  });

  it("should partition workspaces by section", () => {
    const workspaces = [
      createWorkspace("ws1", "section-a"),
      createWorkspace("ws2", "section-b"),
      createWorkspace("ws3"), // unsectioned
    ];
    const sections: SectionConfig[] = [
      { id: "section-a", name: "A" },
      { id: "section-b", name: "B" },
    ];

    const result = partitionWorkspacesBySection(workspaces, sections);

    expect(result.unsectioned.map((w: FrontendWorkspaceMetadata) => w.id)).toEqual(["ws3"]);
    expect(
      result.bySectionId.get("section-a")?.map((w: FrontendWorkspaceMetadata) => w.id)
    ).toEqual(["ws1"]);
    expect(
      result.bySectionId.get("section-b")?.map((w: FrontendWorkspaceMetadata) => w.id)
    ).toEqual(["ws2"]);
  });

  it("should keep child workspaces directly after their parent within a section", () => {
    // Parent in section-a, child also in section-a
    // Input order from flattenWorkspaceTree: parent, child (already correct)
    const workspaces = [
      createWorkspace("parent", "section-a"),
      createWorkspace("child", "section-a", "parent"),
    ];
    const sections: SectionConfig[] = [{ id: "section-a", name: "A" }];

    const result = partitionWorkspacesBySection(workspaces, sections);

    // Child should be directly after parent
    expect(
      result.bySectionId.get("section-a")?.map((w: FrontendWorkspaceMetadata) => w.id)
    ).toEqual(["parent", "child"]);
  });

  it("should keep child workspaces with parent even when child has no sectionId (inherits parent section)", () => {
    // BUG REPRODUCTION: Parent in section-a, child has no sectionId
    // Child should render under parent in section-a, NOT in unsectioned
    const workspaces = [
      createWorkspace("parent", "section-a"),
      createWorkspace("child", undefined, "parent"), // child without sectionId
    ];
    const sections: SectionConfig[] = [{ id: "section-a", name: "A" }];

    const result = partitionWorkspacesBySection(workspaces, sections);

    // Child should inherit parent's section placement
    expect(
      result.bySectionId.get("section-a")?.map((w: FrontendWorkspaceMetadata) => w.id)
    ).toEqual(["parent", "child"]);
    // Unsectioned should be empty
    expect(result.unsectioned).toHaveLength(0);
  });

  it("should handle nested children inheriting section from root parent", () => {
    // Root in section-a, child1 and grandchild have no sectionId
    const workspaces = [
      createWorkspace("root", "section-a"),
      createWorkspace("child1", undefined, "root"),
      createWorkspace("grandchild", undefined, "child1"),
    ];
    const sections: SectionConfig[] = [{ id: "section-a", name: "A" }];

    const result = partitionWorkspacesBySection(workspaces, sections);

    // All should be in section-a, in tree order
    expect(
      result.bySectionId.get("section-a")?.map((w: FrontendWorkspaceMetadata) => w.id)
    ).toEqual(["root", "child1", "grandchild"]);
    expect(result.unsectioned).toHaveLength(0);
  });
});
