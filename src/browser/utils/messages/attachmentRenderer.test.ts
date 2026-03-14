import { describe, it, expect } from "@jest/globals";
import {
  renderAttachmentToContent,
  renderAttachmentsToContentWithBudget,
} from "./attachmentRenderer";
import { getFlowPromptPathMarkerLine } from "@/common/constants/flowPrompting";
import type {
  TodoListAttachment,
  FlowPromptReferenceAttachment,
  PlanFileReferenceAttachment,
  EditedFilesReferenceAttachment,
} from "@/common/types/attachment";

describe("attachmentRenderer", () => {
  it("renders todo list inline and mentions todo_read", () => {
    const attachment: TodoListAttachment = {
      type: "todo_list",
      todos: [
        { content: "Completed task", status: "completed" },
        { content: "In progress task", status: "in_progress" },
        { content: "Pending task", status: "pending" },
      ],
    };

    const content = renderAttachmentToContent(attachment);

    expect(content).toContain("todo_read");
    expect(content).toContain("[x]");
    expect(content).toContain("[>]");
    expect(content).toContain("[ ]");
    expect(content).toContain("Completed task");
    expect(content).toContain("In progress task");
    expect(content).toContain("Pending task");

    // Should not leak file paths (inline only).
    expect(content).not.toContain("todos.json");
    expect(content).not.toContain("~/.mux");
  });

  it("respects a maxChars budget and truncates oversized plan content", () => {
    const attachment: PlanFileReferenceAttachment = {
      type: "plan_file_reference",
      planFilePath: "~/.mux/plans/cmux/ws.md",
      planContent: "a".repeat(10_000),
    };

    const content = renderAttachmentsToContentWithBudget([attachment], { maxChars: 400 });

    expect(content.length).toBeLessThanOrEqual(400);
    expect(content).toContain("Plan contents");
    expect(content).toContain("...(truncated)");
    expect(content).toContain("<system-update>");
  });

  it("keeps tight-budget flow prompt references within budget", () => {
    const flowPromptPath = "/tmp/workspace/.mux/prompts/feature.md";
    const attachment: FlowPromptReferenceAttachment = {
      type: "flow_prompt_reference",
      flowPromptPath,
      flowPromptContent: "0123456789".repeat(50),
    };
    const prefix = `${getFlowPromptPathMarkerLine(flowPromptPath)}\n\nCurrent flow prompt contents:\n\`\`\`md\n`;
    const suffix = "\n```";
    const systemUpdateWrapperLength = "<system-update>\n".length + "\n</system-update>".length;
    const maxChars = prefix.length + suffix.length + systemUpdateWrapperLength + 5;

    const content = renderAttachmentsToContentWithBudget([attachment], { maxChars });

    expect(content.length).toBeLessThanOrEqual(maxChars);
    expect(content).toContain(getFlowPromptPathMarkerLine(flowPromptPath));
    expect(content).toContain("01234");
    expect(content).not.toContain("(post-compaction context omitted due to size)");
  });

  it("keeps tight-budget plan references within budget", () => {
    const planFilePath = "~/.mux/plans/cmux/ws.md";
    const attachment: PlanFileReferenceAttachment = {
      type: "plan_file_reference",
      planFilePath,
      planContent: "abcdefghi".repeat(200),
    };
    const prefix = `A plan file exists from plan mode at: ${planFilePath}\n\nPlan contents:\n`;
    const suffix =
      "\n\nIf this plan is relevant to the current work and not already complete, continue working on it.";
    const systemUpdateWrapperLength = "<system-update>\n".length + "\n</system-update>".length;
    const maxChars = prefix.length + suffix.length + systemUpdateWrapperLength + 5;

    const content = renderAttachmentsToContentWithBudget([attachment], { maxChars });

    expect(content.length).toBeLessThanOrEqual(maxChars);
    expect(content).toContain(`A plan file exists from plan mode at: ${planFilePath}`);
    expect(content).toContain("abcde");
    expect(content).not.toContain("(post-compaction context omitted due to size)");
  });

  it("emits an omitted-file-diffs note when edited file diffs do not fit", () => {
    const attachment: EditedFilesReferenceAttachment = {
      type: "edited_files_reference",
      files: [
        { path: "src/a.ts", diff: "a".repeat(2000), truncated: false },
        { path: "src/b.ts", diff: "b".repeat(2000), truncated: false },
      ],
    };

    const content = renderAttachmentsToContentWithBudget([attachment], { maxChars: 120 });

    expect(content.length).toBeLessThanOrEqual(120);
    expect(content).toContain("omitted 2 file diffs");
    expect(content).toContain("<system-update>");
  });
});
