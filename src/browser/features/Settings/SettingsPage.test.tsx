import { describe, expect, test } from "bun:test";

import { getSettingsSectionRedirect, getSettingsSections } from "./SettingsPage";

describe("SettingsPage", () => {
  test("keeps Goals and Heartbeat out of settings navigation", () => {
    const labels = getSettingsSections(true, true).map((section) => section.label);

    expect(labels).not.toContain("Goals");
    expect(labels).not.toContain("Heartbeat");
    expect(labels).toContain("Experiments");
  });

  test("normalizes stale Goals and Heartbeat routes to Experiments with replace navigation", () => {
    expect(getSettingsSectionRedirect("goals", true, true)).toEqual({
      section: "experiments",
      replace: true,
    });
    expect(getSettingsSectionRedirect("heartbeat", true, true)).toEqual({
      section: "experiments",
      replace: true,
    });
  });

  test("shows the Memory section only while the memory experiment is enabled", () => {
    expect(getSettingsSections(false, true).map((section) => section.id)).toContain("memory");
    expect(getSettingsSections(false, false).map((section) => section.id)).not.toContain("memory");
  });

  test("redirects the memory route away while the memory experiment is disabled", () => {
    expect(getSettingsSectionRedirect("memory", false, false)).toEqual({ section: "general" });
    expect(getSettingsSectionRedirect("memory", false, true)).toBeNull();
  });
});
