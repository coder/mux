import { describe, it, expect } from "bun:test";
import type { MuxProviderOptions } from "@/common/types/providerOptions";
import {
  getServiceTierForCommandKey,
  getServiceTierSpeed,
  getServiceTierSpeedLabel,
  SERVICE_TIER_FAST,
  SERVICE_TIER_SLOW,
  supportsServiceTier,
  withServiceTierOverride,
} from "./serviceTier";

const OPENAI_MODEL = "openai:gpt-5.5";
const ANTHROPIC_MODEL = "anthropic:claude-haiku-4-5";

describe("serviceTier helpers", () => {
  describe("getServiceTierForCommandKey", () => {
    it("maps /fast and /slow to provider wire tiers", () => {
      expect(getServiceTierForCommandKey("fast")).toBe(SERVICE_TIER_FAST);
      expect(getServiceTierForCommandKey("slow")).toBe(SERVICE_TIER_SLOW);
    });

    it("uses OpenAI priority/flex as the Fast/Slow wire values", () => {
      expect(SERVICE_TIER_FAST).toBe("priority");
      expect(SERVICE_TIER_SLOW).toBe("flex");
    });

    it("returns null for non service-tier keys", () => {
      expect(getServiceTierForCommandKey("haiku")).toBeNull();
      expect(getServiceTierForCommandKey("compact")).toBeNull();
      expect(getServiceTierForCommandKey("")).toBeNull();
    });
  });

  describe("getServiceTierSpeed", () => {
    it("collapses concrete tiers into UI speed buckets", () => {
      expect(getServiceTierSpeed("priority")).toBe("fast");
      expect(getServiceTierSpeed("flex")).toBe("slow");
    });

    it("treats auto/default/absent as the neutral default", () => {
      expect(getServiceTierSpeed("auto")).toBe("default");
      expect(getServiceTierSpeed("default")).toBe("default");
      expect(getServiceTierSpeed(null)).toBe("default");
      expect(getServiceTierSpeed(undefined)).toBe("default");
    });
  });

  describe("getServiceTierSpeedLabel", () => {
    it("renders provider-agnostic labels", () => {
      expect(getServiceTierSpeedLabel("fast")).toBe("Fast");
      expect(getServiceTierSpeedLabel("slow")).toBe("Slow");
      expect(getServiceTierSpeedLabel("default")).toBe("Auto");
    });
  });

  describe("supportsServiceTier", () => {
    it("is supported only for OpenAI models today", () => {
      expect(supportsServiceTier(OPENAI_MODEL)).toBe(true);
      expect(supportsServiceTier(ANTHROPIC_MODEL)).toBe(false);
      expect(supportsServiceTier("google:gemini-3.1-pro-preview")).toBe(false);
    });
  });

  describe("withServiceTierOverride", () => {
    it("attaches the tier under openai for supported models", () => {
      const result = withServiceTierOverride({}, SERVICE_TIER_FAST, OPENAI_MODEL);
      expect(result.openai?.serviceTier).toBe("priority");
    });

    it("preserves other openai provider options", () => {
      const result = withServiceTierOverride(
        { openai: { wireFormat: "responses" } },
        SERVICE_TIER_SLOW,
        OPENAI_MODEL
      );
      expect(result.openai?.serviceTier).toBe("flex");
      expect(result.openai?.wireFormat).toBe("responses");
    });

    it("returns options unchanged when there is no override", () => {
      const input = { anthropic: { use1MContext: true } };
      expect(withServiceTierOverride(input, null, OPENAI_MODEL)).toBe(input);
      expect(withServiceTierOverride(input, undefined, OPENAI_MODEL)).toBe(input);
    });

    it("never attaches a tier for unsupported models", () => {
      const input = {};
      const result = withServiceTierOverride(input, SERVICE_TIER_FAST, ANTHROPIC_MODEL);
      expect(result).toBe(input);
      expect(result.openai).toBeUndefined();
    });

    it("does not mutate the input options", () => {
      const input: MuxProviderOptions = { openai: { wireFormat: "responses" } };
      withServiceTierOverride(input, SERVICE_TIER_FAST, OPENAI_MODEL);
      expect(input.openai?.serviceTier).toBeUndefined();
    });
  });
});
