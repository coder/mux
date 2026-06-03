import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  WorkflowListToolCall,
  WorkflowReadToolCall,
} from "@/browser/features/Tools/WorkflowDefinitionToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";

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
