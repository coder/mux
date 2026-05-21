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
  test("returns intent, command, and completed duration when intent is present", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "waiting for the dev instance to start" }),
        result: completedResult,
        isBackground: false,
      })
    ).toEqual({
      kind: "intent-command",
      intent: "Waiting for the dev instance to start",
      command,
      durationLabel: "30.1s",
    });
  });

  test("falls back to the command when intent is missing, blank, or repeats the command", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs(),
        isBackground: false,
      })
    ).toEqual({ kind: "command", command });

    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "   " }),
        isBackground: false,
      })
    ).toEqual({ kind: "command", command });

    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: null }),
        isBackground: false,
      })
    ).toEqual({ kind: "command", command });

    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: command.toUpperCase() }),
        isBackground: false,
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

  test("strips the last redundant using clause when intent text also contains using", () => {
    expect(
      sanitizeModelIntent(
        "checking health using the API using curl localhost:8080/health",
        "curl localhost:8080/health"
      )
    ).toBe("Checking health using the API");
  });

  test("returns undefined when suffix stripping removes the whole intent", () => {
    expect(sanitizeModelIntent("using `ls`", "ls")).toBeUndefined();
  });

  test("runs a second sanitize pass when one strip exposes another suffix", () => {
    expect(sanitizeModelIntent("doing work using ls for 5s for 10s", "ls")).toBe("Doing work");
  });
});
