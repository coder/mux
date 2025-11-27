import { describe, expect, test } from "bun:test";
import { formatModelDisplayName } from "./modelDisplay";

describe("formatModelDisplayName", () => {
  describe("Claude models", () => {
    test("formats Sonnet models", () => {
      expect(formatModelDisplayName("claude-sonnet-4-5")).toBe("Sonnet 4.5");
      expect(formatModelDisplayName("claude-sonnet-4")).toBe("Sonnet 4");
    });

    test("formats Opus models", () => {
      expect(formatModelDisplayName("claude-opus-4-1")).toBe("Opus 4.1");
    });
  });

  describe("GPT models", () => {
    test("formats GPT models", () => {
      expect(formatModelDisplayName("gpt-5-pro")).toBe("GPT-5 Pro");
      expect(formatModelDisplayName("gpt-4o")).toBe("GPT-4o");
      expect(formatModelDisplayName("gpt-4o-mini")).toBe("GPT-4o Mini");
    });
  });

  describe("Gemini models", () => {
    test("formats Gemini models", () => {
      expect(formatModelDisplayName("gemini-2-0-flash-exp")).toBe("Gemini 2.0 Flash Exp");
    });
  });

  describe("Ollama models", () => {
    test("formats Llama models with size", () => {
      expect(formatModelDisplayName("llama3.2:7b")).toBe("Llama 3.2 (7B)");
      expect(formatModelDisplayName("llama3.2:13b")).toBe("Llama 3.2 (13B)");
    });

    test("formats Codellama models with size", () => {
      expect(formatModelDisplayName("codellama:7b")).toBe("Codellama (7B)");
      expect(formatModelDisplayName("codellama:13b")).toBe("Codellama (13B)");
    });

    test("formats Qwen models with size", () => {
      expect(formatModelDisplayName("qwen2.5:7b")).toBe("Qwen 2.5 (7B)");
    });

    test("handles models without size suffix", () => {
      expect(formatModelDisplayName("llama3")).toBe("Llama3");
    });
  });

  describe("Bedrock models", () => {
    test("formats Anthropic Claude models from Bedrock", () => {
      expect(formatModelDisplayName("global.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe(
        "Sonnet 4.5"
      );
      expect(formatModelDisplayName("us.anthropic.claude-opus-4-20250514-v1:0")).toBe("Opus 4");
      expect(formatModelDisplayName("anthropic.claude-3-5-sonnet-20240620-v1:0")).toBe(
        "Sonnet 3.5"
      );
    });

    test("formats Amazon Titan models from Bedrock", () => {
      expect(formatModelDisplayName("amazon.titan-text-premier-v1:0")).toBe("Titan Text Premier");
    });
  });

  describe("fallback formatting", () => {
    test("capitalizes dash-separated parts", () => {
      expect(formatModelDisplayName("custom-model-name")).toBe("Custom Model Name");
    });
  });
});
