import { describe, expect, test } from "bun:test";

import {
  extractSkillDynamicCommands,
  injectSkillDynamicContext,
  MAX_SKILL_DYNAMIC_COMMANDS,
  SKILL_DYNAMIC_OUTPUT_CAP_BYTES,
  type SkillDynamicExecResult,
} from "./skillDynamicContext";

function okExec(stdout: string): SkillDynamicExecResult {
  return { stdout, stderr: "", exitCode: 0 };
}

describe("extractSkillDynamicCommands", () => {
  test("matches whole-line directives including surrounding whitespace", () => {
    const body = ["Intro", "!`git status`", "  !`git log -1`  ", "Outro"].join("\n");
    expect(extractSkillDynamicCommands(body)).toEqual(["git status", "git log -1"]);
  });

  test("ignores mid-line and inline directives", () => {
    const body = [
      "Run !`git status` before continuing.",
      "prefix !`echo hi`",
      "!`echo hi` suffix",
    ].join("\n");
    expect(extractSkillDynamicCommands(body)).toEqual([]);
  });

  test("ignores lines that merely contain backticks or are malformed", () => {
    const body = [
      "`git status`",
      "! `git status`",
      "!``",
      "!`unterminated",
      "!`nested ` backtick`",
      "plain text",
    ].join("\n");
    expect(extractSkillDynamicCommands(body)).toEqual([]);
  });

  test("caps extraction at the directive limit", () => {
    const body = Array.from({ length: 15 }, (_, i) => `!\`echo ${i}\``).join("\n");
    const commands = extractSkillDynamicCommands(body);
    expect(commands).toHaveLength(MAX_SKILL_DYNAMIC_COMMANDS);
    expect(commands[0]).toBe("echo 0");
    expect(commands[commands.length - 1]).toBe(`echo ${MAX_SKILL_DYNAMIC_COMMANDS - 1}`);
  });

  test("returns empty for a body without directives", () => {
    expect(extractSkillDynamicCommands("just text\nmore text")).toEqual([]);
  });
});

describe("injectSkillDynamicContext", () => {
  test("replaces a directive line with a labeled fenced output block", async () => {
    const result = await injectSkillDynamicContext({
      body: "Before\n!`git status`\nAfter",
      execute: () => Promise.resolve(okExec("clean tree\n")),
    });

    expect(result.injected).toBe(true);
    expect(result.body).toBe(
      ["Before", "```text (output of: git status)", "clean tree", "```", "After"].join("\n")
    );
  });

  test("leaves bodies without directives untouched", async () => {
    let called = false;
    const body = "No directives here.\nRun !`inline` stays literal.";
    const result = await injectSkillDynamicContext({
      body,
      execute: () => {
        called = true;
        return Promise.resolve(okExec("x"));
      },
    });

    expect(result.injected).toBe(false);
    expect(result.body).toBe(body);
    expect(called).toBe(false);
  });

  test("combines stdout and stderr and annotates non-zero exit codes", async () => {
    const result = await injectSkillDynamicContext({
      body: "!`failing command`",
      execute: () => Promise.resolve({ stdout: "partial output\n", stderr: "boom\n", exitCode: 2 }),
    });

    expect(result.body).toBe(
      [
        "```text (output of: failing command)",
        "partial output",
        "boom",
        "[exit code 2]",
        "```",
      ].join("\n")
    );
  });

  test("shows a placeholder for empty output", async () => {
    const result = await injectSkillDynamicContext({
      body: "!`true`",
      execute: () => Promise.resolve(okExec("")),
    });

    expect(result.body).toContain("[no output]");
  });

  test("injects a bracketed note when execution throws", async () => {
    const result = await injectSkillDynamicContext({
      body: "Before\n!`broken`\nAfter",
      execute: () => Promise.reject(new Error("spawn failed")),
    });

    expect(result.body).toBe(
      ["Before", "[output of: broken unavailable: spawn failed]", "After"].join("\n")
    );
  });

  test("injects a timeout note when execution exceeds the timeout", async () => {
    const result = await injectSkillDynamicContext({
      body: "!`sleep forever`",
      execute: () => new Promise(() => undefined),
      timeoutMs: 20,
    });

    expect(result.body).toBe("[output of: sleep forever unavailable: timed out after 0.02s]");
  });

  test("truncates oversized output with a marker", async () => {
    const bigOutput = "x".repeat(SKILL_DYNAMIC_OUTPUT_CAP_BYTES + 100);
    const result = await injectSkillDynamicContext({
      body: "!`big`",
      execute: () => Promise.resolve(okExec(bigOutput)),
    });

    expect(result.body).toContain("[output truncated at 16KB]");
    // Cap applies to the output content (marker/fence lines are additional).
    const contentLine = result.body.split("\n")[1];
    expect(Buffer.byteLength(contentLine, "utf-8")).toBeLessThanOrEqual(
      SKILL_DYNAMIC_OUTPUT_CAP_BYTES
    );
  });

  test("extends the fence when output contains triple backticks", async () => {
    const result = await injectSkillDynamicContext({
      body: "!`show fences`",
      execute: () => Promise.resolve(okExec("```js\ncode\n```")),
    });

    const lines = result.body.split("\n");
    expect(lines[0]).toBe("````text (output of: show fences)");
    expect(lines[lines.length - 1]).toBe("````");
    expect(result.body).toContain("```js");
  });

  test("executes directives sequentially in body order", async () => {
    const started: string[] = [];
    let inFlight = 0;
    const result = await injectSkillDynamicContext({
      body: "!`first`\nmiddle\n!`second`\n!`third`",
      execute: async (command) => {
        started.push(command);
        inFlight += 1;
        expect(inFlight).toBe(1); // no parallelism
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return okExec(`ran ${command}`);
      },
    });

    expect(started).toEqual(["first", "second", "third"]);
    expect(result.body).toContain("ran first");
    expect(result.body).toContain("ran second");
    expect(result.body).toContain("ran third");
  });

  test("leaves directives past the limit literal with a note", async () => {
    const executed: string[] = [];
    const body = Array.from(
      { length: MAX_SKILL_DYNAMIC_COMMANDS + 2 },
      (_, i) => `!\`echo ${i}\``
    ).join("\n");
    const result = await injectSkillDynamicContext({
      body,
      execute: (command) => {
        executed.push(command);
        return Promise.resolve(okExec("out"));
      },
    });

    expect(executed).toHaveLength(MAX_SKILL_DYNAMIC_COMMANDS);
    expect(result.body).toContain(`!\`echo ${MAX_SKILL_DYNAMIC_COMMANDS}\``);
    expect(result.body).toContain(`!\`echo ${MAX_SKILL_DYNAMIC_COMMANDS + 1}\``);
    expect(result.body).toContain(
      `[skill dynamic context: directive limit (${MAX_SKILL_DYNAMIC_COMMANDS}) reached; not executed]`
    );
  });

  test("a failing directive does not prevent later directives from running", async () => {
    const result = await injectSkillDynamicContext({
      body: "!`bad`\n!`good`",
      execute: (command) => {
        if (command === "bad") return Promise.reject(new Error("nope"));
        return Promise.resolve(okExec("fine"));
      },
    });

    expect(result.body).toContain("[output of: bad unavailable: nope]");
    expect(result.body).toContain("fine");
  });
});
