import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { installDom } from "../../../../../tests/ui/dom";
void mock.module("@/browser/features/Tools/WorkflowToolShared", () => ({
  WorkflowJsonBlock: (props: { value: unknown; ariaLabel: string }) => (
    <pre aria-label={props.ariaLabel}>{JSON.stringify(props.value)}</pre>
  ),
}));

import type { WorkflowRunView } from "./projectWorkflowRun";
import { WorkflowTimeline } from "./WorkflowTimeline";

function normalizeText(element: Element): string {
  return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function makeCompletedView(): WorkflowRunView {
  const timestamp = "2026-06-25T12:00:00.000Z";
  return {
    id: "wfr_test",
    workflow: {
      name: "test-workflow",
      description: "Test workflow",
      scope: "project",
      executable: true,
    },
    status: "completed",
    argEntries: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    phases: [],
    steps: [],
    result: {
      reportMarkdown: "",
      structuredOutput: {
        outcome: "converged",
        verifierRuns: 1,
        nested: { ignored: true },
      },
    },
    errorMessage: null,
    stats: {
      total: 0,
      done: 0,
      running: 0,
      failed: 0,
      elapsedMs: 0,
    },
  };
}

describe("WorkflowTimeline", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders final report stat chips as bold key before value", () => {
    const { container } = render(<WorkflowTimeline view={makeCompletedView()} />);

    const statTexts = Array.from(container.querySelectorAll("span"), normalizeText);
    const boldTexts = Array.from(container.querySelectorAll("b"), normalizeText);

    expect(statTexts).toContain("outcome converged");
    expect(statTexts).toContain("verifierRuns 1");
    expect(statTexts).not.toContain("converged outcome");
    expect(statTexts).not.toContain("1 verifierRuns");
    expect(boldTexts).toEqual(["outcome", "verifierRuns"]);
  });
});
