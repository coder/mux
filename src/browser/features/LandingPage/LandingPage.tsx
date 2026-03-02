import { useEffect, useMemo } from "react";
import { Menu } from "lucide-react";

import { cn } from "@/common/lib/utils";
import { Button } from "@/browser/components/Button/Button";
import { Skeleton } from "@/browser/components/Skeleton/Skeleton";
import { isDesktopMode } from "@/browser/hooks/useDesktopTitlebar";
import { useRouter } from "@/browser/contexts/RouterContext";
import {
  useWorkspaceMetadata,
  useWorkspaceContext,
  toWorkspaceSelection,
} from "@/browser/contexts/WorkspaceContext";
import { useGateway } from "@/browser/hooks/useGatewayModels";
import {
  useMuxGatewayAccountStatus,
  formatMuxGatewayBalance,
} from "@/browser/hooks/useMuxGatewayAccountStatus";
import { useAnalyticsSummary } from "@/browser/hooks/useAnalytics";
import { formatUsd, formatCompactNumber } from "@/browser/features/Analytics/analyticsUtils";
import { useWorkspaceRecency, useWorkspaceSidebarState } from "@/browser/stores/WorkspaceStore";
import { useGitStatus } from "@/browser/stores/GitStatusStore";
import { useWorkspacePR } from "@/browser/stores/PRStatusStore";

// ─── Card styling constant (Analytics dashboard aesthetic) ───────────────
const CARD_CLASS = "bg-background-secondary border-border-medium rounded-lg border p-3";

interface LandingPageProps {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}

/**
 * Global landing page shown when no workspace is selected and no
 * project-specific creation view is active. Surfaces gateway balance,
 * session stats, and recent workspaces at a glance.
 */
export function LandingPage(props: LandingPageProps) {
  return (
    <div className="bg-dark flex flex-1 flex-col overflow-hidden">
      <LandingTitlebar
        leftSidebarCollapsed={props.leftSidebarCollapsed}
        onToggleLeftSidebarCollapsed={props.onToggleLeftSidebarCollapsed}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
          <GatewayCreditsCard />
          <SessionStatsRow />
          <RecentWorkspacesSection />
        </div>
      </div>
    </div>
  );
}

// ─── Titlebar (shared between landing and workspace-loading states) ──────
function LandingTitlebar(props: {
  leftSidebarCollapsed: boolean;
  onToggleLeftSidebarCollapsed: () => void;
}) {
  return (
    <div
      className={cn(
        "bg-sidebar border-border-light flex shrink-0 items-center border-b px-[15px] [@media(max-width:768px)]:h-auto [@media(max-width:768px)]:py-2",
        isDesktopMode() ? "h-10 titlebar-drag" : "h-8"
      )}
    >
      {props.leftSidebarCollapsed && (
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onToggleLeftSidebarCollapsed}
          title="Open sidebar"
          aria-label="Open sidebar menu"
          className={cn(
            "mobile-menu-btn text-muted hover:text-foreground hidden h-6 w-6 shrink-0",
            isDesktopMode() && "titlebar-no-drag"
          )}
        >
          <Menu className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}

// ─── Gateway credits card ────────────────────────────────────────────────
function GatewayCreditsCard() {
  const gateway = useGateway();
  const { data, isLoading, refresh } = useMuxGatewayAccountStatus();

  // Data-fetching on mount — acceptable per react-effects skill guidance.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!gateway.isConfigured) return null;

  return (
    <div className="bg-background-secondary border-border-medium rounded-lg border p-4">
      <div className="text-muted text-xs">Mux Gateway Balance</div>
      {isLoading ? (
        <Skeleton variant="shimmer" className="mt-1 h-7 w-24" />
      ) : (
        <div className="text-foreground mt-1 font-mono text-2xl font-semibold">
          {formatMuxGatewayBalance(data?.remaining_microdollars)}
        </div>
      )}
    </div>
  );
}

// ─── Session stats row ───────────────────────────────────────────────────
function SessionStatsRow() {
  const { navigateToAnalytics } = useRouter();

  // 7-day window: from 6 days ago (start of day) through now
  const dateFilters = useMemo(() => {
    const from = new Date();
    from.setUTCDate(from.getUTCDate() - 6);
    from.setUTCHours(0, 0, 0, 0);
    return { from, to: null as Date | null };
  }, []);

  const summary = useAnalyticsSummary(null, dateFilters);

  const stats = [
    { label: "Total Spend", value: formatUsd(summary.data?.totalSpendUsd ?? 0) },
    { label: "Today", value: formatUsd(summary.data?.todaySpendUsd ?? 0) },
    { label: "Total Tokens", value: formatCompactNumber(summary.data?.totalTokens ?? 0) },
    { label: "Responses", value: formatCompactNumber(summary.data?.totalResponses ?? 0) },
  ];

  return (
    <div data-testid="session-stats-row">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-foreground text-sm font-medium">Stats (7d)</h3>
        <button
          onClick={navigateToAnalytics}
          className="text-muted hover:text-foreground text-xs"
          data-testid="view-all-stats"
        >
          View all →
        </button>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((stat) => (
          <div key={stat.label} className={CARD_CLASS}>
            <div className="text-muted text-xs">{stat.label}</div>
            <div className="text-foreground mt-1 font-mono text-lg font-semibold">
              {summary.loading ? <Skeleton variant="shimmer" className="h-5 w-16" /> : stat.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Recent workspaces section ───────────────────────────────────────────
function RecentWorkspacesSection() {
  const { workspaceMetadata } = useWorkspaceMetadata();
  const { setSelectedWorkspace } = useWorkspaceContext();
  const workspaceRecency = useWorkspaceRecency();

  // Sort all workspaces by recency, take top 4
  const recentWorkspaces = useMemo(() => {
    return [...workspaceMetadata.values()]
      .sort((a, b) => (workspaceRecency[b.id] ?? 0) - (workspaceRecency[a.id] ?? 0))
      .slice(0, 4);
  }, [workspaceMetadata, workspaceRecency]);

  if (recentWorkspaces.length === 0) return null;

  return (
    <div data-testid="recent-workspaces">
      <h3 className="text-foreground mb-2 text-sm font-medium">Recent Workspaces</h3>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {recentWorkspaces.map((ws) => (
          <WorkspaceCard
            key={ws.id}
            workspaceId={ws.id}
            title={ws.title ?? ws.name}
            onClick={() => setSelectedWorkspace(toWorkspaceSelection(ws))}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Individual workspace card ───────────────────────────────────────────
function WorkspaceCard(props: { workspaceId: string; title: string; onClick: () => void }) {
  const sidebarState = useWorkspaceSidebarState(props.workspaceId);
  const gitStatus = useGitStatus(props.workspaceId);
  const prStatus = useWorkspacePR(props.workspaceId);

  const hasChanges =
    gitStatus && (gitStatus.outgoingAdditions > 0 || gitStatus.outgoingDeletions > 0);

  return (
    <button
      onClick={props.onClick}
      data-testid={`workspace-card-${props.workspaceId}`}
      className="bg-background-secondary border-border-medium hover:border-foreground/20 rounded-lg border p-4 text-left transition-colors"
    >
      {/* Row 1: Title + streaming indicator */}
      <div className="flex items-center gap-2">
        {sidebarState.canInterrupt && (
          <div className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-green-500" />
        )}
        <span className="text-foreground truncate text-sm font-medium">{props.title}</span>
      </div>

      {/* Row 2: Agent status message */}
      {sidebarState.agentStatus && (
        <div className="text-muted mt-1 truncate text-xs">{sidebarState.agentStatus.message}</div>
      )}

      {/* Row 3: Git diff + PR badge */}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px]">
        {hasChanges && (
          <>
            <span className="text-green-400">+{gitStatus.outgoingAdditions}</span>
            <span className="text-red-400">-{gitStatus.outgoingDeletions}</span>
          </>
        )}
        {prStatus && (
          <>
            {hasChanges && <span className="text-muted">·</span>}
            <PRBadge pr={prStatus} />
          </>
        )}
      </div>
    </button>
  );
}

// ─── PR status badge ─────────────────────────────────────────────────────
function PRBadge(props: {
  pr: {
    url: string;
    number: number;
    status?: { state: string; hasPendingChecks?: boolean; hasFailedChecks?: boolean };
  };
}) {
  const state = props.pr.status?.state;
  const stateColor =
    state === "MERGED" ? "text-purple-400" : state === "CLOSED" ? "text-red-400" : "text-green-400"; // OPEN or unknown

  return (
    <a
      href={props.pr.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn("hover:underline", stateColor)}
      onClick={(e) => e.stopPropagation()}
    >
      #{props.pr.number}
      {props.pr.status?.hasPendingChecks && (
        <span className="text-yellow-400" title="Checks pending">
          {" "}
          ●
        </span>
      )}
      {props.pr.status?.hasFailedChecks && (
        <span className="text-red-400" title="Checks failed">
          {" "}
          ●
        </span>
      )}
    </a>
  );
}
