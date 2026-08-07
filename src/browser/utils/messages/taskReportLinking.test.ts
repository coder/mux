import { describe, expect, test } from "bun:test";

import type { DisplayedMessage } from "@/common/types/message";
import { computeTaskReportLinking } from "./taskReportLinking";

function createToolMessage(
  id: string,
  toolName: string,
  args: unknown,
  result: unknown,
  historySequence: number
): DisplayedMessage {
  return {
    type: "tool",
    id,
    historyId: id,
    toolCallId: id,
    toolName,
    args,
    result,
    status: "completed",
    isPartial: false,
    historySequence,
  };
}

describe("computeTaskReportLinking", () => {
  test("links and suppresses canonical reports by workspaceId rather than opaque taskId", () => {
    const linking = computeTaskReportLinking([
      createToolMessage(
        "spawn",
        "task",
        {
          agentId: "exec",
          prompt: "Implement the fix.",
          title: "Canonical execution title",
          run_in_background: true,
        },
        {
          status: "running",
          taskId: "opaque-spawn-id",
          workspaceId: "workspace-canonical",
          note: "Running",
        },
        1
      ),
      createToolMessage(
        "await",
        "task_await",
        { task_ids: ["opaque-different-await-id"], timeout_secs: 0 },
        {
          results: [
            {
              status: "completed",
              taskId: "opaque-different-await-id",
              workspaceId: "workspace-canonical",
              reportMarkdown: "Finished.",
            },
          ],
        },
        2
      ),
    ]);

    expect(linking.reportByWorkspaceId.get("workspace-canonical")?.reportMarkdown).toBe(
      "Finished."
    );
    expect(linking.reportByTaskId.size).toBe(0);
    expect(linking.suppressReportInAwaitWorkspaceIds.has("workspace-canonical")).toBe(true);
    expect(linking.spawnTitleByWorkspaceId.get("workspace-canonical")).toBe(
      "Canonical execution title"
    );
  });

  test("keeps taskId linking only for historical results without workspaceId", () => {
    const linking = computeTaskReportLinking([
      createToolMessage(
        "legacy-spawn",
        "task",
        {
          subagent_type: "explore",
          prompt: "Read old history.",
          title: "Legacy execution",
          run_in_background: true,
        },
        { status: "running", taskId: "legacy-task", note: "Running" },
        1
      ),
      createToolMessage(
        "legacy-await",
        "task_await",
        { task_ids: ["legacy-task"], timeout_secs: 0 },
        {
          results: [
            {
              status: "completed",
              taskId: "legacy-task",
              reportMarkdown: "Legacy report.",
            },
          ],
        },
        2
      ),
    ]);

    expect(linking.reportByWorkspaceId.size).toBe(0);
    expect(linking.reportByTaskId.get("legacy-task")?.reportMarkdown).toBe("Legacy report.");
    expect(linking.suppressReportInAwaitTaskIds.has("legacy-task")).toBe(true);
  });
});
