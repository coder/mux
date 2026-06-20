import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { canUseScheduledPromptsInWorkspace } from "./scheduledPromptAvailability";

function workspace(overrides: Partial<FrontendWorkspaceMetadata> = {}): FrontendWorkspaceMetadata {
  return {
    id: "ws-1",
    name: "main",
    projectName: "project",
    projectPath: "/repo/project",
    namedWorkspacePath: "/repo/project/main",
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ...overrides,
  };
}

describe("canUseScheduledPromptsInWorkspace", () => {
  test("allows regular workspaces", () => {
    expect(canUseScheduledPromptsInWorkspace(workspace())).toBe(true);
  });

  test("blocks workspaces without a runnable composer", () => {
    expect(canUseScheduledPromptsInWorkspace(null)).toBe(false);
    expect(canUseScheduledPromptsInWorkspace(workspace({ transcriptOnly: true }))).toBe(false);
    expect(canUseScheduledPromptsInWorkspace(workspace({ incompatibleRuntime: "missing" }))).toBe(
      false
    );
    expect(
      canUseScheduledPromptsInWorkspace(
        workspace({ parentWorkspaceId: "parent", taskStatus: "queued" })
      )
    ).toBe(false);
    expect(
      canUseScheduledPromptsInWorkspace(
        workspace({ parentWorkspaceId: "parent", taskStatus: "starting" })
      )
    ).toBe(false);
  });
});
