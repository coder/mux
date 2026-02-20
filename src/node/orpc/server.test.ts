import { describe, expect, test } from "bun:test";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { WebSocket } from "ws";
import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { createORPCClient } from "@orpc/client";
import type { RouterClient } from "@orpc/server";
import { createOrpcServer } from "./server";
import type { ORPCContext } from "./context";
import type { AppRouter } from "./router";

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

function createHttpClient(
  baseUrl: string,
  headers?: Record<string, string>
): RouterClient<AppRouter> {
  const link = new HTTPRPCLink({
    url: `${baseUrl}/orpc`,
    headers,
  });

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- test helper
  return createORPCClient(link) as RouterClient<AppRouter>;
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

  test("does not apply origin validation to static and SPA fallback routes", async () => {
    // Static app shell must remain reachable even if proxy/header rewriting makes
    // request Origin values unexpected. API/WS/auth routes are validated separately.
    const stubContext: Partial<ORPCContext> = {};

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mux-static-origin-"));
    const indexHtml =
      "<!doctype html><html><head><title>mux</title></head><body><div>ok</div></body></html>";
    const mainJs = "console.log('ok');";
    const mainCss = "body { color: #fff; }";

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      await fs.writeFile(path.join(tempDir, "index.html"), indexHtml, "utf-8");
      await fs.writeFile(path.join(tempDir, "main.js"), mainJs, "utf-8");
      await fs.writeFile(path.join(tempDir, "main.css"), mainCss, "utf-8");

      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
        serveStatic: true,
        staticDir: tempDir,
      });

      const directIndexResponse = await fetch(`${server.baseUrl}/`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(directIndexResponse.status).toBe(200);
      expect(directIndexResponse.headers.get("access-control-allow-origin")).toBeNull();

      const staticJsResponse = await fetch(`${server.baseUrl}/main.js`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(staticJsResponse.status).toBe(200);
      expect(staticJsResponse.headers.get("access-control-allow-origin")).toBeNull();

      const staticCssResponse = await fetch(`${server.baseUrl}/main.css`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(staticCssResponse.status).toBe(200);
      expect(staticCssResponse.headers.get("access-control-allow-origin")).toBeNull();

      const fallbackRouteResponse = await fetch(`${server.baseUrl}/some/spa/route`, {
        headers: { Origin: "https://evil.example.com" },
      });
      expect(fallbackRouteResponse.status).toBe(200);
      expect(fallbackRouteResponse.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server?.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  test("reports whether GitHub device-flow login is enabled", async () => {
    async function runCase(enabled: boolean): Promise<void> {
      const stubContext: Partial<ORPCContext> = {
        serverAuthService: {
          isGithubDeviceFlowEnabled: () => enabled,
        } as unknown as ORPCContext["serverAuthService"],
      };

      let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

      try {
        server = await createOrpcServer({
          host: "127.0.0.1",
          port: 0,
          context: stubContext as ORPCContext,
        });

        const response = await fetch(`${server.baseUrl}/auth/server-login/options`);
        expect(response.status).toBe(200);

        const payload = (await response.json()) as { githubDeviceFlowEnabled?: boolean };
        expect(payload.githubDeviceFlowEnabled).toBe(enabled);
      } finally {
        await server?.close();
      }
    }

    await runCase(false);
    await runCase(true);
  });

  test("returns 429 when GitHub device-flow start is rate limited", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        startGithubDeviceFlow: () =>
          Promise.resolve({
            success: false,
            error: "Too many concurrent GitHub login attempts. Please wait and try again.",
          }),
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/start`, {
        method: "POST",
      });
      expect(response.status).toBe(429);
    } finally {
      await server?.close();
    }
  });

  test("uses HTTPS redirect URIs for OAuth start routes when forwarded proto is overwritten", async () => {
    let muxGatewayRedirectUri = "";
    let muxGovernorRedirectUri = "";

    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway" };
        },
      } as unknown as ORPCContext["muxGatewayOauthService"],
      muxGovernorOauthService: {
        startServerFlow: (input: { governorOrigin: string; redirectUri: string }) => {
          muxGovernorRedirectUri = input.redirectUri;
          return {
            success: true,
            data: { authorizeUrl: "https://governor.example.com/auth", state: "state-governor" },
          };
        },
      } as unknown as ORPCContext["muxGovernorOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const sharedHeaders = {
        Authorization: "Bearer test-token",
        Origin: "https://mux-public.example.com",
        "X-Forwarded-Host": "mux-public.example.com:443",
        "X-Forwarded-Proto": "http",
      };

      const muxGatewayResponse = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: sharedHeaders,
      });
      expect(muxGatewayResponse.status).toBe(200);

      const muxGovernorResponse = await fetch(
        `${server.baseUrl}/auth/mux-governor/start?governorUrl=${encodeURIComponent("https://governor.example.com")}`,
        {
          headers: sharedHeaders,
        }
      );
      expect(muxGovernorResponse.status).toBe(200);

      expect(muxGatewayRedirectUri).toBe(
        "https://mux-public.example.com/auth/mux-gateway/callback"
      );
      expect(muxGovernorRedirectUri).toBe(
        "https://mux-public.example.com/auth/mux-governor/callback"
      );
    } finally {
      await server?.close();
    }
  });

  test("uses HTTP redirect URIs for OAuth start routes when client-facing proto is HTTP", async () => {
    let muxGatewayRedirectUri = "";

    const stubContext: Partial<ORPCContext> = {
      muxGatewayOauthService: {
        startServerFlow: (input: { redirectUri: string }) => {
          muxGatewayRedirectUri = input.redirectUri;
          return { authorizeUrl: "https://gateway.example.com/auth", state: "state-gateway-http" };
        },
      } as unknown as ORPCContext["muxGatewayOauthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const response = await fetch(`${server.baseUrl}/auth/mux-gateway/start`, {
        headers: {
          Authorization: "Bearer test-token",
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "http,https",
        },
      });

      expect(response.status).toBe(200);
      expect(muxGatewayRedirectUri).toBe(`${server.baseUrl}/auth/mux-gateway/callback`);
    } finally {
      await server?.close();
    }
  });

  test("scopes mux_session cookie path to forwarded app base path", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-1", sessionToken: "session-token-1" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-Prefix": "/@test/workspace/apps/mux/",
        },
        body: JSON.stringify({ flowId: "flow-1" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-1");
      expect(cookieHeader).toContain("Path=/@test/workspace/apps/mux;");
    } finally {
      await server?.close();
    }
  });

  test("sets Secure mux_session cookie when HTTPS origin is accepted via proto compatibility", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-2", sessionToken: "session-token-compat" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://mux-public.example.com",
          "X-Forwarded-Host": "mux-public.example.com:443",
          "X-Forwarded-Proto": "http",
        },
        body: JSON.stringify({ flowId: "flow-compat" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-compat");
      expect(cookieHeader).toContain("; Secure");
    } finally {
      await server?.close();
    }
  });

  test("does not set Secure mux_session cookie when client-facing proto is HTTP", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        waitForGithubDeviceFlow: () =>
          Promise.resolve({
            success: true,
            data: { sessionId: "session-3", sessionToken: "session-token-http" },
          }),
        cancelGithubDeviceFlow: () => {
          // no-op for this test
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/auth/server-login/github/wait`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "http,https",
        },
        body: JSON.stringify({ flowId: "flow-http" }),
      });

      expect(response.status).toBe(200);
      const cookieHeader = response.headers.get("set-cookie");
      expect(cookieHeader).toBeTruthy();
      expect(cookieHeader).toContain("mux_session=session-token-http");
      expect(cookieHeader).not.toContain("; Secure");
    } finally {
      await server?.close();
    }
  });

  test("accepts ORPC requests authenticated via mux_session cookie", async () => {
    const stubContext: Partial<ORPCContext> = {
      serverAuthService: {
        validateSessionToken: (token: string) => {
          if (token === "valid-session-token") {
            return Promise.resolve({ sessionId: "session-1" });
          }
          return Promise.resolve(null);
        },
      } as unknown as ORPCContext["serverAuthService"],
    };

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;

    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
        authToken: "test-token",
      });

      const unauthenticatedClient = createHttpClient(server.baseUrl);

      let unauthenticatedError: unknown = null;
      try {
        await Promise.resolve(unauthenticatedClient.general.ping("cookie-auth"));
      } catch (error) {
        unauthenticatedError = error;
      }
      expect(unauthenticatedError).toBeTruthy();

      const duplicateCookieClient = createHttpClient(server.baseUrl, {
        Cookie: "mux_session=invalid-session-token; mux_session=valid-session-token",
      });
      const duplicateCookiePing = await Promise.resolve(
        duplicateCookieClient.general.ping("cookie-auth")
      );
      expect(duplicateCookiePing).toBe("Pong: cookie-auth");

      const cookieClient = createHttpClient(server.baseUrl, {
        Cookie: "mux_session=valid-session-token",
      });
      const authenticatedPing = await Promise.resolve(cookieClient.general.ping("cookie-auth"));
      expect(authenticatedPing).toBe("Pong: cookie-auth");
    } finally {
      await server?.close();
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

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
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

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: { Origin: server.baseUrl },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await server?.close();
    }
  });

  test("allows same-origin HTTP requests when X-Forwarded-Host does not match", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: {
          Origin: server.baseUrl,
          "X-Forwarded-Host": "internal.proxy.local",
        },
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
      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
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

  test("allows HTTP origins when X-Forwarded-Proto includes multiple hops with leading http", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: {
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "http,https",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(server.baseUrl);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await server?.close();
    }
  });

  test("allows HTTPS origins when X-Forwarded-Proto includes multiple hops with trailing https", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const forwardedOrigin = server.baseUrl.replace(/^http:/, "https:");
      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: {
          Origin: forwardedOrigin,
          "X-Forwarded-Proto": "http,https",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(forwardedOrigin);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await server?.close();
    }
  });

  test("accepts HTTPS origins when X-Forwarded-Proto is overwritten to http by downstream proxy", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: {
          Origin: "https://mux-public.example.com",
          "X-Forwarded-Host": "mux-public.example.com",
          "X-Forwarded-Proto": "http",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://mux-public.example.com"
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await server?.close();
    }
  });

  test("allows HTTPS origins when overwritten proto uses forwarded host with explicit :443", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: {
          Origin: "https://mux-public.example.com",
          "X-Forwarded-Host": "mux-public.example.com:443",
          "X-Forwarded-Proto": "http",
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://mux-public.example.com"
      );
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    } finally {
      await server?.close();
    }
  });

  test("rejects downgraded HTTP origins when X-Forwarded-Proto pins https", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: {
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "https",
        },
      });

      expect(response.status).toBe(403);
    } finally {
      await server?.close();
    }
  });

  test("rejects downgraded HTTP origins when X-Forwarded-Proto includes multiple hops", async () => {
    const stubContext: Partial<ORPCContext> = {};

    let server: Awaited<ReturnType<typeof createOrpcServer>> | null = null;
    try {
      server = await createOrpcServer({
        host: "127.0.0.1",
        port: 0,
        context: stubContext as ORPCContext,
      });

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
        headers: {
          Origin: server.baseUrl,
          "X-Forwarded-Proto": "https,http",
        },
      });

      expect(response.status).toBe(403);
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

      const response = await fetch(`${server.baseUrl}/api/spec.json`);

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

  test("accepts same-origin WebSocket connections when X-Forwarded-Host does not match", async () => {
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
        headers: {
          origin: server.baseUrl,
          "x-forwarded-host": "internal.proxy.local",
        },
      });

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("accepts proxied HTTPS WebSocket origins when forwarded headers describe public app URL", async () => {
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
        headers: {
          origin: "https://mux-public.example.com",
          "x-forwarded-host": "mux-public.example.com",
          "x-forwarded-proto": "https",
        },
      });

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("accepts HTTP WebSocket origins when X-Forwarded-Proto includes multiple hops with leading http", async () => {
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
        headers: {
          origin: server.baseUrl,
          "x-forwarded-proto": "http,https",
        },
      });

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("accepts HTTPS WebSocket origins when X-Forwarded-Proto includes multiple hops with trailing https", async () => {
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
        headers: {
          origin: server.baseUrl.replace(/^http:/, "https:"),
          "x-forwarded-proto": "http,https",
        },
      });

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("accepts HTTPS WebSocket origins when X-Forwarded-Proto is overwritten to http by downstream proxy", async () => {
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
        headers: {
          origin: "https://mux-public.example.com",
          "x-forwarded-host": "mux-public.example.com",
          "x-forwarded-proto": "http",
        },
      });

      await waitForWebSocketOpen(ws);
      await closeWebSocket(ws);
      ws = null;
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("rejects downgraded WebSocket origins when X-Forwarded-Proto pins https", async () => {
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
        headers: {
          origin: server.baseUrl,
          "x-forwarded-proto": "https",
        },
      });

      await waitForWebSocketRejection(ws);
    } finally {
      ws?.terminate();
      await server?.close();
    }
  });

  test("rejects downgraded WebSocket origins when X-Forwarded-Proto includes multiple hops", async () => {
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
        headers: {
          origin: server.baseUrl,
          "x-forwarded-proto": "https,http",
        },
      });

      await waitForWebSocketRejection(ws);
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

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
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

      const response = await fetch(`${server.baseUrl}/api/spec.json`, {
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
