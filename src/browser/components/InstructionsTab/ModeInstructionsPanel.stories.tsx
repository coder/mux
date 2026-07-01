import type { Meta, StoryObj } from "@storybook/react-vite";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import { APIProvider } from "@/browser/contexts/API";
import { AgentProvider, type AgentContextValue } from "@/browser/contexts/AgentContext";
import { createMockORPCClient } from "@/browser/stories/mocks/orpc";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";

import { ModeInstructionsPanel } from "./ModeInstructionsPanel";

const WORKSPACE_ID = "ws-mode-instructions";

const EXEC_AGENT: AgentDefinitionDescriptor = {
  id: "exec",
  scope: "built-in",
  name: "Exec",
  description: "Implement changes in the repository",
  uiSelectable: true,
  uiRoutable: true,
  subagentRunnable: true,
  uiColor: "var(--color-exec-mode)",
};

const PLAN_AGENT: AgentDefinitionDescriptor = {
  id: "plan",
  scope: "built-in",
  name: "Plan",
  description: "Create a plan before coding — research, propose, then hand off.",
  uiSelectable: true,
  uiRoutable: true,
  subagentRunnable: false,
  base: "plan",
  uiColor: "var(--color-plan-mode)",
};

const EXEC_BODY = `# Exec mode

You are in **Exec mode**. Make the requested change with minimal, reviewable
edits and verify your work.

## Standing orders

- Read before you write: confirm paths, symbols, and call-sites first.
- Prefer narrow, targeted fixes over large rewrites.
- Run typecheck and the most-relevant tests after every meaningful change.
- Never claim success until validation actually passes.

## Tools available

- File editing (replace_string, insert)
- Bash (typecheck, lint, tests, git)
- Sub-agents (\`explore\` for read-only investigation)
`;

const PLAN_BODY = `# Plan mode

You are in **Plan mode**. Your job is to think and design — _not_ to write
production code.

## What "done" looks like

1. A clearly-scoped problem statement.
2. A proposed implementation plan, broken into concrete steps.
3. Identified risks and the most important review surface.

> When the plan is accepted, hand off to \`exec\` for implementation.
`;

function buildContext(
  agent: AgentDefinitionDescriptor,
  overrides?: Partial<AgentContextValue>
): AgentContextValue {
  return {
    agentId: agent.id,
    setAgentId: () => undefined,
    currentAgent: agent,
    agents: [agent],
    loaded: true,
    loadFailed: false,
    refresh: () => Promise.resolve(),
    refreshing: false,
    disableWorkspaceAgents: false,
    setDisableWorkspaceAgents: () => undefined,
    ...overrides,
  };
}

function withMockProviders(context: AgentContextValue, bodies: Record<string, string>) {
  return function Decorator(Story: React.ComponentType) {
    return (
      <APIProvider
        client={createMockORPCClient({
          agentDefinitions: [EXEC_AGENT, PLAN_AGENT],
          agentBodies: bodies,
        })}
      >
        <AgentProvider value={context}>
          <TooltipProvider>
            <div className="bg-background mx-auto max-w-md p-3">
              <Story />
            </div>
          </TooltipProvider>
        </AgentProvider>
      </APIProvider>
    );
  };
}

const meta: Meta<typeof ModeInstructionsPanel> = {
  title: "App/Right Sidebar/Instructions/ModeInstructionsPanel",
  component: ModeInstructionsPanel,
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Snapshot budget is tight (see tests/ui/storybook/budget.test.ts), so we
// cover the two distinct mode colors (exec=purple, plan=blue) — those are
// the visuals most worth protecting against regressions. Custom-scope and
// empty-body variants are exercised indirectly via the implementation tests.
export const ExecMode: Story = {
  args: { workspaceId: WORKSPACE_ID },
  decorators: [withMockProviders(buildContext(EXEC_AGENT), { exec: EXEC_BODY })],
};

export const PlanMode: Story = {
  args: { workspaceId: WORKSPACE_ID },
  decorators: [withMockProviders(buildContext(PLAN_AGENT), { plan: PLAN_BODY })],
};
