import { describe, it, expect } from "bun:test";

import type { MuxMessage, MuxToolPart } from "@/common/types/message";
import { Ok } from "@/common/types/result";
import { TaskService } from "./taskService";

function createTaskToolPart(params: {
  toolCallId: string;
  state: "input-available" | "output-available";
  input: unknown;
  output?: unknown;
}): MuxToolPart {
  if (params.state === "output-available") {
    return {
      type: "dynamic-tool",
      toolCallId: params.toolCallId,
      toolName: "task",
      state: "output-available",
      input: params.input,
      output: params.output,
    };
  }

  return {
    type: "dynamic-tool",
    toolCallId: params.toolCallId,
    toolName: "task",
    state: "input-available",
    input: params.input,
  };
}

describe("TaskService", () => {
  describe("tryResolveParentTaskToolCall", () => {
    it("should finalize background task tool output to completed", async () => {
      const toolCallId = "tool-1";
      const childWorkspaceId = "child-1";
      const reportMarkdown = "done";

      const parentMessage: MuxMessage = {
        id: "msg-1",
        role: "assistant",
        parts: [
          createTaskToolPart({
            toolCallId,
            state: "output-available",
            input: { agentType: "research", prompt: "hi", runInBackground: true },
            output: { status: "started", childWorkspaceId },
          }),
        ],
        metadata: {
          historySequence: 1,
          model: "test-model",
        },
      };

      const reportMessage: MuxMessage = {
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "### Subagent report\n\n" + reportMarkdown }],
        metadata: {
          historySequence: 2,
        },
      };

      const history: MuxMessage[] = [parentMessage, reportMessage];
      const emitted: unknown[] = [];
      const resumeCalls: unknown[] = [];

      const historyService = {
        getHistory: () => Ok(history),
        updateHistory: (_workspaceId: string, message: MuxMessage) => {
          const seq = message.metadata?.historySequence;
          expect(seq).toBeDefined();
          const index = history.findIndex((m) => m.metadata?.historySequence === seq);
          expect(index).toBeGreaterThanOrEqual(0);
          history[index] = message;
          return Ok(undefined);
        },
      };

      const partialService = {
        readPartial: () => null,
        writePartial: () => Ok(undefined),
      };

      const workspaceService = {
        emitChatEvent: (_workspaceId: string, event: unknown) => {
          emitted.push(event);
        },
        resumeStream: (_workspaceId: string, options: unknown) => {
          resumeCalls.push(options);
          return Ok(undefined);
        },
      };

      const config = {
        listWorkspaceConfigs: () => [],
      };

      const aiService = {
        on: () => undefined,
      };

      const service = new TaskService(
        config as never,
        historyService as never,
        partialService as never,
        workspaceService as never,
        aiService as never
      );

      await (
        service as unknown as { tryResolveParentTaskToolCall: (params: unknown) => Promise<void> }
      ).tryResolveParentTaskToolCall({
        parentWorkspaceId: "parent",
        parentToolCallId: toolCallId,
        childWorkspaceId,
        report: { reportMarkdown },
      });

      expect(resumeCalls).toHaveLength(0);

      const updatedToolPart = history[0].parts[0] as Extract<
        MuxToolPart,
        { state: "output-available" }
      >;
      expect(updatedToolPart.state).toBe("output-available");
      expect(updatedToolPart.output).toEqual({
        status: "completed",
        childWorkspaceId,
        reportMarkdown,
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "tool-call-end",
        toolCallId,
        toolName: "task",
        result: {
          status: "completed",
          childWorkspaceId,
          reportMarkdown,
        },
      });
    });

    it("should auto-resume parent when the tool call was pending", async () => {
      const toolCallId = "tool-2";
      const childWorkspaceId = "child-2";
      const reportMarkdown = "done";

      const parentMessage: MuxMessage = {
        id: "msg-1",
        role: "assistant",
        parts: [
          createTaskToolPart({
            toolCallId,
            state: "input-available",
            input: { agentType: "research", prompt: "hi" },
          }),
        ],
        metadata: {
          historySequence: 1,
          model: "test-model",
        },
      };

      const reportMessage: MuxMessage = {
        id: "msg-2",
        role: "assistant",
        parts: [{ type: "text", text: "### Subagent report\n\n" + reportMarkdown }],
        metadata: {
          historySequence: 2,
        },
      };

      const history: MuxMessage[] = [parentMessage, reportMessage];
      const emitted: unknown[] = [];
      const resumeCalls: unknown[] = [];

      const historyService = {
        getHistory: () => Ok(history),
        updateHistory: (_workspaceId: string, message: MuxMessage) => {
          const seq = message.metadata?.historySequence;
          expect(seq).toBeDefined();
          const index = history.findIndex((m) => m.metadata?.historySequence === seq);
          expect(index).toBeGreaterThanOrEqual(0);
          history[index] = message;
          return Ok(undefined);
        },
      };

      const partialService = {
        readPartial: () => null,
        writePartial: () => Ok(undefined),
      };

      const workspaceService = {
        emitChatEvent: (_workspaceId: string, event: unknown) => {
          emitted.push(event);
        },
        resumeStream: (_workspaceId: string, options: unknown) => {
          resumeCalls.push(options);
          return Ok(undefined);
        },
      };

      const config = {
        listWorkspaceConfigs: () => [],
      };

      const aiService = {
        on: () => undefined,
      };

      const service = new TaskService(
        config as never,
        historyService as never,
        partialService as never,
        workspaceService as never,
        aiService as never
      );

      await (
        service as unknown as { tryResolveParentTaskToolCall: (params: unknown) => Promise<void> }
      ).tryResolveParentTaskToolCall({
        parentWorkspaceId: "parent",
        parentToolCallId: toolCallId,
        childWorkspaceId,
        report: { reportMarkdown },
      });

      expect(resumeCalls).toHaveLength(1);
      expect(resumeCalls[0]).toEqual({
        model: "test-model",
        mode: undefined,
        toolPolicy: undefined,
      });

      const updatedToolPart = history[0].parts[0] as Extract<
        MuxToolPart,
        { state: "output-available" }
      >;
      expect(updatedToolPart.state).toBe("output-available");
      expect(updatedToolPart.output).toEqual({
        status: "completed",
        childWorkspaceId,
        reportMarkdown,
      });

      expect(emitted).toHaveLength(1);
      expect(emitted[0]).toMatchObject({
        type: "tool-call-end",
        toolCallId,
        toolName: "task",
      });
    });
  });
});
