import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROVIDERS } from "@/common/constants/providers";
import { EffectivePolicySchema, PolicyFileSchema } from "./policy";

function policyFileWithProvider(id: string): unknown {
  return {
    policy_format_version: "0.1",
    provider_access: [{ id }],
  };
}

describe("policy provider ids", () => {
  test("parses custom provider ids in provider_access", () => {
    for (const id of ["local-vllm", "llama_cpp"]) {
      expect(PolicyFileSchema.safeParse(policyFileWithProvider(id)).success).toBe(true);
    }
  });

  test("rejects invalid provider ids in provider_access", () => {
    for (const id of ["BAD.id", "__proto__", "with space", "with:colon", ""]) {
      expect(PolicyFileSchema.safeParse(policyFileWithProvider(id)).success).toBe(false);
    }
  });

  test("continues to parse built-in provider ids", () => {
    for (const id of SUPPORTED_PROVIDERS) {
      expect(PolicyFileSchema.safeParse(policyFileWithProvider(id)).success).toBe(true);
    }
  });

  test("parses custom provider ids in effective policy provider access", () => {
    const parsed = EffectivePolicySchema.safeParse({
      policyFormatVersion: "0.1",
      providerAccess: [
        {
          id: "local-vllm",
          forcedBaseUrl: "http://localhost:8000/v1",
          allowedModels: ["llama-3"],
        },
      ],
      mcp: { allowUserDefined: { stdio: true, remote: true } },
      runtimes: null,
    });

    expect(parsed.success).toBe(true);
  });
});
