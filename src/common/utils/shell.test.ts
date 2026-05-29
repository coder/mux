import { describe, expect, test } from "bun:test";
import { shellQuote } from "./shell";

describe("shellQuote", () => {
  test("quotes regular strings", () => {
    expect(shellQuote("foo")).toBe("'foo'");
    expect(shellQuote("main")).toBe("'main'");
    expect(shellQuote("feature/branch")).toBe("'feature/branch'");
  });

  test("handles empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  test("escapes single quotes", () => {
    expect(shellQuote("it's")).toBe("'it'\"'\"'s'");
    expect(shellQuote("'")).toBe("''\"'\"''");
  });

  test("handles special characters safely", () => {
    // These should all be safely quoted
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
    expect(shellQuote("`id`")).toBe("'`id`'");
    expect(shellQuote("foo;rm -rf /")).toBe("'foo;rm -rf /'");
    expect(shellQuote("a\nb")).toBe("'a\nb'");
  });
});
