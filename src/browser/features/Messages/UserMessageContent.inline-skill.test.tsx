import "../../../../tests/ui/dom";

import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { DisplayedUserMessage, InlineSkillSnapshotMap } from "@/common/types/message";
import type { EditingMessageState } from "@/browser/utils/chatEditing";
import { UserMessage } from "./UserMessage";
import { UserMessageContent, WorkflowDefinitionPreviewCard } from "./UserMessageContent";
import { installDom } from "../../../../tests/ui/dom";

function createSkillSnapshot(skillName: string): InlineSkillSnapshotMap[string] {
  return {
    skillName,
    scope: "global",
    snapshot: {
      frontmatterYaml: `name: ${skillName}`,
      body: `Skill body for ${skillName}`,
    },
  };
}

function getSkillBadges(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-component="AgentSkillBadge"]'));
}

describe("UserMessageContent inline skill rendering", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders the slash skill badge in sent user messages", () => {
    const slashSnapshot = createSkillSnapshot("deep-review");
    const view = render(
      <UserMessageContent
        content="/deep-review Please run $tdd"
        commandPrefix="/deep-review"
        agentSkillSnapshot={slashSnapshot.snapshot}
        inlineSkillSnapshots={{ tdd: createSkillSnapshot("tdd") }}
        variant="sent"
      />
    );

    // Inline `$skill` Markdown badge rendering is covered directly in
    // InlineSkillMarkdown.test; this composition test only needs the synchronously
    // rendered slash prefix badge so it does not depend on Streamdown timing under
    // full-suite coverage runs.
    const badgeTexts = getSkillBadges(view.container).map((badge) => badge.textContent);
    expect(badgeTexts).toContain("/deep-review");
  });

  test("renders workflow command preview content from the run definition snapshot", () => {
    const workflowSource = `// description: Review deeply\nexport default function workflow() {\n  return { reportMarkdown: "done" };\n}`;
    const view = render(
      <WorkflowDefinitionPreviewCard
        preview={{
          descriptor: {
            name: "deep-review-workflow",
            description: "Review deeply",
            scope: "built-in",
            executable: true,
          },
          source: workflowSource,
        }}
      />
    );

    expect(view.getByText("deep-review-workflow")).toBeTruthy();
    expect(view.getByText("Review deeply")).toBeTruthy();
    expect(view.container.textContent).toContain("export default function workflow");
    expect(
      view.getByRole("region", { name: "Source for workflow deep-review-workflow" }).tabIndex
    ).toBe(0);
  });

  test("opens the slash workflow preview from the focusable command badge", async () => {
    const view = render(
      <UserMessageContent
        content="/deep-review-workflow Check this"
        commandPrefix="/deep-review-workflow"
        workflowDefinitionPreview={{
          descriptor: {
            name: "deep-review-workflow",
            description: "Review deeply",
            scope: "built-in",
            executable: true,
          },
          source: "export default function workflow() {}",
        }}
        variant="sent"
      />
    );

    const trigger = view.getByRole("button", {
      name: "Show workflow definition preview for deep-review-workflow",
    });
    expect(trigger.textContent).toBe("/deep-review-workflow");

    fireEvent.focus(trigger);

    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });
  });

  test("toggles the slash workflow preview when the focused badge is clicked", async () => {
    const view = render(
      <UserMessageContent
        content="/deep-review-workflow Check this"
        commandPrefix="/deep-review-workflow"
        workflowDefinitionPreview={{
          descriptor: {
            name: "deep-review-workflow",
            description: "Review deeply",
            scope: "built-in",
            executable: true,
          },
          source: "export default function workflow() {}",
        }}
        variant="sent"
      />
    );

    const trigger = view.getByRole("button", {
      name: "Show workflow definition preview for deep-review-workflow",
    });

    fireEvent.focus(trigger);

    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("true");
    });

    fireEvent.click(trigger);

    await waitFor(() => {
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });
  });

  test("keeps edit-mode textarea content as raw text", () => {
    function EditHarness() {
      const [editingMessage, setEditingMessage] = React.useState<EditingMessageState | null>(null);
      const message: DisplayedUserMessage = {
        type: "user",
        id: "display-1",
        historyId: "history-1",
        historySequence: 1,
        content: "Please run $tdd",
        inlineSkillSnapshots: { tdd: createSkillSnapshot("tdd") },
      };

      if (editingMessage) {
        return (
          <textarea
            aria-label="Edit your last message"
            readOnly
            value={editingMessage.pending.content}
          />
        );
      }

      return (
        <TooltipProvider>
          <UserMessage message={message} onEdit={(nextEditing) => setEditingMessage(nextEditing)} />
        </TooltipProvider>
      );
    }

    const view = render(<EditHarness />);

    fireEvent.click(view.getByRole("button", { name: "Edit" }));

    const textarea = view.getByLabelText("Edit your last message");
    if (!(textarea instanceof window.HTMLTextAreaElement)) {
      throw new Error("Expected edit control to be a textarea");
    }

    expect(textarea.value).toBe("Please run $tdd");
    expect(getSkillBadges(view.container)).toHaveLength(0);
  });
});
