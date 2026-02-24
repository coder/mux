import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import type { EffectivePolicy } from "@/common/orpc/types";
import { RUNTIME_MODE, type ParsedRuntime } from "@/common/types/runtime";
import {
  getAllowedProvidersForUi,
  getAllowedRuntimeModesForUi,
  getPolicyRuntimeIdFromParsedRuntime,
  isParsedRuntimeAllowedByPolicy,
} from "./policyUi";

function buildPolicy(overrides: Partial<EffectivePolicy>): EffectivePolicy {
  return {
    policyFormatVersion: "0.1",
    providerAccess: null,
    mcp: { allowUserDefined: { stdio: true, remote: true } },
    runtimes: null,
    ...overrides,
  };
}

describe("policyUi", () => {
  test("getAllowedProvidersForUi returns all providers when policy allows all", () => {
    expect(getAllowedProvidersForUi(buildPolicy({}))).toEqual([...SUPPORTED_PROVIDERS]);
  });

  test("getAllowedProvidersForUi filters providers by policy (preserving canonical order)", () => {
    const policy = buildPolicy({
      providerAccess: [
        { id: "openai", allowedModels: null },
        { id: "anthropic", allowedModels: null },
      ],
    });

    expect(getAllowedProvidersForUi(policy)).toEqual(["anthropic", "openai"]);
  });

  test("getAllowedRuntimeModesForUi treats runtimes=null as allow-all", () => {
    expect(getAllowedRuntimeModesForUi(buildPolicy({}))).toEqual({
      allowedModes: null,
      allowSshHost: true,
      allowSshCoder: true,
    });
  });

  test("getAllowedRuntimeModesForUi maps ssh+coder to SSH mode + host gating", () => {
    const policy = buildPolicy({ runtimes: ["ssh+coder"] });

    expect(getAllowedRuntimeModesForUi(policy)).toEqual({
      allowedModes: [RUNTIME_MODE.SSH],
      allowSshHost: false,
      allowSshCoder: true,
    });
  });

  test("runtime policy helpers distinguish ssh vs ssh+coder", () => {
    const policy = buildPolicy({ runtimes: ["ssh+coder"] });

    const sshHost: ParsedRuntime = { mode: RUNTIME_MODE.SSH, host: "user@host" };
    const sshCoder: ParsedRuntime = {
      mode: RUNTIME_MODE.SSH,
      host: "workspace.mux--coder",
      coder: { existingWorkspace: true, workspaceName: "workspace" },
    };

    expect(getPolicyRuntimeIdFromParsedRuntime(sshHost)).toBe("ssh");
    expect(getPolicyRuntimeIdFromParsedRuntime(sshCoder)).toBe("ssh+coder");

    expect(isParsedRuntimeAllowedByPolicy(policy, sshHost)).toBe(false);
    expect(isParsedRuntimeAllowedByPolicy(policy, sshCoder)).toBe(true);
  });
});
