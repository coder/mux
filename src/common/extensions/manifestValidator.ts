import type { ZodType } from "zod";
import {
  AgentDescriptorSchema,
  AgentLifecycleHookDescriptorSchema,
  CommandDescriptorSchema,
  ExtensionIdentityRegex,
  ExtensionModuleManifestSchema,
  ExtensionNameSchema,
  LayoutDescriptorSchema,
  McpServerDescriptorSchema,
  PanelDescriptorSchema,
  RuntimeDriverDescriptorSchema,
  RuntimePresetDescriptorSchema,
  SecretProviderDescriptorSchema,
  SkillDescriptorSchema,
  ThemeDescriptorSchema,
  ToolDescriptorSchema,
} from "@/common/orpc/schemas/extension";

export type RootKind = "bundled" | "user-global" | "project-local";

export type ExtensionDiagnosticSeverity = "error" | "warn" | "info";

export interface ExtensionDiagnosticContributionRef {
  type: string;
  // The position of the contribution inside its owning manifest's
  // `contributes[type]` array. Omitted when the diagnostic spans contributions
  // from multiple manifests (e.g., cross-Extension contribution-id conflicts).
  index?: number;
  id?: string;
}

export interface ExtensionDiagnostic {
  code: string;
  severity: ExtensionDiagnosticSeverity;
  message: string;
  rootId?: string;
  extensionId?: string;
  contributionRef?: ExtensionDiagnosticContributionRef;
  suggestedAction?: string;
  occurredAt: number;
}

export interface ValidatedContribution {
  type: string;
  id: string;
  // Position within the original `contributes[type]` array; useful for
  // diagnostic refs and stable ordering in downstream consumers.
  index: number;
  // The post-preprocess validated descriptor. Shape depends on `type`; consumers
  // that need typed access narrow via `type` and re-cast against the matching
  // descriptor schema export.
  descriptor: Record<string, unknown>;
}

export interface ValidatedManifest {
  manifestVersion: 1;
  id: string;
  displayName?: string;
  description?: string;
  publisher?: string;
  homepage?: string;
  // Effect Capabilities plus Registration Capabilities materialized from
  // declared contributions (e.g., `skill.register`).
  requestedPermissions: string[];
  // Validated contributions in declaration order, grouped per type. Only
  // contributions whose descriptor schema accepted the input are included;
  // invalid descriptors are reported in `diagnostics` and excluded here.
  contributions: ValidatedContribution[];
}

export type ManifestValidationResult =
  | { ok: true; manifest: ValidatedManifest; diagnostics: ExtensionDiagnostic[] }
  | { ok: false; diagnostics: ExtensionDiagnostic[] };

export interface ValidateManifestInput {
  rawMux: unknown;
  pkg: unknown;
  rootKind: RootKind;
  /** Override the diagnostic timestamp for deterministic tests. */
  now?: number;
}

export interface ValidateStaticManifestInput {
  rawManifest: unknown;
  extensionName: string;
  rootKind: RootKind;
  /** Override the diagnostic timestamp for deterministic tests. */
  now?: number;
}

// Reserved Extension Identity Prefix per ADR-0005. Checked before envelope
// validation so a regex/schema regression in one place can't open the boundary.
// Also consumed by the Extension Telemetry Layer (US-016) to gate identifier
// fields so only Mux-controlled identities can ever appear in telemetry.
export const RESERVED_EXTENSION_IDENTITY_PREFIX_REGEX = /^mux(\..*)?$/;

const KNOWN_TOP_LEVEL_FIELDS = new Set([
  "manifestVersion",
  "id",
  "contributes",
  "displayName",
  "description",
  "publisher",
  "homepage",
  "requestedPermissions",
]);

const KNOWN_STATIC_MANIFEST_FIELDS = new Set([
  "name",
  "displayName",
  "description",
  "capabilities",
  "requestedPermissions",
]);
const KNOWN_STATIC_CAPABILITY_FIELDS = new Set(["skills"]);

// `singular` is the prefix used to materialize the type's Registration
// Capability (`<singular>.register`).
export const CONTRIBUTION_TYPES: ReadonlyArray<{
  key: string;
  singular: string;
  schema: ZodType;
}> = [
  { key: "skills", singular: "skill", schema: SkillDescriptorSchema },
  { key: "agents", singular: "agent", schema: AgentDescriptorSchema },
  { key: "themes", singular: "theme", schema: ThemeDescriptorSchema },
  { key: "layouts", singular: "layout", schema: LayoutDescriptorSchema },
  { key: "runtimePresets", singular: "runtimePreset", schema: RuntimePresetDescriptorSchema },
  { key: "commands", singular: "command", schema: CommandDescriptorSchema },
  { key: "runtimeDrivers", singular: "runtimeDriver", schema: RuntimeDriverDescriptorSchema },
  { key: "tools", singular: "tool", schema: ToolDescriptorSchema },
  { key: "mcpServers", singular: "mcpServer", schema: McpServerDescriptorSchema },
  { key: "panels", singular: "panel", schema: PanelDescriptorSchema },
  {
    key: "agentLifecycleHooks",
    singular: "agentLifecycleHook",
    schema: AgentLifecycleHookDescriptorSchema,
  },
  { key: "secretProviders", singular: "secretProvider", schema: SecretProviderDescriptorSchema },
];

const KNOWN_CONTRIBUTES_KEYS = new Set(CONTRIBUTION_TYPES.map((c) => c.key));

// Maps a contributes-key (e.g., "skills") to its Registration Capability
// (e.g., "skill.register"). Exposed for downstream consumers
// (e.g., the Registry Service) that need to drive the capability calculator.
export const CONTRIBUTION_TYPE_REGISTRATION_PERMISSIONS: Readonly<Record<string, string>> =
  Object.fromEntries(CONTRIBUTION_TYPES.map((c) => [c.key, `${c.singular}.register`]));

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function validateStaticManifest(
  input: ValidateStaticManifestInput
): ManifestValidationResult {
  const occurredAt = input.now ?? Date.now();
  const diagnostics: ExtensionDiagnostic[] = [];

  if (!ExtensionNameSchema.safeParse(input.extensionName).success) {
    diagnostics.push({
      code: "extension.name.invalid",
      severity: "error",
      message: `Extension Module folder name ${JSON.stringify(
        input.extensionName
      )} must be kebab-case and match the Extension Name rules.`,
      extensionId: input.extensionName,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  if (!isPlainObject(input.rawManifest)) {
    diagnostics.push({
      code: "manifest.invalid",
      severity: "error",
      message: "Static Manifest export must be an object literal.",
      extensionId: input.extensionName,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  const raw = input.rawManifest;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_STATIC_MANIFEST_FIELDS.has(key)) {
      diagnostics.push({
        code: "manifest.unknown_field",
        severity: "info",
        message: `Unknown optional static manifest field "${key}" (value ignored).`,
        extensionId: input.extensionName,
        occurredAt,
      });
    }
  }

  if (isPlainObject(raw.capabilities)) {
    for (const key of Object.keys(raw.capabilities)) {
      if (!KNOWN_STATIC_CAPABILITY_FIELDS.has(key)) {
        diagnostics.push({
          code: "manifest.capability.unknown",
          severity: "error",
          message: `Unknown static manifest capability "${key}". V1 supports only the skills registration capability.`,
          extensionId: input.extensionName,
          occurredAt,
        });
      }
    }
  }

  const parsed = ExtensionModuleManifestSchema.safeParse(raw);
  if (!parsed.success) {
    diagnostics.push({
      code: "manifest.invalid",
      severity: "error",
      message: parsed.error.message,
      extensionId: input.extensionName,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return { ok: false, diagnostics };
  }

  if (parsed.data.name !== input.extensionName) {
    diagnostics.push({
      code: "extension.name.mismatch",
      severity: "error",
      message: `Static Manifest name "${parsed.data.name}" must match Extension Module folder name "${input.extensionName}".`,
      extensionId: parsed.data.name,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  const explicitRequested = Array.isArray(raw.requestedPermissions)
    ? raw.requestedPermissions.filter((p): p is string => typeof p === "string")
    : [];

  const manifest: ValidatedManifest = {
    manifestVersion: 1,
    id: parsed.data.name,
    requestedPermissions: Array.from(new Set(explicitRequested)),
    contributions: [],
  };
  if (typeof parsed.data.displayName === "string") manifest.displayName = parsed.data.displayName;
  if (typeof parsed.data.description === "string") manifest.description = parsed.data.description;

  return { ok: true, manifest, diagnostics };
}

export function validateManifest(input: ValidateManifestInput): ManifestValidationResult {
  const occurredAt = input.now ?? Date.now();
  const diagnostics: ExtensionDiagnostic[] = [];

  if (!isPlainObject(input.rawMux)) {
    diagnostics.push({
      code: "manifest.invalid",
      severity: "error",
      message: "Manifest `mux` field must be an object.",
      occurredAt,
    });
    return { ok: false, diagnostics };
  }
  const raw = input.rawMux;
  const rawId = typeof raw.id === "string" ? raw.id : undefined;

  // Reserved-prefix gate runs before any other identity/envelope diagnostic so
  // the boundary holds even if envelope validation regresses (ADR-0005).
  if (
    input.rootKind !== "bundled" &&
    rawId !== undefined &&
    RESERVED_EXTENSION_IDENTITY_PREFIX_REGEX.test(rawId)
  ) {
    diagnostics.push({
      code: "extension.identity.reserved",
      severity: "error",
      message: `Extension identity "${rawId}" uses the reserved mux/mux.* prefix; only bundled Extensions may claim it.`,
      extensionId: rawId,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  if (raw.manifestVersion !== 1) {
    diagnostics.push({
      code: "manifest.version.unsupported",
      severity: "error",
      message: `Unsupported manifestVersion ${JSON.stringify(raw.manifestVersion)}; this host accepts manifestVersion 1.`,
      extensionId: rawId,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  if (rawId === undefined || !ExtensionIdentityRegex.test(rawId)) {
    diagnostics.push({
      code: "extension.identity.invalid",
      severity: "error",
      message: `Extension identity ${JSON.stringify(rawId)} does not match the required dotted reverse-domain format.`,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  const contributes = raw.contributes;
  if (!isPlainObject(contributes)) {
    diagnostics.push({
      code: "manifest.invalid",
      severity: "error",
      message: "Manifest `contributes` must be an object.",
      extensionId: rawId,
      occurredAt,
    });
    return { ok: false, diagnostics };
  }

  let hasUnknownContributesKey = false;
  for (const key of Object.keys(contributes)) {
    if (!KNOWN_CONTRIBUTES_KEYS.has(key)) {
      hasUnknownContributesKey = true;
      diagnostics.push({
        code: "manifest.contributes.unknown_key",
        severity: "error",
        message: `Unknown top-level contributes key "${key}". The v1 contributes shape is closed; adding a new contribution type is a host-version change.`,
        extensionId: rawId,
        occurredAt,
      });
    }
  }
  let hasInvalidContributesList = false;
  for (const { key } of CONTRIBUTION_TYPES) {
    const value = contributes[key];
    if (value === undefined || Array.isArray(value)) continue;
    hasInvalidContributesList = true;
    diagnostics.push({
      code: "manifest.contributes.invalid_list",
      severity: "error",
      message: `contributes.${key} must be an array of contribution descriptors.`,
      extensionId: rawId,
      occurredAt,
    });
  }
  if (hasUnknownContributesKey || hasInvalidContributesList) {
    return { ok: false, diagnostics };
  }

  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
      diagnostics.push({
        code: "manifest.unknown_field",
        severity: "info",
        message: `Unknown optional manifest field "${key}" (value ignored).`,
        extensionId: rawId,
        occurredAt,
      });
    }
  }

  // A type's Registration Capability is materialized only when at least one
  // descriptor of that type validates, so an all-invalid list does not get
  // capability-grade authority via the inferred capability path.
  const inferredPerms: string[] = [];
  const validatedContributions: ValidatedContribution[] = [];
  for (const { key, singular, schema } of CONTRIBUTION_TYPES) {
    const list: unknown = contributes[key];
    if (!Array.isArray(list)) continue;
    let validCount = 0;
    for (let i = 0; i < list.length; i++) {
      const item: unknown = list[i];
      const parsed = schema.safeParse(item);
      if (parsed.success) {
        validCount++;
        validatedContributions.push({
          type: key,
          // Schema preprocess already injects descriptorVersion=1 when missing
          // and the discriminated union guarantees `id` is a non-empty string.
          id: (parsed.data as { id: string }).id,
          index: i,
          descriptor: parsed.data as Record<string, unknown>,
        });
        continue;
      }
      const contributionRef: ExtensionDiagnosticContributionRef = { type: key, index: i };
      if (isPlainObject(item) && typeof item.id === "string") {
        contributionRef.id = item.id;
      }
      diagnostics.push({
        code: "contribution.invalid",
        severity: "warn",
        message: parsed.error.message,
        extensionId: rawId,
        contributionRef,
        occurredAt,
      });
    }
    if (validCount > 0) {
      inferredPerms.push(`${singular}.register`);
    }
  }

  const explicitRequested = Array.isArray(raw.requestedPermissions)
    ? raw.requestedPermissions.filter((p): p is string => typeof p === "string")
    : [];
  const requestedPermissions = Array.from(new Set([...explicitRequested, ...inferredPerms]));

  const manifest: ValidatedManifest = {
    manifestVersion: 1,
    id: rawId,
    requestedPermissions,
    contributions: validatedContributions,
  };
  if (typeof raw.displayName === "string") manifest.displayName = raw.displayName;
  if (typeof raw.description === "string") manifest.description = raw.description;
  if (typeof raw.publisher === "string") manifest.publisher = raw.publisher;
  if (typeof raw.homepage === "string") {
    const homepage = parseHttpUrl(raw.homepage);
    if (homepage) {
      manifest.homepage = homepage;
    } else {
      diagnostics.push({
        code: "manifest.homepage.invalid",
        severity: "warn",
        message: "mux.homepage must be an http:// or https:// URL when provided.",
        occurredAt,
      });
    }
  }

  return { ok: true, manifest, diagnostics };
}
