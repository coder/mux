import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render } from "@testing-library/react";

import { ContextUsageBar } from "@/browser/components/RightSidebar/ContextUsageBar";
import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

describe("ContextUsageBar compaction warning", () => {
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

  test("shows warning when compaction model is smaller than threshold", () => {
    const data: TokenMeterData = {
      segments: [{ type: "input", tokens: 100, percentage: 10, color: "#000" }],
      totalTokens: 100,
      maxTokens: 1000,
      totalPercentage: 10,
    };

    const view = render(
      <TooltipProvider>
        <ContextUsageBar
          data={data}
          autoCompaction={{
            threshold: 80,
            setThreshold: () => {},
            contextWarning: { compactionModelMaxTokens: 500, thresholdTokens: 800 },
          }}
        />
      </TooltipProvider>
    );

    expect(view.getByText(/Compaction model context/i)).toBeTruthy();
  });

  test("does not show warning when contextWarning is absent", () => {
    const data: TokenMeterData = {
      segments: [{ type: "input", tokens: 100, percentage: 10, color: "#000" }],
      totalTokens: 100,
      maxTokens: 1000,
      totalPercentage: 10,
    };

    const view = render(
      <TooltipProvider>
        <ContextUsageBar data={data} autoCompaction={{ threshold: 80, setThreshold: () => {} }} />
      </TooltipProvider>
    );

    expect(view.queryByText(/Compaction model context/i)).toBeNull();
  });
});
