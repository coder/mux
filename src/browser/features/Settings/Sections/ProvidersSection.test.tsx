import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { installDom } from "../../../../../tests/ui/dom";
import type { APIClient } from "@/browser/contexts/API";
import type {
  AddCustomOpenAICompatibleProviderInput,
  ProviderConfigInfo,
  ProvidersConfigMap,
} from "@/common/orpc/types";

let repairRemovedProviderMock = mock(
  (_provider: string, _workspaceIds: Iterable<string>) => undefined
);

void mock.module("@/browser/utils/modelPreferenceRepair", () => ({
  repairLocalModelPreferencesForRemovedProvider: (
    provider: string,
    workspaceIds: Iterable<string>
  ) => repairRemovedProviderMock(provider, workspaceIds),
}));

import { ProvidersSection } from "./ProvidersSection";
import { SettingsSectionStory, setupSettingsStory } from "./settingsStoryUtils";

const CUSTOM_PROVIDER_ID = "acme-openai";

function createProvidersConfig(): ProvidersConfigMap {
  return {
    openai: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
    },
    [CUSTOM_PROVIDER_ID]: {
      apiKeySet: true,
      isEnabled: true,
      isConfigured: true,
      baseUrl: "https://api.acme.test/v1",
      displayName: "Acme OpenAI",
      isCustom: true,
      providerType: "openai-compatible",
      models: ["acme-chat"],
    },
  };
}

function emptyConfigChangeIterator(): AsyncIterator<void> & AsyncIterable<void> {
  const iterator: AsyncIterator<void> & AsyncIterable<void> = {
    next: () => new Promise<IteratorResult<void>>(() => undefined),
    return: () => Promise.resolve({ done: true, value: undefined }),
    [Symbol.asyncIterator]: () => iterator,
  };
  return iterator;
}

function patchProviderMethods(client: APIClient, providersConfig: ProvidersConfigMap) {
  const getConfig = mock(() => Promise.resolve({ ...providersConfig }));
  const addCustomOpenAICompatibleProvider = mock(
    (input: AddCustomOpenAICompatibleProviderInput) => {
      const providerInfo: ProviderConfigInfo = {
        apiKeySet: input.apiKey != null,
        isEnabled: true,
        isConfigured: true,
        apiKeyFile: input.apiKeyFile,
        baseUrl: input.baseUrl,
        displayName: input.displayName ?? input.provider,
        isCustom: true,
        providerType: "openai-compatible",
        models: input.models,
      };
      providersConfig[input.provider] = providerInfo;
      return Promise.resolve({ success: true as const, data: providerInfo });
    }
  );
  const removeCustomProvider = mock((input: { provider: string }) => {
    delete providersConfig[input.provider];
    return Promise.resolve({ success: true as const, data: undefined });
  });
  const onConfigChanged = mock(() => Promise.resolve(emptyConfigChangeIterator()));

  Object.assign(client.providers, {
    getConfig,
    addCustomOpenAICompatibleProvider,
    removeCustomProvider,
    onConfigChanged,
  });

  return {
    addCustomOpenAICompatibleProvider,
    getConfig,
    removeCustomProvider,
  };
}

function renderProvidersSection() {
  const providersConfig = createProvidersConfig();
  const client = setupSettingsStory({ providersConfig: {} });
  const providerMocks = patchProviderMethods(client, providersConfig);
  const view = render(
    <SettingsSectionStory setup={() => client}>
      <ProvidersSection />
    </SettingsSectionStory>
  );

  return { ...view, ...providerMocks, providersConfig };
}

function getProviderCard(button: HTMLElement): HTMLElement {
  const card = button.parentElement;
  if (!card) {
    throw new Error("Provider button was not rendered inside a card");
  }
  return card;
}

describe("ProvidersSection", () => {
  let restoreDom: (() => void) | null = null;

  beforeEach(() => {
    restoreDom = installDom();
    repairRemovedProviderMock = mock(
      (_provider: string, _workspaceIds: Iterable<string>) => undefined
    );
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    restoreDom?.();
    restoreDom = null;
  });

  test("renders built-in and custom providers in separate groups", async () => {
    const view = renderProvidersSection();

    const directHeading = await view.findByText("Direct Providers");
    const customHeading = await view.findByText("Custom providers");

    expect(directHeading.parentElement?.textContent).toContain("OpenAI");
    expect(customHeading.parentElement?.textContent).toContain("Acme OpenAI");
  });

  test("renders a custom provider display name with fallback icon support", async () => {
    const view = renderProvidersSection();

    expect(await view.findByRole("button", { name: /Acme OpenAI/ })).toBeTruthy();
  });

  test("shows OpenAI-compatible custom provider fields when expanded", async () => {
    const view = renderProvidersSection();
    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });

    fireEvent.click(customButton);

    const customCard = getProviderCard(customButton);
    expect(within(customCard).getByText("Display name")).toBeTruthy();
    expect(within(customCard).getByText("API key")).toBeTruthy();
    expect(within(customCard).getByText("API key file")).toBeTruthy();
    expect(within(customCard).getByText("Base URL")).toBeTruthy();
  });

  test("validates custom provider IDs in the add form", async () => {
    const view = renderProvidersSection();

    fireEvent.click(await view.findByRole("button", { name: "Add provider" }));

    expect(await view.findByText("Custom provider id is required.")).toBeTruthy();

    const providerIdInput = view.getByPlaceholderText("acme-openai") as HTMLInputElement;
    await userEvent.type(providerIdInput, "openai");

    await waitFor(() => {
      expect(providerIdInput.value).toBe("openai");
      expect(
        view.getByText('Custom provider id "openai" conflicts with a built-in provider.')
      ).toBeTruthy();
    });
  });

  test("shows remove only for expanded custom provider cards", async () => {
    const view = renderProvidersSection();
    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });

    fireEvent.click(customButton);
    expect(
      within(getProviderCard(customButton)).getByRole("button", { name: "Remove" })
    ).toBeTruthy();

    const openAiButton = view.getByRole("button", { name: /^OpenAI$/ });
    fireEvent.click(openAiButton);
    expect(
      within(getProviderCard(openAiButton)).queryByRole("button", { name: "Remove" })
    ).toBeNull();
  });

  test("calls the custom provider remove mutation after confirmation", async () => {
    const view = renderProvidersSection();
    const confirmMock = mock(() => true);
    window.confirm = confirmMock;

    const customButton = await view.findByRole("button", { name: /Acme OpenAI/ });
    fireEvent.click(customButton);
    fireEvent.click(within(getProviderCard(customButton)).getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(view.removeCustomProvider).toHaveBeenCalledWith({ provider: CUSTOM_PROVIDER_ID });
    });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(repairRemovedProviderMock).toHaveBeenCalledWith(CUSTOM_PROVIDER_ID, expect.any(Set));
  });
});
