import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { TooltipProvider } from "@/browser/components/Tooltip/Tooltip";
import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import {
  TOOL_COLLAPSED_DISPLAY_MODE_KEY,
  type ToolCollapsedDisplayMode,
} from "@/common/constants/storage";
import { installDom } from "../../../../tests/ui/dom";

const emptyForegroundBashToolCallIds = new Set<string>();

void mock.module("./Shared/ElapsedTimeDisplay", () => ({
  ElapsedTimeDisplay: ({
    prefix = "",
    separator = "",
  }: {
    prefix?: string;
    separator?: string;
  }) => (
    <span data-testid="elapsed-time">
      {separator}
      {prefix}1s
    </span>
  ),
}));

void mock.module("@/browser/stores/WorkspaceStore", () => ({
  useBashToolLiveOutput: () => null,
  useLatestStreamingBashId: () => null,
}));

void mock.module("@/browser/stores/BackgroundBashStore", () => ({
  useForegroundBashToolCallIds: () => emptyForegroundBashToolCallIds,
}));

void mock.module("@/browser/contexts/BackgroundBashContext", () => ({
  useBackgroundBashActions: () => ({ sendToBackground: mock(() => undefined) }),
}));

void mock.module(
  "@/browser/components/BackgroundBashOutputDialog/BackgroundBashOutputDialog",
  () => ({
    BackgroundBashOutputDialog: () => null,
  })
);

import { BashToolCall } from "./BashToolCall";

const command = "sleep 30 && tail -30 /tmp/develop.log";

const baseArgs: BashToolArgs = {
  script: command,
  timeout_secs: 60,
  run_in_background: false,
  display_name: "Test command",
  model_intent: "waiting for the dev instance to start",
};

const completedResult: BashToolResult = {
  success: true,
  output: "",
  exitCode: 0,
  wall_duration_ms: 30_100,
};

function renderBashToolCall(displayMode: ToolCollapsedDisplayMode) {
  window.localStorage.setItem(TOOL_COLLAPSED_DISPLAY_MODE_KEY, JSON.stringify(displayMode));
  return render(
    <TooltipProvider>
      <BashToolCall args={baseArgs} result={completedResult} status="completed" />
    </TooltipProvider>
  );
}

describe("BashToolCall", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("shows intent and command when the collapsed summary mode uses intent", () => {
    const view = renderBashToolCall("intent-command");

    expect(view.container.textContent).toContain(
      "Waiting for the dev instance to start using sleep 30 && tail -30 /tmp/develop.log for 30.1s"
    );
    expect(view.container.textContent).not.toContain("timeout: 60s");
  });

  test("shows the legacy command summary when the setting is command", () => {
    const view = renderBashToolCall("command");

    expect(view.container.textContent).toContain(command);
    expect(view.container.textContent).toContain("timeout: 60s");
    expect(view.container.textContent).toContain("took 30s");
    expect(view.container.textContent).not.toContain("Waiting for the dev instance to start");
  });
});
