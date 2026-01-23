import { describe, it, expect } from "bun:test";
import { appendLiveBashOutputChunk } from "./liveBashOutputBuffer";

describe("appendLiveBashOutputChunk", () => {
  it("appends stdout and stderr independently", () => {
    const a = appendLiveBashOutputChunk(undefined, { text: "out1\n", isError: false }, 1024);
    expect(a.stdout).toBe("out1\n");
    expect(a.stderr).toBe("");
    expect(a.combined).toBe("out1\n");
    expect(a.truncated).toBe(false);

    const b = appendLiveBashOutputChunk(a, { text: "err1\n", isError: true }, 1024);
    expect(b.stdout).toBe("out1\n");
    expect(b.stderr).toBe("err1\n");
    expect(b.combined).toBe("out1\nerr1\n");
    expect(b.truncated).toBe(false);
  });

  it("supports phase-only updates", () => {
    const a = appendLiveBashOutputChunk(undefined, { text: "out\n", isError: false }, 1024);
    expect(a.phase).toBeUndefined();

    const b = appendLiveBashOutputChunk(a, { text: "", isError: false, phase: "filtering" }, 1024);
    expect(b.combined).toBe("out\n");
    expect(b.phase).toBe("filtering");

    // Phase-only updates should be referentially stable when nothing changes.
    const c = appendLiveBashOutputChunk(b, { text: "", isError: false, phase: "filtering" }, 1024);
    expect(c).toBe(b);

    const d = appendLiveBashOutputChunk(b, { text: "", isError: false, phase: "output" }, 1024);
    expect(d.phase).toBe("output");
  });

  it("normalizes carriage returns to newlines", () => {
    const a = appendLiveBashOutputChunk(undefined, { text: "a\rb", isError: false }, 1024);
    expect(a.stdout).toBe("a\nb");
    expect(a.combined).toBe("a\nb");

    const b = appendLiveBashOutputChunk(undefined, { text: "a\r\nb", isError: false }, 1024);
    expect(b.stdout).toBe("a\nb");
    expect(b.combined).toBe("a\nb");
  });

  it("drops the oldest segments to enforce maxBytes", () => {
    const maxBytes = 5;
    const a = appendLiveBashOutputChunk(undefined, { text: "1234", isError: false }, maxBytes);
    expect(a.stdout).toBe("1234");
    expect(a.combined).toBe("1234");
    expect(a.truncated).toBe(false);

    const b = appendLiveBashOutputChunk(a, { text: "abc", isError: false }, maxBytes);
    expect(b.stdout).toBe("abc");
    expect(b.combined).toBe("abc");
    expect(b.truncated).toBe(true);
  });

  it("drops multiple segments when needed", () => {
    const maxBytes = 6;
    const a = appendLiveBashOutputChunk(undefined, { text: "a", isError: false }, maxBytes);
    const b = appendLiveBashOutputChunk(a, { text: "bb", isError: true }, maxBytes);
    const c = appendLiveBashOutputChunk(b, { text: "ccc", isError: false }, maxBytes);

    // total "a" (1) + "bb" (2) + "ccc" (3) = 6 (fits)
    expect(c.stdout).toBe("accc");
    expect(c.stderr).toBe("bb");
    expect(c.combined).toBe("abbccc");
    expect(c.truncated).toBe(false);

    const d = appendLiveBashOutputChunk(c, { text: "DD", isError: true }, maxBytes);
    // total would be 8, so drop oldest segments until <= 6.
    // Drops stdout "a" (1) then stderr "bb" (2) => remaining "ccc" (3) + "DD" (2) = 5
    expect(d.stdout).toBe("ccc");
    expect(d.stderr).toBe("DD");
    expect(d.combined).toBe("cccDD");
    expect(d.truncated).toBe(true);
  });

  it("drops a single chunk larger than the cap", () => {
    const maxBytes = 3;
    const a = appendLiveBashOutputChunk(undefined, { text: "hello", isError: false }, maxBytes);
    expect(a.stdout).toBe("");
    expect(a.stderr).toBe("");
    expect(a.combined).toBe("");
    expect(a.truncated).toBe(true);
  });
});
