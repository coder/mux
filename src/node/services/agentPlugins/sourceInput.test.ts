import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";

import { isFullCommitSha, parseAgentPluginSourceInput } from "./sourceInput";

describe("parseAgentPluginSourceInput", () => {
  // Shorthand expansion depends on SSH-agent presence; pin it for determinism.
  let savedSshAuthSock: string | undefined;
  beforeEach(() => {
    savedSshAuthSock = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
  });
  afterEach(() => {
    if (savedSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = savedSshAuthSock;
    }
  });

  test("expands owner/repo shorthand to an https clone URL", () => {
    expect(parseAgentPluginSourceInput("coder/mux")).toEqual({
      url: "https://github.com/coder/mux.git",
    });
  });

  test("expands owner/repo shorthand to ssh when an SSH agent is present", () => {
    process.env.SSH_AUTH_SOCK = "/tmp/fake-agent.sock";
    expect(parseAgentPluginSourceInput("coder/mux").url).toBe("git@github.com:coder/mux.git");
  });

  test("parses @ref from shorthand (branch, tag, or sha all land in ref)", () => {
    expect(parseAgentPluginSourceInput("coder/mux@main")).toEqual({
      url: "https://github.com/coder/mux.git",
      ref: "main",
    });
    expect(parseAgentPluginSourceInput("coder/mux@v1.2.3").ref).toBe("v1.2.3");
    const sha = "a".repeat(40);
    expect(parseAgentPluginSourceInput(`coder/mux@${sha}`).ref).toBe(sha);
  });

  test("parses monorepo subpath segments from shorthand", () => {
    expect(parseAgentPluginSourceInput("coder/mux/plugins/demo@main")).toEqual({
      url: "https://github.com/coder/mux.git",
      ref: "main",
      subpath: "plugins/demo",
    });
  });

  test("passes through full URLs unchanged (with query/fragment stripped)", () => {
    expect(parseAgentPluginSourceInput("https://github.com/coder/mux.git")).toEqual({
      url: "https://github.com/coder/mux.git",
    });
    expect(parseAgentPluginSourceInput("https://github.com/coder/mux.git?tab=readme").url).toBe(
      "https://github.com/coder/mux.git"
    );
    expect(parseAgentPluginSourceInput("git@github.com:coder/mux.git")).toEqual({
      url: "git@github.com:coder/mux.git",
    });
    expect(parseAgentPluginSourceInput("ssh://git@git.corp:2222/x/y.git").url).toBe(
      "ssh://git@git.corp:2222/x/y.git"
    );
  });

  test("does not treat @ inside URLs as a ref separator", () => {
    // git@host URLs keep their @ — refs for URL inputs come from the ref field.
    const parsed = parseAgentPluginSourceInput("git@github.com:coder/mux.git");
    expect(parsed.ref).toBeUndefined();
  });

  test("passes through absolute local paths (git handles local remotes)", () => {
    expect(parseAgentPluginSourceInput("/tmp/some-repo").url).toBe("/tmp/some-repo");
  });

  test("expands home-relative paths (git is spawned without a shell)", () => {
    expect(parseAgentPluginSourceInput("~/plugins/demo").url).toBe(
      path.join(os.homedir(), "plugins/demo")
    );
  });

  test("rejects unusable inputs with actionable messages", () => {
    expect(() => parseAgentPluginSourceInput("")).toThrow(/git URL or owner\/repo/);
    expect(() => parseAgentPluginSourceInput("just-a-name")).toThrow(/not a git URL/);
    expect(() => parseAgentPluginSourceInput("./relative/path")).toThrow(/relative path/);
    expect(() => parseAgentPluginSourceInput("coder/mux@")).toThrow(/must not be empty/);
    expect(() => parseAgentPluginSourceInput("-bad/owner")).toThrow(/not a valid owner\/repo/);
  });
});

describe("isFullCommitSha", () => {
  test("accepts only full 40-hex SHAs", () => {
    expect(isFullCommitSha("a".repeat(40))).toBe(true);
    expect(isFullCommitSha("A1B2C3D4E5".repeat(4))).toBe(true);
    expect(isFullCommitSha("a".repeat(39))).toBe(false);
    expect(isFullCommitSha("a".repeat(41))).toBe(false);
    expect(isFullCommitSha("main")).toBe(false);
  });
});
