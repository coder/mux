import { describe, expect, test } from "bun:test";

import {
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

  test("returns undefined when metadata is empty", () => {
    expect(reasoningProviderOptionsFromMetadata(undefined)).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({})).toBeUndefined();
    expect(reasoningProviderOptionsFromMetadata({ xai: {} })).toBeUndefined();
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
