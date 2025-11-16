import { describe, expect, it } from "bun:test";
import { SSHRuntime } from "./SSHRuntime";

describe("SSHRuntime constructor", () => {
  it("should accept tilde in srcBaseDir", () => {
    // Tildes are now allowed - they will be resolved via resolvePath()
    expect(() => {
      new SSHRuntime({
        host: "example.com",
        srcBaseDir: "~/cmux",
      });
    }).not.toThrow();
  });

  it("should accept bare tilde in srcBaseDir", () => {
    // Tildes are now allowed - they will be resolved via resolvePath()
    expect(() => {
      new SSHRuntime({
        host: "example.com",
        srcBaseDir: "~",
      });
    }).not.toThrow();
  });

  it("should accept absolute paths in srcBaseDir", () => {
    expect(() => {
      new SSHRuntime({
        host: "example.com",
        srcBaseDir: "/home/user/cmux",
      });
    }).not.toThrow();
  });
});
