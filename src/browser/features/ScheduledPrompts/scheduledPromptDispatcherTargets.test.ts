import { describe, expect, test } from "bun:test";
import { DEFAULT_RUNTIME_CONFIG } from "@/common/constants/workspace";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";
import { createScheduledPrompt, type ScheduledPrompt } from "./scheduledPrompts";
import {
  getScheduledPromptDispatcherTargets,
  isScheduledPromptsStorageKey,
} from "./scheduledPromptDispatcherTargets";

function workspace(
  id: string,
  overrides: Partial<FrontendWorkspaceMetadata> = {}
): FrontendWorkspaceMetadata {
  return {
    id,
    name: id,
    projectName: "project",
    projectPath: `/repo/${id}`,
    namedWorkspacePath: `/repo/${id}/main`,
    runtimeConfig: DEFAULT_RUNTIME_CONFIG,
    ...overrides,
  };
}

function scheduledPrompt(overrides: Partial<ScheduledPrompt> = {}): ScheduledPrompt {
  const prompt = createScheduledPrompt(
    {
      content: "Continue",
      runAt: 1,
      queueDispatchMode: "turn-end",
    },
    0,
    overrides.id ?? "prompt-1"
  );
  return { ...prompt, ...overrides };
}

describe("scheduled prompt dispatcher targets", () => {
  test("recognizes scheduled prompt storage keys", () => {
    expect(isScheduledPromptsStorageKey("scheduledPrompts:ws-1")).toBe(true);
    expect(isScheduledPromptsStorageKey("other:ws-1")).toBe(false);
  });

  test("returns all runnable workspaces with scheduled prompts", () => {
    const metadata = new Map([
      ["active", workspace("active")],
      ["background", workspace("background")],
      ["done", workspace("done")],
      [
        "queued-child",
        workspace("queued-child", { parentWorkspaceId: "parent", taskStatus: "queued" }),
      ],
    ]);
    const promptsByKey = new Map<string, unknown>([
      ["scheduledPrompts:active", [scheduledPrompt({ id: "active-prompt" })]],
      ["scheduledPrompts:background", [scheduledPrompt({ id: "background-prompt" })]],
      ["scheduledPrompts:done", [scheduledPrompt({ id: "done-prompt", status: "sent" })]],
      ["scheduledPrompts:queued-child", [scheduledPrompt({ id: "queued-child-prompt" })]],
    ]);

    expect(getScheduledPromptDispatcherTargets(metadata, (key) => promptsByKey.get(key))).toEqual([
      { workspaceId: "active", projectPath: "/repo/active" },
      { workspaceId: "background", projectPath: "/repo/background" },
    ]);
  });
});
