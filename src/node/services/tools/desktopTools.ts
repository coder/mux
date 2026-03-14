import { type Tool, tool } from "ai";

import type { DesktopActionType } from "@/common/types/desktop";
import type { ToolErrorResult } from "@/common/types/tools";
import { getErrorMessage } from "@/common/utils/errors";
import { TOOL_DEFINITIONS } from "@/common/utils/tools/toolDefinitions";
import type { ToolConfiguration } from "@/common/utils/tools/tools";
import assert from "@/common/utils/assert";
import type { DesktopSessionManager } from "@/node/services/desktop/DesktopSessionManager";

type DesktopActionToolResult =
  | {
      success: true;
      message: string;
    }
  | ToolErrorResult;

type DesktopScreenshotToolResult =
  | {
      type: "content";
      value: [
        {
          type: "text";
          text: string;
        },
        {
          type: "media";
          mediaType: "image/png";
          data: string;
        },
      ];
    }
  | ToolErrorResult;

function getWorkspaceId(
  config: ToolConfiguration,
  toolName: string
): string | { success: false; error: string } {
  if (config.workspaceId == null) {
    return {
      success: false,
      error: `${toolName} requires workspaceId`,
    };
  }

  return config.workspaceId;
}

function getDesktopActionError(toolName: string, result: { error?: string }): ToolErrorResult {
  return {
    success: false,
    error: result.error ?? `${toolName} failed`,
  };
}

async function executeDesktopAction(
  config: ToolConfiguration,
  desktopManager: DesktopSessionManager,
  toolName: string,
  actionType: DesktopActionType,
  params: Record<string, unknown>,
  successMessage: string
): Promise<DesktopActionToolResult> {
  const workspaceId = getWorkspaceId(config, toolName);
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }

  assert(successMessage.length > 0, `${toolName} success message must not be empty`);

  try {
    const result = await desktopManager.action(workspaceId, actionType, params);
    if (!result.success) {
      return getDesktopActionError(toolName, result);
    }

    return {
      success: true,
      message: successMessage,
    };
  } catch (error) {
    return {
      success: false,
      error: getErrorMessage(error),
    };
  }
}

export function createDesktopTools(
  config: ToolConfiguration,
  desktopManager: DesktopSessionManager
): Record<string, Tool> {
  return {
    desktop_screenshot: tool({
      description: TOOL_DEFINITIONS.desktop_screenshot.description,
      inputSchema: TOOL_DEFINITIONS.desktop_screenshot.schema,
      execute: async ({ scaledWidth, scaledHeight }): Promise<DesktopScreenshotToolResult> => {
        // Accept scaling hints in the schema now so the tool contract is stable when backend
        // screenshot resizing support lands. The current manager API always captures full size.
        void scaledWidth;
        void scaledHeight;

        const workspaceId = getWorkspaceId(config, "desktop_screenshot");
        if (typeof workspaceId !== "string") {
          return workspaceId;
        }

        try {
          const screenshot = await desktopManager.screenshot(workspaceId);
          assert(screenshot.mimeType === "image/png", "Desktop screenshots must be PNG images");
          assert(screenshot.imageBase64.length > 0, "Desktop screenshot payload must not be empty");
          assert(screenshot.width > 0, "Desktop screenshot width must be positive");
          assert(screenshot.height > 0, "Desktop screenshot height must be positive");

          return {
            type: "content",
            value: [
              {
                type: "text",
                text: `Desktop screenshot captured: ${screenshot.width}x${screenshot.height}`,
              },
              {
                type: "media",
                mediaType: screenshot.mimeType,
                data: screenshot.imageBase64,
              },
            ],
          };
        } catch (error) {
          return {
            success: false,
            error: getErrorMessage(error),
          };
        }
      },
    }),
    desktop_move_mouse: tool({
      description: TOOL_DEFINITIONS.desktop_move_mouse.description,
      inputSchema: TOOL_DEFINITIONS.desktop_move_mouse.schema,
      execute: ({ x, y }): Promise<DesktopActionToolResult> =>
        executeDesktopAction(
          config,
          desktopManager,
          "desktop_move_mouse",
          "move_mouse",
          { x, y },
          `Moved mouse to (${x}, ${y})`
        ),
    }),
    desktop_click: tool({
      description: TOOL_DEFINITIONS.desktop_click.description,
      inputSchema: TOOL_DEFINITIONS.desktop_click.schema,
      execute: ({ x, y, button }): Promise<DesktopActionToolResult> => {
        const resolvedButton = button ?? "left";
        const actionType: DesktopActionType = resolvedButton === "right" ? "right_click" : "click";
        const buttonLabel = resolvedButton === "right" ? "right-clicked" : "Clicked";
        return executeDesktopAction(
          config,
          desktopManager,
          "desktop_click",
          actionType,
          { x, y },
          `${buttonLabel} at (${x}, ${y})`
        );
      },
    }),
    desktop_double_click: tool({
      description: TOOL_DEFINITIONS.desktop_double_click.description,
      inputSchema: TOOL_DEFINITIONS.desktop_double_click.schema,
      execute: ({ x, y }): Promise<DesktopActionToolResult> => {
        return executeDesktopAction(
          config,
          desktopManager,
          "desktop_double_click",
          "double_click",
          { x, y },
          `Double-clicked at (${x}, ${y})`
        );
      },
    }),
    desktop_drag: tool({
      description: TOOL_DEFINITIONS.desktop_drag.description,
      inputSchema: TOOL_DEFINITIONS.desktop_drag.schema,
      execute: ({ startX, startY, endX, endY }): Promise<DesktopActionToolResult> =>
        executeDesktopAction(
          config,
          desktopManager,
          "desktop_drag",
          "drag",
          { startX, startY, endX, endY },
          `Dragged from (${startX}, ${startY}) to (${endX}, ${endY})`
        ),
    }),
    desktop_scroll: tool({
      description: TOOL_DEFINITIONS.desktop_scroll.description,
      inputSchema: TOOL_DEFINITIONS.desktop_scroll.schema,
      execute: ({ x, y, deltaX, deltaY }): Promise<DesktopActionToolResult> => {
        const params: Record<string, unknown> = { x, y, deltaY };
        if (deltaX != null) {
          params.deltaX = deltaX;
        }

        return executeDesktopAction(
          config,
          desktopManager,
          "desktop_scroll",
          "scroll",
          params,
          `Scrolled at (${x}, ${y}) by (${deltaX ?? 0}, ${deltaY})`
        );
      },
    }),
    desktop_type: tool({
      description: TOOL_DEFINITIONS.desktop_type.description,
      inputSchema: TOOL_DEFINITIONS.desktop_type.schema,
      execute: ({ text }): Promise<DesktopActionToolResult> =>
        executeDesktopAction(
          config,
          desktopManager,
          "desktop_type",
          "type_text",
          { text },
          `Typed ${text.length} characters`
        ),
    }),
    desktop_key_press: tool({
      description: TOOL_DEFINITIONS.desktop_key_press.description,
      inputSchema: TOOL_DEFINITIONS.desktop_key_press.schema,
      execute: ({ key }): Promise<DesktopActionToolResult> =>
        executeDesktopAction(
          config,
          desktopManager,
          "desktop_key_press",
          "key_press",
          { key },
          `Pressed key: ${key}`
        ),
    }),
  };
}
