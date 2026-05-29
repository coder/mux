import { describe, expect, test } from "bun:test";
import { normalizeLocalhostProxyUrl } from "./localhostProxyUrl";

describe("normalizeLocalhostProxyUrl", () => {
  test("returns original URL when input URL parsing fails", () => {
    const originalUrl = "not-a-valid-url";

    expect(
      normalizeLocalhostProxyUrl({
        url: originalUrl,
        localhostProxyTemplate: "https://proxy-{{port}}.example.test",
      })
    ).toBe(originalUrl);
  });

  test("returns original URL when proxy template is missing", () => {
    const originalUrl = "http://localhost:5173/dashboard";

    expect(
      normalizeLocalhostProxyUrl({
        url: originalUrl,
      })
    ).toBe(originalUrl);
  });

  test("returns original URL when proxy template does not include {{port}}", () => {
    const originalUrl = "http://localhost:5173/dashboard";

    expect(
      normalizeLocalhostProxyUrl({
        url: originalUrl,
        localhostProxyTemplate: "https://proxy.example.test",
      })
    ).toBe(originalUrl);
  });

  test("returns original URL for non-http protocols", () => {
    const originalUrl = "ws://localhost:5173/socket";

    expect(
      normalizeLocalhostProxyUrl({
        url: originalUrl,
        localhostProxyTemplate: "https://proxy-{{port}}.example.test",
      })
    ).toBe(originalUrl);
  });

  test("returns original URL for non-loopback hosts", () => {
    const originalUrl = "http://example.com:5173/dashboard";

    expect(
      normalizeLocalhostProxyUrl({
        url: originalUrl,
        localhostProxyTemplate: "https://proxy-{{port}}.example.test",
      })
    ).toBe(originalUrl);
  });

  test("rewrites localhost URLs and preserves pathname/search/hash", () => {
    expect(
      normalizeLocalhostProxyUrl({
        url: "http://localhost:5173/foo/bar?tab=logs#tail",
        localhostProxyTemplate: "https://proxy-{{port}}.example.test",
      })
    ).toBe("https://proxy-5173.example.test/foo/bar?tab=logs#tail");
  });

  test("rewrites supported loopback aliases", () => {
    const cases = [
      {
        url: "http://127.0.0.1:6001/path?x=1#hash",
        expected: "https://proxy-6001.example.test/path?x=1#hash",
      },
      {
        url: "http://0.0.0.0:6002/path?x=1#hash",
        expected: "https://proxy-6002.example.test/path?x=1#hash",
      },
      {
        url: "https://[::1]:6003/path?x=1#hash",
        expected: "https://proxy-6003.example.test/path?x=1#hash",
      },
    ] as const;

    for (const testCase of cases) {
      expect(
        normalizeLocalhostProxyUrl({
          url: testCase.url,
          localhostProxyTemplate: "https://proxy-{{port}}.example.test",
        })
      ).toBe(testCase.expected);
    }
  });

  test("replaces {{host}} with browser host when provided", () => {
    expect(
      normalizeLocalhostProxyUrl({
        url: "http://127.0.0.1:7443/app?mode=dev#section",
        localhostProxyTemplate: "https://{{host}}-{{port}}.proxy.example.test",
        browserHost: "browser.localhost",
      })
    ).toBe("https://browser.localhost-7443.proxy.example.test/app?mode=dev#section");
  });

  test("falls back to source host replacement when browser host is not provided", () => {
    expect(
      normalizeLocalhostProxyUrl({
        url: "http://localhost:4000/health",
        localhostProxyTemplate: "https://{{host}}-{{port}}.proxy.example.test",
      })
    ).toBe("https://localhost-4000.proxy.example.test/health");
  });

  test("uses default protocol port when source URL omits explicit port", () => {
    expect(
      normalizeLocalhostProxyUrl({
        url: "http://localhost/status",
        localhostProxyTemplate: "https://proxy-{{port}}.example.test",
      })
    ).toBe("https://proxy-80.example.test/status");
  });

  test("returns original URL when proxy template parsing fails", () => {
    const originalUrl = "http://localhost:5173/dashboard";

    expect(
      normalizeLocalhostProxyUrl({
        url: originalUrl,
        localhostProxyTemplate: "https://{{port}}.[bad-template",
      })
    ).toBe(originalUrl);
  });

  test("preserves path prefix from path-based proxy template", () => {
    expect(
      normalizeLocalhostProxyUrl({
        url: "http://localhost:3000/foo?x=1#h",
        localhostProxyTemplate: "https://coder.example/proxy/{{port}}/",
      })
    ).toBe("https://coder.example/proxy/3000/foo?x=1#h");
  });

  test("preserves path prefix with root source path", () => {
    expect(
      normalizeLocalhostProxyUrl({
        url: "http://localhost:3000/",
        localhostProxyTemplate: "https://coder.example/proxy/{{port}}/",
      })
    ).toBe("https://coder.example/proxy/3000/");
  });

  test("preserves path prefix from template without trailing slash", () => {
    expect(
      normalizeLocalhostProxyUrl({
        url: "http://localhost:8080/api/v1?debug=true",
        localhostProxyTemplate: "https://coder.example/proxy/{{port}}",
      })
    ).toBe("https://coder.example/proxy/8080/api/v1?debug=true");
  });
});
