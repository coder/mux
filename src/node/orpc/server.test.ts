import { describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";
import { createOrpcServer } from "./server";
import type { ORPCContext } from "./context";

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }

  if (!("code" in error)) {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function waitForWebSocketOpen(ws: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("WebSocket closed before opening"));
    };

    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };

    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function waitForWebSocketRejection(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Expected WebSocket handshake to be rejected"));
    }, 5_000);

    const onError = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      resolve();
    };

    const onOpen = () => {
      cleanup();
      reject(new Error("Expected WebSocket handshake to be rejected"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      ws.off("error", onError);
      ws.off("close", onClose);
      ws.off("open", onOpen);
    };

    ws.once("error", onError);
    ws.once("close", onClose);
    ws.once("open", onOpen);
  });
}

async function closeWebSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

describe("createOrpcServer", () => {
  test("serveStatic fallback does not swallow /api routes", async () => {
    // Minimal context stub - router won't be exercised by this test.
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");

      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        serveStatic: true,
        staticDir: tempDir,
      });

      const uiRes = await fetch(`${server.baseUrl}/some/spa/route`);
      expect(uiRes.status).toBe(200);
      const uiText = await uiRes.text();
      expect(uiText).toContain("mux");
      expect(uiText).toContain('<base href="/"');

      const apiRes = await fetch(`${server.baseUrl}/api/not-a-real-route`);
      expect(apiRes.status).toBe(404);
    } finally {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("OAuth callback routes accept POST redirects (query + form_post)", async () => {
    const stubContext: Partial<ORPCContext> = {
      muxGovernorOauthService: {
        handleServerCallbackAndExchange: () => Promise.resolve({ success: true, data: undefined }),
      } as unknown as ORPCContext["muxGovernorOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      // Some OAuth providers issue 307/308 redirects which preserve POST.
      const queryRes = await fetch(
        `${server.baseUrl}/auth/mux-governor/callback?state=test-state&code=test-code`,
        { method: "POST" }
      );
      expect(queryRes.status).toBe(200);
      const queryText = await queryRes.text();
      expect(queryText).toContain("Enrollment complete");

      // response_mode=form_post delivers params in the request body.
      const formRes = await fetch(`${server.baseUrl}/auth/mux-governor/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "state=test-state&code=test-code",
      });
      expect(formRes.status).toBe(200);
      const formText = await formRes.text();
      expect(formText).toContain("Enrollment complete");
    } finally {
      await server?.close();
    }
  });

  test("allows cross-origin POST requests on OAuth callback routes", async () => {
    const handleSuccessfulCallback = () => Promise.resolve({ success: true, data: undefined });
    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["muxGatewayOauthService"],
      muxGovernorOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["muxGovernorOauthService"],
      mcpOauthService: {
        handleServerCallbackAndExchange: handleSuccessfulCallback,
      } as unknown as ORPCContext["mcpOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const callbackHeaders = {
        Origin: "https://evil.example.com",
        "Content-Type": "application/x-www-form-urlencoded",
      };

      const muxGatewayResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(muxGatewayResponse.status).toBe(200);
      expect(muxGatewayResponse.headers.get("access-control-allow-origin")).toBeNull();

      const muxGovernorResponse = await fetch(`${server.baseUrl}/auth/mux-governor/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(muxGovernorResponse.status).toBe(200);
      expect(muxGovernorResponse.headers.get("access-control-allow-origin")).toBeNull();

      const mcpOauthResponse = await fetch(`${server.baseUrl}/auth/mcp-oauth/callback`, {
        method: "POST",
        headers: callbackHeaders,
        body: "state=test-state&code=test-code",
      });
      expect(mcpOauthResponse.status).toBe(200);
      expect(mcpOauthResponse.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server?.close();
    }
  });

  test("brackets IPv6 hosts in returned URLs", async () => {
    // Minimal context stub - router won't be exercised by this test.
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "::1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });
    } catch (error) {
      const code = getErrorCode(error);

      // Some CI environments may not have IPv6 enabled.
      if (code === "EAFNOSUPPORT" || code === "EADDRNOTAVAIL") {
        return;
      }

      throw error;
    }

    try {
      expect(server.baseUrl).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect(server.wsUrl).toMatch(/^ws:\/\/\[::1\]:\d+\/orpc\/ws$/);
      expect(server.specUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/spec\.json$/);
      expect(server.docsUrl).toMatch(/^http:\/\/\[::1\]:\d+\/api\/docs$/);
    } finally {
      await server.close();
    }
  });

  test("blocks cross-origin HTTP requests with Origin headers", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/health`, {
        headers: { Origin: "https://evil.example.com" },
      });

      expect(response.status).toBe(403);
    } finally {
      await server?.close();
    }
  });

  test("allows same-origin HTTP requests with Origin headers", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/health`, {
        headers: { Origin: server.baseUrl },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await server?.close();
    }
  });

  test("allows same-origin requests when X-Forwarded-Proto overrides inferred protocol", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const forwardedOrigin = server.baseUrl.replace(/^http:/, "https:");
      const response = await fetch(`${server.baseUrl}/health`, {
        headers: {
          Origin: forwardedOrigin,
          "X-Forwarded-Proto": "https",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(forwardedOrigin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await server?.close();
    }
  });

  test("allows HTTP requests without Origin headers", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/health`);

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server?.close();
    }
  });

  test("rejects cross-origin WebSocket connections", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    let ws: WebSocket | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      ws = new WebSocket(server.wsUrl, {
        headers: { origin: "https://evil.example.com" },
      });

      await waitForWebSocketRejection(ws);
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("accepts same-origin WebSocket connections", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    let ws: WebSocket | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      ws = new WebSocket(server.wsUrl, {
        headers: { origin: server.baseUrl },
      });

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("accepts WebSocket connections without Origin headers", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    let ws: WebSocket | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      ws = new WebSocket(server.wsUrl);

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("returns restrictive CORS preflight headers for same-origin requests", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/health`, {
        method: "OPTIONS",
        headers: {
          Origin: server.baseUrl,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, PUT, DELETE, OPTIONS"
      );
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization, Content-Type"
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-max-age")).toBe("86400");
    } finally {
      await server?.close();
    }
  });

  test("rejects CORS preflight requests from cross-origin callers", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/health`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example.com",
          "Access-Control-Request-Method": "GET",
        },
      });

      expect(response.status).toBe(403);
    } finally {
      await server?.close();
    }
  });
});
