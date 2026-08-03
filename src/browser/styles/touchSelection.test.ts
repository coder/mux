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
 * Spellings of suppression are excluded here and tracked by the suppression pattern
 * below instead; the empty-string reset is neither. An inline value this pattern cannot
 * see, such as a variable or a conditional, counts as an opt-in: a match is a review
 * gate, and the cost of a false positive is one entry below.
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
 * The complement: every spelling that suppresses selection, in the same forms as the
 * opt-in pattern. `user-select` inherits, so `select-none` on a control is safe while
 * the same class on an application-wide container (the App.tsx shell) disables desktop
 * selection for everything under it, and which one a line is cannot be told from the
 * class name. Both directions are therefore review gates against the same enumeration
 * machinery; a suppression added anywhere is one entry, reviewed for what it wraps.
 */
const SELECTION_SUPPRESSION_PATTERN = new RegExp(
  [
    String.raw`\b(?:[A-Za-z0-9_-]+:)*select-none\b`,
    String.raw`\bselect-\[none\]`,
    String.raw`\[(?:-(?:webkit|moz|ms|o)-)?user-select:none\]`,
    String.raw`\b(?:[Ww]ebkit|[Mm]oz|[Mm]s|O)?[uU]serSelect\b\s*[:=]\s*["'\`]none["'\`]`,
    `(?:-(?:${anyCase("webkit")}|${anyCase("moz")}|${anyCase("ms")}|${anyCase("o")})-)?\\b${anyCase("user-select")}\\b\\s*:\\s*${anyCase("none")}\\b`,
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

/**
 * Sites that suppress selection, pinned with the same line-plus-content identity as the
 * opt-ins above. Most entries are the ordinary per-control use; the enumeration exists
 * because the exceptional case, suppression on an app-wide container, is
 * indistinguishable from it in a static scan, so a human reviews what each new or moved
 * suppression wraps. Generated mechanically from the current tree; regenerate an entry
 * by running the test and copying the reported diff.
 */
const SELECTION_SUPPRESSIONS: Record<string, string[]> = {
  "src/browser/components/AgentListItem/AgentListItem.tsx": [
    '"bg-surface-primary relative flex items-start gap-1.5 rounded-l-sm py-2 pr-1.5 select-none transition-all duration-150";\nconst HIDE_INLINE_ACTIONS_ON_MOBILE_TOUCH =',
  ],
  "src/browser/components/ChatPane/TranscriptHydrationSkeleton.tsx": [
    'className="flex flex-col gap-8 py-6 select-none"\n>',
  ],
  "src/browser/components/Checkbox/Checkbox.stories.tsx": [
    '<label htmlFor={props.id} className="text-sm select-none">\n{props.label}',
  ],
  "src/browser/components/FileIcon/FileIcon.tsx": ['userSelect: "none",\nfontStyle: "normal",'],
  "src/browser/components/InstructionsTab/AdditionalSystemContextScratchpad.tsx": [
    '<label className="flex cursor-pointer items-center gap-1.5 select-none">\n<input',
  ],
  "src/browser/components/ProjectSidebar/ProjectSidebar.tsx": [
    '"group sticky top-0 z-30 py-2 pl-2 pr-1 flex select-none items-center border-l-transparent bg-surface-primary transition-colors duration-150";\n// Shared classes for the chevron toggle buttons on project/section headers.',
    '"font-primary bg-surface-primary border-border-light relative flex flex-1 select-none flex-col overflow-hidden border-r",\n// In desktop mode when collapsed, hide border (LeftSidebar handles the partial border)',
  ],
  "src/browser/components/ProjectSidebar/TaskGroupListItem.tsx": [
    '"bg-surface-primary relative flex items-start rounded-l-sm py-2 pr-2 select-none transition-all duration-150 hover:bg-surface-secondary",\nprops.sectionId != null ? "ml-2" : "ml-0",',
  ],
  "src/browser/components/ScrollArea/ScrollArea.tsx": [
    '"z-40 flex touch-none select-none bg-transparent transition-colors",\norientation === "vertical" ? "h-full w-1.5" : "h-1.5 flex-col",',
  ],
  "src/browser/components/SectionHeader/SectionHeader.tsx": [
    'className="group relative ml-0 flex items-center gap-1 py-1.5 pr-1 pl-2.5 select-none"\ndata-section-id={section.id}',
  ],
  "src/browser/components/SelectPrimitive/SelectPrimitive.tsx": [
    '"hover:bg-hover focus:bg-hover relative flex w-full cursor-default select-none items-center rounded-sm py-1.5 pr-2 pl-6 text-xs outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50",\nclassName',
  ],
  "src/browser/components/Switch/Switch.stories.tsx": [
    '<span className="text-sm select-none">{props.label}</span>\n</div>',
  ],
  "src/browser/components/ThinkingSlider/ProModeToggle.tsx": [
    '"hover:bg-hover shrink-0 rounded-sm bg-transparent px-1 text-center text-[11px] transition-all duration-200 select-none",\nprops.className',
  ],
  "src/browser/components/ThinkingSlider/ThinkingSlider.tsx": [
    '"text-foreground w-[5ch] shrink-0 text-center text-[11px] font-medium select-none";\ninterface ThinkingControlProps {',
  ],
  "src/browser/components/TitleBar/TitleBar.tsx": [
    '"bg-sidebar border-border-light font-primary text-muted titlebar-safe-left titlebar-safe-left-gutter-4 flex shrink-0 items-center justify-between border-b px-4 text-[11px] select-none",\nisDesktop ? DESKTOP_TITLEBAR_HEIGHT_CLASS : "h-8",',
  ],
  "src/browser/features/ChatInput/CreationControls.tsx": [
    '"focus:bg-hover data-[state=checked]:bg-hover relative flex cursor-default select-none items-center rounded-sm py-1.5 pr-3 pl-3 text-xs outline-none",\n"data-[disabled]:pointer-events-none data-[disabled]:opacity-50"',
  ],
  "src/browser/features/Messages/ChatBarrier/StreamingBarrierView.tsx": [
    '"text-assistant-border counter-nums-mono inline-flex min-w-[14ch] items-baseline justify-end text-[11px] whitespace-nowrap select-none",\nprops.tokenCount === undefined && "invisible"',
    '"text-muted text-[11px] whitespace-nowrap select-none",\n// Low-priority hints yield to the status label in narrow panes',
  ],
  "src/browser/features/Messages/MarkdownComponents.tsx": [
    '<summary className="cursor-pointer py-1 pl-1 font-semibold select-none">{children}</summary>\n),',
  ],
  "src/browser/features/Messages/OperationalBundleMessage.tsx": [
    '"flex w-full cursor-pointer items-center gap-2 text-left text-secondary transition-colors select-none hover:text-foreground",\n"focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"',
  ],
  "src/browser/features/Messages/ReasoningMessage.tsx": [
    '"flex items-center justify-between gap-2 select-none",\nisCollapsible && "cursor-pointer",',
  ],
  "src/browser/features/Messages/WorkBundleMessage.tsx": [
    '"text-muted hover:text-foreground flex w-full cursor-pointer items-center gap-2 border-b border-border/60 py-3 text-left text-base transition-colors select-none",\n"focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"',
  ],
  "src/browser/features/RightSidebar/BrowserTab/BrowserViewport.tsx": [
    'className="pointer-events-none absolute top-1/2 left-1/2 max-h-full max-w-full -translate-x-1/2 -translate-y-1/2 select-none"\ndraggable={false}',
  ],
  "src/browser/features/RightSidebar/CodeReview/FileTree.tsx": [
    '"cursor-pointer select-none flex items-center gap-1.5 rounded py-0.5 px-1.5",\nisSelected ? "bg-code-keyword-overlay" : "bg-transparent hover:bg-white/5"',
  ],
  "src/browser/features/RightSidebar/CodeReview/ImmersiveDiffRevealLoadingState.tsx": [
    'className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 overflow-hidden px-4 py-5 select-none"\n>',
  ],
  "src/browser/features/RightSidebar/CodeReview/ReviewPanel.tsx": [
    "<details className=\"bg-modal-bg border-border-light [&_summary]:text-muted mt-4 w-full max-w-96 cursor-pointer rounded border p-3 [&_summary]:flex [&_summary]:list-none [&_summary]:items-center [&_summary]:gap-1.5 [&_summary]:text-xs [&_summary]:font-medium [&_summary]:select-none [&_summary::-webkit-details-marker]:hidden [&_summary::before]:text-[10px] [&_summary::before]:transition-transform [&_summary::before]:duration-200 [&_summary::before]:content-['\u25b6'] [&[open]_summary::before]:rotate-90\">\n<summary>Show diagnostic info</summary>",
  ],
  "src/browser/features/RightSidebar/StatsTab.tsx": [
    '<label className="text-muted flex items-center gap-2 text-xs select-none">\n<input',
  ],
  "src/browser/features/Shared/DiffRenderer.tsx": [
    'className="flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"\nstyle={{ background: resolvedBackground }}',
    'className={cn("relative text-center select-none", isInteractive && "cursor-pointer")}\nstyle={{ background }}',
    'className="flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"\nstyle={{ background: getDiffLineGutterBackground(lineType) }}',
    'className="flex shrink-0 items-center gap-0.5 px-1 tabular-nums select-none"\nstyle={{ background: getDiffLineGutterBackground(lineType) }}',
  ],
  "src/browser/features/Tools/AgentSkillReadFileToolCall.tsx": [
    '<div className="text-secondary font-monospace mr-2 min-w-10 border-r border-white/10 pr-3 text-right opacity-40 select-none">\n{parsedContent.lineNumbers.map((lineNum, i) => (',
  ],
  "src/browser/features/Tools/AskUserQuestionToolCall.tsx": [
    '"flex cursor-pointer items-start gap-2.5 rounded px-2 py-1.5 transition-colors select-none",\nchecked ? "bg-accent/10 hover:bg-accent/15" : "hover:bg-white/5"',
  ],
  "src/browser/features/Tools/FileReadToolCall.tsx": [
    '<div className="text-secondary font-monospace mr-2 min-w-10 border-r border-white/10 pr-3 text-right opacity-40 select-none">\n{parsedContent.lineNumbers.map((lineNum, i) => (',
  ],
  "src/browser/features/Tools/GoogleSearchToolCall.fixtures.ts": [
    "user-select: none;\nmargin: 0 8px;",
  ],
  "src/browser/features/Tools/Shared/HookOutputDisplay.tsx": [
    '"transition-colors cursor-pointer select-none"\n)}',
  ],
  "src/browser/features/Tools/Shared/ToolPrimitives.tsx": [
    '"flex items-center gap-2 cursor-pointer select-none text-secondary hover:text-foreground",\nclassName',
  ],
  "src/browser/hooks/useResizableSidebar.ts": [
    'document.body.style.userSelect = "none";\ndocument.body.style.cursor = "col-resize";',
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

  async function collectSelectionSites(pattern: RegExp): Promise<Record<string, string[]>> {
    const sites: Record<string, string[]> = {};
    const collectInto = (key: string, source: string) => {
      for (const match of source.matchAll(pattern)) {
        const lineStart = source.lastIndexOf("\n", match.index) + 1;
        const lineEnd = source.indexOf("\n", match.index);
        const line = source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).trim();
        const following = source
          .slice(lineEnd === -1 ? source.length : lineEnd + 1)
          .split("\n")
          .map((candidate) => candidate.trim())
          .find((candidate) => candidate !== "");
        (sites[key] ??= []).push(`${line}\n${following ?? ""}`);
      }
    };
    // Test files are skipped: they ship no UI, and this file names the utilities it matches.
    for await (const relativePath of new Glob("**/*.{ts,tsx}").scan({ cwd: SOURCE_DIR })) {
      if (/\.test\.tsx?$/.test(relativePath)) {
        continue;
      }
      collectInto(
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
      collectInto(
        relative(REPO_ROOT, resolved).replaceAll("\\", "/"),
        await readFile(resolved, "utf8")
      );
    }
    return sites;
  }

  it("opts content back into selection only in reviewed components", async () => {
    expect(await collectSelectionSites(SELECTION_OPT_IN_PATTERN)).toEqual(SELECTION_OPT_INS);
  });

  it("suppresses selection in source only at reviewed sites", async () => {
    expect(await collectSelectionSites(SELECTION_SUPPRESSION_PATTERN)).toEqual(
      SELECTION_SUPPRESSIONS
    );
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
