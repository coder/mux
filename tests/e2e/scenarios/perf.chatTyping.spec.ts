import { electronTest as test, electronExpect as expect } from "../electronTest";
import { seedWorkspaceHistoryProfile } from "../utils/historyFixture";
import {
  readReactProfileSnapshot,
  resetReactProfileSamples,
  withChromeProfiles,
  writePerfArtifacts,
} from "../utils/perfProfile";

const shouldRunPerfScenarios = process.env.MUX_E2E_RUN_PERF === "1";

const TYPING_SAMPLE =
  "Diagnose typing latency in a large chat transcript while keeping input responsive.";

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Electron scenario runs on chromium only"
);

test.describe("chat typing performance profiling", () => {
  test.skip(!shouldRunPerfScenarios, "Set MUX_E2E_RUN_PERF=1 to run perf profiling scenarios");

  test("perf: type in composer with large chat history", async ({
    page,
    ui,
    workspace,
  }, testInfo) => {
    const historySummary = await seedWorkspaceHistoryProfile({
      demoProject: workspace.demoProject,
      profile: "large",
    });

    await ui.projects.openFirstWorkspace();
    await expect(page.getByTestId("message-window")).toHaveAttribute("data-loaded", "true", {
      timeout: 20_000,
    });

    const input = page.getByRole("textbox", { name: "Message Claude" });
    await expect(input).toBeVisible({ timeout: 20_000 });
    await input.fill("");

    await resetReactProfileSamples(page);

    const runLabel = "chat-typing-large-history";
    const chromeProfile = await withChromeProfiles(page, { label: runLabel }, async () => {
      await input.click();
      await input.pressSequentially(TYPING_SAMPLE, { delay: 0 });
      await expect(input).toHaveValue(TYPING_SAMPLE);
    });

    const reactProfileSnapshot = await readReactProfileSnapshot(page);
    if (!reactProfileSnapshot) {
      throw new Error("React profile snapshot was not captured");
    }

    const artifactDirectory = await writePerfArtifacts({
      testInfo,
      runLabel,
      chromeProfile,
      reactProfile: reactProfileSnapshot,
      historyProfile: historySummary,
    });

    // The composer owns draft text locally; typing must not re-render the large transcript.
    expect(reactProfileSnapshot.byProfilerId["chat-pane.transcript"]?.sampleCount ?? 0).toBe(0);
    expect(chromeProfile.wallTimeMs).toBeLessThan(2_500);
    expect(chromeProfile.cpuProfile).not.toBeNull();
    expect(reactProfileSnapshot.enabled).toBe(true);

    testInfo.annotations.push({
      type: "perf-artifact",
      description: artifactDirectory,
    });
  });
});
