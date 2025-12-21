import assert from "node:assert";

import type { ApiClient } from "./client";

export type ServerReachabilityResult =
  | { status: "ok" }
  | {
      status: "unreachable";
      error: string;
    };

export type AuthCheckResult =
  | { status: "ok" }
  | {
      status: "unauthorized";
      error: string;
    }
  | {
      status: "error";
      error: string;
    };

function normalizeBaseUrl(baseUrl: string): string {
  assert(baseUrl.length > 0, "baseUrl must be non-empty");
  return baseUrl.replace(/\/$/, "");
}

async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  assert(timeoutMs > 0, "timeoutMs must be positive");

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timeout);
      });
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isUnauthorizedError(error: unknown): boolean {
  const msg = formatError(error).toLowerCase();
  return (
    msg.includes("unauthorized") ||
    msg.includes("401") ||
    msg.includes("auth token") ||
    msg.includes("authentication")
  );
}

export async function checkServerReachable(
  baseUrl: string,
  options?: { timeoutMs?: number }
): Promise<ServerReachabilityResult> {
  const timeoutMs = options?.timeoutMs ?? 1_000;
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(`${normalizedBaseUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });

    if (!resp.ok) {
      return { status: "unreachable", error: `HTTP ${resp.status} from /health` };
    }

    const data = (await resp.json()) as { status?: unknown };
    if (data.status !== "ok") {
      return {
        status: "unreachable",
        error: "Unexpected /health response",
      };
    }

    return { status: "ok" };
  } catch (error) {
    return {
      status: "unreachable",
      error: formatError(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkAuth(
  client: ApiClient,
  options?: { timeoutMs?: number }
): Promise<AuthCheckResult> {
  const timeoutMs = options?.timeoutMs ?? 1_000;

  try {
    // Used both as an auth check and a basic liveness check.
    await promiseWithTimeout(client.general.ping("vscode"), timeoutMs, "API ping");
    return { status: "ok" };
  } catch (error) {
    if (isUnauthorizedError(error)) {
      return { status: "unauthorized", error: formatError(error) };
    }

    return { status: "error", error: formatError(error) };
  }
}
