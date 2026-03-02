import { describe, expect, test } from "bun:test";
import { buildCheckoutCommand, buildRemoteBranchListCommand } from "./branchCommands";

describe("BranchSelector command builders", () => {
  test("keeps branch names as a single checkout argv element", () => {
    const maliciousBranch = "feature/$(id>/tmp/mux_branch_injection_poc)";

    expect(buildCheckoutCommand(maliciousBranch)).toEqual({
      command: "git",
      args: ["checkout", "feature/$(id>/tmp/mux_branch_injection_poc)", "--"],
    });
  });

  test("preserves branch names containing single quotes", () => {
    expect(buildCheckoutCommand("feature/it's")).toEqual({
      command: "git",
      args: ["checkout", "feature/it's", "--"],
    });
  });

  test("keeps remote names as one ref namespace argument", () => {
    const maliciousRemote = "origin';touch /tmp/mux_remote_injection;#";

    expect(buildRemoteBranchListCommand(maliciousRemote, 50)).toEqual({
      command: "git",
      args: [
        "for-each-ref",
        "--sort=-committerdate",
        "--format=%(refname:short)",
        "--count=51",
        "refs/remotes/origin';touch /tmp/mux_remote_injection;#/*",
      ],
    });
  });
});
