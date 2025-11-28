import React, { useRef } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { ReviewPanel } from "./ReviewPanel";
import type { IPCApi } from "@/common/types/ipc";
import { deleteWorkspaceStorage } from "@/common/constants/storage";
import type { BashToolResult } from "@/common/types/tools";
import type { Result } from "@/common/types/result";

type ScenarioName = "rich" | "empty" | "truncated";

interface ScenarioConfig {
  name: ScenarioName;
  workspaceId: string;
  workspacePath: string;
  diffByFile: Record<string, string>;
  numstatOutput: string;
  untrackedFiles: string[];
  truncated?: {
    reason: string;
    totalLines: number;
  };
}

const joinLines = (lines: string[]): string => lines.join("\n");

const reviewPanelDiff = joinLines([
  "diff --git a/src/browser/components/RightSidebar/CodeReview/ReviewPanel.tsx b/src/browser/components/RightSidebar/CodeReview/ReviewPanel.tsx",
  "index 4b825dc..1c002b1 100644",
  "--- a/src/browser/components/RightSidebar/CodeReview/ReviewPanel.tsx",
  "+++ b/src/browser/components/RightSidebar/CodeReview/ReviewPanel.tsx",
  "@@ -123,6 +123,13 @@ export const ReviewPanel = ({",
  "   const [selectedHunkId, setSelectedHunkId] = useState<string | null>(null);",
  "   const [isLoadingHunks, setIsLoadingHunks] = useState(true);",
  "   const [isLoadingTree, setIsLoadingTree] = useState(true);",
  "+  const [lastInteractionTimestamp, setLastInteractionTimestamp] = useState<number>(() => Date.now());",
  "+",
  "+  useEffect(() => {",
  "+    setLastInteractionTimestamp(Date.now());",
  "+  }, [selectedFilePath, debouncedSearchTerm]);",
  "+",
  "+  const idleForMs = Date.now() - lastInteractionTimestamp;",
  "   const [error, setError] = useState<string | null>(null);",
  "",
  "@@ -410,7 +417,17 @@ export const ReviewPanel = ({",
  "   const handleRefresh = () => {",
  "-    setRefreshTrigger((prev) => prev + 1);",
  "+    setRefreshTrigger((prev) => prev + 1);",
  "+    if (idleForMs > 5000) {",
  '+      console.debug("ReviewPanel idle refresh", { workspaceId, idleForMs });',
  "+    }",
  '+    if (typeof window !== "undefined") {',
  "+      window.dispatchEvent(",
  '+        new CustomEvent("review-panel:refresh", { detail: { workspaceId, idleForMs } })',
  "+      );",
  "+    }",
  "   };",
  "",
  "@@ -642,6 +656,14 @@ export const ReviewPanel = ({",
  '-          <div className="border-border-light bg-separator border-b px-3 py-2">',
  '+          <div className="border-border-light bg-separator border-b px-3 py-2 sticky top-0 z-10 backdrop-blur-sm">',
  '             <div className="border-border-light bg-dark hover:border-border-gray focus-within:border-accent focus-within:hover:border-accent flex items-stretch overflow-hidden rounded border transition-[border-color] duration-150">',
  '+              <span className="text-dim flex items-center px-2 text-[10px] uppercase tracking-wide">',
  "+                Search",
  "+              </span>",
  "               <input",
  "",
  "@@ -707,6 +729,12 @@ export const ReviewPanel = ({",
  "             {(fileTree ?? isLoadingTree) && (",
  '               <div className="border-border-light flex w-full flex-[0_0_auto] flex-col overflow-hidden border-b">',
  "                 <FileTree",
  "                   root={fileTree}",
  "                   selectedPath={selectedFilePath}",
  "                   onSelectFile={setSelectedFilePath}",
  "-                  isLoading={isLoadingTree}",
  "+                  isLoading={isLoadingTree}",
  '+                  key={selectedFilePath ?? "all-files"}',
  "                   getFileReadStatus={getFileReadStatus}",
  "                   workspaceId={workspaceId}",
  "                 />",
  "               </div>",
  "             )}",
]);

const hunkViewerDiff = joinLines([
  "diff --git a/src/browser/components/RightSidebar/CodeReview/HunkViewer.tsx b/src/browser/components/RightSidebar/CodeReview/HunkViewer.tsx",
  "index 6c1d2e3..9f0a1b2 100644",
  "--- a/src/browser/components/RightSidebar/CodeReview/HunkViewer.tsx",
  "+++ b/src/browser/components/RightSidebar/CodeReview/HunkViewer.tsx",
  "@@ -49,6 +49,7 @@ export const HunkViewer = React.memo<HunkViewerProps>(",
  "     // Track if hunk is visible in viewport for lazy syntax highlighting",
  "     const isVisibleRef = React.useRef(true); // Start visible to avoid flash",
  "     const [isVisible, setIsVisible] = React.useState(true);",
  "+    const [isPinned, setIsPinned] = React.useState(false);",
  "",
  "@@ -150,6 +151,13 @@ export const HunkViewer = React.memo<HunkViewerProps>(",
  "     const handleToggleExpand = React.useCallback(",
  "       (e?: React.MouseEvent) => {",
  "         e?.stopPropagation();",
  "         const newExpandState = !isExpanded;",
  "         setIsExpanded(newExpandState);",
  "         // Persist manual expand/collapse choice",
  "         setExpandStateMap((prev) => ({",
  "           ...prev,",
  "           [hunkId]: newExpandState,",
  "         }));",
  "       },",
  "       [isExpanded, hunkId, setExpandStateMap]",
  "     );",
  "+",
  "+    const handlePinToggle = React.useCallback((e: React.MouseEvent<HTMLButtonElement>) => {",
  "+      e.stopPropagation();",
  "+      setIsPinned((prev) => !prev);",
  "+    }, []);",
  "",
  "@@ -182,7 +190,8 @@ export const HunkViewer = React.memo<HunkViewerProps>(",
  "         className={cn(",
  '           "bg-dark border rounded mb-3 overflow-hidden cursor-pointer transition-all duration-200",',
  '           "focus:outline-none focus-visible:outline-none",',
  '           isRead ? "border-read" : "border-border-light",',
  '-          isSelected && "border-review-accent shadow-[0_0_0_1px_var(--color-review-accent)]"',
  '+          isSelected && "border-review-accent shadow-[0_0_0_1px_var(--color-review-accent)]",',
  '+          isPinned && "ring-1 ring-review-accent/70"',
  "         )}",
  "",
  "@@ -206,6 +215,18 @@ export const HunkViewer = React.memo<HunkViewerProps>(",
  '           <div className="flex shrink-0 items-center gap-2 text-[11px] whitespace-nowrap">',
  "+            <TooltipWrapper inline>",
  "+              <button",
  "+                className={cn(",
  '+                  "border-border-light flex cursor-pointer items-center gap-1 rounded-[3px] border bg-transparent px-1.5 py-0.5 text-[11px] transition-all duration-200",',
  '+                  isPinned ? "text-warning-light border-warning" : "text-muted hover:text-foreground",',
  '+                  isPinned && "bg-warning/10"',
  "+                )}",
  '+                type="button"',
  "+                onClick={handlePinToggle}",
  "+              >",
  '+                {isPinned ? "Pinned" : "Pin"}',
  "+              </button>",
  '+              <Tooltip align="center" position="top">',
  "+                Keep this hunk expanded while scrolling",
  "+              </Tooltip>",
  "+            </TooltipWrapper>",
  "             {!isPureRename && (",
]);

const useReviewStateDiff = joinLines([
  "diff --git a/src/browser/hooks/useReviewState.ts b/src/browser/hooks/useReviewState.ts",
  "index 1234567..89abcde 100644",
  "--- a/src/browser/hooks/useReviewState.ts",
  "+++ b/src/browser/hooks/useReviewState.ts",
  "@@ -43,6 +43,7 @@ export interface UseReviewStateReturn {",
  "   /** Mark one or more hunks as read */",
  "   markAsRead: (hunkIds: string | string[]) => void;",
  "   /** Mark a hunk as unread */",
  "   markAsUnread: (hunkId: string) => void;",
  "+  /** Mark several hunks as unread without multiple re-renders */",
  "+  markManyAsUnread: (hunkIds: string[]) => void;",
  "   /** Toggle read state of a hunk */",
  "   toggleRead: (hunkId: string) => void;",
  "",
  "@@ -133,6 +134,33 @@ export function useReviewState(workspaceId: string): UseReviewStateReturn {",
  "   const markAsUnread = useCallback(",
  "     (hunkId: string) => {",
  "       setReviewState((prev) => {",
  "         // Early return if not currently read",
  "         if (!prev.readState[hunkId]) return prev;",
  "",
  "         const { [hunkId]: _, ...rest } = prev.readState;",
  "         return {",
  "           ...prev,",
  "           readState: rest,",
  "           lastUpdated: Date.now(),",
  "         };",
  "       });",
  "     },",
  "     [setReviewState]",
  "   );",
  "+",
  "+  const markManyAsUnread = useCallback(",
  "+    (hunkIds: string[]) => {",
  "+      if (hunkIds.length === 0) return;",
  "+      setReviewState((prev) => {",
  "+        const nextState = { ...prev.readState };",
  "+        let changed = false;",
  "+        for (const id of hunkIds) {",
  "+          if (nextState[id]) {",
  "+            delete nextState[id];",
  "+            changed = true;",
  "+          }",
  "+        }",
  "+        if (!changed) return prev;",
  "+        return {",
  "+          ...prev,",
  "+          readState: nextState,",
  "+          lastUpdated: Date.now(),",
  "+        };",
  "+      });",
  "+    },",
  "+    [setReviewState]",
  "+  );",
  "",
  "@@ -183,6 +211,7 @@ export function useReviewState(workspaceId: string): UseReviewStateReturn {",
  "   return {",
  "     isRead,",
  "     markAsRead,",
  "     markAsUnread,",
  "+    markManyAsUnread,",
  "     toggleRead,",
  "     clearAll,",
  "     readCount,",
  "   };",
]);

const codeReviewCssDiff = joinLines([
  "diff --git a/src/styles/codeReview.css b/src/styles/codeReview.css",
  "index 13579bd..2468ace 100644",
  "--- a/src/styles/codeReview.css",
  "+++ b/src/styles/codeReview.css",
  "@@ -12,6 +12,24 @@ .code-review-panel {",
  "   scrollbar-color: var(--color-border-light) transparent;",
  " }",
  "+",
  "+.code-review-panel .search-header {",
  "+  position: sticky;",
  "+  top: 0;",
  "+  z-index: 10;",
  "+  padding-block: 6px;",
  "+  background: linear-gradient(180deg, rgba(12, 13, 17, 0.95), rgba(12, 13, 17, 0.6));",
  "+  backdrop-filter: blur(12px);",
  "+}",
  "+",
  "+.code-review-panel .file-tree-row.is-filtered {",
  "+  color: var(--color-review-accent);",
  "+  font-weight: 600;",
  "+}",
  "+",
  "+.code-review-panel .hunk-pinned {",
  "+  outline: 1px solid var(--color-review-accent);",
  "+  outline-offset: 2px;",
  "+  background-color: rgba(77, 184, 255, 0.05);",
  "+}",
]);

const docChecklistDiff = joinLines([
  "diff --git a/docs/review-checklist.md b/docs/review-checklist.md",
  "new file mode 100644",
  "index 0000000..1f5e3d4",
  "--- /dev/null",
  "+++ b/docs/review-checklist.md",
  "@@ -0,0 +1,24 @@",
  "+# Code Review Checklist",
  "+",
  "+Use this checklist when triaging large diffs inside the mux Code Review panel:",
  "+",
  "+1. Confirm keyboard shortcuts render in tooltips for every actionable item.",
  "+2. Verify truncation warnings show up before the hunks and provide remediation steps.",
  "+3. Ensure pinned hunks retain their state after scrolling or reloading.",
  "+4. Confirm file filters highlight the active directory inside the tree.",
  "+5. Skim docs and tests for every file with 50+ additions.",
  "+",
  "+## Reviewer Notes",
  "+",
  "+- Capture high-level summary of risky areas.",
  "+- Note any follow-up tasks for documentation or monitoring.",
  "+- Cross-link related tickets or incidents.",
  "+",
  "+## Sign-Off",
  "+",
  "+- [ ] Tests added or explicitly deemed unnecessary.",
  "+- [ ] Accessibility impact reviewed.",
  "+- [ ] Performance implications measured for hot paths.",
  "+- [ ] Rollback plan documented.",
]);

const themeRenameDiff = joinLines([
  "diff --git a/src/styles/theme.css b/src/styles/theme.scss",
  "index 5c4b3a2..5c4b3a2 100644",
  "similarity index 100%",
  "rename from src/styles/theme.css",
  "rename to src/styles/theme.scss",
  "@@ -0,0 +0,0 @@",
]);

const packageJsonDiff = joinLines([
  "diff --git a/package.json b/package.json",
  "index a1b2c3d..d4c3b2a 100644",
  "--- a/package.json",
  "+++ b/package.json",
  "@@ -5,7 +5,8 @@",
  '   "name": "mux",',
  '   "scripts": {',
  '-    "storybook": "storybook dev -p 6006"',
  '+    "storybook": "storybook dev -p 6006",',
  '+    "storybook:code-review": "storybook dev -p 6006 --docs"',
  "   },",
  '   "devDependencies": {',
  "@@ -23,4 +24,5 @@",
  '   "lint-staged": {},',
  '+  "codeReviewPanel": "storybook"',
  " }",
]);

const richDiffByFile: Record<string, string> = {
  "src/browser/components/RightSidebar/CodeReview/ReviewPanel.tsx": reviewPanelDiff,
  "src/browser/components/RightSidebar/CodeReview/HunkViewer.tsx": hunkViewerDiff,
  "src/browser/hooks/useReviewState.ts": useReviewStateDiff,
  "src/styles/codeReview.css": codeReviewCssDiff,
  "docs/review-checklist.md": docChecklistDiff,
  "src/styles/theme.scss": themeRenameDiff,
  "package.json": packageJsonDiff,
};

const richNumstat = [
  "72\t14\tsrc/browser/components/RightSidebar/CodeReview/ReviewPanel.tsx",
  "34\t6\tsrc/browser/components/RightSidebar/CodeReview/HunkViewer.tsx",
  "24\t3\tsrc/browser/hooks/useReviewState.ts",
  "27\t0\tsrc/styles/codeReview.css",
  "48\t0\tdocs/review-checklist.md",
  "0\t0\tsrc/styles/{theme.css => theme.scss}",
  "4\t1\tpackage.json",
].join("\n");

const WORKSPACE_PATH = "/home/user/projects/mux";

const scenarioConfigs: Record<ScenarioName, ScenarioConfig> = {
  rich: {
    name: "rich",
    workspaceId: "storybook-review-rich",
    workspacePath: WORKSPACE_PATH,
    diffByFile: richDiffByFile,
    numstatOutput: richNumstat,
    untrackedFiles: ["notes/review-followups.md", "scripts/smoke-review.sh"],
  },
  truncated: {
    name: "truncated",
    workspaceId: "storybook-review-truncated",
    workspacePath: WORKSPACE_PATH,
    diffByFile: richDiffByFile,
    numstatOutput: richNumstat,
    untrackedFiles: ["notes/review-followups.md"],
    truncated: {
      reason: "terminal buffer limit (storybook fixture)",
      totalLines: 2400,
    },
  },
  empty: {
    name: "empty",
    workspaceId: "storybook-review-empty",
    workspacePath: WORKSPACE_PATH,
    diffByFile: {},
    numstatOutput: "",
    untrackedFiles: ["playground/spike.ts"],
  },
};

function createSuccessResult(
  output: string,
  overrides?: { truncated?: { reason: string; totalLines: number } }
): Result<BashToolResult, string> {
  return {
    success: true as const,
    data: {
      success: true as const,
      output,
      exitCode: 0,
      wall_duration_ms: 5,
      ...overrides,
    },
  };
}

function setupCodeReviewMocks(config: ScenarioConfig) {
  const executeBash: IPCApi["workspace"]["executeBash"] = (_workspaceId, command) => {
    if (command.includes("git ls-files --others --exclude-standard")) {
      return Promise.resolve(createSuccessResult(config.untrackedFiles.join("\n")));
    }

    if (command.includes("--numstat")) {
      return Promise.resolve(createSuccessResult(config.numstatOutput));
    }

    if (command.includes("git add --")) {
      return Promise.resolve(createSuccessResult(""));
    }

    if (command.startsWith("git diff") || command.includes("git diff ")) {
      const pathRegex = / -- "([^"]+)"/;
      const pathMatch = pathRegex.exec(command);
      const pathFilter = pathMatch?.[1];
      const diffOutput = pathFilter
        ? (config.diffByFile[pathFilter] ?? "")
        : Object.values(config.diffByFile).filter(Boolean).join("\n\n");

      const truncated =
        !pathFilter && config.truncated ? { truncated: config.truncated } : undefined;
      return Promise.resolve(createSuccessResult(diffOutput, truncated));
    }

    return Promise.resolve(createSuccessResult(""));
  };

  const mockApi = {
    workspace: {
      executeBash,
    },
    platform: "browser",
    versions: {
      node: "18.18.0",
      chrome: "120.0.0.0",
      electron: "28.0.0",
    },
  } as unknown as IPCApi;

  // @ts-expect-error - mockApi is not typed correctly
  window.api = mockApi;

  deleteWorkspaceStorage(config.workspaceId);
  localStorage.removeItem(`review-diff-base:${config.workspaceId}`);
  localStorage.removeItem(`review-file-filter:${config.workspaceId}`);
  localStorage.setItem("review-default-base", "HEAD");
  localStorage.setItem("review-include-uncommitted", "false");
  localStorage.setItem("review-show-read", "true");
}

const ReviewPanelStoryWrapper: React.FC<{ scenario: ScenarioName }> = ({ scenario }) => {
  const initialized = useRef(false);
  const config = scenarioConfigs[scenario];

  if (!initialized.current) {
    setupCodeReviewMocks(config);
    initialized.current = true;
  }

  return (
    <div
      style={{
        height: "720px",
        width: "520px",
        padding: "16px",
        background: "#050505",
        boxSizing: "border-box",
      }}
    >
      <ReviewPanel workspaceId={config.workspaceId} workspacePath={config.workspacePath} />
    </div>
  );
};

const meta = {
  title: "Panels/Code Review/ReviewPanel",
  component: ReviewPanel,
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "panel",
      values: [{ name: "panel", value: "#050505" }],
    },
  },
} satisfies Meta<typeof ReviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RichContent: Story = {
  args: {
    workspaceId: scenarioConfigs.rich.workspaceId,
    workspacePath: scenarioConfigs.rich.workspacePath,
  },
  render: () => <ReviewPanelStoryWrapper scenario="rich" />,
};

export const TruncatedDiff: Story = {
  args: {
    workspaceId: scenarioConfigs.truncated.workspaceId,
    workspacePath: scenarioConfigs.truncated.workspacePath,
  },
  render: () => <ReviewPanelStoryWrapper scenario="truncated" />,
};

export const EmptyState: Story = {
  args: {
    workspaceId: scenarioConfigs.empty.workspaceId,
    workspacePath: scenarioConfigs.empty.workspacePath,
  },
  render: () => <ReviewPanelStoryWrapper scenario="empty" />,
};
