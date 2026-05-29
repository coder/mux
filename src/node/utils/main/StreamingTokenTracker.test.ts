import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import { KNOWN_MODELS } from "@/common/constants/knownModels";
import { StreamingTokenTracker } from "./StreamingTokenTracker";

jest.setTimeout(20000);

describe("StreamingTokenTracker", () => {
  let tracker: StreamingTokenTracker;

  beforeEach(() => {
    tracker = new StreamingTokenTracker();
  });

  describe("countTokens", () => {
    test("returns 0 for empty string", async () => {
      await tracker.setModel(KNOWN_MODELS.SONNET.id);
      expect(await tracker.countTokens("")).toBe(0);
    });

    test("counts tokens in simple text", async () => {
      await tracker.setModel(KNOWN_MODELS.SONNET.id);
      const count = await tracker.countTokens("Hello world");
      expect(count).toBeGreaterThan(0);
      expect(count).toBeLessThan(10); // Reasonable upper bound
    });

    test("counts tokens in longer text", async () => {
      await tracker.setModel(KNOWN_MODELS.SONNET.id);
      const text = "This is a longer piece of text with more tokens";
      const count = await tracker.countTokens(text);
      expect(count).toBeGreaterThan(5);
    });

    test("handles special characters", async () => {
      await tracker.setModel(KNOWN_MODELS.SONNET.id);
      const count = await tracker.countTokens("🚀 emoji test");
      expect(count).toBeGreaterThan(0);
    });

    test("is consistent for repeated calls", async () => {
      await tracker.setModel(KNOWN_MODELS.SONNET.id);
      const text = "Test consistency";
      const count1 = await tracker.countTokens(text);
      const count2 = await tracker.countTokens(text);
      expect(count1).toBe(count2);
    });
  });

  describe("setModel", () => {
    test("switches tokenizer for different models", async () => {
      await tracker.setModel(KNOWN_MODELS.SONNET.id);
      const initial = await tracker.countTokens("test");

      await tracker.setModel("openai:gpt-4");
      const switched = await tracker.countTokens("test");

      expect(initial).toBeGreaterThan(0);
      expect(switched).toBeGreaterThan(0);
    });
  });
});
