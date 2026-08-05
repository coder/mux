import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { FAST_MODE_PREVIOUS_SERVICE_TIER_KEY } from "@/common/constants/storage";
import {
  commitFastModeServiceTierChange,
  getFastModeServiceTierChange,
} from "./fastModeServiceTier";

const testWindow = new GlobalWindow();
globalThis.window = testWindow as unknown as Window & typeof globalThis;
globalThis.document = testWindow.document as unknown as Document;
globalThis.CustomEvent = testWindow.CustomEvent as unknown as typeof CustomEvent;

describe("fast mode service tier", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test("restores flex after a temporary fast-mode override", () => {
    const enable = getFastModeServiceTierChange("flex");
    expect(enable).toEqual({
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: "flex",
    });
    commitFastModeServiceTierChange(enable);

    expect(getFastModeServiceTierChange("priority")).toEqual({
      apiValue: "flex",
      serviceTier: "flex",
      previousServiceTier: undefined,
    });
  });

  test("restores an unset service tier with the backend removal value", () => {
    const enable = getFastModeServiceTierChange(undefined);
    commitFastModeServiceTierChange(enable);

    expect(getFastModeServiceTierChange("priority")).toEqual({
      apiValue: "",
      serviceTier: undefined,
      previousServiceTier: undefined,
    });
  });

  test("clears the remembered tier after fast mode is disabled", () => {
    updatePersistedState(FAST_MODE_PREVIOUS_SERVICE_TIER_KEY, "default");
    const disable = getFastModeServiceTierChange("priority");
    commitFastModeServiceTierChange(disable);

    // A priority tier loaded without a remembered override falls back to auto.
    expect(getFastModeServiceTierChange("priority").serviceTier).toBe("auto");
  });
});
