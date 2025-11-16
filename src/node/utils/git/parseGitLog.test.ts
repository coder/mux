import { describe, test, expect } from "bun:test";
import { parseGitShowBranch } from "./parseGitLog";

describe("parseGitShowBranch", () => {
  test("should preserve indicator positions for three-way divergence", () => {
    // Real output from ci-codex workspace showing HEAD (ci-codex), origin/ci-codex, and origin/main
    // Order: HEAD, origin/<branch>, origin/main
    const output = `! [HEAD] 🤖 Trigger CI after resolving Codex comments
 ! [origin/ci-codex] 🤖 Trigger CI after resolving Codex comments
  ! [origin/main] fix: improve compaction
---
  + [9050a56] fix: improve compaction
  + [dad16a3] feat: change interrupt stream keybind to Ctrl+C
  + [5006273] 🤖 Add CI job to block merge on unresolved Codex comments (#76)
++  [027552c] 🤖 Trigger CI after resolving Codex comments
++  [2fe99bf] 🤖 Fix: Check resolved status for Codex review comments
++  [34f3c52] 🤖 Add CI job to block merge on unresolved Codex comments
+++ [9543f22] 🤖 Fix: Restore base64: prefix for CSC_LINK (#75)`;

    const dateMap = new Map([
      ["9050a56", "Oct 07 02:16 PM"],
      ["dad16a3", "Oct 06 11:22 PM"],
      ["5006273", "Oct 06 04:49 PM"],
      ["027552c", "Oct 07 01:16 PM"],
      ["2fe99bf", "Oct 07 12:49 PM"],
      ["34f3c52", "Oct 07 12:22 PM"],
      ["9543f22", "Oct 06 08:49 PM"],
    ]);

    const result = parseGitShowBranch(output, dateMap);

    // Verify headers
    expect(result.headers).toHaveLength(3);
    expect(result.headers[0]).toEqual({ branch: "HEAD", columnIndex: 0 });
    expect(result.headers[1]).toEqual({ branch: "origin/ci-codex", columnIndex: 1 });
    expect(result.headers[2]).toEqual({ branch: "origin/main", columnIndex: 2 });

    // Verify commits
    expect(result.commits).toHaveLength(7);

    // First commit: "  +" - only on origin/main (column 2)
    expect(result.commits[0].indicators).toBe("  +");
    expect(result.commits[0].indicators.length).toBe(3);
    expect(result.commits[0].indicators[0]).toBe(" "); // Not on HEAD
    expect(result.commits[0].indicators[1]).toBe(" "); // Not on origin/ci-codex
    expect(result.commits[0].indicators[2]).toBe("+"); // On origin/main
    expect(result.commits[0].hash).toBe("9050a56");

    // Fourth commit: "++  " - on HEAD and origin/ci-codex (columns 0 and 1)
    expect(result.commits[3].indicators).toBe("++ ");
    expect(result.commits[3].indicators.length).toBe(3);
    expect(result.commits[3].indicators[0]).toBe("+"); // On HEAD
    expect(result.commits[3].indicators[1]).toBe("+"); // On origin/ci-codex
    expect(result.commits[3].indicators[2]).toBe(" "); // Not on origin/main
    expect(result.commits[3].hash).toBe("027552c");

    // Last commit: "+++" - on all three branches
    expect(result.commits[6].indicators).toBe("+++");
    expect(result.commits[6].indicators.length).toBe(3);
    expect(result.commits[6].indicators[0]).toBe("+"); // On HEAD
    expect(result.commits[6].indicators[1]).toBe("+"); // On origin/ci-codex
    expect(result.commits[6].indicators[2]).toBe("+"); // On origin/main
    expect(result.commits[6].hash).toBe("9543f22");
  });

  test("should handle two-branch divergence", () => {
    const output = `! [HEAD] Latest on HEAD
 ! [origin/main] Latest on main
--
 + [abc1234] Only on main
+  [def5678] Only on HEAD
++ [012abcd] On both`;

    const dateMap = new Map<string, string>();

    const result = parseGitShowBranch(output, dateMap);

    expect(result.headers).toHaveLength(2);
    expect(result.commits).toHaveLength(3);

    // Indicators should be exactly 2 characters
    expect(result.commits[0].indicators).toBe(" +");
    expect(result.commits[1].indicators).toBe("+ ");
    expect(result.commits[2].indicators).toBe("++");
  });

  test("should handle empty output", () => {
    const result = parseGitShowBranch("", new Map<string, string>());
    expect(result.headers).toHaveLength(0);
    expect(result.commits).toHaveLength(0);
  });
});
