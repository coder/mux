import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import { TokenizerService } from "./tokenizerService";
import type { SessionUsageService } from "./sessionUsageService";
import * as tokenizerUtils from "@/node/utils/main/tokenizer";
import * as statsUtils from "@/common/utils/tokens/tokenStatsCalculator";
import { createMuxMessage } from "@/common/types/message";

describe("TokenizerService", () => {
  let sessionUsageService: SessionUsageService;
  let service: TokenizerService;

  beforeEach(() => {
    sessionUsageService = {
      setTokenStatsCache: () => Promise.resolve(),
    } as unknown as SessionUsageService;
    service = new TokenizerService(sessionUsageService);
  });

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
    test("delegates to underlying function and persists token stats cache", async () => {
      const messages = [
        createMuxMessage("msg1", "user", "Hello", { historySequence: 1 }),
        createMuxMessage("msg2", "assistant", "World", { historySequence: 2 }),
      ];

      const mockResult = {
        consumers: [{ name: "User", tokens: 100, percentage: 100 }],
        totalTokens: 100,
        model: "gpt-4",
        tokenizerName: "cl100k",
        usageHistory: [],
      };
      const statsSpy = spyOn(statsUtils, "calculateTokenStats").mockResolvedValue(mockResult);
      const persistSpy = spyOn(sessionUsageService, "setTokenStatsCache").mockResolvedValue(
        undefined
      );
      const nowSpy = spyOn(Date, "now").mockReturnValue(1234);

      const result = await service.calculateStats("test-workspace", messages, "gpt-4");
      expect(result).toBe(mockResult);
      expect(statsSpy).toHaveBeenCalledWith(messages, "gpt-4");
      expect(persistSpy).toHaveBeenCalledWith(
        "test-workspace",
        expect.objectContaining({
          version: 1,
          computedAt: 1234,
          model: "gpt-4",
          tokenizerName: "cl100k",
          totalTokens: 100,
          consumers: mockResult.consumers,
          history: { messageCount: 2, maxHistorySequence: 2 },
        })
      );

      nowSpy.mockRestore();
      statsSpy.mockRestore();
      persistSpy.mockRestore();
    });

    test("throws on invalid messages", () => {
      // @ts-expect-error testing runtime validation
      expect(service.calculateStats("test-workspace", null, "gpt-4")).rejects.toThrow(
        "requires an array"
      );
    });

    test("throws on empty workspaceId", () => {
      expect(service.calculateStats("", [], "gpt-4")).rejects.toThrow("requires workspaceId");
    });
  });
});
