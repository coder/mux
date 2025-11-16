import { useCallback } from "react";
import { trackEvent, getBaseTelemetryProperties, roundToBase2 } from "@/node/telemetry";
import type { ErrorContext } from "@/node/telemetry/payload";

/**
 * Hook for clean telemetry integration in React components
 *
 * Provides type-safe telemetry tracking with base properties automatically included.
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
        ...getBaseTelemetryProperties(),
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
        ...getBaseTelemetryProperties(),
        workspaceId,
      },
    });
  }, []);

  const messageSent = useCallback((model: string, mode: string, messageLength: number) => {
    console.debug("[useTelemetry] messageSent called", { model, mode, messageLength });
    trackEvent({
      event: "message_sent",
      properties: {
        ...getBaseTelemetryProperties(),
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
        ...getBaseTelemetryProperties(),
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
