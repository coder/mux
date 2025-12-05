import { useCallback } from "react";
import { trackEvent, roundToBase2, getFrontendPlatformInfo } from "@/common/telemetry";
import type {
  ErrorContext,
  TelemetryRuntimeType,
  TelemetryThinkingLevel,
  TelemetryCommandType,
} from "@/common/telemetry/payload";

/**
 * Hook for clean telemetry integration in React components
 *
 * Provides type-safe telemetry tracking. Base properties (version, platform, etc.)
 * are automatically added by the backend TelemetryService.
 *
 * Usage:
 *
 * ```tsx
 * const telemetry = useTelemetry();
 *
 * // Track workspace switch
 * telemetry.workspaceSwitched(fromId, toId);
 *
 * // Track workspace creation (runtimeType: 'local' | 'worktree' | 'ssh')
 * telemetry.workspaceCreated(workspaceId, runtimeType);
 *
 * // Track message sent
 * telemetry.messageSent(model, mode, messageLength, runtimeType, thinkingLevel);
 *
 * // Track stream completion
 * telemetry.streamCompleted(model, wasInterrupted, durationSecs, outputTokens);
 *
 * // Track provider configuration
 * telemetry.providerConfigured(provider, keyType);
 *
 * // Track command usage
 * telemetry.commandUsed(commandType);
 *
 * // Track voice transcription
 * telemetry.voiceTranscription(audioDurationSecs, success);
 *
 * // Track error
 * telemetry.errorOccurred(errorType, context);
 * ```
 */
export function useTelemetry() {
  const workspaceSwitched = useCallback((fromWorkspaceId: string, toWorkspaceId: string) => {
    console.debug("[useTelemetry] workspaceSwitched called", { fromWorkspaceId, toWorkspaceId });
    trackEvent({
      event: "workspace_switched",
      properties: {
        fromWorkspaceId,
        toWorkspaceId,
      },
    });
  }, []);

  const workspaceCreated = useCallback((workspaceId: string, runtimeType: TelemetryRuntimeType) => {
    const frontendPlatform = getFrontendPlatformInfo();
    console.debug("[useTelemetry] workspaceCreated called", {
      workspaceId,
      runtimeType,
      frontendPlatform,
    });
    trackEvent({
      event: "workspace_created",
      properties: {
        workspaceId,
        runtimeType,
        frontendPlatform,
      },
    });
  }, []);

  const messageSent = useCallback(
    (
      model: string,
      mode: string,
      messageLength: number,
      runtimeType: TelemetryRuntimeType,
      thinkingLevel: TelemetryThinkingLevel
    ) => {
      const frontendPlatform = getFrontendPlatformInfo();
      console.debug("[useTelemetry] messageSent called", {
        model,
        mode,
        messageLength,
        runtimeType,
        thinkingLevel,
        frontendPlatform,
      });
      trackEvent({
        event: "message_sent",
        properties: {
          model,
          mode,
          message_length_b2: roundToBase2(messageLength),
          runtimeType,
          frontendPlatform,
          thinkingLevel,
        },
      });
    },
    []
  );

  const streamCompleted = useCallback(
    (model: string, wasInterrupted: boolean, durationSecs: number, outputTokens: number) => {
      console.debug("[useTelemetry] streamCompleted called", {
        model,
        wasInterrupted,
        durationSecs,
        outputTokens,
      });
      trackEvent({
        event: "stream_completed",
        properties: {
          model,
          wasInterrupted,
          duration_b2: roundToBase2(durationSecs),
          output_tokens_b2: roundToBase2(outputTokens),
        },
      });
    },
    []
  );

  const providerConfigured = useCallback((provider: string, keyType: string) => {
    console.debug("[useTelemetry] providerConfigured called", { provider, keyType });
    trackEvent({
      event: "provider_configured",
      properties: {
        provider,
        keyType,
      },
    });
  }, []);

  const commandUsed = useCallback((command: TelemetryCommandType) => {
    console.debug("[useTelemetry] commandUsed called", { command });
    trackEvent({
      event: "command_used",
      properties: {
        command,
      },
    });
  }, []);

  const voiceTranscription = useCallback((audioDurationSecs: number, success: boolean) => {
    console.debug("[useTelemetry] voiceTranscription called", { audioDurationSecs, success });
    trackEvent({
      event: "voice_transcription",
      properties: {
        audio_duration_b2: roundToBase2(audioDurationSecs),
        success,
      },
    });
  }, []);

  const errorOccurred = useCallback((errorType: string, context: ErrorContext) => {
    console.debug("[useTelemetry] errorOccurred called", { errorType, context });
    trackEvent({
      event: "error_occurred",
      properties: {
        errorType,
        context,
      },
    });
  }, []);

  return {
    workspaceSwitched,
    workspaceCreated,
    messageSent,
    streamCompleted,
    providerConfigured,
    commandUsed,
    voiceTranscription,
    errorOccurred,
  };
}
