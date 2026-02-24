import { describe, expect, it } from "@jest/globals";
import {
  isExecLikeEditingCapableInResolvedChain,
  isToolEnabledInResolvedChain,
} from "./agentTools";

describe("isExecLikeEditingCapableInResolvedChain", () => {
  it("returns true when exec chain enables file_edit_insert", () => {
    const agents = [{ id: "exec", tools: { add: ["file_edit_insert"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(true);
  });

  it("returns true when exec chain enables file_edit_replace_string", () => {
    const agents = [{ id: "exec", tools: { add: ["file_edit_replace_string"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(true);
  });

  it("returns false when exec chain enables neither edit nor patch-apply tools", () => {
    const agents = [{ id: "exec", tools: { add: ["task"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(false);
  });

  it("returns false when chain does not inherit exec", () => {
    const agents = [{ id: "orchestrator", tools: { add: ["file_edit_insert"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(false);
  });

  it("returns true for orchestrator-style chains that remove file_edit tools but keep patch apply", () => {
    const agents = [
      {
        id: "orchestrator",
        tools: {
          add: ["ask_user_question"],
          remove: ["propose_plan", "file_edit_.*"],
        },
      },
      {
        id: "exec",
        tools: {
          add: [".*"],
          remove: ["propose_plan", "ask_user_question", "system1_keep_ranges"],
        },
      },
    ];

    expect(isToolEnabledInResolvedChain("file_edit_insert", agents)).toBe(false);
    expect(isToolEnabledInResolvedChain("file_edit_replace_string", agents)).toBe(false);
    expect(isToolEnabledInResolvedChain("task_apply_git_patch", agents)).toBe(true);
    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(true);
  });

  it("returns false when task_apply_git_patch is enabled without exec inheritance", () => {
    const agents = [{ id: "orchestrator", tools: { add: ["task_apply_git_patch"] } }];

    expect(isExecLikeEditingCapableInResolvedChain(agents)).toBe(false);
  });
});
