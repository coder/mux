import { describe, expect, it } from "bun:test";

import { formatToolEnd } from "./toolFormatters";

describe("formatToolEnd(task)", () => {
  it("formats grouped running task results with spawned task IDs", () => {
    const formatted = formatToolEnd(
      {
        type: "tool-call-end",
        workspaceId: "parent",
        messageId: "message-1",
        toolCallId: "tool-task-1",
        toolName: "task",
        result: {
          status: "running",
          taskIds: ["task-a", "task-b"],
          tasks: [
            { taskId: "task-a", status: "running" },
            { taskId: "task-b", status: "queued" },
          ],
          note: "Tasks continue in background.",
        },
        timestamp: Date.now(),
      },
      {
        agentId: "explore",
        prompt: "compare options",
        title: "Best of 2",
        n: 2,
      }
    );

    expect(formatted).toContain("running:");
    expect(formatted).toContain("task-a");
    expect(formatted).toContain("task-b");
  });

  it("formats grouped completed task results with report counts", () => {
    const formatted = formatToolEnd(
      {
        type: "tool-call-end",
        workspaceId: "parent",
        messageId: "message-1",
        toolCallId: "tool-task-1",
        toolName: "task",
        result: {
          status: "completed",
          taskIds: ["task-a", "task-b"],
          reports: [
            {
              taskId: "task-a",
              title: "Candidate one",
              reportMarkdown: "Report one",
              agentId: "explore",
              agentType: "explore",
            },
            {
              taskId: "task-b",
              title: "Candidate two",
              reportMarkdown: "Report two",
              agentId: "explore",
              agentType: "explore",
            },
          ],
        },
        timestamp: Date.now(),
      },
      {
        agentId: "explore",
        prompt: "compare options",
        title: "Best of 2",
        n: 2,
      }
    );

    expect(formatted).toContain("2 reports");
    expect(formatted).toContain("task-a");
    expect(formatted).toContain("task-b");
  });
});
