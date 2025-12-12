/**
 * Component-level stories for GitStatusIndicatorView.
 *
 * We keep these stories independent from GitStatusStore/executeBash so we can
 * validate the UI deterministically without replicating git command output.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import React from "react";
import type { GitStatus } from "@/common/types/workspace";
import type { GitBranchHeader, GitCommit } from "@/common/utils/git/parseGitLog";
import { GitStatusIndicatorView } from "@/browser/components/GitStatusIndicatorView";

const meta: Meta<typeof GitStatusIndicatorView> = {
  title: "Components/GitStatusIndicatorView",
  component: GitStatusIndicatorView,
  parameters: {
    layout: "fullscreen",
    backgrounds: {
      default: "dark",
      values: [{ name: "dark", value: "#1e1e1e" }],
    },
  },
  decorators: [
    (Story) => (
      <div className="bg-sidebar flex min-h-screen items-start justify-start p-10">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof meta>;

const noop = () => undefined;

const baseStatus: GitStatus = {
  ahead: 0,
  behind: 0,
  dirty: false,
  outgoingAdditions: 0,
  outgoingDeletions: 0,
  incomingAdditions: 0,
  incomingDeletions: 0,
};

const branchHeaders: GitBranchHeader[] = [
  { branch: "HEAD", columnIndex: 0 },
  { branch: "origin/main", columnIndex: 1 },
  { branch: "origin/feature", columnIndex: 2 },
];

const commits: GitCommit[] = [
  {
    indicators: "-  ",
    hash: "1234abc",
    date: "Nov 14 10:30 AM",
    subject: "Local commit",
  },
  {
    indicators: " + ",
    hash: "2345bcd",
    date: "Nov 14 09:12 AM",
    subject: "Origin commit",
  },
  {
    indicators: "++ ",
    hash: "3456cde",
    date: "Nov 13 06:05 PM",
    subject: "Shared commit",
  },
];

export const LineDeltaTooltipOpen: Story = {
  args: {
    gitStatus: {
      ...baseStatus,
      ahead: 2,
      behind: 1,
      dirty: true,
      outgoingAdditions: 12313,
      outgoingDeletions: 1231,
    },
    mode: "line-delta",
    tooltipPosition: "right",
    branchHeaders,
    commits,
    dirtyFiles: ["src/App.tsx", "src/browser/stores/GitStatusStore.ts"],
    isLoading: false,
    errorMessage: null,
    showTooltip: true,
    tooltipCoords: { top: 120, left: 220 },
    onMouseEnter: noop,
    onMouseLeave: noop,
    onTooltipMouseEnter: noop,
    onTooltipMouseLeave: noop,
    onModeChange: noop,
    onContainerRef: noop,
    isWorking: true,
  },
};

export const BehindOnlyLineDelta: Story = {
  args: {
    gitStatus: {
      ...baseStatus,
      behind: 5,
    },
    mode: "line-delta",
    tooltipPosition: "right",
    branchHeaders,
    commits,
    dirtyFiles: [],
    isLoading: false,
    errorMessage: null,
    showTooltip: true,
    tooltipCoords: { top: 220, left: 220 },
    onMouseEnter: noop,
    onMouseLeave: noop,
    onTooltipMouseEnter: noop,
    onTooltipMouseLeave: noop,
    onModeChange: noop,
    onContainerRef: noop,
    isWorking: false,
  },
};

export const DivergenceTooltipOpen: Story = {
  args: {
    gitStatus: {
      ...baseStatus,
      ahead: 3,
      behind: 2,
    },
    mode: "divergence",
    tooltipPosition: "right",
    branchHeaders,
    commits,
    dirtyFiles: [],
    isLoading: false,
    errorMessage: null,
    showTooltip: true,
    tooltipCoords: { top: 320, left: 220 },
    onMouseEnter: noop,
    onMouseLeave: noop,
    onTooltipMouseEnter: noop,
    onTooltipMouseLeave: noop,
    onModeChange: noop,
    onContainerRef: noop,
    isWorking: false,
  },
};
