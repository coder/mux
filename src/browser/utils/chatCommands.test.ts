import { describe, expect, test, beforeEach } from "bun:test";
import type { SendMessageOptions } from "@/common/orpc/types";
import { parseRuntimeString, prepareCompactionMessage } from "./chatCommands";

// Simple mock for localStorage to satisfy resolveCompactionModel
beforeEach(() => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage;
});

describe("parseRuntimeString", () => {
  const workspaceName = "test-workspace";

  test("returns undefined for undefined runtime (default to worktree)", () => {
    expect(parseRuntimeString(undefined, workspaceName)).toBeUndefined();
  });

  test("returns undefined for explicit 'worktree' runtime", () => {
    expect(parseRuntimeString("worktree", workspaceName)).toBeUndefined();
    expect(parseRuntimeString("WORKTREE", workspaceName)).toBeUndefined();
    expect(parseRuntimeString(" worktree ", workspaceName)).toBeUndefined();
  });

  test("returns local config for explicit 'local' runtime", () => {
    // "local" now returns project-dir runtime config (no srcBaseDir)
    expect(parseRuntimeString("local", workspaceName)).toEqual({ type: "local" });
    expect(parseRuntimeString("LOCAL", workspaceName)).toEqual({ type: "local" });
    expect(parseRuntimeString(" local ", workspaceName)).toEqual({ type: "local" });
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
      "Unknown runtime type: 'docker'. Use 'ssh <host>', 'worktree', or 'local'"
    );
    expect(() => parseRuntimeString("remote", workspaceName)).toThrow(
      "Unknown runtime type: 'remote'. Use 'ssh <host>', 'worktree', or 'local'"
    );
  });
});

describe("prepareCompactionMessage", () => {
  const createBaseOptions = (): SendMessageOptions => ({
    model: "anthropic:claude-3-5-sonnet",
    thinkingLevel: "medium",
    toolPolicy: [],
    mode: "exec",
  });

  test("embeds continue message model from base send options", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      continueMessage: { text: "Keep building" },
      model: "anthropic:claude-3-5-haiku",
      sendMessageOptions,
    });

    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage?.model).toBe(sendMessageOptions.model);
  });

  test("generates correct prompt text with strict summary instructions", () => {
    const sendMessageOptions = createBaseOptions();
    const { messageText } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      sendMessageOptions,
    });

    expect(messageText).toContain("Focus entirely on the summary");
    expect(messageText).toContain("Do not suggest next steps or future actions");
  });

  test("does not create continueMessage when no text or images provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      sendMessageOptions,
    });

    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeUndefined();
  });

  test("creates continueMessage when text is provided", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: { text: "Continue with this" },
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.text).toBe("Continue with this");
  });

  test("creates continueMessage when images are provided without text", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      continueMessage: {
        text: "",
        imageParts: [{ url: "data:image/png;base64,abc", mediaType: "image/png" }],
      },
      sendMessageOptions,
    });

    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.continueMessage).toBeDefined();
    expect(metadata.parsed.continueMessage?.imageParts).toHaveLength(1);
  });
});
