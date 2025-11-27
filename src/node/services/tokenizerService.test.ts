import { describe, expect, test, spyOn } from "bun:test";
import { TokenizerService } from "./tokenizerService";
import * as tokenizerUtils from "@/node/utils/main/tokenizer";
import * as statsUtils from "@/common/utils/tokens/tokenStatsCalculator";

describe("TokenizerService", () => {
  const service = new TokenizerService();

  describe("countTokens", () => {
    test("delegates to underlying function", async () => {
      const spy = spyOn(tokenizerUtils, "countTokens").mockResolvedValue(42);

      const result = await service.countTokens("gpt-4", "hello world");
      expect(result).toBe(42);
      expect(spy).toHaveBeenCalledWith("gpt-4", "hello world");
      spy.mockRestore();
    });

    test("throws on empty model", () => {
      expect(service.countTokens("", "text")).rejects.toThrow("requires model name");
    });

    test("throws on invalid text", () => {
      // @ts-expect-error testing runtime validation
      expect(service.countTokens("gpt-4", null)).rejects.toThrow("requires text");
    });
  });

  describe("countTokensBatch", () => {
    test("delegates to underlying function", async () => {
      const spy = spyOn(tokenizerUtils, "countTokensBatch").mockResolvedValue([10, 20]);

      const result = await service.countTokensBatch("gpt-4", ["a", "b"]);
      expect(result).toEqual([10, 20]);
      expect(spy).toHaveBeenCalledWith("gpt-4", ["a", "b"]);
      spy.mockRestore();
    });

    test("throws on non-array input", () => {
      // @ts-expect-error testing runtime validation
      expect(service.countTokensBatch("gpt-4", "not-array")).rejects.toThrow("requires an array");
    });
  });

  describe("calculateStats", () => {
    test("delegates to underlying function", async () => {
      const mockResult = {
        consumers: [],
        totalTokens: 100,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const spy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);

      const result = await service.calculateStats([], "gpt-4");
      expect(result).toBe(mockResult);
      expect(spy).toHaveBeenCalledWith([], "gpt-4");
      spy.mockRestore();
    });

    test("throws on invalid messages", () => {
      // @ts-expect-error testing runtime validation
      expect(service.calculateStats(null, "gpt-4")).rejects.toThrow("requires an array");
    });
  });
});
