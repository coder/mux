import { electronTest as test, electronExpect as expect } from "../electronTest";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("Settings Modal", () => {
  test("opens settings modal via gear button", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();

    // Open settings
    await ui.settings.open();

    // Verify modal is open with correct structure
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Verify sidebar sections are present
    await expect(page.getByRole("button", { name: "General", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Providers", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Models", exact: true })).toBeVisible();

    // Verify default section is General (theme toggle visible)
    await expect(page.getByText("Theme", { exact: true })).toBeVisible();
  });

  test("navigates between settings sections", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();

    // Navigate to Providers section
    await ui.settings.selectSection("Providers");
    await expect(page.getByText(/Configure API keys and endpoints/i)).toBeVisible();

    // Navigate to Models section
    await ui.settings.selectSection("Models");
    await expect(page.getByPlaceholder(/model-id/i)).toBeVisible();

    // Navigate back to General
    await ui.settings.selectSection("General");
    await expect(page.getByText("Theme", { exact: true })).toBeVisible();
  });

  test("closes settings with Escape key", async ({ ui }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();

    // Close via Escape
    await ui.settings.close();

    // Verify closed
    await ui.settings.expectClosed();
  });

  test("closes settings with X button", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();

    // Click close button
    const closeButton = page.getByRole("button", { name: /close settings/i });
    await closeButton.click();

    // Verify closed
    await ui.settings.expectClosed();
  });

  test("closes settings by clicking overlay", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();

    // Click overlay (outside modal content) - Radix Dialog uses data-state attribute
    const overlay = page.locator('[data-state="open"].fixed.inset-0');
    await overlay.click({ position: { x: 10, y: 10 }, force: true });

    // Verify closed
    await ui.settings.expectClosed();
  });

  test("expands provider accordion in Providers section", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Expand Anthropic provider
    await ui.settings.expandProvider("Anthropic");

    // Verify accordion content is visible - use exact matches to avoid ambiguity
    await expect(page.getByText("API Key", { exact: true })).toBeVisible();
    await expect(page.getByText(/Base URL/, { exact: false })).toBeVisible();
  });

  test("shows all provider names correctly", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Verify all providers are listed with correct display names
    await expect(page.getByRole("button", { name: /Anthropic/i })).toBeVisible();
    await expect(
      page.getByRole("button", { name: /OpenAI/i }).filter({ has: page.getByText("OpenAI icon") })
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /xAI/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Ollama/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /OpenRouter/i })).toBeVisible();
  });

  test("Models section shows add form", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Models");

    // Verify add model form elements
    await expect(page.getByText("Custom Models")).toBeVisible();
    await expect(page.getByRole("combobox")).toBeVisible(); // Provider dropdown
    await expect(page.getByPlaceholder(/model-id/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /^Add$/i })).toBeVisible();
  });

  test("provider settings updates propagate without reload", async ({ ui, page }) => {
    await ui.projects.openFirstWorkspace();
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Expand OpenAI provider - use the specific button with OpenAI icon
    const openaiButton = page
      .getByRole("button", { name: /OpenAI/i })
      .filter({ has: page.getByText("OpenAI icon") });
    await expect(openaiButton).toBeVisible();
    await openaiButton.click();

    // Wait for the provider section to expand - API Key label should be visible
    await expect(page.getByText("API Key", { exact: true })).toBeVisible();

    // Verify API key is not set initially (shows "Not set")
    await expect(page.getByText("Not set").first()).toBeVisible();

    // Click "Set" to enter edit mode - it's a text link, not a button role
    const setLink = page.getByText("Set", { exact: true }).first();
    await setLink.click();

    // The password input should appear with autofocus
    const apiKeyInput = page.locator('input[type="password"]');
    await expect(apiKeyInput).toBeVisible();
    await apiKeyInput.fill("sk-test-key-12345");

    // Save by pressing Enter (the input has onKeyDown handler for Enter)
    await page.keyboard.press("Enter");

    // Verify the field now shows as set (masked value)
    await expect(page.getByText("••••••••")).toBeVisible();

    // Close settings
    await ui.settings.close();

    // Re-open settings and verify the change persisted without reload
    await ui.settings.open();
    await ui.settings.selectSection("Providers");

    // Expand OpenAI again
    await openaiButton.click();
    await expect(page.getByText("API Key", { exact: true })).toBeVisible();

    // The API key should still show as set
    await expect(page.getByText("••••••••")).toBeVisible();

    // The provider should show as configured (green indicator dot)
    const configuredIndicator = openaiButton.locator(".bg-green-500");
    await expect(configuredIndicator).toBeVisible();
  });
});
