import { describe, expect, test } from "bun:test";

import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import { buildBashCollapsedSummary, sanitizeModelIntent } from "./bashCollapsedSummary";

const command = "sleep 30 && tail -30 /tmp/develop.log";

function createArgs(overrides: Partial<BashToolArgs> = {}): BashToolArgs {
  return {
    script: command,
    timeout_secs: 60,
    run_in_background: false,
    display_name: "Test command",
    ...overrides,
  };
}

const completedResult: BashToolResult = {
  success: true,
  output: "",
  exitCode: 0,
  wall_duration_ms: 30_100,
};

describe("buildBashCollapsedSummary", () => {
  test("returns the legacy command summary in command mode", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "Waiting for the dev instance to start" }),
        result: completedResult,
        isBackground: false,
        mode: "command",
      })
    ).toEqual({ kind: "command", command });
  });

  test("returns intent, command, and completed duration in intent-command mode", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "waiting for the dev instance to start" }),
        result: completedResult,
        isBackground: false,
        mode: "intent-command",
      })
    ).toEqual({
      kind: "intent-command",
      intent: "Waiting for the dev instance to start",
      command,
      durationLabel: "30.1s",
    });
  });

  test("falls back to the command when intent is missing or blank", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs(),
        isBackground: false,
        mode: "intent-command",
      })
    ).toEqual({ kind: "command", command });

    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "   " }),
        isBackground: false,
        mode: "intent-command",
      })
    ).toEqual({ kind: "command", command });
  });

  test("omits spawn duration for background commands", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "Starting the dev server", run_in_background: true }),
        result: {
          success: true,
          output: "",
          exitCode: 0,
          wall_duration_ms: 250,
          taskId: "bash:1",
          backgroundProcessId: "proc-1",
        },
        isBackground: true,
        mode: "intent-command",
      })
    ).toEqual({
      kind: "intent-command",
      intent: "Starting the dev server",
      command,
    });
  });
});

describe("sanitizeModelIntent", () => {
  test("strips redundant command and duration suffixes before display", () => {
    expect(
      sanitizeModelIntent(
        "waiting for the dev instance to start using `sleep 30 && tail -30 /tmp/develop.log` for 30.1s",
        command
      )
    ).toBe("Waiting for the dev instance to start");
  });

  test("keeps intent text when a trailing using clause names a different command", () => {
    expect(sanitizeModelIntent("Checking output using cat /tmp/develop.log", command)).toBe(
      "Checking output using cat /tmp/develop.log"
    );
  });
});
