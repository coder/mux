import { describe, expect, test } from "bun:test";
import { WORKSPACE_DEFAULTS } from "@/constants/workspaceDefaults";
import { normalizeAgentId, resolveRemovedBuiltinAgentId } from "./agentIds";

describe("resolveRemovedBuiltinAgentId", () => {
  test("maps removed builtin agent ids to the workspace default when unavailable", () => {
    expect(resolveRemovedBuiltinAgentId("ask", ["exec", "plan"])).toBe(WORKSPACE_DEFAULTS.agentId);
    expect(resolveRemovedBuiltinAgentId("auto", ["exec", "plan"])).toBe(WORKSPACE_DEFAULTS.agentId);
    expect(resolveRemovedBuiltinAgentId("mux", ["exec", "plan"])).toBe(WORKSPACE_DEFAULTS.agentId);
  });

  test("preserves removed builtin agent ids that are still available", () => {
    expect(resolveRemovedBuiltinAgentId("mux", ["mux", "exec"])).toBe("mux");
  });

  test("normalizes case and whitespace before applying fallback remaps", () => {
    expect(resolveRemovedBuiltinAgentId("  MUX  ", ["exec", "plan"])).toBe(
      WORKSPACE_DEFAULTS.agentId
    );
    expect(normalizeAgentId("  Exec  ")).toBe("exec");
  });
});
