import type { ComponentType } from "react";

import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor, within } from "@storybook/test";

import {
  WorkflowListToolCall,
  WorkflowReadToolCall,
} from "@/browser/features/Tools/WorkflowDefinitionToolCall";
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

const workflowMetadata = {
  description:
    "Review an artifact, adversarially verify findings, fix them, and repeat until clean.",
  argsSchema: {
    type: "object",
    properties: {
      artifact: { type: "string", positional: true },
    },
  },
};

const sourceStats = { chars: source.length, lines: source.split(/\r\n|\r|\n/u).length };

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
        view: "source",
        descriptor: {
          name: "review-fix-loop",
          description:
            "Review an artifact, adversarially verify findings, fix them, and repeat until clean.",
          scope: "scratch",
          sourcePath: "/repo/.mux/workflows/.scratch/review-fix-loop.js",
          executable: true,
        },
        metadata: workflowMetadata,
        sourceStats,
        source,
      }}
    />
  ),
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
    chromatic: { modes: { "dark-mobile": { theme: "dark", viewport: "mobile1", hasTouch: true } } },
  },
  play: async ({ canvasElement }) => {
    expandToolCard(canvasElement, "3 definitions");
    await expectDescriptionBelowName(canvasElement, "deep-research", /Coordinate staged research/);
  },
};
