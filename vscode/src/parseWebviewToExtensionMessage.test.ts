import { describe, expect, test } from "bun:test";

import { parseWebviewToExtensionMessage } from "./parseWebviewToExtensionMessage";

describe("parseWebviewToExtensionMessage", () => {
  test("rejects non-object payloads", () => {
    expect(parseWebviewToExtensionMessage(null)).toBeNull();
    expect(parseWebviewToExtensionMessage(undefined)).toBeNull();
    expect(parseWebviewToExtensionMessage("nope")).toBeNull();
    expect(parseWebviewToExtensionMessage(123)).toBeNull();
    expect(parseWebviewToExtensionMessage([])).toBeNull();
  });

  test("rejects objects without a string 'type'", () => {
    expect(parseWebviewToExtensionMessage({})).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: 123 })).toBeNull();
  });

  test("parses no-argument message types", () => {
    expect(parseWebviewToExtensionMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebviewToExtensionMessage({ type: "refreshWorkspaces" })).toEqual({ type: "refreshWorkspaces" });
    expect(parseWebviewToExtensionMessage({ type: "configureConnection" })).toEqual({ type: "configureConnection" });
  });

  test("parses selectWorkspace", () => {
    expect(parseWebviewToExtensionMessage({ type: "selectWorkspace", workspaceId: "ws-1" })).toEqual({
      type: "selectWorkspace",
      workspaceId: "ws-1",
    });

    expect(parseWebviewToExtensionMessage({ type: "selectWorkspace", workspaceId: null })).toEqual({
      type: "selectWorkspace",
      workspaceId: null,
    });

    expect(parseWebviewToExtensionMessage({ type: "selectWorkspace" })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "selectWorkspace", workspaceId: 123 })).toBeNull();
  });

  test("parses openWorkspace", () => {
    expect(parseWebviewToExtensionMessage({ type: "openWorkspace", workspaceId: "ws-1" })).toEqual({
      type: "openWorkspace",
      workspaceId: "ws-1",
    });

    expect(parseWebviewToExtensionMessage({ type: "openWorkspace" })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "openWorkspace", workspaceId: null })).toBeNull();
  });

  test("parses debugLog", () => {
    expect(parseWebviewToExtensionMessage({ type: "debugLog", message: "hello" })).toEqual({
      type: "debugLog",
      message: "hello",
      data: undefined,
    });

    expect(parseWebviewToExtensionMessage({ type: "debugLog", message: "hello", data: { ok: true } })).toEqual({
      type: "debugLog",
      message: "hello",
      data: { ok: true },
    });

    expect(parseWebviewToExtensionMessage({ type: "debugLog" })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "debugLog", message: 123 })).toBeNull();
  });

  test("parses copyDebugLog", () => {
    expect(parseWebviewToExtensionMessage({ type: "copyDebugLog", text: "hi" })).toEqual({
      type: "copyDebugLog",
      text: "hi",
    });

    expect(parseWebviewToExtensionMessage({ type: "copyDebugLog" })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "copyDebugLog", text: 123 })).toBeNull();
  });

  test("parses orpcCall", () => {
    expect(
      parseWebviewToExtensionMessage({
        type: "orpcCall",
        requestId: "req-1",
        path: ["workspace", "sendMessage"],
        input: { text: "hello" },
      })
    ).toEqual({
      type: "orpcCall",
      requestId: "req-1",
      path: ["workspace", "sendMessage"],
      input: { text: "hello" },
      lastEventId: undefined,
    });

    expect(
      parseWebviewToExtensionMessage({
        type: "orpcCall",
        requestId: "req-1",
        path: ["workspace", "sendMessage"],
        input: null,
        lastEventId: "evt-1",
      })
    ).toEqual({
      type: "orpcCall",
      requestId: "req-1",
      path: ["workspace", "sendMessage"],
      input: null,
      lastEventId: "evt-1",
    });

    expect(parseWebviewToExtensionMessage({ type: "orpcCall" })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "orpcCall", requestId: 123 })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "orpcCall", requestId: "req-1", path: "nope", input: {} })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "orpcCall", requestId: "req-1", path: ["ok", 123], input: {} })).toBeNull();
  });

  test("parses orpcCancel", () => {
    expect(parseWebviewToExtensionMessage({ type: "orpcCancel", requestId: "req-1" })).toEqual({
      type: "orpcCancel",
      requestId: "req-1",
    });

    expect(parseWebviewToExtensionMessage({ type: "orpcCancel" })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "orpcCancel", requestId: 123 })).toBeNull();
  });

  test("parses orpcStreamCancel", () => {
    expect(parseWebviewToExtensionMessage({ type: "orpcStreamCancel", streamId: "stream-1" })).toEqual({
      type: "orpcStreamCancel",
      streamId: "stream-1",
    });

    expect(parseWebviewToExtensionMessage({ type: "orpcStreamCancel" })).toBeNull();
    expect(parseWebviewToExtensionMessage({ type: "orpcStreamCancel", streamId: 123 })).toBeNull();
  });

  test("rejects unknown message types", () => {
    expect(parseWebviewToExtensionMessage({ type: "unknown" })).toBeNull();
  });
});
