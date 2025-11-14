import { beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";

import {
  __resetTokenizerForTests,
  countTokens,
  countTokensBatch,
  getTokenizerForModel,
  loadTokenizerModules,
} from "./tokenizer";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

jest.setTimeout(20000);

const model = KNOWN_MODELS.GPT.id;
beforeAll(async () => {
  // warm up the worker_thread and tokenizer before running tests
  await expect(loadTokenizerModules([model])).resolves.toHaveLength(1);
});

beforeEach(() => {
  __resetTokenizerForTests();
});

describe("tokenizer", () => {
  test("loadTokenizerModules warms known encodings", async () => {
    const tokenizer = await getTokenizerForModel(model);
    expect(typeof tokenizer.encoding).toBe("string");
    expect(tokenizer.encoding.length).toBeGreaterThan(0);
  });

  test("countTokens returns stable values", async () => {
    const text = "mux-tokenizer-smoke-test";
    const first = await countTokens(model, text);
    const second = await countTokens(model, text);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(first);
  });

  test("countTokensBatch matches individual calls", async () => {
    const texts = ["alpha", "beta", "gamma"];
    const batch = await countTokensBatch(model, texts);
    expect(batch).toHaveLength(texts.length);

    const individual = await Promise.all(texts.map((text) => countTokens(model, text)));
    expect(batch).toEqual(individual);
  });
});
