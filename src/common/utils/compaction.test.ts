/**
 * Tests for compaction utilities
 */

import { createCompactionRequest, applyCompactionOverrides } from "./compaction";
import type { SendMessageOptions } from "@/common/types/ipc";
import type { CompactionRequestData } from "@/common/types/message";
import { KNOWN_MODELS } from "@/common/constants/knownModels";

describe("applyCompactionOverrides", () => {
  const baseOptions: SendMessageOptions = {
    model: KNOWN_MODELS.SONNET.id,
    thinkingLevel: "medium",
    toolPolicy: [],
    mode: "exec",
  };

  it("uses workspace model when no override specified", () => {
    const compactData: CompactionRequestData = {};
    const result = applyCompactionOverrides(baseOptions, compactData);

    expect(result.model).toBe(KNOWN_MODELS.SONNET.id);
    expect(result.mode).toBe("compact");
  });

  it("applies custom model override", () => {
    const compactData: CompactionRequestData = {
      model: KNOWN_MODELS.HAIKU.id,
    };
    const result = applyCompactionOverrides(baseOptions, compactData);

    expect(result.model).toBe(KNOWN_MODELS.HAIKU.id);
  });

  it("preserves workspace thinking level for all models", () => {
    // Test Anthropic model
    const anthropicData: CompactionRequestData = {
      model: KNOWN_MODELS.HAIKU.id,
    };
    const anthropicResult = applyCompactionOverrides(baseOptions, anthropicData);
    expect(anthropicResult.thinkingLevel).toBe("medium");

    // Test OpenAI model
    const openaiData: CompactionRequestData = {
      model: "openai:gpt-5-pro",
    };
    const openaiResult = applyCompactionOverrides(baseOptions, openaiData);
    expect(openaiResult.thinkingLevel).toBe("medium");
  });

  it("applies maxOutputTokens override", () => {
    const compactData: CompactionRequestData = {
      maxOutputTokens: 8000,
    };
    const result = applyCompactionOverrides(baseOptions, compactData);

    expect(result.maxOutputTokens).toBe(8000);
  });

  it("sets compact mode and disables all tools", () => {
    const compactData: CompactionRequestData = {};
    const result = applyCompactionOverrides(baseOptions, compactData);

    expect(result.mode).toBe("compact");
    expect(result.toolPolicy).toEqual([]);
  });

  it("disables all tools even when base options has tool policy", () => {
    const baseWithTools: SendMessageOptions = {
      ...baseOptions,
      toolPolicy: [{ regex_match: "bash", action: "enable" }],
    };
    const compactData: CompactionRequestData = {};
    const result = applyCompactionOverrides(baseWithTools, compactData);

    expect(result.mode).toBe("compact");
    expect(result.toolPolicy).toEqual([]); // Tools always disabled for compaction
  });

  it("applies all overrides together", () => {
    const compactData: CompactionRequestData = {
      model: KNOWN_MODELS.GPT.id,
      maxOutputTokens: 5000,
    };
    const result = applyCompactionOverrides(baseOptions, compactData);

    expect(result.model).toBe(KNOWN_MODELS.GPT.id);
    expect(result.maxOutputTokens).toBe(5000);
    expect(result.mode).toBe("compact");
    expect(result.thinkingLevel).toBe("medium"); // Non-Anthropic preserves original
  });
});

describe("createCompactionRequest", () => {
  const baseOptions: SendMessageOptions = {
    model: KNOWN_MODELS.SONNET.id,
    thinkingLevel: "medium",
    toolPolicy: [{ regex_match: "bash", action: "enable" }],
    mode: "exec",
    maxOutputTokens: 4000,
  };

  it("creates request with proper overrides applied", () => {
    const result = createCompactionRequest({
      baseOptions,
      rawCommand: "/compact",
    });

    expect(result.messageText).toContain("Summarize this conversation");
    expect(result.sendOptions.mode).toBe("compact");
    expect(result.sendOptions.toolPolicy).toEqual([]);
    expect(result.sendOptions.model).toBe(KNOWN_MODELS.SONNET.id);
    expect(result.sendOptions.muxMetadata).toBeDefined();
    expect(result.metadata.type).toBe("compaction-request");
    
    if (result.metadata.type === "compaction-request") {
      expect(result.metadata.parsed).toBeDefined();
    }
  });

  it("includes continue message in request text", () => {
    const result = createCompactionRequest({
      baseOptions,
      continueMessage: { text: "Fix the bug" },
      rawCommand: "/compact\nFix the bug",
    });

    expect(result.messageText).toContain("Fix the bug");
    
    if (result.metadata.type === "compaction-request") {
      expect(result.metadata.parsed.continueMessage).toEqual({ text: "Fix the bug" });
    }
  });

  it("includes images in continue message metadata", () => {
    const imageParts = [
      { url: "data:image/png;base64,base64data", mediaType: "image/png" },
    ];

    const result = createCompactionRequest({
      baseOptions,
      continueMessage: { text: "Analyze this", imageParts },
      rawCommand: "/compact\nAnalyze this",
    });

    if (result.metadata.type === "compaction-request") {
      expect(result.metadata.parsed.continueMessage?.text).toBe("Analyze this");
      expect(result.metadata.parsed.continueMessage?.imageParts).toEqual(imageParts);
    }
  });

  it("applies custom maxOutputTokens override", () => {
    const customOptions = { ...baseOptions, maxOutputTokens: 8000 };

    const result = createCompactionRequest({
      baseOptions: customOptions,
      rawCommand: "/compact -t 8000",
    });

    expect(result.sendOptions.maxOutputTokens).toBe(8000);
    
    if (result.metadata.type === "compaction-request") {
      expect(result.metadata.parsed.maxOutputTokens).toBe(8000);
    }
    // Word target should be approximately maxOutputTokens / 1.3
    expect(result.messageText).toContain("6154 words"); // Math.round(8000 / 1.3)
  });

  it("applies custom model override", () => {
    const customOptions = { ...baseOptions, model: KNOWN_MODELS.HAIKU.id };

    const result = createCompactionRequest({
      baseOptions: customOptions,
      rawCommand: "/compact -m haiku",
    });

    expect(result.sendOptions.model).toBe(KNOWN_MODELS.HAIKU.id);
    
    if (result.metadata.type === "compaction-request") {
      expect(result.metadata.parsed.model).toBe(KNOWN_MODELS.HAIKU.id);
    }
  });

  it("preserves thinking level from base options", () => {
    const result = createCompactionRequest({
      baseOptions,
      rawCommand: "/compact",
    });

    expect(result.sendOptions.thinkingLevel).toBe("medium");
  });

  it("stores raw command in metadata", () => {
    const rawCommand = "/compact -m haiku -t 5000\nContinue debugging";

    const result = createCompactionRequest({
      baseOptions,
      continueMessage: { text: "Continue debugging" },
      rawCommand,
    });

    if (result.metadata.type === "compaction-request") {
      expect(result.metadata.rawCommand).toBe(rawCommand);
    }
  });

  it("attaches metadata to sendOptions", () => {
    const result = createCompactionRequest({
      baseOptions,
      rawCommand: "/compact",
    });

    expect(result.sendOptions.muxMetadata).toBe(result.metadata);
  });

  it("uses default word target when no maxOutputTokens specified", () => {
    const optionsWithoutMax = { ...baseOptions };
    delete optionsWithoutMax.maxOutputTokens;

    const result = createCompactionRequest({
      baseOptions: optionsWithoutMax,
      rawCommand: "/compact",
    });

    // Default should be approximately 2000 words
    expect(result.messageText).toContain("2000 words");
  });
});
