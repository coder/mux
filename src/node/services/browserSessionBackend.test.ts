import { describe, expect, mock, test } from "bun:test";

import WebSocket from "ws";
import type {
  BrowserFrameMetadata,
  BrowserInputEvent,
  BrowserSession,
} from "@/common/types/browserSession";
import {
  BrowserSessionBackend,
  type BrowserSessionBackendOptions,
} from "@/node/services/browserSessionBackend";

const noop = (): void => undefined;

function createBackend(overrides?: Partial<BrowserSessionBackendOptions>): BrowserSessionBackend {
  return new BrowserSessionBackend({
    workspaceId: "workspace-123",
    initialUrl: "https://example.com",
    onSessionUpdate: noop,
    onAction: noop,
    onEnded: noop,
    onError: noop,
    ...overrides,
  });
}

function setSession(backend: BrowserSessionBackend, updates: Partial<BrowserSession>): void {
  const session = Reflect.get(backend, "session") as BrowserSession;
  Reflect.set(backend, "session", {
    ...session,
    ...updates,
    updatedAt: new Date().toISOString(),
  });
}

function getSession(backend: BrowserSessionBackend): BrowserSession {
  return Reflect.get(backend, "session") as BrowserSession;
}

function handleStreamMessage(backend: BrowserSessionBackend, payload: unknown): void {
  const handler = Reflect.get(backend, "handleStreamSocketMessage") as (
    this: BrowserSessionBackend,
    data: Buffer
  ) => void;
  handler.call(backend, Buffer.from(JSON.stringify(payload), "utf8"));
}

function setStreamSocket(
  backend: BrowserSessionBackend,
  socket: { readyState: number; send: (data: string) => void }
): void {
  Reflect.set(backend, "streamSocket", socket as unknown as WebSocket);
}

const viewportMetadata: BrowserFrameMetadata = {
  deviceWidth: 1280,
  deviceHeight: 720,
  pageScaleFactor: 1,
  offsetTop: 0,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
};

const mouseClickInput: BrowserInputEvent = {
  kind: "mouse",
  eventType: "mousePressed",
  x: 100,
  y: 200,
  button: "left",
  clickCount: 1,
};

describe("BrowserSessionBackend", () => {
  test("reuses the deterministic mux session id", () => {
    const backend = createBackend();

    expect(backend.getSession().id).toMatch(/^mux-workspace-123-[a-f0-9]{8}$/);
  });

  test("attaches to an existing daemon session without reopening the initial URL", async () => {
    const backend = createBackend({
      initialUrl: "https://start.example.com",
      streamPort: 9223,
    });
    const runCliCommand = mock(() => Promise.resolve({ ok: true as const, data: {} }));
    const refreshNavigationMetadata = mock(() => {
      setSession(backend, {
        currentUrl: "https://attached.example.com",
        title: "Attached page",
      });
      return Promise.resolve();
    });

    expect(Reflect.set(backend, "hasExistingSession", () => true)).toBe(true);
    expect(Reflect.set(backend, "runCliCommand", runCliCommand)).toBe(true);
    expect(Reflect.set(backend, "refreshNavigationMetadata", refreshNavigationMetadata)).toBe(true);
    expect(
      Reflect.set(backend, "startStreamTransport", () => Promise.resolve("stream" as const))
    ).toBe(true);
    expect(Reflect.set(backend, "startMetadataRefreshLoop", noop)).toBe(true);

    const session = await backend.start();

    expect(runCliCommand).not.toHaveBeenCalled();
    expect(refreshNavigationMetadata).toHaveBeenCalledTimes(1);
    expect(session.id).toMatch(/^mux-workspace-123-[a-f0-9]{8}$/);
    expect(session.status).toBe("live");
    expect(session.currentUrl).toBe("https://attached.example.com");
  });

  test("opens the initial URL when no daemon session exists yet", async () => {
    const backend = createBackend({
      initialUrl: "https://start.example.com",
      streamPort: 9223,
    });
    const runCliCommand = mock((args: string[]) => {
      expect(args).toEqual(["open", "https://start.example.com"]);
      return Promise.resolve({ ok: true as const, data: {} });
    });
    const refreshNavigationMetadata = mock(() => {
      setSession(backend, {
        currentUrl: "https://start.example.com",
        title: "Start page",
      });
      return Promise.resolve();
    });

    expect(Reflect.set(backend, "hasExistingSession", () => false)).toBe(true);
    expect(Reflect.set(backend, "runCliCommand", runCliCommand)).toBe(true);
    expect(Reflect.set(backend, "refreshNavigationMetadata", refreshNavigationMetadata)).toBe(true);
    expect(
      Reflect.set(backend, "startStreamTransport", () => Promise.resolve("stream" as const))
    ).toBe(true);
    expect(Reflect.set(backend, "startMetadataRefreshLoop", noop)).toBe(true);

    const session = await backend.start();

    expect(runCliCommand).toHaveBeenCalledTimes(1);
    expect(refreshNavigationMetadata).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("live");
    expect(session.currentUrl).toBe("https://start.example.com");
  });

  test("does not reopen the browser if disposed while awaiting existing-session detection", async () => {
    const backend = createBackend({
      initialUrl: "https://start.example.com",
      streamPort: 9223,
    });
    let resolveExistingSession!: (value: boolean) => void;
    const hasExistingSession = mock(
      () =>
        new Promise<boolean>((resolve) => {
          resolveExistingSession = resolve;
        })
    );
    const runCliCommand = mock(() => Promise.resolve({ ok: true as const, data: {} }));

    expect(Reflect.set(backend, "hasExistingSession", hasExistingSession)).toBe(true);
    expect(Reflect.set(backend, "runCliCommand", runCliCommand)).toBe(true);

    const startPromise = backend.start();
    backend.dispose();
    resolveExistingSession(false);

    const session = await startPromise;

    expect(hasExistingSession).toHaveBeenCalledTimes(1);
    expect(runCliCommand).not.toHaveBeenCalled();
    expect(session.status).toBe("starting");
  });

  test("updates frame metadata and screenshot state from valid stream payloads", () => {
    const backend = createBackend({ streamPort: 9223 });
    const expectedMetadata: BrowserFrameMetadata = {
      deviceWidth: 1280,
      deviceHeight: 720,
      pageScaleFactor: 1,
      offsetTop: 0,
      scrollOffsetX: 5,
      scrollOffsetY: 10,
    };

    setSession(backend, {
      status: "live",
      streamState: "connecting",
      lastScreenshotBase64: null,
      lastFrameMetadata: null,
    });

    handleStreamMessage(backend, { type: "status", status: "connected" });
    expect(getSession(backend).streamState).toBe("connecting");

    handleStreamMessage(backend, {
      type: "frame",
      data: "ZmFrZS1qcGVn",
      metadata: expectedMetadata,
    });

    const session = getSession(backend);
    expect(session.streamState).toBe("live");
    expect(session.streamErrorMessage).toBeNull();
    expect(session.lastScreenshotBase64).toBe("ZmFrZS1qcGVn");
    expect(session.lastFrameMetadata).toEqual(expectedMetadata);
  });

  test("ignores malformed and invalid stream payloads without crashing", () => {
    const backend = createBackend({ streamPort: 9223 });
    setSession(backend, {
      status: "live",
      streamState: "connecting",
      lastScreenshotBase64: "existing-frame",
    });

    const malformedHandler = Reflect.get(backend, "handleStreamSocketMessage") as (
      this: BrowserSessionBackend,
      data: Buffer
    ) => void;
    expect(() => malformedHandler.call(backend, Buffer.from("not-json", "utf8"))).not.toThrow();

    handleStreamMessage(backend, {
      type: "frame",
      data: "next-frame",
      metadata: {
        deviceWidth: 0,
        deviceHeight: 720,
        pageScaleFactor: 1,
        offsetTop: 0,
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    });

    handleStreamMessage(backend, { type: "status", status: "mystery" });

    const session = getSession(backend);
    expect(session.streamState).toBe("connecting");
    expect(session.lastScreenshotBase64).toBe("existing-frame");
    expect(session.lastFrameMetadata).toBeNull();
  });

  test("marks attached sessions restart_required when stream transport never comes up", async () => {
    const backend = createBackend({
      initialUrl: "https://attached.example.com",
      streamPort: 9223,
    });
    const connectStreamTransport = mock(() =>
      Promise.resolve({ ok: false as const, error: "connect ECONNREFUSED 127.0.0.1:9223" })
    );

    expect(Reflect.set(backend, "hasExistingSession", () => true)).toBe(true);
    expect(
      Reflect.set(backend, "refreshNavigationMetadata", () => {
        setSession(backend, {
          currentUrl: "https://attached.example.com",
          title: "Attached",
        });
        return Promise.resolve();
      })
    ).toBe(true);
    expect(Reflect.set(backend, "connectStreamTransport", connectStreamTransport)).toBe(true);
    expect(Reflect.set(backend, "sleep", () => Promise.resolve())).toBe(true);
    expect(Reflect.set(backend, "startMetadataRefreshLoop", noop)).toBe(true);

    const session = await backend.start();

    expect(connectStreamTransport).toHaveBeenCalledTimes(3);
    expect(session.status).toBe("live");
    expect(session.streamState).toBe("restart_required");
    expect(session.streamErrorMessage).toContain("ECONNREFUSED");
  });

  test("treats disappearing daemon sessions as errors instead of neutral closure", async () => {
    const onSessionUpdate = mock(() => undefined);
    const onError = mock(() => undefined);
    const onEnded = mock(() => undefined);
    const backend = createBackend({ onSessionUpdate, onError, onEnded });

    setSession(backend, {
      status: "live",
      currentUrl: "https://example.com",
      title: "Example",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
      lastError: "socket closed",
      streamErrorMessage: "socket closed",
    });

    expect(
      Reflect.set(backend, "runCliCommand", (args: string[]) => {
        if (args[0] === "get" && args[1] === "url") {
          return Promise.resolve({ ok: true as const, data: { url: "about:blank" } });
        }
        if (args[0] === "get" && args[1] === "title") {
          return Promise.resolve({ ok: true as const, data: { title: "about:blank" } });
        }
        throw new Error(`Unexpected CLI args: ${args.join(" ")}`);
      })
    ).toBe(true);
    expect(
      Reflect.set(backend, "inspectExistingSession", () =>
        Promise.resolve({ ok: true as const, exists: false })
      )
    ).toBe(true);

    const refreshNavigationMetadata = Reflect.get(backend, "refreshNavigationMetadata") as (
      this: BrowserSessionBackend
    ) => Promise<void>;
    await refreshNavigationMetadata.call(backend);

    const session = getSession(backend);
    expect(session.status).toBe("error");
    expect(session.endReason).toBeNull();
    expect(session.lastError).toBe("Browser session disappeared unexpectedly.");
    expect(session.streamState).toBe("error");
    expect(session.streamErrorMessage).toBe("Browser session disappeared unexpectedly.");
    expect(onEnded).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(
      "workspace-123",
      "Browser session disappeared unexpectedly."
    );
    expect(onSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "error", endReason: null })
    );
  });

  test("treats browser-window closure outside Mux as an ended session", async () => {
    const onSessionUpdate = mock(() => undefined);
    const onEnded = mock(() => undefined);
    const backend = createBackend({ onSessionUpdate, onEnded });

    setSession(backend, {
      status: "live",
      currentUrl: "https://example.com",
      title: "Example",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });

    expect(
      Reflect.set(backend, "runCliCommand", (args: string[]) => {
        if (args[0] === "get" && args[1] === "url") {
          return Promise.resolve({ ok: true as const, data: { url: "about:blank" } });
        }
        if (args[0] === "get" && args[1] === "title") {
          return Promise.resolve({ ok: true as const, data: { title: "about:blank" } });
        }
        throw new Error(`Unexpected CLI args: ${args.join(" ")}`);
      })
    ).toBe(true);
    expect(
      Reflect.set(backend, "inspectExistingSession", () =>
        Promise.resolve({ ok: true as const, exists: true })
      )
    ).toBe(true);

    const refreshNavigationMetadata = Reflect.get(backend, "refreshNavigationMetadata") as (
      this: BrowserSessionBackend
    ) => Promise<void>;
    await refreshNavigationMetadata.call(backend);

    const session = getSession(backend);
    expect(session.status).toBe("ended");
    expect(session.endReason).toBe("external_closed");
    expect(session.lastError).toBeNull();
    expect(session.streamState).toBeNull();
    expect(onSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ended", endReason: "external_closed" })
    );
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith("workspace-123");
  });

  test("keeps launch failures classified as errors", async () => {
    const onError = mock(() => undefined);
    const backend = createBackend({ onError, initialUrl: "https://start.example.com" });

    expect(Reflect.set(backend, "hasExistingSession", () => false)).toBe(true);
    expect(
      Reflect.set(backend, "runCliCommand", () =>
        Promise.resolve({ ok: false as const, error: "launch failed" })
      )
    ).toBe(true);

    const session = await backend.start();

    expect(session.status).toBe("error");
    expect(session.lastError).toBe("launch failed");
    expect(session.endReason).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith("workspace-123", "launch failed");
  });

  test("does not classify unexpected stream close as ended when session probing fails", async () => {
    const backend = createBackend();
    setSession(backend, {
      status: "live",
      currentUrl: "https://example.com",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });

    expect(
      Reflect.set(backend, "inspectExistingSession", () =>
        Promise.resolve({ ok: false as const, error: "session list timed out" })
      )
    ).toBe(true);
    expect(Reflect.set(backend, "streamRetryCount", 3)).toBe(true);

    const handleUnexpectedStreamClose = Reflect.get(backend, "handleUnexpectedStreamClose") as (
      this: BrowserSessionBackend,
      error: string
    ) => Promise<void>;
    await handleUnexpectedStreamClose.call(backend, "socket closed");

    const session = getSession(backend);
    expect(session.status).toBe("live");
    expect(session.endReason).toBeNull();
    expect(session.streamState).toBe("restart_required");
    expect(session.streamErrorMessage).toBe("socket closed");
  });

  test("does not schedule retries after refresh-based close classification transitions to error", async () => {
    const backend = createBackend();
    setSession(backend, {
      status: "live",
      currentUrl: "https://example.com",
      title: "Example",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });

    let inspectCallCount = 0;
    expect(
      Reflect.set(backend, "inspectExistingSession", () => {
        inspectCallCount += 1;
        return Promise.resolve(
          inspectCallCount === 1
            ? ({ ok: true as const, exists: true } as const)
            : ({ ok: true as const, exists: false } as const)
        );
      })
    ).toBe(true);
    expect(
      Reflect.set(backend, "runCliCommand", (args: string[]) => {
        if (args[0] === "get" && args[1] === "url") {
          return Promise.resolve({ ok: true as const, data: { url: "about:blank" } });
        }
        if (args[0] === "get" && args[1] === "title") {
          return Promise.resolve({ ok: true as const, data: { title: "about:blank" } });
        }
        throw new Error(`Unexpected CLI args: ${args.join(" ")}`);
      })
    ).toBe(true);

    const handleUnexpectedStreamClose = Reflect.get(backend, "handleUnexpectedStreamClose") as (
      this: BrowserSessionBackend,
      error: string
    ) => Promise<void>;
    await handleUnexpectedStreamClose.call(backend, "socket closed");

    const session = getSession(backend);
    expect(session.status).toBe("error");
    expect(session.streamState).toBe("error");
    expect(session.streamErrorMessage).toBe("Browser session disappeared unexpectedly.");
    expect(Reflect.get(backend, "streamRetryTimer")).toBeNull();
  });

  test("treats about:blank as a metadata failure when session probing fails", async () => {
    const backend = createBackend();
    setSession(backend, {
      status: "live",
      currentUrl: "https://example.com",
      title: "Example",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });

    expect(
      Reflect.set(backend, "runCliCommand", (args: string[]) => {
        if (args[0] === "get" && args[1] === "url") {
          return Promise.resolve({ ok: true as const, data: { url: "about:blank" } });
        }
        if (args[0] === "get" && args[1] === "title") {
          return Promise.resolve({ ok: true as const, data: { title: "about:blank" } });
        }
        throw new Error(`Unexpected CLI args: ${args.join(" ")}`);
      })
    ).toBe(true);
    expect(
      Reflect.set(backend, "inspectExistingSession", () =>
        Promise.resolve({ ok: false as const, error: "session list timed out" })
      )
    ).toBe(true);

    const refreshNavigationMetadata = Reflect.get(backend, "refreshNavigationMetadata") as (
      this: BrowserSessionBackend
    ) => Promise<void>;
    await refreshNavigationMetadata.call(backend);

    const session = getSession(backend);
    expect(session.status).toBe("live");
    expect(session.endReason).toBeNull();
    expect(session.lastError).toBe("session list timed out");
  });

  describe("navigate", () => {
    test("navigates to a valid URL via CLI open command", async () => {
      const backend = createBackend();
      setSession(backend, { status: "live" });

      const runCliCommand = mock((args: string[]) => {
        expect(args).toEqual(["open", "https://example.com/"]);
        return Promise.resolve({ ok: true as const, data: {} });
      });
      const refreshNavigationMetadata = mock(() => Promise.resolve());

      Reflect.set(backend, "runCliCommand", runCliCommand);
      Reflect.set(backend, "refreshNavigationMetadata", refreshNavigationMetadata);

      const result = await backend.navigate("https://example.com");
      expect(result.success).toBe(true);
      expect(runCliCommand).toHaveBeenCalledTimes(1);
      expect(refreshNavigationMetadata).toHaveBeenCalledTimes(1);
    });

    test("rejects invalid URLs without calling CLI", async () => {
      const backend = createBackend();
      setSession(backend, { status: "live" });

      const runCliCommand = mock(() => Promise.resolve({ ok: true as const, data: {} }));
      Reflect.set(backend, "runCliCommand", runCliCommand);

      const result = await backend.navigate("javascript:alert(1)");
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(runCliCommand).not.toHaveBeenCalled();
    });

    test("fails when session is not live", async () => {
      const backend = createBackend();
      setSession(backend, { status: "ended" });

      const result = await backend.navigate("https://example.com");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Session is not live");
    });

    test("normalizes scheme-less URLs", async () => {
      const backend = createBackend();
      setSession(backend, { status: "live" });

      const runCliCommand = mock(() => Promise.resolve({ ok: true as const, data: {} }));
      const refreshNavigationMetadata = mock(() => Promise.resolve());
      Reflect.set(backend, "runCliCommand", runCliCommand);
      Reflect.set(backend, "refreshNavigationMetadata", refreshNavigationMetadata);

      const result = await backend.navigate("example.com");
      expect(result.success).toBe(true);
      expect(runCliCommand).toHaveBeenCalledWith(["open", "https://example.com/"]);
    });
  });

  test("marks new sessions restart_required when stream transport is unavailable", async () => {
    const backend = createBackend({ initialUrl: "https://restart.example.com" });

    expect(Reflect.set(backend, "hasExistingSession", () => false)).toBe(true);
    expect(
      Reflect.set(backend, "runCliCommand", () => Promise.resolve({ ok: true as const, data: {} }))
    ).toBe(true);
    expect(
      Reflect.set(backend, "refreshNavigationMetadata", () => {
        setSession(backend, {
          currentUrl: "https://restart.example.com",
          title: "Restart required",
        });
        return Promise.resolve();
      })
    ).toBe(true);
    expect(Reflect.set(backend, "startMetadataRefreshLoop", noop)).toBe(true);

    const session = await backend.start();

    expect(session.status).toBe("live");
    expect(session.streamState).toBe("restart_required");
    expect(session.streamErrorMessage).toBe(
      "Streaming unavailable; restart the browser session to relaunch streaming."
    );
  });

  test("clears stream state when the session stops", async () => {
    const onSessionUpdate = mock(() => undefined);
    const onEnded = mock(() => undefined);
    const backend = createBackend({ onSessionUpdate, onEnded });

    setSession(backend, {
      status: "live",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
      streamErrorMessage: "socket closed",
    });

    expect(
      Reflect.set(backend, "runCliCommand", () => Promise.resolve({ ok: true as const, data: {} }))
    ).toBe(true);

    await backend.stop();

    const session = getSession(backend);
    expect(session.status).toBe("ended");
    expect(session.streamState).toBeNull();
    expect(session.lastFrameMetadata).toBeNull();
    expect(session.streamErrorMessage).toBeNull();
    expect(session.endReason).toBe("agent_closed");
    expect(onSessionUpdate).toHaveBeenCalledTimes(1);
    expect(onSessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ended",
        streamState: null,
        lastFrameMetadata: null,
        streamErrorMessage: null,
        endReason: "agent_closed",
      })
    );
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith("workspace-123");
  });

  test("rejects input when the session is not live", () => {
    const backend = createBackend();
    const send = mock(() => undefined);
    setSession(backend, {
      status: "starting",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput(mouseClickInput);

    expect(result).toEqual({ success: false, error: "Session is not live" });
    expect(send).not.toHaveBeenCalled();
  });

  test("rejects input when the stream is not live", () => {
    const backend = createBackend();
    const send = mock(() => undefined);
    setSession(backend, {
      status: "live",
      streamState: "connecting",
      lastFrameMetadata: viewportMetadata,
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput(mouseClickInput);

    expect(result).toEqual({ success: false, error: "Stream is not live (state: connecting)" });
    expect(send).not.toHaveBeenCalled();
  });

  test("rejects input when frame metadata is unavailable", () => {
    const backend = createBackend();
    const send = mock(() => undefined);
    setSession(backend, {
      status: "live",
      streamState: "live",
      lastFrameMetadata: null,
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput(mouseClickInput);

    expect(result).toEqual({ success: false, error: "No frame metadata available" });
    expect(send).not.toHaveBeenCalled();
  });

  test("sends mapped input over the live stream socket", () => {
    const backend = createBackend();
    const send = mock(() => undefined);
    setSession(backend, {
      status: "live",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput(mouseClickInput);

    expect(result).toEqual({ success: true });
    expect(send).toHaveBeenCalledTimes(1);
    const firstCall = Reflect.get(send.mock.calls, "0") as string[] | undefined;
    const sentMessage = firstCall?.[0];
    expect(JSON.parse(sentMessage ?? "{}")).toEqual({
      type: "input_mouse",
      eventType: "mousePressed",
      x: 100,
      y: 200,
      button: "left",
      clickCount: 1,
    });
  });

  test("sends Enter keyboard input over the live stream socket", () => {
    const backend = createBackend();
    const send = mock(() => undefined);
    setSession(backend, {
      status: "live",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput({
      kind: "keyboard",
      eventType: "keyDown",
      key: "Enter",
      code: "Enter",
      text: "\r",
    });

    expect(result).toEqual({ success: true });
    const firstCall = Reflect.get(send.mock.calls, "0") as string[] | undefined;
    const sentMessage = firstCall?.[0];
    expect(JSON.parse(sentMessage ?? "{}")).toEqual({
      type: "input_keyboard",
      eventType: "keyDown",
      key: "Enter",
      code: "Enter",
      text: "\r",
    });
  });

  test("sends modified keyboard input over the live stream socket", () => {
    const backend = createBackend();
    const send = mock(() => undefined);
    setSession(backend, {
      status: "live",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput({
      kind: "keyboard",
      eventType: "keyDown",
      key: "c",
      code: "KeyC",
      text: "c",
      modifiers: 2,
    });

    expect(result).toEqual({ success: true });
    const firstCall = Reflect.get(send.mock.calls, "0") as string[] | undefined;
    const sentMessage = firstCall?.[0];
    expect(JSON.parse(sentMessage ?? "{}")).toEqual({
      type: "input_keyboard",
      eventType: "keyDown",
      key: "c",
      code: "KeyC",
      text: "c",
      modifiers: 2,
    });
  });

  test("returns an input error when the stream socket closes during send", () => {
    const backend = createBackend();
    const send = mock(() => {
      throw new Error("socket closed");
    });
    setSession(backend, {
      status: "live",
      streamState: "live",
      lastFrameMetadata: viewportMetadata,
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput(mouseClickInput);

    expect(result).toEqual({ success: false, error: "Failed to send input: socket closed" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("clamps mouse coordinates to the viewport before sending", () => {
    const backend = createBackend();
    const send = mock(() => undefined);
    setSession(backend, {
      status: "live",
      streamState: "live",
      lastFrameMetadata: {
        ...viewportMetadata,
        deviceWidth: 640,
        deviceHeight: 480,
      },
    });
    setStreamSocket(backend, { readyState: WebSocket.OPEN, send });

    const result = backend.sendInput({
      kind: "mouse",
      eventType: "mouseMoved",
      x: 999,
      y: -25,
    });

    expect(result).toEqual({ success: true });
    const firstCall = Reflect.get(send.mock.calls, "0") as string[] | undefined;
    const sentMessage = firstCall?.[0];
    expect(JSON.parse(sentMessage ?? "{}")).toEqual({
      type: "input_mouse",
      eventType: "mouseMoved",
      x: 640,
      y: 0,
    });
  });
});
