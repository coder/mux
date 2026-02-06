import { describe, expect, it } from "bun:test";

import {
  isLoopbackAddress,
  isPrivateHost,
  rejectUserinfo,
  validateOutboundUrl,
  validateRedirectUri,
} from "./urlSecurity";

describe("isLoopbackAddress", () => {
  it("returns true for IPv4 loopback", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  it("returns true for IPv6 loopback", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  it("returns true for IPv6-mapped IPv4 loopback", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("returns false for undefined", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
  });

  it("returns false for non-loopback address", () => {
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
  });
});

describe("rejectUserinfo", () => {
  it("throws when URL contains userinfo", () => {
    const url = new URL("http://user:pass@example.com/");
    expect(() => rejectUserinfo(url)).toThrow("URL must not contain userinfo (@-credentials)");
  });

  it("does not throw for a clean URL", () => {
    const url = new URL("https://example.com/path");
    expect(() => rejectUserinfo(url)).not.toThrow();
  });

  it("throws for the @-based URL confusion attack vector", () => {
    // new URL() parses host as attacker.com, but url.username is set
    const url = new URL(
      "http://[0:0:0:0:0:ffff:128.168.1.0]@[0:0:0:0:0:ffff:127.168.1.0]@attacker.com/"
    );
    expect(() => rejectUserinfo(url)).toThrow("URL must not contain userinfo (@-credentials)");
  });
});

describe("validateRedirectUri", () => {
  it("accepts a valid https redirect URI", () => {
    const url = validateRedirectUri("https://example.com/callback");
    expect(url.hostname).toBe("example.com");
    expect(url.pathname).toBe("/callback");
  });

  it("accepts a valid http redirect URI", () => {
    const url = validateRedirectUri("http://localhost:8080/callback");
    expect(url.hostname).toBe("localhost");
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateRedirectUri("ftp://example.com/file")).toThrow(
      "Unsupported protocol: ftp:"
    );
  });

  it("rejects URIs with userinfo", () => {
    expect(() => validateRedirectUri("https://user:pass@example.com/callback")).toThrow(
      "URL must not contain userinfo (@-credentials)"
    );
  });

  it("passes when hostname is in allowedHosts", () => {
    const url = validateRedirectUri("https://example.com/callback", {
      allowedHosts: ["example.com", "other.com"],
    });
    expect(url.hostname).toBe("example.com");
  });

  it("rejects when hostname is not in allowedHosts", () => {
    expect(() =>
      validateRedirectUri("https://evil.com/callback", {
        allowedHosts: ["example.com"],
      })
    ).toThrow("Host not in allowlist: evil.com");
  });

  it("ignores allowedHosts when list is empty", () => {
    const url = validateRedirectUri("https://anything.com/callback", {
      allowedHosts: [],
    });
    expect(url.hostname).toBe("anything.com");
  });
});

describe("isPrivateHost", () => {
  const privateCases = [
    ["127.0.0.1", "IPv4 loopback"],
    ["127.255.255.255", "IPv4 loopback high end"],
    ["10.0.0.1", "Class A private"],
    ["10.255.255.255", "Class A private high end"],
    ["172.16.0.1", "Class B private low end"],
    ["172.31.255.255", "Class B private high end"],
    ["192.168.0.1", "Class C private"],
    ["192.168.255.255", "Class C private high end"],
    ["169.254.1.1", "link-local"],
    ["0.0.0.0", '"this" network'],
    ["0.1.2.3", '"this" network prefix'],
    ["::1", "IPv6 loopback"],
    ["[::1]", "IPv6 loopback with brackets"],
    ["fe80::1", "IPv6 link-local"],
    ["localhost", "localhost"],
    ["LOCALHOST", "localhost uppercase"],
  ] as const;

  for (const [host, label] of privateCases) {
    it(`returns true for ${label} (${host})`, () => {
      expect(isPrivateHost(host)).toBe(true);
    });
  }

  const publicCases = [
    ["8.8.8.8", "Google DNS"],
    ["example.com", "public domain"],
    ["1.1.1.1", "Cloudflare DNS"],
    ["203.0.113.1", "documentation range (public)"],
    ["172.15.0.1", "just below Class B private range"],
    ["172.32.0.1", "just above Class B private range"],
  ] as const;

  for (const [host, label] of publicCases) {
    it(`returns false for ${label} (${host})`, () => {
      expect(isPrivateHost(host)).toBe(false);
    });
  }
});

describe("validateOutboundUrl", () => {
  it("accepts a public https URL", () => {
    const url = validateOutboundUrl("https://api.example.com/data");
    expect(url.hostname).toBe("api.example.com");
  });

  it("rejects private IP addresses", () => {
    expect(() => validateOutboundUrl("http://192.168.1.1/secret")).toThrow(
      "Outbound requests to private addresses are not allowed: 192.168.1.1"
    );
  });

  it("rejects localhost", () => {
    expect(() => validateOutboundUrl("http://localhost:3000/api")).toThrow(
      "Outbound requests to private addresses are not allowed: localhost"
    );
  });

  it("rejects URLs with userinfo", () => {
    expect(() => validateOutboundUrl("https://admin:secret@api.example.com/")).toThrow(
      "URL must not contain userinfo (@-credentials)"
    );
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateOutboundUrl("file:///etc/passwd")).toThrow("Unsupported protocol: file:");
  });
});
