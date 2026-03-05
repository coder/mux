import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { AgentSkillReadToolCall } from "@/browser/features/Tools/AgentSkillReadToolCall";
import { lightweightMeta } from "@/browser/stories/meta.js";
import type { AgentSkillReadToolResult } from "@/common/types/tools";

const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/AgentSkillRead",
  component: AgentSkillReadToolCall,
} satisfies Meta<typeof AgentSkillReadToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const TESTS_SKILL_RESULT: AgentSkillReadToolResult = {
  success: true,
  skill: {
    scope: "project",
    directoryName: "tests",
    frontmatter: {
      name: "tests",
      description: "Testing doctrine, commands, and test layout conventions",
    },
    body: `# tests

Use this skill to align changes with project testing conventions.

## Includes

- Test file placement
- Recommended test commands
- Assertions and fixture patterns`,
  },
};

const REACT_EFFECTS_SKILL_RESULT: AgentSkillReadToolResult = {
  success: true,
  skill: {
    scope: "project",
    directoryName: "react-effects",
    frontmatter: {
      name: "react-effects",
      description: "Guidelines for when to use (and avoid) useEffect in React",
    },
    body: `# react-effects

Prefer render-time derivation and explicit event handlers.

## Avoid

- Prop-to-state syncing effects
- Timing-based coordination`,
  },
};

function AgentSkillStoryShell(props: { children: ReactNode }) {
  return (
    <div className="bg-background flex min-h-screen items-start p-6">
      <div className="w-full max-w-3xl space-y-3">{props.children}</div>
    </div>
  );
}

/** Chat showing loaded skills via agent_skill_read tool calls */
export const WithLoadedSkills: Story = {
  render: () => (
    <AgentSkillStoryShell>
      <AgentSkillReadToolCall
        args={{ name: "tests" }}
        result={TESTS_SKILL_RESULT}
        status="completed"
      />
      <AgentSkillReadToolCall
        args={{ name: "react-effects" }}
        result={REACT_EFFECTS_SKILL_RESULT}
        status="completed"
      />
    </AgentSkillStoryShell>
  ),
};

/** Chat showing a skill invocation command on user messages */
export const WithSkillCommand: Story = {
  render: () => (
    <AgentSkillStoryShell>
      <AgentSkillReadToolCall args={{ name: "react-effects" }} status="executing" />
    </AgentSkillStoryShell>
  ),
};
