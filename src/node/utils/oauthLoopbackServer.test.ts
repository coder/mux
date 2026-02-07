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
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    }).on("error", reject);
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

  it("resolves with Err on state mismatch", async () => {
    loopback = await startLoopbackServer({ expectedState: "good" });

    const callbackUrl = `${loopback.redirectUri}?state=bad&code=c`;
    const res = await httpGet(callbackUrl);

    expect(res.status).toBe(400);

    const result = await loopback.result;
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Invalid OAuth state");
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
