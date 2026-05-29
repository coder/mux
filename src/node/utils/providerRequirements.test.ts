import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import type { ProvidersConfig } from "@/node/config";
import {
  hasAnyConfiguredProvider,
  isProviderAutoRouteEligible,
  resolveCustomProviderCredentials,
  resolveProviderCredentials,
} from "./providerRequirements";

describe("isProviderAutoRouteEligible", () => {
  it("returns false for bedrock when only a region is configured", () => {
    expect(isProviderAutoRouteEligible("bedrock", { region: "us-east-1" }, {})).toBe(false);
  });

  it("returns true for bedrock when config includes a credential pair", () => {
    expect(
      isProviderAutoRouteEligible(
        "bedrock",
        { region: "us-east-1", accessKeyId: "x", secretAccessKey: "y" },
        {}
      )
    ).toBe(true);
  });

  it("returns false for bedrock when env only exposes a region", () => {
    expect(isProviderAutoRouteEligible("bedrock", {}, { AWS_REGION: "us-east-1" })).toBe(false);
  });

  it("returns true for bedrock when env exposes region and credential pair", () => {
    expect(
      isProviderAutoRouteEligible(
        "bedrock",
        {},
        {
          AWS_REGION: "us-east-1",
          AWS_ACCESS_KEY_ID: "x",
          AWS_SECRET_ACCESS_KEY: "y",
        }
      )
    ).toBe(true);
  });

  it("returns false for disabled non-bedrock providers even when configured", () => {
    expect(
      isProviderAutoRouteEligible("mux-gateway", { couponCode: "x", enabled: false }, {})
    ).toBe(false);
  });

  it("returns true for non-bedrock providers when enabled is omitted", () => {
    expect(isProviderAutoRouteEligible("mux-gateway", { couponCode: "x" }, {})).toBe(true);
  });

  it("returns true for non-bedrock providers when explicitly enabled", () => {
    expect(isProviderAutoRouteEligible("mux-gateway", { couponCode: "x", enabled: true }, {})).toBe(
      true
    );
  });
});

describe("hasAnyConfiguredProvider", () => {
  it("returns false for null or empty config", () => {
    expect(hasAnyConfiguredProvider(null)).toBe(false);
    expect(hasAnyConfiguredProvider({})).toBe(false);
  });

  it("returns true when a provider has an API key", () => {
    const providers: ProvidersConfig = {
      anthropic: { apiKey: "sk-ant-test" },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
  });

  it("returns true for OpenAI Codex OAuth-only configuration", () => {
    const providers: ProvidersConfig = {
      openai: {
        codexOauth: {
          type: "oauth",
          access: "test-access-token",
          refresh: "test-refresh-token",
          expires: Date.now() + 60_000,
          accountId: "acct_123",
        },
      },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
  });

  it("returns true for keyless providers with explicit config", () => {
    const providers: ProvidersConfig = {
      ollama: {
        baseUrl: "http://localhost:11434/api",
      },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
  });

  it("returns true for keyless providers with legacy baseURL config", () => {
    const providers: ProvidersConfig = {
      ollama: {
        baseURL: "http://localhost:11434/api",
      },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
    expect(resolveProviderCredentials("ollama", providers.ollama ?? {}, {}).isConfigured).toBe(
      true
    );
  });

  it("returns true for enabled custom OpenAI-compatible providers with only a base URL", () => {
    const providers: ProvidersConfig = {
      "local-vllm": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
      },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(true);
  });

  it("returns false for disabled custom OpenAI-compatible providers", () => {
    const providers: ProvidersConfig = {
      "local-vllm": {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
        enabled: false,
      },
    };

    expect(hasAnyConfiguredProvider(providers)).toBe(false);
  });
});

describe("resolveProviderCredentials base URL source", () => {
  it("marks OpenAI base URL from OPENAI_BASE_URL as env sourced", () => {
    const result = resolveProviderCredentials(
      "openai",
      {},
      { OPENAI_API_KEY: "sk-from-env", OPENAI_BASE_URL: "https://env.openai.test" }
    );

    expect(result.isConfigured).toBe(true);
    expect(result.apiKeySource).toBe("env");
    expect(result.baseUrl).toBe("https://env.openai.test");
    expect(result.baseUrlSource).toBe("env");
  });

  it("marks Anthropic base URL from ANTHROPIC_BASE_URL as env sourced", () => {
    const result = resolveProviderCredentials(
      "anthropic",
      {},
      { ANTHROPIC_API_KEY: "sk-ant-env", ANTHROPIC_BASE_URL: "https://env.anthropic.test" }
    );

    expect(result.isConfigured).toBe(true);
    expect(result.apiKeySource).toBe("env");
    expect(result.baseUrl).toBe("https://env.anthropic.test");
    expect(result.baseUrlSource).toBe("env");
  });

  it("marks baseUrl from config as config sourced", () => {
    const result = resolveProviderCredentials(
      "openai",
      { apiKey: "sk-from-config", baseUrl: "https://config.openai.test" },
      { OPENAI_BASE_URL: "https://env.openai.test" }
    );

    expect(result.apiKeySource).toBe("config");
    expect(result.baseUrl).toBe("https://config.openai.test");
    expect(result.baseUrlSource).toBe("config");
  });

  it("marks baseURL from config as config sourced", () => {
    const result = resolveProviderCredentials(
      "anthropic",
      { apiKey: "sk-ant-config", baseURL: "https://config.anthropic.test" },
      { ANTHROPIC_BASE_URL: "https://env.anthropic.test" }
    );

    expect(result.apiKeySource).toBe("config");
    expect(result.baseUrl).toBe("https://config.anthropic.test");
    expect(result.baseUrlSource).toBe("config");
  });

  it("prefers canonical baseUrl over legacy baseURL when both are set", () => {
    const result = resolveProviderCredentials(
      "openai",
      {
        apiKey: "sk-from-config",
        baseUrl: "https://canonical.openai.test",
        baseURL: "https://legacy.openai.test",
      },
      {}
    );

    expect(result.baseUrl).toBe("https://canonical.openai.test");
    expect(result.baseUrlResolved).toBe("https://canonical.openai.test");
    expect(result.baseUrlSource).toBe("config");
  });

  it("keeps config base URL ahead of env base URL", () => {
    const result = resolveProviderCredentials(
      "openai",
      { apiKey: "sk-from-config", baseUrl: "https://config.openai.test" },
      { OPENAI_BASE_URL: "https://env.openai.test" }
    );

    expect(result.baseUrl).toBe("https://config.openai.test");
    expect(result.baseUrlSource).toBe("config");
  });

  it("keeps OPENAI_BASE_URL ahead of OPENAI_API_BASE", () => {
    const result = resolveProviderCredentials(
      "openai",
      {},
      {
        OPENAI_API_KEY: "sk-from-env",
        OPENAI_BASE_URL: "https://openai-base-url.test",
        OPENAI_API_BASE: "https://openai-api-base.test",
      }
    );

    expect(result.baseUrl).toBe("https://openai-base-url.test");
    expect(result.baseUrlSource).toBe("env");
  });

  it("returns base URL metadata even when API key is missing", () => {
    const result = resolveProviderCredentials(
      "openai",
      {},
      { OPENAI_BASE_URL: "https://env.openai.test" }
    );

    expect(result.isConfigured).toBe(false);
    expect(result.missingRequirement).toBe("api_key");
    expect(result.apiKeySource).toBeUndefined();
    expect(result.baseUrl).toBeUndefined();
    expect(result.baseUrlResolved).toBe("https://env.openai.test");
    expect(result.baseUrlSource).toBe("env");
  });
});

describe("resolveCustomProviderCredentials", () => {
  it("succeeds with no API key when only baseUrl is set", async () => {
    const result = await resolveCustomProviderCredentials("local-vllm", {
      providerType: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
    });

    expect(result).toEqual({
      ok: true,
      baseURL: "http://localhost:8000/v1",
      resolvedFrom: "none",
    });
  });

  it("returns a typed missing_base_url error without a base URL", async () => {
    const result = await resolveCustomProviderCredentials("local-vllm", {
      providerType: "openai-compatible",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "missing_base_url", providerId: "local-vllm" });
    }
  });

  it("resolves inline apiKey from config", async () => {
    const result = await resolveCustomProviderCredentials("local-vllm", {
      providerType: "openai-compatible",
      baseUrl: "http://localhost:8000/v1",
      apiKey: "sk-test",
    });

    expect(result).toEqual({
      ok: true,
      apiKey: "sk-test",
      baseURL: "http://localhost:8000/v1",
      resolvedFrom: "inline",
    });
  });

  it("resolves apiKeyFile", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "mux-test-"));
    const keyFilePath = path.join(tmpDir, "api-key");
    writeFileSync(keyFilePath, "sk-from-file\n", "utf-8");

    try {
      const result = await resolveCustomProviderCredentials("local-vllm", {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
        apiKeyFile: keyFilePath,
      });

      expect(result).toEqual({
        ok: true,
        apiKey: "sk-from-file",
        baseURL: "http://localhost:8000/v1",
        resolvedFrom: "file",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("resolves op references with the provided resolver", async () => {
    const opRef = "op://Personal/Local vLLM/api-key";
    const result = await resolveCustomProviderCredentials(
      "local-vllm",
      {
        providerType: "openai-compatible",
        baseUrl: "http://localhost:8000/v1",
        apiKey: opRef,
      },
      (ref) => Promise.resolve(ref === opRef ? "sk-from-op" : undefined)
    );

    expect(result).toEqual({
      ok: true,
      apiKey: "sk-from-op",
      baseURL: "http://localhost:8000/v1",
      resolvedFrom: "op",
    });
  });
});
describe("resolveProviderCredentials - apiKeyFile", () => {
  let tmpDir: string;
  let keyFilePath: string;

  function setup(content: string) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "mux-test-"));
    keyFilePath = path.join(tmpDir, "api-key");
    writeFileSync(keyFilePath, content, "utf-8");
  }

  function cleanup() {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }

  it("resolves apiKeyFile when apiKey is not set", () => {
    setup("sk-from-file");
    try {
      const result = resolveProviderCredentials("anthropic", { apiKeyFile: keyFilePath }, {});
      expect(result.isConfigured).toBe(true);
      expect(result.apiKey).toBe("sk-from-file");
    } finally {
      cleanup();
    }
  });

  it("apiKey takes precedence over apiKeyFile", () => {
    setup("sk-from-file");
    try {
      const result = resolveProviderCredentials(
        "anthropic",
        { apiKey: "sk-from-config", apiKeyFile: keyFilePath },
        {}
      );
      expect(result.apiKey).toBe("sk-from-config");
    } finally {
      cleanup();
    }
  });

  it("apiKeyFile takes precedence over env vars", () => {
    setup("sk-from-file");
    try {
      const result = resolveProviderCredentials(
        "anthropic",
        { apiKeyFile: keyFilePath },
        { ANTHROPIC_API_KEY: "sk-from-env" }
      );
      expect(result.apiKey).toBe("sk-from-file");
    } finally {
      cleanup();
    }
  });

  it("falls back to env vars when apiKeyFile does not exist", () => {
    const result = resolveProviderCredentials(
      "anthropic",
      { apiKeyFile: "/nonexistent/path/key" },
      { ANTHROPIC_API_KEY: "sk-from-env" }
    );
    expect(result.apiKey).toBe("sk-from-env");
  });

  it("falls back to env vars when file is empty", () => {
    setup("");
    try {
      const result = resolveProviderCredentials(
        "anthropic",
        { apiKeyFile: keyFilePath },
        { ANTHROPIC_API_KEY: "sk-from-env" }
      );
      expect(result.apiKey).toBe("sk-from-env");
    } finally {
      cleanup();
    }
  });

  it("supports ~ expansion for home directory", () => {
    const uniqueName = `.mux-test-api-key-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const homeKeyFile = path.join(os.homedir(), uniqueName);
    writeFileSync(homeKeyFile, "sk-from-home", "utf-8");
    try {
      const result = resolveProviderCredentials("anthropic", { apiKeyFile: `~/${uniqueName}` }, {});
      expect(result.isConfigured).toBe(true);
      expect(result.apiKey).toBe("sk-from-home");
    } finally {
      rmSync(homeKeyFile, { force: true });
    }
  });
});
