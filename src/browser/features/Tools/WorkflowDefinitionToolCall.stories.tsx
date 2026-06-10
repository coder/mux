import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  WorkflowListToolCall,
  WorkflowReadToolCall,
} from "@/browser/features/Tools/WorkflowDefinitionToolCall";
import { WorkflowActionListToolCall } from "@/browser/features/Tools/WorkflowActionListToolCall";
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
