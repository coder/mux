import "../../../../../tests/ui/dom";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { HEARTBEAT_DEFAULT_MESSAGE_BODY } from "@/constants/heartbeat";
import { installDom } from "../../../../../tests/ui/dom";

interface MockConfig {
  heartbeatDefaultPrompt?: string;
  heartbeatDefaultIntervalMs?: number;
}

interface MockAPIClient {
  config: {
    getConfig: () => Promise<MockConfig>;
    updateHeartbeatDefaultPrompt: (input: { defaultPrompt?: string | null }) => Promise<void>;
    updateHeartbeatDefaultIntervalMs: (input: { intervalMs?: number | null }) => Promise<void>;
  };
}

let mockApi: MockAPIClient;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { HeartbeatSection } from "./HeartbeatSection";

function createMockAPI(configOverrides: Partial<MockConfig> = {}) {
  const config: MockConfig = {
    ...configOverrides,
  };

  const updateHeartbeatDefaultPromptMock = mock(
    ({ defaultPrompt }: { defaultPrompt?: string | null }) => {
      config.heartbeatDefaultPrompt = defaultPrompt?.trim() ? defaultPrompt.trim() : undefined;
      return Promise.resolve();
    }
  );
  const updateHeartbeatDefaultIntervalMsMock = mock(
    ({ intervalMs }: { intervalMs?: number | null }) => {
      config.heartbeatDefaultIntervalMs = intervalMs ?? undefined;
      return Promise.resolve();
    }
  );

  return {
    api: {
      config: {
        getConfig: mock(() => Promise.resolve({ ...config })),
        updateHeartbeatDefaultPrompt: updateHeartbeatDefaultPromptMock,
        updateHeartbeatDefaultIntervalMs: updateHeartbeatDefaultIntervalMsMock,
      },
    },
    updateHeartbeatDefaultPromptMock,
    updateHeartbeatDefaultIntervalMsMock,
  };
}

function renderHeartbeatSection(configOverrides: Partial<MockConfig> = {}) {
  const { api, updateHeartbeatDefaultPromptMock, updateHeartbeatDefaultIntervalMsMock } =
    createMockAPI(configOverrides);
  mockApi = api;

  const view = render(
    <ThemeProvider forcedTheme="dark">
      <HeartbeatSection />
    </ThemeProvider>
  );

  return { view, updateHeartbeatDefaultPromptMock, updateHeartbeatDefaultIntervalMsMock };
}

describe("HeartbeatSection", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("renders the default heartbeat controls", async () => {
    const { view } = renderHeartbeatSection();

    const thresholdInput = (await waitFor(() =>
      view.getByLabelText("Default heartbeat threshold in minutes")
    )) as HTMLInputElement;

    expect(thresholdInput.value).toBe("30");
    const promptField = view.getByLabelText("Default heartbeat prompt") as HTMLTextAreaElement;
    expect(promptField.placeholder).toBe(HEARTBEAT_DEFAULT_MESSAGE_BODY);
  });

  test("loads and saves the default heartbeat prompt", async () => {
    const initialPrompt = "Review pending work before acting.";
    const { view, updateHeartbeatDefaultPromptMock } = renderHeartbeatSection({
      heartbeatDefaultPrompt: initialPrompt,
    });

    const promptField = (await waitFor(() =>
      view.getByLabelText("Default heartbeat prompt")
    )) as HTMLTextAreaElement;

    expect(promptField.value).toBe(initialPrompt);

    fireEvent.blur(promptField);

    await waitFor(() => {
      expect(updateHeartbeatDefaultPromptMock.mock.calls[0]?.[0]).toEqual({
        defaultPrompt: initialPrompt,
      });
    });
  });

  test("loads and saves the default heartbeat threshold", async () => {
    const initialIntervalMs = 45 * 60_000;
    const { view, updateHeartbeatDefaultIntervalMsMock } = renderHeartbeatSection({
      heartbeatDefaultIntervalMs: initialIntervalMs,
    });

    const thresholdInput = (await waitFor(() =>
      view.getByLabelText("Default heartbeat threshold in minutes")
    )) as HTMLInputElement;

    expect(thresholdInput.value).toBe("45");

    fireEvent.blur(thresholdInput);

    await waitFor(() => {
      expect(updateHeartbeatDefaultIntervalMsMock.mock.calls[0]?.[0]).toEqual({
        intervalMs: initialIntervalMs,
      });
    });
  });
});
