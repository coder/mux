import assert from "node:assert/strict";
import type {
  AgentSideConnection,
  SessionUpdate,
  ToolCallContent,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type { WorkspaceChatMessage } from "../../common/orpc/types";

interface ActiveToolCall {
  messageId: string;
  toolName: string;
}

type AgentMessageChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_message_chunk" }>;
type AgentThoughtChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "agent_thought_chunk" }>;
type UserMessageChunkUpdate = Extract<SessionUpdate, { sessionUpdate: "user_message_chunk" }>;
type ToolCallUpdateSessionUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call_update" }>;

export class StreamTranslator {
  private readonly activeToolCalls = new Map<string, string[]>();
  private readonly toolCallsById = new Map<string, ActiveToolCall>();

  constructor(private readonly connection: AgentSideConnection) {
    assert(connection != null, "StreamTranslator: connection is required");
  }

  /**
   * Consume the MUX chat stream and forward events as ACP session updates.
   * Returns a promise that resolves when the stream ends or errors.
   */
  async consumeAndForward(
    sessionId: string,
    chatStream: AsyncIterable<WorkspaceChatMessage>
  ): Promise<void> {
    assert(
      typeof sessionId === "string" && sessionId.trim().length > 0,
      "consumeAndForward: sessionId must be non-empty"
    );
    assert(chatStream != null, "consumeAndForward: chatStream is required");

    for await (const event of chatStream) {
      const updates = this.translateEvent(event);
      for (const update of updates) {
        await this.connection.sessionUpdate({ sessionId, update });
      }
    }
  }

  private translateEvent(event: WorkspaceChatMessage): SessionUpdate[] {
    switch (event.type) {
      case "stream-delta":
        return this.toSingleChunkUpdate("agent_message_chunk", event.delta);

      case "reasoning-delta":
        return this.toSingleChunkUpdate("agent_thought_chunk", event.delta);

      case "tool-call-start": {
        this.registerToolCall(event.messageId, event.toolCallId, event.toolName);
        return [
          {
            sessionUpdate: "tool_call",
            toolCallId: event.toolCallId,
            title: event.toolName,
            kind: inferToolKind(event.toolName),
            rawInput: event.args,
            status: "in_progress",
          },
        ];
      }

      case "tool-call-delta": {
        if (!this.toolCallsById.has(event.toolCallId)) {
          this.registerToolCall(event.messageId, event.toolCallId, event.toolName);
        }
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            title: event.toolName,
            kind: inferToolKind(event.toolName),
            rawInput: event.delta,
            status: "in_progress",
          },
        ];
      }

      case "tool-call-end": {
        this.unregisterToolCall(event.toolCallId);
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            title: event.toolName,
            kind: inferToolKind(event.toolName),
            rawOutput: event.result,
            content: this.asToolOutputContent(event.result),
            status: "completed",
          },
        ];
      }

      case "bash-output": {
        const outputText = event.isError ? `[stderr] ${event.text}` : event.text;
        return [
          {
            sessionUpdate: "tool_call_update",
            toolCallId: event.toolCallId,
            status: "in_progress",
            content: [textToolContent(outputText)],
            _meta: {
              isError: event.isError,
              source: "bash-output",
              phase: event.phase,
              timestamp: event.timestamp,
            },
          },
        ];
      }

      case "error":
        return this.translateToolFailure(event.messageId, event.error, event.errorType);

      case "stream-error":
        return this.translateToolFailure(event.messageId, event.error, event.errorType);

      case "message":
        return this.translateReplayMessage(event);

      case "stream-end":
      case "stream-abort":
        this.clearMessageToolCalls(event.messageId);
        return [];

      // Informational/no-op events for ACP stream output.
      case "heartbeat":
      case "caught-up":
      case "stream-start":
      case "reasoning-end":
      case "delete":
      case "task-created":
      case "usage-delta":
      case "session-usage-delta":
      case "queued-message-changed":
      case "restore-to-input":
      case "idle-compaction-needed":
      case "runtime-status":
      case "init-start":
      case "init-output":
      case "init-end":
        return [];

      default:
        return [];
    }
  }

  private translateReplayMessage(
    event: Extract<WorkspaceChatMessage, { type: "message" }>
  ): SessionUpdate[] {
    const updates: SessionUpdate[] = [];

    if (event.role === "assistant") {
      for (const part of event.parts) {
        if (part.type === "text") {
          updates.push(...this.toSingleChunkUpdate("agent_message_chunk", part.text));
          continue;
        }

        if (part.type === "reasoning") {
          updates.push(...this.toSingleChunkUpdate("agent_thought_chunk", part.text));
          continue;
        }

        if (part.type !== "dynamic-tool") {
          continue;
        }

        this.registerToolCall(event.id, part.toolCallId, part.toolName);
        updates.push({
          sessionUpdate: "tool_call",
          toolCallId: part.toolCallId,
          title: part.toolName,
          kind: inferToolKind(part.toolName),
          rawInput: part.input,
          status: "in_progress",
        });

        if (part.state === "output-available") {
          this.unregisterToolCall(part.toolCallId);
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            title: part.toolName,
            kind: inferToolKind(part.toolName),
            rawOutput: part.output,
            content: this.asToolOutputContent(part.output),
            status: "completed",
          });
        }

        if (part.state === "output-redacted") {
          this.unregisterToolCall(part.toolCallId);
          const redactionMessage = part.failed
            ? "Tool output was redacted because the tool failed."
            : "Tool output was redacted.";
          updates.push({
            sessionUpdate: "tool_call_update",
            toolCallId: part.toolCallId,
            title: part.toolName,
            kind: inferToolKind(part.toolName),
            status: part.failed ? "failed" : "completed",
            content: [textToolContent(redactionMessage)],
          });
        }
      }

      return updates;
    }

    if (event.role === "user") {
      for (const part of event.parts) {
        if (part.type !== "text") {
          continue;
        }
        updates.push(...this.toSingleChunkUpdate("user_message_chunk", part.text));
      }
    }

    return updates;
  }

  private translateToolFailure(
    messageId: string,
    error: string,
    errorType?: string
  ): SessionUpdate[] {
    const activeToolCallId = this.getLatestActiveToolCallId(messageId);
    if (activeToolCallId == null) {
      return [];
    }

    const toolState = this.toolCallsById.get(activeToolCallId);
    this.unregisterToolCall(activeToolCallId);

    const update: ToolCallUpdateSessionUpdate = {
      sessionUpdate: "tool_call_update",
      toolCallId: activeToolCallId,
      title: toolState?.toolName,
      kind: inferToolKind(toolState?.toolName ?? "other"),
      status: "failed",
      content: [textToolContent(error)],
    };

    if (errorType != null) {
      update._meta = { errorType };
    }

    return [update];
  }

  private toSingleChunkUpdate(
    chunkType:
      | AgentMessageChunkUpdate["sessionUpdate"]
      | AgentThoughtChunkUpdate["sessionUpdate"]
      | UserMessageChunkUpdate["sessionUpdate"],
    text: string
  ): SessionUpdate[] {
    // Preserve whitespace-only chunks — providers emit standalone spaces and
    // newlines (e.g., indentation, blank lines) that are significant for output
    // formatting.  Only skip truly empty strings.
    if (text.length === 0) {
      return [];
    }

    if (chunkType === "agent_message_chunk") {
      const update: AgentMessageChunkUpdate = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      };
      return [update];
    }

    if (chunkType === "agent_thought_chunk") {
      const update: AgentThoughtChunkUpdate = {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text },
      };
      return [update];
    }

    const update: UserMessageChunkUpdate = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    };
    return [update];
  }

  private asToolOutputContent(rawOutput: unknown): ToolCallContent[] | undefined {
    const text = stringifyToolOutput(rawOutput);
    if (text == null) {
      return undefined;
    }
    return [textToolContent(text)];
  }

  private registerToolCall(messageId: string, toolCallId: string, toolName: string): void {
    assert(messageId.trim().length > 0, "registerToolCall: messageId must be non-empty");
    assert(toolCallId.trim().length > 0, "registerToolCall: toolCallId must be non-empty");
    assert(toolName.trim().length > 0, "registerToolCall: toolName must be non-empty");

    this.toolCallsById.set(toolCallId, { messageId, toolName });

    const existing = this.activeToolCalls.get(messageId);
    if (existing == null) {
      this.activeToolCalls.set(messageId, [toolCallId]);
      return;
    }

    if (!existing.includes(toolCallId)) {
      existing.push(toolCallId);
    }
  }

  private unregisterToolCall(toolCallId: string): void {
    const tool = this.toolCallsById.get(toolCallId);
    if (tool == null) {
      return;
    }

    const activeForMessage = this.activeToolCalls.get(tool.messageId);
    if (activeForMessage != null) {
      const filtered = activeForMessage.filter((id) => id !== toolCallId);
      if (filtered.length === 0) {
        this.activeToolCalls.delete(tool.messageId);
      } else {
        this.activeToolCalls.set(tool.messageId, filtered);
      }
    }

    this.toolCallsById.delete(toolCallId);
  }

  private clearMessageToolCalls(messageId: string): void {
    const activeForMessage = this.activeToolCalls.get(messageId);
    if (activeForMessage == null) {
      return;
    }

    for (const toolCallId of activeForMessage) {
      this.toolCallsById.delete(toolCallId);
    }

    this.activeToolCalls.delete(messageId);
  }

  private getLatestActiveToolCallId(messageId: string): string | undefined {
    const activeForMessage = this.activeToolCalls.get(messageId);
    if (activeForMessage == null || activeForMessage.length === 0) {
      return undefined;
    }

    for (let i = activeForMessage.length - 1; i >= 0; i--) {
      const toolCallId = activeForMessage[i];
      if (toolCallId != null && this.toolCallsById.has(toolCallId)) {
        return toolCallId;
      }
    }

    return undefined;
  }
}

function inferToolKind(toolName: string): ToolKind {
  const normalized = toolName.toLowerCase();

  if (normalized.startsWith("terminal/") || normalized === "bash" || normalized.includes("exec")) {
    return "execute";
  }

  if (
    normalized.startsWith("fs/read") ||
    normalized.startsWith("file_read") ||
    normalized.includes("read")
  ) {
    return "read";
  }

  if (
    normalized.startsWith("fs/write") ||
    normalized.startsWith("file_write") ||
    normalized.includes("edit") ||
    normalized.includes("replace")
  ) {
    return "edit";
  }

  if (normalized.includes("delete") || normalized.includes("remove")) {
    return "delete";
  }

  if (normalized.includes("move") || normalized.includes("rename")) {
    return "move";
  }

  if (normalized.includes("search") || normalized.includes("find") || normalized.includes("grep")) {
    return "search";
  }

  if (normalized.includes("fetch") || normalized.includes("web")) {
    return "fetch";
  }

  return "other";
}

function textToolContent(text: string): ToolCallContent {
  return {
    type: "content",
    content: { type: "text", text },
  };
}

function stringifyToolOutput(output: unknown): string | null {
  if (output == null) {
    return null;
  }

  if (typeof output === "string") {
    return output.length > 0 ? output : null;
  }

  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return String(output);
  }

  try {
    const serialized = JSON.stringify(output, null, 2);
    return serialized == null || serialized.length === 0 ? null : serialized;
  } catch {
    return output instanceof Error ? output.message : "[Unserializable tool output]";
  }
}
