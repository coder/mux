import type { SessionConfigOption, SessionConfigSelectOption } from "@agentclientprotocol/sdk";
import {
  AGENT_MODE_CONFIG_ID,
  buildConfigOptions,
  handleSetConfigOption,
} from "../../src/node/acp/configOptions";
import type { ORPCClient } from "../../src/node/acp/serverConnection";

interface WorkspaceAiSettings {
  model: string;
  thinkingLevel: "off" | "low" | "medium" | "high" | "xhigh" | "max";
}

interface WorkspaceState {
  agentId: string;
  aiSettings: WorkspaceAiSettings;
  aiSettingsByAgent: Record<string, WorkspaceAiSettings>;
}

type WorkspaceInfo = NonNullable<Awaited<ReturnType<ORPCClient["workspace"]["getInfo"]>>>;

type AgentDescriptor = Awaited<ReturnType<ORPCClient["agents"]["list"]>>[number];

const DEFAULT_AGENT_DESCRIPTORS: Awaited<ReturnType<ORPCClient["agents"]["list"]>> = [
  {
    id: "exec",
    scope: "built-in",
    name: "Exec",
    description: "Implement changes in the repository",
    uiSelectable: true,
    subagentRunnable: true,
  },
  {
    id: "plan",
    scope: "built-in",
    name: "Plan",
    description: "Create a plan before coding",
    uiSelectable: true,
    subagentRunnable: true,
  },
  {
    id: "ask",
    scope: "built-in",
    name: "Ask",
    description: "Delegate questions to Explore sub-agents and synthesize an answer.",
    uiSelectable: true,
    subagentRunnable: false,
  },
  {
    id: "auto",
    scope: "built-in",
    name: "Auto",
    description: "Automatically selects the best agent for your task",
    uiSelectable: true,
    subagentRunnable: false,
  },
  {
    id: "explore",
    scope: "built-in",
    name: "Explore",
    description: "Read-only exploration",
    uiSelectable: false,
    subagentRunnable: true,
  },
];

function createHarness(
  initial: WorkspaceState,
  options?: {
    agents?: AgentDescriptor[];
  }
): {
  client: ORPCClient;
  getWorkspaceState: () => WorkspaceState;
  updateModeCalls: Array<{
    workspaceId: string;
    mode: "exec" | "plan";
    aiSettings: WorkspaceAiSettings;
  }>;
  updateAgentCalls: Array<{
    workspaceId: string;
    agentId: string;
    aiSettings: WorkspaceAiSettings;
  }>;
} {
  let workspaceState: WorkspaceState = {
    agentId: initial.agentId,
    aiSettings: { ...initial.aiSettings },
    aiSettingsByAgent: { ...initial.aiSettingsByAgent },
  };

  const updateModeCalls: Array<{
    workspaceId: string;
    mode: "exec" | "plan";
    aiSettings: WorkspaceAiSettings;
  }> = [];
  const updateAgentCalls: Array<{
    workspaceId: string;
    agentId: string;
    aiSettings: WorkspaceAiSettings;
  }> = [];

  const availableAgents = options?.agents ?? DEFAULT_AGENT_DESCRIPTORS;

  const client = {
    workspace: {
      getInfo: async (): Promise<WorkspaceInfo> => ({
        id: "ws-1",
        name: "ws-1",
        title: "ws-1",
        projectName: "project",
        projectPath: "/tmp/project",
        runtimeConfig: { type: "local" },
        namedWorkspacePath: "/tmp/project/.mux/ws-1",
        agentId: workspaceState.agentId,
        aiSettings: workspaceState.aiSettings,
        aiSettingsByAgent: workspaceState.aiSettingsByAgent,
      }),
      updateModeAISettings: async (input: {
        workspaceId: string;
        mode: "exec" | "plan";
        aiSettings: WorkspaceAiSettings;
      }) => {
        updateModeCalls.push(input);

        workspaceState = {
          ...workspaceState,
          agentId: input.mode,
          aiSettings: { ...input.aiSettings },
          aiSettingsByAgent: {
            ...workspaceState.aiSettingsByAgent,
            [input.mode]: { ...input.aiSettings },
          },
        };

        return { success: true as const, data: undefined };
      },
      updateAgentAISettings: async (input: {
        workspaceId: string;
        agentId: string;
        aiSettings: WorkspaceAiSettings;
      }) => {
        updateAgentCalls.push(input);

        workspaceState = {
          ...workspaceState,
          agentId: input.agentId,
          aiSettings: { ...input.aiSettings },
          aiSettingsByAgent: {
            ...workspaceState.aiSettingsByAgent,
            [input.agentId]: { ...input.aiSettings },
          },
        };

        return { success: true as const, data: undefined };
      },
    },
    agents: {
      list: async () => availableAgents,
    },
  } as unknown as ORPCClient;

  return {
    client,
    getWorkspaceState: () => workspaceState,
    updateModeCalls,
    updateAgentCalls,
  };
}

function getSelectConfigOption(
  options: SessionConfigOption[],
  id: string
): Extract<SessionConfigOption, { type: "select" }> {
  const option = options.find((candidate) => candidate.id === id);
  if (option == null || option.type !== "select") {
    throw new Error(`Expected select config option '${id}'`);
  }
  return option;
}

function flattenSelectOptions(
  option: Extract<SessionConfigOption, { type: "select" }>
): SessionConfigSelectOption[] {
  return option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

describe("ACP config options", () => {
  it("includes agent mode descriptions and model-aware thinking labels for Opus 4.6", async () => {
    const harness = createHarness({
      agentId: "exec",
      aiSettings: {
        model: "anthropic:claude-opus-4-6",
        thinkingLevel: "xhigh",
      },
      aiSettingsByAgent: {
        exec: {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "xhigh",
        },
      },
    });

    const options = await buildConfigOptions(harness.client, "ws-1", { activeAgentId: "exec" });

    const agentModeOption = getSelectConfigOption(options, AGENT_MODE_CONFIG_ID);
    const agentModeEntries = flattenSelectOptions(agentModeOption);

    expect(agentModeEntries.find((entry) => entry.value === "exec")?.description).toBe(
      "Implement changes in the repository"
    );
    expect(agentModeEntries.find((entry) => entry.value === "ask")?.description).toBe(
      "Delegate questions to Explore sub-agents and synthesize an answer."
    );
    expect(agentModeEntries.find((entry) => entry.value === "plan")?.description).toBe(
      "Create a plan before coding"
    );
    expect(agentModeEntries.find((entry) => entry.value === "auto")?.description).toBe(
      "Automatically selects the best agent for your task"
    );
    expect(agentModeEntries.map((entry) => entry.value)).toEqual(["exec", "plan", "ask", "auto"]);

    const thinkingOption = getSelectConfigOption(options, "thinkingLevel");
    const thinkingEntries = flattenSelectOptions(thinkingOption);

    expect(thinkingOption.currentValue).toBe("xhigh");
    expect(thinkingEntries.map((entry) => entry.value)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(thinkingEntries.map((entry) => entry.name)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
  });

  it("normalizes openai thinking labels and current value to xhigh (not max)", async () => {
    const harness = createHarness({
      agentId: "exec",
      aiSettings: {
        model: "openai:gpt-5.2",
        thinkingLevel: "max",
      },
      aiSettingsByAgent: {
        exec: {
          model: "openai:gpt-5.2",
          thinkingLevel: "max",
        },
      },
    });

    const options = await buildConfigOptions(harness.client, "ws-1", { activeAgentId: "exec" });

    const thinkingOption = getSelectConfigOption(options, "thinkingLevel");
    const thinkingEntries = flattenSelectOptions(thinkingOption);

    expect(thinkingOption.currentValue).toBe("xhigh");
    expect(thinkingEntries.map((entry) => entry.name)).toEqual([
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });

  it("clamps persisted thinking level when model changes", async () => {
    const harness = createHarness({
      agentId: "exec",
      aiSettings: {
        model: "anthropic:claude-opus-4-6",
        thinkingLevel: "xhigh",
      },
      aiSettingsByAgent: {
        exec: {
          model: "anthropic:claude-opus-4-6",
          thinkingLevel: "xhigh",
        },
      },
    });

    const updated = await handleSetConfigOption(
      harness.client,
      "ws-1",
      "model",
      "openai:gpt-5-pro",
      { activeAgentId: "exec" }
    );

    expect(harness.updateModeCalls).toHaveLength(1);
    expect(harness.updateModeCalls[0]?.aiSettings).toEqual({
      model: "openai:gpt-5-pro",
      thinkingLevel: "high",
    });

    const thinkingOption = getSelectConfigOption(updated, "thinkingLevel");
    const thinkingEntries = flattenSelectOptions(thinkingOption);

    expect(thinkingOption.currentValue).toBe("high");
    expect(thinkingEntries.map((entry) => entry.value)).toEqual(["high"]);
    expect(harness.getWorkspaceState().aiSettingsByAgent.exec).toEqual({
      model: "openai:gpt-5-pro",
      thinkingLevel: "high",
    });
  });
});
