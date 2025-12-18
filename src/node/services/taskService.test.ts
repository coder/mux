import { describe, it, expect } from "bun:test";

import type { MuxMessage, MuxToolPart } from "@/common/types/message";
import { Err, Ok } from "@/common/types/result";
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

  describe("handleAgentReport", () => {
    it("should resolve awaiters even if parent history append fails", async () => {
      const parentWorkspaceId = "parent";
      const childWorkspaceId = "child";

      const workspace = {
        id: childWorkspaceId,
        path: "/tmp/agent",
        name: "agent",
        projectName: "proj",
        projectPath: "/proj",
        createdAt: "2025-01-01T00:00:00.000Z",
        parentWorkspaceId,
        agentType: "research",
        taskStatus: "running",
        taskModel: "openai:gpt-5-codex",
      };

      const projects = new Map([
        [
          "/proj",
          {
            workspaces: [workspace],
          },
        ],
      ]);

      let idCounter = 0;
      const config = {
        generateStableId: () => `id-${idCounter++}`,
        getTaskSettings: () => ({
          maxParallelAgentTasks: 3,
          maxTaskNestingDepth: 3,
        }),
        listWorkspaceConfigs: () => [],
        getWorkspaceConfig: (id: string) => {
          if (id !== childWorkspaceId) {
            return null;
          }

          return { projectPath: "/proj", workspace };
        },
        editConfig: (edit: (cfg: unknown) => unknown) => {
          edit({ projects });
        },
      };

      const historyService = {
        getHistory: (_workspaceId: string) => Ok([]),
        appendToHistory: (workspaceId: string, _message: MuxMessage) => {
          if (workspaceId === parentWorkspaceId) {
            return Err("disk full");
          }

          return Ok(undefined);
        },
      };

      const partialService = {
        readPartial: () => null,
        writePartial: () => Ok(undefined),
      };

      const workspaceService = {
        emitChatEvent: (_workspaceId: string, _event: unknown) => undefined,
        emitWorkspaceMetadata: (_workspaceId: string) => undefined,
        remove: (_workspaceId: string, _force?: boolean) => Ok(undefined),
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

      const reportPromise = service.awaitAgentReport(childWorkspaceId);

      await service.handleAgentReport(childWorkspaceId, { reportMarkdown: "hello" });

      expect(await reportPromise).toEqual({ reportMarkdown: "hello" });
      expect(workspace.taskStatus).toBe("reported");
    });
  });

  describe("onStreamEnd", () => {
    it("should finalize tasks when report enforcement resume fails", async () => {
      const parentWorkspaceId = "parent";
      const childWorkspaceId = "child";

      const workspace = {
        id: childWorkspaceId,
        path: "/tmp/agent",
        name: "agent",
        projectName: "proj",
        projectPath: "/proj",
        createdAt: "2025-01-01T00:00:00.000Z",
        parentWorkspaceId,
        agentType: "research",
        taskStatus: "running",
        taskModel: "openai:gpt-5-codex",
      };

      const projects = new Map([
        [
          "/proj",
          {
            workspaces: [workspace],
          },
        ],
      ]);

      let idCounter = 0;
      const config = {
        generateStableId: () => `id-${idCounter++}`,
        getTaskSettings: () => ({
          maxParallelAgentTasks: 3,
          maxTaskNestingDepth: 3,
        }),
        listWorkspaceConfigs: () => [{ projectPath: "/proj", workspace }],
        getWorkspaceConfig: (id: string) => {
          if (id !== childWorkspaceId) {
            return null;
          }

          return { projectPath: "/proj", workspace };
        },
        editConfig: (edit: (cfg: unknown) => unknown) => {
          edit({ projects });
        },
      };

      const histories = new Map<string, MuxMessage[]>([
        [
          childWorkspaceId,
          [
            {
              id: "assistant-1",
              role: "assistant",
              parts: [{ type: "text", text: "partial output" }],
              metadata: {
                historySequence: 1,
              },
            },
          ],
        ],
        [parentWorkspaceId, []],
      ]);

      const historyService = {
        getHistory: (workspaceId: string) => Ok(histories.get(workspaceId) ?? []),
        appendToHistory: (workspaceId: string, message: MuxMessage) => {
          const list = histories.get(workspaceId) ?? [];
          list.push(message);
          histories.set(workspaceId, list);
          return Ok(undefined);
        },
      };

      const partialService = {
        readPartial: () => null,
        writePartial: () => Ok(undefined),
      };

      const removed: string[] = [];
      const workspaceService = {
        emitChatEvent: (_workspaceId: string, _event: unknown) => undefined,
        emitWorkspaceMetadata: (_workspaceId: string) => undefined,
        resumeStream: () => Err({ type: "api_key_not_found", provider: "openai" }),
        remove: (workspaceId: string, _force?: boolean) => {
          removed.push(workspaceId);
          return Ok(undefined);
        },
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

      await (service as unknown as { onStreamEnd: (id: string) => Promise<void> }).onStreamEnd(
        childWorkspaceId
      );

      expect(workspace.taskStatus).toBe("reported");
      expect(removed).toEqual([childWorkspaceId]);

      const parentHistory = histories.get(parentWorkspaceId) ?? [];
      expect(parentHistory).toHaveLength(1);

      const reportText = parentHistory[0].parts.find((p) => p.type === "text")?.text;
      expect(reportText).toBeDefined();
      expect(reportText).toContain("Mux was unable to resume this agent task");
      expect(reportText).toContain("partial output");
    });
  });
});
