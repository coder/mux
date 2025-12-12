/**
 * React DOM integration test utilities.
 *
 * Provides renderWithBackend() - renders components with a real oRPC backend
 * using @testing-library/react. Components get full React context and can
 * make real API calls that hit the ServiceContainer.
 */

import React from "react";
import { act, render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { AppLoader } from "@/browser/components/AppLoader";
import type { APIClient } from "@/browser/contexts/API";
import { createBrowserTestEnv, type BrowserTestEnv } from "./env";

export interface RenderWithBackendResult extends RenderResult {
  /** Test environment with real backend */
  env: BrowserTestEnv;
  /** Cleanup function - unmounts component and cleans up backend */
  cleanup: () => Promise<void>;
}

export interface RenderWithBackendOptions extends Omit<RenderOptions, "wrapper"> {
  /** Pass an existing test environment instead of creating a new one */
  env?: BrowserTestEnv;
}

/**
 * Render a component wrapped in the full app context with a real backend.
 *
 * Usage:
 * ```tsx
 * const { env, cleanup, getByText } = await renderWithBackend();
 * // Interact with DOM using @testing-library queries
 * expect(getByText(/loading/i)).toBeInTheDocument();
 * await cleanup();
 * ```
 *
 * With pre-existing env (for setup before render):
 * ```tsx
 * const env = await createBrowserTestEnv();
 * await env.orpc.projects.create({ projectPath: '/some/path' });
 * const { cleanup, getByText } = await renderWithBackend({ env });
 * ```
 */
export async function renderWithBackend(
  options?: RenderWithBackendOptions
): Promise<RenderWithBackendResult> {
  const existingEnv = options?.env;
  const env = existingEnv ?? (await createBrowserTestEnv());

  // Cast oRPC client to APIClient for React components
  const client = env.orpc as unknown as APIClient;

  const renderResult = render(<AppLoader client={client} />, {
    ...options,
  });

  const cleanup = async () => {
    await act(async () => {
      renderResult.unmount();
    });

    // Only cleanup the env if we created it (not passed in)
    if (!existingEnv) {
      await env.cleanup();
    }
  };

  return {
    ...renderResult,
    env,
    cleanup,
  };
}

/**
 * Render a custom component tree with a real backend.
 *
 * Use this when you want to test a specific component rather than the full app.
 *
 * Usage:
 * ```tsx
 * const { env, cleanup, getByRole } = await renderComponentWithBackend(
 *   <MyComponent prop="value" />
 * );
 * ```
 */
export async function renderComponentWithBackend(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
): Promise<RenderWithBackendResult> {
  const env = await createBrowserTestEnv();

  // Cast oRPC client to APIClient for React components
  const client = env.orpc as unknown as APIClient;

  // Wrap UI in APIProvider for context
  const { APIProvider } = await import("@/browser/contexts/API");

  const renderResult = render(<APIProvider client={client}>{ui}</APIProvider>, {
    ...options,
  });

  const cleanup = async () => {
    await act(async () => {
      renderResult.unmount();
    });
    await env.cleanup();
  };

  return {
    ...renderResult,
    env,
    cleanup,
  };
}
