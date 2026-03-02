import { describe, expect, test } from "bun:test";
import { buildCheckoutScript, buildRemoteBranchListScript } from "./branchScripts";

describe("BranchSelector command builders", () => {
  test("shell-quotes branch names in checkout script", () => {
    const maliciousBranch = "feature/$(id>/tmp/mux_branch_injection_poc)";

    expect(buildCheckoutScript(maliciousBranch)).toBe(
      "git checkout 'feature/$(id>/tmp/mux_branch_injection_poc)' -- 2>&1"
    );
  });

  test("shell-quotes branch names containing single quotes", () => {
    expect(buildCheckoutScript("feature/it's")).toBe("git checkout 'feature/it'\"'\"'s' -- 2>&1");
  });

  test("shell-quotes remote names in remote branch listing script", () => {
    const maliciousRemote = "origin';touch /tmp/mux_remote_injection;#";

    expect(buildRemoteBranchListScript(maliciousRemote, 50)).toBe(
      "git branch -r --list --sort=-committerdate --format='%(refname:short)' -- 'origin'\"'\"';touch /tmp/mux_remote_injection;#/*' 2>/dev/null | head -51"
    );
  });
});
