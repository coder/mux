import { describe, it, expect } from "@jest/globals";
import { renderAttachmentToContent } from "./attachmentRenderer";
import type { TodoListAttachment } from "@/common/types/attachment";

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
});
