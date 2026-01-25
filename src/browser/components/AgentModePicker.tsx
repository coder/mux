import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, FolderX, RefreshCw } from "lucide-react";

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
import {
  formatKeybind,
  formatNumberedKeybind,
  KEYBINDS,
  matchNumberedKeybind,
} from "@/browser/utils/ui/keybinds";
import { sortAgentsStable } from "@/browser/utils/agents";

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

function formatAgentIdLabel(agentId: string): string {
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

function formatScope(scope: AgentOption["scope"]): string {
  switch (scope) {
    case "built-in":
      return "Built-in";
    case "project":
      return "Project";
    case "global":
      return "Global";
  }
}

/** Renders the rich tooltip content for an agent option */
const AgentTooltipContent: React.FC<{ opt: AgentOption }> = ({ opt }) => {
  const hasAdd = (opt.tools?.add?.length ?? 0) > 0;
  const hasRemove = (opt.tools?.remove?.length ?? 0) > 0;
  const hasToolsOverrides = hasAdd || hasRemove;
  const hasAiDefaults = Boolean(opt.aiDefaults?.model ?? opt.aiDefaults?.thinkingLevel);

  return (
    <div className="space-y-1.5 text-[10px]">
      {opt.description && <div className="text-light">{opt.description}</div>}

      <div className="text-muted">
        <span className="text-muted-light">Source:</span> {formatScope(opt.scope)}
      </div>

      {opt.base && (
        <div className="text-muted">
          <span className="text-muted-light">Base:</span> {opt.base}
        </div>
      )}

      {hasAiDefaults && (
        <div className="text-muted">
          <span className="text-muted-light">AI:</span>{" "}
          {[opt.aiDefaults?.model, opt.aiDefaults?.thinkingLevel].filter(Boolean).join(", ")}
        </div>
      )}

      {(hasToolsOverrides || opt.base) && (
        <div className="text-muted space-y-0.5">
          <span className="text-muted-light">Tools:</span>
          {hasAdd &&
            opt.tools!.add!.map((pattern) => (
              <div key={pattern} className="ml-2">
                <span className="text-green-500">+</span> {pattern}
              </div>
            ))}
          {hasRemove &&
            opt.tools!.remove!.map((pattern) => (
              <div key={pattern} className="ml-2">
                <span className="text-red-500">−</span> {pattern}
              </div>
            ))}
          {!hasToolsOverrides && opt.base && (
            <div className="text-muted-light ml-2">inherited from base</div>
          )}
        </div>
      )}

      {opt.subagentRunnable && (
        <div className="text-muted">
          <span className="text-muted-light">Subagent:</span> runnable
        </div>
      )}
    </div>
  );
};

/** Returns true if an agent has any tooltip-worthy content */
function hasTooltipContent(opt: AgentOption): boolean {
  if (opt.description) return true;
  if (opt.base) return true;
  if (opt.aiDefaults?.model) return true;
  if (opt.aiDefaults?.thinkingLevel) return true;
  if ((opt.tools?.add?.length ?? 0) > 0) return true;
  if ((opt.tools?.remove?.length ?? 0) > 0) return true;
  if (opt.subagentRunnable) return true;
  return false;
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
  const {
    agentId,
    setAgentId,
    agents,
    refresh,
    refreshing,
    disableWorkspaceAgents,
    setDisableWorkspaceAgents,
  } = useAgent();

  const onComplete = props.onComplete;

  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownItemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const normalizedAgentId = useMemo(() => normalizeAgentId(agentId), [agentId]);

  const options = useMemo(() => resolveAgentOptions(agents), [agents]);

  const activeOption = useMemo(() => {
    if (!normalizedAgentId) {
      return null;
    }

    const descriptor = agents.find((entry) => entry.id === normalizedAgentId);
    if (!descriptor) {
      // Unknown agent (not in discovery) - show a fallback option
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

  const filteredOptions = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (query.length === 0) {
      return options;
    }

    return options.filter((opt) => {
      if (opt.id.toLowerCase().includes(query)) return true;
      if (opt.name.toLowerCase().includes(query)) return true;
      return false;
    });
  }, [filter, options]);

  const openPicker = useCallback(
    (opts?: { highlightAgentId?: string }) => {
      setIsPickerOpen(true);
      setFilter("");

      // Pre-select the current agent (or specified) in the list.
      const targetId = opts?.highlightAgentId ?? normalizedAgentId;
      const currentIndex = options.findIndex((opt) => opt.id === targetId);
      setHighlightedIndex(currentIndex >= 0 ? currentIndex : 0);

      // Focus the search input after the dropdown renders.
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    },
    [normalizedAgentId, options]
  );

  const closePicker = useCallback(() => {
    setIsPickerOpen(false);
    setFilter("");
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

  // Keep highlight in-bounds when the filtered list changes.
  useEffect(() => {
    if (filteredOptions.length === 0) {
      setHighlightedIndex(-1);
      return;
    }
    if (highlightedIndex >= filteredOptions.length) {
      setHighlightedIndex(filteredOptions.length - 1);
    }
  }, [filteredOptions.length, highlightedIndex]);

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

      // Use options (not filteredOptions) for consistent keybinds
      if (index < options.length) {
        const picked = options[index];
        if (picked) {
          handleSelectAgent(picked.id);
        }
      }
    };

    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handleGlobalKeyDown, true);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown, true);
  }, [isPickerOpen, options, handleSelectAgent]);

  const handlePickerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePicker();
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      if (filteredOptions.length === 0) {
        return;
      }

      const selectedIndex = highlightedIndex >= 0 ? highlightedIndex : 0;
      const picked = filteredOptions[selectedIndex];
      if (!picked) {
        return;
      }

      handleSelectAgent(picked.id);
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedIndex((prev) => Math.min(prev + 1, filteredOptions.length - 1));
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      // When we're already at the top (or nothing is highlighted), treat ArrowUp
      // as a close/cancel action.
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
    ? { backgroundColor: activeOption.uiColor }
    : undefined;
  const activeClassName = activeOption?.uiColor
    ? "text-white"
    : "bg-exec-mode text-white hover:bg-exec-mode-hover";

  return (
    <div ref={containerRef} className={cn("relative flex items-center gap-1.5", props.className)}>
      {/* Dropdown trigger - pill style button */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Select agent"
            aria-expanded={isPickerOpen}
            onClick={() => {
              if (isPickerOpen) {
                closePicker();
              } else {
                openPicker();
              }
            }}
            style={activeStyle}
            className={cn(
              "flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[11px] font-medium transition-all duration-150",
              activeClassName
            )}
          >
            <span className="max-w-[130px] truncate">{activeDisplayName}</span>
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform duration-150",
                isPickerOpen && "rotate-180"
              )}
            />
          </button>
        </TooltipTrigger>
        <TooltipContent align="center">
          Select agent ({formatKeybind(KEYBINDS.TOGGLE_AGENT)})
        </TooltipContent>
      </Tooltip>

      <AgentHelpTooltip />

      {isPickerOpen && (
        <div className="bg-separator border-border-light absolute right-0 bottom-full z-[1020] mb-1 max-w-[420px] min-w-72 overflow-hidden rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
          <div className="border-border-light flex items-center gap-1.5 border-b p-1.5">
            <input
              ref={inputRef}
              value={filter}
              onChange={(e) => {
                const value = e.target.value;
                setFilter(value);

                // Auto-highlight first result.
                const query = value.trim().toLowerCase();
                const next =
                  query.length === 0
                    ? options
                    : options.filter((opt) => {
                        if (opt.id.toLowerCase().includes(query)) return true;
                        if (opt.name.toLowerCase().includes(query)) return true;
                        return false;
                      });

                setHighlightedIndex(next.length > 0 ? 0 : -1);
              }}
              onKeyDown={handlePickerKeyDown}
              placeholder="Search agents…"
              className="text-light bg-dark border-border-light focus:border-exec-mode min-w-0 flex-1 rounded-sm border px-1 py-0.5 text-[10px] leading-[11px] outline-none"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={
                    disableWorkspaceAgents
                      ? "Workspace agents disabled (click to enable)"
                      : "Workspace agents enabled (click to disable)"
                  }
                  onClick={() => setDisableWorkspaceAgents((prev) => !prev)}
                  className={cn(
                    "flex-shrink-0 p-0.5 transition-colors",
                    disableWorkspaceAgents
                      ? "text-red-500 hover:text-red-400"
                      : "text-muted hover:text-foreground"
                  )}
                >
                  <FolderX className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end" className="max-w-56">
                {disableWorkspaceAgents ? (
                  <span className="text-red-400">
                    Workspace agents disabled — using built-in/global only. Click to re-enable.
                  </span>
                ) : (
                  "Disable workspace agents (use built-in/global only)"
                )}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Reload agents"
                  onClick={() => void refresh()}
                  className={cn(
                    "text-muted hover:text-foreground flex-shrink-0 p-0.5 transition-colors",
                    refreshing && "text-accent"
                  )}
                >
                  <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" align="end">
                {refreshing ? "Reloading…" : "Reload agent definitions"}
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="max-h-[220px] overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="text-muted-light px-2.5 py-2 text-[11px]">No matching agents</div>
            ) : (
              filteredOptions.map((opt, index) => {
                const isHighlighted = index === highlightedIndex;
                // Show keybind for first 9 items (based on position in full options list)
                const optionIndex = options.findIndex((o) => o.id === opt.id);
                const keybindLabel = formatNumberedKeybind(optionIndex);
                return (
                  <div
                    key={opt.id}
                    ref={(el) => (dropdownItemRefs.current[index] = el)}
                    role="button"
                    tabIndex={-1}
                    data-agent-id={opt.id}
                    className={cn(
                      "px-2.5 py-1.5 cursor-pointer transition-colors duration-100",
                      "first:rounded-t last:rounded-b",
                      isHighlighted
                        ? "text-foreground bg-hover"
                        : "text-light bg-transparent hover:bg-hover hover:text-foreground"
                    )}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => handleSelectAgent(opt.id)}
                  >
                    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
                      <span
                        data-testid="agent-name"
                        className="min-w-0 truncate text-[11px] font-medium"
                      >
                        {opt.name}
                      </span>
                      <span data-testid="agent-id" className="text-muted-light text-[10px]">
                        {opt.id}
                      </span>
                      {hasTooltipContent(opt) && (
                        <Tooltip>
                          <TooltipTrigger
                            asChild
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            <HelpIndicator className="ml-0.5">?</HelpIndicator>
                          </TooltipTrigger>
                          <TooltipContent
                            side="left"
                            align="center"
                            className="max-w-72 whitespace-normal"
                          >
                            <AgentTooltipContent opt={opt} />
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {keybindLabel && (
                        <span className="text-muted-light ml-1 text-[10px] tabular-nums">
                          {keybindLabel}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
