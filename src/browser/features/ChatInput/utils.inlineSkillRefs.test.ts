import { describe, expect, test } from "bun:test";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import {
  hasProjectScopedSkillRef,
  parseCommandWithSkillInvocation,
  resolveInlineSkillRefsForSend,
  resolveMcpPromptRefsForSend,
  type SkillInvocation,
} from "./utils";

function descriptor(
  name: string,
  scope: AgentSkillDescriptor["scope"] = "global"
): AgentSkillDescriptor {
  return { name, description: `${name} description`, scope };
}

function promptDescriptor() {
  return {
    commandKey: "mcp__coder__review",
    stableKey: "mcp__coder__review_11111111",
    serverName: "coder",
    promptName: "review",
    description: "Review code",
    arguments: [
      { name: "path", required: true },
      { name: "focus", required: false },
    ],
  };
}

function slashInvocation(skill: AgentSkillDescriptor): SkillInvocation {
  return {
    descriptor: skill,
    userText: `Using skill ${skill.name}: message`,
    argumentText: "message",
  };
}

describe("parseCommandWithSkillInvocation", () => {
  test("does not treat known-command goal text as slash skill invocation", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/goal --bogus\nBody",
      agentSkillDescriptors: [descriptor("goal")],
      api: null,
      discovery: null,
    });

    expect(result.skillInvocation).toBeNull();
    expect(result.parsed).toEqual({
      type: "goal-set",
      objective: "--bogus\nBody",
    });
  });

  test("treats user-invocable: false skills as nonexistent for typed /skill-name", async () => {
    const modelOnly = { ...descriptor("model-only"), userInvocable: false };

    const result = await parseCommandWithSkillInvocation({
      messageText: "/model-only do something",
      agentSkillDescriptors: [modelOnly],
      api: null,
      discovery: null,
    });

    expect(result.skillInvocation).toBeNull();
  });

  test("resolves user-invocable skills for typed /skill-name", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/tdd do something",
      agentSkillDescriptors: [descriptor("tdd")],
      api: null,
      discovery: null,
    });

    expect(result.skillInvocation?.descriptor.name).toBe("tdd");
  });

  test("maps quoted MCP prompt arguments positionally and lets the last consume the remainder", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: '/mcp__coder__review "src app" security and tests',
      agentSkillDescriptors: [],
      mcpPromptDescriptors: [promptDescriptor()],
      api: null,
      discovery: null,
    });

    expect(result.mcpPromptInvocation?.arguments).toEqual({
      path: "src app",
      focus: "security and tests",
    });
    expect(result.mcpPromptInvocation?.userText).toBe(
      'Using MCP prompt coder/review: "src app" security and tests'
    );
  });

  test("resolves a stale collision-suffixed key via the descriptor stableKey", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/mcp__coder__review_11111111 src",
      agentSkillDescriptors: [],
      mcpPromptDescriptors: [promptDescriptor()],
      api: null,
      discovery: null,
    });

    expect(result.mcpPromptInvocation?.descriptor.commandKey).toBe("mcp__coder__review");
    expect(result.mcpPromptInvocation?.arguments).toEqual({ path: "src" });
  });

  test("blocks an unsuffixed key orphaned by a new collision with the current keys", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/mcp__coder__review src",
      agentSkillDescriptors: [],
      mcpPromptDescriptors: [
        {
          ...promptDescriptor(),
          commandKey: "mcp__coder__review_11111111",
        },
        {
          ...promptDescriptor(),
          commandKey: "mcp__coder__review_22222222",
          stableKey: "mcp__coder__review_22222222",
          serverName: "Coder",
        },
      ],
      api: null,
      discovery: null,
    });

    expect(result.mcpPromptInvocation).toBeNull();
    expect(result.error).toBe(
      "'/mcp__coder__review' no longer matches an MCP prompt key; did you mean /mcp__coder__review_11111111 or /mcp__coder__review_22222222?"
    );
  });

  test("reports a missing required MCP prompt argument before send", async () => {
    const result = await parseCommandWithSkillInvocation({
      messageText: "/mcp__coder__review",
      agentSkillDescriptors: [],
      mcpPromptDescriptors: [promptDescriptor()],
      api: null,
      discovery: null,
    });

    expect(result.mcpPromptInvocation).toBeNull();
    expect(result.error).toBe("Missing required MCP prompt argument: path");
  });
});

describe("resolveInlineSkillRefsForSend", () => {
  test("returns an empty array for no slash and no inline refs", async () => {
    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "Please help",
        slashInvocation: null,
        agentSkillDescriptors: [descriptor("tdd")],
        api: null,
        discovery: null,
      })
    ).toEqual([]);
  });

  test("returns a single slash ref for slash-only invocation", async () => {
    const tdd = descriptor("tdd", "project");

    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "/tdd Please help",
        slashInvocation: slashInvocation(tdd),
        agentSkillDescriptors: [tdd],
        api: null,
        discovery: null,
      })
    ).toEqual([{ skillName: "tdd", scope: "project", source: "slash" }]);
  });

  test("returns inline refs in first-appearance order", async () => {
    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "Use $deep-review and then $tdd",
        slashInvocation: null,
        agentSkillDescriptors: [descriptor("tdd"), descriptor("deep-review", "project")],
        api: null,
        discovery: null,
      })
    ).toEqual([
      { skillName: "deep-review", scope: "project", source: "inline" },
      { skillName: "tdd", scope: "global", source: "inline" },
    ]);
  });

  test("drops inline refs to user-invocable: false skills", async () => {
    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "Use $model-only and $tdd",
        slashInvocation: null,
        agentSkillDescriptors: [
          { ...descriptor("model-only"), userInvocable: false },
          descriptor("tdd"),
        ],
        api: null,
        discovery: null,
      })
    ).toEqual([{ skillName: "tdd", scope: "global", source: "inline" }]);
  });

  test("collapses duplicate inline refs", async () => {
    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "Use $tdd and $tdd again",
        slashInvocation: null,
        agentSkillDescriptors: [descriptor("tdd")],
        api: null,
        discovery: null,
      })
    ).toEqual([{ skillName: "tdd", scope: "global", source: "inline" }]);
  });

  test("keeps slash first and appends inline refs for mixed messages", async () => {
    const deepReview = descriptor("deep-review", "project");

    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "/deep-review Please also follow $tdd",
        slashInvocation: slashInvocation(deepReview),
        agentSkillDescriptors: [deepReview, descriptor("tdd")],
        api: null,
        discovery: null,
      })
    ).toEqual([
      { skillName: "deep-review", scope: "project", source: "slash" },
      { skillName: "tdd", scope: "global", source: "inline" },
    ]);
  });

  test("keeps only the slash ref when inline repeats the slash skill", async () => {
    const tdd = descriptor("tdd", "project");

    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "/tdd Please also follow $tdd",
        slashInvocation: slashInvocation(tdd),
        agentSkillDescriptors: [tdd],
        api: null,
        discovery: null,
      })
    ).toEqual([{ skillName: "tdd", scope: "project", source: "slash" }]);
  });

  test("ignores currency-like dollar tokens", async () => {
    expect(
      await resolveInlineSkillRefsForSend({
        messageText: "This costs $100",
        slashInvocation: null,
        agentSkillDescriptors: [descriptor("tdd")],
        api: null,
        discovery: null,
      })
    ).toEqual([]);
  });
});

describe("resolveMcpPromptRefsForSend", () => {
  test("resolves inline no-required-argument prompts and drops required prompts", async () => {
    const noArgs = { ...promptDescriptor(), arguments: [] };
    const result = await resolveMcpPromptRefsForSend({
      messageText: "Use $mcp__coder__review and $mcp__coder__required",
      slashInvocation: null,
      descriptors: [
        noArgs,
        {
          ...promptDescriptor(),
          commandKey: "mcp__coder__required",
          stableKey: "mcp__coder__required_22222222",
          promptName: "required",
        },
      ],
      api: null,
      discovery: null,
    });

    expect(result.error).toBeUndefined();
    expect(result.refs).toEqual([
      {
        serverName: "coder",
        promptName: "review",
        commandKey: "mcp__coder__review",
        source: "inline",
      },
    ]);
  });

  test("blocks an inline unsuffixed key orphaned by a new collision", async () => {
    const result = await resolveMcpPromptRefsForSend({
      messageText: "Use $mcp__coder__review please",
      slashInvocation: null,
      descriptors: [
        { ...promptDescriptor(), arguments: [], commandKey: "mcp__coder__review_11111111" },
        {
          ...promptDescriptor(),
          arguments: [],
          commandKey: "mcp__coder__review_22222222",
          stableKey: "mcp__coder__review_22222222",
          serverName: "Coder",
        },
      ],
      api: null,
      discovery: null,
    });

    expect(result.refs).toEqual([]);
    expect(result.error).toBe(
      "'$mcp__coder__review' no longer matches an MCP prompt key; did you mean $mcp__coder__review_11111111 or $mcp__coder__review_22222222?"
    );
  });

  test("still drops orphaned inline keys whose base matches only required-argument prompts", async () => {
    const result = await resolveMcpPromptRefsForSend({
      messageText: "Use $mcp__coder__review please",
      slashInvocation: null,
      descriptors: [
        { ...promptDescriptor(), commandKey: "mcp__coder__review_11111111" },
        {
          ...promptDescriptor(),
          commandKey: "mcp__coder__review_22222222",
          stableKey: "mcp__coder__review_22222222",
          serverName: "Coder",
        },
      ],
      api: null,
      discovery: null,
    });

    expect(result.error).toBeUndefined();
    expect(result.refs).toEqual([]);
  });
});

describe("hasProjectScopedSkillRef", () => {
  test("returns true when any ref is project-scoped", () => {
    expect(
      hasProjectScopedSkillRef([
        { skillName: "tdd", scope: "global", source: "inline" },
        { skillName: "deep-review", scope: "project", source: "slash" },
      ])
    ).toBe(true);
  });

  test("returns false for empty refs", () => {
    expect(hasProjectScopedSkillRef([])).toBe(false);
  });
});
