import { describe, it, expect } from "bun:test";

import {
  parseCodexOauthAuth,
  isCodexOauthAuthExpired,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountIdFromToken,
  extractAccountIdFromTokens,
} from "./codexOauthAuth";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a claims object into a fake JWT (header.payload.signature). */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.fakesig`;
}

// ---------------------------------------------------------------------------
// parseCodexOauthAuth
// ---------------------------------------------------------------------------

describe("parseCodexOauthAuth", () => {
  it("accepts a valid object with all required fields", () => {
    const input = {
      type: "oauth" as const,
      access: "at_123",
      refresh: "rt_456",
      expires: Date.now() + 60_000,
    };
    const result = parseCodexOauthAuth(input);
    expect(result).toEqual(input);
  });

  it("accepts a valid object with optional accountId", () => {
    const input = {
      type: "oauth" as const,
      access: "at_123",
      refresh: "rt_456",
      expires: Date.now() + 60_000,
      accountId: "acct_abc",
    };
    const result = parseCodexOauthAuth(input);
    expect(result).toEqual(input);
  });

  it("returns null for non-object values", () => {
    expect(parseCodexOauthAuth(null)).toBeNull();
    expect(parseCodexOauthAuth(undefined)).toBeNull();
    expect(parseCodexOauthAuth("string")).toBeNull();
    expect(parseCodexOauthAuth(42)).toBeNull();
    expect(parseCodexOauthAuth([])).toBeNull();
  });

  it("returns null when type is not 'oauth'", () => {
    expect(
      parseCodexOauthAuth({ type: "api-key", access: "a", refresh: "r", expires: 123 })
    ).toBeNull();
  });

  it("returns null when access is missing or empty", () => {
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "", refresh: "r", expires: 123 })
    ).toBeNull();
    expect(parseCodexOauthAuth({ type: "oauth", refresh: "r", expires: 123 })).toBeNull();
  });

  it("returns null when refresh is missing or empty", () => {
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "", expires: 123 })
    ).toBeNull();
  });

  it("returns null when expires is not a finite number", () => {
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "r", expires: NaN })
    ).toBeNull();
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "r", expires: Infinity })
    ).toBeNull();
    expect(
      parseCodexOauthAuth({ type: "oauth", access: "a", refresh: "r", expires: "soon" })
    ).toBeNull();
  });

  it("returns null when accountId is present but empty string", () => {
    expect(
      parseCodexOauthAuth({
        type: "oauth",
        access: "a",
        refresh: "r",
        expires: 123,
        accountId: "",
      })
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isCodexOauthAuthExpired
// ---------------------------------------------------------------------------

describe("isCodexOauthAuthExpired", () => {
  const base = { type: "oauth" as const, access: "a", refresh: "r" };

  it("returns false when token is not yet expired (with default skew)", () => {
    // Token expires 60s from now, default skew is 30s → not expired
    const auth = { ...base, expires: Date.now() + 60_000 };
    expect(isCodexOauthAuthExpired(auth)).toBe(false);
  });

  it("returns true when token is within the skew window", () => {
    // Token expires in 20s, default skew 30s → expired
    const now = Date.now();
    const auth = { ...base, expires: now + 20_000 };
    expect(isCodexOauthAuthExpired(auth, { nowMs: now })).toBe(true);
  });

  it("returns true when token is already past expiry", () => {
    const auth = { ...base, expires: Date.now() - 1000 };
    expect(isCodexOauthAuthExpired(auth)).toBe(true);
  });

  it("respects custom skew", () => {
    const now = 1_000_000;
    const auth = { ...base, expires: now + 5_000 };
    // With 0 skew, not expired
    expect(isCodexOauthAuthExpired(auth, { nowMs: now, skewMs: 0 })).toBe(false);
    // With 10s skew, expired
    expect(isCodexOauthAuthExpired(auth, { nowMs: now, skewMs: 10_000 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseJwtClaims
// ---------------------------------------------------------------------------

describe("parseJwtClaims", () => {
  it("decodes a valid JWT payload", () => {
    const claims = { sub: "user_123", iss: "https://auth.openai.com" };
    const token = fakeJwt(claims);
    expect(parseJwtClaims(token)).toEqual(claims);
  });

  it("returns null for tokens with wrong number of parts", () => {
    expect(parseJwtClaims("")).toBeNull();
    expect(parseJwtClaims("one.two")).toBeNull();
    expect(parseJwtClaims("a.b.c.d")).toBeNull();
  });

  it("returns null for non-object payloads", () => {
    const header = Buffer.from("{}").toString("base64url");
    const payload = Buffer.from('"just a string"').toString("base64url");
    expect(parseJwtClaims(`${header}.${payload}.sig`)).toBeNull();
  });

  it("returns null for invalid base64", () => {
    expect(parseJwtClaims("a.!!!invalid!!!.c")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAccountIdFromClaims
// ---------------------------------------------------------------------------

describe("extractAccountIdFromClaims", () => {
  it("prefers direct chatgpt_account_id claim", () => {
    const claims = {
      chatgpt_account_id: "direct_id",
      "https://api.openai.com/auth": { chatgpt_account_id: "nested_id" },
      organizations: [{ id: "org_id" }],
    };
    expect(extractAccountIdFromClaims(claims)).toBe("direct_id");
  });

  it("falls back to nested auth namespace", () => {
    const claims = {
      "https://api.openai.com/auth": { chatgpt_account_id: "nested_id" },
      organizations: [{ id: "org_id" }],
    };
    expect(extractAccountIdFromClaims(claims)).toBe("nested_id");
  });

  it("falls back to organizations[0].id", () => {
    const claims = {
      organizations: [{ id: "org_id" }],
    };
    expect(extractAccountIdFromClaims(claims)).toBe("org_id");
  });

  it("returns null when no account id is found", () => {
    expect(extractAccountIdFromClaims({})).toBeNull();
    expect(extractAccountIdFromClaims({ organizations: [] })).toBeNull();
    expect(
      extractAccountIdFromClaims({ "https://api.openai.com/auth": "not an object" })
    ).toBeNull();
  });

  it("skips empty string values", () => {
    expect(extractAccountIdFromClaims({ chatgpt_account_id: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAccountIdFromToken / extractAccountIdFromTokens
// ---------------------------------------------------------------------------

describe("extractAccountIdFromToken", () => {
  it("extracts account id from a JWT", () => {
    const token = fakeJwt({ chatgpt_account_id: "from_jwt" });
    expect(extractAccountIdFromToken(token)).toBe("from_jwt");
  });

  it("returns null for an invalid token", () => {
    expect(extractAccountIdFromToken("not-a-jwt")).toBeNull();
  });
});

describe("extractAccountIdFromTokens", () => {
  it("prefers id_token over access token", () => {
    const idToken = fakeJwt({ chatgpt_account_id: "from_id_token" });
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access_token" });
    expect(extractAccountIdFromTokens({ accessToken, idToken })).toBe("from_id_token");
  });

  it("falls back to access token when id_token is missing", () => {
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access_token" });
    expect(extractAccountIdFromTokens({ accessToken })).toBe("from_access_token");
  });

  it("falls back to access token when id_token has no account id", () => {
    const idToken = fakeJwt({ sub: "user" });
    const accessToken = fakeJwt({ chatgpt_account_id: "from_access_token" });
    expect(extractAccountIdFromTokens({ accessToken, idToken })).toBe("from_access_token");
  });
});
