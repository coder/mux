import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import {
  ProviderNotConfiguredBanner,
  getUnconfiguredProvider,
} from "./ProviderNotConfiguredBanner";
import type { ProvidersConfigMap } from "@/common/orpc/types";

describe("ProviderNotConfiguredBanner", () => {
  beforeEach(() => {
    globalThis.window = new GlobalWindow() as unknown as Window & typeof globalThis;
    globalThis.document = globalThis.window.document;
  });

  afterEach(() => {
    cleanup();
    globalThis.window = undefined as unknown as Window & typeof globalThis;
    globalThis.document = undefined as unknown as Document;
  });

  test("renders when provider is not configured", () => {
    const onOpenProviders = mock(() => undefined);
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
    };

    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="anthropic:claude-sonnet-4-5"
        providersConfig={config}
        onOpenProviders={onOpenProviders}
      />
    );

    expect(view.getByTestId("provider-not-configured-banner")).toBeTruthy();
    expect(view.getByText("API key required for Anthropic.")).toBeTruthy();
    expect(view.getByText("Providers")).toBeTruthy();

    fireEvent.click(view.getByText("Providers"));
    expect(onOpenProviders).toHaveBeenCalledTimes(1);
  });

  test("renders disabled message when provider is disabled", () => {
    const config: ProvidersConfigMap = {
      openai: { apiKeySet: true, isEnabled: false, isConfigured: true },
    };

    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="openai:gpt-4o"
        providersConfig={config}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.getByTestId("provider-not-configured-banner")).toBeTruthy();
    expect(view.getByText("OpenAI provider is disabled.")).toBeTruthy();
  });

  test("does not render when provider is configured and enabled", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="anthropic:claude-sonnet-4-5"
        providersConfig={config}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("provider-not-configured-banner")).toBeNull();
  });

  test("does not render when config is still loading", () => {
    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="anthropic:claude-sonnet-4-5"
        providersConfig={null}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("provider-not-configured-banner")).toBeNull();
  });

  test("does not render for unknown providers", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };

    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="custom-provider:some-model"
        providersConfig={config}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("provider-not-configured-banner")).toBeNull();
  });

  test("does not render when model is routed through Mux Gateway", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: ["anthropic:claude-sonnet-4-5"],
      },
    };

    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="anthropic:claude-sonnet-4-5"
        providersConfig={config}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.queryByTestId("provider-not-configured-banner")).toBeNull();
  });

  test("renders when model's provider is unsupported by gateway even if gateway is active", () => {
    const config: ProvidersConfigMap = {
      ollama: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: [],
      },
    };

    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="ollama:llama3"
        providersConfig={config}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.getByTestId("provider-not-configured-banner")).toBeTruthy();
  });

  test("renders when gateway is active but model is not enrolled", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: ["openai:gpt-4o"],
      },
    };

    const view = render(
      <ProviderNotConfiguredBanner
        activeModel="anthropic:claude-sonnet-4-5"
        providersConfig={config}
        onOpenProviders={() => undefined}
      />
    );

    expect(view.getByTestId("provider-not-configured-banner")).toBeTruthy();
  });
});

describe("getUnconfiguredProvider", () => {
  test("returns null when config is null", () => {
    expect(getUnconfiguredProvider("anthropic:claude-sonnet-4-5", null)).toBeNull();
  });

  test("returns provider when not configured", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
    };
    expect(getUnconfiguredProvider("anthropic:claude-sonnet-4-5", config)).toBe("anthropic");
  });

  test("returns provider when disabled", () => {
    const config: ProvidersConfigMap = {
      openai: { apiKeySet: true, isEnabled: false, isConfigured: true },
    };
    expect(getUnconfiguredProvider("openai:gpt-4o", config)).toBe("openai");
  });

  test("returns null when configured and enabled", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: true, isEnabled: true, isConfigured: true },
    };
    expect(getUnconfiguredProvider("anthropic:claude-sonnet-4-5", config)).toBeNull();
  });

  test("returns null for model without provider prefix", () => {
    const config: ProvidersConfigMap = {};
    expect(getUnconfiguredProvider("some-model-no-colon", config)).toBeNull();
  });

  test("returns null when gateway routes the model", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: true,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: ["anthropic:claude-sonnet-4-5"],
      },
    };
    expect(getUnconfiguredProvider("anthropic:claude-sonnet-4-5", config)).toBeNull();
  });

  test("returns provider when gateway is disabled", () => {
    const config: ProvidersConfigMap = {
      anthropic: { apiKeySet: false, isEnabled: true, isConfigured: false },
      "mux-gateway": {
        apiKeySet: false,
        isEnabled: false,
        isConfigured: true,
        couponCodeSet: true,
        gatewayModels: ["anthropic:claude-sonnet-4-5"],
      },
    };
    expect(getUnconfiguredProvider("anthropic:claude-sonnet-4-5", config)).toBe("anthropic");
  });
});
