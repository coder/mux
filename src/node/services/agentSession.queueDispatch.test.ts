import { describe, expect, test } from "bun:test";

import type { SendMessageOptions } from "@/common/orpc/types";
import { AgentSession } from "./agentSession";

describe("AgentSession tool-end queue semantics", () => {
  function hasToolEndQueuedWork(state: {
    messageQueue: {
      isEmpty: () => boolean;
      getQueueDispatchMode: () => "tool-end" | "turn-end" | null;
    };
    flowPromptUpdate?: unknown;
  }): boolean {
    return (
      AgentSession.prototype as unknown as {
        hasToolEndQueuedWork(this: {
          messageQueue: {
            isEmpty: () => boolean;
            getQueueDispatchMode: () => "tool-end" | "turn-end" | null;
          };
          flowPromptUpdate?: unknown;
        }): boolean;
      }
    ).hasToolEndQueuedWork.call(state);
  }

  test("ignores pending Flow Prompting saves while only turn-end user messages are queued", () => {
    expect(
      hasToolEndQueuedWork({
        messageQueue: {
          isEmpty: () => false,
          getQueueDispatchMode: () => "turn-end",
        },
        flowPromptUpdate: { message: "pending flow prompt" },
      })
    ).toBe(false);
  });

  test("restores dequeued Flow Prompting saves when dispatch fails", async () => {
    const state = {
      disposed: false,
      turnPhase: "idle",
      flowPromptUpdate: {
        message: "pending flow prompt",
        options: undefined,
        internal: undefined,
      },
      messageQueue: {
        isEmpty: () => true,
        getQueueDispatchMode: () => null,
      },
      setTurnPhase(phase: string) {
        this.turnPhase = phase;
      },
      syncQueuedMessageFlag() {
        // No-op for this focused dispatch test.
      },
      sendMessage: () => Promise.resolve({ success: false }),
    };

    (
      AgentSession.prototype as unknown as {
        sendQueuedMessages(this: typeof state): void;
      }
    ).sendQueuedMessages.call(state);

    await Promise.resolve();
    await Promise.resolve();

    expect(state.flowPromptUpdate).toBeTruthy();
    expect(state.turnPhase).toBe("idle");
  });

  test("does not report tool-end work when Flow Prompting is queued for turn end", () => {
    expect(
      hasToolEndQueuedWork({
        messageQueue: {
          isEmpty: () => true,
          getQueueDispatchMode: () => null,
        },
        flowPromptUpdate: {
          message: "pending flow prompt",
          options: { queueDispatchMode: "turn-end" },
        },
      })
    ).toBe(false);
  });

  test("still reports tool-end work when Flow Prompting explicitly targets tool end", () => {
    expect(
      hasToolEndQueuedWork({
        messageQueue: {
          isEmpty: () => true,
          getQueueDispatchMode: () => null,
        },
        flowPromptUpdate: {
          message: "pending flow prompt",
          options: { queueDispatchMode: "tool-end" },
        },
      })
    ).toBe(true);
  });
});

test("getFlowPromptSendOptions strips inherited fileParts from the active turn", async () => {
  const result = await (
    AgentSession.prototype as unknown as {
      getFlowPromptSendOptions(this: {
        workspaceId: string;
        activeStreamContext?: {
          modelString: string;
          options?: SendMessageOptions & {
            fileParts?: Array<{ url: string; mediaType: string; filename?: string }>;
          };
        };
        aiService: {
          getWorkspaceMetadata: () => Promise<unknown>;
        };
      }): Promise<
        SendMessageOptions & {
          fileParts?: Array<{ url: string; mediaType: string; filename?: string }>;
        }
      >;
    }
  ).getFlowPromptSendOptions.call({
    workspaceId: "workspace-1",
    activeStreamContext: {
      modelString: "openai:gpt-4o",
      options: {
        model: "anthropic:claude-3-5-sonnet-latest",
        agentId: "exec",
        thinkingLevel: "high",
        queueDispatchMode: "turn-end",
        muxMetadata: { type: "user-send" },
        fileParts: [
          {
            url: "file:///tmp/attachment.txt",
            mediaType: "text/plain",
            filename: "attachment.txt",
          },
        ],
      },
    },
    aiService: {
      getWorkspaceMetadata: () => Promise.reject(new Error("should not be called")),
    },
  });

  expect(result.model).toBe("openai:gpt-4o");
  expect(result.agentId).toBe("exec");
  expect(result.thinkingLevel).toBe("high");
  expect("fileParts" in result).toBe(false);
  expect("muxMetadata" in result).toBe(false);
  expect("queueDispatchMode" in result).toBe(false);
});
