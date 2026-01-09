import { describe, expect, test } from "bun:test";
import { buildAuthorizeUrl, buildExchangeBody, MUX_GATEWAY_ORIGIN } from "./muxGatewayOAuth";

describe("muxGatewayOAuth", () => {
  test("buildAuthorizeUrl includes required params", () => {
    const urlString = buildAuthorizeUrl({
      redirectUri: "http://localhost:1234/callback",
      state: "abc123",
    });

    const url = new URL(urlString);
    expect(url.origin).toBe(MUX_GATEWAY_ORIGIN);
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("mux-client");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:1234/callback");
    expect(url.searchParams.get("state")).toBe("abc123");
  });

  test("buildExchangeBody includes required fields", () => {
    const body = buildExchangeBody({ code: "jwt-code" });
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("jwt-code");
    expect(body.get("client_id")).toBe("mux-client");
    expect(body.get("client_secret")).toBe("mux-client");
  });
});
