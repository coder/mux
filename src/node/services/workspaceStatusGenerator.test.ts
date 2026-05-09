import { describe, expect, test } from "bun:test";
import { buildWorkspaceStatusPrompt, generateWorkspaceStatus } from "./workspaceStatusGenerator";

describe("buildWorkspaceStatusPrompt", () => {
  test("contains the transcript inside delimited markers", () => {
    const prompt = buildWorkspaceStatusPrompt("User: please run tests\nAssistant: running");

    // The transcript block needs explicit delimiters so the model can tell
    // where the transcript ends and the requirements begin. If we ever drop
    // these delimiters, the model is more likely to follow trailing
    // instructions baked into the transcript itself (a real prompt-injection
    // risk for arbitrary chat history).
    expect(prompt).toContain("<transcript>");
    expect(prompt).toContain("</transcript>");
    expect(prompt).toContain("User: please run tests");
    expect(prompt).toContain("Assistant: running");
  });

  test("falls back to a sentinel when transcript is empty", () => {
    const prompt = buildWorkspaceStatusPrompt("");

    // Empty transcripts must still produce a syntactically-valid prompt; the
    // sentinel keeps the small model from inheriting system-prompt context
    // from a previous workspace.
    expect(prompt).toContain("(no recent transcript)");
  });
});

describe("generateWorkspaceStatus error paths", () => {
  test("returns a configuration error when no candidates are provided", async () => {
    const fakeAiService = {
      // Asserting this never gets called is the real point of this test —
      // the empty-candidates short-circuit prevents wasteful provider calls
      // for misconfigured workspaces.
      createModel: () => {
        throw new Error("createModel must not be called when no candidates exist");
      },
    } as unknown as Parameters<typeof generateWorkspaceStatus>[2];

    const result = await generateWorkspaceStatus("hello", [], fakeAiService);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error.type).toBe("unknown");
      expect(result.error.error.raw).toContain("No model candidates");
      // No candidates means we never even attempted createModel, so the
      // failure has nothing to do with the transcript — caller must keep
      // retrying so a future config change recovers without a new message.
      expect(result.error.reachedProvider).toBe(false);
    }
  });
});
