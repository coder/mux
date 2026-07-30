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

/**
 * Both spellings are asserted: WebKit is the engine this guard exists for, and older
 * iPadOS honours only the prefixed property, so dropping either one regresses it.
 */
const SELECTION_PROPERTIES = ["user-select", "-webkit-user-select"];

interface SelectionRule {
  selectors: string[];
  property: string;
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
    if (!SELECTION_PROPERTIES.includes(decl.prop) || decl.parent?.type !== "rule") {
      return;
    }
    selectionRules.push({
      selectors: decl.parent.selectors,
      property: decl.prop,
      value: decl.value,
      mediaParams: collectMediaParams(decl),
    });
  });
});

/**
 * Evaluates the media features these selection rules use. Anything outside a plain
 * `(feature: value)` conjunction throws: silently ignoring an operator such as `not`
 * would invert the result while still satisfying every assertion below.
 */
function mediaQueryApplies(params: string, viewport: Viewport): boolean {
  const shape = params.replace(/\([^)]*\)/g, "()").trim();
  if (!/^\(\)(\s+and\s+\(\))*$/.test(shape)) {
    throw new Error(`Unsupported media query syntax in selection rule: ${params}`);
  }

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

function valuesFor(selector: string, property: string, viewport: Viewport): string[] {
  return selectionRules
    .filter(
      (rule) =>
        rule.selectors.includes(selector) &&
        rule.property === property &&
        rule.mediaParams.every((params) => mediaQueryApplies(params, viewport))
    )
    .map((rule) => rule.value);
}

describe("touch text-selection guard", () => {
  it.each([IPAD_WIDTH_PX, IPAD_LANDSCAPE_WIDTH_PX, DESKTOP_WIDTH_PX])(
    "suppresses body selection on a coarse pointer at %ipx",
    (widthPx) => {
      for (const property of SELECTION_PROPERTIES) {
        expect(valuesFor("body", property, { widthPx, coarse: true })).toContain("none");
      }
    }
  );

  it("keeps editable controls selectable wherever body selection is suppressed", () => {
    for (const widthPx of [PHONE_WIDTH_PX, IPAD_WIDTH_PX, IPAD_LANDSCAPE_WIDTH_PX]) {
      for (const selector of EDITABLE_SELECTORS) {
        for (const property of SELECTION_PROPERTIES) {
          expect(valuesFor(selector, property, { widthPx, coarse: true })).toContain("text");
        }
      }
    }
  });

  it("leaves content selectable for fine pointers", () => {
    // Controls are not exempted here: `button` and `[role="button"]` both wrap
    // selectable content in this codebase (skill descriptions, diff hunks, copyable
    // IDs), so suppressing them app-wide would break copying on desktop.
    for (const selector of ["body", "button", '[role="button"]']) {
      for (const property of SELECTION_PROPERTIES) {
        expect(
          valuesFor(selector, property, { widthPx: DESKTOP_WIDTH_PX, coarse: false })
        ).not.toContain("none");
      }
    }
  });
});
