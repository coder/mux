/* eslint-disable @typescript-eslint/await-thenable */
import { describe, expect, test } from "bun:test";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import {
  hasProjectScopedSkillRef,
  parseCommandWithSkillInvocation,
  resolveInlineSkillRefsForSend,
  type SkillInvocation,
} from "./utils";

function descriptor(
  name: string,
  scope: AgentSkillDescriptor["scope"] = "global"
): AgentSkillDescriptor {
  return { name, description: `${name} description`, scope };
}

function slashInvocation(skill: AgentSkillDescriptor): SkillInvocation {
  return {
    descriptor: skill,
    userText: `Using skill ${skill.name}: message`,
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
});

describe("parseCommandWithSkillInvocation workflows", () => {
  test("resolves an unambiguous unknown slash command as a workflow run", async () => {
    await expect(
      parseCommandWithSkillInvocation({
        messageText: "/deep-research topic: mux",
        agentSkillDescriptors: [],
        workflowDefinitions: [
          {
            name: "deep-research",
            description: "Research deeply",
            scope: "built-in",
            executable: true,
          },
        ],
        api: null,
        discovery: null,
      })
    ).resolves.toEqual({
      parsed: { type: "workflow-run", name: "deep-research", argsText: "topic: mux" },
      skillInvocation: null,
    });
  });

  test("requires explicit workflow invocation when a skill and workflow share a name", async () => {
    await expect(
      parseCommandWithSkillInvocation({
        messageText: "/deep-review topic: mux",
        agentSkillDescriptors: [
          {
            name: "deep-review",
            description: "Review deeply",
            scope: "project",
          },
        ],
        workflowDefinitions: [
          {
            name: "deep-review",
            description: "Ambiguous workflow",
            scope: "project",
            executable: true,
          },
        ],
        api: null,
        discovery: null,
      })
    ).resolves.toEqual({
      parsed: {
        type: "command-invalid-args",
        command: "deep-review",
        input: "deep-review",
        usage: "Skill and workflow names collide. Use /workflow deep-review to run the workflow.",
      },
      skillInvocation: null,
    });
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
