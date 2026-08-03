/**
 * Static contract for the touch text-selection guard in globals.css.
 *
 * Pixel and the Storybook test-runner do not emulate touch, so `(pointer: coarse)`
 * never matches in a snapshot or play test (AGENTS.md, Storybook responsive/Pixel
 * validation). This asserts the rules against the stylesheet instead, resolving the
 * declaration that wins for a viewport rather than matching literal source.
 *
 * Selection reaches an element from every place Tailwind collects class names, so all are
 * checked: rules written in globals.css, Tailwind utilities named in TSX, and files pulled
 * in by `@source` directives. The utilities only enter the build through
 * `@import "tailwindcss"`, so they never appear in this parse and need their own scan.
 */
import { Glob } from "bun";
import { beforeAll, describe, expect, it } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type ChildNode, type Container, type Declaration } from "postcss";

const IPAD_WIDTH_PX = 834;
const IPAD_LANDSCAPE_WIDTH_PX = 1194;
const DESKTOP_WIDTH_PX = 1900;
const PHONE_WIDTH_PX = 390;

/**
 * Both spellings are asserted: WebKit is the engine this guard exists for, and older
 * iPadOS honours only the prefixed property, so dropping either one regresses it.
 */
const SELECTION_PROPERTIES = ["user-select", "-webkit-user-select"];

/**
 * Collection recognises every vendor spelling, not just the two asserted above: a rule
 * setting only `-moz-user-select` still changes selection in that engine, so ignoring it
 * would let a descendant override slip past the whole-stylesheet checks below.
 */
const SELECTION_PROPERTY_PATTERN = /^(?:-(?:webkit|moz|ms|o)-)?user-select$/;

/** Tailwind's selection utilities, including variants such as `hover:select-text`. */
const APPLIED_SELECTION_UTILITY = /^(?:[\w[\]./-]+:)*select-(?:none|text|all|auto)$/;

/**
 * The arbitrary-property spelling, `[user-select:text]` in any vendor prefix, which
 * compiles to the same direct declaration a named utility does. Unanchored, so a
 * variant chain in front does not hide it.
 */
const ARBITRARY_SELECTION_CLASS = /\[(?:-(?:webkit|moz|ms|o)-)?user-select:[^\s\]]+\]/;

const SOURCE_DIR = new URL("../../", import.meta.url).pathname;

const STYLESHEET_DIR = fileURLToPath(new URL("./", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The one `@source` form this contract models: a double-quoted plain file path, which
 * Tailwind resolves against the stylesheet's directory (verified against
 * `@tailwindcss/node`'s `compile()`). `not`, `inline(...)`, globs, and directories all
 * throw, so extending to them is a deliberate edit rather than a silent guess.
 */
const PLAIN_SOURCE_PATH = /^"([^"*?{}[\]]+)"$/;

/**
 * Opt-ins as they appear in class names, in any variant: the named utilities and the
 * arbitrary-property form. `[user-select:none]` is excluded as the arbitrary spelling
 * of `select-none`, which is untracked for the reason given below.
 */
const SELECTION_OPT_IN_CLASS =
  /\b(?:[A-Za-z0-9_-]+:)*select-(?:text|all|auto)\b|\[(?:-(?:webkit|moz|ms|o)-)?user-select:(?!none\])[^\s\]]+\]/g;

/**
 * Components that opt content back into selection with a Tailwind class.
 *
 * Such a class compiles to a `user-select` declaration on the element itself, which beats
 * the guard inherited from `body`, so each entry is content that stays selectable on touch.
 * Every current one is a short value a user copies: a commit SHA, an SSH fingerprint, review
 * metadata, or a rename input. Enumerated rather than inferred because whether an element is
 * narrow enough for that to be safe is not visible in the stylesheet or the class name, so a
 * new entry is a decision for review.
 *
 * Counted per file rather than listed per file, because an opt-in added to a file that
 * already appears here would otherwise go unreviewed: a class on a transcript-wide container
 * in `ReviewPanel.tsx`, which already opts in several metadata values, would suppress
 * nothing and change no file name.
 *
 * Suppression utilities (`select-none` and its arbitrary spelling) are deliberately not
 * tracked here: turning selection off on a control is the ordinary use of that utility,
 * whereas turning it back on is the exception to this guard. Broad suppression written as
 * CSS is still caught below.
 *
 * Files named by `@source` directives are counted here too, keyed by repo-relative path:
 * Tailwind scans those for utility classes just like TSX under `src/`.
 */
const SELECTION_OPT_INS: Record<string, number> = {
  "src/browser/components/AgentListItem/AgentListItem.tsx": 1,
  "src/browser/components/GitStatusIndicatorView/GitStatusIndicatorView.tsx": 1,
  "src/browser/components/ProjectSidebar/ProjectSidebar.tsx": 1,
  "src/browser/components/SectionHeader/SectionHeader.tsx": 2,
  "src/browser/components/SshPromptDialog/SshPromptDialog.tsx": 1,
  "src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx": 4,
};

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
  property: string;
  value: string;
  mediaParams: string[];
  /** Source position, so the winning declaration can be resolved by order. */
  order: number;
}

function collectMediaParams(node: ChildNode | Container): string[] {
  const params: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (!("name" in current) || typeof current.params !== "string") {
      continue;
    }
    // Only `@media` is modelled. `@supports` and `@container` also appear in this
    // stylesheet, and dropping their conditions would treat a conditional rule as
    // unconditional, so they have to be rejected rather than ignored.
    if (current.name !== "media") {
      throw new Error(`Unsupported at-rule around selection rule: @${current.name}`);
    }
    params.push(current.params);
  }
  return params;
}

let selectionRules: SelectionRule[] = [];
let sourceDirectivePaths: string[] = [];

beforeAll(async () => {
  const stylesheet = postcss.parse(
    await readFile(new URL("./globals.css", import.meta.url), "utf8")
  );

  sourceDirectivePaths = [];
  stylesheet.walkAtRules("source", (atRule) => {
    const match = PLAIN_SOURCE_PATH.exec(atRule.params.trim());
    if (!match) {
      throw new Error(`Unsupported @source form: @source ${atRule.params}`);
    }
    sourceDirectivePaths.push(match[1]);
  });

  // `@apply select-text` sets selection without a `user-select` declaration to find, and
  // resolving what a utility expands to needs Tailwind's variant and layer handling, so
  // the honest response is to refuse rather than report a guard this cannot see.
  stylesheet.walkAtRules("apply", (atRule) => {
    const appliesSelection = atRule.params
      .split(/\s+/)
      .some(
        (token) => APPLIED_SELECTION_UTILITY.test(token) || ARBITRARY_SELECTION_CLASS.test(token)
      );
    if (appliesSelection) {
      throw new Error(`Selection set via @apply cannot be modelled: @apply ${atRule.params}`);
    }
  });

  selectionRules = [];
  let order = 0;
  stylesheet.walkDecls((decl: Declaration) => {
    if (!SELECTION_PROPERTY_PATTERN.test(decl.prop)) {
      return;
    }
    // A declaration outside a plain rule (`@utility`, `@keyframes`) has no selector to
    // reason about, and its application sites live in TSX this contract cannot read.
    if (decl.parent?.type !== "rule") {
      throw new Error(
        `Selection declaration outside a rule: ${decl.parent?.type ?? "detached"} ${decl.prop}`
      );
    }
    if (decl.important) {
      throw new Error(`Unsupported !important selection declaration: ${decl.parent.selector}`);
    }
    selectionRules.push({
      selectors: decl.parent.selectors,
      property: decl.prop,
      value: decl.value,
      mediaParams: collectMediaParams(decl),
      order: order++,
    });
  });
});

/**
 * Media queries this contract can evaluate, matched exactly rather than parsed.
 *
 * A hand-rolled parser accepts queries a browser rejects, such as `(pointer: coarse: fine)`
 * or `(min-width: 0 px)`, by reading a valid prefix and ignoring the rest; such a query
 * silently disables the guard while every assertion here still passes. Exact keys cannot
 * drift from the grammar that way: an unlisted query throws, and extending this map is a
 * deliberate edit.
 */
const MEDIA_QUERIES: Record<string, (viewport: Viewport) => boolean> = {
  "(pointer: coarse)": (viewport) => viewport.coarse,
  "(pointer: fine)": (viewport) => !viewport.coarse,
  "(max-width: 768px) and (pointer: coarse)": (viewport) =>
    viewport.widthPx <= 768 && viewport.coarse,
  "(max-width: 1200px) and (pointer: coarse)": (viewport) =>
    viewport.widthPx <= 1200 && viewport.coarse,
  "(pointer: coarse) and (min-width: 1200px)": (viewport) =>
    viewport.coarse && viewport.widthPx >= 1200,
};

function mediaQueryApplies(params: string, viewport: Viewport): boolean {
  const applies = MEDIA_QUERIES[params.trim()];
  if (!applies) {
    throw new Error(`Unrecognised media query around a selection rule: ${params}`);
  }
  return applies(viewport);
}

/**
 * The declaration a browser would use: last applicable one wins, since every rule
 * reaching this point is a bare selector of equal specificity. `undefined` means no
 * rule applies, so the element keeps the inherited or initial value.
 */
function effectiveValue(
  selector: string,
  property: string,
  viewport: Viewport
): string | undefined {
  return selectionRules
    .filter(
      (rule) =>
        rule.selectors.includes(selector) &&
        rule.property === property &&
        rule.mediaParams.every((params) => mediaQueryApplies(params, viewport))
    )
    .sort((left, right) => left.order - right.order)
    .at(-1)?.value;
}

const COARSE_VIEWPORTS: Viewport[] = [
  PHONE_WIDTH_PX,
  IPAD_WIDTH_PX,
  IPAD_LANDSCAPE_WIDTH_PX,
  DESKTOP_WIDTH_PX,
].map((widthPx) => ({ widthPx, coarse: true }));

const FINE_VIEWPORTS: Viewport[] = [PHONE_WIDTH_PX, DESKTOP_WIDTH_PX].map((widthPx) => ({
  widthPx,
  coarse: false,
}));

/**
 * A selector consisting of exactly one class or id token, which can therefore only match
 * elements carrying it. Merely containing a class is not evidence of scoping, because
 * `:not(.allow-selection)` contains one and still matches nearly everything. Requiring the
 * whole selector to be one token needs no selector engine to defend.
 */
const SINGLE_COMPONENT_SELECTOR = /^[.#][A-Za-z0-9_-]+$/;

function applicableSelectors(viewport: Viewport, value: (candidate: string) => boolean) {
  return selectionRules
    .filter(
      (rule) =>
        value(rule.value) && rule.mediaParams.every((params) => mediaQueryApplies(params, viewport))
    )
    .flatMap((rule) => rule.selectors);
}

describe("touch text-selection guard", () => {
  it.each([IPAD_WIDTH_PX, IPAD_LANDSCAPE_WIDTH_PX, DESKTOP_WIDTH_PX])(
    "suppresses body selection on a coarse pointer at %ipx",
    (widthPx) => {
      for (const property of SELECTION_PROPERTIES) {
        expect(effectiveValue("body", property, { widthPx, coarse: true })).toBe("none");
      }
    }
  );

  it("keeps editable controls selectable wherever body selection is suppressed", () => {
    for (const viewport of COARSE_VIEWPORTS) {
      for (const selector of EDITABLE_SELECTORS) {
        for (const property of SELECTION_PROPERTIES) {
          expect(effectiveValue(selector, property, viewport)).toBe("text");
        }
      }
    }
  });

  /**
   * `user-select` inherits, so the `body` rule reaches transcript content only by
   * inheritance, and inheritance loses to any declaration that matches a descendant
   * directly, whatever its specificity. The guard therefore holds only while nothing
   * else re-enables selection, which the per-selector assertions above cannot see.
   */
  it("re-enables selection only for the editable opt-in on a coarse pointer", () => {
    const reEnabling = COARSE_VIEWPORTS.flatMap((viewport) =>
      applicableSelectors(viewport, (value) => value !== "none").filter(
        (selector) => !EDITABLE_SELECTORS.includes(selector)
      )
    );
    expect([...new Set(reEnabling)]).toEqual([]);
  });

  /**
   * The same inheritance argument in reverse, and viewport-independent because a rule that
   * can reach content is wrong at every width: only the guard on `body` may suppress
   * selection broadly, and everything else must name a single component.
   */
  it("suppresses selection only through the body guard or one component class", () => {
    const offenders = selectionRules
      .filter((rule) => rule.value === "none")
      .flatMap((rule) => rule.selectors)
      .filter(
        (selector) => selector !== "body" && !SINGLE_COMPONENT_SELECTOR.test(selector.trim())
      );
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("opts content back into selection only in reviewed components", async () => {
    const optIns: Record<string, number> = {};
    const countInto = (key: string, source: string) => {
      const matches = source.match(SELECTION_OPT_IN_CLASS);
      if (matches) {
        optIns[key] = matches.length;
      }
    };
    // Test files are skipped: they ship no UI, and this file names the utilities it matches.
    for await (const relativePath of new Glob("**/*.{ts,tsx}").scan({ cwd: SOURCE_DIR })) {
      if (/\.test\.tsx?$/.test(relativePath)) {
        continue;
      }
      countInto(
        `src/${relativePath.replaceAll("\\", "/")}`,
        await readFile(join(SOURCE_DIR, relativePath), "utf8")
      );
    }
    for (const directivePath of sourceDirectivePaths) {
      const resolved = resolve(STYLESHEET_DIR, directivePath);
      // A path that matches nothing is scanned as nothing, exactly as Tailwind treats it.
      const stats = await stat(resolved).catch(() => undefined);
      if (!stats) {
        continue;
      }
      if (!stats.isFile()) {
        throw new Error(`Unsupported non-file @source target: ${directivePath}`);
      }
      countInto(
        relative(REPO_ROOT, resolved).replaceAll("\\", "/"),
        await readFile(resolved, "utf8")
      );
    }
    expect(optIns).toEqual(SELECTION_OPT_INS);
  });

  it("leaves content selectable for fine pointers", () => {
    // Controls are not exempted here: `button` and `[role="button"]` both wrap
    // selectable content in this codebase (skill descriptions, diff hunks, copyable
    // IDs), so suppressing them app-wide would break copying on desktop.
    for (const viewport of FINE_VIEWPORTS) {
      for (const selector of ["body", "button", '[role="button"]']) {
        for (const property of SELECTION_PROPERTIES) {
          expect(effectiveValue(selector, property, viewport)).not.toBe("none");
        }
      }
    }
  });
});
