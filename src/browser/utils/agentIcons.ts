import { Bot, Route, SquareCode } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Maps well-known agent IDs to lucide icons. Shared between the
 * AgentModePicker (the small pill in the chat-input bar) and the
 * Instructions pane so the same agent always shows the same glyph.
 */
const AGENT_ICONS: Record<string, LucideIcon> = {
  plan: Route,
  exec: SquareCode,
};

const DEFAULT_AGENT_ICON: LucideIcon = Bot;

export function getAgentIcon(agentId: string): LucideIcon {
  return AGENT_ICONS[agentId] ?? DEFAULT_AGENT_ICON;
}
