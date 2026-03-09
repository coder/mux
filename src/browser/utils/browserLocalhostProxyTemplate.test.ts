import { describe, expect, test } from "bun:test";
import { resolveBrowserLocalhostProxyTemplate } from "./browserLocalhostProxyTemplate";

describe("resolveBrowserLocalhostProxyTemplate", () => {
  test("prefers injected template when provided", () => {
    expect(
      resolveBrowserLocalhostProxyTemplate({
        injectedTemplate: "  https://proxy-{{port}}.example.test  ",
        browserProtocol: "https:",
        browserHostname: "5173--dev--alice--apps.example.test",
      })
    ).toBe("https://proxy-{{port}}.example.test");
  });

  test("derives coder-style template from browser host when injected template is missing", () => {
    expect(
      resolveBrowserLocalhostProxyTemplate({
        browserProtocol: "https:",
        browserHostname: "5173--dev--pog2--ethan--apps.sydney.fly.dev.coder.com",
      })
    ).toBe("https://{{port}}--dev--pog2--ethan--apps.sydney.fly.dev.coder.com");
  });

  test("preserves browser port in derived template", () => {
    expect(
      resolveBrowserLocalhostProxyTemplate({
        browserProtocol: "http:",
        browserHostname: "5173--dev--pog2--ethan--apps.sydney.fly.dev.coder.com",
        browserPort: "8443",
      })
    ).toBe("http://{{port}}--dev--pog2--ethan--apps.sydney.fly.dev.coder.com:8443");
  });

  test("returns null for non-coder hostnames", () => {
    expect(
      resolveBrowserLocalhostProxyTemplate({
        browserProtocol: "https:",
        browserHostname: "apps.sydney.fly.dev.coder.com",
      })
    ).toBeNull();
  });

  test("returns null for non-http browser protocols", () => {
    expect(
      resolveBrowserLocalhostProxyTemplate({
        browserProtocol: "file:",
        browserHostname: "5173--dev--pog2--ethan--apps.sydney.fly.dev.coder.com",
      })
    ).toBeNull();
  });
});
