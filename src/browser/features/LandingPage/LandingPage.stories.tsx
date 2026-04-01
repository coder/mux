/**
 * Landing page (dashboard) stories.
 *
 * The landing page is the default startup view — users see gateway credits,
 * 7-day stats, and recent workspaces before explicitly choosing a workspace.
 */

import type { APIClient } from "@/browser/contexts/API";
import type { Summary } from "@/browser/hooks/useAnalytics";
import { createPRStatusExecutor } from "@/browser/stories/helpers/git";
import { collapseLeftSidebar, expandProjects } from "@/browser/stories/helpers/uiState";
import {
  CHROMATIC_SMOKE_MODES,
  appMeta,
  AppWithMocks,
  type AppStory,
} from "@/browser/stories/meta.js";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { createWorkspace, groupWorkspacesByProject } from "@/browser/stories/mocks/workspaces";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";

// Integration: stories render full app to test landing page layout with sidebar, analytics, and workspace cards.
export default {
  ...appMeta,
  title: "Features/LandingPage",
};

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const PROJECT_PATH = "/home/user/projects/atlas-api";

const WORKSPACES = [
  createWorkspace({
    id: "ws-feat-auth",
    name: "feat/auth-flow",
    projectName: "atlas-api",
    projectPath: PROJECT_PATH,
    title: "Implement OAuth2 auth flow",
  }),
  createWorkspace({
    id: "ws-fix-perf",
    name: "fix/query-perf",
    projectName: "atlas-api",
    projectPath: PROJECT_PATH,
    title: "Fix N+1 query in user endpoint",
  }),
  createWorkspace({
    id: "ws-docs-update",
    name: "docs/api-v2",
    projectName: "atlas-api",
    projectPath: PROJECT_PATH,
    title: "Update API v2 documentation",
  }),
  createWorkspace({
    id: "ws-refactor-db",
    name: "refactor/db-layer",
    projectName: "atlas-api",
    projectPath: PROJECT_PATH,
    title: "Refactor database connection pool",
  }),
];

const WORKSPACES_WITH_PR_BADGE = WORKSPACES.map((workspace) => ({
  ...workspace,
  // Use distinct story-only ids so PR store cache from this badge scenario never
  // bleeds into the default landing-page stories when Storybook remounts.
  id: `${workspace.id}-pr-badge`,
}));

const RECENT_WORKSPACE_PR_STATUSES = new Map([
  [
    WORKSPACES_WITH_PR_BADGE[0].id,
    {
      number: 482,
      url: "https://github.com/muxinc/atlas-api/pull/482",
      state: "OPEN" as const,
      mergeable: "MERGEABLE" as const,
      mergeStateStatus: "CLEAN" as const,
      title: "Implement OAuth2 auth flow",
      isDraft: false,
      headRefName: "feat/auth-flow",
      baseRefName: "main",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    },
  ],
]);

const MOCK_SUMMARY: Summary = {
  totalSpendUsd: 47.82,
  todaySpendUsd: 6.13,
  avgDailySpendUsd: 6.83,
  cacheHitRatio: 0.42,
  totalTokens: 2_340_000,
  totalResponses: 189,
};

/** Wire up analytics.getSummary so the landing page stats row has data. */
function withAnalytics(client: APIClient): APIClient {
  // The analytics namespace is a typed ORPC client; cast through unknown to
  // patch only the method the landing page calls without stubbing every method.
  const patched = client as Omit<APIClient, "analytics"> & { analytics: unknown };
  const existing = (patched.analytics ?? {}) as Record<string, unknown>;
  patched.analytics = {
    ...existing,
    getSummary: () => Promise.resolve(MOCK_SUMMARY),
  };
  return patched as APIClient;
}

// ─── Stories ─────────────────────────────────────────────────────────────────

/** Default landing page with gateway balance, stats, and recent workspaces. */
export const Default: AppStory = {
  parameters: {
    chromatic: { modes: CHROMATIC_SMOKE_MODES },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        expandProjects([PROJECT_PATH]);
        const client = createMockORPCClient({
          projects: groupWorkspacesByProject(WORKSPACES),
          workspaces: WORKSPACES,
        });
        return withAnalytics(client);
      }}
    />
  ),
};

/** Landing page with a recent workspace card that shows the shared PR badge. */
export const RecentWorkspacePRBadge: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        expandProjects([PROJECT_PATH]);
        const client = createMockORPCClient({
          projects: groupWorkspacesByProject(WORKSPACES_WITH_PR_BADGE),
          workspaces: WORKSPACES_WITH_PR_BADGE,
          executeBash: createPRStatusExecutor(RECENT_WORKSPACE_PR_STATUSES),
        });
        return withAnalytics(client);
      }}
    />
  ),
};

/** Landing page with no projects — fresh install experience. */
export const EmptyState: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        const client = createMockORPCClient({
          projects: new Map(),
          workspaces: [],
        });
        return withAnalytics(client);
      }}
    />
  ),
};

/** Landing page with sidebar collapsed. */
export const SidebarCollapsed: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
        localStorage.setItem(LEFT_SIDEBAR_COLLAPSED_KEY, JSON.stringify(true));
        expandProjects([PROJECT_PATH]);
        const client = createMockORPCClient({
          projects: groupWorkspacesByProject(WORKSPACES),
          workspaces: WORKSPACES,
        });
        return withAnalytics(client);
      }}
    />
  ),
};

/** Chat with Mux - the default boot state (no user projects) */
export const ChatWithMux: AppStory = {
  parameters: {
    chromatic: { modes: CHROMATIC_SMOKE_MODES },
  },
  render: () => (
    <AppWithMocks
      setup={() => {
        collapseLeftSidebar();
        return createMockORPCClient({
          projects: new Map(),
          workspaces: [],
        });
      }}
    />
  ),
};
