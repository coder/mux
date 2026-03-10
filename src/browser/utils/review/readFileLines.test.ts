import { describe, expect, mock, test } from "bun:test";
import type { APIClient } from "@/browser/contexts/API";
import { readFileLines } from "./readFileLines";

describe("readFileLines", () => {
  test("keeps plain file reads on the shared container cwd", async () => {
    const executeBash = mock(() =>
      Promise.resolve({
        success: true,
        data: {
          success: true,
          output: "first\nsecond\n",
          exitCode: 0,
        },
      })
    );
    const api = {
      workspace: {
        executeBash,
      },
    } as unknown as APIClient;

    const lines = await readFileLines(api, "workspace-1", "project-b/src/example.ts", 1, 2, "");

    expect(lines).toEqual(["first", "second"]);
    expect(executeBash).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      script: `sed -n '1,2p' "project-b/src/example.ts"`,
      options: { timeout_secs: 3 },
    });
  });

  test("preserves repo-root opt-in for git-ref reads", async () => {
    const executeBash = mock(() =>
      Promise.resolve({
        success: true,
        data: {
          success: true,
          output: "first\nsecond\n",
          exitCode: 0,
        },
      })
    );
    const api = {
      workspace: {
        executeBash,
      },
    } as unknown as APIClient;

    const lines = await readFileLines(
      api,
      "workspace-1",
      "project-a/src/example.ts",
      1,
      2,
      "HEAD",
      "/tmp/project-a"
    );

    expect(lines).toEqual(["first", "second"]);
    expect(executeBash).toHaveBeenNthCalledWith(1, {
      workspaceId: "workspace-1",
      script: "git show \"HEAD:project-a/src/example.ts\" 2>/dev/null | sed -n '1,2p'",
      options: {
        timeout_secs: 3,
        cwdMode: "repo-root",
        repoRootProjectPath: "/tmp/project-a",
      },
    });
  });
});
