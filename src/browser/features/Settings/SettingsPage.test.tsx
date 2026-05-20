import { describe, expect, test } from "bun:test";

import { getSettingsSectionRedirect, getSettingsSections } from "./SettingsPage";

describe("SettingsPage", () => {
  test("keeps Goals and Heartbeat out of settings navigation", () => {
    const labels = getSettingsSections(true).map((section) => section.label);

    expect(labels).not.toContain("Goals");
    expect(labels).not.toContain("Heartbeat");
    expect(labels).toContain("Extensions");
    expect(labels).toContain("Experiments");
  });

  test("normalizes stale Goals and Heartbeat routes to Experiments with replace navigation", () => {
    expect(getSettingsSectionRedirect("goals", true)).toEqual({
      section: "experiments",
      replace: true,
    });
    expect(getSettingsSectionRedirect("heartbeat", true)).toEqual({
      section: "experiments",
      replace: true,
    });
  });
});
