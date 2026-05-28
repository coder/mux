import { z } from "zod";
import { SkillNameSchema } from "./agentSkill";
import { LayoutPresetSchema } from "./uiLayouts";
import { RuntimeConfigSchema } from "./runtime";

export const ExtensionIdentityRegex = /^[a-z0-9]+(?:\.[a-z0-9][a-z0-9-]*)+$/;

export const ExtensionIdentitySchema = z.string().regex(ExtensionIdentityRegex);

// Extension Modules are identified by their kebab-case folder basename. Keep
// this aligned with agent skill names so a module name can safely appear in UI,
// state keys, and filesystem-backed active views.
export const ExtensionNameSchema = SkillNameSchema;

// Transitional API key schema while package-based Extension Identities are being
// retired in favor of Extension Names. New Extension Module code should use
// ExtensionNameSchema; existing persisted/package records still parse here.
export const ExtensionRuntimeIdSchema = z.union([ExtensionNameSchema, ExtensionIdentitySchema]);

export const ExtensionModuleCapabilitiesSchema = z
  .object({
    skills: z.literal(true).nullish(),
  })
  .strict();

export const ExtensionModuleManifestSchema = z
  .object({
    name: ExtensionNameSchema,
    displayName: z.string().nullish(),
    description: z.string().nullish(),
    capabilities: ExtensionModuleCapabilitiesSchema.nullish(),
  })
  .passthrough();

// Per-contribution identifier (kebab-case, mirrors agentskills.io naming).
export const ContributionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

// Schema-level validation of relative body paths. Filesystem-level symlink
// containment is enforced separately by the Path Containment helper (US-007).
export const RelativeBodyPathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.includes("\0"), { message: "must not contain null bytes" })
  .refine((p) => !p.startsWith("/") && !p.startsWith("\\") && !/^[A-Za-z]:[/\\]/.test(p), {
    message: "must be a relative path (no absolute paths)",
  })
  .refine((p) => !p.split(/[\\/]/).includes(".."), {
    message: "must not contain .. segments",
  });

// Mux-owned Command Target id (e.g., mux.workspace.create). Validator may
// further check the value against the live Command Target registry.
export const CommandTargetIdSchema = z
  .string()
  .min(1)
  .regex(/^mux\.[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/);

// Curated theme tokens. Adding a new token here is an explicit platform
// decision, not something Extensions can opt into via passthrough.
export const ThemeTokenKeySchema = z.enum([
  "background",
  "backgroundSecondary",
  "foreground",
  "border",
  "accent",
  "accentForeground",
  "muted",
  "mutedForeground",
  "surfacePrimary",
  "surfaceSecondary",
  "surfaceTertiary",
  "destructive",
  "destructiveForeground",
  "success",
  "successForeground",
]);

export const ThemeTokensSchema = z.partialRecord(ThemeTokenKeySchema, z.string().min(1));

// Build a descriptor schema for a contribution type:
// - V1 object requires `descriptorVersion: 1` plus the type-specific fields
// - `.passthrough()` lets additive optional fields stay at v1 (the validator
//   emits info diagnostics for unrecognized keys; US-004)
// - Discriminated union rejects unknown descriptorVersion values cleanly
// - Preprocess injects `descriptorVersion: 1` when absent so authors do not
//   need to repeat the literal in every contribution
function makeDescriptorSchema<T extends z.ZodRawShape>(fields: T) {
  const v1 = z.object({ descriptorVersion: z.literal(1), ...fields }).passthrough();
  return z.preprocess(
    (input) => {
      if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
      const obj = input as Record<string, unknown>;
      return "descriptorVersion" in obj ? obj : { ...obj, descriptorVersion: 1 };
    },
    z.discriminatedUnion("descriptorVersion", [v1])
  );
}

export const SkillDescriptorSchema = makeDescriptorSchema({
  // Extension skills flow into the agent skill registry, whose public names are
  // capped by SkillNameSchema. Keep manifest validation aligned so a skill that
  // validates here cannot be silently skipped later by skill discovery.
  id: SkillNameSchema,
  body: RelativeBodyPathSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  advertise: z.boolean().nullish(),
});

export const AgentDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  body: RelativeBodyPathSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
});

export const ThemeDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  tokens: ThemeTokensSchema,
});

export const LayoutDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  preset: LayoutPresetSchema,
});

export const RuntimePresetDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  runtime: RuntimeConfigSchema,
});

export const CommandDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  target: CommandTargetIdSchema,
  title: z.string().min(1),
  description: z.string().nullish(),
});

// Provisional Descriptors (inspection-only contribution types).
//
// The six schemas below cover Runtime Driver, Tool, MCP Server, Panel,
// Agent Lifecycle Hook, and Secret Provider. They are descriptor-only:
// no executable handler reference, no view/render hook, no runtime config —
// just identity plus inspection metadata so authors can declare them in v1
// manifests and Mux can surface them in the Extensions Settings Section.
//
// Per ADR-0002 and the v1 contribution support level table, these types
// remain `inspection-only` until Mux defines a Host API. Their schemas may
// evolve in **breaking** ways before reaching `available` Contribution
// Support Level *without bumping descriptorVersion*; authors targeting
// Provisional Descriptors must accept that schemas may change.
//
// `.passthrough()` (via makeDescriptorSchema) tolerates additive optional
// fields at v1; the Manifest Validator (US-004) emits info-severity
// diagnostics for unrecognized keys.

export const RuntimeDriverDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
});

export const ToolDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
});

export const McpServerDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
});

export const PanelDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
});

export const AgentLifecycleHookDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
});

export const SecretProviderDescriptorSchema = makeDescriptorSchema({
  id: ContributionIdSchema,
  displayName: z.string().nullish(),
  description: z.string().nullish(),
});

export type ExtensionModuleManifest = z.infer<typeof ExtensionModuleManifestSchema>;

export type SkillDescriptor = z.infer<typeof SkillDescriptorSchema>;
export type AgentDescriptor = z.infer<typeof AgentDescriptorSchema>;
export type ThemeDescriptor = z.infer<typeof ThemeDescriptorSchema>;
export type LayoutDescriptor = z.infer<typeof LayoutDescriptorSchema>;
export type RuntimePresetDescriptor = z.infer<typeof RuntimePresetDescriptorSchema>;
export type CommandDescriptor = z.infer<typeof CommandDescriptorSchema>;
export type RuntimeDriverDescriptor = z.infer<typeof RuntimeDriverDescriptorSchema>;
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;
export type McpServerDescriptor = z.infer<typeof McpServerDescriptorSchema>;
export type PanelDescriptor = z.infer<typeof PanelDescriptorSchema>;
export type AgentLifecycleHookDescriptor = z.infer<typeof AgentLifecycleHookDescriptorSchema>;
export type SecretProviderDescriptor = z.infer<typeof SecretProviderDescriptorSchema>;
export type ThemeTokenKey = z.infer<typeof ThemeTokenKeySchema>;

// Contribution lists stay as `unknown[]` at the envelope level so the Manifest
// Validator (US-004) can apply each type's descriptor schema per-element and
// emit contribution-level diagnostics without failing the whole manifest.
const ContributionDescriptorListSchema = z.array(z.unknown()).nullish();

export const ExtensionContributesV1Schema = z
  .object({
    skills: ContributionDescriptorListSchema,
    agents: ContributionDescriptorListSchema,
    themes: ContributionDescriptorListSchema,
    layouts: ContributionDescriptorListSchema,
    runtimePresets: ContributionDescriptorListSchema,
    commands: ContributionDescriptorListSchema,
    runtimeDrivers: ContributionDescriptorListSchema,
    tools: ContributionDescriptorListSchema,
    mcpServers: ContributionDescriptorListSchema,
    panels: ContributionDescriptorListSchema,
    agentLifecycleHooks: ContributionDescriptorListSchema,
    secretProviders: ContributionDescriptorListSchema,
  })
  .strict();

export const ExtensionManifestV1Schema = z
  .object({
    manifestVersion: z.literal(1),
    id: ExtensionIdentitySchema,
    contributes: ExtensionContributesV1Schema,
    displayName: z.string().nullish(),
    description: z.string().nullish(),
    publisher: z.string().nullish(),
    homepage: z.string().nullish(),
    requestedPermissions: z.array(z.string()).nullish(),
  })
  .passthrough();

export const ExtensionManifestSchema = z.discriminatedUnion("manifestVersion", [
  ExtensionManifestV1Schema,
]);

export type ExtensionContributesV1 = z.infer<typeof ExtensionContributesV1Schema>;
export type ExtensionManifestV1 = z.infer<typeof ExtensionManifestV1Schema>;
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
