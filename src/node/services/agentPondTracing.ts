import { createFilesSpanExporterFromRuntimeEnv } from "@agentpond/files-sdk/otel";
import { OpenTelemetry } from "@ai-sdk/otel";
import {
  isOpenInferenceSpan,
  OpenInferenceBatchSpanProcessor,
} from "@arizeai/openinference-vercel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { TelemetryOptions } from "ai";
import { log } from "./log";

const AGENTPOND_TRACING_STATE = Symbol.for("mux.agentpond-tracing");

interface AgentPondTracingState {
  provider: NodeTracerProvider;
  telemetry: TelemetryOptions;
}

type AgentPondGlobal = typeof globalThis & {
  [AGENTPOND_TRACING_STATE]?: AgentPondTracingState;
};

function createAgentPondTracingState(): AgentPondTracingState | undefined {
  // Agent traces can contain operational metadata, so users must explicitly
  // provide a Files SDK environment before Mux creates an exporter.
  if (!process.env.FILES_SDK_PROVIDER) {
    return undefined;
  }

  try {
    const provider = new NodeTracerProvider({
      spanProcessors: [
        new OpenInferenceBatchSpanProcessor({
          exporter: createFilesSpanExporterFromRuntimeEnv(),
          spanFilter: isOpenInferenceSpan,
          reparentOrphanedSpans: true,
        }),
      ],
    });

    return {
      provider,
      telemetry: {
        functionId: "mux-agent",
        integrations: [
          new OpenTelemetry({
            tracer: provider.getTracer("mux"),
            usage: true,
          }),
          {
            // Run after OpenTelemetry closes its spans so short-lived CLI turns
            // are durable before the process can exit.
            onEnd: flushAgentPondTracing,
            onAbort: flushAgentPondTracing,
            onError: flushAgentPondTracing,
          },
        ],
        isEnabled: true,
        recordInputs: false,
        recordOutputs: false,
      },
    };
  } catch (error) {
    // Optional tracing must never stop Mux from starting or serving an AI turn.
    log.warn("Failed to initialize AgentPond tracing", { error });
    return undefined;
  }
}

const agentPondGlobal = globalThis as AgentPondGlobal;
const tracingState =
  agentPondGlobal[AGENTPOND_TRACING_STATE] ??
  (agentPondGlobal[AGENTPOND_TRACING_STATE] = createAgentPondTracingState());

export const agentPondTelemetry = tracingState?.telemetry;

export async function flushAgentPondTracing(): Promise<void> {
  try {
    await tracingState?.provider.forceFlush();
  } catch (error) {
    log.warn("Failed to flush AgentPond tracing", { error });
  }
}
