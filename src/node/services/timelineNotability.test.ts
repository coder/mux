import { describe, expect, test } from "bun:test";
import { isNotableToolCall } from "./timelineNotability";

describe("isNotableToolCall", () => {
  test("records allowlisted mutating tools", () => {
    expect(isNotableToolCall("file_edit_insert", { path: "src/app.ts" }, { success: true })).toBe(
      true
    );
    expect(isNotableToolCall("task", { title: "Fix tests" }, { status: "running" })).toBe(true);
  });

  test("records memory mutations but not reads", () => {
    expect(isNotableToolCall("memory", { command: "create" }, { success: true })).toBe(true);
    expect(isNotableToolCall("memory", { command: "view" }, { success: true })).toBe(false);
  });

  test("drops routine bash reads", () => {
    expect(isNotableToolCall("bash", { script: "ls -la" }, { success: true })).toBe(false);
    expect(isNotableToolCall("bash", { script: "cat package.json" }, { success: true })).toBe(
      false
    );
  });

  test("records bash commands with a mutating command head", () => {
    expect(isNotableToolCall("bash", { script: "git commit -m test" }, { success: true })).toBe(
      true
    );
  });

  test("records failed calls regardless of tool name", () => {
    expect(isNotableToolCall("file_read", { path: "missing" }, { success: false })).toBe(true);
    expect(isNotableToolCall("unknown_tool", {}, { error: "failed" })).toBe(true);
  });
});
