import { describe, expect, test } from "bun:test";

import { KNOWN_MODELS } from "@/common/constants/knownModels";
import {
  buildModelClassValue,
  parseModelClassValue,
  resolveSkillModelClassBinding,
  sanitizeModelClasses,
  splitModelClassValue,
} from "./skillModelClasses";

describe("parseModelClassValue", () => {
  test("resolves a bare alias without a thinking level", () => {
    expect(parseModelClassValue("haiku")).toEqual({ model: KNOWN_MODELS.HAIKU.id });
  });

  test("resolves alias + numeric thinking (deferred as an index)", () => {
    expect(parseModelClassValue("haiku+0")).toEqual({
      model: KNOWN_MODELS.HAIKU.id,
      thinkingLevel: 0,
    });
  });

  test("resolves alias + named thinking", () => {
    expect(parseModelClassValue("sonnet+high")).toEqual({
      model: KNOWN_MODELS.SONNET.id,
      thinkingLevel: "high",
    });
  });

  test("accepts full provider:model ids (unlike the composer one-shot parser)", () => {
    expect(parseModelClassValue("anthropic:claude-fable-5+max")).toEqual({
      model: KNOWN_MODELS.FABLE.id,
      thinkingLevel: "max",
    });
  });

  test("rejects unknown model input", () => {
    expect(parseModelClassValue("not-a-model")).toBeNull();
    expect(parseModelClassValue("")).toBeNull();
  });

  test("rejects an invalid thinking suffix instead of ignoring it", () => {
    expect(parseModelClassValue("haiku+bogus")).toBeNull();
    expect(parseModelClassValue("haiku+")).toBeNull();
  });
});

describe("splitModelClassValue / buildModelClassValue", () => {
  test("round-trips a raw thinking suffix so numeric levels survive model changes", () => {
    // "+0" is model-relative user intent ("lowest"): swapping the model in an
    // editor must not concretize it to the old model's floor.
    const { thinkingSuffix } = splitModelClassValue("haiku+0");
    expect(thinkingSuffix).toBe("0");
    expect(buildModelClassValue(KNOWN_MODELS.SONNET.id, thinkingSuffix)).toBe(
      `${KNOWN_MODELS.SONNET.id}+0`
    );
  });

  test("handles suffix-less values", () => {
    expect(splitModelClassValue("sonnet")).toEqual({ modelPart: "sonnet", thinkingSuffix: null });
    expect(buildModelClassValue("sonnet", null)).toBe("sonnet");
  });
});

describe("sanitizeModelClasses", () => {
  test("keeps parseable entries and drops unparseable ones", () => {
    expect(
      sanitizeModelClasses({
        small: "haiku+0",
        broken: "not-a-model",
        badThinking: "haiku+bogus",
        "": "haiku",
        "  spaced  ": " sonnet+high ",
      })
    ).toEqual({
      small: "haiku+0",
      spaced: "sonnet+high",
    });
  });

  test("preserves custom class names alongside canonical ones", () => {
    expect(
      sanitizeModelClasses({ small: "haiku", "my-custom": "anthropic:claude-opus-5+high" })
    ).toEqual({
      small: "haiku",
      "my-custom": "anthropic:claude-opus-5+high",
    });
  });
});

describe("resolveSkillModelClassBinding", () => {
  const modelClasses = {
    small: "haiku+0",
    large: "anthropic:claude-fable-5+max",
  };

  test("binds via frontmatter metadata and resolves numeric thinking to a concrete level", () => {
    const binding = resolveSkillModelClassBinding({
      skillName: "done",
      frontmatterMetadata: { "model-class": "small" },
      modelClasses,
    });
    // Haiku's lowest allowed thinking level is "off": index 0 must resolve
    // model-relatively, not to the literal level "0".
    expect(binding).toEqual({
      status: "resolved",
      className: "small",
      model: KNOWN_MODELS.HAIKU.id,
      thinkingLevel: "off",
    });
  });

  test("config routing table wins over frontmatter metadata", () => {
    const binding = resolveSkillModelClassBinding({
      skillName: "done",
      frontmatterMetadata: { "model-class": "small" },
      modelClasses,
      skillModelClasses: { done: "large" },
    });
    expect(binding).toMatchObject({
      status: "resolved",
      model: KNOWN_MODELS.FABLE.id,
      thinkingLevel: "max",
    });
  });

  test("table entries for other skills do not shadow the metadata binding", () => {
    const binding = resolveSkillModelClassBinding({
      skillName: "done",
      frontmatterMetadata: { "model-class": "small" },
      modelClasses,
      skillModelClasses: { review: "large" },
    });
    expect(binding).toMatchObject({ status: "resolved", model: KNOWN_MODELS.HAIKU.id });
  });

  test("reports an unknown class name instead of swallowing it", () => {
    expect(
      resolveSkillModelClassBinding({
        skillName: "done",
        frontmatterMetadata: { "model-class": "tiny" },
        modelClasses,
      })
    ).toEqual({ status: "unknown-class", className: "tiny" });
  });

  test("reports an invalid class value instead of swallowing it", () => {
    expect(
      resolveSkillModelClassBinding({
        skillName: "done",
        frontmatterMetadata: { "model-class": "small" },
        modelClasses: { small: "not-a-model" },
      })
    ).toEqual({ status: "invalid-value", className: "small", value: "not-a-model" });
  });

  test("skills without any binding are unbound", () => {
    expect(resolveSkillModelClassBinding({ skillName: "done", modelClasses })).toEqual({
      status: "unbound",
    });
  });

  test("frontmatter bindings are inert until the user configures model classes", () => {
    // A skill shipping `metadata: model-class` must not error for users who
    // never opted into model classes.
    expect(
      resolveSkillModelClassBinding({
        skillName: "done",
        frontmatterMetadata: { "model-class": "small" },
      })
    ).toEqual({ status: "unbound" });
  });

  test("a config-table binding is explicit intent and errors even without a class map", () => {
    expect(
      resolveSkillModelClassBinding({
        skillName: "done",
        skillModelClasses: { done: "small" },
      })
    ).toEqual({ status: "unknown-class", className: "small" });
  });

  test("a class without a thinking suffix overrides only the model", () => {
    const binding = resolveSkillModelClassBinding({
      skillName: "done",
      frontmatterMetadata: { "model-class": "medium" },
      modelClasses: { medium: "sonnet" },
    });
    expect(binding).toEqual({
      status: "resolved",
      className: "medium",
      model: KNOWN_MODELS.SONNET.id,
    });
  });
});
