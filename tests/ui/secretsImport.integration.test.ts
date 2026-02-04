/**
 * UI integration tests for the secrets import feature.
 *
 * Tests that secrets can be imported from one project to another via Settings → Projects,
 * and that existing secrets are not overwritten.
 */

import "./dom";
import { act, waitFor, within } from "@testing-library/react";
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

      await waitFor(
        async () => {
          const sourceSecrets = await env.orpc.projects.secrets.get({
            projectPath: sourceRepoPath,
          });
          expect(sourceSecrets.length).toBe(3);
        },
        { timeout: 5_000 }
      );
      await waitFor(
        async () => {
          const targetSecrets = await env.orpc.projects.secrets.get({
            projectPath: targetRepoPath,
          });
          expect(targetSecrets.length).toBe(2);
        },
        { timeout: 5_000 }
      );

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
      const testWindow = window as typeof window & {
        __muxImportSecrets?: (path: string) => Promise<void>;
        __muxGetSecretsState?: () => Array<{ key: string; value: string }>;
      };
      let importHelper: ((path: string) => Promise<void>) | undefined;

      await waitFor(
        () => {
          importHelper = testWindow.__muxImportSecrets;
          if (!importHelper) {
            throw new Error("Import helper not ready");
          }
        },
        { timeout: 5_000 }
      );

      await act(async () => {
        await importHelper?.(sourceRepoPath);
      });

      // Wait for import to complete - should now have 4 secrets
      // (TARGET_KEY_1, SHARED_KEY from target + SOURCE_KEY_1, SOURCE_KEY_2 from source)
      await waitFor(
        () => {
          const secretsState = testWindow.__muxGetSecretsState?.();
          if (!secretsState) {
            throw new Error("Secrets state helper not ready");
          }
          expect(secretsState.length).toBe(4);
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

      const secretsState = testWindow.__muxGetSecretsState?.();
      if (!secretsState) {
        throw new Error("Secrets state helper not ready");
      }
      await env.orpc.projects.secrets.update({
        projectPath: targetRepoPath,
        secrets: secretsState,
      });

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
