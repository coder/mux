/**
 * UI integration test: analytics dashboard header respects titlebar-safe inset classes.
 */

import "../dom";
import { fireEvent, waitFor } from "@testing-library/react";

import { preloadTestModules } from "../../ipc/setup";
import { createAppHarness } from "../harness";

function enableDesktopApi(platform: NodeJS.Platform) {
  window.api = {
    platform,
    versions: {},
    getIsRosetta: () => Promise.resolve(false),
  };
}

function clearDesktopApi() {
  delete (window as Window & { api?: unknown }).api;
}

async function openAnalyticsAndGetHeader(container: HTMLElement) {
  const analyticsButton = container.querySelector(
    '[data-testid="analytics-button"]'
  ) as HTMLButtonElement;
  expect(analyticsButton).not.toBeNull();
  fireEvent.click(analyticsButton);

  let header: HTMLElement | null = null;
  await waitFor(
    () => {
      header = container.querySelector('[data-testid="analytics-header"]') as HTMLElement;
      if (!header) {
        throw new Error("Analytics header not found");
      }
    },
    { timeout: 10_000 }
  );

  return header!;
}

describe("Analytics header titlebar contract", () => {
  beforeAll(async () => {
    await preloadTestModules();
  });

  test("browser mode: header has h-8 and titlebar-safe-right, no desktop drag classes", async () => {
    const app = await createAppHarness({ branchPrefix: "analytics-hdr-browser" });

    try {
      const header = await openAnalyticsAndGetHeader(app.view.container);
      expect(header.classList.contains("titlebar-safe-right")).toBe(true);
      expect(header.classList.contains("titlebar-safe-right-gutter-3")).toBe(true);
      expect(header.classList.contains("h-8")).toBe(true);
      expect(header.classList.contains("titlebar-drag")).toBe(false);
    } finally {
      await app.dispose();
    }
  }, 60_000);

  test("desktop linux mode: header has h-9, titlebar-drag, and titlebar-safe-right", async () => {
    const app = await createAppHarness({
      branchPrefix: "analytics-hdr-linux",
      beforeRender: () => enableDesktopApi("linux"),
    });

    try {
      const header = await openAnalyticsAndGetHeader(app.view.container);
      expect(header.classList.contains("titlebar-safe-right")).toBe(true);
      expect(header.classList.contains("titlebar-safe-right-gutter-3")).toBe(true);
      expect(header.classList.contains("h-9")).toBe(true);
      expect(header.classList.contains("titlebar-drag")).toBe(true);
    } finally {
      clearDesktopApi();
      await app.dispose();
    }
  }, 60_000);

  test("desktop darwin mode: header has titlebar-safe-right (no-op on mac, 0px right inset)", async () => {
    const app = await createAppHarness({
      branchPrefix: "analytics-hdr-darwin",
      beforeRender: () => enableDesktopApi("darwin"),
    });

    try {
      const header = await openAnalyticsAndGetHeader(app.view.container);
      expect(header.classList.contains("titlebar-safe-right")).toBe(true);
      expect(header.classList.contains("titlebar-safe-right-gutter-3")).toBe(true);
      expect(header.classList.contains("h-9")).toBe(true);
      expect(header.classList.contains("titlebar-drag")).toBe(true);
    } finally {
      clearDesktopApi();
      await app.dispose();
    }
  }, 60_000);
});
