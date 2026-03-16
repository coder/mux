import { describe, expect, mock, test } from "bun:test";

import type { BrowserSession } from "@/common/types/browserSession";
import { BrowserSessionBackend } from "@/node/services/browserSessionBackend";

const noop = (): void => undefined;

function createBackend(initialUrl = "https://example.com"): BrowserSessionBackend {
  return new BrowserSessionBackend({
    workspaceId: "workspace-123",
    ownership: "shared",
    initialUrl,
    onSessionUpdate: noop,
    onAction: noop,
    onEnded: noop,
    onError: noop,
  });
}

describe("BrowserSessionBackend", () => {
  test("reuses the deterministic mux session id", () => {
    const backend = createBackend();

    expect(backend.getSession().id).toMatch(/^mux-workspace-123-[a-f0-9]{8}$/);
  });

  test("attaches to an existing daemon session without reopening the initial URL", async () => {
    const backend = createBackend("https://start.example.com");
    const runCliCommand = mock(() => Promise.resolve({ ok: true as const, data: {} }));
    const refreshMetadata = mock(() => {
      const session = Reflect.get(backend, "session") as BrowserSession;
      Reflect.set(backend, "session", {
        ...session,
        currentUrl: "https://attached.example.com",
        title: "Attached page",
        updatedAt: new Date().toISOString(),
      });
      return Promise.resolve();
    });

    expect(Reflect.set(backend, "hasExistingSession", () => true)).toBe(true);
    expect(Reflect.set(backend, "runCliCommand", runCliCommand)).toBe(true);
    expect(Reflect.set(backend, "refreshMetadata", refreshMetadata)).toBe(true);

    const session = await backend.start();

    expect(runCliCommand).not.toHaveBeenCalled();
    expect(refreshMetadata).toHaveBeenCalledTimes(1);
    expect(session.id).toMatch(/^mux-workspace-123-[a-f0-9]{8}$/);
    expect(session.status).toBe("live");
    expect(session.currentUrl).toBe("https://attached.example.com");
  });

  test("opens the initial URL when no daemon session exists yet", async () => {
    const backend = createBackend("https://start.example.com");
    const runCliCommand = mock((args: string[]) => {
      expect(args).toEqual(["open", "https://start.example.com"]);
      return Promise.resolve({ ok: true as const, data: {} });
    });
    const refreshMetadata = mock(() => {
      const session = Reflect.get(backend, "session") as BrowserSession;
      Reflect.set(backend, "session", {
        ...session,
        currentUrl: "https://start.example.com",
        title: "Start page",
        updatedAt: new Date().toISOString(),
      });
      return Promise.resolve();
    });

    expect(Reflect.set(backend, "hasExistingSession", () => false)).toBe(true);
    expect(Reflect.set(backend, "runCliCommand", runCliCommand)).toBe(true);
    expect(Reflect.set(backend, "refreshMetadata", refreshMetadata)).toBe(true);

    const session = await backend.start();

    expect(runCliCommand).toHaveBeenCalledTimes(1);
    expect(refreshMetadata).toHaveBeenCalledTimes(1);
    expect(session.status).toBe("live");
    expect(session.currentUrl).toBe("https://start.example.com");
  });
});
