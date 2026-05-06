import assert from "node:assert";
import type { LanguageModel } from "ai";

import { log } from "./log";

const languageModelCleanupSymbol = Symbol("mux.languageModelCleanup");

type LanguageModelCleanup = () => void;
type LanguageModelWithCleanup = LanguageModel & {
  [languageModelCleanupSymbol]?: LanguageModelCleanup;
};

export function attachLanguageModelCleanup(
  model: LanguageModel,
  cleanup: LanguageModelCleanup
): LanguageModel {
  assert(typeof cleanup === "function", "language model cleanup must be a function");
  const modelWithCleanup = model as LanguageModelWithCleanup;
  modelWithCleanup[languageModelCleanupSymbol] = cleanup;
  return model;
}

export function moveLanguageModelCleanup(source: LanguageModel, target: LanguageModel): void {
  const sourceWithCleanup = source as LanguageModelWithCleanup;
  const cleanup = sourceWithCleanup[languageModelCleanupSymbol];
  if (cleanup === undefined) {
    return;
  }

  delete sourceWithCleanup[languageModelCleanupSymbol];
  attachLanguageModelCleanup(target, cleanup);
}

export function hasLanguageModelCleanup(model: LanguageModel): boolean {
  const modelWithCleanup = model as LanguageModelWithCleanup;
  return typeof modelWithCleanup[languageModelCleanupSymbol] === "function";
}

export function runLanguageModelCleanup(model: LanguageModel): void {
  const modelWithCleanup = model as LanguageModelWithCleanup;
  const cleanup = modelWithCleanup[languageModelCleanupSymbol];
  if (cleanup === undefined) {
    return;
  }

  delete modelWithCleanup[languageModelCleanupSymbol];

  try {
    cleanup();
  } catch (error) {
    log.warn("Failed to clean up language model resources", { error });
  }
}
