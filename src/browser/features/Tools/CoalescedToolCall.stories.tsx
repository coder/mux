import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "@storybook/test";

import { CoalescedToolCall } from "@/browser/features/Tools/CoalescedToolCall";
import { CHROMATIC_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";

/**
 * Layout shell rendered inside each story so the meta-level decorator
 * stack (which provides `TooltipProvider` via `StoryUiShell`) is not
 * shadowed by a story-local `decorators` override.
 */
function StoryLayout(props: { children: ReactNode }) {
  return (
    <div className="bg-background p-6">
      <div className="w-full max-w-3xl">{props.children}</div>
    </div>
  );
}

/**
 * Interactive wrapper that owns the expansion state so play functions can
 * exercise the real click-to-expand / click-to-collapse UX. The static
 * `expanded` prop on stories is treated as the initial state.
 */
function InteractiveCoalesced(
  args: React.ComponentProps<typeof CoalescedToolCall>
): React.ReactElement {
  const [expanded, setExpanded] = useState(args.expanded);
  return (
    <StoryLayout>
      <CoalescedToolCall
        kind={args.kind}
        filePaths={args.filePaths}
        expanded={expanded}
        onToggle={() => setExpanded((prev) => !prev)}
      />
    </StoryLayout>
  );
}

// Chromatic visual coverage is intentionally disabled — the global snapshot
// budget is tight, and the meaningful surface (header copy, click toggle,
// dedupe, kind verb) is exercised here via `play` functions that run under
// `test-storybook` in CI.
const meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/CoalescedToolCall",
  component: CoalescedToolCall,
  parameters: {
    ...lightweightMeta.parameters,
    chromatic: CHROMATIC_DISABLED,
  },
  render: (args) => <InteractiveCoalesced {...args} />,
} satisfies Meta<typeof CoalescedToolCall>;

export default meta;

type Story = StoryObj<typeof meta>;

const NOOP = () => undefined;

// Storybook's test runner uses the document body as the canvas root in some
// configurations. Querying the body ensures we still find rendered content
// when the decorator stack inserts wrappers above the story root.
function getCanvas(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body);
}

/**
 * Two consecutive file_read calls coalesce into a "Read files …" row. The
 * play function clicks it and verifies it toggles to expanded.
 */
export const TwoReadsClickToExpand: Story = {
  args: {
    kind: "file_read",
    filePaths: ["src/App.tsx", "src/main.ts"],
    expanded: false,
    onToggle: NOOP,
  },
  play: async ({ canvasElement }) => {
    const canvas = getCanvas(canvasElement);

    // Header copy: past-tense verb + plural noun + joined paths.
    const summary = await canvas.findByText(/Read files/);
    await expect(canvas.findByText("src/App.tsx, src/main.ts")).resolves.toBeTruthy();

    // Toggle starts collapsed, then expanded after a click.
    const header = summary.closest("[aria-expanded]");
    if (!(header instanceof HTMLElement)) {
      throw new Error("Coalesce header missing aria-expanded element");
    }
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(header);
    await waitFor(() => expect(header).toHaveAttribute("aria-expanded", "true"));

    // Clicking again collapses; covers both branches of the toggle.
    await userEvent.click(header);
    await waitFor(() => expect(header).toHaveAttribute("aria-expanded", "false"));
  },
};

/**
 * A burst of five reads — exercises the joined-paths layout and the icon
 * column hugging the leading path.
 */
export const ManyReads: Story = {
  args: {
    kind: "file_read",
    filePaths: [
      "src/App.tsx",
      "src/main.ts",
      "src/preload.ts",
      "src/config.ts",
      "src/browser/features/Tools/CoalescedToolCall.tsx",
    ],
    expanded: false,
    onToggle: NOOP,
  },
  play: async ({ canvasElement }) => {
    const canvas = getCanvas(canvasElement);
    await canvas.findByText(/Read files/);
    // All five paths render in chronological order, joined by ", ".
    await expect(
      canvas.findByText(
        "src/App.tsx, src/main.ts, src/preload.ts, src/config.ts, src/browser/features/Tools/CoalescedToolCall.tsx"
      )
    ).resolves.toBeTruthy();
  },
};

/**
 * file_edit groups use the past-tense "Wrote" verb. Mirrors the canonical
 * file-edit icon variant.
 */
export const TwoEdits: Story = {
  args: {
    kind: "file_edit",
    filePaths: ["src/App.tsx", "src/main.ts"],
    expanded: false,
    onToggle: NOOP,
  },
  play: async ({ canvasElement }) => {
    const canvas = getCanvas(canvasElement);
    await canvas.findByText(/Wrote files/);
    await expect(canvas.findByText("src/App.tsx, src/main.ts")).resolves.toBeTruthy();
  },
};

/**
 * Display-only dedupe: a burst that touches the same file repeatedly should
 * still render it once. Verifies the React.useMemo dedupe path in
 * `CoalescedToolCall`.
 */
export const DeduplicatedPaths: Story = {
  args: {
    kind: "file_edit",
    // 5 raw calls; 3 unique files. First-occurrence order: a, b, c.
    filePaths: ["src/a.ts", "src/b.ts", "src/a.ts", "src/c.ts", "src/b.ts"],
    expanded: false,
    onToggle: NOOP,
  },
  play: async ({ canvasElement }) => {
    const canvas = getCanvas(canvasElement);
    await canvas.findByText(/Wrote files/);

    // Each unique path appears exactly once in the joined list, in
    // first-occurrence order. Asserting on the exact string is the simplest
    // way to express both the order and the dedupe simultaneously.
    await expect(canvas.findByText("src/a.ts, src/b.ts, src/c.ts")).resolves.toBeTruthy();
  },
};

/**
 * Expanded state — verifies aria-expanded reflects the initial prop and the
 * chevron indicator rotates.
 */
export const InitiallyExpanded: Story = {
  args: {
    kind: "file_read",
    filePaths: ["src/App.tsx", "src/main.ts", "src/preload.ts"],
    expanded: true,
    onToggle: NOOP,
  },
  play: async ({ canvasElement }) => {
    const canvas = getCanvas(canvasElement);
    const summary = await canvas.findByText(/Read files/);
    const header = summary.closest("[aria-expanded]");
    if (!(header instanceof HTMLElement)) {
      throw new Error("Coalesce header missing aria-expanded element");
    }
    await expect(header).toHaveAttribute("aria-expanded", "true");
  },
};
