import { describe, it, expect } from "@jest/globals";

import { computeToolCoalesceInfos, type ToolCoalesceInfo } from "./toolCoalescing";
import type { DisplayedMessage } from "@/common/types/message";

function fileReadMessage(
  id: string,
  path: string,
  historySequence: number
): Extract<DisplayedMessage, { type: "tool" }> {
  return {
    type: "tool",
    id,
    historyId: `h-${id}`,
    toolCallId: `tc-${id}`,
    toolName: "file_read",
    args: { path },
    result: { success: true, content: "", file_size: 0, modifiedTime: "", lines_read: 0 },
    status: "completed",
    isPartial: false,
    historySequence,
  };
}

function fileEditMessage(
  id: string,
  toolName: "file_edit_replace_string" | "file_edit_insert" | "file_edit_replace_lines",
  path: string,
  historySequence: number
): DisplayedMessage {
  return {
    type: "tool",
    id,
    historyId: `h-${id}`,
    toolCallId: `tc-${id}`,
    toolName,
    args:
      toolName === "file_edit_insert"
        ? { path, content: "x" }
        : toolName === "file_edit_replace_string"
          ? { path, old_string: "a", new_string: "b" }
          : { path, start_line: 1, end_line: 2, new_content: "x" },
    result: { success: true, diff: "", edits_applied: 1 },
    status: "completed",
    isPartial: false,
    historySequence,
  };
}

function userMessage(id: string, historySequence: number): DisplayedMessage {
  return {
    type: "user",
    id,
    historyId: `h-${id}`,
    content: "hi",
    historySequence,
  };
}

function infoAt(messages: DisplayedMessage[], index: number): ToolCoalesceInfo | undefined {
  return computeToolCoalesceInfos(messages)[index];
}

describe("computeToolCoalesceInfos", () => {
  it("does not coalesce a single file_read", () => {
    const messages = [fileReadMessage("1", "/a.ts", 1)];
    expect(infoAt(messages, 0)).toBeUndefined();
  });

  it("coalesces two consecutive file_reads with head/member positions", () => {
    const messages = [fileReadMessage("1", "/a.ts", 1), fileReadMessage("2", "/b.ts", 2)];

    const head = infoAt(messages, 0);
    const member = infoAt(messages, 1);

    expect(head).toMatchObject({
      kind: "file_read",
      position: "head",
      totalCount: 2,
      headIndex: 0,
      filePaths: ["/a.ts", "/b.ts"],
    });
    expect(member).toMatchObject({
      kind: "file_read",
      position: "member",
      totalCount: 2,
      headIndex: 0,
      filePaths: ["/a.ts", "/b.ts"],
    });
  });

  it("coalesces three or more consecutive file_reads", () => {
    const messages = [
      fileReadMessage("1", "/a.ts", 1),
      fileReadMessage("2", "/b.ts", 2),
      fileReadMessage("3", "/c.ts", 3),
    ];

    expect(infoAt(messages, 0)?.position).toBe("head");
    expect(infoAt(messages, 1)?.position).toBe("member");
    expect(infoAt(messages, 2)?.position).toBe("member");
    expect(infoAt(messages, 0)?.totalCount).toBe(3);
    expect(infoAt(messages, 0)?.filePaths).toEqual(["/a.ts", "/b.ts", "/c.ts"]);
  });

  it("coalesces mixed file_edit variants under the file_edit kind", () => {
    const messages = [
      fileEditMessage("1", "file_edit_replace_string", "/a.ts", 1),
      fileEditMessage("2", "file_edit_insert", "/b.ts", 2),
      fileEditMessage("3", "file_edit_replace_lines", "/c.ts", 3),
    ];

    expect(infoAt(messages, 0)).toMatchObject({
      kind: "file_edit",
      position: "head",
      totalCount: 3,
      filePaths: ["/a.ts", "/b.ts", "/c.ts"],
    });
    expect(infoAt(messages, 2)?.position).toBe("member");
  });

  it("does not coalesce across kinds (file_read then file_edit)", () => {
    const messages = [
      fileReadMessage("1", "/a.ts", 1),
      fileEditMessage("2", "file_edit_replace_string", "/a.ts", 2),
    ];

    expect(infoAt(messages, 0)).toBeUndefined();
    expect(infoAt(messages, 1)).toBeUndefined();
  });

  it("does not coalesce across an intervening non-tool message", () => {
    const messages = [
      fileReadMessage("1", "/a.ts", 1),
      userMessage("u", 2),
      fileReadMessage("2", "/b.ts", 3),
    ];

    expect(infoAt(messages, 0)).toBeUndefined();
    expect(infoAt(messages, 2)).toBeUndefined();
  });

  it("does not coalesce across an intervening unrelated tool", () => {
    const messages: DisplayedMessage[] = [
      fileReadMessage("1", "/a.ts", 1),
      {
        type: "tool",
        id: "bash-1",
        historyId: "h-bash-1",
        toolCallId: "tc-bash-1",
        toolName: "bash",
        args: { script: "ls", timeout_secs: 1, display_name: "ls" },
        status: "completed",
        isPartial: false,
        historySequence: 2,
      },
      fileReadMessage("2", "/b.ts", 3),
    ];

    expect(infoAt(messages, 0)).toBeUndefined();
    expect(infoAt(messages, 2)).toBeUndefined();
  });

  it("supports multiple independent groups separated by other content", () => {
    const messages = [
      fileReadMessage("r1", "/a.ts", 1),
      fileReadMessage("r2", "/b.ts", 2),
      userMessage("u1", 3),
      fileEditMessage("e1", "file_edit_replace_string", "/c.ts", 4),
      fileEditMessage("e2", "file_edit_insert", "/d.ts", 5),
    ];

    expect(infoAt(messages, 0)?.kind).toBe("file_read");
    expect(infoAt(messages, 0)?.position).toBe("head");
    expect(infoAt(messages, 1)?.position).toBe("member");
    expect(infoAt(messages, 2)).toBeUndefined();
    expect(infoAt(messages, 3)?.kind).toBe("file_edit");
    expect(infoAt(messages, 3)?.position).toBe("head");
    expect(infoAt(messages, 4)?.position).toBe("member");
  });

  it("falls back to (unknown) when a tool args object has no recognizable path", () => {
    const messages: DisplayedMessage[] = [
      {
        type: "tool",
        id: "1",
        historyId: "h-1",
        toolCallId: "tc-1",
        toolName: "file_read",
        args: {},
        status: "completed",
        isPartial: false,
        historySequence: 1,
      },
      fileReadMessage("2", "/b.ts", 2),
    ];

    expect(infoAt(messages, 0)?.filePaths).toEqual(["(unknown)", "/b.ts"]);
  });

  it("does not coalesce a group that contains an interrupted (partial) member", () => {
    // The transcript renders an InterruptedBarrier for interrupted tool rows;
    // hiding such a row would eat the user-visible interruption signal.
    const partial = fileReadMessage("2", "/b.ts", 2);
    partial.isPartial = true;
    const messages: DisplayedMessage[] = [
      fileReadMessage("1", "/a.ts", 1),
      partial,
      fileReadMessage("3", "/c.ts", 3),
    ];

    expect(infoAt(messages, 0)).toBeUndefined();
    expect(infoAt(messages, 1)).toBeUndefined();
    expect(infoAt(messages, 2)).toBeUndefined();
  });

  it("does not coalesce a group with a failed member (preserves error visibility)", () => {
    const failed = fileReadMessage("2", "/b.ts", 2);
    failed.status = "failed";
    const messages: DisplayedMessage[] = [
      fileReadMessage("1", "/a.ts", 1),
      failed,
      fileReadMessage("3", "/c.ts", 3),
    ];

    expect(infoAt(messages, 0)).toBeUndefined();
    expect(infoAt(messages, 1)).toBeUndefined();
    expect(infoAt(messages, 2)).toBeUndefined();
  });

  it("does not coalesce a group with a still-running member", () => {
    // Mid-stream a fresh tool call is `executing`; the summary row hides
    // that status until the user expands, so refuse to coalesce.
    const running = fileReadMessage("2", "/b.ts", 2);
    running.status = "executing";
    const messages: DisplayedMessage[] = [fileReadMessage("1", "/a.ts", 1), running];

    expect(infoAt(messages, 0)).toBeUndefined();
    expect(infoAt(messages, 1)).toBeUndefined();
  });

  it("still coalesces a group when every member is completed", () => {
    const messages = [
      fileReadMessage("1", "/a.ts", 1),
      fileReadMessage("2", "/b.ts", 2),
      fileReadMessage("3", "/c.ts", 3),
    ];

    expect(infoAt(messages, 0)?.position).toBe("head");
  });

  it("returns an array sized to match the input", () => {
    const messages = [
      userMessage("u1", 1),
      fileReadMessage("1", "/a.ts", 2),
      fileReadMessage("2", "/b.ts", 3),
    ];

    const infos = computeToolCoalesceInfos(messages);
    expect(infos).toHaveLength(3);
    expect(infos[0]).toBeUndefined();
    expect(infos[1]?.position).toBe("head");
    expect(infos[2]?.position).toBe("member");
  });
});
