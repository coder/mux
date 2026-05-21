import { describe, expect, test } from "bun:test";

import type { BashToolArgs, BashToolResult } from "@/common/types/tools";
import {
  buildBashCollapsedSummary,
  sanitizeModelIntent,
  summarizeBashCommands,
} from "./bashCollapsedSummary";

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
        displayMode: "command",
      })
    ).toEqual({ kind: "command", command });
  });

  test("falls back to the default summary mode for invalid display mode values", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "Waiting for the dev instance to start" }),
        result: completedResult,
        isBackground: false,
        displayMode: "invalid",
      })
    ).toEqual({
      kind: "intent-command",
      intent: "Waiting for the dev instance to start",
      command,
      durationLabel: "30.1s",
    });
  });

  test("returns intent, command, and completed duration in intent-command mode", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "waiting for the dev instance to start" }),
        result: completedResult,
        isBackground: false,
        displayMode: "intent-command",
      })
    ).toEqual({
      kind: "intent-command",
      intent: "Waiting for the dev instance to start",
      command,
      durationLabel: "30.1s",
    });
  });

  test("returns command names only in compact mode", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "Waiting for the dev instance to start" }),
        result: completedResult,
        isBackground: false,
        displayMode: "compact",
      })
    ).toEqual({ kind: "compact-command", command, commandSummary: "sleep, tail" });
  });

  test("falls back to the command when intent is missing, blank, or repeats the command", () => {
    expect(
      buildBashCollapsedSummary({
        args: createArgs(),
        isBackground: false,
        displayMode: "intent-command",
      })
    ).toEqual({ kind: "command", command });

    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: "   " }),
        isBackground: false,
        displayMode: "intent-command",
      })
    ).toEqual({ kind: "command", command });

    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: null }),
        isBackground: false,
        displayMode: "intent-command",
      })
    ).toEqual({ kind: "command", command });

    expect(
      buildBashCollapsedSummary({
        args: createArgs({ model_intent: command.toUpperCase() }),
        isBackground: false,
        displayMode: "intent-command",
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
        displayMode: "intent-command",
      })
    ).toEqual({
      kind: "intent-command",
      intent: "Starting the dev server",
      command,
    });
  });
});

describe("summarizeBashCommands", () => {
  test.each([
    [
      "deduplicates command names across shell control operators",
      "cd /repo && git push && git status",
      "cd, git",
    ],
    [
      "handles wrappers, assignments, paths, and pipes",
      "env MUX_ESLINT_CONCURRENCY=2 make static-check && ./scripts/wait_pr_ready.sh 3337 | sed -n '1,2p'",
      "make, wait_pr_ready.sh, sed",
    ],
    [
      "skips env options with required arguments before command names",
      "env -C /repo -u FOO git status && env --chdir=/repo --unset=BAR gh pr view 1 && env -iu BAZ make test",
      "git, gh, make",
    ],
    [
      "skips simple wrapper options before command names",
      "time -p git status && exec -ca newname bash -lc 'echo hi' && command -p make test",
      "git, bash, make",
    ],
    ["skips redirection-only wrapper fragments", "exec >/tmp/mux.log && git status", "git"],
    [
      "ignores shell keywords while keeping commands inside blocks",
      'set -euo pipefail\nfor pr in 1 2; do\n  gh pr view "$pr"\ndone',
      "set, gh",
    ],
    [
      "skips attached leading redirections before command names",
      ">/tmp/mux.log make test && 2>/dev/null git status && 2>&1 gh pr view 1",
      "make, git, gh",
    ],
    [
      "does not split noclobber redirection targets into command names",
      "printf hi >|/tmp/out && git status",
      "printf, git",
    ],
    [
      "skips brace group reserved words before command names",
      "{ git status; } && gh pr view 1",
      "git, gh",
    ],
    [
      "skips subshell group delimiters before command names",
      "(git status) && ( gh pr view 1 )",
      "git, gh",
    ],
    [
      "skips heredoc bodies before command extraction",
      "cat <<'EOF'\nhello from heredoc\nEOF\ngit status",
      "cat, git",
    ],
    [
      "keeps pipeline commands from heredoc declaration lines",
      "cat <<-EOF | sed -n '1p'\n\thello\n\tEOF\ngh pr view 1",
      "cat, sed, gh",
    ],
    [
      "ignores arithmetic bit shifts when scanning for heredocs",
      "echo $((1<<2))\ngit status\n((x<<=1))\ngh pr view 1",
      "echo, git, gh",
    ],
    [
      "does not split arithmetic for loop headers into command names",
      'for ((i=0; i<10; i++)); do echo "$i"; done && git status',
      "echo, git",
    ],
    [
      "skips case arm labels before command names",
      'case "$target" in\n  foo|bar) gh pr view 1 ;;\n  baz) make test ;;\nesac',
      "gh, make",
    ],
    [
      "skips spaced case arm alternatives before command names",
      'case "$target" in\n  foo | bar | baz ) gh pr view 1 ;;\nesac',
      "gh",
    ],
    [
      "skips variable-backed case arm labels before command names",
      'case "$target" in\n  $pattern) gh pr view 1 ;;\nesac',
      "gh",
    ],
    [
      "does not split control operators inside quoted text",
      "printf 'a && b' && git status",
      "printf, git",
    ],
  ])("%s", (_caseName, command, expected) => {
    expect(summarizeBashCommands(command)).toBe(expected);
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
