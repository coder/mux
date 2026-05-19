/**
 * Schemas for the extensions ORPC API surface.
 *
 * These mirror the runtime types exported by
 * `src/node/extensions/extensionRegistryService.ts` and the manifest /
 * discovery / permission / conflict-resolver modules they depend on.
 *
 * Mutators in this API target Extensions with `{ rootId, extensionId }`;
 * `rootId` is opaque to the IPC and resolved on the backend against the
 * registry's current snapshot. For project-local roots the `rootId` includes
 * the project path so multi-project hosts disambiguate. Stale records expose a
 * synthetic `rootId` so the same `{ rootId, extensionId }` pair works through
 * `forgetStale`.
 */
import { eventIterator } from "@orpc/server";
import { z } from "zod";
import { ExtensionNameSchema, ExtensionRuntimeIdSchema } from "./extension";

export const RootKindSchema = z.enum(["bundled", "user-global", "project-local"]);

export const ExtensionDiagnosticSeveritySchema = z.enum(["error", "warn", "info"]);

export const ExtensionDiagnosticContributionRefSchema = z.object({
  type: z.string(),
  index: z.number().int().nonnegative().nullish(),
  id: z.string().nullish(),
});

export const ExtensionDiagnosticSchema = z.object({
  code: z.string(),
  severity: ExtensionDiagnosticSeveritySchema,
  message: z.string(),
  rootId: z.string().nullish(),
  extensionId: z.string().nullish(),
  contributionRef: ExtensionDiagnosticContributionRefSchema.nullish(),
  suggestedAction: z.string().nullish(),
  occurredAt: z.number(),
});

export const ValidatedContributionSchema = z.object({
  type: z.string(),
  id: z.string(),
  index: z.number().int().nonnegative(),
  // Descriptor shape varies per contribution type; the manifest validator has
  // already accepted it against the matching descriptor schema, so we surface
  // it as a record.
  descriptor: z.record(z.string(), z.unknown()),
});

export const ValidatedManifestSchema = z.object({
  manifestVersion: z.literal(1),
  id: z.string(),
  displayName: z.string().nullish(),
  description: z.string().nullish(),
  publisher: z.string().nullish(),
  homepage: z.string().nullish(),
  requestedPermissions: z.array(z.string()),
  contributions: z.array(ValidatedContributionSchema),
});

export const DiscoveredContributionSchema = z.object({
  type: z.string(),
  id: z.string(),
  index: z.number().int().nonnegative(),
  bodyPath: z.string().nullish(),
  activated: z.boolean(),
});

export const DiscoveredExtensionSchema = z.object({
  extensionId: ExtensionRuntimeIdSchema,
  rootId: z.string(),
  rootKind: RootKindSchema,
  isCore: z.boolean(),
  modulePath: z.string(),
  manifest: ValidatedManifestSchema,
  contributions: z.array(DiscoveredContributionSchema),
  diagnostics: z.array(ExtensionDiagnosticSchema),
  enabled: z.boolean(),
  granted: z.boolean(),
  activated: z.boolean(),
});

export const RootDiscoveryStateSchema = z.enum(["pending", "running", "ready", "failed"]);

export const RootDiscoveryResultSchema = z.object({
  rootId: z.string(),
  kind: RootKindSchema,
  path: z.string(),
  trusted: z.boolean(),
  rootExists: z.boolean(),
  state: RootDiscoveryStateSchema,
  extensions: z.array(DiscoveredExtensionSchema),
  diagnostics: z.array(ExtensionDiagnosticSchema),
});

export const AvailableContributionSchema = z.object({
  type: z.string(),
  id: z.string(),
  extensionId: ExtensionRuntimeIdSchema,
  rootId: z.string(),
  rootKind: RootKindSchema,
});

export const UnavailableReasonSchema = z.enum([
  "untrusted-root",
  "disabled",
  "ungranted",
  "missing-permissions",
  "pending-reapproval",
  "body-failed",
  "not-activated",
  "inspection-only",
  "conflict",
]);

export const InspectionDescriptorSchema = z.object({
  type: z.string(),
  id: z.string(),
  extensionId: ExtensionRuntimeIdSchema,
  rootId: z.string(),
  rootKind: RootKindSchema,
  available: z.boolean(),
  unavailableReasons: z.array(UnavailableReasonSchema),
  missingPermissions: z.array(z.string()),
});

export const ApprovalRecordSchema = z.object({
  grantedPermissions: z.array(z.string()),
  requestedPermissionsHash: z.string(),
});

export const DriftStatusSchema = z.enum(["fresh", "permissions-changed"]);

export const ContributionAvailabilitySchema = z.object({
  type: z.string(),
  id: z.string(),
  available: z.boolean(),
  missingPermissions: z.array(z.string()),
});

export const CalculatePermissionsResultSchema = z.object({
  effectivePermissions: z.array(z.string()),
  pendingNew: z.array(z.string()),
  contributions: z.array(ContributionAvailabilitySchema),
  driftStatus: DriftStatusSchema.nullable(),
  isStale: z.boolean(),
});

export const StaleRecordSchema = z.object({
  scope: z.enum(["global", "project-local"]),
  projectPath: z.string().nullish(),
  extensionId: ExtensionRuntimeIdSchema,
  approval: ApprovalRecordSchema,
  rootId: z.string(),
});

export const RegistrySnapshotSchema = z.object({
  generatedAt: z.number(),
  roots: z.array(RootDiscoveryResultSchema),
  availableContributions: z.array(AvailableContributionSchema),
  resolverDiagnostics: z.array(ExtensionDiagnosticSchema),
  descriptors: z.array(InspectionDescriptorSchema),
  permissions: z.record(z.string(), CalculatePermissionsResultSchema),
  staleRecords: z.array(StaleRecordSchema),
});

export const GitExtensionInstallResultSchema = z
  .object({
    extensionName: ExtensionNameSchema,
    resolvedSha: z.string().regex(/^[0-9a-f]{40}$/u),
    contentHash: z.string().min(1),
    storePath: z.string().min(1),
    activePath: z.string().min(1),
  })
  .strict();

const RootIdInputSchema = z.object({ rootId: z.string().min(1) }).strict();
const ExtensionTargetSchema = z
  .object({ rootId: z.string().min(1), extensionId: ExtensionRuntimeIdSchema })
  .strict();

export const extensions = {
  // Returns the current registry snapshot. `null` until the first reload (e.g.,
  // before the registry has been initialized).
  list: {
    input: z.void(),
    output: RegistrySnapshotSchema.nullable(),
  },
  // Subscription: emits when the live snapshot is replaced. Frontend re-fetches
  // `list` on each notification. Multicasts to multiple subscribers.
  onChanged: {
    input: z.void(),
    output: eventIterator(z.void()),
  },
  installGitSource: {
    input: z.object({ coordinate: z.string().min(1) }).strict(),
    output: GitExtensionInstallResultSchema,
  },
  initializeUserRoot: {
    input: z.void(),
    output: z.void(),
  },
  reload: {
    input: z.object({ rootId: z.string().min(1).nullish() }).strict(),
    output: z.void(),
  },
  trustRoot: {
    input: RootIdInputSchema,
    output: z.void(),
  },
  untrustRoot: {
    input: RootIdInputSchema,
    output: z.void(),
  },
  enable: {
    input: ExtensionTargetSchema,
    output: z.void(),
  },
  disable: {
    input: ExtensionTargetSchema,
    output: z.void(),
  },
  approve: {
    input: ExtensionTargetSchema,
    output: z.void(),
  },
  revokeApproval: {
    input: ExtensionTargetSchema,
    output: z.void(),
  },
  forgetStale: {
    input: ExtensionTargetSchema,
    output: z.void(),
  },
};
