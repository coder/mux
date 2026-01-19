import { describe, expect, test } from "bun:test";
import { buildAutoSelectedTemplateConfig } from "./useCoderWorkspace";
import type { CoderTemplate } from "@/common/orpc/schemas/coder";

const makeTemplate = (name: string, org = "default-org"): CoderTemplate => ({
  name,
  displayName: name,
  organizationName: org,
});

describe("buildAutoSelectedTemplateConfig", () => {
  test("preserves preset when auto-selecting first template", () => {
    const currentConfig = { preset: "my-preset" };
    const templates = [makeTemplate("template-a")];

    const result = buildAutoSelectedTemplateConfig(currentConfig, templates);

    expect(result).toEqual({
      preset: "my-preset",
      existingWorkspace: false,
      template: "template-a",
      templateOrg: undefined,
    });
  });

  test("sets templateOrg when first template name is duplicated across orgs", () => {
    const templates = [makeTemplate("shared-name", "org-1"), makeTemplate("shared-name", "org-2")];

    const result = buildAutoSelectedTemplateConfig(null, templates);

    expect(result).toEqual({
      existingWorkspace: false,
      template: "shared-name",
      templateOrg: "org-1",
    });
  });

  test("returns null when template is already selected", () => {
    const currentConfig = { template: "existing-template" };
    const templates = [makeTemplate("template-a")];

    expect(buildAutoSelectedTemplateConfig(currentConfig, templates)).toBeNull();
  });

  test("returns null when existingWorkspace is true", () => {
    const currentConfig = { existingWorkspace: true };
    const templates = [makeTemplate("template-a")];

    expect(buildAutoSelectedTemplateConfig(currentConfig, templates)).toBeNull();
  });

  test("returns null when templates array is empty", () => {
    expect(buildAutoSelectedTemplateConfig(null, [])).toBeNull();
  });
});
