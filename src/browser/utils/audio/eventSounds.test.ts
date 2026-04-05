import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";

import type { EventSoundSettings } from "@/common/config/schemas/appConfigOnDisk";

import { playEventSound } from "./eventSounds";

const AUTH_TOKEN_STORAGE_KEY = "mux:auth-token";

let originalWindow: (Window & typeof globalThis) | undefined;
let originalDocument: Document | undefined;
let originalAudio: typeof Audio | undefined;
let originalLocalStorage: Storage | undefined;
let lastAudioSource: string | null = null;

class MockAudio {
  constructor(src?: string) {
    lastAudioSource = src ?? null;
  }

  play(): Promise<void> {
    return Promise.resolve();
  }
}

describe("eventSounds", () => {
  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalAudio = globalThis.Audio;
    originalLocalStorage = globalThis.localStorage;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    Object.defineProperty(globalThis.window, "api", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    globalThis.document = globalThis.window.document;
    globalThis.Audio = MockAudio as unknown as typeof Audio;
    globalThis.localStorage = globalThis.window.localStorage;

    lastAudioSource = null;
  });

  afterEach(() => {
    globalThis.window = originalWindow!;
    globalThis.document = originalDocument!;
    globalThis.Audio = originalAudio!;
    globalThis.localStorage = originalLocalStorage!;
  });

  test("preserves app proxy base path and forwards URL token for playback", () => {
    window.location.href = "https://coder.example.com/@u/ws/apps/mux/settings?token=url-token";

    const settings: EventSoundSettings = {
      agent_review_ready: {
        enabled: true,
        source: {
          kind: "managed",
          assetId: "11111111-1111-1111-1111-111111111111.wav",
        },
      },
    };

    playEventSound(settings, "agent_review_ready");

    expect(lastAudioSource).toBe(
      "https://coder.example.com/@u/ws/apps/mux/assets/event-sounds/11111111-1111-1111-1111-111111111111.wav?token=url-token"
    );
  });

  test("uses stored auth token when URL token is absent", () => {
    window.location.href = "https://coder.example.com/@u/ws/apps/mux/settings";
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, "stored-token");

    const settings: EventSoundSettings = {
      agent_review_ready: {
        enabled: true,
        source: {
          kind: "managed",
          assetId: "22222222-2222-2222-2222-222222222222.wav",
        },
      },
    };

    playEventSound(settings, "agent_review_ready");

    expect(lastAudioSource).toBe(
      "https://coder.example.com/@u/ws/apps/mux/assets/event-sounds/22222222-2222-2222-2222-222222222222.wav?token=stored-token"
    );
  });

  test("uses API server status in desktop mode to build playback URL", async () => {
    window.location.href = "file:///app/index.html";
    Object.defineProperty(window, "api", {
      value: {},
      writable: true,
      configurable: true,
    });

    const settings: EventSoundSettings = {
      agent_review_ready: {
        enabled: true,
        source: {
          kind: "managed",
          assetId: "33333333-3333-3333-3333-333333333333.wav",
        },
      },
    };

    playEventSound(settings, "agent_review_ready", {
      server: {
        getApiServerStatus: () =>
          Promise.resolve({
            running: true,
            baseUrl: "http://127.0.0.1:55525",
            bindHost: "127.0.0.1",
            port: 55525,
            networkBaseUrls: [],
            token: "desktop-token",
            configuredBindHost: null,
            configuredPort: null,
            configuredServeWebUi: false,
          }),
      },
    } as unknown as Parameters<typeof playEventSound>[2]);

    await Promise.resolve();
    await Promise.resolve();

    expect(lastAudioSource).toBe(
      "http://127.0.0.1:55525/assets/event-sounds/33333333-3333-3333-3333-333333333333.wav?token=desktop-token"
    );
  });
});
