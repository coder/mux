import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  MessageCircleQuestionMark,
  Route,
  Sparkles,
  SquareCode,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { useAgent } from "@/browser/contexts/AgentContext";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { cn } from "@/common/lib/utils";
import { DocsLink } from "@/browser/components/DocsLink";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/browser/components/ui/tooltip";
import { Button } from "@/browser/components/ui/button";
import { Switch } from "@/browser/components/ui/switch";
import {
  formatKeybind,
  formatNumberedKeybind,
  KEYBINDS,
  matchNumberedKeybind,
} from "@/browser/utils/ui/keybinds";
import { sortAgentsStable } from "@/browser/utils/agents";
import { stopKeyboardPropagation } from "@/browser/utils/events";

interface AgentModePickerProps {
  className?: string;

  /** Called when the picker closes (best-effort). Useful for restoring focus. */
  onComplete?: () => void;
}

interface AgentOption {
  id: string;
  name: string;
  uiColor?: string;
  description?: string;
  /** Source scope: built-in, project, or global */
  scope: "built-in" | "project" | "global";
  /** Base agent ID for inheritance */
  base?: string;
  /** Tool add/remove patterns */
  tools?: { add?: string[]; remove?: string[] };
  /** AI defaults (model, thinking level) */
  aiDefaults?: { model?: string; thinkingLevel?: string };
  /** Whether this agent can be spawned as a subagent */
  subagentRunnable: boolean;
}

/** Maps well-known agent IDs to lucide icons for the dropdown */
const AGENT_ICONS: Record<string, LucideIcon> = {
  ask: MessageCircleQuestionMark,
  plan: Route,
  exec: SquareCode,
  orchestrator: Workflow,
  auto: Sparkles,
};
const DEFAULT_AGENT_ICON: LucideIcon = Bot;

function getAgentIcon(agentId: string): LucideIcon {
  return AGENT_ICONS[agentId] ?? DEFAULT_AGENT_ICON;
}

export function formatAgentIdLabel(agentId: string): string {
  if (!agentId) {
    return "Agent";
  }

  // Best-effort humanization for IDs (e.g. "code-review" -> "Code Review").
  const parts = agentId.split(/[-_]+/g).filter((part) => part.length > 0);
  if (parts.length === 0) {
    return agentId;
  }

  return parts
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function normalizeAgentId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : "";
}

const AgentHelpTooltip: React.FC = () => (
  <Tooltip>
    <TooltipTrigger asChild>
      <HelpIndicator>?</HelpIndicator>
    </TooltipTrigger>
    <TooltipContent align="center" className="max-w-80 whitespace-normal">
      Selects an agent definition (system prompt + tool policy).
      <br />
      <br />
      Open picker: {formatKeybind(KEYBINDS.TOGGLE_AGENT)}
      <br />
      Cycle agents: {formatKeybind(KEYBINDS.CYCLE_AGENT)}
      <br />
      Quick select: {formatNumberedKeybind(0).replace("1", "1-9")} (when open)
      <br />
      <br />
      <DocsLink path="/agents">Learn more about agents</DocsLink>
    </TooltipContent>
  </Tooltip>
);

function resolveAgentOptions(agents: AgentDefinitionDescriptor[]): AgentOption[] {
  return sortAgentsStable(agents.filter((entry) => entry.uiSelectable));
}

export const AgentModePicker: React.FC<AgentModePickerProps> = (props) => {
  const { agentId, setAgentId, agents, loaded } = useAgent();

  const onComplete = props.onComplete;

  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownItemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const normalizedAgentId = useMemo(() => normalizeAgentId(agentId), [agentId]);

  const options = useMemo(() => resolveAgentOptions(agents), [agents]);

  // Non-auto options shown as selectable items in the dropdown
  const selectableOptions = useMemo(() => options.filter((opt) => opt.id !== "auto"), [options]);

  // Auto is only available when the backend discovers it in the agent list
  const autoAvailable = useMemo(() => options.some((opt) => opt.id === "auto"), [options]);

  // Only lock the list when auto is both selected AND available — if auto was
  // persisted but later removed from the agent list, users must still be able
  // to pick a different agent from the dropdown.
  const isAuto = normalizedAgentId === "auto" && autoAvailable;

  const activeOption = useMemo(() => {
    if (!normalizedAgentId) {
      return null;
    }

    const descriptor = agents.find((entry) => entry.id === normalizedAgentId);
    if (!descriptor) {
      // Unknown agent (not in discovery) — show a fallback option
      return {
        id: normalizedAgentId,
        name: formatAgentIdLabel(normalizedAgentId),
        uiColor: undefined,
        scope: "project" as const,
        subagentRunnable: false,
      } satisfies AgentOption;
    }

    return {
      id: descriptor.id,
      name: descriptor.name,
      uiColor: descriptor.uiColor,
      description: descriptor.description,
      scope: descriptor.scope,
      base: descriptor.base,
      tools: descriptor.tools,
      aiDefaults: descriptor.aiDefaults,
      subagentRunnable: descriptor.subagentRunnable,
    } satisfies AgentOption;
  }, [agents, normalizedAgentId]);

  const openPicker = useCallback(
    (opts?: { highlightAgentId?: string }) => {
      setIsPickerOpen(true);

      // Pre-select the current agent (or specified) in the list.
      const targetId = opts?.highlightAgentId ?? normalizedAgentId;
      const currentIndex = selectableOptions.findIndex((opt) => opt.id === targetId);
      setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);

      // Focus the dropdown container for keyboard navigation.
      requestAnimationFrame(() => {
        dropdownRef.current?.focus();
      });
    },
    [normalizedAgentId, selectableOptions]
  );

  const closePicker = useCallback(() => {
    setIsPickerOpen(false);
    setHighlightedIndex(-1);
    onComplete?.();
  }, [onComplete]);

  // Hotkey integration (open via AgentContext).
  useEffect(() => {
    const handleOpen = () => {
      openPicker({ highlightAgentId: normalizedAgentId });
    };

    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpen as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpen as EventListener);
  }, [normalizedAgentId, openPicker]);

  useEffect(() => {
    const handleClose = () => {
      if (!isPickerOpen) {
        return;
      }
      closePicker();
    };

    window.addEventListener(CUSTOM_EVENTS.CLOSE_AGENT_PICKER, handleClose as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.CLOSE_AGENT_PICKER, handleClose as EventListener);
  }, [closePicker, isPickerOpen]);

  // Close picker when clicking outside.
  useEffect(() => {
    if (!isPickerOpen) {
      return;
    }

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current?.contains(e.target as Node)) {
        return;
      }
      closePicker();
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [closePicker, isPickerOpen]);

  // Scroll highlighted item into view.
  useEffect(() => {
    if (highlightedIndex < 0) {
      return;
    }

    const el = dropdownItemRefs.current[highlightedIndex];
    el?.scrollIntoView?.({ block: "nearest" });
  }, [highlightedIndex]);

  const handleSelectAgent = useCallback(
    (nextAgentId: string) => {
      const normalized = normalizeAgentId(nextAgentId);
      if (!normalized) {
        return;
      }

      setAgentId(normalized);
      closePicker();
    },
    [closePicker, setAgentId]
  );

  // Global Cmd/Ctrl+1-9 shortcuts when dropdown is open.
  useEffect(() => {
    if (!isPickerOpen) return;

    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const index = matchNumberedKeybind(e);
      if (index < 0) return;

      e.preventDefault();
      e.stopPropagation();

      // Don't allow numbered shortcuts to bypass Auto lock
      if (isAuto) return;

      // Use selectableOptions so keybinds match the visible dropdown items
      if (index < selectableOptions.length) {
        const picked = selectableOptions[index];
        if (picked) {
          handleSelectAgent(picked.id);
        }
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [isPickerOpen, isAuto, selectableOptions, handleSelectAgent]);

  const handleDropdownKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      // Block capture-phase listeners (e.g. ImmersiveReviewView) from
      // consuming Escape before the picker closes
      stopKeyboardPropagation(e);
      closePicker();
      return;
    }

    // Don't navigate agents list when auto is active
    if (isAuto) return;

    if (e.key === "Enter") {
      // Only handle Enter for agent rows — don't intercept when focus is on
      // the auto-select Switch (which has role="switch")
      const target = e.target as HTMLElement;
      if (target.getAttribute("role") === "switch") return;

      e.preventDefault();
      if (selectableOptions.length === 0) return;

      const selectedIndex = highlightedIndex >= 0 ? highlightedIndex : 0;
      const picked = selectableOptions[selectedIndex];
      if (picked) {
        handleSelectAgent(picked.id);
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, selectableOptions.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (highlightedIndex <= 0) {
        closePicker();
        return;
      }
      setHighlightedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
  };

  // Resolve display properties for the trigger pill
  const activeDisplayName = activeOption?.name ?? formatAgentIdLabel(normalizedAgentId);
  const activeStyle: React.CSSProperties | undefined = activeOption?.uiColor
    ? { borderColor: activeOption.uiColor }
    : undefined;
  const activeClassName = activeOption?.uiColor ? "" : "border-exec-mode";
  const TriggerIcon = getAgentIcon(normalizedAgentId);

  return (
    <div ref={containerRef} className={cn("relative flex items-center gap-1.5", props.className)}>
      {/* Dropdown trigger */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            aria-label="Select agent"
            aria-expanded={isPickerOpen}
            size="xs"
            variant="ghost"
            onClick={() => {
              if (isPickerOpen) {
                closePicker();
              } else {
                openPicker();
              }
            }}
            style={activeStyle}
            className={cn(
              "text-foreground hover:bg-hover flex items-center gap-1.5 rounded-sm border-[0.5px] px-1.5 py-0.5 text-[11px] font-medium transition-all duration-150",
              activeClassName
            )}
          >
            <TriggerIcon
              className="h-3 w-3 shrink-0"
              style={activeOption?.uiColor ? { color: activeOption.uiColor } : undefined}
            />
            <span className="max-w-[clamp(4.5rem,30vw,130px)] truncate">{activeDisplayName}</span>
            <ChevronDown
              className={cn(
                "text-muted h-3 w-3 transition-transform duration-150",
                isPickerOpen && "rotate-180"
              )}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent align="center">
          Select agent{" "}
          <span className="mobile-hide-shortcut-hints">
            ({formatKeybind(KEYBINDS.TOGGLE_AGENT)})
          </span>
        </TooltipContent>
      </Tooltip>

      {/* Tooltip is hover-only; hide it on touch + narrow layouts to avoid overlap. */}
      <div className="hidden [@container(min-width:420px)]:[@media(hover:hover)_and_(pointer:fine)]:block">
        <AgentHelpTooltip />
      </div>

      {isPickerOpen && (
        <div
          ref={dropdownRef}
          tabIndex={-1}
          onKeyDown={handleDropdownKeyDown}
          className="bg-separator border-border-light absolute right-0 bottom-full z-[1020] mb-1 min-w-52 overflow-hidden rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)] outline-none"
        >
          {/* Agent list — greyed out when auto is active, scrollable for long lists */}
          <div
            className={cn(
              "max-h-64 overflow-y-auto py-1",
              isAuto && "pointer-events-none opacity-50"
            )}
          >
            {!loaded && selectableOptions.length === 0 ? (
              <div className="text-muted-light px-2.5 py-2 text-[11px]">Loading agents…</div>
            ) : selectableOptions.length === 0 ? (
              <div className="text-muted-light px-2.5 py-2 text-[11px]">No agents available</div>
            ) : (
              selectableOptions.map((opt, index) => {
                const isHighlighted = index === highlightedIndex && !isAuto;
                const isSelected = opt.id === normalizedAgentId;
                const Icon = getAgentIcon(opt.id);
                // Keybind label matches the item's position in selectableOptions
                const keybindLabel = formatNumberedKeybind(index);

                return (
                  <div
                    key={opt.id}
                    ref={(el) => (dropdownItemRefs.current[index] = el)}
                    role="button"
                    tabIndex={-1}
                    data-agent-id={opt.id}
                    data-testid="agent-option"
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 px-2.5 py-1.5 transition-colors duration-100",
                      isHighlighted ? "bg-hover text-foreground" : "bg-transparent hover:bg-hover",
                      isSelected ? "text-foreground" : "text-light hover:text-foreground"
                    )}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => handleSelectAgent(opt.id)}
                  >
                    <Icon
                      className="h-4 w-4 shrink-0"
                      style={opt.uiColor ? { color: opt.uiColor } : undefined}
                    />
                    <span
                      data-testid="agent-name"
                      className={cn(
                        "min-w-0 flex-1 truncate text-[11px] font-medium",
                        isSelected && "text-accent"
                      )}
                    >
                      {opt.name}
                    </span>
                    {keybindLabel && (
                      <span className="text-muted-light mobile-hide-shortcut-hints ml-auto text-[10px] tabular-nums">
                        {keybindLabel}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Divider + Auto toggle — only shown when auto agent is available */}
          {autoAvailable && (
            <div className="border-border border-t px-2.5 py-1.5">
              <div
                role="button"
                tabIndex={-1}
                className="flex cursor-pointer items-center gap-2"
                onClick={() => {
                  if (isAuto) {
                    // Turn off auto → default to exec (first built-in)
                    setAgentId("exec");
                  } else {
                    setAgentId("auto");
                  }
                  closePicker();
                }}
              >
                {/* Wrapper stops propagation so the parent div's onClick
                   doesn't double-fire when clicking the Switch directly */}
                <span onClick={(e) => e.stopPropagation()}>
                  <Switch
                    checked={isAuto}
                    size="sm"
                    onCheckedChange={(checked) => {
                      setAgentId(checked ? "auto" : "exec");
                      closePicker();
                    }}
                    aria-label="Auto-select agent"
                  />
                </span>
                <div className="flex flex-col">
                  <span className="text-foreground text-[11px] font-medium">Auto</span>
                  <span className="text-muted text-[10px] leading-tight">
                    Mux chooses the best agent
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
