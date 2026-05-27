import { isAllowedEgressUrl } from "./networkEgressPolicy";

describe("isAllowedEgressUrl", () => {
  it("allows Copilot API and GitHub OAuth hosts", () => {
    expect(isAllowedEgressUrl(new URL("https://api.githubcopilot.com/v1/responses"))).toBe(true);
    expect(isAllowedEgressUrl(new URL("https://github.com/login/device/code"))).toBe(true);
  });

  it("allows loopback hosts for local bridge traffic", () => {
    expect(isAllowedEgressUrl(new URL("http://localhost:3000/healthz"))).toBe(true);
    expect(isAllowedEgressUrl(new URL("http://127.0.0.1:3000/healthz"))).toBe(true);
    expect(isAllowedEgressUrl(new URL("http://[::1]:3000/healthz"))).toBe(true);
  });

  it("blocks non-Copilot public egress", () => {
    expect(isAllowedEgressUrl(new URL("https://api.openai.com/v1/chat/completions"))).toBe(false);
    expect(isAllowedEgressUrl(new URL("https://example.com"))).toBe(false);
  });
});
