import { describe, expect, it } from "bun:test";
import type { WorkspaceActivitySnapshot } from "../types";
import { getWorkspaceActivityPresentation } from "./workspaceActivity";

function createActivitySnapshot(
  overrides: Partial<WorkspaceActivitySnapshot> = {}
): WorkspaceActivitySnapshot {
  return {
    recency: 1,
    streaming: false,
    lastModel: null,
    lastThinkingLevel: null,
    ...overrides,
  };
}

describe("getWorkspaceActivityPresentation", () => {
  it("shows idle status with the last active time when no activity snapshot exists", () => {
    expect(getWorkspaceActivityPresentation(undefined, "2 hours ago")).toEqual({
      label: "Idle",
      detail: "2 hours ago",
      tone: "idle",
    });
  });

  it("prefers agent status messages for active streaming workspaces", () => {
    expect(
      getWorkspaceActivityPresentation(
        createActivitySnapshot({
          streaming: true,
          lastModel: "openai/gpt-5-mini",
          agentStatus: { emoji: "🧪", message: "Running tests" },
        }),
        "Just now"
      )
    ).toEqual({
      label: "Running tests",
      detail: "GPT-5 mini",
      tone: "active",
    });
  });

  it("surfaces follow-up work when a workspace has pending todos", () => {
    expect(
      getWorkspaceActivityPresentation(createActivitySnapshot({ hasTodos: true }), "Yesterday")
    ).toEqual({
      label: "Needs follow-up",
      detail: "Yesterday",
      tone: "attention",
    });
  });

  it("omits unknown fallback details for idle workspaces", () => {
    expect(getWorkspaceActivityPresentation(createActivitySnapshot(), "Unknown")).toEqual({
      label: "Idle",
      tone: "idle",
    });
  });
});
