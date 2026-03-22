import type {
  CoderInfo,
  CoderPreset,
  CoderTemplate,
  CoderWorkspace,
} from "@/common/orpc/schemas/coder";

export const mockCoderTemplates: CoderTemplate[] = [
  { name: "coder-on-coder", displayName: "Coder on Coder", organizationName: "default" },
  { name: "kubernetes-dev", displayName: "Kubernetes Development", organizationName: "default" },
  { name: "aws-windows", displayName: "AWS Windows Instance", organizationName: "default" },
];

export const mockCoderPresetsCoderOnCoder: CoderPreset[] = [
  {
    id: "preset-sydney",
    name: "Sydney",
    description: "Australia region",
    isDefault: false,
  },
  {
    id: "preset-helsinki",
    name: "Helsinki",
    description: "Europe region",
    isDefault: false,
  },
  {
    id: "preset-pittsburgh",
    name: "Pittsburgh",
    description: "US East region",
    isDefault: true,
  },
];

export const mockCoderWorkspaces: CoderWorkspace[] = [
  {
    name: "mux-dev",
    templateName: "coder-on-coder",
    templateDisplayName: "Coder on Coder",
    status: "running",
  },
  {
    name: "api-testing",
    templateName: "kubernetes-dev",
    templateDisplayName: "Kubernetes Dev",
    status: "running",
  },
  {
    name: "frontend-v2",
    templateName: "coder-on-coder",
    templateDisplayName: "Coder on Coder",
    status: "running",
  },
];

export const mockCoderParseError = "Unexpected token u in JSON at position 0";

export const mockCoderInfoAvailable: CoderInfo = {
  state: "available",
  version: "2.28.0",
  username: "coder-user",
  url: "https://coder.example.com",
};

export const mockCoderInfoOutdated: CoderInfo = {
  state: "outdated",
  version: "2.20.0",
  minVersion: "2.25.0",
};

export const mockCoderInfoMissing: CoderInfo = {
  state: "unavailable",
  reason: "missing",
};
