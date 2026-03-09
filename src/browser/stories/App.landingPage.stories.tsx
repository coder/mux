/**
 * Landing page (dashboard) stories.
 *
 * The landing page is the default startup view — users see gateway credits,
 * 7-day stats, and recent workspaces before explicitly choosing a workspace.
 */

import type { APIClient } from "@/browser/contexts/API";
import type { Summary } from "@/browser/hooks/useAnalytics";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import { appMeta, AppWithMocks, type AppStory } from "./meta.js";
import { createWorkspace, groupWorkspacesByProject } from "./mockFactory";
import { expandProjects } from "./storyHelpers";
import { LEFT_SIDEBAR_COLLAPSED_KEY } from "@/common/constants/storage";

export default {
  ...appMeta,
  title: "App/LandingPage",
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
  render: () => (
    <AppWithMocks
      setup={() => {
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

/** Landing page with no projects — fresh install experience. */
export const EmptyState: AppStory = {
  render: () => (
    <AppWithMocks
      setup={() => {
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
