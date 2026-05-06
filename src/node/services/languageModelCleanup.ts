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
): void {
  assert(typeof cleanup === "function", "language model cleanup must be a function");
  assert(
    !hasLanguageModelCleanup(model),
    "language model already has cleanup attached; call moveLanguageModelCleanup instead"
  );
  const modelWithCleanup = model as LanguageModelWithCleanup;
  modelWithCleanup[languageModelCleanupSymbol] = cleanup;
}

// Single-shot pop: read the attached cleanup (if any) and clear the slot in one
// step so move/run callers can't accidentally leave a stale cleanup behind that
// would re-fire on a later run.
function detachLanguageModelCleanup(model: LanguageModel): LanguageModelCleanup | undefined {
  const modelWithCleanup = model as LanguageModelWithCleanup;
  const cleanup = modelWithCleanup[languageModelCleanupSymbol];
  if (cleanup === undefined) {
    return undefined;
  }
  delete modelWithCleanup[languageModelCleanupSymbol];
  return cleanup;
}

export function moveLanguageModelCleanup(source: LanguageModel, target: LanguageModel): void {
  const cleanup = detachLanguageModelCleanup(source);
  if (cleanup === undefined) {
    return;
  }
  attachLanguageModelCleanup(target, cleanup);
}

export function hasLanguageModelCleanup(model: LanguageModel): boolean {
  const modelWithCleanup = model as LanguageModelWithCleanup;
  return typeof modelWithCleanup[languageModelCleanupSymbol] === "function";
}

export function runLanguageModelCleanup(model: LanguageModel | undefined): void {
  if (model === undefined) {
    return;
  }
  const cleanup = detachLanguageModelCleanup(model);
  if (cleanup === undefined) {
    return;
  }

  try {
    cleanup();
  } catch (error) {
    log.warn("Failed to clean up language model resources", { error });
  }
}
