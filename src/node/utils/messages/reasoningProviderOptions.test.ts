import { describe, expect, test } from "bun:test";

import type { MuxMessage, MuxReasoningPart } from "@/common/types/message";
import {
  attachReasoningReplayMetadata,
  findFirstReasoningPartIndexInTrailingRun,
  mergeReasoningProviderOptions,
  reasoningProviderOptionsFromMetadata,
} from "./reasoningProviderOptions";

describe("reasoningProviderOptionsFromMetadata", () => {
  test("maps Anthropic signatures", () => {
    expect(reasoningProviderOptionsFromMetadata({ anthropic: { signature: "sig_abc" } })).toEqual({
      anthropic: { signature: "sig_abc" },
    });
  });

  test("maps xAI encrypted reasoning used for ZDR multi-turn quality", () => {
    expect(
      reasoningProviderOptionsFromMetadata({
        xai: {
          itemId: "rs_1",
          reasoningEncryptedContent: "enc_blob",
        },
      })
    ).toEqual({
      xai: {
        itemId: "rs_1",
        reasoningEncryptedContent: "enc_blob",
      },
    });
  });

  test("maps OpenAI encrypted reasoning the same way", () => {
    expect(
      reasoningProviderOptionsFromMetadata({
        openai: {
          itemId: "rs_oai",
          reasoningEncryptedContent: "enc_oai",
        },
      })
    ).toEqual({
      openai: {
        itemId: "rs_oai",
        reasoningEncryptedContent: "enc_oai",
      },
    });
  });

  test("maps Google thought signatures", () => {
    expect(
      reasoningProviderOptionsFromMetadata({ google: { thoughtSignature: "ts_1" } })
    ).toEqual({
      google: { thoughtSignature: "ts_1" },
    });
  });

  test("returns undefined when metadata is empty", () => {
    expect(reasoningProviderOptionsFromMetadata(undefined)).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({})).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({ xai: {} })).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({ google: {} })).toBeUndefined();
  });
});

describe("mergeReasoningProviderOptions", () => {
  test("merges itemId from start with encrypted content from end", () => {
    expect(
      mergeReasoningProviderOptions(
        { xai: { itemId: "rs_1" } },
        { xai: { reasoningEncryptedContent: "enc_blob" } }
      )
    ).toEqual({
      xai: {
        itemId: "rs_1",
        reasoningEncryptedContent: "enc_blob",
      },
    });
  });
});

describe("attachReasoningReplayMetadata", () => {
  function assistantMessage(parts: MuxMessage["parts"]): MuxMessage {
    return { id: "a1", role: "assistant", metadata: { timestamp: 1 }, parts };
  }

  function reasoningParts(message: MuxMessage): Array<MuxReasoningPart & Record<string, unknown>> {
    return message.parts.filter(
      (part): part is MuxReasoningPart & Record<string, unknown> => part.type === "reasoning"
    );
  }

  test("mirrors providerOptions into providerMetadata", () => {
    const input = assistantMessage([
      {
        type: "reasoning",
        text: "thinking",
        providerOptions: { openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" } },
      },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      openai: { itemId: "rs_1", reasoningEncryptedContent: "enc" },
    });
  });

  test("bridges the legacy top-level signature field from old histories", () => {
    const input = assistantMessage([{ type: "reasoning", text: "old", signature: "legacy_sig" }]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      anthropic: { signature: "legacy_sig" },
    });
  });

  test("providerOptions wins over the legacy signature on conflict", () => {
    const input = assistantMessage([
      {
        type: "reasoning",
        text: "both",
        signature: "stale_sig",
        providerOptions: { anthropic: { signature: "fresh_sig" } },
      },
    ]);

    const [output] = attachReasoningReplayMetadata([input]);

    expect(reasoningParts(output)[0].providerMetadata).toEqual({
      anthropic: { signature: "fresh_sig" },
    });
  });

  test("leaves messages without replay data untouched (same reference)", () => {
    const noReplay = assistantMessage([
      { type: "reasoning", text: "unsigned" },
      { type: "text", text: "answer" },
    ]);
    const user: MuxMessage = {
      id: "u1",
      role: "user",
      metadata: { timestamp: 0 },
      parts: [{ type: "text", text: "hi" }],
    };

    const output = attachReasoningReplayMetadata([user, noReplay]);

    expect(output[0]).toBe(user);
    expect(output[1]).toBe(noReplay);
  });

  test("does not mutate the input parts", () => {
    const part: MuxReasoningPart = {
      type: "reasoning",
      text: "thinking",
      providerOptions: { anthropic: { signature: "sig" } },
    };
    const input = assistantMessage([part]);

    attachReasoningReplayMetadata([input]);

    expect("providerMetadata" in part).toBe(false);
  });
});

describe("findFirstReasoningPartIndexInTrailingRun", () => {
  test("returns the first reasoning part in a trailing run of deltas", () => {
    const parts = [
      { type: "text" },
      { type: "reasoning" },
      { type: "reasoning" },
      { type: "reasoning" },
    ];
    expect(findFirstReasoningPartIndexInTrailingRun(parts)).toBe(1);
  });

  test("returns -1 when the trailing part is not reasoning", () => {
    expect(
      findFirstReasoningPartIndexInTrailingRun([{ type: "reasoning" }, { type: "text" }])
    ).toBe(-1);
  });
});
