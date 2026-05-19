/**
 * Extension Telemetry Layer — privacy-preserving allowlist for Extension events.
 *
 * Wraps the host TelemetryService so identifier strings (extensionId,
 * contributionId) only appear in telemetry when BOTH provenance gates pass:
 *   (a) the value matches the Reserved Extension Identity Prefix (^mux(\..*)?$)
 *   (b) the source rootKind === 'bundled'
 *
 * Either gate failing strips the field. A third-party extension squatting
 * on the `mux.*` namespace is still rejected because rootKind !== 'bundled';
 * a bundled Extension with a non-Mux id is rejected because the regex fails.
 *
 * Field names outside each event's allowlist are dropped silently — that is
 * the defense against accidentally emitting project paths, package names,
 * requested-capability lists, or file paths.
 */

import type { RootKind } from "@/common/extensions/manifestValidator";
import { RESERVED_EXTENSION_IDENTITY_PREFIX_REGEX } from "@/common/extensions/manifestValidator";

export type ExtensionTelemetryEventName =
  | "extensions.discovery.completed"
  | "extensions.discovery.failed"
  | "extensions.migration.activated"
  | "extensions.consent.shortcut.accepted"
  | "extensions.consent.shortcut.rejected"
  | "extensions.approval.recorded"
  | "extensions.approval.revoked"
  | "extensions.enabled.toggled"
  | "extensions.reload.invoked"
  | "extensions.cache.miss"
  | "extensions.cache.hit"
  | "extensions.diagnostic.emitted";

export const EXTENSION_TELEMETRY_EVENTS: readonly ExtensionTelemetryEventName[] = [
  "extensions.discovery.completed",
  "extensions.discovery.failed",
  "extensions.migration.activated",
  "extensions.consent.shortcut.accepted",
  "extensions.consent.shortcut.rejected",
  "extensions.approval.recorded",
  "extensions.approval.revoked",
  "extensions.enabled.toggled",
  "extensions.reload.invoked",
  "extensions.cache.miss",
  "extensions.cache.hit",
  "extensions.diagnostic.emitted",
];

/**
 * Field classification within an event's allowlist.
 *
 * - `scalar`: counts, durations (ms), booleans, status enums, diagnostic
 *   codes, severity. Always-allowed; no provenance check applied. Numbers,
 *   booleans, and short enum strings are accepted as-is.
 * - `identifier`: extensionId / contributionId style fields. Gated on
 *   (matches Reserved Extension Identity Prefix) AND (rootKind === 'bundled').
 *   Either gate failing drops the field.
 */
export type ExtensionTelemetryFieldKind = "scalar" | "identifier";

/**
 * Closed per-event allowlist. Any field not listed here is silently dropped.
 *
 * Forbidden categories (project paths, package names, third-party extension
 * identities, requested-capability lists, file paths, lockfile contents) are
 * absent from every entry by construction; aggregate counts (e.g.
 * `capabilityCount`) are how aggregate state is exposed instead.
 */
export const EXTENSION_TELEMETRY_FIELD_ALLOWLIST: Readonly<
  Record<ExtensionTelemetryEventName, Readonly<Record<string, ExtensionTelemetryFieldKind>>>
> = {
  "extensions.discovery.completed": {
    durationMs: "scalar",
    rootCount: "scalar",
    extensionCount: "scalar",
    contributionCount: "scalar",
    diagnosticCount: "scalar",
    cacheHit: "scalar",
  },
  "extensions.discovery.failed": {
    rootKind: "scalar",
    diagnosticCode: "scalar",
    durationMs: "scalar",
  },
  "extensions.migration.activated": {
    extensionId: "identifier",
    durationMs: "scalar",
  },
  "extensions.consent.shortcut.accepted": {
    rootKind: "scalar",
  },
  "extensions.consent.shortcut.rejected": {
    rootKind: "scalar",
  },
  "extensions.approval.recorded": {
    extensionId: "identifier",
    rootKind: "scalar",
    capabilityCount: "scalar",
  },
  "extensions.approval.revoked": {
    extensionId: "identifier",
    rootKind: "scalar",
  },
  "extensions.enabled.toggled": {
    extensionId: "identifier",
    rootKind: "scalar",
    enabled: "scalar",
  },
  "extensions.reload.invoked": {
    rootKind: "scalar",
    durationMs: "scalar",
  },
  "extensions.cache.miss": {
    reason: "scalar",
  },
  "extensions.cache.hit": {
    durationMs: "scalar",
  },
  "extensions.diagnostic.emitted": {
    extensionId: "identifier",
    contributionId: "identifier",
    diagnosticCode: "scalar",
    severity: "scalar",
    rootKind: "scalar",
  },
};

export interface ExtensionTelemetryProvenance {
  /**
   * The rootKind of the Extension that triggered this event. For host-internal
   * events without a single owning Extension (cache miss/hit, platform toggle,
   * consent shortcut) the rootKind is still required so identifier-class
   * fields cannot leak even if a caller mistakenly populates one — it has to
   * be 'bundled' to allow identifier emission.
   */
  rootKind: RootKind;
}

export interface GatedExtensionTelemetryEvent {
  event: ExtensionTelemetryEventName;
  properties: Record<string, string | number | boolean>;
}

export interface GateExtensionTelemetryEventInput {
  event: ExtensionTelemetryEventName;
  properties: Readonly<Record<string, unknown>>;
  provenance: ExtensionTelemetryProvenance;
}

/**
 * Pure provenance gate. Returns the sanitized payload that may be forwarded
 * to PostHog — drops any field not in the per-event allowlist, drops scalar
 * fields whose values aren't string|number|boolean, and drops identifier
 * fields unless BOTH the regex gate and the rootKind === 'bundled' gate pass.
 */
export function gateExtensionTelemetryEvent(
  input: GateExtensionTelemetryEventInput
): GatedExtensionTelemetryEvent {
  const allowlist = EXTENSION_TELEMETRY_FIELD_ALLOWLIST[input.event];
  const properties: Record<string, string | number | boolean> = {};

  for (const [key, value] of Object.entries(input.properties)) {
    const kind = allowlist[key];
    if (kind === undefined) continue;
    if (kind === "scalar") {
      if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
        properties[key] = value;
      }
      continue;
    }
    // identifier
    if (typeof value !== "string") continue;
    if (!RESERVED_EXTENSION_IDENTITY_PREFIX_REGEX.test(value)) continue;
    if (input.provenance.rootKind !== "bundled") continue;
    properties[key] = value;
  }

  return { event: input.event, properties };
}
