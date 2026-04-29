import { describe, expect, test } from "bun:test";
import type { AgentSkillDescriptor } from "@/common/types/agentSkill";
import { getInlineSkillSuggestions } from "./inlineSkillSuggestions";

function descriptor(name: string, description = `${name} description`): AgentSkillDescriptor {
  return { name, description, scope: "global" };
}

describe("getInlineSkillSuggestions", () => {
  test("returns an empty list when no descriptors are loaded", () => {
    expect(getInlineSkillSuggestions({ partial: "", descriptors: [] })).toEqual([]);
  });

  test("returns all descriptors for an empty partial", () => {
    expect(
      getInlineSkillSuggestions({
        partial: "",
        descriptors: [descriptor("tdd"), descriptor("deep-review")],
      })
    ).toEqual([
      {
        id: "inline-skill:tdd",
        display: "$tdd",
        description: "tdd description",
        replacement: "$tdd",
      },
      {
        id: "inline-skill:deep-review",
        display: "$deep-review",
        description: "deep-review description",
        replacement: "$deep-review",
      },
    ]);
  });

  test("returns only descriptors whose names start with the partial", () => {
    expect(
      getInlineSkillSuggestions({
        partial: "tdd",
        descriptors: [descriptor("tdd"), descriptor("tdd-review"), descriptor("deep-review")],
      }).map((suggestion) => suggestion.display)
    ).toEqual(["$tdd", "$tdd-review"]);
  });

  test("matches uppercase partials against canonical lowercase names", () => {
    expect(
      getInlineSkillSuggestions({
        partial: "TDD",
        descriptors: [descriptor("tdd"), descriptor("deep-review")],
      }).map((suggestion) => suggestion.display)
    ).toEqual(["$tdd"]);
  });

  test("maps descriptor fields into the suggestion shape", () => {
    expect(
      getInlineSkillSuggestions({
        partial: "deep",
        descriptors: [descriptor("deep-review", "Deep review description")],
      })
    ).toEqual([
      {
        id: "inline-skill:deep-review",
        display: "$deep-review",
        description: "Deep review description",
        replacement: "$deep-review",
      },
    ]);
  });

  test("suggests skills that collide with slash command names", () => {
    expect(
      getInlineSkillSuggestions({
        partial: "clear",
        descriptors: [descriptor("clear"), descriptor("clear-cache")],
      }).map((suggestion) => suggestion.display)
    ).toEqual(["$clear", "$clear-cache"]);
  });

  test("preserves descriptor input order", () => {
    expect(
      getInlineSkillSuggestions({
        partial: "",
        descriptors: [descriptor("deep-review"), descriptor("tdd"), descriptor("clear")],
      }).map((suggestion) => suggestion.display)
    ).toEqual(["$deep-review", "$tdd", "$clear"]);
  });
});
