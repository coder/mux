import { describe, expect, it } from "bun:test";
import { SSHRuntime } from "./SSHRuntime";

/**
 * SSHRuntime constructor tests (run with bun test)
 *
 * Note: SSH workspace operation tests (renameWorkspace, deleteWorkspace) require Docker
 * and are in ssh-workspace.jest-test.ts - run with: TEST_INTEGRATION=1 bun x jest
 */
describe("SSHRuntime constructor", () => {
  it("should accept tilde in srcBaseDir", () => {
    // Tildes are now allowed - they will be resolved via resolvePath()
    expect(() => {
      new SSHRuntime({
        host: "example.com",
        srcBaseDir: "~/mux",
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
        srcBaseDir: "/home/user/mux",
      });
    }).not.toThrow();
  });
});
