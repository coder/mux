import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";
import type { DelegationInsights } from "@/common/orpc/schemas/chatStats";
import { DelegationInsightsSection } from "./DelegationInsightsSection";

const BASE_INSIGHTS: DelegationInsights = {
  children: [
    { workspaceId: "explore-1", agentType: "explore", totalTokens: 62_400 },
    { workspaceId: "exec-2", agentType: "exec", totalTokens: 142_000 },
    { workspaceId: "exec-1", agentType: "exec", totalTokens: 198_000 },
  ],
  totalChildTokens: 402_400,
  exploreTokensConsumed: 62_400,
  exploreReportTokens: 3_100,
  compressionRatio: 20.1,
  actualCompactions: 2,
  estimatedWithoutDelegation: 11,
  compactionsAvoided: 9,
  hasData: true,
};

function createInsights(overrides: Partial<DelegationInsights>): DelegationInsights {
  return {
    ...BASE_INSIGHTS,
    ...overrides,
  };
}

describe("DelegationInsightsSection", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders nothing when hasData is false", () => {
    const view = render(
      <DelegationInsightsSection insights={createInsights({ hasData: false, children: [] })} />
    );

    expect(view.container.textContent).toBe("");
  });

  test("shows compression ratio when explore report data exists", () => {
    const view = render(<DelegationInsightsSection insights={BASE_INSIGHTS} />);

    expect(view.getByTestId("delegation-compression").textContent).toContain("20:1");
    expect(view.getByTestId("delegation-compression").textContent).toContain("62.4k");
    expect(view.getByTestId("delegation-compression").textContent).toContain("3.1k");
  });

  test("hides compression card when compressionRatio is 0", () => {
    const view = render(
      <DelegationInsightsSection
        insights={createInsights({
          compressionRatio: 0,
          exploreReportTokens: 0,
          exploreTokensConsumed: 0,
        })}
      />
    );

    expect(view.queryByTestId("delegation-compression")).toBeNull();
  });

  test("shows compactions avoided with percentage", () => {
    const view = render(<DelegationInsightsSection insights={BASE_INSIGHTS} />);

    expect(view.getByTestId("delegation-compactions").textContent).toContain("9 (82%)");
  });

  test("hides compactions card when compactionsAvoided is 0", () => {
    const view = render(
      <DelegationInsightsSection
        insights={createInsights({
          compactionsAvoided: 0,
          estimatedWithoutDelegation: 0,
          actualCompactions: 0,
        })}
      />
    );

    expect(view.queryByTestId("delegation-compactions")).toBeNull();
  });

  test("shows per-child breakdown sorted by tokens descending", () => {
    const view = render(<DelegationInsightsSection insights={BASE_INSIGHTS} />);

    const rows = view.getAllByTestId("delegation-child-bar");
    expect(rows).toHaveLength(3);

    const rowText = rows.map((row) => row.textContent ?? "");
    expect(rowText[0]).toContain("198.0k");
    expect(rowText[1]).toContain("142.0k");
    expect(rowText[2]).toContain("62.4k");
  });
});
