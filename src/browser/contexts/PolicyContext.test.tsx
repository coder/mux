import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import React from "react";
import type { APIClient } from "@/browser/contexts/API";
import type { PolicyGetResponse } from "@/common/orpc/types";

// Idiomatic pattern: mock @/browser/contexts/API at the top of the file
// before importing PolicyProvider. This ensures our mock takes precedence
// even when other test files have already mocked the same module (bun module
// mocks leak between files: https://github.com/oven-sh/bun/issues/12823).

async function* emptyStream() {
  // no-op
}

let mockGet: () => Promise<PolicyGetResponse>;

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      policy: {
        get: () => mockGet(),
        onChanged: () => Promise.resolve(emptyStream()),
      },
    } as unknown as APIClient,
    status: "connected" as const,
    error: null,
  }),
  APIProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Import AFTER the mock is registered
import { PolicyProvider, usePolicy } from "./PolicyContext";

const buildBlockedResponse = (reason: string): PolicyGetResponse => ({
  source: "governor",
  status: { state: "blocked", reason },
  policy: null,
});

const buildEnforcedResponse = (): PolicyGetResponse => ({
  source: "governor",
  status: { state: "enforced" },
  policy: {
    policyFormatVersion: "0.1",
    providerAccess: null,
    mcp: { allowUserDefined: { stdio: true, remote: true } },
    runtimes: null,
  },
});

const Wrapper = (props: { children: React.ReactNode }) =>
  React.createElement(PolicyProvider, null, props.children);
Wrapper.displayName = "PolicyContextTestWrapper";

describe("PolicyContext", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
    globalThis.localStorage = undefined as unknown as Storage;
  });

  test("updates when blocked reason changes", async () => {
    // Keep this mock resilient to multiple mount refreshes (e.g. StrictMode).
    let current = buildBlockedResponse("Reason A");
    mockGet = () => Promise.resolve(current);

    const { result } = renderHook(() => usePolicy(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.status.reason).toBe("Reason A"), {
      timeout: 3000,
    });

    current = buildBlockedResponse("Reason B");
    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => expect(result.current.status.reason).toBe("Reason B"), {
      timeout: 3000,
    });
  });

  test("keeps identical policy responses stable", async () => {
    mockGet = () => Promise.resolve(buildEnforcedResponse());

    const { result } = renderHook(() => usePolicy(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.policy).not.toBeNull(), { timeout: 3000 });

    const firstPolicy = result.current.policy;
    const firstStatus = result.current.status;

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.policy).toBe(firstPolicy);
    expect(result.current.status).toBe(firstStatus);
  });
});
