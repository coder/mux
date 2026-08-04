/**
 * Static contract for the touch text-selection guard in globals.css.
 *
 * Pixel and the Storybook test-runner do not emulate touch, so `(pointer: coarse)`
 * never matches in a snapshot or play test (AGENTS.md, Storybook responsive/Pixel
 * validation). This asserts the rules against the stylesheet instead, resolving the
 * declaration that wins for a viewport rather than matching literal source.
 *
 * The contract checks stylesheet rules, Tailwind utilities, and explicit inline
 * selection writes in renderer sources.
 *
 * `@tailwindcss/oxide` is the scanner underneath the declared `tailwindcss` and
 * `@tailwindcss/vite` packages; asking it for the file list is what keeps "which files
 * does Tailwind scan" from becoming another hand-rolled approximation.
 */
import { Scanner } from "@tailwindcss/oxide";
import { beforeAll, describe, expect, it } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import postcss, { type ChildNode, type Container, type Declaration } from "postcss";
import ts from "typescript";

const IPAD_WIDTH_PX = 834;
const IPAD_LANDSCAPE_WIDTH_PX = 1194;
const DESKTOP_WIDTH_PX = 1900;
const PHONE_WIDTH_PX = 390;

/**
 * Older iPadOS honours only the prefixed property, so the guard requires both spellings.
 */
const GUARD_SELECTION_PROPERTIES = ["user-select", "-webkit-user-select"];

/**
 * Collection and fine-pointer assertions cover every vendor spelling: a rule setting only
 * `-moz-user-select` still changes selection in that engine. CSS property names and keyword
 * values are case-insensitive, so both are lowercased before comparison.
 */
const RECOGNIZED_SELECTION_PROPERTIES = [
  ...GUARD_SELECTION_PROPERTIES,
  "-moz-user-select",
  "-ms-user-select",
  "-o-user-select",
];
const SELECTION_PROPERTY_PATTERN = new RegExp(
  `^(?:${RECOGNIZED_SELECTION_PROPERTIES.join("|")})$`,
  "i"
);

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

const STYLESHEET_DIR = fileURLToPath(new URL("./", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const STYLESHEET_PATH = fileURLToPath(new URL("./globals.css", import.meta.url));

/**
 * Files whose contents can put a `user-select` declaration on a rendered element: the
 * renderer's entry HTML (vite.config.ts `rollupOptions.input`) and the `src/` segments
 * the renderer is bundled from, limited to executable files and minus tests, fixtures,
 * and Storybook-only sources. Tokens in docs, assets, fixture payloads, declarations, or
 * backend prompts can emit unused Tailwind rules but cannot style rendered UI, so
 * inventorying them creates the behavior-neutral failures AGENTS.md forbids.
 *
 * The segments are a reviewed list rather than a computed module graph, because file-
 * level reachability needs a bundler's resolution rules, and segment-level transitive
 * closure over-includes: `src/common` runtime-imports `@/node` in server-only corners
 * that the renderer never reaches (the eslint `no-cross-boundary-imports` rule bans
 * browser -> node directly but not common -> node). Whole segments are included, so a
 * renderer-visible file inside a listed segment cannot be silently exempt; the drift
 * guard below keeps the list current when the renderer starts importing a new segment.
 * `src/types` is only ambient `.d.ts` declarations, never imported as a module.
 */
const RENDERER_SEGMENTS = ["browser", "common", "constants", "version"];
const RUNTIME_ENTRY_HTML = ["index.html", "terminal.html"];
const EXECUTABLE_SOURCE = /\.[cm]?[jt]sx?$/;
const DECLARATION_SOURCE = /\.d\.[cm]?ts$/;
const NON_RUNTIME_SOURCE =
  /(?:^|\/)stories\/|\/settingsStoryUtils\.[jt]sx?$|\.(?:test|stories|fixtures)\.[jt]sx?$/;

function isRuntimeSource(relativePath: string): boolean {
  if (RUNTIME_ENTRY_HTML.includes(relativePath)) {
    return true;
  }
  const [root, segment] = relativePath.split("/");
  return (
    root === "src" &&
    segment !== undefined &&
    RENDERER_SEGMENTS.includes(segment.replace(EXECUTABLE_SOURCE, "")) &&
    EXECUTABLE_SOURCE.test(relativePath) &&
    !DECLARATION_SOURCE.test(relativePath) &&
    !NON_RUNTIME_SOURCE.test(relativePath)
  );
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  if (/\.[cm]?tsx$/.test(filePath)) {
    return ts.ScriptKind.TSX;
  }
  if (/\.[cm]?jsx$/.test(filePath)) {
    return ts.ScriptKind.JSX;
  }
  if (/\.[cm]?js$/.test(filePath)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function isJavaScriptScriptKind(scriptKind: ts.ScriptKind): boolean {
  return scriptKind === ts.ScriptKind.JS || scriptKind === ts.ScriptKind.JSX;
}

function importClauseHasRuntimeValue(
  importClause: ts.ImportClause | undefined,
  scriptKind: ts.ScriptKind
): boolean {
  if (!importClause || importClause.name) {
    return !importClause?.isTypeOnly;
  }
  if (importClause.isTypeOnly) {
    return false;
  }
  const bindings = importClause.namedBindings;
  return (
    bindings === undefined ||
    ts.isNamespaceImport(bindings) ||
    (bindings.elements.length === 0 && isJavaScriptScriptKind(scriptKind)) ||
    bindings.elements.some((element) => !element.isTypeOnly)
  );
}

function exportDeclarationHasRuntimeValue(
  declaration: ts.ExportDeclaration,
  scriptKind: ts.ScriptKind
): boolean {
  if (declaration.isTypeOnly || !declaration.moduleSpecifier) {
    return false;
  }
  const clause = declaration.exportClause;
  return (
    clause === undefined ||
    ts.isNamespaceExport(clause) ||
    (clause.elements.length === 0 && isJavaScriptScriptKind(scriptKind)) ||
    clause.elements.some((element) => !element.isTypeOnly)
  );
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let candidate = expression;
  while (
    ts.isParenthesizedExpression(candidate) ||
    ts.isAsExpression(candidate) ||
    ts.isTypeAssertionExpression(candidate) ||
    ts.isSatisfiesExpression(candidate) ||
    ts.isNonNullExpression(candidate)
  ) {
    candidate = candidate.expression;
  }
  return candidate;
}

function stringLiteralValue(expression: ts.Expression | undefined): string | undefined {
  if (!expression) {
    return undefined;
  }
  const candidate = unwrapExpression(expression);
  return ts.isStringLiteralLike(candidate) ? candidate.text : undefined;
}

function importedSegments(source: string, filePath: string): Set<string> {
  const scriptKind = scriptKindForPath(filePath);
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const specifiers = new Set<string>();
  const addSpecifier = (expression: ts.Expression | undefined) => {
    const specifier = stringLiteralValue(expression);
    if (specifier !== undefined) {
      specifiers.add(specifier.split("?")[0]);
    }
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      importClauseHasRuntimeValue(node.importClause, scriptKind)
    ) {
      addSpecifier(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node) && exportDeclarationHasRuntimeValue(node, scriptKind)) {
      addSpecifier(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        addSpecifier(node.moduleReference.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      if (isDynamicImport || isRequire) {
        addSpecifier(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const segments = new Set<string>();
  for (const specifier of specifiers) {
    let target: string | undefined;
    if (specifier.startsWith("@/")) {
      target = specifier.slice(2).split("/")[0];
    } else if (specifier.startsWith(".")) {
      const resolved = relative(REPO_ROOT, resolve(dirname(filePath), specifier)).replaceAll(
        "\\",
        "/"
      );
      const [root, segment] = resolved.split("/");
      target = root === "src" ? segment : undefined;
    }
    if (target !== undefined) {
      segments.add(target.replace(EXECUTABLE_SOURCE, ""));
    }
  }
  return segments;
}

/**
 * The one `@source` form this contract models: a double-quoted plain file path, which
 * Tailwind resolves against the stylesheet's directory (verified against
 * `@tailwindcss/node`'s `compile()`). `not`, `inline(...)`, globs, and directories all
 * throw, so extending to them is a deliberate edit rather than a silent guess.
 */
const PLAIN_SOURCE_PATH = /^"([^"*?{}[\]]+)"$/;

/**
 * A Tailwind variant chain, named (`hover:`) or arbitrary (`[&:hover]:`), so the whole
 * candidate lands in the recorded token: a variant change alters when the declaration
 * applies, which is a behavioral edit the inventory must see.
 */
const VARIANT_CHAIN = String.raw`(?:(?:[A-Za-z0-9_-]+|\[[^\s\]]+\]):)*`;

const SELECTION_OPT_IN_PATTERN = new RegExp(
  [
    String.raw`!?${VARIANT_CHAIN}\bselect-(?:text|all)\b!?`,
    String.raw`!${VARIANT_CHAIN}\bselect-auto\b`,
    String.raw`${VARIANT_CHAIN}\bselect-auto\b!`,
    String.raw`!?${VARIANT_CHAIN}\bselect-\[(?!none\])[^\s\]]+\]!?`,
    String.raw`!?${VARIANT_CHAIN}\bselect-\((?:[\w-]+:)?--[^\s)]+\)!?`,
    String.raw`!?${VARIANT_CHAIN}\[(?:-(?:webkit|moz|ms|o)-)?user-select:(?!none\])[^\s\]]+\]!?`,
  ].join("|"),
  "g"
);

const SELECTION_SUPPRESSION_PATTERN = new RegExp(
  [
    String.raw`!?${VARIANT_CHAIN}\bselect-none\b!?`,
    String.raw`!?${VARIANT_CHAIN}\bselect-\[none\]!?`,
    String.raw`!?${VARIANT_CHAIN}\[(?:-(?:webkit|moz|ms|o)-)?user-select:none\]!?`,
  ].join("|"),
  "g"
);

type SelectionSiteKind = "opt-in" | "suppression";

const INLINE_SELECTION_PROPERTIES: Record<string, string> = {
  userSelect: "userSelect",
  WebkitUserSelect: "WebkitUserSelect",
  webkitUserSelect: "webkitUserSelect",
  MozUserSelect: "MozUserSelect",
  mozUserSelect: "mozUserSelect",
  MsUserSelect: "MsUserSelect",
  msUserSelect: "msUserSelect",
  OUserSelect: "OUserSelect",
  oUserSelect: "oUserSelect",
  "user-select": "user-select",
  "-webkit-user-select": "-webkit-user-select",
  "-moz-user-select": "-moz-user-select",
  "-ms-user-select": "-ms-user-select",
  "-o-user-select": "-o-user-select",
};

/**
 * Components that opt content back into selection with a Tailwind class or inline style.
 *
 * Either one puts a declaration on the element itself, replacing the value propagated
 * from `body`, so each entry is content that stays selectable on touch.
 * Enumerated rather than inferred because whether an element is narrow enough for that
 * to be safe (a SHA, a fingerprint, an input) is not visible in the stylesheet or the
 * class name, so a new entry is a decision for review.
 *
 * The recorded token is the Tailwind candidate or inline property spelling, without
 * surrounding source that would make behavior-neutral refactors fail the contract.
 */
const SELECTION_OPT_INS: Record<string, Record<string, number>> = {
  "src/browser/components/AgentListItem/AgentListItem.tsx": { "select-text": 1 },
  "src/browser/components/GitStatusIndicatorView/GitStatusIndicatorView.tsx": { "select-all": 1 },
  "src/browser/components/ProjectSidebar/ProjectSidebar.tsx": { "select-text": 1 },
  "src/browser/components/SectionHeader/SectionHeader.tsx": { "select-text": 2 },
  "src/browser/components/SshPromptDialog/SshPromptDialog.tsx": { "select-all": 1 },
  "src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx": { "select-all": 4 },
};

/**
 * Sites that suppress selection, inventoried the same way. Most entries are the
 * ordinary per-control use; the enumeration exists because the exceptional case,
 * suppression on an app-wide container, is indistinguishable from it in a static scan,
 * so a human reviews what each new suppression wraps.
 */
const SELECTION_SUPPRESSIONS: Record<string, Record<string, number>> = {
  "src/browser/components/AgentListItem/AgentListItem.tsx": { "select-none": 1 },
  "src/browser/components/ChatPane/TranscriptHydrationSkeleton.tsx": { "select-none": 1 },
  "src/browser/components/FileIcon/FileIcon.tsx": { "userSelect:none": 1 },
  "src/browser/components/InstructionsTab/AdditionalSystemContextScratchpad.tsx": {
    "select-none": 1,
  },
  "src/browser/components/ProjectSidebar/ProjectSidebar.tsx": { "select-none": 2 },
  "src/browser/components/ProjectSidebar/TaskGroupListItem.tsx": { "select-none": 1 },
  "src/browser/components/ScrollArea/ScrollArea.tsx": { "select-none": 1 },
  "src/browser/components/SectionHeader/SectionHeader.tsx": { "select-none": 1 },
  "src/browser/components/SelectPrimitive/SelectPrimitive.tsx": { "select-none": 1 },
  "src/browser/components/ThinkingSlider/ProModeToggle.tsx": { "select-none": 1 },
  "src/browser/components/ThinkingSlider/ThinkingSlider.tsx": { "select-none": 1 },
  "src/browser/components/TitleBar/TitleBar.tsx": { "select-none": 1 },
  "src/browser/features/ChatInput/CreationControls.tsx": { "select-none": 1 },
  "src/browser/features/Messages/ChatBarrier/StreamingBarrierView.tsx": { "select-none": 2 },
  "src/browser/features/Messages/MarkdownComponents.tsx": { "select-none": 1 },
  "src/browser/features/Messages/OperationalBundleMessage.tsx": { "select-none": 1 },
  "src/browser/features/Messages/ReasoningMessage.tsx": { "select-none": 1 },
  "src/browser/features/Messages/WorkBundleMessage.tsx": { "select-none": 1 },
  "src/browser/features/RightSidebar/BrowserTab/BrowserViewport.tsx": { "select-none": 1 },
  "src/browser/features/RightSidebar/CodeReview/FileTree.tsx": { "select-none": 1 },
  "src/browser/features/RightSidebar/CodeReview/ImmersiveDiffRevealLoadingState.tsx": {
    "select-none": 1,
  },
  "src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx": { "[&_summary]:select-none": 1 },
  "src/browser/features/RightSidebar/StatsTab.tsx": { "select-none": 1 },
  "src/browser/features/Shared/DiffRenderer.tsx": { "select-none": 4 },
  "src/browser/features/Tools/AgentSkillReadFileToolCall.tsx": { "select-none": 1 },
  "src/browser/features/Tools/AskUserQuestionToolCall.tsx": { "select-none": 1 },
  "src/browser/features/Tools/FileReadToolCall.tsx": { "select-none": 1 },
  "src/browser/features/Tools/Shared/HookOutputDisplay.tsx": { "select-none": 1 },
  "src/browser/features/Tools/Shared/ToolPrimitives.tsx": { "select-none": 1 },
  "src/browser/hooks/useResizableSidebar.ts": { "userSelect:none": 1 },
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

  // The source scan assumes Tailwind's default automatic detection from the project
  // root. A `source(...)` clause on the import changes or disables that base, which
  // would silently invalidate the scan, so it must be modelled before it is allowed.
  stylesheet.walkAtRules(/^import$/i, (atRule) => {
    if (atRule.params.includes("tailwindcss") && /\bsource\s*\(/i.test(atRule.params)) {
      throw new Error(`Unsupported source() clause on the Tailwind import: ${atRule.params}`);
    }
  });

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
 * rule applies, so no direct value is resolved here.
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
 * Structural precondition for the reviewed list below: exactly one class or id token.
 * Merely containing a class is not evidence of scoping, because `:not(.allow-selection)`
 * contains one and still matches nearly everything. Requiring the whole selector to be
 * one token needs no selector engine to defend.
 */
const SINGLE_COMPONENT_SELECTOR = /^[.#][A-Za-z0-9_-]+$/;

/**
 * Suppression selectors reviewed as genuinely component-scoped. One token is still not
 * evidence of scope: `.mobile-layout` is a single class attached to App.tsx's
 * application-wide wrapper, so suppressing selection on it would reach every desktop
 * descendant through the `auto` used value while staying structurally indistinguishable from
 * `.line-number`. Which one a token is lives in TSX this contract cannot read, and
 * reading class names out of shell files does not settle it either (`titlebar-drag`
 * appears in App.tsx on a scoped strip), so no selector is accepted automatically; each
 * is a reviewed entry, the same posture as the source-side inventories.
 */
const SCOPED_SUPPRESSION_SELECTORS = [".line-number", ".shimmer-text-sweep", ".titlebar-drag"];

/**
 * Hard floor under the reviewed list: `#root` (index.html) contains everything React
 * renders, so its used value would suppress selection throughout the app, and an
 * enumeration entry must not be able to override that. Ids are read from index.html
 * rather than hardcoded, so a renamed or added shell container stays covered.
 */
let appShellSelectors: string[] = [];

async function readAppShellSelectors(): Promise<string[]> {
  const indexHtml = await readFile(resolve(REPO_ROOT, "index.html"), "utf8");
  return [...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => `#${match[1]}`);
}

/**
 * Tailwind's own scanner supplies the file list, so which files exist and are scannable
 * is never a hand-rolled walk; the runtime filter then keeps only the sources that can
 * style a rendered element. The parsed stylesheet is skipped: its declarations are
 * covered by the stylesheet assertions.
 */
function runtimeSourceFiles(): string[] {
  const scanner = new Scanner({
    sources: [{ base: REPO_ROOT.replace(/[\\/]$/, ""), pattern: "**/*", negated: false }],
  });
  scanner.scan();
  return scanner.files
    .filter((filePath) => resolve(filePath) !== STYLESHEET_PATH)
    .map((filePath) => relative(REPO_ROOT, filePath).replaceAll("\\", "/"))
    .filter(isRuntimeSource);
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
      for (const property of GUARD_SELECTION_PROPERTIES) {
        expect(effectiveValue("body", property, { widthPx, coarse: true })).toBe("none");
      }
    }
  );

  it("keeps editable controls selectable wherever body selection is suppressed", () => {
    for (const viewport of COARSE_VIEWPORTS) {
      for (const selector of EDITABLE_SELECTORS) {
        for (const property of GUARD_SELECTION_PROPERTIES) {
          expect(effectiveValue(selector, property, viewport)).toBe("text");
        }
      }
    }
  });

  /**
   * The `auto` used value follows the parent, but a declaration on a descendant replaces
   * it. The guard therefore holds only while nothing else re-enables selection.
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
   * Only the guard on `body` may suppress selection broadly. Every other suppression must
   * be a reviewed component selector.
   */
  it("suppresses selection only through the body guard or a reviewed component selector", () => {
    const offenders = selectionRules
      .filter((rule) => rule.value === "none")
      .flatMap((rule) => rule.selectors)
      .map((selector) => selector.trim())
      .filter(
        (selector) =>
          selector !== "body" &&
          !(
            SINGLE_COMPONENT_SELECTOR.test(selector) &&
            SCOPED_SUPPRESSION_SELECTORS.includes(selector) &&
            !appShellSelectors.includes(selector)
          )
      );
    expect([...new Set(offenders)]).toEqual([]);
  });

  /**
   * Whitespace and quotes never change what a spelling declares, and only the kebab CSS
   * forms are case-insensitive to their parser, so exactly those are lowercased; the
   * `=`/`:` fold makes a DOM assignment and a style-object entry the same token.
   */
  function normalizeToken(token: string): string {
    const compact = token.replace(/\s+/g, "").replace(/["'`]/g, "").replace("=", ":");
    return /^-?(?:webkit-|moz-|ms-|o-)?user-select/i.test(compact)
      ? compact.toLowerCase()
      : compact;
  }

  interface SourceSpan {
    start: number;
    end: number;
  }

  function sourceWithoutComments(relativePath: string, source: string): string {
    if (/\.[cm]?[jt]sx?$/.test(relativePath)) {
      const sourceFile = ts.createSourceFile(
        relativePath,
        source,
        ts.ScriptTarget.Latest,
        true,
        scriptKindForPath(relativePath)
      );
      const tokenSpans: SourceSpan[] = [];
      const collectTokenSpans = (node: ts.Node) => {
        const children = node.getChildren(sourceFile);
        if (children.length === 0) {
          tokenSpans.push({ start: node.getStart(sourceFile, false), end: node.end });
          return;
        }
        children.forEach(collectTokenSpans);
      };
      collectTokenSpans(sourceFile);

      let result = "";
      let copiedThrough = 0;
      const copyCommentlessGap = (end: number) => {
        result += source
          .slice(copiedThrough, end)
          .replace(/^#![^\r\n]*(?:\r?\n|$)/, " ")
          .replace(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\r\n]*/g, " ");
      };
      for (const span of tokenSpans) {
        copyCommentlessGap(span.start);
        result += source.slice(span.start, span.end);
        copiedThrough = span.end;
      }
      copyCommentlessGap(source.length);
      return result;
    }
    if (/\.(?:html|md|svg)$/.test(relativePath)) {
      return source.replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
    }
    return source;
  }

  function matchedTokens(relativePath: string, source: string, pattern: RegExp): string[] {
    if ([...source.matchAll(pattern)].length === 0) {
      return [];
    }
    return [...sourceWithoutComments(relativePath, source).matchAll(pattern)].map((match) =>
      normalizeToken(match[0])
    );
  }

  function propertyNameText(name: ts.PropertyName): string | undefined {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
      return name.text;
    }
    return undefined;
  }

  function accessName(expression: ts.Expression): string | undefined {
    const candidate = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(candidate)) {
      return candidate.name.text;
    }
    if (ts.isElementAccessExpression(candidate)) {
      return stringLiteralValue(candidate.argumentExpression);
    }
    return undefined;
  }

  function accessBase(expression: ts.Expression): ts.Expression | undefined {
    const candidate = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) {
      return candidate.expression;
    }
    return undefined;
  }

  function inlineSelectionTokens(
    relativePath: string,
    source: string,
    kind: SelectionSiteKind
  ): string[] {
    if (!/(?:[A-Za-z]userSelect|\buserSelect\b|user-select)/i.test(source)) {
      return [];
    }

    const tokens: string[] = [];
    const record = (property: string, expression: ts.Expression) => {
      const literal = stringLiteralValue(expression)?.trim().toLowerCase();
      if (literal === undefined) {
        throw new Error(`Unsupported dynamic inline selection value: ${expression.getText()}`);
      }
      if (literal === "") {
        return;
      }
      const suppression = literal === "none";
      if ((kind === "suppression") !== suppression) {
        return;
      }
      tokens.push(normalizeToken(suppression ? `${property}:none` : property));
    };
    const collectCss = (cssText: string) => {
      const root = postcss.parse(`x{${cssText}}`);
      root.walkDecls((decl) => {
        const property = decl.prop.toLowerCase();
        if (!SELECTION_PROPERTY_PATTERN.test(property)) {
          return;
        }
        record(property, ts.factory.createStringLiteral(decl.value.trim()));
      });
    };

    if (relativePath.endsWith(".html")) {
      const dom = new JSDOM(source);
      for (const element of dom.window.document.querySelectorAll("[style]")) {
        const style = element.getAttribute("style");
        if (style) {
          collectCss(style);
        }
      }
      dom.window.close();
      return tokens;
    }
    if (!EXECUTABLE_SOURCE.test(relativePath)) {
      return tokens;
    }

    const filePath = resolve(REPO_ROOT, relativePath);
    const options: ts.CompilerOptions = {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      noLib: true,
      noResolve: true,
      target: ts.ScriptTarget.Latest,
    };
    const sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(relativePath)
    );
    const defaultHost = ts.createCompilerHost(options);
    const host: ts.CompilerHost = {
      ...defaultHost,
      fileExists: (requestedPath) => resolve(requestedPath) === filePath,
      getSourceFile: (requestedPath) =>
        resolve(requestedPath) === filePath ? sourceFile : undefined,
      readFile: (requestedPath) => (resolve(requestedPath) === filePath ? source : undefined),
    };
    const checker = ts.createProgram({ rootNames: [filePath], options, host }).getTypeChecker();
    const resolvedSymbol = (node: ts.Node): ts.Symbol | undefined =>
      checker.getSymbolAtLocation(node);
    const isConstDeclaration = (declaration: ts.VariableDeclaration): boolean =>
      ts.isVariableDeclarationList(declaration.parent) &&
      Boolean(declaration.parent.flags & ts.NodeFlags.Const);
    const visitedSymbols = new Set<ts.Symbol>();

    const collectStyleExpression = (expression: ts.Expression): void => {
      const candidate = unwrapExpression(expression);
      if (ts.isObjectLiteralExpression(candidate)) {
        for (const property of candidate.properties) {
          if (ts.isSpreadAssignment(property)) {
            collectStyleExpression(property.expression);
          } else if (ts.isPropertyAssignment(property)) {
            const name = propertyNameText(property.name);
            const selectionProperty = name ? INLINE_SELECTION_PROPERTIES[name] : undefined;
            if (selectionProperty) {
              record(selectionProperty, property.initializer);
            }
          } else if (ts.isShorthandPropertyAssignment(property)) {
            const selectionProperty = INLINE_SELECTION_PROPERTIES[property.name.text];
            if (selectionProperty) {
              record(selectionProperty, property.name);
            }
          }
        }
        return;
      }
      if (ts.isIdentifier(candidate)) {
        const symbol = resolvedSymbol(candidate);
        if (!symbol || visitedSymbols.has(symbol)) {
          return;
        }
        const declaration = symbol.valueDeclaration;
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          isConstDeclaration(declaration)
        ) {
          visitedSymbols.add(symbol);
          collectStyleExpression(declaration.initializer);
        }
        return;
      }
      if (ts.isConditionalExpression(candidate)) {
        collectStyleExpression(candidate.whenTrue);
        collectStyleExpression(candidate.whenFalse);
        return;
      }
      if (
        ts.isCallExpression(candidate) &&
        ts.isPropertyAccessExpression(candidate.expression) &&
        ts.isIdentifier(candidate.expression.expression) &&
        candidate.expression.expression.text === "Object" &&
        candidate.expression.name.text === "assign"
      ) {
        candidate.arguments.forEach(collectStyleExpression);
      }
    };

    const collectPropsExpression = (expression: ts.Expression): void => {
      const candidate = unwrapExpression(expression);
      if (ts.isObjectLiteralExpression(candidate)) {
        for (const property of candidate.properties) {
          if (ts.isSpreadAssignment(property)) {
            collectPropsExpression(property.expression);
          } else if (
            ts.isPropertyAssignment(property) &&
            propertyNameText(property.name) === "style"
          ) {
            collectStyleExpression(property.initializer);
          }
        }
        return;
      }
      if (ts.isIdentifier(candidate)) {
        const symbol = resolvedSymbol(candidate);
        const declaration = symbol?.valueDeclaration;
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          isConstDeclaration(declaration)
        ) {
          collectPropsExpression(declaration.initializer);
        }
      }
    };

    const isStyleObject = (expression: ts.Expression): boolean => {
      const candidate = unwrapExpression(expression);
      if (
        (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) &&
        accessName(candidate) === "style"
      ) {
        return true;
      }
      if (ts.isIdentifier(candidate)) {
        const declaration = resolvedSymbol(candidate)?.valueDeclaration;
        return Boolean(
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          isConstDeclaration(declaration) &&
          isStyleObject(declaration.initializer)
        );
      }
      return false;
    };

    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "style") {
        const initializer = node.initializer;
        if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
          collectStyleExpression(initializer.expression);
        }
      } else if (ts.isJsxSpreadAttribute(node)) {
        collectPropsExpression(node.expression);
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const property = accessName(node.left);
        const base = accessBase(node.left);
        const selectionProperty = property ? INLINE_SELECTION_PROPERTIES[property] : undefined;
        if (selectionProperty && base && isStyleObject(base)) {
          record(selectionProperty, node.right);
        } else if (property === "cssText" && base && isStyleObject(base)) {
          const cssText = stringLiteralValue(node.right);
          if (cssText !== undefined) {
            collectCss(cssText);
          }
        }
      } else if (ts.isCallExpression(node)) {
        const method = accessName(node.expression);
        const receiver = accessBase(node.expression);
        if (method === "setProperty" && receiver && isStyleObject(receiver)) {
          const property = stringLiteralValue(node.arguments[0]);
          const value = node.arguments[1];
          const selectionProperty = property ? INLINE_SELECTION_PROPERTIES[property] : undefined;
          if (selectionProperty && value) {
            record(selectionProperty, value);
          }
        } else if (method === "setAttribute" && stringLiteralValue(node.arguments[0]) === "style") {
          const cssText = stringLiteralValue(node.arguments[1]);
          if (cssText !== undefined) {
            collectCss(cssText);
          }
        } else if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "createElement" &&
          node.arguments[1]
        ) {
          collectPropsExpression(node.arguments[1]);
        } else if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "createElement" &&
          node.arguments[1]
        ) {
          collectPropsExpression(node.arguments[1]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return tokens;
  }

  function selectionTokens(
    relativePath: string,
    source: string,
    kind: SelectionSiteKind
  ): string[] {
    const pattern = kind === "opt-in" ? SELECTION_OPT_IN_PATTERN : SELECTION_SUPPRESSION_PATTERN;
    return [
      ...matchedTokens(relativePath, source, pattern),
      ...inlineSelectionTokens(relativePath, source, kind),
    ];
  }

  it("finds runtime imports without matching comments, strings, or type-only imports", () => {
    const source = [
      '// do not import "@/node/comment"',
      "const copy = 'import \"@/desktop/copy\"';",
      'import type { NodeType } from "@/node/type";',
      'import { type CliType } from "@/cli/type";',
      'export type { DesktopType } from "@/desktop/type";',
      'export { type NodeType } from "@/node/reexport";',
      'import {} from "@/node/empty-import";',
      'export {} from "@/desktop/empty-export";',
      'import Browser from "@/browser/value";',
      'import "@/browser/side-effect";',
      'import BrowserAlias = require("@/browser/equal");',
      'import type NodeAlias = require("@/node/equal");',
      'export { commonValue } from "@/common/value";',
      'void import(("@/constants/dynamic"));',
      'const value = require("@/version" as const);',
    ].join("\n");
    expect(
      [...importedSegments(source, resolve(REPO_ROOT, "src/browser/example.ts"))].sort()
    ).toEqual(["browser", "common", "constants", "version"]);
  });

  it("keeps empty JavaScript imports that still execute their modules", () => {
    const source = [
      'import {} from "@/node/empty-import";',
      'export {} from "@/desktop/empty-export";',
    ].join("\n");
    expect(
      [...importedSegments(source, resolve(REPO_ROOT, "src/browser/example.js"))].sort()
    ).toEqual(["desktop", "node"]);
  });

  it("inventories inline selection writes without matching reads or declarations", () => {
    const source = [
      "interface SelectionOptions { userSelect: string }",
      "const current = element.style.userSelect;",
      'const unrelated = { userSelect: "none" };',
      'const shared = { userSelect: "text" };',
      "const view = <>",
      "  <div style={shared} />",
      '  <span {...{ style: { WebkitUserSelect: "none" } }} />',
      "</>;",
      'document.body.style.userSelect = "none";',
      'document.body.style.userSelect = "";',
      'document.body.style.setProperty("-moz-user-select", "none");',
      'document.body.setAttribute("style", "user-select:all");',
      'React.createElement("div", { style: { msUserSelect: "none" } });',
    ].join("\n");

    expect({
      optIns: selectionTokens("component.tsx", source, "opt-in").sort(),
      suppressions: selectionTokens("component.tsx", source, "suppression").sort(),
    }).toEqual({
      optIns: ["user-select", "userSelect"],
      suppressions: [
        "-moz-user-select:none",
        "WebkitUserSelect:none",
        "msUserSelect:none",
        "userSelect:none",
      ],
    });
  });

  it("ignores comments while inventorying selection sites", () => {
    const cases = [
      {
        relativePath: "component.tsx",
        source: [
          "#!/usr/bin/env bun --select-none",
          'const className = "select-text"; // select-none',
          'const style = <div style={{ userSelect: "text" }} />; /* userSelect: "none" */',
          "const current = element.style.userSelect;",
          "interface SelectionOptions { userSelect: string }",
          'const unrelated = { userSelect: "none" };',
          "const view = <><span>https://example.test</span>",
          '<button className="select-none" />{/* select-none */}</>;',
          'const template = `/* select-all */ ${/* select-none */ "select-text"}`;',
          "const pattern = /https?:\\/\\/example/;",
        ].join("\n"),
        optIns: ["select-text", "userSelect", "select-all", "select-text"],
        suppressions: ["select-none"],
      },
      {
        relativePath: "index.html",
        source: '<div class="select-text"><!-- select-none --></div>',
        optIns: ["select-text"],
        suppressions: [],
      },
    ];
    for (const { relativePath, source, optIns, suppressions } of cases) {
      expect({
        relativePath,
        optIns: selectionTokens(relativePath, source, "opt-in").sort(),
        suppressions: selectionTokens(relativePath, source, "suppression").sort(),
      }).toEqual({
        relativePath,
        optIns: [...optIns].sort(),
        suppressions: [...suppressions].sort(),
      });
    }
  });

  async function collectSelectionSites(
    kind: SelectionSiteKind
  ): Promise<Record<string, Record<string, number>>> {
    const sites: Record<string, Record<string, number>> = {};
    const collectInto = (key: string, source: string) => {
      for (const token of selectionTokens(key, source, kind)) {
        const fileSites = (sites[key] ??= {});
        fileSites[token] = (fileSites[token] ?? 0) + 1;
      }
    };
    for (const relativePath of runtimeSourceFiles()) {
      collectInto(relativePath, await readFile(resolve(REPO_ROOT, relativePath), "utf8"));
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
      collectInto(
        relative(REPO_ROOT, resolved).replaceAll("\\", "/"),
        await readFile(resolved, "utf8")
      );
    }
    return sites;
  }

  it("opts content back into selection only in reviewed components", async () => {
    expect(await collectSelectionSites("opt-in")).toEqual(SELECTION_OPT_INS);
  });

  it("suppresses selection in source only at reviewed sites", async () => {
    expect(await collectSelectionSites("suppression")).toEqual(SELECTION_SUPPRESSIONS);
  });

  it("scans executable renderer sources but not non-runtime files", () => {
    const runtimeSources = new Set(runtimeSourceFiles());
    expect({
      production: [
        "src/browser/features/Settings/Sections/GeneralSection.tsx",
        "src/browser/features/Analytics/sqlExplorerSampleQueryRunner.cjs",
      ].every((relativePath) => runtimeSources.has(relativePath)),
      excluded: [
        "src/browser/stories/mocks/orpc.ts",
        "src/browser/stories/storyPlayHelpers.ts",
        "src/browser/features/Settings/Sections/settingsStoryUtils.tsx",
        "src/browser/assets/icons/README.md",
        "src/browser/assets/icons/openai.svg",
        "src/browser/assets/file-icons/seti-icon-theme.json",
      ].filter((relativePath) => runtimeSources.has(relativePath)),
    }).toEqual({ production: true, excluded: [] });
  });

  /**
   * Drift guard for RENDERER_SEGMENTS: if browser code starts importing a new `src/`
   * segment at runtime, that segment's files become renderer-visible and must join the
   * inventory scan, so an unlisted import fails here rather than being silently exempt.
   * Only the browser segment is checked because `src/common` legitimately runtime-
   * imports `@/node` in corners the renderer never reaches; a segment reachable only
   * through common is the accepted residual of segment-level granularity.
   */
  it("scans every segment the renderer imports directly", async () => {
    const unlisted = new Set<string>();
    for (const relativePath of runtimeSourceFiles()) {
      if (!relativePath.startsWith("src/browser/")) {
        continue;
      }
      const source = await readFile(resolve(REPO_ROOT, relativePath), "utf8");
      for (const segment of importedSegments(source, resolve(REPO_ROOT, relativePath))) {
        if (!RENDERER_SEGMENTS.includes(segment)) {
          unlisted.add(segment);
        }
      }
    }
    expect([...unlisted]).toEqual([]);
  });

  it("leaves content selectable for fine pointers", () => {
    // Controls are not exempted here: `button` and `[role="button"]` both wrap
    // selectable content in this codebase (skill descriptions, diff hunks, copyable
    // IDs), so suppressing them app-wide would break copying on desktop.
    for (const viewport of FINE_VIEWPORTS) {
      for (const selector of ["body", "button", '[role="button"]']) {
        for (const property of RECOGNIZED_SELECTION_PROPERTIES) {
          expect(effectiveValue(selector, property, viewport)).not.toBe("none");
        }
      }
    }
  });
});
