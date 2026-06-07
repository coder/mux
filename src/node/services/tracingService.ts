/**
 * OpenTelemetry tracing service (main process only).
 *
 * Emits OTLP trace spans for mux agent activity — one trace per agent turn,
 * with the Vercel AI SDK's built-in `experimental_telemetry` contributing the
 * LLM/tool spans (`ai.streamText`, `ai.streamText.doStream`, `ai.toolCall`) and
 * their standard `gen_ai.*` semantic-convention attributes. The result is the
 * same kind of observability other coding agents ship (codex-cli, opencode):
 * traces/spans you can ship to any OTLP-compatible backend (Jaeger, Grafana
 * Tempo, SigNoz, Honeycomb, ...).
 *
 * This is an original implementation built directly on the upstream
 * OpenTelemetry SDK + the AI SDK telemetry hook — it does not vendor any code
 * from those projects. The span/attribute names it targets are open
 * OpenTelemetry semantic conventions, not project-specific schemas.
 *
 * Behavior:
 * - Opt-in and OFF by default. Enabled only when the operator configures a
 *   standard OTEL endpoint/service env var (so users with no backend pay
 *   nothing), and never when telemetry is explicitly disabled.
 * - Standard config: honors `OTEL_EXPORTER_OTLP_(TRACES_)ENDPOINT` /
 *   `_HEADERS` / `OTEL_SERVICE_NAME` exactly like any other OTEL app.
 * - Startup-safe: all setup is wrapped in try/catch and degrades to a no-op,
 *   per docs/AGENTS.md ("startup-time initialization must never crash").
 * - Node/main-process only; never imported by the renderer bundle (the SDK
 *   touches Node-only APIs).
 */

import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Tracer,
  type Attributes,
} from "@opentelemetry/api";
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { VERSION } from "@/version";
import { log } from "./log";

const DEFAULT_SERVICE_NAME = "mux";
/** Instrumentation scope name for spans we create ourselves (distinct from the AI SDK's "ai" scope). */
const TRACER_NAME = "mux";

/**
 * Env vars that, when set, opt the user into trace export. Mirrors how
 * opencode/codex gate their exporters: tracing turns on only once a collector
 * (or at minimum a service name) is configured, so the default experience is
 * unchanged.
 */
const TRACING_OPT_IN_ENV_VARS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_SERVICE_NAME",
] as const;

export function shouldEnableTracing(env: NodeJS.ProcessEnv): boolean {
  // Respect explicit opt-outs: mux's own kill switch and the OTEL standard one.
  // Keeping these in sync with the existing telemetry surface means a user who
  // disables telemetry disables tracing too.
  if (env.MUX_DISABLE_TELEMETRY === "1") {
    return false;
  }
  if (env.OTEL_SDK_DISABLED === "true") {
    return false;
  }
  return TRACING_OPT_IN_ENV_VARS.some((key) => (env[key] ?? "").trim().length > 0);
}

function getServiceName(env: NodeJS.ProcessEnv): string {
  const configured = env.OTEL_SERVICE_NAME?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_SERVICE_NAME;
}

function getServiceVersion(): string {
  if (
    typeof VERSION === "object" &&
    VERSION !== null &&
    typeof (VERSION as Record<string, unknown>).git_describe === "string"
  ) {
    return (VERSION as { git_describe: string }).git_describe;
  }
  return "unknown";
}

export class TracingService {
  private provider: NodeTracerProvider | null = null;
  private tracer: Tracer | null = null;
  /**
   * Whether prompt/response bodies may be attached to spans. Redacted by
   * default (matching codex's `log_user_prompt = false`); opt in with
   * `MUX_OTEL_RECORD_IO=1` when debugging against a private collector.
   */
  readonly recordIo: boolean = process.env.MUX_OTEL_RECORD_IO === "1";

  isEnabled(): boolean {
    return this.tracer !== null;
  }

  /** The tracer for our own spans, or null when tracing is disabled. */
  getTracer(): Tracer | null {
    return this.tracer;
  }

  /**
   * Initialize the OTLP exporter and register a global tracer provider.
   * Idempotent and never throws. Returns a promise to match the service
   * lifecycle interface even though setup is synchronous today.
   */
  initialize(): Promise<void> {
    if (this.tracer) {
      return Promise.resolve();
    }
    if (!shouldEnableTracing(process.env)) {
      return Promise.resolve();
    }

    try {
      const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: getServiceName(process.env),
        [ATTR_SERVICE_VERSION]: getServiceVersion(),
      });

      // Constructed with no explicit URL/headers so it reads the standard
      // OTEL_EXPORTER_OTLP_* env vars — operators configure mux the same way
      // they would any OpenTelemetry application.
      const exporter = new OTLPTraceExporter();
      const provider = new NodeTracerProvider({
        resource,
        spanProcessors: [new BatchSpanProcessor(exporter)],
      });

      // register() installs the global tracer provider plus a Node
      // AsyncLocalStorage context manager. The context manager is what lets the
      // AI SDK's spans nest under our turn span across async boundaries.
      provider.register();

      this.provider = provider;
      this.tracer = trace.getTracer(TRACER_NAME, getServiceVersion());
      log.info("[TracingService] OpenTelemetry tracing enabled", {
        service: getServiceName(process.env),
        recordIo: this.recordIo,
      });
    } catch (error) {
      // Telemetry must never take down startup.
      log.warn("[TracingService] Failed to initialize tracing; continuing without it", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.provider = null;
      this.tracer = null;
    }

    return Promise.resolve();
  }

  /**
   * Start a span without making it active. The caller owns its lifecycle and
   * must call {@link endSpan}. Returns undefined when tracing is disabled so
   * callers can pass it around without branching.
   */
  startSpan(name: string, attributes?: Attributes): Span | undefined {
    return this.tracer?.startSpan(name, attributes ? { attributes } : undefined);
  }

  /**
   * Run `fn` with `span` installed as the active span. Any spans created during
   * `fn` (including those the AI SDK creates) become children of `span`.
   * Passthrough when `span` is undefined (tracing disabled).
   */
  runInSpanContext<T>(span: Span | undefined, fn: () => T): T {
    if (!span) {
      return fn();
    }
    return context.with(trace.setSpan(context.active(), span), fn);
  }

  /** Finalize a span started via {@link startSpan}, recording an error if provided. */
  endSpan(span: Span | undefined, error?: unknown): void {
    if (!span) {
      return;
    }
    if (error !== undefined) {
      recordSpanError(span, error);
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }

  /** Flush pending spans and tear down the provider. Safe to call when disabled. */
  async shutdown(): Promise<void> {
    const provider = this.provider;
    this.provider = null;
    this.tracer = null;
    if (!provider) {
      return;
    }
    try {
      await provider.shutdown();
    } catch {
      // Shutdown failures are non-fatal.
    }
  }
}

function recordSpanError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else {
    span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
  }
}
