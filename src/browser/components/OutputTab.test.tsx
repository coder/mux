import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, render, waitFor } from "@testing-library/react";

import { MAX_LOG_ENTRIES } from "@/common/constants/ui";

type LogLevel = "error" | "warn" | "info" | "debug";

interface LogEntry {
  timestamp: number;
  level: LogLevel;
  message: string;
  location: string;
}

interface LogBatch {
  entries: LogEntry[];
  isInitial: boolean;
}

interface MockAPI {
  general: {
    subscribeLogs: () => Promise<AsyncGenerator<LogBatch, void, unknown>>;
    clearLogs: () => Promise<{ success: boolean; error?: string | null }>;
  };
}

let mockApi: MockAPI | null = null;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: mockApi,
    status: mockApi ? ("connected" as const) : ("connecting" as const),
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

import { OutputTab } from "./OutputTab";

function formatEntryMessage(id: number): string {
  return `entry-${id.toString().padStart(4, "0")}`;
}

function createEntries(startId: number, count: number): LogEntry[] {
  return Array.from({ length: count }, (_, i) => {
    const id = startId + i;
    return {
      timestamp: id,
      level: "info",
      message: formatEntryMessage(id),
      location: `src/test.ts:${id}`,
    };
  });
}

function streamBatches(...batches: LogBatch[]): AsyncGenerator<LogBatch, void, unknown> {
  return (async function* () {
    for (const batch of batches) {
      yield batch;
      // Keep this helper explicitly async to match oRPC stream semantics.
      await Promise.resolve();
    }
  })();
}

describe("OutputTab", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;

  beforeEach(() => {
    originalWindow = globalThis.window;
    originalDocument = globalThis.document;

    globalThis.window = new GlobalWindow({ url: "http://localhost" }) as unknown as Window &
      typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    mockApi = null;
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
  });

  test("renders initial log batch from subscription", async () => {
    const initialEntries = createEntries(0, 5);
    mockApi = {
      general: {
        subscribeLogs: () =>
          Promise.resolve(streamBatches({ entries: initialEntries, isInitial: true })),
        clearLogs: () => Promise.resolve({ success: true }),
      },
    };

    const view = render(<OutputTab workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(view.getAllByText(/^entry-\d{4}$/)).toHaveLength(5);
    });

    expect(view.getByText(formatEntryMessage(0))).toBeTruthy();
    expect(view.getByText(formatEntryMessage(4))).toBeTruthy();
  });

  test("caps streamed entries and evicts the oldest entries", async () => {
    const initialEntries = createEntries(0, MAX_LOG_ENTRIES);
    const appendedEntries = createEntries(MAX_LOG_ENTRIES, 200);

    mockApi = {
      general: {
        subscribeLogs: () =>
          Promise.resolve(
            streamBatches(
              { entries: initialEntries, isInitial: true },
              { entries: appendedEntries, isInitial: false }
            )
          ),
        clearLogs: () => Promise.resolve({ success: true }),
      },
    };

    const view = render(<OutputTab workspaceId="workspace-1" />);

    await waitFor(() => {
      expect(view.getAllByText(/^entry-\d{4}$/)).toHaveLength(MAX_LOG_ENTRIES);
    });

    expect(view.queryByText(formatEntryMessage(0))).toBeNull();
    expect(view.queryByText(formatEntryMessage(199))).toBeNull();
    expect(view.getByText(formatEntryMessage(200))).toBeTruthy();
    expect(view.getByText(formatEntryMessage(MAX_LOG_ENTRIES + 199))).toBeTruthy();
  });
});
