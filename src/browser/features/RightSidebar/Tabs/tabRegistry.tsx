/**
 * Right-sidebar tab registry — single source of truth for non-terminal tabs.
 *
 * Adding a tab should mean adding ONE entry here. Every consumer
 * (`RightSidebar.tsx`, the default layout, the command palette, the layout
 * migration) iterates this registry, so adding/renaming/removing a tab no
 * longer requires touching switch statements scattered across the codebase.
 *
 * Terminal tabs are intentionally NOT in this registry: they are
 * multi-instance (`terminal:<sessionId>`), keep-alive, and need session-aware
 * wiring that doesn't fit the static "one panel per id" shape. They live in
 * `RightSidebar.tsx` directly.
 */

import React from "react";
import { ErrorBoundary } from "@/browser/components/ErrorBoundary/ErrorBoundary";
import { InstructionsTab } from "@/browser/components/InstructionsTab/InstructionsTab";
import { OutputTab } from "@/browser/components/OutputTab/OutputTab";
import { StatsContainer } from "@/browser/features/RightSidebar/StatsContainer";
import { ReviewPanel } from "@/browser/features/RightSidebar/CodeReview/ReviewPanel";
import { DesktopPanel } from "@/browser/features/desktop/DesktopPanel";
import { BrowserTab } from "@/browser/features/RightSidebar/BrowserTab";
import { DevToolsTab } from "@/browser/features/RightSidebar/DevToolsTab";
import { EXPERIMENT_IDS } from "@/common/constants/experiments";
import type { ReviewNoteData } from "@/common/types/review";
import {
  BrowserTabLabel,
  DebugTabLabel,
  DesktopTabLabel,
  InstructionsTabLabel,
  OutputTabLabel,
  ReviewTabLabel,
  StatsTabLabel,
} from "./TabLabels";

/** Stats reported by ReviewPanel for tab display (kept local to the registry). */
export interface ReviewStats {
  total: number;
  read: number;
}

/** Props every tab label receives. Most tabs ignore most fields. */
export interface TabLabelContext {
  workspaceId: string;
  /** Latest review stats (only consumed by the review label). */
  reviewStats: ReviewStats | null;
}

/** Props every tab panel renderer receives. Most tabs use just `workspaceId`. */
export interface TabPanelContext {
  workspaceId: string;
  workspacePath: string;
  projectPath: string;
  isCreating: boolean;
  /** Bumps when the workspace requests review-tab focus (e.g., immersive open). */
  focusTrigger: number;
  /** Stable key suffix for tabset-scoped panels (used by `ReviewPanel`). */
  tabsetId: string;
  /** Review-panel-specific callbacks. Other tabs ignore. */
  review: {
    onReviewNote?: (data: ReviewNoteData) => void;
    onStatsChange: (stats: ReviewStats | null) => void;
    isTouchImmersive: boolean;
    onTouchImmersiveChange: (isTouch: boolean) => void;
  };
}

/** Static description of one non-terminal tab. */
export interface TabRegistration {
  /** Display name shown in tab strip / pickers. */
  name: string;
  /** Content container CSS classes. */
  contentClassName: string;
  /** Whether the panel should remain mounted while hidden. */
  keepAlive?: boolean;
  /** Optional feature/experiment flag required to show this tab. */
  featureFlag?: string;
  /**
   * Whether the tab should appear in the default layout for new workspaces.
   * Tabs with this flag are also auto-added to existing persisted layouts via
   * `ensureDefaultLayoutTabs` migration so users don't have to manually add
   * them after an upgrade.
   */
  inDefaultLayout?: boolean;
  /**
   * Sort order in the default layout & Add-Tool picker.
   * Lower numbers come first.
   */
  defaultOrder: number;
  /** Workspace-scope label component (subscribes to per-workspace stores as needed). */
  Label: React.ComponentType<TabLabelContext>;
  /** Renders the panel body. Receives a workspace-scoped context bag. */
  renderPanel: (ctx: TabPanelContext) => React.ReactNode;
  /** Optional palette keywords to improve fuzzy search in the command palette. */
  paletteKeywords?: string[];
}

// `satisfies` lets us derive `BaseTabType` from this object's keys while
// type-checking every field. We don't use `as const` because the helpers
// below want a uniform `TabRegistration` shape (so optional fields like
// `inDefaultLayout` can be read without a type-narrowing escape hatch).
const TAB_REGISTRY_DEF = {
  costs: {
    name: "Stats", // Hosts Cost/Timing/Models sub-tabs.
    contentClassName: "overflow-y-auto p-[15px]",
    inDefaultLayout: true,
    defaultOrder: 10,
    Label: ({ workspaceId }) => <StatsTabLabel workspaceId={workspaceId} />,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Stats tab">
        <StatsContainer workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
    paletteKeywords: ["cost", "stats", "tokens", "timing"],
  },
  review: {
    name: "Review",
    contentClassName: "overflow-y-auto p-0",
    inDefaultLayout: true,
    defaultOrder: 20,
    Label: ({ reviewStats }) => <ReviewTabLabel reviewStats={reviewStats} />,
    renderPanel: (ctx) => (
      <ReviewPanel
        // Re-key per (workspace, tabset) so an immersive overlay re-mounts cleanly when
        // the user moves the review tab between tabsets.
        key={`${ctx.workspaceId}:${ctx.tabsetId}`}
        workspaceId={ctx.workspaceId}
        workspacePath={ctx.workspacePath}
        projectPath={ctx.projectPath}
        onReviewNote={ctx.review.onReviewNote}
        focusTrigger={ctx.focusTrigger}
        isCreating={ctx.isCreating}
        isTouchImmersive={ctx.review.isTouchImmersive}
        onTouchImmersiveChange={ctx.review.onTouchImmersiveChange}
        onStatsChange={ctx.review.onStatsChange}
      />
    ),
    paletteKeywords: ["review", "diff", "code review"],
  },
  instructions: {
    name: "Instructions",
    contentClassName: "overflow-hidden p-0",
    inDefaultLayout: true,
    defaultOrder: 30,
    Label: InstructionsTabLabel,
    renderPanel: (ctx) => <InstructionsTab workspaceId={ctx.workspaceId} />,
    paletteKeywords: ["agents", "agents.md", "claude.md", "instructions", "prompt", "context"],
  },
  desktop: {
    name: "Desktop",
    contentClassName: "overflow-hidden p-0",
    featureFlag: EXPERIMENT_IDS.PORTABLE_DESKTOP,
    defaultOrder: 40,
    Label: DesktopTabLabel,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Desktop tab">
        <DesktopPanel workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
    paletteKeywords: ["desktop", "vnc", "screen"],
  },
  browser: {
    name: "Browser",
    contentClassName: "overflow-hidden p-0",
    keepAlive: false,
    featureFlag: EXPERIMENT_IDS.AGENT_BROWSER,
    defaultOrder: 50,
    Label: BrowserTabLabel,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Browser tab">
        <BrowserTab workspaceId={ctx.workspaceId} projectPath={ctx.projectPath} />
      </ErrorBoundary>
    ),
    paletteKeywords: ["browser", "web"],
  },
  output: {
    name: "Output",
    contentClassName: "overflow-hidden p-0",
    defaultOrder: 60,
    Label: OutputTabLabel,
    renderPanel: (ctx) => <OutputTab workspaceId={ctx.workspaceId} />,
    paletteKeywords: ["log", "logs", "output"],
  },
  debug: {
    name: "Debug",
    contentClassName: "overflow-y-auto p-0",
    defaultOrder: 70,
    Label: DebugTabLabel,
    renderPanel: (ctx) => (
      <ErrorBoundary workspaceInfo="Debug tab">
        <DevToolsTab workspaceId={ctx.workspaceId} />
      </ErrorBoundary>
    ),
    paletteKeywords: ["debug", "devtools", "diagnostics"],
  },
} satisfies Record<string, TabRegistration>;

/** Static (non-terminal) tab id union, derived from the registry keys. */
export type BaseTabType = keyof typeof TAB_REGISTRY_DEF;

/**
 * Public registry indexed by tab id. Typed as a uniform record so callers can
 * read optional fields (`inDefaultLayout`, `featureFlag`, …) without manual
 * narrowing.
 */
export const TAB_REGISTRY: Record<BaseTabType, TabRegistration> = TAB_REGISTRY_DEF;

/** Runtime-iterable list of base tab ids (for validators & iteration). */
export const BASE_TAB_IDS = Object.keys(TAB_REGISTRY_DEF) as BaseTabType[];

/** Type-narrowing predicate for static (non-terminal) tab ids. */
export function isBaseTabId(value: unknown): value is BaseTabType {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TAB_REGISTRY_DEF, value);
}

export function getTabRegistration(id: BaseTabType): TabRegistration {
  return TAB_REGISTRY[id];
}

/** Default-layout tab ids in canonical order (used for new workspaces & migration). */
export function getDefaultLayoutTabIds(): BaseTabType[] {
  return BASE_TAB_IDS.filter((id) => TAB_REGISTRY[id].inDefaultLayout === true).sort(
    (a, b) => TAB_REGISTRY[a].defaultOrder - TAB_REGISTRY[b].defaultOrder
  );
}

/** All static tabs ordered by defaultOrder (used by Add-Tool picker). */
export function getOrderedBaseTabIds(): BaseTabType[] {
  return [...BASE_TAB_IDS].sort(
    (a, b) => TAB_REGISTRY[a].defaultOrder - TAB_REGISTRY[b].defaultOrder
  );
}
