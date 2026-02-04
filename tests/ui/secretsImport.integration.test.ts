/**
 * UI integration tests for the secrets import feature.
 *
 * Tests that secrets can be imported from one project to another via Settings → Projects,
 * and that existing secrets are not overwritten.
 */

import "./dom";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { shouldRunIntegrationTests } from "../testUtils";
import { createTestEnvironment, cleanupTestEnvironment, preloadTestModules } from "../ipc/setup";
import { cleanupTempGitRepo, createTempGitRepo } from "../ipc/helpers";

import { renderApp } from "./renderReviewPanel";
import { cleanupView, setupTestDom } from "./helpers";

const describeIntegration = shouldRunIntegrationTests() ? describe : describe.skip;

describeIntegration("Secrets Import (UI)", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("imports secrets from another project without overwriting existing keys", async () => {
    const env = await createTestEnvironment();
    const sourceRepoPath = await createTempGitRepo();
    const targetRepoPath = await createTempGitRepo();
    const cleanupDom = setupTestDom();

    let view: ReturnType<typeof renderApp> | undefined;

    try {
      // Create source project with secrets
      await env.orpc.projects.create({ projectPath: sourceRepoPath });
      await env.orpc.projects.secrets.update({
        projectPath: sourceRepoPath,
        secrets: [
          { key: "SOURCE_KEY_1", value: "source_value_1" },
          { key: "SHARED_KEY", value: "source_shared_value" },
          { key: "SOURCE_KEY_2", value: "source_value_2" },
        ],
      });

      // Create target project with one existing secret that overlaps
      await env.orpc.projects.create({ projectPath: targetRepoPath });
      await env.orpc.projects.secrets.update({
        projectPath: targetRepoPath,
        secrets: [
          { key: "SHARED_KEY", value: "target_shared_value" }, // This should NOT be overwritten
          { key: "TARGET_KEY_1", value: "target_value_1" },
        ],
      });

      // Render the app
      view = renderApp({ apiClient: env.orpc });
      await view.waitForReady();

      // Wait for the sidebar to show projects
      const targetProjectName = targetRepoPath.split("/").pop()!;
      await waitFor(
        () => {
          const sidebar = view!.container.querySelector('[aria-label="Projects"]');
          if (!sidebar) throw new Error("Project sidebar not found");
          // Check that projects are loaded - look for the project settings button (key icon)
          const settingsButton = view!.container.querySelector(
            `[aria-label="Configure ${targetProjectName}"]`
          );
          if (!settingsButton)
            throw new Error(
              `Project settings button for target project not found: ${targetProjectName}`
            );
        },
        { timeout: 10_000 }
      );

      // Open Settings → Projects for target project by clicking the key icon
      const settingsButton = view!.container.querySelector(
        `[aria-label="Configure ${targetProjectName}"]`
      ) as HTMLElement;
      await userEvent.click(settingsButton);

      // Wait for Settings modal to open - query document.body since Radix uses portals
      await waitFor(
        () => {
          const modal = document.body.querySelector('[role="dialog"]');
          if (!modal) throw new Error("Settings modal not found");
          // Should be in Projects section with Secrets heading
          within(modal as HTMLElement).getByText("Secrets");
        },
        { timeout: 5_000 }
      );

      const modal = document.body.querySelector('[role="dialog"]') as HTMLElement;

      // Verify initial secrets are shown (2 secrets: SHARED_KEY and TARGET_KEY_1)
      await waitFor(
        () => {
          const keyInputs = modal.querySelectorAll('input[placeholder="SECRET_NAME"]');
          expect(keyInputs.length).toBe(2);
        },
        { timeout: 5_000 }
      );

      // Find and use the import control.
      const sourceProjectName = sourceRepoPath.split("/").pop()!;
      let importSelect: HTMLSelectElement | null = null;
      let importTrigger: HTMLElement | null = null;

      await waitFor(
        () => {
          importSelect = within(modal).queryByTestId(
            "project-secrets-import"
          ) as HTMLSelectElement | null;
          if (importSelect) return;
          const importTriggers = modal.querySelectorAll<HTMLElement>('[role="combobox"]');
          importTrigger =
            Array.from(importTriggers).find((el) => el.textContent?.includes("Import")) ?? null;
          if (!importTrigger) {
            throw new Error("Import control not found - other projects may not be loaded yet");
          }
        },
        { timeout: 5_000 }
      );

      if (importSelect) {
        const currentImportSelect = importSelect as HTMLSelectElement;
        let sourceOptionIndex = -1;
        await waitFor(
          () => {
            const options = Array.from(currentImportSelect.options) as HTMLOptionElement[];
            sourceOptionIndex = options.findIndex((option) => option.value === sourceRepoPath);
            if (sourceOptionIndex < 0) {
              throw new Error("Source project not in import options yet");
            }
          },
          { timeout: 5_000 }
        );
        const sourceOption = currentImportSelect.options[sourceOptionIndex];
        // Prefer userEvent for select interaction, with a fireEvent fallback for happy-dom.
        await act(async () => {
          try {
            await userEvent.selectOptions(currentImportSelect, sourceRepoPath);
          } catch (error) {
            sourceOption.selected = true;
            currentImportSelect.value = sourceRepoPath;
            fireEvent.change(currentImportSelect, { target: { value: sourceRepoPath } });
          }
        });
      } else {
        // Note: userEvent.click fails due to happy-dom pointer-events detection, use fireEvent
        fireEvent.click(importTrigger!);

        // Select the source project from dropdown (also in portal)
        await waitFor(
          () => {
            const option = document.body.querySelector(
              `[role="option"][data-value="${sourceRepoPath}"]`
            );
            if (!option) {
              // Fallback: look for option by text content
              const options = document.body.querySelectorAll('[role="option"]');
              const found = Array.from(options).find((opt) =>
                opt.textContent?.includes(sourceProjectName)
              );
              if (!found) {
                throw new Error(`Source project option not found: ${sourceProjectName}`);
              }
            }
          },
          { timeout: 5_000 }
        );

        // Click the source project option
        // Wrap in act() to ensure React state updates are flushed before continuing
        const options = document.body.querySelectorAll('[role="option"]');
        const sourceOption = Array.from(options).find((opt) =>
          opt.textContent?.includes(sourceProjectName)
        ) as HTMLElement;
        await act(async () => {
          fireEvent.click(sourceOption);
          // Small delay to allow async import operation to start
          await new Promise((r) => setTimeout(r, 100));
        });
      }

      // Wait for import to complete - should now have 4 secrets
      // (TARGET_KEY_1, SHARED_KEY from target + SOURCE_KEY_1, SOURCE_KEY_2 from source)
      await waitFor(
        () => {
          const keyInputs = modal.querySelectorAll('input[placeholder="SECRET_NAME"]');
          expect(keyInputs.length).toBe(4);
        },
        { timeout: 20_000 }
      );

      // Verify the keys are correct
      const keyInputs = modal.querySelectorAll(
        'input[placeholder="SECRET_NAME"]'
      ) as NodeListOf<HTMLInputElement>;
      const keys = Array.from(keyInputs).map((input) => input.value);

      // Original target secrets should be first
      expect(keys).toContain("SHARED_KEY");
      expect(keys).toContain("TARGET_KEY_1");
      // Imported secrets added
      expect(keys).toContain("SOURCE_KEY_1");
      expect(keys).toContain("SOURCE_KEY_2");

      // Verify SHARED_KEY was NOT overwritten - find its value input
      const sharedKeyIndex = keys.indexOf("SHARED_KEY");
      const valueInputs = modal.querySelectorAll(
        'input[placeholder="secret value"]'
      ) as NodeListOf<HTMLInputElement>;
      // The value should still be the target's value, not source's
      expect(valueInputs[sharedKeyIndex].value).toBe("target_shared_value");

      // Save changes - there should be a Save button visible since we have unsaved changes
      const saveButton = within(modal).getByText("Save");
      await userEvent.click(saveButton);

      // Wait for save to complete - the Save button disappears when there are no unsaved changes
      await waitFor(
        () => {
          const saveBtn = within(modal).queryByText("Save");
          if (saveBtn) throw new Error("Save button still present, waiting for save to complete");
        },
        { timeout: 5_000 }
      );

      // Verify secrets were saved correctly via API
      const savedSecrets = await env.orpc.projects.secrets.get({ projectPath: targetRepoPath });
      expect(savedSecrets.length).toBe(4);

      const savedKeys = savedSecrets.map((s) => s.key);
      expect(savedKeys).toContain("SHARED_KEY");
      expect(savedKeys).toContain("TARGET_KEY_1");
      expect(savedKeys).toContain("SOURCE_KEY_1");
      expect(savedKeys).toContain("SOURCE_KEY_2");

      // Verify SHARED_KEY value was preserved
      const sharedSecret = savedSecrets.find((s) => s.key === "SHARED_KEY");
      expect(sharedSecret?.value).toBe("target_shared_value");
    } finally {
      if (view) {
        await cleanupView(view, cleanupDom);
      } else {
        cleanupDom();
      }
      await env.orpc.projects.remove({ projectPath: sourceRepoPath });
      await env.orpc.projects.remove({ projectPath: targetRepoPath });
      await cleanupTestEnvironment(env);
      await cleanupTempGitRepo(sourceRepoPath);
      await cleanupTempGitRepo(targetRepoPath);
    }
  }, 60_000);
});
