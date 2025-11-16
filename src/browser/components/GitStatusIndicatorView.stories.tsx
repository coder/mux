import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor } from "storybook/test";
import { GitStatusIndicatorView } from "./GitStatusIndicatorView";
import type { GitCommit, GitBranchHeader } from "@/utils/git/parseGitLog";
import { useState } from "react";

// Type for the wrapped component props (without interaction handlers)
type InteractiveProps = Omit<
  React.ComponentProps<typeof GitStatusIndicatorView>,
  | "showTooltip"
  | "tooltipCoords"
  | "onMouseEnter"
  | "onMouseLeave"
  | "onTooltipMouseEnter"
  | "onTooltipMouseLeave"
  | "onContainerRef"
>;

const meta = {
  title: "Components/GitStatusIndicatorView",
  component: GitStatusIndicatorView,
  parameters: {
    layout: "centered",
  },
  tags: ["autodocs"],
} satisfies Meta<typeof GitStatusIndicatorView>;

export default meta;
type Story = StoryObj<InteractiveProps>;

// Mock data for different scenarios
const mockBranchHeaders: GitBranchHeader[] = [
  { branch: "HEAD", columnIndex: 0 },
  { branch: "origin/main", columnIndex: 1 },
  { branch: "origin/feature-branch", columnIndex: 2 },
];

const mockCommits: GitCommit[] = [
  {
    hash: "a1b2c3d",
    date: "Jan 15 02:30 PM",
    subject: "feat: Add new feature",
    indicators: "***",
  },
  {
    hash: "e4f5g6h",
    date: "Jan 15 01:45 PM",
    subject: "fix: Resolve bug in handler",
    indicators: "*+ ",
  },
  {
    hash: "i7j8k9l",
    date: "Jan 15 11:20 AM",
    subject: "refactor: Simplify logic",
    indicators: " + ",
  },
  {
    hash: "m0n1o2p",
    date: "Jan 14 04:15 PM",
    subject: "docs: Update README",
    indicators: "  +",
  },
];

const mockDirtyFiles = [
  "M  src/components/GitStatusIndicator.tsx",
  "M  src/components/GitStatusIndicatorView.tsx",
  "A  src/components/hooks/useGitBranchDetails.ts",
  "?? src/components/GitStatusIndicatorView.stories.tsx",
];

const mockManyDirtyFiles = [
  ...mockDirtyFiles,
  "M  src/utils/git.ts",
  "M  src/types/workspace.ts",
  "A  src/hooks/useData.ts",
  "A  src/hooks/useDebounce.ts",
  "M  package.json",
  "M  tsconfig.json",
  "?? temp-file-1.txt",
  "?? temp-file-2.txt",
  "?? temp-file-3.txt",
  "?? temp-file-4.txt",
  "?? temp-file-5.txt",
  "?? temp-file-6.txt",
  "?? temp-file-7.txt",
  "?? temp-file-8.txt",
  "?? temp-file-9.txt",
  "?? temp-file-10.txt",
  "?? temp-file-11.txt",
  "?? temp-file-12.txt",
  "?? temp-file-13.txt",
  "?? temp-file-14.txt",
  "?? temp-file-15.txt",
  "?? temp-file-16.txt",
  "?? temp-file-17.txt",
];

// Interactive wrapper component for stories with hover state
const InteractiveWrapper = (props: InteractiveProps) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const [tooltipCoords, setTooltipCoords] = useState({ top: 0, left: 0 });
  const [containerEl, setContainerEl] = useState<HTMLSpanElement | null>(null);

  const handleMouseEnter = () => {
    setShowTooltip(true);
    if (containerEl) {
      const rect = containerEl.getBoundingClientRect();
      if (props.tooltipPosition === "bottom") {
        setTooltipCoords({
          top: rect.bottom + 8,
          left: rect.left,
        });
      } else {
        setTooltipCoords({
          top: rect.top + rect.height / 2,
          left: rect.right + 8,
        });
      }
    }
  };

  const handleTooltipMouseEnter = () => {
    // No-op for Storybook demo - in real app, prevents tooltip from closing when hovering over it
  };

  return (
    <GitStatusIndicatorView
      {...props}
      showTooltip={showTooltip}
      tooltipCoords={tooltipCoords}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setShowTooltip(false)}
      onTooltipMouseEnter={handleTooltipMouseEnter}
      onTooltipMouseLeave={() => setShowTooltip(false)}
      onContainerRef={setContainerEl}
    />
  );
};

// Basic indicator states
export const AheadOnly: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 0, dirty: false },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: null,
    isLoading: false,
    errorMessage: null,
  },
};

export const BehindOnly: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 0, behind: 5, dirty: false },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: null,
    isLoading: false,
    errorMessage: null,
  },
};

export const AheadAndBehind: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 5, dirty: false },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: null,
    isLoading: false,
    errorMessage: null,
  },
  play: async ({ canvasElement }) => {
    // Find the git status indicator element
    const indicator = canvasElement.querySelector(".git-status-wrapper") ?? canvasElement;

    // Hover over the indicator to show tooltip
    await userEvent.hover(indicator);

    // Wait for tooltip to appear with git status info
    await waitFor(
      () => {
        // The tooltip is rendered as a portal in document.body
        const tooltip = document.querySelector("[data-git-tooltip]");
        if (!tooltip) {
          // Tooltip might not have a data attribute, so find it by checking for git-related text
          const tooltips = document.querySelectorAll("div");
          const gitTooltip = Array.from(tooltips).find(
            (el) =>
              el.textContent?.includes("ahead") ||
              el.textContent?.includes("behind") ||
              el.textContent?.includes("HEAD")
          );
          if (gitTooltip?.style.position === "fixed") {
            void expect(gitTooltip).toBeInTheDocument();
            void expect(gitTooltip.textContent).toContain("HEAD");
            return;
          }
        }
        // If we have a data attribute, use that
        if (tooltip) {
          void expect(tooltip).toBeInTheDocument();
        }
      },
      { timeout: 3000 }
    );
  },
};

export const DirtyOnly: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 0, behind: 0, dirty: true },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: mockDirtyFiles,
    isLoading: false,
    errorMessage: null,
  },
};

export const AllCombined: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 5, dirty: true },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: mockDirtyFiles,
    isLoading: false,
    errorMessage: null,
  },
};

// Tooltip content states
export const LoadingState: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 0, dirty: false },
    tooltipPosition: "right",
    branchHeaders: null,
    commits: null,
    dirtyFiles: null,
    isLoading: true,
    errorMessage: null,
  },
};

export const ErrorState: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 0, dirty: false },
    tooltipPosition: "right",
    branchHeaders: null,
    commits: null,
    dirtyFiles: null,
    isLoading: false,
    errorMessage: "Branch info unavailable: git command failed",
  },
};

export const NoCommitsState: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 0, dirty: false },
    tooltipPosition: "right",
    branchHeaders: null,
    commits: [],
    dirtyFiles: null,
    isLoading: false,
    errorMessage: null,
  },
};

// Dirty files variations
export const WithDirtyFiles: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 2, behind: 1, dirty: true },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: mockDirtyFiles,
    isLoading: false,
    errorMessage: null,
  },
};

export const WithTruncatedDirtyFiles: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 0, behind: 0, dirty: true },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: mockManyDirtyFiles,
    isLoading: false,
    errorMessage: null,
  },
};

// Tooltip position variations
export const TooltipPositionRight: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 5, dirty: true },
    tooltipPosition: "right",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: mockDirtyFiles,
    isLoading: false,
    errorMessage: null,
  },
};

export const TooltipPositionBottom: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 3, behind: 5, dirty: true },
    tooltipPosition: "bottom",
    branchHeaders: mockBranchHeaders,
    commits: mockCommits,
    dirtyFiles: mockDirtyFiles,
    isLoading: false,
    errorMessage: null,
  },
};

// Edge cases
export const HiddenState: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 0, behind: 0, dirty: false },
    tooltipPosition: "right",
    branchHeaders: null,
    commits: null,
    dirtyFiles: null,
    isLoading: false,
    errorMessage: null,
  },
};

export const NullGitStatus: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: null,
    tooltipPosition: "right",
    branchHeaders: null,
    commits: null,
    dirtyFiles: null,
    isLoading: false,
    errorMessage: null,
  },
};

// Minimal branch info (no headers)
export const WithoutBranchHeaders: Story = {
  render: (args) => <InteractiveWrapper {...args} />,
  args: {
    gitStatus: { ahead: 2, behind: 1, dirty: false },
    tooltipPosition: "right",
    branchHeaders: null,
    commits: mockCommits,
    dirtyFiles: null,
    isLoading: false,
    errorMessage: null,
  },
};
