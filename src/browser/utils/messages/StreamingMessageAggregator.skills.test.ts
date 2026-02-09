import { describe, expect, it } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";
import { createMuxMessage } from "@/common/types/message";

const TEST_CREATED_AT = "2024-01-01T00:00:00.000Z";
const WORKSPACE_ID = "test-workspace";

describe("Loaded skills tracking", () => {
  const createAggregator = () => {
    return new StreamingMessageAggregator(TEST_CREATED_AT);
  };

  it("returns empty array when no skills loaded", () => {
    const agg = createAggregator();
    expect(agg.getLoadedSkills()).toEqual([]);
  });

  it("tracks skills from successful agent_skill_read tool calls", () => {
    const agg = createAggregator();
    const messageId = "msg-1";
    const toolCallId = "tc-1";

    // Start a stream
    agg.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: Date.now(),
    });

    // Start a tool call
    agg.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId,
      toolName: "agent_skill_read",
      args: { name: "tests" },
      tokens: 10,
      timestamp: Date.now(),
    });

    // Complete the tool call with skill result
    agg.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId,
      toolName: "agent_skill_read",
      result: {
        success: true,
        skill: {
          scope: "project",
          directoryName: "tests",
          frontmatter: {
            name: "tests",
            description: "Testing doctrine and conventions",
          },
          body: "# Tests skill content",
        },
      },
      timestamp: Date.now(),
    });

    const skills = agg.getLoadedSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: "tests",
      description: "Testing doctrine and conventions",
      scope: "project",
    });
  });

  it("tracks skills from agentSkillSnapshot messages via handleMessage", () => {
    const agg = createAggregator();

    const snapshot = createMuxMessage(
      "snapshot-1",
      "user",
      '<agent-skill name="pull-requests" scope="project">\n# Content\n</agent-skill>',
      {
        timestamp: Date.now(),
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "pull-requests",
          scope: "project",
          sha256: "deadbeef",
        },
      }
    );

    agg.handleMessage({ ...snapshot, type: "message" });

    expect(agg.getLoadedSkills()).toEqual([
      {
        name: "pull-requests",
        description: "(loaded via /pull-requests)",
        scope: "project",
      },
    ]);
  });

  it("tracks skills from agentSkillSnapshot during loadHistoricalMessages replay", () => {
    const agg = createAggregator();

    const snapshot = createMuxMessage(
      "snapshot-1",
      "user",
      '<agent-skill name="pull-requests" scope="project">\n# Content\n</agent-skill>',
      {
        historySequence: 1,
        timestamp: Date.now(),
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "pull-requests",
          scope: "project",
          sha256: "deadbeef",
        },
      }
    );

    agg.loadHistoricalMessages([snapshot]);

    expect(agg.getLoadedSkills()).toEqual([
      {
        name: "pull-requests",
        description: "(loaded via /pull-requests)",
        scope: "project",
      },
    ]);
  });

  it("deduplicates skills by name", () => {
    const agg = createAggregator();
    const messageId = "msg-1";

    agg.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: Date.now(),
    });

    // Load same skill twice
    for (let i = 0; i < 2; i++) {
      agg.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: WORKSPACE_ID,
        messageId,
        toolCallId: `tc-${i}`,
        toolName: "agent_skill_read",
        args: { name: "tests" },
        tokens: 10,
        timestamp: Date.now(),
      });

      agg.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: WORKSPACE_ID,
        messageId,
        toolCallId: `tc-${i}`,
        toolName: "agent_skill_read",
        result: {
          success: true,
          skill: {
            scope: "project",
            directoryName: "tests",
            frontmatter: {
              name: "tests",
              description: "Testing doctrine",
            },
            body: "# Content",
          },
        },
        timestamp: Date.now(),
      });
    }

    expect(agg.getLoadedSkills()).toHaveLength(1);
  });

  it("tracks multiple different skills", () => {
    const agg = createAggregator();
    const messageId = "msg-1";

    agg.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: Date.now(),
    });

    const skillDefs = [
      { name: "tests", description: "Testing skill", scope: "project" as const },
      { name: "pull-requests", description: "PR guidelines", scope: "project" as const },
      { name: "mux-docs", description: "Documentation", scope: "built-in" as const },
    ];

    for (const [i, skill] of skillDefs.entries()) {
      agg.handleToolCallStart({
        type: "tool-call-start",
        workspaceId: WORKSPACE_ID,
        messageId,
        toolCallId: `tc-${i}`,
        toolName: "agent_skill_read",
        args: { name: skill.name },
        tokens: 10,
        timestamp: Date.now(),
      });

      agg.handleToolCallEnd({
        type: "tool-call-end",
        workspaceId: WORKSPACE_ID,
        messageId,
        toolCallId: `tc-${i}`,
        toolName: "agent_skill_read",
        result: {
          success: true,
          skill: {
            scope: skill.scope,
            directoryName: skill.name,
            frontmatter: {
              name: skill.name,
              description: skill.description,
            },
            body: "# Content",
          },
        },
        timestamp: Date.now(),
      });
    }

    const skills = agg.getLoadedSkills();
    expect(skills).toHaveLength(3);
    expect(skills.map((s) => s.name).sort()).toEqual(["mux-docs", "pull-requests", "tests"]);
  });

  it("ignores failed agent_skill_read calls for loadedSkills", () => {
    const agg = createAggregator();
    const messageId = "msg-1";

    agg.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: Date.now(),
    });

    agg.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId: "tc-1",
      toolName: "agent_skill_read",
      args: { name: "nonexistent" },
      tokens: 10,
      timestamp: Date.now(),
    });

    agg.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId: "tc-1",
      toolName: "agent_skill_read",
      result: {
        success: false,
        error: "Skill not found",
      },
      timestamp: Date.now(),
    });

    expect(agg.getLoadedSkills()).toEqual([]);
  });

  it("returns stable array reference for memoization", () => {
    const agg = createAggregator();
    const messageId = "msg-1";

    agg.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: Date.now(),
    });

    // Load a skill
    agg.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId: "tc-1",
      toolName: "agent_skill_read",
      args: { name: "tests" },
      tokens: 10,
      timestamp: Date.now(),
    });

    agg.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId: "tc-1",
      toolName: "agent_skill_read",
      result: {
        success: true,
        skill: {
          scope: "project",
          directoryName: "tests",
          frontmatter: { name: "tests", description: "Testing" },
          body: "# Content",
        },
      },
      timestamp: Date.now(),
    });

    // Multiple calls should return same reference
    const ref1 = agg.getLoadedSkills();
    const ref2 = agg.getLoadedSkills();
    expect(ref1).toBe(ref2); // Same reference, not just equal
  });

  it("clears skills on loadHistoricalMessages replay", () => {
    const agg = createAggregator();
    const messageId = "msg-1";

    // Load a skill first
    agg.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: Date.now(),
    });

    agg.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId: "tc-1",
      toolName: "agent_skill_read",
      args: { name: "tests" },
      tokens: 10,
      timestamp: Date.now(),
    });

    agg.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId: "tc-1",
      toolName: "agent_skill_read",
      result: {
        success: true,
        skill: {
          scope: "project",
          directoryName: "tests",
          frontmatter: { name: "tests", description: "Testing" },
          body: "# Content",
        },
      },
      timestamp: Date.now(),
    });

    expect(agg.getLoadedSkills()).toHaveLength(1);

    // Replay with empty history should clear skills
    agg.loadHistoricalMessages([]);
    expect(agg.getLoadedSkills()).toEqual([]);
  });
});

describe("Skill load error tracking", () => {
  const createAggregator = () => {
    return new StreamingMessageAggregator(TEST_CREATED_AT);
  };

  /** Helper to emit a failed agent_skill_read tool call */
  const emitFailedSkillRead = (
    agg: StreamingMessageAggregator,
    messageId: string,
    toolCallId: string,
    skillName: string,
    error: string
  ) => {
    agg.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId,
      toolName: "agent_skill_read",
      args: { name: skillName },
      tokens: 10,
      timestamp: Date.now(),
    });
    agg.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId,
      toolName: "agent_skill_read",
      result: { success: false, error },
      timestamp: Date.now(),
    });
  };

  /** Helper to emit a successful agent_skill_read tool call */
  const emitSuccessfulSkillRead = (
    agg: StreamingMessageAggregator,
    messageId: string,
    toolCallId: string,
    skillName: string
  ) => {
    agg.handleToolCallStart({
      type: "tool-call-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId,
      toolName: "agent_skill_read",
      args: { name: skillName },
      tokens: 10,
      timestamp: Date.now(),
    });
    agg.handleToolCallEnd({
      type: "tool-call-end",
      workspaceId: WORKSPACE_ID,
      messageId,
      toolCallId,
      toolName: "agent_skill_read",
      result: {
        success: true,
        skill: {
          scope: "project",
          directoryName: skillName,
          frontmatter: { name: skillName, description: "A skill" },
          body: "# Content",
        },
      },
      timestamp: Date.now(),
    });
  };

  const startStream = (agg: StreamingMessageAggregator, messageId: string) => {
    agg.handleStreamStart({
      type: "stream-start",
      workspaceId: WORKSPACE_ID,
      messageId,
      historySequence: 1,
      model: "test-model",
      startTime: Date.now(),
    });
  };

  it("returns empty array when no errors", () => {
    const agg = createAggregator();
    expect(agg.getSkillLoadErrors()).toEqual([]);
  });

  it("tracks failed agent_skill_read calls", () => {
    const agg = createAggregator();
    startStream(agg, "msg-1");
    emitFailedSkillRead(agg, "msg-1", "tc-1", "nonexistent", "Agent skill not found: nonexistent");

    expect(agg.getSkillLoadErrors()).toEqual([
      { name: "nonexistent", error: "Agent skill not found: nonexistent" },
    ]);
  });

  it("deduplicates errors by skill name", () => {
    const agg = createAggregator();
    startStream(agg, "msg-1");
    emitFailedSkillRead(agg, "msg-1", "tc-1", "broken", "Parse error");
    emitFailedSkillRead(agg, "msg-1", "tc-2", "broken", "Parse error");

    expect(agg.getSkillLoadErrors()).toHaveLength(1);
  });

  it("updates error message on subsequent failure", () => {
    const agg = createAggregator();
    startStream(agg, "msg-1");
    emitFailedSkillRead(agg, "msg-1", "tc-1", "broken", "First error");
    emitFailedSkillRead(agg, "msg-1", "tc-2", "broken", "Second error");

    expect(agg.getSkillLoadErrors()).toEqual([{ name: "broken", error: "Second error" }]);
  });

  it("clears error when skill later loads successfully", () => {
    const agg = createAggregator();
    startStream(agg, "msg-1");
    emitFailedSkillRead(agg, "msg-1", "tc-1", "flaky", "Temporary failure");

    expect(agg.getSkillLoadErrors()).toHaveLength(1);

    emitSuccessfulSkillRead(agg, "msg-1", "tc-2", "flaky");

    expect(agg.getSkillLoadErrors()).toEqual([]);
    expect(agg.getLoadedSkills()).toHaveLength(1);
  });

  it("replaces loaded skill with error on later failure", () => {
    const agg = createAggregator();
    startStream(agg, "msg-1");
    emitSuccessfulSkillRead(agg, "msg-1", "tc-1", "flaky-skill");

    expect(agg.getLoadedSkills()).toHaveLength(1);
    expect(agg.getSkillLoadErrors()).toEqual([]);

    // Skill was edited/deleted and the agent retries — now it fails
    emitFailedSkillRead(agg, "msg-1", "tc-2", "flaky-skill", "SKILL.md is missing");

    // Error replaces the loaded state so the UI reflects current reality
    expect(agg.getSkillLoadErrors()).toEqual([
      { name: "flaky-skill", error: "SKILL.md is missing" },
    ]);
    expect(agg.getLoadedSkills()).toEqual([]);
  });

  it("clears errors on loadHistoricalMessages replay", () => {
    const agg = createAggregator();
    startStream(agg, "msg-1");
    emitFailedSkillRead(agg, "msg-1", "tc-1", "broken", "Error");

    expect(agg.getSkillLoadErrors()).toHaveLength(1);

    agg.loadHistoricalMessages([]);
    expect(agg.getSkillLoadErrors()).toEqual([]);
  });

  it("returns stable array reference for memoization", () => {
    const agg = createAggregator();
    startStream(agg, "msg-1");
    emitFailedSkillRead(agg, "msg-1", "tc-1", "broken", "Error");

    const ref1 = agg.getSkillLoadErrors();
    const ref2 = agg.getSkillLoadErrors();
    expect(ref1).toBe(ref2);
  });

  it("tracks errors from historical tool calls", () => {
    const agg = createAggregator();

    // Simulate loading a historical message with a failed agent_skill_read tool part
    agg.loadHistoricalMessages([
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

    expect(agg.getSkillLoadErrors()).toEqual([
      { name: "missing-skill", error: "Agent skill not found: missing-skill" },
    ]);
  });
});

describe("Agent skill snapshot association", () => {
  const createAggregator = () => {
    return new StreamingMessageAggregator(TEST_CREATED_AT);
  };

  it("attaches agentSkillSnapshot content to the subsequent invocation message", () => {
    const agg = createAggregator();

    const snapshot = createMuxMessage(
      "snapshot-1",
      "user",
      '<agent-skill name="pull-requests" scope="project">\n# Content\n</agent-skill>',
      {
        historySequence: 1,
        timestamp: Date.now(),
        synthetic: true,
        agentSkillSnapshot: {
          skillName: "pull-requests",
          scope: "project",
          sha256: "deadbeef",
          frontmatterYaml: "name: pull-requests\ndescription: PR guidelines",
        },
      }
    );

    const invocation = createMuxMessage("invoke-1", "user", "/pull-requests", {
      historySequence: 2,
      timestamp: Date.now(),
      muxMetadata: {
        type: "agent-skill",
        rawCommand: "/pull-requests",
        commandPrefix: "/pull-requests",
        skillName: "pull-requests",
        scope: "project",
      },
    });

    agg.loadHistoricalMessages([snapshot, invocation]);

    const displayed = agg.getDisplayedMessages();
    expect(displayed).toHaveLength(1);

    const msg = displayed[0];
    expect(msg.type).toBe("user");
    if (msg.type !== "user") {
      throw new Error("Expected displayed user message");
    }

    expect(msg.agentSkill).toEqual({
      skillName: "pull-requests",
      scope: "project",
      snapshot: {
        frontmatterYaml: "name: pull-requests\ndescription: PR guidelines",
        body: "# Content",
      },
    });
  });
});
