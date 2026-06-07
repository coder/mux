import { afterEach, describe, expect, test } from "bun:test";
import { context, trace } from "@opentelemetry/api";

import { shouldEnableTracing, TracingService } from "./tracingService";

describe("shouldEnableTracing", () => {
  test("disabled when no OTEL env vars are set", () => {
    expect(shouldEnableTracing({})).toBe(false);
  });

  test("enabled when an OTLP endpoint is configured", () => {
    expect(shouldEnableTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318" })).toBe(
      true
    );
  });

  test("enabled when a traces-specific endpoint is configured", () => {
    expect(
      shouldEnableTracing({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces" })
    ).toBe(true);
  });

  test("enabled when only a service name is configured", () => {
    expect(shouldEnableTracing({ OTEL_SERVICE_NAME: "mux" })).toBe(true);
  });

  test("blank env values do not opt in", () => {
    expect(shouldEnableTracing({ OTEL_EXPORTER_OTLP_ENDPOINT: "   " })).toBe(false);
  });

  test("explicit mux opt-out wins over a configured endpoint", () => {
    expect(
      shouldEnableTracing({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
        MUX_DISABLE_TELEMETRY: "1",
      })
    ).toBe(false);
  });

  test("standard OTEL_SDK_DISABLED wins over a configured endpoint", () => {
    expect(
      shouldEnableTracing({
        OTEL_SERVICE_NAME: "mux",
        OTEL_SDK_DISABLED: "true",
      })
    ).toBe(false);
  });
});

describe("TracingService when disabled", () => {
  test("stays a no-op after initialize() with no configuration", async () => {
    const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const originalService = process.env.OTEL_SERVICE_NAME;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_SERVICE_NAME;
    try {
      const tracing = new TracingService();
      await tracing.initialize();

      expect(tracing.isEnabled()).toBe(false);
      expect(tracing.getTracer()).toBeNull();
      // No span is created, but the helpers must not throw.
      expect(tracing.startSpan("mux.stream")).toBeUndefined();
      // Context helper passes the callback through untouched.
      expect(tracing.runInSpanContext(undefined, () => 42)).toBe(42);
      // Ending a non-existent span and shutting down are safe.
      tracing.endSpan(undefined);
      await tracing.shutdown();
    } finally {
      if (original !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
      if (originalService !== undefined) process.env.OTEL_SERVICE_NAME = originalService;
    }
  });
});

describe("TracingService when enabled", () => {
  let tracing: TracingService | null = null;

  afterEach(async () => {
    await tracing?.shutdown();
    tracing = null;
  });

  test("produces real spans and propagates them as the active context", async () => {
    const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    try {
      tracing = new TracingService();
      await tracing.initialize();

      expect(tracing.isEnabled()).toBe(true);

      const span = tracing.startSpan("mux.stream", { "mux.workspace.id": "ws-1" });
      expect(span).toBeDefined();

      // The span we created should be the active span inside runInSpanContext,
      // which is what lets the AI SDK nest its spans beneath ours.
      const activeSpanId = tracing.runInSpanContext(
        span,
        () => trace.getSpan(context.active())?.spanContext().spanId
      );
      expect(activeSpanId).toBe(span!.spanContext().spanId);

      tracing.endSpan(span);
    } finally {
      if (original !== undefined) {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
      } else {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      }
    }
  });
});
