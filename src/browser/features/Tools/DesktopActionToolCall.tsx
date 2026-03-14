import React from "react";
import type { ToolErrorResult } from "@/common/types/tools";
import { assertNever } from "@/common/utils/assertNever";
import {
  ErrorBox,
  StatusIndicator,
  ToolContainer,
  ToolDetails,
  ToolHeader,
  ToolIcon,
} from "./Shared/ToolPrimitives";
import { getStatusDisplay, isToolErrorResult, type ToolStatus } from "./Shared/toolUtils";

type DesktopActionToolName =
  | "desktop_move_mouse"
  | "desktop_click"
  | "desktop_double_click"
  | "desktop_drag"
  | "desktop_scroll"
  | "desktop_type"
  | "desktop_key_press";

interface DesktopMoveMouseArgs {
  x: number;
  y: number;
}

interface DesktopClickArgs extends DesktopMoveMouseArgs {
  button?: "left" | "right" | "middle" | null;
}

interface DesktopDragArgs {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

interface DesktopScrollArgs extends DesktopMoveMouseArgs {
  deltaX?: number | null;
  deltaY: number;
}

interface DesktopTypeArgs {
  text: string;
}

interface DesktopKeyPressArgs {
  key: string;
}

type DesktopActionArgs =
  | DesktopMoveMouseArgs
  | DesktopClickArgs
  | DesktopDragArgs
  | DesktopScrollArgs
  | DesktopTypeArgs
  | DesktopKeyPressArgs;

interface DesktopActionSuccessResult {
  success: true;
  message?: string;
}

function isDesktopActionSuccessResult(result: unknown): result is DesktopActionSuccessResult {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { success?: unknown }).success === true &&
    (typeof (result as { message?: unknown }).message === "string" ||
      (result as { message?: unknown }).message === undefined)
  );
}

interface DesktopActionToolCallProps {
  toolName: DesktopActionToolName;
  args: DesktopActionArgs;
  result?: DesktopActionSuccessResult | ToolErrorResult;
  status?: ToolStatus;
}

function formatCoordinates(x: number, y: number): string {
  return `(${x}, ${y})`;
}

function getClickVerb(
  button: "left" | "right" | "middle" | null | undefined,
  clickType: "single" | "double"
): string {
  if (clickType === "single") {
    if (button == null || button === "left") {
      return "Clicked";
    }
    return `${button}-clicked`;
  }

  if (button == null || button === "left") {
    return "Double-clicked";
  }
  return `${button} double-clicked`;
}

function truncateText(text: string, maxLength = 60): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function getDesktopActionSummary(toolName: DesktopActionToolName, args: DesktopActionArgs): string {
  switch (toolName) {
    case "desktop_move_mouse": {
      const moveArgs = args as DesktopMoveMouseArgs;
      return `Moved mouse to ${formatCoordinates(moveArgs.x, moveArgs.y)}`;
    }
    case "desktop_click": {
      const clickArgs = args as DesktopClickArgs;
      return `${getClickVerb(clickArgs.button, "single")} at ${formatCoordinates(clickArgs.x, clickArgs.y)}`;
    }
    case "desktop_double_click": {
      const doubleClickArgs = args as DesktopClickArgs;
      return `${getClickVerb(doubleClickArgs.button, "double")} at ${formatCoordinates(doubleClickArgs.x, doubleClickArgs.y)}`;
    }
    case "desktop_drag": {
      const dragArgs = args as DesktopDragArgs;
      return `Dragged from ${formatCoordinates(dragArgs.startX, dragArgs.startY)} to ${formatCoordinates(dragArgs.endX, dragArgs.endY)}`;
    }
    case "desktop_scroll": {
      const scrollArgs = args as DesktopScrollArgs;
      const horizontalDelta = scrollArgs.deltaX != null ? `, Δx ${scrollArgs.deltaX}` : "";
      return `Scrolled at ${formatCoordinates(scrollArgs.x, scrollArgs.y)} (Δy ${scrollArgs.deltaY}${horizontalDelta})`;
    }
    case "desktop_type": {
      const typeArgs = args as DesktopTypeArgs;
      return `Typed: “${truncateText(typeArgs.text)}”`;
    }
    case "desktop_key_press": {
      const keyPressArgs = args as DesktopKeyPressArgs;
      return `Pressed: ${truncateText(keyPressArgs.key, 40)}`;
    }
    default:
      return assertNever(toolName);
  }
}

export const DesktopActionToolCall: React.FC<DesktopActionToolCallProps> = ({
  toolName,
  args,
  result,
  status = "pending",
}) => {
  const errorResult = isToolErrorResult(result) ? result : null;
  const successResult = isDesktopActionSuccessResult(result) ? result : null;
  const summary = successResult?.message ?? getDesktopActionSummary(toolName, args);
  const shouldShowDetails = errorResult !== null;

  return (
    <ToolContainer expanded={shouldShowDetails}>
      <ToolHeader className="hover:text-secondary cursor-default">
        <ToolIcon toolName={toolName} />
        <div className="text-text min-w-0 flex-1 truncate">{summary}</div>
        <StatusIndicator status={status}>{getStatusDisplay(status)}</StatusIndicator>
      </ToolHeader>

      {shouldShowDetails && (
        <ToolDetails>
          <ErrorBox>{errorResult.error}</ErrorBox>
        </ToolDetails>
      )}
    </ToolContainer>
  );
};
