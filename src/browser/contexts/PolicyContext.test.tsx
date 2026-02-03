import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import React from "react";
import { APIProvider, type APIClient } from "@/browser/contexts/API";
import type { PolicyGetResponse } from "@/common/orpc/types";
import { PolicyProvider, usePolicy } from "./PolicyContext";

async function* emptyStream() {
  // no-op
}

const buildWrapper = (client: APIClient): React.FC<{ children: React.ReactNode }> => {
  const Wrapper = (props: { children: React.ReactNode }) =>
    React.createElement(
      APIProvider,
      { client } as React.ComponentProps<typeof APIProvider>,
      React.createElement(PolicyProvider, null, props.children)
    );
  Wrapper.displayName = "PolicyContextTestWrapper";
  return Wrapper;
};

const buildBlockedResponse = (reason: string): PolicyGetResponse => ({
  status: { state: "blocked", reason },
  policy: null,
});

const buildEnforcedResponse = (): PolicyGetResponse => ({
  status: { state: "enforced" },
  policy: {
    policyFormatVersion: "0.1",
    providerAccess: null,
    mcp: { allowUserDefined: { stdio: true, remote: true } },
    runtimes: null,
  },
});

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
    const get = mock(() => Promise.resolve(current));

    const client = {
      policy: {
        get,
        onChanged: () => Promise.resolve(emptyStream()),
      },
    } as unknown as APIClient;

    const { result } = renderHook(() => usePolicy(), {
      wrapper: buildWrapper(client),
    });

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
    const get = mock(() => Promise.resolve(buildEnforcedResponse()));

    const client = {
      policy: {
        get,
        onChanged: () => Promise.resolve(emptyStream()),
      },
    } as unknown as APIClient;

    const { result } = renderHook(() => usePolicy(), {
      wrapper: buildWrapper(client),
    });

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
