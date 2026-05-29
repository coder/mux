import { describe, expect, it } from "bun:test";
import { buildDevcontainerConfigInfo, formatDevcontainerLabel } from "./devcontainerConfigs";

describe("formatDevcontainerLabel", () => {
  it("labels root devcontainer.json as default", () => {
    expect(formatDevcontainerLabel(".devcontainer.json")).toBe("Default (.devcontainer.json)");
  });

  it("labels .devcontainer/devcontainer.json as default", () => {
    expect(formatDevcontainerLabel(".devcontainer/devcontainer.json")).toBe(
      "Default (.devcontainer/devcontainer.json)"
    );
  });

  it("labels nested devcontainer configs by folder", () => {
    expect(formatDevcontainerLabel(".devcontainer/backend/devcontainer.json")).toBe(
      "backend (.devcontainer/backend/devcontainer.json)"
    );
  });

  it("normalizes backslashes in nested paths", () => {
    expect(formatDevcontainerLabel(".devcontainer\\frontend\\devcontainer.json")).toBe(
      "frontend (.devcontainer/frontend/devcontainer.json)"
    );
  });

  it("falls back to normalized path for custom locations", () => {
    expect(formatDevcontainerLabel("configs/devcontainer.json")).toBe("configs/devcontainer.json");
  });
});

describe("buildDevcontainerConfigInfo", () => {
  it("maps config paths to labels", () => {
    const info = buildDevcontainerConfigInfo([
      ".devcontainer.json",
      ".devcontainer/api/devcontainer.json",
    ]);

    expect(info).toEqual([
      { path: ".devcontainer.json", label: "Default (.devcontainer.json)" },
      {
        path: ".devcontainer/api/devcontainer.json",
        label: "api (.devcontainer/api/devcontainer.json)",
      },
    ]);
  });
});
