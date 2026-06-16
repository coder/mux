import type { ComponentType } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";

import {
  WorkflowListToolCall,
  WorkflowReadToolCall,
} from "@/browser/features/Tools/WorkflowDefinitionToolCall";
import { WorkflowActionListToolCall } from "@/browser/features/Tools/WorkflowActionListToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

const NARROW_VIEWPORT_GLOBALS = { viewport: { value: "mobile1", isRotated: false } };

/**
 * Forces the narrow tool-card layout regardless of window size: ToolContainer is
 * an inline-size container, so capping the wrapper width engages the
 * `@container(max-width:640px)` styles. Required because the Storybook
 * test-runner applies neither story `globals.viewport` nor Chromatic modes —
 * plays execute at desktop window size, where the pinned mobile1 viewport alone
 * would never engage and the layout assertions below would fail.
 */
function NarrowContainerDecorator(Story: ComponentType) {
  return (
    <div style={{ maxWidth: 375 }}>
      <Story />
    </div>
  );
}

function expandToolCard(canvasElement: HTMLElement, summaryText: string) {
  const canvas = within(canvasElement);
  const header = canvas.getByText(summaryText).closest('[data-scroll-intent="ignore"]');
  if (header == null) throw new Error(`Could not find tool header for "${summaryText}"`);
  (header as HTMLElement).click();
}

/**
 * Assert the narrow list layout engaged: the description must wrap onto its own
 * grid row below the name instead of sharing the single-line wide layout.
 */
async function expectDescriptionBelowName(canvasElement: HTMLElement, name: string, desc: RegExp) {
  const canvas = within(canvasElement);
  const nameEl = await canvas.findByText(name);
  const descEl = canvas.getByText(desc);
  await waitFor(() => {
    if (descEl.getBoundingClientRect().top < nameEl.getBoundingClientRect().bottom) {
      throw new Error(`Expected narrow layout: description below "${name}" row`);
    }
  });
}

const source = `export default function workflow({ args, agent, phase, log }) {
  phase("review", { artifact: args.artifact });
  log("Starting review loop");

  const review = agent({
    id: "review",
    title: "Review implementation",
    prompt: "Review " + args.artifact,
  });

  return {
    reportMarkdown: "# Review complete\\n\\n" + review.reportMarkdown,
    structuredOutput: { verdict: "clean" },
  };
}
`;

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/WorkflowDefinitions",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const WorkflowRead: Story = {
  render: () => (
    <WorkflowReadToolCall
      args={{ name: "review-fix-loop" }}
      status="completed"
      result={{
        descriptor: {
          name: "review-fix-loop",
          description:
            "Review an artifact, adversarially verify findings, fix them, and repeat until clean.",
          scope: "scratch",
          sourcePath: "/repo/.mux/workflows/.scratch/review-fix-loop.js",
          executable: true,
        },
        source,
      }}
    />
  ),
};

export const WorkflowActionList: Story = {
  render: () => (
    <WorkflowActionListToolCall
      args={{}}
      status="completed"
      result={{
        actions: [
          {
            name: "git.changedFiles",
            scope: "built-in",
            sourcePath: "/__mux_builtin_workflow_actions__/git/changedFiles.js",
            executable: true,
            hasReconcile: false,
            metadata: {
              version: 1,
              description:
                "Return changed file lists for branch, staged, unstaged, and untracked files.",
              effect: "read",
              inputSchema: { type: "object", properties: { base: { type: "string" } } },
              outputSchema: {
                type: "object",
                properties: { files: { type: "array", items: { type: "string" } } },
              },
              timeoutMs: 60_000,
            },
          },
          {
            name: "git.commit",
            scope: "built-in",
            sourcePath: "/__mux_builtin_workflow_actions__/git/commit.js",
            executable: true,
            hasReconcile: true,
            metadata: {
              version: 2,
              description: "Create a git commit from staged changes.",
              effect: "workspace",
            },
          },
          {
            name: "slack.notify",
            scope: "global",
            sourcePath: "~/.mux/workflows/actions/slack/notify.js",
            executable: true,
            hasReconcile: false,
            metadata: {
              version: "2026-01-01",
              description: "Post a message to a Slack channel via webhook.",
              effect: "external",
              permissions: { network: ["hooks.slack.com"] },
            },
          },
          {
            name: "audit.scan",
            scope: "project",
            sourcePath: "/repo/.mux/workflows/actions/audit/scan.js",
            executable: false,
            blockedReason: "Trust this project before running project-local actions.",
          },
        ],
      }}
    />
  ),
};

/** iPhone-sized variant: name + badges on one row, description stacked below. */
export const WorkflowActionListNarrow: Story = {
  ...WorkflowActionList,
  globals: NARROW_VIEWPORT_GLOBALS,
  decorators: [NarrowContainerDecorator],
  parameters: {
    // Pinned mobile mode so Chromatic doesn't silently snapshot the wide grid.
    // hasTouch matches the repo's other mobile1 modes so touch-target CSS applies.
    // Modes stay inline (not hoisted) so the snapshot budget estimator counts them.
    chromatic: { modes: { "dark-mobile": { theme: "dark", viewport: "mobile1", hasTouch: true } } },
  },
  play: async ({ canvasElement }) => {
    expandToolCard(canvasElement, "4 actions");
    await expectDescriptionBelowName(
      canvasElement,
      "git.changedFiles",
      /Return changed file lists/
    );
  },
};

export const WorkflowList: Story = {
  render: () => (
    <WorkflowListToolCall
      args={{}}
      status="completed"
      result={{
        workflows: [
          {
            name: "deep-research",
            description: "Coordinate staged research, verification, and synthesis.",
            scope: "built-in",
            executable: true,
          },
          {
            name: "review-fix-loop",
            description:
              "Review an artifact, adversarially verify findings, fix them, and repeat until clean.",
            scope: "scratch",
            sourcePath: "/repo/.mux/workflows/.scratch/review-fix-loop.js",
            executable: true,
          },
          {
            name: "project-audit",
            description: "Project-local audit workflow.",
            scope: "project",
            sourcePath: "/repo/.mux/workflows/project-audit.js",
            executable: false,
            blockedReason: "Trust this project before running project-local workflows.",
          },
        ],
      }}
    />
  ),
};

/** iPhone-sized variant of the definitions list. */
export const WorkflowListNarrow: Story = {
  ...WorkflowList,
  globals: NARROW_VIEWPORT_GLOBALS,
  decorators: [NarrowContainerDecorator],
  parameters: {
    // Inline modes for the budget estimator; see WorkflowActionListNarrow.
    chromatic: { modes: { "dark-mobile": { theme: "dark", viewport: "mobile1", hasTouch: true } } },
  },
  play: async ({ canvasElement }) => {
    expandToolCard(canvasElement, "3 definitions");
    await expectDescriptionBelowName(canvasElement, "deep-research", /Coordinate staged research/);
  },
};
