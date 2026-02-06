import { describe, expect, test } from "bun:test";
import { extractIdentityFromText } from "./workspaceTitleGenerator";

describe("extractIdentityFromText", () => {
  test("extracts from markdown bold + backtick format", () => {
    const text = [
      'Based on the development task "testing", here are my recommendations:',
      "",
      "**name:** `testing`",
      "- Concise, git-safe (lowercase), and clearly identifies the codebase area",
      "",
      "**title:** `Improve test coverage`",
      "- Follows the verb-noun format and describes the testing work generically",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "testing", title: "Improve test coverage" });
  });

  test("extracts from embedded JSON object", () => {
    const text =
      'Here is the result: {"name": "sidebar", "title": "Fix sidebar layout"} as requested.';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "sidebar", title: "Fix sidebar layout" });
  });

  test("extracts from JSON with reverse field order", () => {
    const text = '{"title": "Add user auth", "name": "auth"}';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "auth", title: "Add user auth" });
  });

  test("extracts from quoted values in prose", () => {
    const text = 'The name: "config" and title: "Refactor config loading"';
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "config", title: "Refactor config loading" });
  });

  test("sanitizes name to be git-safe", () => {
    const text = ["**name:** `My Feature`", "**title:** `Add cool feature`"].join("\n");
    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "my-feature", title: "Add cool feature" });
  });

  test("returns null for empty text", () => {
    expect(extractIdentityFromText("")).toBeNull();
  });

  test("returns null when only name is present", () => {
    const text = "**name:** `testing`\nSome other content without title";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null when only title is present", () => {
    const text = "**title:** `Fix bugs`\nSome other content without name";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null when name is too short after sanitization", () => {
    const text = "**name:** `-`\n**title:** `Fix something here`";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null when title is too short", () => {
    const text = "**name:** `auth`\n**title:** `Fix`";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("returns null for completely unrelated text", () => {
    const text = "I'm sorry, I cannot help with that request. Please try again.";
    expect(extractIdentityFromText(text)).toBeNull();
  });

  test("handles the exact failing response from the bug report", () => {
    // This is the exact text content from the claude-haiku response that triggered the bug.
    // In the raw API response JSON, newlines are escaped as \n — once parsed they become
    // real newline characters in the string that NoObjectGeneratedError.text carries.
    const text = [
      'Based on the development task "testing", here are my recommendations:',
      "",
      "**name:** `testing`",
      "- Concise, git-safe (lowercase), and clearly identifies the codebase area",
      "",
      "**title:** `Improve test coverage`",
      "- Follows the verb-noun format and describes the testing work generically",
      "",
      "These are suitable for a testing-focused development task.",
    ].join("\n");

    const result = extractIdentityFromText(text);
    expect(result).toEqual({ name: "testing", title: "Improve test coverage" });
  });
});
