import { describe, expect, it } from "bun:test";
import { getMuxBashrcSourceSnippet } from "./paths";

describe("getMuxBashrcSourceSnippet", () => {
  it("should return a bash snippet that sources ~/.mux/bashrc if it exists", () => {
    const snippet = getMuxBashrcSourceSnippet();

    // Should check for file existence with -f
    expect(snippet).toContain("[ -f");
    // Should reference $HOME/.mux/bashrc
    expect(snippet).toContain('$HOME/.mux/bashrc"');
    // Should source the file with . (dot command)
    expect(snippet).toContain(". ");
  });

  it("should use $HOME for portability across local and SSH runtimes", () => {
    const snippet = getMuxBashrcSourceSnippet();

    // Should not use ~ (tilde) which doesn't expand in all contexts
    expect(snippet).not.toContain("~/");
    // Should use $HOME which expands reliably
    expect(snippet).toContain("$HOME/");
  });

  it("should silently skip if file doesn't exist and return success", () => {
    const snippet = getMuxBashrcSourceSnippet();

    // Should use the pattern: [ -f file ] && . file || true
    // - If file doesn't exist, [ -f file ] returns 1, && short-circuits, || true returns 0
    // - If file exists, [ -f file ] returns 0, && sources file, || is skipped
    // The || true is critical for SSH runtime where commands are joined with &&
    expect(snippet).toContain("] && .");
    expect(snippet).toContain("|| true");
  });
});
