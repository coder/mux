import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GlobalWindow } from "happy-dom";
import React from "react";
import type { APIClient } from "./API";
import type { PolicyGetResponse } from "@/common/orpc/types";

async function* emptyStream() {
  // no-op
}

let APIProvider!: typeof import("./API").APIProvider;
let PolicyProvider!: typeof import("./PolicyContext").PolicyProvider;
let usePolicy!: typeof import("./PolicyContext").usePolicy;
let isolatedModuleDir: string | null = null;

const contextsDir = dirname(fileURLToPath(import.meta.url));

async function importIsolatedPolicyModules() {
  const tempDir = await mkdtemp(join(contextsDir, ".policy-context-test-"));
  const isolatedApiPath = join(tempDir, "API.real.tsx");
  const isolatedPolicyContextPath = join(tempDir, "PolicyContext.real.tsx");

  await copyFile(join(contextsDir, "API.tsx"), isolatedApiPath);

  const policyContextSource = await readFile(join(contextsDir, "PolicyContext.tsx"), "utf8");
  const isolatedPolicyContextSource = policyContextSource.replace(
    'from "@/browser/contexts/API";',
    'from "./API.real.tsx";'
  );

  if (isolatedPolicyContextSource === policyContextSource) {
    throw new Error("Failed to rewrite PolicyContext API import for the isolated test copy");
  }

  await writeFile(isolatedPolicyContextPath, isolatedPolicyContextSource);

  ({ APIProvider } = await import(pathToFileURL(isolatedApiPath).href));
  ({ PolicyProvider, usePolicy } = await import(pathToFileURL(isolatedPolicyContextPath).href));

  return tempDir;
}

let mockGet: () => Promise<PolicyGetResponse>;

// Keep the API client local to each render so this suite does not leak a process-global
// mock.module override into later context tests.
function createApiClient(): APIClient {
  return {
    policy: {
      get: () => mockGet(),
      onChanged: () => Promise.resolve(emptyStream()),
    },
  } as unknown as APIClient;
}

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
  React.createElement(
    APIProvider,
    { client: createApiClient() },
    React.createElement(PolicyProvider, null, props.children)
  );
Wrapper.displayName = "PolicyContextTestWrapper";

describe("PolicyContext", () => {
  let originalWindow: typeof globalThis.window;
  let originalDocument: typeof globalThis.document;
  let originalLocalStorage: typeof globalThis.localStorage;

  beforeEach(async () => {
    isolatedModuleDir = await importIsolatedPolicyModules();

    originalWindow = globalThis.window;
    originalDocument = globalThis.document;
    originalLocalStorage = globalThis.localStorage;

    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
    globalThis.localStorage = globalThis.window.localStorage;
    globalThis.localStorage.clear();
  });

  afterEach(async () => {
    cleanup();
    mock.restore();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.localStorage = originalLocalStorage;

    if (isolatedModuleDir) {
      await rm(isolatedModuleDir, { recursive: true, force: true });
      isolatedModuleDir = null;
    }
  });

  test("updates when blocked reason changes", async () => {
    // Keep the real PolicyContext module isolated from any earlier Bun mock.module registrations,
    // while still making this response mock resilient to multiple mount refreshes.
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
