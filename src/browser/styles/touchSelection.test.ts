/**
 * Static contract for the touch text-selection guard in globals.css.
 *
 * Pixel and the Storybook test-runner never match `(pointer: coarse)`, so no
 * snapshot or play test can observe these rules (AGENTS.md, Storybook
 * responsive/Pixel validation). This asserts them against the stylesheet
 * instead, evaluating the media conditions rather than matching literal source
 * so the rules stay free to move or be reworded.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import postcss, { type ChildNode, type Container, type Declaration } from "postcss";

const IPAD_WIDTHS_PX = [834, 1194];
const PHONE_WIDTH_PX = 390;

interface SelectionRule {
  selectors: string[];
  value: string;
  mediaParams: string[];
}

function collectMediaParams(node: ChildNode | Container): string[] {
  const params: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if ("name" in current && current.name === "media" && typeof current.params === "string") {
      params.push(current.params);
    }
  }
  return params;
}

let selectionRules: SelectionRule[] = [];

beforeAll(async () => {
  const stylesheet = postcss.parse(
    await readFile(new URL("./globals.css", import.meta.url), "utf8")
  );

  selectionRules = [];
  stylesheet.walkDecls((decl: Declaration) => {
    if (decl.prop !== "user-select" || decl.parent?.type !== "rule") {
      return;
    }
    selectionRules.push({
      selectors: decl.parent.selectors,
      value: decl.value,
      mediaParams: collectMediaParams(decl),
    });
  });
});

/** Mirrors how a browser resolves the width and pointer conditions we rely on. */
function appliesTo(rule: SelectionRule, viewport: { widthPx: number; coarse: boolean }): boolean {
  return rule.mediaParams.every((params) => {
    for (const [, rawMax] of params.matchAll(/max-width:\s*(\d+)px/g)) {
      if (viewport.widthPx > Number(rawMax)) {
        return false;
      }
    }
    for (const [, rawMin] of params.matchAll(/min-width:\s*(\d+)px/g)) {
      if (viewport.widthPx < Number(rawMin)) {
        return false;
      }
    }
    if (/pointer:\s*coarse/.test(params) && !viewport.coarse) {
      return false;
    }
    if (/pointer:\s*fine/.test(params) && viewport.coarse) {
      return false;
    }
    return true;
  });
}

function matches(rule: SelectionRule, selector: string): boolean {
  return rule.selectors.some((candidate) => candidate === selector);
}

describe("touch text-selection guard", () => {
  it.each(IPAD_WIDTHS_PX)("suppresses body selection on a coarse pointer at %ipx", (widthPx) => {
    const applied = selectionRules.filter(
      (rule) => matches(rule, "body") && appliesTo(rule, { widthPx, coarse: true })
    );

    expect(applied.map((rule) => rule.value)).toContain("none");
  });

  it("keeps editable controls selectable wherever body selection is suppressed", () => {
    for (const widthPx of [...IPAD_WIDTHS_PX, PHONE_WIDTH_PX]) {
      const viewport = { widthPx, coarse: true };
      const editableSelectors = ["input", "textarea", '[contenteditable="true"]'];

      for (const selector of editableSelectors) {
        const applied = selectionRules.filter(
          (rule) => matches(rule, selector) && appliesTo(rule, viewport)
        );

        expect(applied.map((rule) => rule.value)).toContain("text");
      }
    }
  });

  it("leaves prose selectable for fine pointers", () => {
    const applied = selectionRules.filter(
      (rule) => matches(rule, "body") && appliesTo(rule, { widthPx: 1200, coarse: false })
    );

    expect(applied.map((rule) => rule.value)).not.toContain("none");
  });

  it("suppresses selection on native buttons at every width and pointer type", () => {
    for (const viewport of [
      { widthPx: 1200, coarse: false },
      { widthPx: 1194, coarse: true },
      { widthPx: PHONE_WIDTH_PX, coarse: true },
    ]) {
      const applied = selectionRules.filter(
        (rule) => matches(rule, "button") && appliesTo(rule, viewport)
      );

      expect(applied.map((rule) => rule.value)).toContain("none");
    }
  });

  it("does not suppress selection for role=button containers", () => {
    // They wrap selectable content (diff hunks, review notes), so a blanket rule
    // would stop desktop users copying code out of a review.
    const applied = selectionRules.filter(
      (rule) =>
        matches(rule, '[role="button"]') &&
        rule.value === "none" &&
        appliesTo(rule, { widthPx: 1200, coarse: false })
    );

    expect(applied).toHaveLength(0);
  });
});
