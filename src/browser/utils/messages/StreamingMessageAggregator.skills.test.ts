import { describe, expect, it } from "bun:test";
import type { AgentSkillScope } from "@/common/types/agentSkill";
import { createMuxMessage } from "@/common/types/message";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";
const WORKSPACE_ID = "test-workspace";

const createAggregator = () => new StreamingMessageAggregator(TEST_CREATED_AT);

const startStream = (aggregator: StreamingMessageAggregator, messageId = "msg-1") => {
  aggregator.handleStreamStart({
    type: "stream-start",
    workspaceId: WORKSPACE_ID,
    messageId,
    historySequence: 1,
    model: "test-model",
    startTime: 0,
  });
};

const emitSkillReadResult = (
  aggregator: StreamingMessageAggregator,
  {
    messageId = "msg-1",
    toolCallId,
    skillName,
    result,
  }: {
    messageId?: string;
    toolCallId: string;
    skillName: string;
    result: unknown;
  }
) => {
  aggregator.handleToolCallStart({
    type: "tool-call-start",
    workspaceId: WORKSPACE_ID,
    messageId,
    toolCallId,
    toolName: "agent_skill_read",
    args: { name: skillName },
    tokens: 10,
    timestamp: 0,
  });
  aggregator.handleToolCallEnd({
    type: "tool-call-end",
    workspaceId: WORKSPACE_ID,
    messageId,
    toolCallId,
    toolName: "agent_skill_read",
    result,
    timestamp: 0,
  });
};

const emitSuccessfulSkillRead = (
  aggregator: StreamingMessageAggregator,
  {
    messageId,
    toolCallId,
    skillName,
    description = "A skill",
    scope = "project",
  }: {
    messageId?: string;
    toolCallId: string;
    skillName: string;
    description?: string;
    scope?: AgentSkillScope;
  }
) => {
  emitSkillReadResult(aggregator, {
    messageId,
    toolCallId,
    skillName,
    result: {
      success: true,
      skill: {
        scope,
        directoryName: skillName,
        frontmatter: {
          name: skillName,
          description,
        },
        body: "# Content",
      },
    },
  });
};

const emitFailedSkillRead = (
  aggregator: StreamingMessageAggregator,
  {
    messageId,
    toolCallId,
    skillName,
    error,
  }: {
    messageId?: string;
    toolCallId: string;
    skillName: string;
    error: string;
  }
) => {
  emitSkillReadResult(aggregator, {
    messageId,
    toolCallId,
    skillName,
    result: { success: false, error },
  });
};

const createSkillSnapshotMessage = ({
  id = "snapshot-1",
  skillName = "pull-requests",
  scope = "project",
  historySequence,
  body = "# Content",
  frontmatterYaml,
}: {
  id?: string;
  skillName?: string;
  scope?: AgentSkillScope;
  historySequence?: number;
  body?: string;
  frontmatterYaml?: string;
}) =>
  createMuxMessage(
    id,
    "user",
    `<agent-skill name="${skillName}" scope="${scope}">\n${body}\n</agent-skill>`,
    {
      ...(historySequence !== undefined ? { historySequence } : {}),
      timestamp: 0,
      synthetic: true,
      agentSkillSnapshot: {
        skillName,
        scope,
        sha256: "deadbeef",
        ...(frontmatterYaml !== undefined ? { frontmatterYaml } : {}),
      },
    }
  );

const createSkillInvocationMessage = ({
  id = "invoke-1",
  skillName = "pull-requests",
  scope = "project",
  historySequence,
}: {
  id?: string;
  skillName?: string;
  scope?: AgentSkillScope;
  historySequence: number;
}) => {
  const command = `/${skillName}`;
  return createMuxMessage(id, "user", command, {
    historySequence,
    timestamp: 0,
    muxMetadata: {
      type: "agent-skill",
      rawCommand: command,
      commandPrefix: command,
      skillName,
      scope,
    },
  });
};

describe("Loaded skills tracking", () => {
  it("returns empty array when no skills loaded", () => {
    const aggregator = createAggregator();
    expect(aggregator.getLoadedSkills()).toEqual([]);
  });

  it("tracks skills from successful agent_skill_read tool calls", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "tests",
      description: "Testing doctrine and conventions",
    });

    expect(aggregator.getLoadedSkills()).toEqual([
      {
        name: "tests",
        description: "Testing doctrine and conventions",
        scope: "project",
      },
    ]);
  });

  it("tracks skills from agentSkillSnapshot messages via handleMessage", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({ skillName: "pull-requests" });

    aggregator.handleMessage({ ...snapshot, type: "message" });

    expect(aggregator.getLoadedSkills()).toEqual([
      {
        name: "pull-requests",
        description: "(loaded via /pull-requests)",
        scope: "project",
      },
    ]);
  });

  it("tracks skills from agentSkillSnapshot during loadHistoricalMessages replay", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({ skillName: "pull-requests", historySequence: 1 });

    aggregator.loadHistoricalMessages([snapshot]);

    expect(aggregator.getLoadedSkills()).toEqual([
      {
        name: "pull-requests",
        description: "(loaded via /pull-requests)",
        scope: "project",
      },
    ]);
  });

  it("deduplicates skills by name", () => {
    const aggregator = createAggregator();
    startStream(aggregator);

    for (let index = 0; index < 2; index++) {
      emitSuccessfulSkillRead(aggregator, {
        toolCallId: `tc-${index}`,
        skillName: "tests",
        description: "Testing doctrine",
      });
    }

    expect(aggregator.getLoadedSkills()).toHaveLength(1);
  });

  it("tracks multiple different skills", () => {
    const aggregator = createAggregator();
    startStream(aggregator);

    const skillDefs = [
      { name: "tests", description: "Testing skill", scope: "project" as const },
      { name: "pull-requests", description: "PR guidelines", scope: "project" as const },
      { name: "mux-docs", description: "Documentation", scope: "built-in" as const },
    ];

    for (const [index, skill] of skillDefs.entries()) {
      emitSuccessfulSkillRead(aggregator, {
        toolCallId: `tc-${index}`,
        skillName: skill.name,
        description: skill.description,
        scope: skill.scope,
      });
    }

    const skills = aggregator.getLoadedSkills();
    expect(skills).toHaveLength(3);
    expect(skills.map((skill) => skill.name).sort()).toEqual([
      "mux-docs",
      "pull-requests",
      "tests",
    ]);
  });

  it("ignores failed agent_skill_read calls for loadedSkills", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "nonexistent",
      error: "Skill not found",
    });

    expect(aggregator.getLoadedSkills()).toEqual([]);
  });

  it("returns stable array reference for memoization", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "tests",
      description: "Testing",
    });

    const ref1 = aggregator.getLoadedSkills();
    const ref2 = aggregator.getLoadedSkills();
    expect(ref1).toBe(ref2);
  });

  it("clears skills on loadHistoricalMessages replay", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "tests",
      description: "Testing",
    });

    expect(aggregator.getLoadedSkills()).toHaveLength(1);

    aggregator.loadHistoricalMessages([]);
    expect(aggregator.getLoadedSkills()).toEqual([]);
  });
});

describe("Skill load error tracking", () => {
  it("returns empty array when no errors", () => {
    const aggregator = createAggregator();
    expect(aggregator.getSkillLoadErrors()).toEqual([]);
  });

  it("tracks failed agent_skill_read calls", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "nonexistent",
      error: "Agent skill not found: nonexistent",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([
      { name: "nonexistent", error: "Agent skill not found: nonexistent" },
    ]);
  });

  it("deduplicates errors by skill name", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "Parse error",
    });
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "broken",
      error: "Parse error",
    });

    expect(aggregator.getSkillLoadErrors()).toHaveLength(1);
  });

  it("updates error message on subsequent failure", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "First error",
    });
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "broken",
      error: "Second error",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([{ name: "broken", error: "Second error" }]);
  });

  it("clears error when skill later loads successfully", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "flaky",
      error: "Temporary failure",
    });

    expect(aggregator.getSkillLoadErrors()).toHaveLength(1);

    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "flaky",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([]);
    expect(aggregator.getLoadedSkills()).toHaveLength(1);
  });

  it("replaces loaded skill with error on later failure", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitSuccessfulSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "flaky-skill",
    });

    expect(aggregator.getLoadedSkills()).toHaveLength(1);
    expect(aggregator.getSkillLoadErrors()).toEqual([]);

    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-2",
      skillName: "flaky-skill",
      error: "SKILL.md is missing",
    });

    expect(aggregator.getSkillLoadErrors()).toEqual([
      { name: "flaky-skill", error: "SKILL.md is missing" },
    ]);
    expect(aggregator.getLoadedSkills()).toEqual([]);
  });

  it("clears errors on loadHistoricalMessages replay", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "Error",
    });

    expect(aggregator.getSkillLoadErrors()).toHaveLength(1);

    aggregator.loadHistoricalMessages([]);
    expect(aggregator.getSkillLoadErrors()).toEqual([]);
  });

  it("returns stable array reference for memoization", () => {
    const aggregator = createAggregator();
    startStream(aggregator);
    emitFailedSkillRead(aggregator, {
      toolCallId: "tc-1",
      skillName: "broken",
      error: "Error",
    });

    const ref1 = aggregator.getSkillLoadErrors();
    const ref2 = aggregator.getSkillLoadErrors();
    expect(ref1).toBe(ref2);
  });

  it("tracks errors from historical tool calls", () => {
    const aggregator = createAggregator();

    aggregator.loadHistoricalMessages([
      createMuxMessage("msg-1", "assistant", "", undefined, [
        {
          type: "dynamic-tool",
          toolCallId: "tc-1",
          toolName: "agent_skill_read",
          input: { name: "missing-skill" },
          state: "output-available",
          output: { success: false, error: "Agent skill not found: missing-skill" },
        },
      ]),
    ]);

    expect(aggregator.getSkillLoadErrors()).toEqual([
      { name: "missing-skill", error: "Agent skill not found: missing-skill" },
    ]);
  });
});

describe("Agent skill snapshot association", () => {
  it("attaches agentSkillSnapshot content to the subsequent invocation message", () => {
    const aggregator = createAggregator();
    const snapshot = createSkillSnapshotMessage({
      historySequence: 1,
      frontmatterYaml: "name: pull-requests\ndescription: PR guidelines",
    });
    const invocation = createSkillInvocationMessage({ historySequence: 2 });

    aggregator.loadHistoricalMessages([snapshot, invocation]);

    const displayed = aggregator.getDisplayedMessages();
    expect(displayed).toHaveLength(1);

    const message = displayed[0];
    if (message?.type !== "user") {
      throw new Error("Expected displayed user message");
    }

    expect(message.agentSkill).toEqual({
      skillName: "pull-requests",
      scope: "project",
      snapshot: {
        frontmatterYaml: "name: pull-requests\ndescription: PR guidelines",
        body: "# Content",
      },
    });
  });

  it("uses the latest snapshot available at each invocation turn", () => {
    const aggregator = createAggregator();
    const firstFrontmatter = "name: pull-requests\ndescription: First";
    const secondFrontmatter = "name: pull-requests\ndescription: Second";
    const firstSnapshot = createSkillSnapshotMessage({
      id: "snapshot-1",
      historySequence: 1,
      body: "# First",
      frontmatterYaml: firstFrontmatter,
    });
    const firstInvocation = createSkillInvocationMessage({
      id: "invoke-1",
      historySequence: 2,
    });
    const secondSnapshot = createSkillSnapshotMessage({
      id: "snapshot-2",
      historySequence: 3,
      body: "# Second",
      frontmatterYaml: secondFrontmatter,
    });
    const secondInvocation = createSkillInvocationMessage({
      id: "invoke-2",
      historySequence: 4,
    });

    aggregator.loadHistoricalMessages([
      firstSnapshot,
      firstInvocation,
      secondSnapshot,
      secondInvocation,
    ]);

    const displayed = aggregator.getDisplayedMessages();
    expect(displayed).toHaveLength(2);

    const [firstMessage, secondMessage] = displayed;
    if (firstMessage?.type !== "user" || secondMessage?.type !== "user") {
      throw new Error("Expected displayed user messages");
    }

    expect(firstMessage.agentSkill?.snapshot).toEqual({
      frontmatterYaml: firstFrontmatter,
      body: "# First",
    });
    expect(secondMessage.agentSkill?.snapshot).toEqual({
      frontmatterYaml: secondFrontmatter,
      body: "# Second",
    });
  });
});
