import { beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";

import {
  __resetTokenizerForTests,
  countTokens,
  countTokensBatch,
  countTokensForData,
  getTokenizerForModel,
  loadTokenizerModules,
  type Tokenizer,
} from "./tokenizer";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

jest.setTimeout(20000);

const openaiModel = KNOWN_MODELS.GPT.id;
const googleModel = KNOWN_MODELS.GEMINI_3_PRO.id;

beforeAll(async () => {
  // warm up the worker_thread and tokenizer before running tests
  const results = await loadTokenizerModules([openaiModel, googleModel]);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ status: "fulfilled" });
  expect(results[1]).toMatchObject({ status: "fulfilled" });
});

beforeEach(() => {
  __resetTokenizerForTests();
});

describe("tokenizer", () => {
  test("loadTokenizerModules warms known encodings", async () => {
    const tokenizer = await getTokenizerForModel(openaiModel);
    expect(typeof tokenizer.encoding).toBe("string");
    expect(tokenizer.encoding.length).toBeGreaterThan(0);
  });

  test("countTokens returns stable values", async () => {
    const text = "mux-tokenizer-smoke-test";
    const first = await countTokens(openaiModel, text);
    const second = await countTokens(openaiModel, text);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test("countTokensBatch matches individual calls", async () => {
    const texts = ["alpha", "beta", "gamma"];
    const batch = await countTokensBatch(openaiModel, texts);
    expect(batch).toHaveLength(texts.length);

    const individual = await Promise.all(texts.map((text) => countTokens(openaiModel, text)));
    expect(batch).toEqual(individual);
  });

  test("getTokenizerForModel supports google gemini 3 via override", async () => {
    const tokenizer = await getTokenizerForModel(googleModel);
    expect(typeof tokenizer.encoding).toBe("string");
    expect(tokenizer.encoding.length).toBeGreaterThan(0);
  });

  test("countTokensForData redacts base64 image payloads", async () => {
    const calls: string[] = [];
    const mockTokenizer: Tokenizer = {
      encoding: "test",
      countTokens: (text: string) => {
        calls.push(text);
        return Promise.resolve(text.length);
      },
    };

    const base64 = "A".repeat(50_000);
    await countTokensForData(
      {
        type: "content",
        value: [{ type: "media", mediaType: "image/png", data: base64 }],
      },
      mockTokenizer
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("[omitted image data");
    expect(calls[0]).not.toMatch(/[A]{1000,}/);
  });
  test("countTokens returns stable values for google gemini 3", async () => {
    const text = "mux-google-tokenizer-test";
    const first = await countTokens(googleModel, text);
    const second = await countTokens(googleModel, text);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });
});
