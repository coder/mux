/**
 * Tests for isExperimentEnabled()
 *
 * Key invariant:
 * - For user-overridable experiments, absence of a localStorage entry must be treated as
 *   "no explicit override" (undefined), so the backend can apply PostHog assignment.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { EXPERIMENT_IDS, getExperimentKey } from "@/common/constants/experiments";
import { isExperimentEnabled } from "./useExperiments";

describe("isExperimentEnabled", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("returns undefined when no local override exists for a user-overridable experiment", () => {
    expect(isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1)).toBeUndefined();
  });

  test("returns boolean when local override exists", () => {
    const key = getExperimentKey(EXPERIMENT_IDS.SYSTEM_1);

    globalThis.window.localStorage.setItem(key, JSON.stringify(true));
    expect(isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1)).toBe(true);

    globalThis.window.localStorage.setItem(key, JSON.stringify(false));
    expect(isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1)).toBe(false);
  });

  test('treats literal "undefined" as no override', () => {
    const key = getExperimentKey(EXPERIMENT_IDS.SYSTEM_1);

    globalThis.window.localStorage.setItem(key, "undefined");
    expect(isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1)).toBeUndefined();
  });

  test("treats non-boolean stored value as no override", () => {
    const key = getExperimentKey(EXPERIMENT_IDS.SYSTEM_1);

    globalThis.window.localStorage.setItem(key, JSON.stringify("test"));
    expect(isExperimentEnabled(EXPERIMENT_IDS.SYSTEM_1)).toBeUndefined();
  });
});
