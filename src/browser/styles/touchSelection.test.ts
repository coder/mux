/**
 * Static contract for the touch text-selection guard in globals.css.
 *
 * Pixel and the Storybook test-runner do not emulate touch, so `(pointer: coarse)`
 * never matches in a snapshot or play test (AGENTS.md, Storybook responsive/Pixel
 * validation). This asserts the rules against the stylesheet instead, evaluating
 * media conditions rather than matching literal source.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import postcss, { type ChildNode, type Container, type Declaration } from "postcss";

const IPAD_WIDTH_PX = 834;
const IPAD_LANDSCAPE_WIDTH_PX = 1194;
const DESKTOP_WIDTH_PX = 1900;
const PHONE_WIDTH_PX = 390;

const EDITABLE_SELECTORS = [
  "input",
  "textarea",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
];

interface Viewport {
  widthPx: number;
  coarse: boolean;
}

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

/**
 * Evaluates the media features these selection rules use. Throws on anything else
 * so a future rule cannot silently pass every assertion below.
 */
function mediaQueryApplies(params: string, viewport: Viewport): boolean {
  let applies = true;
  for (const condition of params.matchAll(/\(([^)]*)\)/g)) {
    const [feature, rawValue] = condition[1].split(":").map((part) => part.trim());
    if (feature === "max-width" || feature === "min-width") {
      const boundaryPx = Number(rawValue.replace("px", ""));
      if (!rawValue.endsWith("px") || Number.isNaN(boundaryPx)) {
        throw new Error(`Unsupported width value in media query: ${params}`);
      }
      applies &&=
        feature === "max-width" ? viewport.widthPx <= boundaryPx : viewport.widthPx >= boundaryPx;
      continue;
    }
    if (feature === "pointer") {
      applies &&= rawValue === (viewport.coarse ? "coarse" : "fine");
      continue;
    }
    throw new Error(`Unsupported media feature in selection rule: ${params}`);
  }
  return applies;
}

function valuesFor(selector: string, viewport: Viewport): string[] {
  return selectionRules
    .filter(
      (rule) =>
        rule.selectors.includes(selector) &&
        rule.mediaParams.every((params) => mediaQueryApplies(params, viewport))
    )
    .map((rule) => rule.value);
}

describe("touch text-selection guard", () => {
  it.each([IPAD_WIDTH_PX, IPAD_LANDSCAPE_WIDTH_PX, DESKTOP_WIDTH_PX])(
    "suppresses body selection on a coarse pointer at %ipx",
    (widthPx) => {
      expect(valuesFor("body", { widthPx, coarse: true })).toContain("none");
    }
  );

  it("keeps editable controls selectable wherever body selection is suppressed", () => {
    for (const widthPx of [PHONE_WIDTH_PX, IPAD_WIDTH_PX, IPAD_LANDSCAPE_WIDTH_PX]) {
      for (const selector of EDITABLE_SELECTORS) {
        expect(valuesFor(selector, { widthPx, coarse: true })).toContain("text");
      }
    }
  });

  it("leaves content selectable for fine pointers", () => {
    // Controls are not exempted here: `button` and `[role="button"]` both wrap
    // selectable content in this codebase (skill descriptions, diff hunks, copyable
    // IDs), so suppressing them app-wide would break copying on desktop.
    for (const selector of ["body", "button", '[role="button"]']) {
      expect(valuesFor(selector, { widthPx: DESKTOP_WIDTH_PX, coarse: false })).not.toContain(
        "none"
      );
    }
  });
});
