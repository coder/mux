import { useCallback } from "react";
import { trackEvent, roundToBase2 } from "@/common/telemetry";
import type { ErrorContext } from "@/common/telemetry/payload";

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
 * // Track workspace creation
 * telemetry.workspaceCreated(workspaceId);
 *
 * // Track message sent
 * telemetry.messageSent(model, mode, messageLength);
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

  const workspaceCreated = useCallback((workspaceId: string) => {
    console.debug("[useTelemetry] workspaceCreated called", { workspaceId });
    trackEvent({
      event: "workspace_created",
      properties: {
        workspaceId,
      },
    });
  }, []);

  const messageSent = useCallback((model: string, mode: string, messageLength: number) => {
    console.debug("[useTelemetry] messageSent called", { model, mode, messageLength });
    trackEvent({
      event: "message_sent",
      properties: {
        model,
        mode,
        message_length_b2: roundToBase2(messageLength),
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
    errorOccurred,
  };
}
