import { describe, it, expect } from "bun:test";
import { STATUS_MESSAGE_MAX_LENGTH } from "@/common/constants/toolLimits";
import { parseAgentStatusFromLine } from "./parseAgentStatus";

describe("parseAgentStatusFromLine", () => {
  it("extracts leading emoji and first URL, removing URL from message", () => {
    const parsed = parseAgentStatusFromLine(
      "🚀 PR #123 waiting for CI https://github.com/example/repo/pull/123"
    );

    expect(parsed).toEqual({
      emoji: "🚀",
      message: "PR #123 waiting for CI",
      url: "https://github.com/example/repo/pull/123",
    });
  });

  it("does not treat an emoji as leading emoji when not followed by whitespace", () => {
    const parsed = parseAgentStatusFromLine("✅Done");
    expect(parsed).toEqual({ message: "✅Done" });
  });

  it("truncates after URL extraction", () => {
    const long = `✅ ${"a".repeat(STATUS_MESSAGE_MAX_LENGTH + 20)} https://example.com/pr/1`;
    const parsed = parseAgentStatusFromLine(long);

    expect(parsed.emoji).toBe("✅");
    expect(parsed.url).toBe("https://example.com/pr/1");
    expect(parsed.message.length).toBe(STATUS_MESSAGE_MAX_LENGTH);
    expect(parsed.message.endsWith("…")).toBe(true);
  });
});
