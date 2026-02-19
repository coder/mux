import { describe, expect, test } from "bun:test";
import { isLoopbackHost, resolveServerAuthToken } from "./serverSecurity";

describe("isLoopbackHost", () => {
  test("recognizes localhost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
  });

  test("recognizes 127.0.0.1", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
  });

  test("recognizes 127.x.y.z", () => {
    expect(isLoopbackHost("127.1.2.3")).toBe(true);
  });

  test("recognizes ::1", () => {
    expect(isLoopbackHost("::1")).toBe(true);
  });

  test("rejects 0.0.0.0", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
  });

  test("rejects LAN IP", () => {
    expect(isLoopbackHost("192.168.1.100")).toBe(false);
  });

  test("case insensitive", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
  });

  test("rejects hostnames starting with 127. that are not IPs", () => {
    expect(isLoopbackHost("127.example.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.evil")).toBe(false);
  });

  test("recognizes bracketed IPv6 loopback [::1]", () => {
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  test("rejects 127-prefix with wrong octet count", () => {
    expect(isLoopbackHost("127.0.0")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.2")).toBe(false);
  });

  test("rejects 127-prefix with out-of-range octets", () => {
    expect(isLoopbackHost("127.0.0.256")).toBe(false);
  });
});

describe("resolveServerAuthToken", () => {
  test("explicit token wins over everything", () => {
    const result = resolveServerAuthToken("0.0.0.0", "my-token", "env-token");
    expect(result.token).toBe("my-token");
    expect(result.generated).toBe(false);
  });

  test("env token used when no explicit token", () => {
    const result = resolveServerAuthToken("0.0.0.0", undefined, "env-token");
    expect(result.token).toBe("env-token");
    expect(result.generated).toBe(false);
  });

  test("loopback host without token returns undefined", () => {
    const result = resolveServerAuthToken("127.0.0.1");
    expect(result.token).toBeUndefined();
    expect(result.generated).toBe(false);
  });

  test("localhost without token returns undefined", () => {
    const result = resolveServerAuthToken("localhost");
    expect(result.token).toBeUndefined();
    expect(result.generated).toBe(false);
  });

  test("non-loopback host without token generates token", () => {
    const result = resolveServerAuthToken("0.0.0.0");
    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe("string");
    expect(result.token).toHaveLength(64); // 32 bytes hex
    expect(result.generated).toBe(true);
  });

  test("generated tokens are unique", () => {
    const a = resolveServerAuthToken("0.0.0.0");
    const b = resolveServerAuthToken("0.0.0.0");
    expect(a.token).not.toBe(b.token);
  });

  test("whitespace-only explicit token treated as absent", () => {
    const result = resolveServerAuthToken("0.0.0.0", "  ", undefined);
    expect(result.generated).toBe(true);
  });
});
