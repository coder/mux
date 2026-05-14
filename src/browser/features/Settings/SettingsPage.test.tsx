import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { ThemeProvider } from "@/browser/contexts/ThemeContext";
import { installDom } from "../../../../tests/ui/dom";

let activeSection = "general";
let setActiveSection = mock((section: string, _options?: { replace?: boolean }) => {
  activeSection = section;
});
const close = mock(() => undefined);
const toggleLeftSidebar = mock(() => undefined);

void mock.module("@/browser/contexts/SettingsContext", () => ({
  useSettings: () => ({
    close,
    activeSection,
    setActiveSection,
  }),
}));

void mock.module("@/browser/features/SplashScreens/SplashScreenProvider", () => ({
  useOnboardingPause: () => ({ paused: false }),
}));

const apiMethod = mock(() => Promise.resolve({}));

function createApiSection() {
  return new Proxy(
    {},
    {
      get: () => apiMethod,
    }
  );
}

void mock.module("@/browser/contexts/API", () => ({
  useAPI: () => ({
    api: {
      config: createApiSection(),
      providers: createApiSection(),
      general: createApiSection(),
      server: createApiSection(),
      projects: createApiSection(),
    },
    status: "connected" as const,
    error: null,
    authenticate: () => undefined,
    retry: () => undefined,
  }),
}));

void mock.module("@/browser/hooks/useExperiments", () => ({
  useExperimentValue: () => true,
}));

import { SettingsPage } from "./SettingsPage";

function renderSettingsPage() {
  return render(
    <ThemeProvider forcedTheme="dark">
      <SettingsPage leftSidebarCollapsed={false} onToggleLeftSidebarCollapsed={toggleLeftSidebar} />
    </ThemeProvider>
  );
}

describe("SettingsPage", () => {
  let cleanupDom: (() => void) | null = null;

  beforeEach(() => {
    cleanupDom = installDom();
    activeSection = "general";
    setActiveSection = mock((section: string, _options?: { replace?: boolean }) => {
      activeSection = section;
    });
  });

  afterEach(() => {
    cleanup();
    mock.restore();
    cleanupDom?.();
    cleanupDom = null;
  });

  test("keeps Goals and Heartbeat out of settings navigation when their experiments are enabled", () => {
    const view = renderSettingsPage();

    expect(view.queryByRole("button", { name: "Goals" })).toBeNull();
    expect(view.queryByRole("button", { name: "Heartbeat" })).toBeNull();
    expect(view.getAllByRole("button", { name: "Experiments" }).length).toBeGreaterThan(0);
  });

  test("normalizes stale Goals and Heartbeat routes to Experiments", async () => {
    activeSection = "goals";
    const view = renderSettingsPage();

    await waitFor(() => {
      expect(setActiveSection).toHaveBeenCalledWith("experiments", { replace: true });
    });

    view.unmount();
    setActiveSection.mockClear();
    activeSection = "heartbeat";
    renderSettingsPage();

    await waitFor(() => {
      expect(setActiveSection).toHaveBeenCalledWith("experiments", { replace: true });
    });
  });
});
