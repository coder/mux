import { describe, expect, test, beforeEach } from "bun:test";
import type { SendMessageOptions } from "@/common/types/ipc";
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

  test("returns undefined for undefined runtime (default to local)", () => {
    expect(parseRuntimeString(undefined, workspaceName)).toBeUndefined();
  });

  test("returns undefined for explicit 'local' runtime", () => {
    expect(parseRuntimeString("local", workspaceName)).toBeUndefined();
    expect(parseRuntimeString("LOCAL", workspaceName)).toBeUndefined();
    expect(parseRuntimeString(" local ", workspaceName)).toBeUndefined();
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
      "Unknown runtime type: 'docker'"
    );
    expect(() => parseRuntimeString("remote", workspaceName)).toThrow(
      "Unknown runtime type: 'remote'"
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

  test("embeds resumeModel from base send options", () => {
    const sendMessageOptions = createBaseOptions();
    const { metadata } = prepareCompactionMessage({
      workspaceId: "ws-1",
      maxOutputTokens: 4096,
      continueMessage: "Keep building",
      model: "anthropic:claude-3-5-haiku",
      sendMessageOptions,
    });

    expect(metadata.type).toBe("compaction-request");
    if (metadata.type !== "compaction-request") {
      throw new Error("Expected compaction metadata");
    }

    expect(metadata.parsed.resumeModel).toBe(sendMessageOptions.model);
  });
});
