/* eslint-disable @typescript-eslint/no-floating-promises -- bun mock.module() is synchronous */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, vi } from "bun:test";

const getMuxHomeMock = vi.fn(() => "/tmp/mux-home");
const lockfileReadMock = vi.fn<() => Promise<{ baseUrl: string; token: string } | null>>();
const startEmbeddedServerMock =
  vi.fn<
    () => Promise<{ baseUrl: string; wsUrl: string; token: string; close: () => Promise<void> }>
  >();
const logDebugMock = vi.fn();

class MockServerLockfile {
  // eslint-disable-next-line @typescript-eslint/no-empty-function -- mock class
  constructor(_muxHome: string) {}

  read(): Promise<{ baseUrl: string; token: string } | null> {
    return lockfileReadMock();
  }
}

mock.module("@/common/constants/paths", () => ({
  getMuxHome: getMuxHomeMock,
}));

mock.module("@/node/services/serverLockfile", () => ({
  ServerLockfile: MockServerLockfile,
}));

mock.module("./embeddedServer", () => ({
  startEmbeddedServer: startEmbeddedServerMock,
}));

mock.module("@/node/services/log", () => ({
  log: {
    debug: logDebugMock,
  },
}));

// eslint-disable-next-line no-restricted-syntax -- dynamic import required: mocks must be registered before module loads
const { resolveBackend } = await import("./backendResolver");

const ORIGINAL_SERVER_URL = process.env.MUX_SERVER_URL;
const ORIGINAL_SERVER_AUTH_TOKEN = process.env.MUX_SERVER_AUTH_TOKEN;

function restoreEnvVar(
  name: "MUX_SERVER_URL" | "MUX_SERVER_AUTH_TOKEN",
  value: string | undefined
): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

describe("resolveBackend", () => {
  beforeEach(() => {
    delete process.env.MUX_SERVER_URL;
    delete process.env.MUX_SERVER_AUTH_TOKEN;

    getMuxHomeMock.mockClear();
    lockfileReadMock.mockReset();
    startEmbeddedServerMock.mockReset();
    logDebugMock.mockReset();
  });

  afterEach(() => {
    restoreEnvVar("MUX_SERVER_URL", ORIGINAL_SERVER_URL);
    restoreEnvVar("MUX_SERVER_AUTH_TOKEN", ORIGINAL_SERVER_AUTH_TOKEN);
  });

  afterAll(() => {
    mock.restore();
  });

  it("prefers explicit server URL and skips lockfile/embedded resolution", async () => {
    process.env.MUX_SERVER_URL = "https://env.example.com";
    process.env.MUX_SERVER_AUTH_TOKEN = "env-token";

    const resolved = await resolveBackend({
      serverUrl: "https://explicit.example.com/base/?debug=1#fragment",
      authToken: " explicit-token ",
    });

    expect(resolved).toEqual({
      kind: "remote",
      baseUrl: "https://explicit.example.com/base",
      wsUrl: "wss://explicit.example.com/base/orpc/ws",
      token: "explicit-token",
    });

    expect(lockfileReadMock).not.toHaveBeenCalled();
    expect(startEmbeddedServerMock).not.toHaveBeenCalled();
  });

  it("uses MUX_SERVER_URL when --server-url is omitted", async () => {
    process.env.MUX_SERVER_URL = "http://127.0.0.1:4321/mux/";
    process.env.MUX_SERVER_AUTH_TOKEN = "env-auth";

    const resolved = await resolveBackend({ authToken: "   " });

    expect(resolved).toEqual({
      kind: "remote",
      baseUrl: "http://127.0.0.1:4321/mux",
      wsUrl: "ws://127.0.0.1:4321/mux/orpc/ws",
      token: "env-auth",
    });

    expect(lockfileReadMock).not.toHaveBeenCalled();
    expect(startEmbeddedServerMock).not.toHaveBeenCalled();
  });

  it("extracts ?token= from the server URL when no explicit auth token is set", async () => {
    const resolved = await resolveBackend({
      serverUrl: "https://remote.example.com?token=url-secret&other=ignored",
    });

    expect(resolved).toEqual({
      kind: "remote",
      baseUrl: "https://remote.example.com",
      wsUrl: "wss://remote.example.com/orpc/ws",
      token: "url-secret",
    });
  });

  it("prefers explicit --auth-token over URL ?token= parameter", async () => {
    const resolved = await resolveBackend({
      serverUrl: "https://remote.example.com?token=url-secret",
      authToken: "cli-token",
    });

    expect(resolved).toEqual({
      kind: "remote",
      baseUrl: "https://remote.example.com",
      wsUrl: "wss://remote.example.com/orpc/ws",
      token: "cli-token",
    });
  });

  it("uses lockfile backend when no explicit URL is provided", async () => {
    lockfileReadMock.mockResolvedValue({
      baseUrl: "https://lockfile.example.com/api/",
      token: "lockfile-token",
    });
    process.env.MUX_SERVER_AUTH_TOKEN = "env-token";

    const resolved = await resolveBackend({ authToken: "cli-token" });

    expect(resolved).toEqual({
      kind: "existing",
      baseUrl: "https://lockfile.example.com/api",
      wsUrl: "wss://lockfile.example.com/api/orpc/ws",
      token: "cli-token",
    });

    expect(getMuxHomeMock).toHaveBeenCalledTimes(1);
    expect(lockfileReadMock).toHaveBeenCalledTimes(1);
    expect(startEmbeddedServerMock).not.toHaveBeenCalled();
  });

  it("starts embedded backend when explicit URL and lockfile are unavailable", async () => {
    const closeMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    lockfileReadMock.mockResolvedValue(null);
    startEmbeddedServerMock.mockResolvedValue({
      baseUrl: "http://127.0.0.1:9876",
      wsUrl: "ws://127.0.0.1:9876/orpc/ws",
      token: "embedded-token",
      close: closeMock,
    });

    const resolved = await resolveBackend({});

    expect(resolved.kind).toBe("embedded");
    if (resolved.kind !== "embedded") {
      throw new Error("Expected embedded backend");
    }

    expect(resolved.baseUrl).toBe("http://127.0.0.1:9876");
    expect(resolved.wsUrl).toBe("ws://127.0.0.1:9876/orpc/ws");
    expect(resolved.token).toBe("embedded-token");
    expect(resolved.close).toBe(closeMock);

    expect(lockfileReadMock).toHaveBeenCalledTimes(1);
    expect(startEmbeddedServerMock).toHaveBeenCalledTimes(1);
    expect(logDebugMock).toHaveBeenCalledTimes(1);
  });
});
