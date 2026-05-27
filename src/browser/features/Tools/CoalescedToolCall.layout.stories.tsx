import type { ReactElement, ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { waitFor } from "@storybook/test";

import { CoalescedToolCall } from "@/browser/features/Tools/CoalescedToolCall";
import { FileEditToolCall } from "@/browser/features/Tools/FileEditToolCall";
import { FileReadToolCall } from "@/browser/features/Tools/FileReadToolCall";
import { CHROMATIC_DISABLED, lightweightMeta } from "@/browser/stories/meta.js";

const NOOP = () => undefined;

function ToolProbe(props: { id: string; children: ReactNode }): ReactElement {
  return <div data-testid={props.id}>{props.children}</div>;
}

function getToolSurface(root: HTMLElement, id: string): HTMLElement {
  const probe = root.querySelector(`[data-testid="${id}"]`);
  const surface = probe?.querySelector<HTMLElement>('[data-transcript-row-surface="tool"]');
  if (!surface) {
    throw new Error(`Missing tool surface for ${id}`);
  }
  return surface;
}

function assertHeightParity(a: HTMLElement, b: HTMLElement, label: string): void {
  const delta = Math.abs(a.getBoundingClientRect().height - b.getBoundingClientRect().height);
  if (delta > 1) {
    throw new Error(`${label} changed by ${delta.toFixed(2)}px`);
  }
}

function assertNoLayoutTransition(surface: HTMLElement, label: string): void {
  const transitionProperty = getComputedStyle(surface).transitionProperty;
  const forbiddenProperties = ["all", "height", "max-height", "padding", "margin"];

  for (const property of forbiddenProperties) {
    if (transitionProperty.includes(property)) {
      throw new Error(`${label} must not transition ${property}; got ${transitionProperty}`);
    }
  }
}

function LayoutContractFixture(): ReactElement {
  return (
    <div className="bg-background p-6">
      <div className="w-[640px] leading-[1.5] break-words whitespace-pre-wrap">
        <ToolProbe id="single-read">
          <FileReadToolCall
            args={{ path: "src/App.tsx" }}
            result={{
              success: true,
              content: "1\tconsole.log('hello');",
              file_size: 21,
              modifiedTime: "2026-05-26T00:00:00.000Z",
              lines_read: 1,
            }}
            status="completed"
          />
        </ToolProbe>

        <ToolProbe id="coalesced-read">
          <CoalescedToolCall
            kind="file_read"
            filePaths={["src/App.tsx", "src/main.ts"]}
            status="completed"
            expanded={false}
            onToggle={NOOP}
          />
        </ToolProbe>

        <ToolProbe id="single-edit">
          <FileEditToolCall
            toolName="file_edit_replace_string"
            args={{ path: "src/App.tsx", old_string: "hello", new_string: "hi" }}
            result={{
              success: true,
              diff: "--- src/App.tsx\n+++ src/App.tsx\n@@ -1 +1 @@\n-hello\n+hi",
              edits_applied: 1,
            }}
            status="completed"
          />
        </ToolProbe>

        <ToolProbe id="coalesced-edit">
          <CoalescedToolCall
            reserveActionSlot={true}
            kind="file_edit"
            filePaths={["src/App.tsx", "src/main.ts"]}
            status="completed"
            expanded={false}
            onToggle={NOOP}
          />
        </ToolProbe>

        <div className="w-[280px]">
          <ToolProbe id="narrow-coalesced-read">
            <CoalescedToolCall
              kind="file_read"
              filePaths={[
                "src/browser/features/Tools/CoalescedToolCall.layout.stories.tsx",
                "src/browser/components/ChatPane/ChatPane.tsx",
              ]}
              status="executing"
              expanded={false}
              onToggle={NOOP}
            />
          </ToolProbe>
        </div>
      </div>
    </div>
  );
}

const meta: Meta = {
  ...lightweightMeta,
  title: "App/Chat/Tools/CoalescedToolCall Layout Contract",
  component: LayoutContractFixture,
  parameters: {
    ...lightweightMeta.parameters,
    chromatic: CHROMATIC_DISABLED,
  },
  render: () => <LayoutContractFixture />,
};

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Real-browser layout guardrail for transcript row swaps. Coalesced summaries
 * replace the head tool row in-place, so their collapsed height and transition
 * contract must stay aligned with the single-row tool baseline.
 */
export const StableRowSwapContract: Story = {
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument.body;

    await waitFor(() => {
      if (!root.querySelector('[data-testid="coalesced-read"]')) {
        throw new Error("Coalesced read probe has not rendered yet");
      }
    });

    const singleRead = getToolSurface(root, "single-read");
    const coalescedRead = getToolSurface(root, "coalesced-read");
    const singleEdit = getToolSurface(root, "single-edit");
    const coalescedEdit = getToolSurface(root, "coalesced-edit");
    const narrowCoalescedRead = getToolSurface(root, "narrow-coalesced-read");

    assertHeightParity(singleRead, coalescedRead, "file_read coalesce summary row height");
    assertHeightParity(singleEdit, coalescedEdit, "file_edit coalesce summary row height");
    assertHeightParity(singleRead, narrowCoalescedRead, "narrow coalesce summary stays one row");

    for (const [label, surface] of [
      ["single read", singleRead],
      ["coalesced read", coalescedRead],
      ["single edit", singleEdit],
      ["coalesced edit", coalescedEdit],
      ["narrow coalesced read", narrowCoalescedRead],
    ] as const) {
      assertNoLayoutTransition(surface, label);
    }
  },
};
