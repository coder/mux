import { parseRuntimeString } from "./chatCommands";

describe("parseRuntimeString", () => {
  const workspaceName = "test-workspace";

  test("returns undefined for undefined runtime (default to worktree)", () => {
    expect(parseRuntimeString(undefined, workspaceName)).toBeUndefined();
  });

  test("returns undefined for explicit 'worktree' runtime", () => {
    expect(parseRuntimeString("worktree", workspaceName)).toBeUndefined();
    expect(parseRuntimeString(" WORKTREE ", workspaceName)).toBeUndefined();
  });

  test("parses local runtime token", () => {
    expect(parseRuntimeString("local", workspaceName)).toEqual({ type: "local" });
    expect(parseRuntimeString("LOCAL", workspaceName)).toEqual({ type: "local" });
    expect(parseRuntimeString(" local-in-place ", workspaceName)).toEqual({ type: "local" });
  });

  test("parses valid SSH runtime", () => {
    const result = parseRuntimeString("ssh user@host", workspaceName);
    expect(result).toEqual({
      type: "ssh",
      host: "user@host",
      srcBaseDir: "~/mux",
    });
  });

  test("preserves case in SSH host", () => {
    const result = parseRuntimeString("ssh User@Host.Example.Com", workspaceName);
    expect(result).toEqual({
      type: "ssh",
      host: "User@Host.Example.Com",
      srcBaseDir: "~/mux",
    });
  });

  test("handles extra whitespace", () => {
    const result = parseRuntimeString("  ssh   user@host  ", workspaceName);
    expect(result).toEqual({
      type: "ssh",
      host: "user@host",
      srcBaseDir: "~/mux",
    });
  });

  test("throws error for SSH without host", () => {
    expect(() => parseRuntimeString("ssh", workspaceName)).toThrow("SSH runtime requires host");
    expect(() => parseRuntimeString("ssh ", workspaceName)).toThrow("SSH runtime requires host");
  });

  test("accepts SSH with hostname only (user will be inferred)", () => {
    const result = parseRuntimeString("ssh hostname", workspaceName);
    // Uses tilde path - backend will resolve it via runtime.resolvePath()
    expect(result).toEqual({
      type: "ssh",
      host: "hostname",
      srcBaseDir: "~/mux",
    });
  });

  test("accepts SSH with hostname.domain only", () => {
    const result = parseRuntimeString("ssh dev.example.com", workspaceName);
    // Uses tilde path - backend will resolve it via runtime.resolvePath()
    expect(result).toEqual({
      type: "ssh",
      host: "dev.example.com",
      srcBaseDir: "~/mux",
    });
  });

  test("uses tilde path for root user too", () => {
    const result = parseRuntimeString("ssh root@hostname", workspaceName);
    // Backend will resolve ~ to /root for root user
    expect(result).toEqual({
      type: "ssh",
      host: "root@hostname",
      srcBaseDir: "~/mux",
    });
  });

  test("throws error for unknown runtime type", () => {
    expect(() => parseRuntimeString("docker", workspaceName)).toThrow(
      "Unknown runtime type: 'docker'. Use 'worktree', 'local', or 'ssh <host>'"
    );
    expect(() => parseRuntimeString("remote", workspaceName)).toThrow(
      "Unknown runtime type: 'remote'. Use 'worktree', 'local', or 'ssh <host>'"
    );
  });
});
