import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { FrontendWorkspaceMetadata } from "@/common/types/workspace";

export function isWorkspaceForkSwitchEvent(
  event: Event
): event is CustomEvent<FrontendWorkspaceMetadata> {
  return event.type === CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH;
}

export function dispatchWorkspaceSwitch(workspaceInfo: FrontendWorkspaceMetadata): void {
  window.dispatchEvent(
    new CustomEvent(CUSTOM_EVENTS.WORKSPACE_FORK_SWITCH, {
      detail: workspaceInfo,
    })
  );
}
