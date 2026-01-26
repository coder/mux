import { z } from "zod";
import { SUPPORTED_PROVIDERS, type ProviderName } from "@/common/constants/providers";

export const PolicyFormatVersionSchema = z.literal("0.1");
export type PolicyFormatVersion = z.infer<typeof PolicyFormatVersionSchema>;

export const PolicyProviderNameSchema = z.enum(
  SUPPORTED_PROVIDERS as [ProviderName, ...ProviderName[]]
);
export type PolicyProviderName = z.infer<typeof PolicyProviderNameSchema>;

export const PolicyModelAccessRuleSchema = z
  .object({
    // NOTE: the policy file itself is evaluated as JS before validation.
    // This field is therefore the evaluated result of any expression.
    match: z.union([z.string(), z.array(z.string())]),
  })
  .strict();
export type PolicyModelAccessRule = z.infer<typeof PolicyModelAccessRuleSchema>;

export const PolicyProviderAccessSchema = z
  .object({
    id: PolicyProviderNameSchema,
    // Empty/undefined means "do not force".
    base_url: z.string().optional(),
    // Empty/undefined means "allow all".
    model_access: z.array(PolicyModelAccessRuleSchema).optional(),
  })
  .strict();
export type PolicyProviderAccess = z.infer<typeof PolicyProviderAccessSchema>;

export const PolicyAllowUserDefinedMCPSchema = z
  .object({
    stdio: z.boolean(),
    remote: z.boolean(),
  })
  .strict();
export type PolicyAllowUserDefinedMCP = z.infer<typeof PolicyAllowUserDefinedMCPSchema>;

export const PolicyToolsSchema = z
  .object({
    allow_user_defined_mcp: PolicyAllowUserDefinedMCPSchema.optional(),
  })
  .strict();
export type PolicyTools = z.infer<typeof PolicyToolsSchema>;

export const PolicyRuntimeIdSchema = z.enum([
  "local",
  "worktree",
  "ssh",
  "ssh+coder",
  "docker",
  "devcontainer",
]);
export type PolicyRuntimeId = z.infer<typeof PolicyRuntimeIdSchema>;

export const PolicyRuntimeAccessSchema = z
  .object({
    id: PolicyRuntimeIdSchema,
  })
  .strict();
export type PolicyRuntimeAccess = z.infer<typeof PolicyRuntimeAccessSchema>;

export const PolicyFileSchema = z
  .object({
    policy_format_version: PolicyFormatVersionSchema,
    server_version: z.string().optional(),
    minimum_client_version: z.string().optional(),

    // Empty/undefined means "allow all".
    provider_access: z.array(PolicyProviderAccessSchema).optional(),

    tools: PolicyToolsSchema.optional(),

    // Empty/undefined means "allow all".
    runtimes: z.array(PolicyRuntimeAccessSchema).optional(),
  })
  .strict();
export type PolicyFile = z.infer<typeof PolicyFileSchema>;

export const PolicyStatusSchema = z
  .object({
    state: z.enum(["disabled", "enforced", "blocked"]),
    reason: z.string().optional(),
  })
  .strict();
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

export const EffectivePolicyProviderAccessSchema = z
  .object({
    id: PolicyProviderNameSchema,
    forcedBaseUrl: z.string().optional(),
    // null means "allow all" for that provider.
    allowedModels: z.array(z.string()).nullable().optional(),
  })
  .strict();

export const EffectivePolicySchema = z
  .object({
    policyFormatVersion: PolicyFormatVersionSchema,
    serverVersion: z.string().optional(),
    minimumClientVersion: z.string().optional(),

    // null means "allow all providers".
    providerAccess: z.array(EffectivePolicyProviderAccessSchema).nullable(),

    mcp: z
      .object({
        allowUserDefined: z.object({ stdio: z.boolean(), remote: z.boolean() }).strict(),
      })
      .strict(),

    // null means "allow all runtimes".
    runtimes: z.array(PolicyRuntimeIdSchema).nullable(),
  })
  .strict();
export type EffectivePolicy = z.infer<typeof EffectivePolicySchema>;

export const PolicyGetResponseSchema = z
  .object({
    status: PolicyStatusSchema,
    policy: EffectivePolicySchema.nullable(),
  })
  .strict();
export type PolicyGetResponse = z.infer<typeof PolicyGetResponseSchema>;
