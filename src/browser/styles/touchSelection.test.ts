/**
 * Static contract for the touch text-selection guard in globals.css.
 *
 * Pixel and the Storybook test-runner do not emulate touch, so `(pointer: coarse)`
 * never matches in a snapshot or play test (AGENTS.md, Storybook responsive/Pixel
 * validation). This asserts the rules against the stylesheet instead, resolving the
 * declaration that wins for a viewport rather than matching literal source.
 *
 * Selection reaches an element from every route that produces a `user-select`
 * declaration, so all are checked: rules written in globals.css, Tailwind utilities named
 * in TSX or in files pulled in by `@source` directives, and inline styles, whether React
 * style objects or DOM style assignments. Only the first route is visible to this parse;
 * the others need their own source scan.
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
 * Case-insensitive because browsers match property names and keyword values that way;
 * collected properties and values are lowercased so the assertions compare one spelling.
 */
const SELECTION_PROPERTY_PATTERN = /^(?:-(?:webkit|moz|ms|o)-)?user-select$/i;

/**
 * Tailwind's selection utilities, matched anywhere in the token so variant chains
 * (`hover:`, `[&:hover]:`) and important markers (`select-text!`, `!select-text`) cannot
 * hide them. The arbitrary-value and variable forms (`select-[text]`, `select-(--x)`)
 * compile to nothing in this Tailwind version, where `select-*` is a static utility
 * (verified against `@tailwindcss/node`'s `compile()`), but they are refused anyway so a
 * Tailwind upgrade cannot silently open the gap.
 */
const APPLIED_SELECTION_UTILITY =
  /\bselect-(?:none|text|all|auto)\b|\bselect-\[[^\s\]]+\]|\bselect-\((?:[\w-]+:)?--[^\s)]+\)/;

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
 * Opt-ins as they appear in source, in every spelling that produces a declaration:
 * the named utilities in any variant, the arbitrary-value and variable forms (tracked
 * despite compiling to nothing today, see above), the arbitrary-property form, and
 * inline styles, camelCase for React style objects and DOM assignments (`userSelect`,
 * `WebkitUserSelect`, DOM's `webkitUserSelect`) or kebab-case inside strings
 * (`setProperty`, `cssText`).
 *
 * Spellings of suppression are excluded: `select-[none]` and `[user-select:none]` as
 * arbitrary forms of the untracked `select-none`, and inline values that are literally
 * `none` or the empty-string reset. An inline value this pattern cannot see, such as a
 * variable or a conditional, counts as an opt-in: a match is a review gate, and the
 * cost of a false positive is one entry below.
 *
 * Each alternative carries its parser's case posture. Tailwind candidates and JS
 * property lookups are case-sensitive (`SELECT-TEXT` and `[USER-SELECT:text]` compile
 * to nothing or fail the build, verified against `compile()`, and `style.USERSELECT`
 * is inert), but CSS parsed out of strings is case-insensitive, and a regex flag
 * cannot vary per alternative, so the kebab spellings are built letter by letter.
 */
const anyCase = (kebab: string) => kebab.replace(/[a-z]/g, (c) => `[${c}${c.toUpperCase()}]`);

const SELECTION_OPT_IN_PATTERN = new RegExp(
  [
    // Named utilities behind any variant chain.
    String.raw`\b(?:[A-Za-z0-9_-]+:)*select-(?:text|all|auto)\b`,
    // Arbitrary-value and variable forms.
    String.raw`\bselect-\[(?!none\])[^\s\]]+\]`,
    String.raw`\bselect-\((?:[\w-]+:)?--[^\s)]+\)`,
    // The arbitrary-property form.
    String.raw`\[(?:-(?:webkit|moz|ms|o)-)?user-select:(?!none\])[^\s\]]+\]`,
    // camelCase inline styles, unless the value is a literal none or empty reset.
    String.raw`\b(?:[Ww]ebkit|[Mm]oz|[Mm]s|O)?[uU]serSelect\b(?!\s*[:=]\s*["'\`](?:none)?["'\`])`,
    // kebab-case inside strings, in any case the browser would accept.
    `(?:-(?:${anyCase("webkit")}|${anyCase("moz")}|${anyCase("ms")}|${anyCase("o")})-)?\\b${anyCase("user-select")}\\b(?!\\s*:\\s*${anyCase("none")}\\b)`,
  ].join("|"),
  "g"
);

/**
 * Components that opt content back into selection with a Tailwind class or inline style.
 *
 * Either one puts a `user-select` declaration on the element itself, which beats
 * the guard inherited from `body`, so each entry is content that stays selectable on touch.
 * Every current one is a short value a user copies: a commit SHA, an SSH fingerprint, review
 * metadata, or a rename input. Enumerated rather than inferred because whether an element is
 * narrow enough for that to be safe is not visible in the stylesheet or the class name, so a
 * new entry is a decision for review.
 *
 * Each occurrence is pinned by the trimmed source line that carries it plus the next
 * non-empty line, in source order, so what was reviewed is the element the class sits on
 * and the content it exposes, not a per-file count. A count cannot tell a reviewed
 * opt-in from a different one that replaced it in the same file, a carrying line alone
 * cannot tell apart duplicates (`ReviewPanel.tsx` wraps four metadata values in
 * byte-identical divs, distinguished only by the content line under them), and a bare
 * file list cannot see an addition next to an existing entry. Unrelated edits elsewhere
 * in a file leave the entry alone; editing a pinned line, even around the class,
 * resubmits that occurrence for review, which is the point. Still an exact-match
 * posture: identity comes from line text, not from parsing TSX.
 *
 * Suppression utilities (`select-none` and its arbitrary spelling) are deliberately not
 * tracked here: turning selection off on a control is the ordinary use of that utility,
 * whereas turning it back on is the exception to this guard. Broad suppression written as
 * CSS is still caught below.
 *
 * Files named by `@source` directives are scanned here too, keyed by repo-relative path:
 * Tailwind reads those for utility classes just like TSX under `src/`.
 */
const SELECTION_OPT_INS: Record<string, string[]> = {
  "src/browser/components/AgentListItem/AgentListItem.tsx": [
    'className="bg-input-bg text-input-text border-input-border font-inherit focus:border-input-border-focus col-span-2 min-w-0 flex-1 rounded-sm border px-1 text-left text-[13px] outline-none select-text"\nvalue={editingTitle}',
  ],
  "src/browser/components/GitStatusIndicatorView/GitStatusIndicatorView.tsx": [
    '<span className="text-accent shrink-0 select-all">{commit.hash}</span>\n<span className="text-muted-light shrink-0">{commit.date}</span>',
  ],
  "src/browser/components/ProjectSidebar/ProjectSidebar.tsx": [
    'className="bg-background/50 text-foreground w-full rounded border border-white/20 px-1.5 py-0.5 text-xs outline-none select-text"\n/>',
  ],
  "src/browser/components/SectionHeader/SectionHeader.tsx": [
    'className="bg-background/50 text-foreground min-w-0 flex-1 rounded border border-white/20 px-1.5 py-0.5 text-xs font-medium outline-none select-text"\n/>',
    'className="bg-background/50 text-foreground w-full rounded border border-white/20 px-1.5 py-0.5 text-xs outline-none select-text"\n/>',
  ],
  "src/browser/components/SshPromptDialog/SshPromptDialog.tsx": [
    '<div className="text-foreground mt-1 break-all select-all">{pending.fingerprint}</div>\n</div>',
  ],
  "src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx": [
    '<div className="text-foreground break-all select-all">\n{diagnosticInfo.command}',
    '<div className="text-foreground break-all select-all">\n{diagnosticInfo.outputLength.toLocaleString()} bytes',
    '<div className="text-foreground break-all select-all">\n{diagnosticInfo.fileDiffCount}',
    '<div className="text-foreground break-all select-all">\n{diagnosticInfo.hunkCount}',
  ],
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
  appShellSelectors = await readAppShellSelectors();

  const stylesheet = postcss.parse(
    await readFile(new URL("./globals.css", import.meta.url), "utf8")
  );

  sourceDirectivePaths = [];
  stylesheet.walkAtRules(/^source$/i, (atRule) => {
    const match = PLAIN_SOURCE_PATH.exec(atRule.params.trim());
    if (!match) {
      throw new Error(`Unsupported @source form: @source ${atRule.params}`);
    }
    sourceDirectivePaths.push(match[1]);
  });

  // `@apply select-text` sets selection without a `user-select` declaration to find, and
  // resolving what a utility expands to needs Tailwind's variant and layer handling, so
  // the honest response is to refuse rather than report a guard this cannot see.
  // At-rule names are matched case-insensitively: `@APPLY` currently compiles to
  // nothing, but refusing it keeps a Tailwind change from opening the gap silently.
  stylesheet.walkAtRules(/^apply$/i, (atRule) => {
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
    // A CSS ident escape (`user-sele\63t`) can spell a property in a form no pattern
    // sees, so escaped property names are refused rather than decoded.
    if (decl.prop.includes("\\")) {
      throw new Error(`Unsupported escaped property name: ${decl.prop}`);
    }
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
      property: decl.prop.toLowerCase(),
      value: decl.value.toLowerCase(),
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

/**
 * One token is still not scoping when the element it names wraps the application:
 * `#root` (index.html) contains everything React renders, so suppressing selection there
 * suppresses it app-wide by inheritance. Ids are read from index.html rather than
 * hardcoded, so a renamed or added shell container stays covered.
 */
let appShellSelectors: string[] = [];

async function readAppShellSelectors(): Promise<string[]> {
  const indexHtml = await readFile(join(REPO_ROOT, "index.html"), "utf8");
  return [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => `#${match[1]}`);
}

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
      .map((selector) => selector.trim())
      .filter(
        (selector) =>
          selector !== "body" &&
          (!SINGLE_COMPONENT_SELECTOR.test(selector) || appShellSelectors.includes(selector))
      );
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("opts content back into selection only in reviewed components", async () => {
    const optIns: Record<string, string[]> = {};
    const countInto = (key: string, source: string) => {
      for (const match of source.matchAll(SELECTION_OPT_IN_PATTERN)) {
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        const lineEnd = source.indexOf("\n", match.index);
        const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
        const following = source
          .slice(lineEnd === -1 ? source.length : lineEnd + 1)
          .split("\n")
          .map((candidate) => candidate.trim())
          .find((candidate) => candidate !== "");
        (optIns[key] ??= []).push(`${line}\n${following ?? ""}`);
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
