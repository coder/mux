/**
 * Extension Telemetry Layer (node wrapper).
 *
 * Composes a TelemetryService with the pure provenance gate
 * (`gateExtensionTelemetryEvent`) so every Extension event passes through
 * the allowlist + identifier-gating before reaching PostHog.
 *
 * Callers should never bypass this layer for Extension events; it enforces
 * the telemetry privacy invariants before data reaches PostHog.
 */

import {
  type ExtensionTelemetryEventName,
  type ExtensionTelemetryProvenance,
  gateExtensionTelemetryEvent,
} from "@/common/extensions/extensionTelemetry";

export interface ExtensionTelemetryCapture {
  event: ExtensionTelemetryEventName;
  properties: Readonly<Record<string, unknown>>;
  provenance: ExtensionTelemetryProvenance;
}

interface ExtensionTelemetrySink {
  captureExtensionEvent(
    event: ExtensionTelemetryEventName,
    properties: Record<string, string | number | boolean>
  ): void;
}

export class ExtensionTelemetryLayer {
  constructor(private readonly telemetry: ExtensionTelemetrySink) {}

  capture(input: ExtensionTelemetryCapture): void {
    const gated = gateExtensionTelemetryEvent(input);
    this.telemetry.captureExtensionEvent(gated.event, gated.properties);
  }
}
