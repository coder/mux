import { describe, expect, test } from "bun:test";
import {
  normalizeDomain,
  getOauthUrls,
  getCopilotApiBaseUrl,
  shouldUseCopilotResponsesApi,
  detectCopilotRequestContext,
} from "./copilotHelpers";

describe("normalizeDomain", () => {
  test("strips https:// prefix", () => {
    expect(normalizeDomain("https://github.mycompany.com")).toBe("github.mycompany.com");
  });

  test("strips http:// prefix", () => {
    expect(normalizeDomain("http://github.mycompany.com")).toBe("github.mycompany.com");
  });

  test("strips trailing slash", () => {
    expect(normalizeDomain("github.mycompany.com/")).toBe("github.mycompany.com");
  });

  test("strips protocol and trailing slash together", () => {
    expect(normalizeDomain("https://github.mycompany.com/")).toBe("github.mycompany.com");
  });

  test("passes through bare domain", () => {
    expect(normalizeDomain("github.mycompany.com")).toBe("github.mycompany.com");
  });
});

describe("getOauthUrls", () => {
  test("returns github.com URLs for default domain", () => {
    const urls = getOauthUrls("github.com");
    expect(urls.deviceCodeUrl).toBe("https://github.com/login/device/code");
    expect(urls.accessTokenUrl).toBe("https://github.com/login/oauth/access_token");
  });

  test("returns enterprise URLs for custom domain", () => {
    const urls = getOauthUrls("github.mycompany.com");
    expect(urls.deviceCodeUrl).toBe("https://github.mycompany.com/login/device/code");
    expect(urls.accessTokenUrl).toBe("https://github.mycompany.com/login/oauth/access_token");
  });
});

describe("getCopilotApiBaseUrl", () => {
  test("returns public API URL when no domain", () => {
    expect(getCopilotApiBaseUrl()).toBe("https://api.githubcopilot.com");
  });

  test("returns public API URL for github.com", () => {
    expect(getCopilotApiBaseUrl("github.com")).toBe("https://api.githubcopilot.com");
  });

  test("returns copilot-api.{domain} for enterprise", () => {
    expect(getCopilotApiBaseUrl("github.mycompany.com")).toBe(
      "https://copilot-api.github.mycompany.com"
    );
  });
});

describe("shouldUseCopilotResponsesApi", () => {
  test("returns true for gpt-5", () => {
    expect(shouldUseCopilotResponsesApi("gpt-5")).toBe(true);
  });

  test("returns true for gpt-5.2", () => {
    expect(shouldUseCopilotResponsesApi("gpt-5.2")).toBe(true);
  });

  test("returns false for gpt-5-mini", () => {
    expect(shouldUseCopilotResponsesApi("gpt-5-mini")).toBe(false);
  });

  test("returns false for gpt-4o", () => {
    expect(shouldUseCopilotResponsesApi("gpt-4o")).toBe(false);
  });

  test("returns false for claude-sonnet-4.5", () => {
    expect(shouldUseCopilotResponsesApi("claude-sonnet-4.5")).toBe(false);
  });

  test("returns true for gpt-6", () => {
    expect(shouldUseCopilotResponsesApi("gpt-6")).toBe(true);
  });
});

describe("detectCopilotRequestContext", () => {
  test("detects user-initiated chat completion", () => {
    const body = JSON.stringify({
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hello" },
      ],
    });
    const result = detectCopilotRequestContext(body);
    expect(result.isAgent).toBe(false);
    expect(result.hasVision).toBe(false);
  });

  test("detects agent-initiated chat completion", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
    });
    const result = detectCopilotRequestContext(body);
    expect(result.isAgent).toBe(true);
    expect(result.hasVision).toBe(false);
  });

  test("detects user-initiated responses API", () => {
    const body = JSON.stringify({
      input: [{ role: "user", content: "Hello" }],
    });
    const result = detectCopilotRequestContext(body);
    expect(result.isAgent).toBe(false);
    expect(result.hasVision).toBe(false);
  });

  test("detects vision in chat completions (image_url)", () => {
    const body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What's in this image?" },
            { type: "image_url", image_url: { url: "https://example.com/img.png" } },
          ],
        },
      ],
    });
    const result = detectCopilotRequestContext(body);
    expect(result.isAgent).toBe(false);
    expect(result.hasVision).toBe(true);
  });

  test("detects vision in responses API (input_image)", () => {
    const body = JSON.stringify({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Describe this" },
            { type: "input_image", image_url: "https://example.com/img.png" },
          ],
        },
      ],
    });
    const result = detectCopilotRequestContext(body);
    expect(result.isAgent).toBe(false);
    expect(result.hasVision).toBe(true);
  });

  test("returns defaults for non-JSON body", () => {
    const result = detectCopilotRequestContext("not json");
    expect(result.isAgent).toBe(false);
    expect(result.hasVision).toBe(false);
  });

  test("returns defaults for null body", () => {
    const result = detectCopilotRequestContext(null);
    expect(result.isAgent).toBe(false);
    expect(result.hasVision).toBe(false);
  });

  test("detects tool-role as agent-initiated", () => {
    const body = JSON.stringify({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Let me check." },
        { role: "tool", content: "result data" },
      ],
    });
    const result = detectCopilotRequestContext(body);
    expect(result.isAgent).toBe(true);
  });
});
