import { describe, expect, test } from "bun:test";
import { parseGitHubRemote } from "./githubRemote";

describe("parseGitHubRemote", () => {
  const validCases: Array<[string, { owner: string; repo: string }]> = [
    ["https://github.com/coder/mux", { owner: "coder", repo: "mux" }],
    ["https://github.com/coder/mux.git", { owner: "coder", repo: "mux" }],
    ["https://github.com/coder/mux.git/", { owner: "coder", repo: "mux" }],
    ["https://token@github.com/coder/mux.git", { owner: "coder", repo: "mux" }],
    ["https://user:token@github.com/coder/mux", { owner: "coder", repo: "mux" }],
    ["ssh://git@github.com/coder/mux.git", { owner: "coder", repo: "mux" }],
    ["ssh://git@github.com/coder/mux.git/", { owner: "coder", repo: "mux" }],
    ["git@github.com:coder/mux.git", { owner: "coder", repo: "mux" }],
    ["github.com:coder/mux", { owner: "coder", repo: "mux" }],
    ["  git@github.com:coder/mux.git  ", { owner: "coder", repo: "mux" }],
  ];

  for (const [remote, expected] of validCases) {
    test(`parses ${remote.trim()}`, () => {
      expect(parseGitHubRemote(remote)).toEqual(expected);
    });
  }

  const invalidCases = [
    "",
    "https://gitlab.com/coder/mux.git",
    "git@gitlab.com:coder/mux.git",
    "http://github.com/coder/mux.git",
    "https://github.com/coder",
    "https://github.com/coder/mux/issues",
    "https://github.com//mux.git",
    "not a remote",
  ];

  for (const remote of invalidCases) {
    test(`rejects ${remote || "an empty remote"}`, () => {
      expect(parseGitHubRemote(remote)).toBeNull();
    });
  }
});
