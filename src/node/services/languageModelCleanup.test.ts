import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";

import {
  attachLanguageModelCleanup,
  hasLanguageModelCleanup,
  moveLanguageModelCleanup,
  runLanguageModelCleanup,
} from "./languageModelCleanup";

function createModel(): LanguageModel {
  return {
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("doGenerate is unused in cleanup tests")),
    doStream: () => Promise.reject(new Error("doStream is unused in cleanup tests")),
  };
}

describe("language model cleanup", () => {
  test("runs attached cleanup exactly once", () => {
    const model = createModel();
    let cleanupCalls = 0;

    attachLanguageModelCleanup(model, () => {
      cleanupCalls += 1;
    });

    runLanguageModelCleanup(model);
    runLanguageModelCleanup(model);

    expect(cleanupCalls).toBe(1);
  });

  test("reports whether cleanup is attached", () => {
    const model = createModel();

    expect(hasLanguageModelCleanup(model)).toBe(false);
    attachLanguageModelCleanup(model, () => undefined);
    expect(hasLanguageModelCleanup(model)).toBe(true);
    runLanguageModelCleanup(model);
    expect(hasLanguageModelCleanup(model)).toBe(false);
  });

  test("moves cleanup to a wrapper model", () => {
    const inner = createModel();
    const outer = createModel();
    let cleanupCalls = 0;

    attachLanguageModelCleanup(inner, () => {
      cleanupCalls += 1;
    });

    moveLanguageModelCleanup(inner, outer);

    expect(hasLanguageModelCleanup(inner)).toBe(false);
    expect(hasLanguageModelCleanup(outer)).toBe(true);
    runLanguageModelCleanup(inner);
    runLanguageModelCleanup(outer);
    expect(cleanupCalls).toBe(1);
  });

  test("rejects double attach before cleanup is moved or run", () => {
    const model = createModel();
    attachLanguageModelCleanup(model, () => undefined);

    expect(() => attachLanguageModelCleanup(model, () => undefined)).toThrow(
      "language model already has cleanup attached"
    );
  });

  test("models without cleanup are safe", () => {
    expect(() => runLanguageModelCleanup(createModel())).not.toThrow();
  });

  test("cleanup errors are swallowed after the first attempt", () => {
    const model = createModel();
    let cleanupCalls = 0;

    attachLanguageModelCleanup(model, () => {
      cleanupCalls += 1;
      throw new Error("close failed");
    });

    expect(() => runLanguageModelCleanup(model)).not.toThrow();
    expect(() => runLanguageModelCleanup(model)).not.toThrow();
    expect(cleanupCalls).toBe(1);
  });
});
