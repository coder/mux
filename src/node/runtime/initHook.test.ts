import { describe, it, expect } from "bun:test";
import { LineBuffer, createLineBufferedLoggers, getMuxEnv } from "./initHook";
import type { InitLogger } from "./Runtime";

describe("LineBuffer", () => {
  it("should buffer incomplete lines", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("hello ");
    expect(lines).toEqual([]);

    buffer.append("world\n");
    expect(lines).toEqual(["hello world"]);
  });

  it("should handle multiple lines in one chunk", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("line1\nline2\nline3\n");
    expect(lines).toEqual(["line1", "line2", "line3"]);
  });

  it("should handle incomplete line at end", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("line1\nline2\nincomplete");
    expect(lines).toEqual(["line1", "line2"]);

    buffer.flush();
    expect(lines).toEqual(["line1", "line2", "incomplete"]);
  });

  it("should skip empty lines", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("\nline1\n\nline2\n\n");
    expect(lines).toEqual(["line1", "line2"]);
  });

  it("should handle flush with no buffered data", () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));

    buffer.append("line1\n");
    expect(lines).toEqual(["line1"]);

    buffer.flush();
    expect(lines).toEqual(["line1"]); // No change
  });
});

// getMuxEnv tests are placed here because initHook.ts owns the implementation.
describe("createLineBufferedLoggers", () => {
  it("should create separate buffers for stdout and stderr", () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const mockLogger: InitLogger = {
      logStep: () => {
        /* no-op for test */
      },
      logStdout: (line) => stdoutLines.push(line),
      logStderr: (line) => stderrLines.push(line),
      logComplete: () => {
        /* no-op for test */
      },
    };

    const loggers = createLineBufferedLoggers(mockLogger);

    loggers.stdout.append("out1\nout2\n");
    loggers.stderr.append("err1\nerr2\n");

    expect(stdoutLines).toEqual(["out1", "out2"]);
    expect(stderrLines).toEqual(["err1", "err2"]);
  });

  it("should handle incomplete lines and flush separately", () => {
    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const mockLogger: InitLogger = {
      logStep: () => {
        /* no-op for test */
      },
      logStdout: (line) => stdoutLines.push(line),
      logStderr: (line) => stderrLines.push(line),
      logComplete: () => {
        /* no-op for test */
      },
    };

    const loggers = createLineBufferedLoggers(mockLogger);

    loggers.stdout.append("incomplete");
    loggers.stderr.append("also incomplete");

    expect(stdoutLines).toEqual([]);
    expect(stderrLines).toEqual([]);

    loggers.stdout.flush();
    expect(stdoutLines).toEqual(["incomplete"]);
    expect(stderrLines).toEqual([]); // stderr not flushed yet

    loggers.stderr.flush();
    expect(stderrLines).toEqual(["also incomplete"]);
  });
});

describe("getMuxEnv", () => {
  it("should include base MUX_ environment variables", () => {
    const env = getMuxEnv("/path/to/project", "worktree", "feature-branch");

    expect(env.MUX_PROJECT_PATH).toBe("/path/to/project");
    expect(env.MUX_RUNTIME).toBe("worktree");
    expect(env.MUX_WORKSPACE_NAME).toBe("feature-branch");
    expect(env.MUX_MODEL_STRING).toBeUndefined();
    expect(env.MUX_THINKING_LEVEL).toBeUndefined();
  });

  it("should include model + thinking env vars when provided", () => {
    const env = getMuxEnv("/path/to/project", "worktree", "feature-branch", {
      modelString: "openai:gpt-5.2-pro",
      thinkingLevel: "medium",
    });

    expect(env.MUX_MODEL_STRING).toBe("openai:gpt-5.2-pro");
    expect(env.MUX_THINKING_LEVEL).toBe("medium");
  });

  it("should allow explicit thinkingLevel=off", () => {
    const env = getMuxEnv("/path/to/project", "local", "main", {
      modelString: "anthropic:claude-3-5-sonnet",
      thinkingLevel: "off",
    });

    expect(env.MUX_MODEL_STRING).toBe("anthropic:claude-3-5-sonnet");
    expect(env.MUX_THINKING_LEVEL).toBe("off");
  });
});
