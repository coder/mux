import { describe, expect, test } from "bun:test";
import { Config } from "@/node/config";
import { isProjectTrusted } from "./projectTrust";

const CANONICAL_PROJECT_PATH = "/Users/tester/src/mux";
const WORKTREE_PARENT_PATH = "/Users/tester/.mux/src/mux";
const KNOWN_WORKTREE_PATH = `${WORKTREE_PARENT_PATH}/lsp-rb97`;

async function createConfig(
  projects: Array<[string, { workspaces: Array<{ path: string }>; trusted?: boolean }]>
) {
  const config = new Config(`/tmp/mux-project-trust-${Date.now()}-${Math.random()}`);
  await config.saveConfig({
    ...config.loadConfigOrDefault(),
    projects: new Map(projects),
  });
  return config;
}

describe("isProjectTrusted", () => {
  test("matches canonical project entries directly", async () => {
    const config = await createConfig([
      [CANONICAL_PROJECT_PATH, { workspaces: [], trusted: true }],
    ]);

    expect(isProjectTrusted(config, CANONICAL_PROJECT_PATH)).toBe(true);
  });

  test("resolves known worktree paths back to the trusted canonical project", async () => {
    const config = await createConfig([
      [
        CANONICAL_PROJECT_PATH,
        {
          trusted: true,
          workspaces: [{ path: KNOWN_WORKTREE_PATH }],
        },
      ],
    ]);

    expect(isProjectTrusted(config, WORKTREE_PARENT_PATH, KNOWN_WORKTREE_PATH)).toBe(true);
  });
});
