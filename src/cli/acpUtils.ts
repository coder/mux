import type { ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";
import { isReasoningDelta, isStreamDelta, type WorkspaceChatMessage } from "@/common/orpc/types";

export function contentBlocksToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      const text = block.text.trimEnd();
      if (text.length > 0) {
        parts.push(text);
      }
      continue;
    }

    if (block.type === "resource_link") {
      const title = block.title?.trim() ? ` (${block.title.trim()})` : "";
      parts.push(`[resource] ${block.uri}${title}`);
      continue;
    }

    if (block.type === "resource") {
      // If the client provided embedded context, include it verbatim when it's text-based.
      // This keeps the bridge simple while still surfacing useful context to mux.
      const resource = block.resource;
      if ("text" in resource) {
        const uri = resource.uri.trim() ? ` ${resource.uri}` : "";
        parts.push(`[resource${uri}]\n${resource.text}`);
      } else {
        parts.push(`[resource] ${resource.uri}`);
      }
      continue;
    }

    // Unsupported by mux ACP bridge (image/audio). The client should only send these when enabled.
    parts.push(`[${block.type}]`);
  }

  return parts.join("\n\n").trim();
}

export function muxChatMessageToSessionUpdate(msg: WorkspaceChatMessage): SessionUpdate | null {
  if (isStreamDelta(msg)) {
    if (!msg.delta) {
      return null;
    }
    return {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: msg.delta,
      },
    };
  }

  if (isReasoningDelta(msg)) {
    if (!msg.delta) {
      return null;
    }
    return {
      sessionUpdate: "agent_thought_chunk",
      content: {
        type: "text",
        text: msg.delta,
      },
    };
  }

  return null;
}
