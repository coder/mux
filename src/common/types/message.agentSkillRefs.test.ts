import { describe, expect, test } from "bun:test";
import {
  buildAgentSkillMetadata,
  dedupeAgentSkillRefs,
  mergeAgentSkillRefs,
  withAgentSkillRefs,
} from "./message";
import type { AgentSkillReference, MuxMessageMetadata } from "./message";
import type { ReviewNoteData } from "./review";

function skillRef(
  skillName: string,
  source: AgentSkillReference["source"],
  scope: AgentSkillReference["scope"] = "project"
): AgentSkillReference {
  return { skillName, scope, source };
}

describe("agent skill refs metadata helpers", () => {
  test("dedupeAgentSkillRefs preserves first-appearance order", () => {
    expect(
      dedupeAgentSkillRefs([
        skillRef("tdd", "inline"),
        skillRef("react-effects", "inline", "built-in"),
        skillRef("tdd", "inline"),
        skillRef("tests", "slash", "project"),
      ])
    ).toEqual([
      skillRef("tdd", "inline"),
      skillRef("react-effects", "inline", "built-in"),
      skillRef("tests", "slash", "project"),
    ]);
  });

  test("dedupeAgentSkillRefs lets slash refs beat inline refs on name collisions", () => {
    expect(
      dedupeAgentSkillRefs([
        skillRef("tdd", "inline", "project"),
        skillRef("react-effects", "inline", "built-in"),
        skillRef("tdd", "slash", "global"),
      ])
    ).toEqual([
      skillRef("tdd", "slash", "global"),
      skillRef("react-effects", "inline", "built-in"),
    ]);
  });

  test("mergeAgentSkillRefs keeps existing refs first, appends new refs, then dedupes", () => {
    expect(
      mergeAgentSkillRefs(
        [skillRef("tdd", "inline"), skillRef("react-effects", "inline", "built-in")],
        [skillRef("tests", "slash"), skillRef("tdd", "inline"), skillRef("docs", "inline")]
      )
    ).toEqual([
      skillRef("tdd", "inline"),
      skillRef("react-effects", "inline", "built-in"),
      skillRef("tests", "slash"),
      skillRef("docs", "inline"),
    ]);
  });

  test("withAgentSkillRefs preserves existing metadata fields and discriminator", () => {
    const review: ReviewNoteData = {
      filePath: "src/example.ts",
      lineRange: "1-2",
      selectedCode: "const value = true;",
      userNote: "please review",
    };
    const metadata: MuxMessageMetadata = {
      type: "agent-skill",
      rawCommand: "/tdd write tests",
      commandPrefix: "/tdd",
      skillName: "tdd",
      scope: "project",
      reviews: [review],
      requestedModel: "anthropic/claude-sonnet-4-5",
      agentSkillRefs: [skillRef("tdd", "slash")],
    };

    const result = withAgentSkillRefs(metadata, [skillRef("react-effects", "inline", "built-in")]);

    if (!result || result.type !== "agent-skill") {
      throw new Error("Expected agent-skill metadata");
    }
    expect(result.type).toBe("agent-skill");
    expect(result.rawCommand).toBe("/tdd write tests");
    expect(result.commandPrefix).toBe("/tdd");
    expect(result.skillName).toBe("tdd");
    expect(result.scope).toBe("project");
    expect(result.reviews).toEqual([review]);
    expect(result.requestedModel).toBe("anthropic/claude-sonnet-4-5");
    expect(result.agentSkillRefs).toEqual([
      skillRef("tdd", "slash"),
      skillRef("react-effects", "inline", "built-in"),
    ]);
  });

  test("withAgentSkillRefs creates normal metadata for undefined metadata and non-empty refs", () => {
    expect(
      withAgentSkillRefs(undefined, [skillRef("tdd", "inline"), skillRef("tdd", "slash")])
    ).toEqual({
      type: "normal",
      agentSkillRefs: [skillRef("tdd", "slash")],
    });
  });

  test("withAgentSkillRefs returns undefined for undefined metadata and empty refs", () => {
    expect(withAgentSkillRefs(undefined, [])).toBeUndefined();
  });

  test("buildAgentSkillMetadata preserves legacy agent-skill fields and adds slash ref", () => {
    expect(
      buildAgentSkillMetadata({
        rawCommand: "/tdd write tests",
        commandPrefix: "/tdd",
        skillName: "tdd",
        scope: "project",
      })
    ).toEqual({
      type: "agent-skill",
      rawCommand: "/tdd write tests",
      commandPrefix: "/tdd",
      skillName: "tdd",
      scope: "project",
      agentSkillRefs: [skillRef("tdd", "slash")],
    });
  });
});
