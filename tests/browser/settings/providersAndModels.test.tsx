/**
 * UI integration tests for Settings.
 */

import { within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { shouldRunIntegrationTests } from "../../testUtils";
import { renderWithBackend, waitForAppLoad, openSettingsToSection } from "../harness";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Settings", () => {
  test("Providers: can set OpenAI API key and base URL", async () => {
    const user = userEvent.setup();

    const { cleanup, ...queries } = await renderWithBackend();
    try {
      await waitForAppLoad(queries);

      const modal = await openSettingsToSection(user, queries, "Providers");

      const openaiButton = await within(modal).findByRole("button", {
        name: /openai/i,
      });
      await user.click(openaiButton);

      const apiKeyLabel = await within(modal).findByText("API Key");
      const apiKeyField = apiKeyLabel.parentElement as HTMLElement;
      await user.click(within(apiKeyField).getByRole("button", { name: /set|change/i }));
      const apiKeyInput = within(apiKeyField).getByPlaceholderText(/enter api key/i);
      await user.type(apiKeyInput, "test-api-key{enter}");

      const baseUrlLabel = await within(modal).findByText("Base URL");
      const baseUrlField = baseUrlLabel.parentElement as HTMLElement;
      await user.click(within(baseUrlField).getByRole("button", { name: /set|change/i }));
      const baseUrlInput = within(baseUrlField).getByRole("textbox");
      await user.type(baseUrlInput, "https://custom.openai.com/v1{enter}");

      await waitFor(() => {
        expect(openaiButton.querySelector('[title="Configured"]')).toBeTruthy();
      });

      expect(within(apiKeyField).getByText("••••••••")).toBeInTheDocument();
      expect(within(baseUrlField).getByText("https://custom.openai.com/v1")).toBeInTheDocument();
    } finally {
      await cleanup();
    }
  });

  test("Models: can add a custom model", async () => {
    const user = userEvent.setup();

    const { cleanup, ...queries } = await renderWithBackend();
    try {
      await waitForAppLoad(queries);

      const modal = await openSettingsToSection(user, queries, "Models");

      // Wait for the form to load.
      await within(modal).findByPlaceholderText("model-id");

      // Click the provider select trigger (placeholder value: "Provider").
      const providerValue = within(modal).getByText("Provider");
      const providerTrigger = providerValue.closest("button");
      expect(providerTrigger).toBeTruthy();
      await user.click(providerTrigger!);

      // Select content is rendered in a portal.
      const openaiOption = await queries.findByRole("option", { name: "OpenAI" });
      await user.click(openaiOption);

      const modelIdInput = await within(modal).findByPlaceholderText("model-id");
      await user.type(modelIdInput, "my-custom-model-123");

      const addButton = within(modal).getByRole("button", { name: /^add$/i });
      await user.click(addButton);

      await waitFor(() => {
        expect(within(modal).getByText("my-custom-model-123")).toBeInTheDocument();
      });
    } finally {
      await cleanup();
    }
  });
});
