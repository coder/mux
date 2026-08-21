import { describe, expect, it } from "bun:test";

import type { ResolveAgentAiSettingsInput } from "@/common/types/agentAiSettings";
import { collectDeclaredAncestorLayers } from "./agentAncestorLayers";
import { InvalidExplicitAiSettingError, resolveAgentAiSettings } from "./resolveAgentAiSettings";

// Unrecognized providers fall through to the shared default thinking policy
// (["off","low","medium","high"], floor "off"), so precedence assertions are
// not perturbed by capability clamping.
const MODEL_A = "custom:model-a";
const MODEL_B = "custom:model-b";
const MODEL_C = "custom:model-c";
const PRO_MODEL = "openai:gpt-5.6";

function base(overrides: Partial<ResolveAgentAiSettingsInput>): ResolveAgentAiSettingsInput {
  return {
    targetAgentId: "worker",
    profile: "interactive",
    ...overrides,
  };
}

describe("resolveAgentAiSettings precedence", () => {
  it("explicit values win independently per field", () => {
    const result = resolveAgentAiSettings(
      base({
        explicit: { model: MODEL_A },
        targetWorkspaceSettings: { model: MODEL_B, thinkingLevel: "high", reasoningMode: "pro" },
      })
    );
    expect(result.selected.model).toBe(MODEL_A);
    expect(result.sources.model.tier).toBe("explicit");
    // Only model was explicit: thinking and reasoning still come from the workspace tier.
    expect(result.selected.thinkingLevel).toBe("high");
    expect(result.sources.thinkingLevel.tier).toBe("workspace");
    expect(result.selected.reasoningMode).toBe("pro");
  });

  it("resolves explicit model aliases", () => {
    const result = resolveAgentAiSettings(base({ explicit: { model: "sonnet" } }));
    expect(result.selected.model).toMatch(/^anthropic:claude-sonnet/);
  });

  it("target workspace values beat configured defaults", () => {
    const result = resolveAgentAiSettings(
      base({
        targetWorkspaceSettings: { model: MODEL_A, thinkingLevel: "low" },
        agentAiDefaults: { worker: { modelString: MODEL_B, thinkingLevel: "high" } },
      })
    );
    expect(result.selected.model).toBe(MODEL_A);
    expect(result.selected.thinkingLevel).toBe("low");
    expect(result.sources.model).toEqual({ tier: "workspace", agentId: "worker" });
  });

  it("delegated override beats the base profile only in delegated context", () => {
    const defaults = {
      worker: {
        modelString: MODEL_A,
        thinkingLevel: "low" as const,
        subagent: { modelString: MODEL_B, thinkingLevel: "high" as const },
      },
    };

    const delegated = resolveAgentAiSettings(
      base({ profile: "subagent", agentAiDefaults: defaults })
    );
    expect(delegated.selected.model).toBe(MODEL_B);
    expect(delegated.selected.thinkingLevel).toBe("high");
    expect(delegated.sources.model).toEqual({ tier: "config-subagent", agentId: "worker" });

    const interactive = resolveAgentAiSettings(
      base({ profile: "interactive", agentAiDefaults: defaults })
    );
    expect(interactive.selected.model).toBe(MODEL_A);
    expect(interactive.selected.thinkingLevel).toBe("low");
    expect(interactive.sources.model).toEqual({ tier: "config", agentId: "worker" });
  });

  it("missing delegated fields inherit from the base profile", () => {
    const result = resolveAgentAiSettings(
      base({
        profile: "subagent",
        agentAiDefaults: {
          worker: {
            modelString: MODEL_A,
            thinkingLevel: "low",
            subagent: { thinkingLevel: "high" },
          },
        },
      })
    );
    expect(result.selected.model).toBe(MODEL_A);
    expect(result.selected.thinkingLevel).toBe("high");
  });

  it("configured target fields beat target definition fields", () => {
    const result = resolveAgentAiSettings(
      base({
        agentAiDefaults: { worker: { modelString: MODEL_A } },
        targetDefinitionAiDefaults: { model: MODEL_B, thinkingLevel: "high" },
      })
    );
    expect(result.selected.model).toBe(MODEL_A);
    // Definition still supplies the field config leaves unset.
    expect(result.selected.thinkingLevel).toBe("high");
    expect(result.sources.thinkingLevel).toEqual({ tier: "definition", agentId: "worker" });
  });

  it("target definition fields beat ancestor configured fields", () => {
    const result = resolveAgentAiSettings(
      base({
        targetDefinitionAiDefaults: { model: MODEL_A },
        agentAiDefaults: { exec: { modelString: MODEL_B } },
        ancestors: [{ agentId: "exec" }],
      })
    );
    expect(result.selected.model).toBe(MODEL_A);
    expect(result.sources.model).toEqual({ tier: "definition", agentId: "worker" });
  });

  it("multi-hop base chains merge fields independently", () => {
    const result = resolveAgentAiSettings(
      base({
        agentAiDefaults: {
          middle: { thinkingLevel: "medium" },
          root: { modelString: MODEL_C, reasoningMode: "pro" },
        },
        ancestors: [{ agentId: "middle" }, { agentId: "root" }],
      })
    );
    expect(result.selected.model).toBe(MODEL_C);
    expect(result.selected.thinkingLevel).toBe("medium");
    expect(result.selected.reasoningMode).toBe("pro");
    expect(result.sources.model).toEqual({ tier: "config", agentId: "root" });
    expect(result.sources.thinkingLevel).toEqual({ tier: "config", agentId: "middle" });
  });

  it("delegated ancestor overrides apply in delegated context", () => {
    const result = resolveAgentAiSettings(
      base({
        profile: "subagent",
        agentAiDefaults: {
          exec: { modelString: MODEL_A, subagent: { modelString: MODEL_B } },
        },
        ancestors: [{ agentId: "exec" }],
      })
    );
    expect(result.selected.model).toBe(MODEL_B);
    expect(result.sources.model).toEqual({ tier: "config-subagent", agentId: "exec" });
  });

  it("the implicit exec fallback contributes reasoningMode only", () => {
    // No ancestors passed: the resolver appends the implicit fallback itself.
    const result = resolveAgentAiSettings(
      base({
        agentAiDefaults: {
          exec: { modelString: MODEL_B, thinkingLevel: "high", reasoningMode: "pro" },
        },
        fallbacks: [{ model: MODEL_A, thinkingLevel: "low" }],
        proModeAvailable: true,
      })
    );
    // Model/thinking skip the implicit ancestor and land on the fallback tier.
    expect(result.selected.model).toBe(MODEL_A);
    expect(result.selected.thinkingLevel).toBe("low");
    expect(result.selected.reasoningMode).toBe("pro");
    expect(result.sources.reasoningMode).toEqual({ tier: "config", agentId: "exec" });
  });

  it("plan has no implicit exec fallback", () => {
    const result = resolveAgentAiSettings(
      base({
        targetAgentId: "plan",
        agentAiDefaults: { exec: { reasoningMode: "pro" } },
      })
    );
    expect(result.selected.reasoningMode).toBeUndefined();
  });

  it("explicit standard beats inherited pro", () => {
    const result = resolveAgentAiSettings(
      base({
        explicit: { reasoningMode: "standard" },
        agentAiDefaults: { worker: { reasoningMode: "pro" } },
      })
    );
    expect(result.selected.reasoningMode).toBe("standard");
    expect(result.sources.reasoningMode?.tier).toBe("explicit");
  });

  it("configured standard beats an ancestor's pro", () => {
    const result = resolveAgentAiSettings(
      base({
        agentAiDefaults: {
          worker: { reasoningMode: "standard" },
          exec: { reasoningMode: "pro" },
        },
        ancestors: [{ agentId: "exec" }],
      })
    );
    expect(result.selected.reasoningMode).toBe("standard");
  });

  it("parent runtime sits below ancestor defaults and above root workspace fallback", () => {
    const withAncestor = resolveAgentAiSettings(
      base({
        agentAiDefaults: { exec: { modelString: MODEL_A } },
        ancestors: [{ agentId: "exec" }],
        parentRuntime: { model: MODEL_B },
        fallbacks: [{ model: MODEL_C }],
      })
    );
    expect(withAncestor.selected.model).toBe(MODEL_A);

    const withoutAncestor = resolveAgentAiSettings(
      base({
        parentRuntime: { model: MODEL_B },
        fallbacks: [{ model: MODEL_C }],
      })
    );
    expect(withoutAncestor.selected.model).toBe(MODEL_B);
    expect(withoutAncestor.sources.model.tier).toBe("parent-runtime");

    const fallbackOnly = resolveAgentAiSettings(base({ fallbacks: [{ model: MODEL_C }] }));
    expect(fallbackOnly.selected.model).toBe(MODEL_C);
    expect(fallbackOnly.sources.model.tier).toBe("fallback");
  });

  it("system fallback applies when every layer is absent", () => {
    const result = resolveAgentAiSettings(base({}));
    expect(result.selected.model.length).toBeGreaterThan(0);
    expect(result.selected.thinkingLevel).toBe("off");
    expect(result.selected.reasoningMode).toBeUndefined();
    expect(result.sources.model.tier).toBe("default");
    expect(result.sources.thinkingLevel.tier).toBe("default");
  });

  it("uses the supplied default model for the system fallback", () => {
    const result = resolveAgentAiSettings(base({ defaultModel: MODEL_C }));
    expect(result.selected.model).toBe(MODEL_C);
    expect(result.sources.model.tier).toBe("default");
  });
});

describe("resolveAgentAiSettings normalization and clamping", () => {
  it("numeric thinking input maps into the resolved model's policy", () => {
    // gemini-3 allows ["low", "high"]: index 0 is its lowest allowed level.
    const low = resolveAgentAiSettings(
      base({
        explicit: { thinkingLevel: 0 },
        agentAiDefaults: { worker: { modelString: "google:gemini-3-pro" } },
      })
    );
    expect(low.selected.thinkingLevel).toBe("low");

    const high = resolveAgentAiSettings(
      base({
        explicit: { thinkingLevel: 9 },
        agentAiDefaults: { worker: { modelString: "google:gemini-3-pro" } },
      })
    );
    expect(high.selected.thinkingLevel).toBe("high");
  });

  it("clamps effective thinking to the model capability while preserving the selection", () => {
    // Default policy models cap at "high": selected keeps the preference.
    const result = resolveAgentAiSettings(
      base({ targetWorkspaceSettings: { model: MODEL_A, thinkingLevel: "max" } })
    );
    expect(result.selected.thinkingLevel).toBe("max");
    expect(result.effective.thinkingLevel).toBe("high");
  });

  it("applies configured minimum thinking floors to effective values", () => {
    const result = resolveAgentAiSettings(
      base({
        targetWorkspaceSettings: { model: MODEL_A, thinkingLevel: "off" },
        minThinkingLevelByModel: { [MODEL_A]: "medium" },
      })
    );
    expect(result.selected.thinkingLevel).toBe("off");
    expect(result.effective.thinkingLevel).toBe("medium");
  });

  it("preserves selected pro while effective reasoning is unavailable on a non-pro model", () => {
    const result = resolveAgentAiSettings(
      base({
        targetWorkspaceSettings: { model: MODEL_A, reasoningMode: "pro" },
      })
    );
    expect(result.selected.reasoningMode).toBe("pro");
    expect(result.effective.reasoningMode).toBeUndefined();
  });

  it("keeps effective pro on a pro-capable model", () => {
    const result = resolveAgentAiSettings(
      base({
        targetWorkspaceSettings: { model: PRO_MODEL, reasoningMode: "pro" },
      })
    );
    expect(result.effective.reasoningMode).toBe("pro");
  });

  it("honors an adapter-supplied pro availability override", () => {
    const result = resolveAgentAiSettings(
      base({
        targetWorkspaceSettings: { model: PRO_MODEL, reasoningMode: "pro" },
        proModeAvailable: false,
      })
    );
    expect(result.selected.reasoningMode).toBe("pro");
    expect(result.effective.reasoningMode).toBeUndefined();
  });

  it("invalid persisted candidates fall through with diagnostics", () => {
    const result = resolveAgentAiSettings(
      base({
        targetWorkspaceSettings: { model: "not-a-model" },
        agentAiDefaults: { worker: { modelString: MODEL_B } },
      })
    );
    expect(result.selected.model).toBe(MODEL_B);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("invalid explicit model fails instead of falling back", () => {
    expect(() => resolveAgentAiSettings(base({ explicit: { model: "не модель" } }))).toThrow(
      InvalidExplicitAiSettingError
    );
  });
});

describe("collectDeclaredAncestorLayers", () => {
  it("orders declared ancestors child to root without the implicit fallback", () => {
    const chain = collectDeclaredAncestorLayers(
      "leaf",
      new Map([
        ["leaf", { base: "middle" }],
        ["middle", { base: "root", definitionAiDefaults: { model: MODEL_A } }],
      ])
    );
    expect(chain).toEqual([
      { agentId: "middle", definitionAiDefaults: { model: MODEL_A } },
      { agentId: "root" },
    ]);
  });

  it("missing parents terminate the declared chain", () => {
    const chain = collectDeclaredAncestorLayers("leaf", new Map([["leaf", { base: "ghost" }]]));
    expect(chain).toEqual([{ agentId: "ghost" }]);
  });

  it("stops on cycles", () => {
    const chain = collectDeclaredAncestorLayers(
      "a",
      new Map([
        ["a", { base: "b" }],
        ["b", { base: "a" }],
      ])
    );
    expect(chain).toEqual([{ agentId: "b" }]);
  });

  it("treats a same-id base as the chain terminus, not a cycle", () => {
    const chain = collectDeclaredAncestorLayers("exec", new Map([["exec", { base: "exec" }]]));
    expect(chain).toEqual([]);
  });

  it("bounds traversal depth", () => {
    const map = new Map<string, { base?: string }>();
    for (let i = 0; i < 20; i++) {
      map.set(`agent-${i}`, { base: `agent-${i + 1}` });
    }
    const chain = collectDeclaredAncestorLayers("agent-0", map);
    expect(chain).toHaveLength(10);
  });
});
