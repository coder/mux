/* eslint-disable @typescript-eslint/no-unsafe-argument */
import { describe, it, expect } from "bun:test";
import { EXPERIMENT_IDS, type ExperimentId } from "@/common/constants/experiments";
import { getSlashCommandSuggestions } from "./suggestions";
import { resolveSlashCommandExperimentValue } from "./experimentVisibility";

describe("resolveSlashCommandExperimentValue", () => {
  it("requires the parent memory experiment for memory-consolidation", () => {
    // The backend rejects /dream unless BOTH flags are on, so the sub-flag
    // alone must not surface the command.
    expect(
      resolveSlashCommandExperimentValue(EXPERIMENT_IDS.MEMORY_CONSOLIDATION, {
        workspaceHeartbeats: false,
        memoryConsolidation: true,
      })
    ).toBe(false);
    expect(
      resolveSlashCommandExperimentValue(EXPERIMENT_IDS.MEMORY_CONSOLIDATION, {
        workspaceHeartbeats: false,
        memory: true,
        memoryConsolidation: true,
      })
    ).toBe(true);
  });
});

describe("getSlashCommandSuggestions", () => {
  it("returns empty suggestions for non-commands", () => {
    expect(getSlashCommandSuggestions("hello")).toEqual([]);
    expect(getSlashCommandSuggestions("")).toEqual([]);
  });

  it("filters workspace-only commands in creation mode", () => {
    const suggestions = getSlashCommandSuggestions("/", { variant: "creation" });
    const labels = suggestions.map((s) => s.display);

    expect(labels).not.toContain("/clear");
    expect(labels).not.toContain("/plan");
  });

  it("omits workspace-only subcommands in creation mode", () => {
    const suggestions = getSlashCommandSuggestions("/plan ", { variant: "creation" });
    expect(suggestions).toEqual([]);
  });
  it("hides experiment-gated commands when their experiments are disabled", () => {
    const suggestions = getSlashCommandSuggestions("/", {
      isExperimentEnabled: () => false,
    });
    const labels = suggestions.map((s) => s.display);

    expect(labels).not.toContain("/heartbeat");
    expect(labels).not.toContain("/dream");
    // `/goal` graduated to GA — it must surface regardless of experiment state.
    expect(labels).toContain("/goal");
  });

  it("shows experiment-gated commands when their experiments are enabled", () => {
    const enabledExperiments = new Set<ExperimentId>([
      EXPERIMENT_IDS.WORKSPACE_HEARTBEATS,
      EXPERIMENT_IDS.MEMORY_CONSOLIDATION,
    ]);
    const suggestions = getSlashCommandSuggestions("/", {
      isExperimentEnabled: (experimentId) => enabledExperiments.has(experimentId),
    });
    const labels = suggestions.map((s) => s.display);

    expect(labels).toContain("/heartbeat");
    expect(labels).toContain("/dream");
    // `/goal` is always available post-GA.
    expect(labels).toContain("/goal");
  });

  it("suggests top level commands when starting with slash", () => {
    const suggestions = getSlashCommandSuggestions("/");
    const labels = suggestions.map((s) => s.display);

    expect(labels).toContain("/clear");
    expect(labels).toContain("/model");
  });

  it("includes agent skills when provided in context", () => {
    const suggestions = getSlashCommandSuggestions("/", {
      agentSkills: [
        {
          name: "test-skill",
          description: "Test skill description",
          scope: "project",
        },
      ],
    });

    const skillSuggestion = suggestions.find((s) => s.display === "/test-skill");
    expect(skillSuggestion).toBeTruthy();
    expect(skillSuggestion?.replacement).toBe("/test-skill ");
    expect(skillSuggestion?.description).toContain("(project)");
  });

  it("matches hyphenated skill segments", () => {
    const suggestions = getSlashCommandSuggestions("/r", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Test",
          scope: "project",
        },
      ],
    });

    const labels = suggestions.map((s) => s.display);
    expect(labels).toContain("/deep-review");
  });

  it("matches full prefixes that cross hyphen boundaries", () => {
    const suggestions = getSlashCommandSuggestions("/deep-r", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Test",
          scope: "project",
        },
      ],
    });

    expect(suggestions.map((s) => s.display)).toContain("/deep-review");
  });

  it("includes workflows distinctly and hides ambiguous top-level workflow shortcuts", () => {
    const suggestions = getSlashCommandSuggestions("/deep", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Review deeply",
          scope: "project",
        },
      ],
      workflows: [
        {
          name: "deep-research",
          description: "Research deeply",
          scope: "built-in",
          executable: true,
        },
        {
          name: "deep-review",
          description: "Ambiguous workflow",
          scope: "project",
          executable: true,
        },
      ],
    });

    expect(suggestions).toContainEqual(
      expect.objectContaining({
        id: "workflow:deep-research",
        display: "/deep-research",
        kind: "workflow",
        replacement: "/deep-research ",
      })
    );
    expect(suggestions).not.toContainEqual(expect.objectContaining({ id: "workflow:deep-review" }));
    expect(suggestions).toContainEqual(expect.objectContaining({ id: "skill:deep-review" }));
  });

  it("hides top-level workflow shortcuts that collide with model aliases", () => {
    const workflow = {
      name: "haiku",
      description: "Alias collision workflow",
      scope: "global" as const,
      executable: true,
    };

    const suggestions = getSlashCommandSuggestions("/ha", { workflows: [workflow] });

    expect(suggestions).toContainEqual(expect.objectContaining({ id: "model-oneshot:haiku" }));
    expect(suggestions).not.toContainEqual(expect.objectContaining({ id: "workflow:haiku" }));

    const explicitSuggestions = getSlashCommandSuggestions("/workflow ha", {
      workflows: [workflow],
      isExperimentEnabled: (experimentId) => experimentId === EXPERIMENT_IDS.DYNAMIC_WORKFLOWS,
    });

    expect(explicitSuggestions).toContainEqual(
      expect.objectContaining({
        id: "workflow-explicit:haiku",
        display: "haiku",
        kind: "workflow",
        replacement: "/workflow haiku ",
      })
    );
  });

  it("suggests explicit workflow invocations for ambiguous workflow names", () => {
    const suggestions = getSlashCommandSuggestions("/workflow deep", {
      agentSkills: [
        {
          name: "deep-review",
          description: "Review deeply",
          scope: "project",
        },
      ],
      workflows: [
        {
          name: "deep-review",
          description: "Ambiguous workflow",
          scope: "project",
          executable: true,
        },
      ],
      isExperimentEnabled: (experimentId) => experimentId === EXPERIMENT_IDS.DYNAMIC_WORKFLOWS,
    });

    expect(suggestions).toEqual([
      expect.objectContaining({
        id: "workflow-explicit:deep-review",
        display: "deep-review",
        kind: "workflow",
        replacement: "/workflow deep-review ",
      }),
    ]);
  });

  it("suggests workflows while creating a new workspace", () => {
    const suggestions = getSlashCommandSuggestions("/workflow deep", {
      variant: "creation",
      workflows: [
        {
          name: "deep-research",
          description: "Research deeply",
          scope: "built-in",
          executable: true,
        },
      ],
      isExperimentEnabled: (experimentId) => experimentId === EXPERIMENT_IDS.DYNAMIC_WORKFLOWS,
    });

    expect(suggestions).toContainEqual(
      expect.objectContaining({
        id: "workflow-explicit:deep-research",
        display: "deep-research",
        kind: "workflow",
        replacement: "/workflow deep-research ",
      })
    );
  });

  it("filters top level commands by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/cl");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].replacement).toBe("/clear");
  });

  it("suggests model abbreviations after /model", () => {
    const suggestions = getSlashCommandSuggestions("/model ");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("opus");
    expect(displays).toContain("sonnet");
  });

  it("filters model suggestions by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/model op");
    // Only "opus" (opus-4-6) matches the "op" prefix
    expect(suggestions).toHaveLength(1);
    const displays = suggestions.map((s) => s.display);
    expect(displays).toContain("opus");
  });

  it("suggests model aliases as one-shot commands", () => {
    const suggestions = getSlashCommandSuggestions("/");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("/haiku");
    expect(displays).toContain("/sonnet");
    expect(displays).toContain("/opus");
  });

  it("filters model alias suggestions by partial input", () => {
    const suggestions = getSlashCommandSuggestions("/ha");
    const displays = suggestions.map((s) => s.display);

    expect(displays).toContain("/haiku");
    expect(displays).not.toContain("/sonnet");
  });

  it("includes usable metadata for model alias suggestions", () => {
    const suggestions = getSlashCommandSuggestions("/haiku");
    const haiku = suggestions.find((s) => s.display === "/haiku");

    expect(haiku).toBeTruthy();
    expect(haiku?.description).toBeTruthy();
    expect(haiku?.replacement).toBe("/haiku ");
  });
});
