import { describe, it, expect } from "bun:test";
import { generatePlaceholderName } from "./workspaceTitleGenerator";

describe("generatePlaceholderName", () => {
  it("should generate a git-safe name from message", () => {
    const result = generatePlaceholderName("Add user authentication feature");
    expect(result).toBe("add-user-authentication-featur");
  });

  it("should handle special characters", () => {
    const result = generatePlaceholderName("Fix bug #123 in user/profile");
    expect(result).toBe("fix-bug-123-in-user-profile");
  });

  it("should truncate long messages", () => {
    const result = generatePlaceholderName(
      "This is a very long message that should be truncated to fit within the maximum length"
    );
    expect(result.length).toBeLessThanOrEqual(30);
    expect(result).toBe("this-is-a-very-long-message-th");
  });

  it("should return default name for empty/whitespace input", () => {
    expect(generatePlaceholderName("")).toBe("new-workspace");
    expect(generatePlaceholderName("   ")).toBe("new-workspace");
  });

  it("should handle unicode characters", () => {
    const result = generatePlaceholderName("Add émojis 🚀 and accénts");
    expect(result).toBe("add-mojis-and-acc-nts");
  });

  it("should handle only special characters", () => {
    const result = generatePlaceholderName("!@#$%^&*()");
    expect(result).toBe("new-workspace");
  });
});
