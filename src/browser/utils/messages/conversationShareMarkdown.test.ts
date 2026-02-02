import {
  buildConversationShareConvoSummary,
  buildConversationShareMarkdown,
} from "./conversationShareMarkdown";
import { createMuxMessage } from "@/common/types/message";
import type { MuxToolPart } from "@/common/types/message";

describe("buildConversationShareMarkdown", () => {
  test("renders a basic user/assistant transcript", () => {
    const muxMessages = [
      createMuxMessage("u1", "user", "Hello"),
      createMuxMessage("a1", "assistant", "Hi there"),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "my-workspace" });

    expect(md).toContain("# my-workspace");
    expect(md).toContain('<div data-message-block class="ml-auto w-fit">');
    expect(md).toContain("<pre>Hello</pre>");
    expect(md).toContain("Hi there");
  });

  test("concatenates streaming text parts (no extra newlines between chunks)", () => {
    const muxMessages = [
      createMuxMessage("a1", "assistant", "", undefined, [
        { type: "text" as const, text: "I" },
        { type: "text" as const, text: "'ll" },
        { type: "text" as const, text: " explore" },
      ]),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("I'll explore");
    expect(md).not.toContain("I\n\n'll");
  });

  test("renders bash tool calls as inline command", () => {
    const bashTool: MuxToolPart = {
      type: "dynamic-tool",
      toolCallId: "call-1",
      toolName: "bash",
      input: { script: "echo hi" },
      state: "output-available",
      output: { exitCode: 0, output: "hi\n" },
    };

    const muxMessages = [
      createMuxMessage("u1", "user", "Run the command"),
      createMuxMessage("a1", "assistant", "Done", undefined, [bashTool]),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("Done");
    expect(md).toContain("`echo hi`");
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("<summary>");
    expect(md).not.toContain('"script": "echo hi"');
  });

  test("summarizes file_read tool calls", () => {
    const fileReadTool = {
      type: "dynamic-tool" as const,
      toolCallId: "call-1",
      toolName: "file_read",
      input: { file_path: "src/node/orpc/router.ts", offset: 1, limit: 40 },
      state: "output-available" as const,
      output: { success: true, content: "" },
    } as unknown as MuxToolPart;

    const muxMessages = [createMuxMessage("a1", "assistant", "", undefined, [fileReadTool])];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("Reading a file src/node/orpc/router.ts");
    expect(md).not.toContain("<summary>Tool: file_read");
    expect(md).not.toContain('"file_path": "src/node/orpc/router.ts"');
  });

  test("renders task tool calls as an expandable prompt", () => {
    const taskTool = {
      type: "dynamic-tool" as const,
      toolCallId: "call-1",
      toolName: "task",
      input: {
        agentId: "explore",
        prompt: "**Task:** Find the MCP name field.\n\n**Deliverable:** Notes",
        title: "Explore MCP name field in settings",
        run_in_background: true,
      },
      state: "output-available" as const,
      output: { status: "queued", taskId: "t1" },
    } as unknown as MuxToolPart;

    const muxMessages = [createMuxMessage("a1", "assistant", "", undefined, [taskTool])];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("<details>");
    expect(md).toContain("Started background task - Explore MCP name field in settings");
    expect(md).toContain("**Agent:** `explore`");
    expect(md).toContain("**Task:** Find the MCP name field.");
    expect(md).not.toContain('"prompt"');
    expect(md).not.toContain('"title"');
  });

  test("renders todo_write tool calls as a checkbox list", () => {
    const todoWriteTool = {
      type: "dynamic-tool" as const,
      toolCallId: "call-1",
      toolName: "todo_write",
      input: {
        todos: [
          {
            content: "Reading current MCP server validation implementation",
            status: "in_progress",
          },
          { content: "Add uniqueness validation for server name", status: "pending" },
          { content: "Test the validation", status: "completed" },
        ],
      },
      state: "output-available" as const,
      output: { success: true },
    } as unknown as MuxToolPart;

    const muxMessages = [createMuxMessage("a1", "assistant", "", undefined, [todoWriteTool])];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("To do:");
    expect(md).toContain(
      "- [ ] Reading current MCP server validation implementation _(in progress)_"
    );
    expect(md).toContain("- [ ] Add uniqueness validation for server name");
    expect(md).toContain("- [x] Test the validation");
    expect(md).not.toContain('"todos"');
  });
  test("includes file edit previews", () => {
    const diff = [
      "Index: src/foo.ts",
      "===================================================================",
      "--- src/foo.ts",
      "+++ src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const fileEditTool = {
      type: "dynamic-tool" as const,
      toolCallId: "call-1",
      toolName: "file_edit_replace_string",
      input: {
        file_path: "src/foo.ts",
        old_string: "old",
        new_string: "new",
      },
      state: "output-available" as const,
      output: {
        success: true,
        diff,
      },
    } as unknown as MuxToolPart;

    const muxMessages = [createMuxMessage("a1", "assistant", "Updated", undefined, [fileEditTool])];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    // File edit previews should be readable excerpts (not raw unified diffs).
    expect(md).toContain("Edited src/foo.ts");
    expect(md).toContain("```text");
    expect(md).toContain("1 | new");
    expect(md).not.toContain("Index:");
    expect(md).not.toContain("@@");
    expect(md).not.toContain("+++ ");
    expect(md).not.toContain("--- ");
    expect(md).not.toContain("+new");
    expect(md).not.toContain("-old");
  });

  test("buildConversationShareConvoSummary counts prompts and file edits", () => {
    const diff = [
      "Index: src/foo.ts",
      "===================================================================",
      "--- src/foo.ts",
      "+++ src/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const fileEditTool = {
      type: "dynamic-tool" as const,
      toolCallId: "call-1",
      toolName: "file_edit_replace_string",
      input: {
        file_path: "src/foo.ts",
        old_string: "old",
        new_string: "new",
      },
      state: "output-available" as const,
      output: {
        success: true,
        diff,
      },
    } as unknown as MuxToolPart;

    const muxMessages = [
      createMuxMessage("u1", "user", "Hello"),
      createMuxMessage("a1", "assistant", "Updated", undefined, [fileEditTool]),
    ];

    const summary = buildConversationShareConvoSummary({ muxMessages });

    expect(summary.clientMode).toBe("desktop");
    expect(summary.userPromptCount).toBe(1);
    expect(summary.filesModifiedCount).toBe(1);
    expect(summary.loc).toEqual({ added: 1, removed: 1 });
  });
  test("includes reasoning parts inline (not collapsible)", () => {
    const muxMessages = [
      createMuxMessage("a1", "assistant", "Answer", undefined, [
        { type: "reasoning" as const, text: "Secret reasoning" },
      ]),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("Answer");
    expect(md).toContain("Secret reasoning");
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("<summary>");
  });

  test("strips section headers from reasoning", () => {
    const muxMessages = [
      createMuxMessage("a1", "assistant", "Answer", undefined, [
        {
          type: "reasoning" as const,
          text: "Updating router endpoints\n\nThis is the real reasoning.",
        },
      ]),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("This is the real reasoning.");
    expect(md).not.toContain("Updating router endpoints");
  });

  test("concatenates streaming reasoning parts (no per-word <details>)", () => {
    const muxMessages = [
      createMuxMessage("a1", "assistant", "", undefined, [
        { type: "reasoning" as const, text: "Inspect" },
        { type: "reasoning" as const, text: "ing repository structure" },
      ]),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });

    expect(md).toContain("Inspecting repository structure");
    expect(md).not.toContain("<details>");
    expect(md).not.toContain("<summary>");
  });
  test("filters synthetic messages by default", () => {
    const muxMessages = [
      createMuxMessage("u1", "user", "Visible"),
      createMuxMessage("s1", "assistant", "Hidden", { synthetic: true }),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });
    expect(md).toContain("Visible");
    expect(md).not.toContain("Hidden");

    const mdWithSynthetic = buildConversationShareMarkdown({
      muxMessages,
      workspaceName: "ws",
      includeSynthetic: true,
    });
    expect(mdWithSynthetic).toContain("Hidden");
  });

  test("replaces file parts with a placeholder", () => {
    const muxMessages = [
      createMuxMessage("u1", "user", "Here is the file", undefined, [
        {
          type: "file" as const,
          mediaType: "image/png",
          url: "data:image/png;base64,AAAA",
          filename: "image.png",
        },
      ]),
    ];

    const md = buildConversationShareMarkdown({ muxMessages, workspaceName: "ws" });
    expect(md).toContain("[file: image.png (image/png)]");
    expect(md).not.toContain("data:image/png;base64");
  });
});
