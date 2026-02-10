import { describe, expect, test } from "bun:test";
import {
  buildContinueMessage,
  normalizeCompactionFollowUpRequest,
  rebuildContinueMessage,
  type CompactionFollowUpRequest,
} from "./message";
import type { ReviewNoteData } from "./review";

// Helper to create valid ReviewNoteData for tests
const makeReview = (filePath: string): ReviewNoteData => ({
  filePath,
  lineRange: "1-10",
  selectedCode: "const x = 1;",
  userNote: "fix this",
});

describe("buildContinueMessage", () => {
  test("returns undefined when no content provided", () => {
    const result = buildContinueMessage({
      model: "test-model",
      agentId: "exec",
    });
    expect(result).toBeUndefined();
  });

  test("returns undefined when text is empty string", () => {
    const result = buildContinueMessage({
      text: "",
      model: "test-model",
      agentId: "exec",
    });
    expect(result).toBeUndefined();
  });

  test("returns message when text is provided", () => {
    const result = buildContinueMessage({
      text: "hello",
      model: "test-model",
      agentId: "exec",
    });
    // Check individual fields instead of toEqual (branded type can't be matched with plain object)
    expect(result?.text).toBe("hello");
    expect(result?.model).toBe("test-model");
    expect(result?.agentId).toBe("exec");
    expect(result?.fileParts).toBeUndefined();
    expect(result?.reviews).toBeUndefined();
  });

  test("returns message when only images provided", () => {
    const result = buildContinueMessage({
      fileParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
      model: "test-model",
      agentId: "plan",
    });
    expect(result?.fileParts?.length).toBe(1);
    expect(result?.text).toBe("");
    expect(result?.agentId).toBe("plan");
  });

  test("preserves muxMetadata when provided", () => {
    const muxMetadata = {
      type: "agent-skill",
      rawCommand: "/test-skill hello",
      skillName: "test-skill",
      scope: "project",
    } as const;

    const result = buildContinueMessage({
      text: "hello",
      muxMetadata,
      model: "test-model",
      agentId: "exec",
    });

    expect(result?.muxMetadata).toEqual(muxMetadata);
  });
  test("returns message when only reviews provided", () => {
    const result = buildContinueMessage({
      reviews: [makeReview("a.ts")],
      model: "test-model",
      agentId: "exec",
    });
    expect(result?.reviews?.length).toBe(1);
    expect(result?.text).toBe("");
  });
});

describe("rebuildContinueMessage", () => {
  test("returns undefined when persisted is undefined", () => {
    const result = rebuildContinueMessage(undefined, { model: "default", agentId: "exec" });
    expect(result).toBeUndefined();
  });

  test("returns undefined when persisted has no content", () => {
    const result = rebuildContinueMessage({}, { model: "default", agentId: "exec" });
    expect(result).toBeUndefined();
  });

  test("uses persisted values when available", () => {
    const result = rebuildContinueMessage(
      { text: "continue", model: "persisted-model", agentId: "plan" },
      { model: "default", agentId: "exec" }
    );
    expect(result?.text).toBe("continue");
    expect(result?.model).toBe("persisted-model");
    expect(result?.agentId).toBe("plan");
  });

  test("migrates legacy mode to agentId", () => {
    const result = rebuildContinueMessage(
      { text: "continue", mode: "plan" },
      { model: "default-model", agentId: "exec" }
    );
    expect(result?.agentId).toBe("plan");
  });

  test("prefers persisted agentId over legacy mode", () => {
    const result = rebuildContinueMessage(
      { text: "continue", agentId: "custom-agent", mode: "plan" },
      { model: "default-model", agentId: "exec" }
    );
    expect(result?.agentId).toBe("custom-agent");
  });
  test("uses defaults when persisted values missing", () => {
    const result = rebuildContinueMessage(
      { text: "continue" },
      { model: "default-model", agentId: "plan" }
    );
    expect(result?.text).toBe("continue");
    expect(result?.model).toBe("default-model");
    expect(result?.agentId).toBe("plan");
  });

  test("preserves muxMetadata from persisted data", () => {
    const muxMetadata = {
      type: "agent-skill",
      rawCommand: "/test-skill hello",
      skillName: "test-skill",
      scope: "project",
    } as const;

    const result = rebuildContinueMessage(
      { text: "continue", muxMetadata },
      { model: "m", agentId: "exec" }
    );

    expect(result?.muxMetadata).toEqual(muxMetadata);
  });
  test("preserves reviews from persisted data", () => {
    const review = makeReview("a.ts");
    const result = rebuildContinueMessage(
      { text: "review this", reviews: [review] },
      { model: "m", agentId: "exec" }
    );
    expect(result?.reviews?.length).toBe(1);
    expect(result?.reviews?.[0].filePath).toBe("a.ts");
  });

  test("preserves fileParts from persisted data", () => {
    const result = rebuildContinueMessage(
      {
        text: "with image",
        fileParts: [{ url: "data:image/png;base64,xyz", mediaType: "image/png" }],
      },
      { model: "m", agentId: "exec" }
    );
    expect(result?.fileParts?.length).toBe(1);
  });
});

describe("normalizeCompactionFollowUpRequest", () => {
  const defaults = { model: "default:model", agentId: "exec" };

  test("preserves modern envelope shape unchanged", () => {
    const modern: CompactionFollowUpRequest = {
      message: { content: "fix tests", fileParts: [], reviews: [] },
      muxMetadata: undefined,
      sendOptions: {
        model: "openai:gpt-4o",
        agentId: "code",
        thinkingLevel: "high",
      },
    };
    const result = normalizeCompactionFollowUpRequest(modern, defaults);
    expect(result.message.content).toBe("fix tests");
    expect(result.sendOptions.model).toBe("openai:gpt-4o");
    expect(result.sendOptions.agentId).toBe("code");
    expect(result.sendOptions.thinkingLevel).toBe("high");
  });

  test("normalizes legacy flattened follow-up to envelope shape", () => {
    // Simulate a persisted legacy follow-up (flat fields, no message/sendOptions)
    const legacy = {
      text: "Continue working",
      model: "anthropic:claude-3-5-sonnet",
      agentId: "exec",
      fileParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
      reviews: [makeReview("fix-this.ts")],
      thinkingLevel: "medium" as const,
    } as unknown as CompactionFollowUpRequest;

    const result = normalizeCompactionFollowUpRequest(legacy, defaults);

    expect(result.message.content).toBe("Continue working");
    expect(result.message.fileParts).toHaveLength(1);
    expect(result.message.reviews).toHaveLength(1);
    expect(result.sendOptions.model).toBe("anthropic:claude-3-5-sonnet");
    expect(result.sendOptions.agentId).toBe("exec");
    expect(result.sendOptions.thinkingLevel).toBe("medium");
  });

  test("migrates legacy mode to agentId", () => {
    const legacy = {
      text: "hello",
      mode: "plan",
    } as unknown as CompactionFollowUpRequest;

    const result = normalizeCompactionFollowUpRequest(legacy, defaults);
    expect(result.sendOptions.agentId).toBe("plan");
  });

  test("migrates legacy imageParts to fileParts", () => {
    const legacy = {
      text: "look at this",
      imageParts: [{ url: "data:image/png;base64,xyz", mediaType: "image/png" }],
    } as unknown as CompactionFollowUpRequest;

    const result = normalizeCompactionFollowUpRequest(legacy, defaults);
    expect(result.message.fileParts).toHaveLength(1);
  });

  test("uses defaults when legacy fields are missing", () => {
    const legacy = {
      text: "hello",
    } as unknown as CompactionFollowUpRequest;

    const result = normalizeCompactionFollowUpRequest(legacy, defaults);
    expect(result.sendOptions.model).toBe("default:model");
    expect(result.sendOptions.agentId).toBe("exec");
    expect(result.message.content).toBe("hello");
  });

  test("preserves muxMetadata from legacy data", () => {
    const legacy = {
      text: "/tests run all",
      muxMetadata: {
        type: "agent-skill" as const,
        rawCommand: "/tests run all",
        skillName: "tests",
        scope: "project" as const,
      },
    } as unknown as CompactionFollowUpRequest;

    const result = normalizeCompactionFollowUpRequest(legacy, defaults);
    expect(result.muxMetadata?.type).toBe("agent-skill");
  });

  test("fills sendOptions defaults when modern shape is missing sendOptions", () => {
    // Edge case: somehow persisted with message but without sendOptions
    const partial = {
      message: { content: "hello" },
    } as unknown as CompactionFollowUpRequest;

    const result = normalizeCompactionFollowUpRequest(partial, defaults);
    expect(result.sendOptions.model).toBe("default:model");
    expect(result.sendOptions.agentId).toBe("exec");
  });
});
