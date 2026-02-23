import type { ORPCClient } from "../../src/node/acp/serverConnection";
import { resolveAgentAiSettings } from "../../src/node/acp/resolveAgentAiSettings";

function createClient(overrides: {
  agentAiDefaults: Record<
    string,
    { modelString?: string; thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max" }
  >;
  agents: Array<{
    id: string;
    base?: string;
    aiDefaults?: {
      model?: string;
      thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
    };
  }>;
}): ORPCClient {
  return {
    config: {
      getConfig: async () => ({
        agentAiDefaults: overrides.agentAiDefaults,
      }),
    },
    agents: {
      list: async () => overrides.agents,
    },
  } as unknown as ORPCClient;
}

describe("resolveAgentAiSettings", () => {
  it("inherits missing thinking level from base config defaults when direct override is partial", async () => {
    const client = createClient({
      agentAiDefaults: {
        exec: {
          modelString: "anthropic:claude-opus-4-6",
          thinkingLevel: "high",
        },
        ask: {
          modelString: "openai:gpt-5",
        },
      },
      agents: [
        {
          id: "ask",
          base: "exec",
          aiDefaults: {
            model: "google:gemini-2.5-pro",
            thinkingLevel: "off",
          },
        },
        {
          id: "exec",
          aiDefaults: {
            model: "anthropic:claude-sonnet-4-5",
            thinkingLevel: "medium",
          },
        },
      ],
    });

    const resolved = await resolveAgentAiSettings(client, "ask", "ws-1");

    expect(resolved).toEqual({
      model: "openai:gpt-5",
      thinkingLevel: "high",
    });
  });

  it("inherits missing model from base config defaults when direct override only sets thinking", async () => {
    const client = createClient({
      agentAiDefaults: {
        exec: {
          modelString: "anthropic:claude-opus-4-6",
          thinkingLevel: "high",
        },
        ask: {
          thinkingLevel: "low",
        },
      },
      agents: [
        {
          id: "ask",
          base: "exec",
          aiDefaults: {
            model: "google:gemini-2.5-pro",
            thinkingLevel: "off",
          },
        },
        {
          id: "exec",
          aiDefaults: {
            model: "anthropic:claude-sonnet-4-5",
            thinkingLevel: "medium",
          },
        },
      ],
    });

    const resolved = await resolveAgentAiSettings(client, "ask", "ws-1");

    expect(resolved).toEqual({
      model: "anthropic:claude-opus-4-6",
      thinkingLevel: "low",
    });
  });

  it("traverses multiple base levels to fill missing inherited fields", async () => {
    const client = createClient({
      agentAiDefaults: {
        ask: {
          modelString: "openai:gpt-5",
        },
        exec: {
          thinkingLevel: "high",
        },
      },
      agents: [
        {
          id: "review",
          base: "ask",
          aiDefaults: {
            model: "google:gemini-2.5-pro",
            thinkingLevel: "off",
          },
        },
        {
          id: "ask",
          base: "exec",
          aiDefaults: {
            model: "anthropic:claude-sonnet-4-5",
            thinkingLevel: "medium",
          },
        },
        {
          id: "exec",
          aiDefaults: {
            model: "anthropic:claude-opus-4-6",
            thinkingLevel: "low",
          },
        },
      ],
    });

    const resolved = await resolveAgentAiSettings(client, "review", "ws-1");

    expect(resolved).toEqual({
      model: "openai:gpt-5",
      thinkingLevel: "high",
    });
  });
});
