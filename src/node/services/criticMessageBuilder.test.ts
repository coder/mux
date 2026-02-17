import { describe, expect, test } from "bun:test";

import {
  buildActorRequestHistoryWithCriticFeedback,
  isCriticDoneResponse,
} from "./criticMessageBuilder";
import { createMuxMessage, type MuxMessage } from "@/common/types/message";
import type { CompletedMessagePart } from "@/common/types/stream";

function textPart(text: string): CompletedMessagePart {
  return { type: "text", text };
}

function reasoningPart(text: string): CompletedMessagePart {
  return { type: "reasoning", text };
}

describe("isCriticDoneResponse", () => {
  test("returns true when visible text is exactly /done", () => {
    expect(isCriticDoneResponse([textPart("/done")])).toBe(true);
  });

  test("returns true when reasoning is present but text is exactly /done", () => {
    expect(isCriticDoneResponse([reasoningPart("thinking"), textPart("/done")])).toBe(true);
  });

  test("returns false when text is not exactly /done", () => {
    expect(isCriticDoneResponse([reasoningPart("thinking"), textPart("/done later")])).toBe(false);
  });

  test("returns false when no text part is present", () => {
    expect(isCriticDoneResponse([reasoningPart("/done")])).toBe(false);
  });
});

function getTextContent(message: MuxMessage): string {
  return message.parts
    .filter((part): part is Extract<MuxMessage["parts"][number], { type: "text" }> => {
      return part.type === "text";
    })
    .map((part) => part.text)
    .join("");
}

describe("buildActorRequestHistoryWithCriticFeedback", () => {
  test("drops critic /done with reasoning from future actor context", () => {
    const history = [
      createMuxMessage("user-1", "user", "Implement feature"),
      createMuxMessage("actor-1", "assistant", "Actor draft", {
        messageSource: "actor",
      }),
      createMuxMessage(
        "critic-1",
        "assistant",
        "/done",
        {
          messageSource: "critic",
        },
        [{ type: "reasoning", text: "Checked invariants." }]
      ),
    ];

    const transformed = buildActorRequestHistoryWithCriticFeedback(history);
    expect(transformed).toHaveLength(2);
    expect(transformed.some((message) => message.id === "critic-1")).toBe(false);
  });

  test("keeps non-/done critic feedback as a user-context message", () => {
    const history = [
      createMuxMessage("user-1", "user", "Implement feature"),
      createMuxMessage("actor-1", "assistant", "Actor draft", {
        messageSource: "actor",
      }),
      createMuxMessage(
        "critic-1",
        "assistant",
        "Add edge-case coverage.",
        {
          messageSource: "critic",
        },
        [{ type: "reasoning", text: "Missing empty-input branch." }]
      ),
    ];

    const transformed = buildActorRequestHistoryWithCriticFeedback(history);
    expect(transformed).toHaveLength(3);

    const criticFeedback = transformed[2];
    if (!criticFeedback) {
      throw new Error("Expected critic feedback message");
    }
    expect(criticFeedback.role).toBe("user");
    expect(getTextContent(criticFeedback)).toContain("Add edge-case coverage.");
  });
});
