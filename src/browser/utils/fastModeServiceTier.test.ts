import { describe, expect, mock, test } from "bun:test";

import type { APIClient } from "@/browser/contexts/API";
import {
  applyFastModeServiceTierChange,
  getFastModeServiceTierChange,
} from "./fastModeServiceTier";

type ProviderConfigWriter = Pick<APIClient["providers"], "setProviderConfig">;

function createWriter() {
  const setProviderConfig = mock((_input: unknown) =>
    Promise.resolve({ success: true as const, data: undefined })
  );
  return {
    providers: { setProviderConfig } as unknown as ProviderConfigWriter,
    setProviderConfig,
  };
}

describe("fast mode service tier", () => {
  test("restores flex from the shared provider config", () => {
    expect(getFastModeServiceTierChange("priority", "flex")).toEqual({
      apiValue: "flex",
      serviceTier: "flex",
      previousServiceTier: undefined,
    });
  });

  test("persists the restore tier before enabling Fast mode", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "flex");

    expect(change).toEqual({
      apiValue: "priority",
      serviceTier: "priority",
      previousServiceTier: "flex",
    });
    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "openai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "flex",
        },
      ],
      [
        {
          provider: "openai",
          keyPath: ["serviceTier"],
          value: "priority",
        },
      ],
    ]);
  });

  test("restores and clears the shared tier when disabling Fast mode", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "priority", "default");

    expect(change).toEqual({
      apiValue: "default",
      serviceTier: "default",
      previousServiceTier: undefined,
    });
    expect(setProviderConfig.mock.calls).toEqual([
      [
        {
          provider: "openai",
          keyPath: ["serviceTier"],
          value: "default",
        },
      ],
      [
        {
          provider: "openai",
          keyPath: ["fastModePreviousServiceTier"],
          value: "",
        },
      ],
    ]);
  });

  test("restores an unset tier with the backend removal value", async () => {
    const { providers, setProviderConfig } = createWriter();

    const change = await applyFastModeServiceTierChange(providers, "priority", "unset");

    expect(change?.serviceTier).toBeUndefined();
    expect(setProviderConfig.mock.calls[0]).toEqual([
      {
        provider: "openai",
        keyPath: ["serviceTier"],
        value: "",
      },
    ]);
  });

  test("falls back to auto for legacy priority config without a restore tier", () => {
    expect(getFastModeServiceTierChange("priority").serviceTier).toBe("auto");
  });
});
