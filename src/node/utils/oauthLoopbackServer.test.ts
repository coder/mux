import http from "node:http";
import { describe, it, expect, afterEach } from "bun:test";
import type { LoopbackServer } from "./oauthLoopbackServer";
import { startLoopbackServer } from "./oauthLoopbackServer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the port from a redirectUri like http://127.0.0.1:12345/callback */
function portFromUri(uri: string): number {
  return new URL(uri).port ? Number(new URL(uri).port) : 80;
}

/** Simple GET helper that returns { status, body }. */
async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("startLoopbackServer", () => {
  let loopback: LoopbackServer | undefined;

  afterEach(async () => {
    // Ensure the server is always cleaned up.
    if (loopback?.server.listening) {
      await loopback.close();
    }
    loopback = undefined;
  });

  it("starts a server and provides a redirectUri with the listening port", async () => {
    loopback = await startLoopbackServer({ expectedState: "s1" });

    expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const port = portFromUri(loopback.redirectUri);
    expect(port).toBeGreaterThan(0);
    expect(loopback.server.listening).toBe(true);
  });

  it("honors host when building redirectUri", async () => {
    loopback = await startLoopbackServer({ expectedState: "s1", host: "localhost" });

    const redirectUrl = new URL(loopback.redirectUri);
    expect(redirectUrl.hostname).toBe("localhost");
    expect(loopback.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
  });

  it("returns 403 for non-loopback requests when validateLoopback is enabled", async () => {
    loopback = await startLoopbackServer({ expectedState: "s1", validateLoopback: true });

    // `validateLoopback` is based on `req.socket.remoteAddress`. It's tricky to
    // force a non-loopback remoteAddress with bun's http client, so invoke the
    // request handler directly with a mocked request/response.
    const handler = loopback.server.listeners("request")[0] as unknown as (
      req: http.IncomingMessage,
      res: http.ServerResponse
    ) => void;

    let body = "";
    const headers: Record<string, unknown> = {};
    const res = {
      statusCode: 0,
      setHeader: (name: string, value: unknown) => {
        headers[name] = value;
      },
      end: (chunk?: unknown) => {
        if (typeof chunk === "string") {
          body = chunk;
          return;
        }
        if (Buffer.isBuffer(chunk)) {
          body = chunk.toString();
          return;
        }
        body = "";
      },
    };

    const req = {
      method: "GET",
      url: "/callback?state=s1&code=c1",
      socket: { remoteAddress: "192.0.2.1" },
    };

    handler(req as unknown as http.IncomingMessage, res as unknown as http.ServerResponse);

    expect(res.statusCode).toBe(403);
    expect(body).toContain("Forbidden");

    const resultState = await Promise.race([
      loopback.result.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(resultState).toBe("pending");

    await loopback.cancel();
  });

  it("resolves with Ok({code, state}) on a valid callback", async () => {
    loopback = await startLoopbackServer({ expectedState: "state123" });

    const callbackUrl = `${loopback.redirectUri}?state=state123&code=authcode456`;
    const res = await httpGet(callbackUrl);

    expect(res.status).toBe(200);
    expect(res.body).toContain("<!doctype html>");

    const result = await loopback.result;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("authcode456");
      expect(result.data.state).toBe("state123");
    }
  });

  it("returns 400 on state mismatch but keeps waiting for a valid callback", async () => {
    loopback = await startLoopbackServer({ expectedState: "good" });

    const badCallbackUrl = `${loopback.redirectUri}?state=bad&code=c`;
    const badRes = await httpGet(badCallbackUrl);

    expect(badRes.status).toBe(400);
    expect(badRes.body).toContain("Invalid OAuth state");

    const resultState = await Promise.race([
      loopback.result.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(resultState).toBe("pending");

    const goodCallbackUrl = `${loopback.redirectUri}?state=good&code=authcode456`;
    const goodRes = await httpGet(goodCallbackUrl);

    expect(goodRes.status).toBe(200);

    const result = await loopback.result;
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("authcode456");
      expect(result.data.state).toBe("good");
    }
  });

  it("resolves with Err when provider returns an error param", async () => {
    loopback = await startLoopbackServer({ expectedState: "s1" });

    const callbackUrl = `${loopback.redirectUri}?state=s1&error=access_denied&error_description=User+denied`;
    const res = await httpGet(callbackUrl);

    expect(res.status).toBe(400);

    const result = await loopback.result;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("access_denied");
      expect(result.error).toContain("User denied");
    }
  });

  it("resolves with Err when code is missing", async () => {
    loopback = await startLoopbackServer({ expectedState: "s1" });

    const callbackUrl = `${loopback.redirectUri}?state=s1`;
    const res = await httpGet(callbackUrl);

    expect(res.status).toBe(400);

    const result = await loopback.result;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Missing authorization code");
    }
  });

  it("returns 404 for the wrong path", async () => {
    loopback = await startLoopbackServer({ expectedState: "s1" });

    const port = portFromUri(loopback.redirectUri);
    const res = await httpGet(`http://127.0.0.1:${port}/wrong`);

    expect(res.status).toBe(404);
    expect(res.body).toContain("Not found");
  });

  it("cancel resolves result with Err and closes the server", async () => {
    loopback = await startLoopbackServer({ expectedState: "s1" });
    expect(loopback.server.listening).toBe(true);

    await loopback.cancel();

    const result = await loopback.result;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("cancelled");
    }
    expect(loopback.server.listening).toBe(false);
  });

  it("uses a custom callbackPath", async () => {
    loopback = await startLoopbackServer({
      expectedState: "s1",
      callbackPath: "/oauth/done",
    });

    expect(loopback.redirectUri).toContain("/oauth/done");

    const callbackUrl = `${loopback.redirectUri}?state=s1&code=c1`;
    const res = await httpGet(callbackUrl);
    expect(res.status).toBe(200);

    const result = await loopback.result;
    expect(result.success).toBe(true);
  });

  it("defers success response until sendSuccessResponse is called", async () => {
    loopback = await startLoopbackServer({
      expectedState: "s1",
      deferSuccessResponse: true,
    });

    const callbackUrl = `${loopback.redirectUri}?state=s1&code=c1`;
    const responsePromise = httpGet(callbackUrl);

    const callbackResult = await loopback.result;
    expect(callbackResult.success).toBe(true);

    const responseState = await Promise.race([
      responsePromise.then(() => "settled" as const),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 25)),
    ]);
    expect(responseState).toBe("pending");

    loopback.sendSuccessResponse();

    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.body).toContain("Login complete");
  });

  it("can send deferred failure response after receiving a valid code", async () => {
    loopback = await startLoopbackServer({
      expectedState: "s1",
      deferSuccessResponse: true,
    });

    const callbackUrl = `${loopback.redirectUri}?state=s1&code=c1`;
    const responsePromise = httpGet(callbackUrl);

    const callbackResult = await loopback.result;
    expect(callbackResult.success).toBe(true);

    loopback.sendFailureResponse("Token exchange failed");

    const response = await responsePromise;
    expect(response.status).toBe(400);
    expect(response.body).toContain("Token exchange failed");
  });

  it("sends a cancellation response if deferred callback is still pending during close", async () => {
    loopback = await startLoopbackServer({
      expectedState: "s1",
      deferSuccessResponse: true,
    });

    const callbackUrl = `${loopback.redirectUri}?state=s1&code=c1`;
    const responsePromise = httpGet(callbackUrl);

    const callbackResult = await loopback.result;
    expect(callbackResult.success).toBe(true);

    await loopback.close();

    const response = await responsePromise;
    expect(response.status).toBe(400);
    expect(response.body).toContain("OAuth flow cancelled");
  });

  it("uses a custom renderHtml function", async () => {
    const customHtml = "<html><body>Custom!</body></html>";
    loopback = await startLoopbackServer({
      expectedState: "s1",
      renderHtml: () => customHtml,
    });

    const callbackUrl = `${loopback.redirectUri}?state=s1&code=c1`;
    const res = await httpGet(callbackUrl);

    expect(res.status).toBe(200);
    expect(res.body).toBe(customHtml);

    const result = await loopback.result;
    expect(result.success).toBe(true);
  });
});
