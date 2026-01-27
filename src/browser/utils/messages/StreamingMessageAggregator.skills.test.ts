import { describe, expect, it } from "bun:test";
import { StreamingMessageAggregator } from "./StreamingMessageAggregator";

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

  it("ignores failed agent_skill_read calls", () => {
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
