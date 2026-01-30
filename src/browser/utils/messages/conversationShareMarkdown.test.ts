import { buildConversationShareMarkdown } from "./conversationShareMarkdown";
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
    expect(md).toContain("## User");
    expect(md).toContain("Hello");
    expect(md).toContain("## Assistant");
    expect(md).toContain("Hi there");
  });

  test("includes tool calls as <details> blocks", () => {
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

    expect(md).toContain("<summary>Tool: bash (output-available)</summary>");
    expect(md).toContain("**Input**");
    expect(md).toContain('"script": "echo hi"');
    expect(md).toContain("**Output**");
    expect(md).toContain('"exitCode": 0');
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
    expect(md).toContain("_[file: image.png (image/png)]_");
    expect(md).not.toContain("data:image/png;base64");
  });
});
