import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

import { useAgent } from "@/browser/contexts/AgentContext";
import { usePersistedState } from "@/browser/hooks/usePersistedState";
import { CUSTOM_EVENTS } from "@/common/constants/events";
import {
  getPinnedAgentIdKey,
  getProjectScopeId,
  GLOBAL_SCOPE_ID,
} from "@/common/constants/storage";
import type { AgentDefinitionDescriptor } from "@/common/types/agentDefinition";
import { cn } from "@/common/lib/utils";
import {
  HelpIndicator,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/browser/components/ui/tooltip";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";

interface AgentModePickerProps {
  className?: string;

  /** Highest-priority scope for pin persistence. */
  workspaceId?: string;

  /** Fallback scope for pin persistence (used when workspaceId is not provided). */
  projectPath?: string;

  /** Called when the picker closes (best-effort). Useful for restoring focus. */
  onComplete?: () => void;
}

type PickerOpenReason = "manual" | "modeCycle";

interface AgentOption {
  id: string;
  name: string;
  policyBase: AgentDefinitionDescriptor["policyBase"];
  uiColor?: string;
}

function normalizeAgentId(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : "";
}

function getScopeId(workspaceId: string | undefined, projectPath: string | undefined): string {
  return workspaceId ?? (projectPath ? getProjectScopeId(projectPath) : GLOBAL_SCOPE_ID);
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
      Cycle between Exec → Plan → Other with: {formatKeybind(KEYBINDS.TOGGLE_MODE)}
    </TooltipContent>
  </Tooltip>
);

function resolveAgentOptions(agents: AgentDefinitionDescriptor[]): AgentOption[] {
  const selectable = agents.filter((entry) => entry.uiSelectable);

  // Defensive: If agent discovery failed (or is unavailable), fall back to Exec/Plan.
  const base: AgentOption[] =
    selectable.length > 0
      ? selectable.map((entry) => ({
          id: entry.id,
          name: entry.name,
          policyBase: entry.policyBase,
          uiColor: entry.uiColor,
        }))
      : [
          { id: "exec", name: "Exec", policyBase: "exec" },
          { id: "plan", name: "Plan", policyBase: "plan" },
        ];

  // Prefer showing Exec/Plan first in the picker (for discoverability / keyboard-only use).
  const exec = base.find((opt) => opt.id === "exec");
  const plan = base.find((opt) => opt.id === "plan");
  const rest = base.filter((opt) => opt.id !== "exec" && opt.id !== "plan");

  return [exec, plan, ...rest].filter((opt): opt is AgentOption => Boolean(opt));
}

function resolveActiveClassName(policyBase: AgentDefinitionDescriptor["policyBase"]): string {
  return policyBase === "plan"
    ? "bg-plan-mode text-white hover:bg-plan-mode-hover"
    : "bg-exec-mode text-white hover:bg-exec-mode-hover";
}

export const AgentModePicker: React.FC<AgentModePickerProps> = (props) => {
  const { agentId, setAgentId, agents } = useAgent();

  const onComplete = props.onComplete;

  const scopeId = useMemo(
    () => getScopeId(props.workspaceId, props.projectPath),
    [props.projectPath, props.workspaceId]
  );

  const [pinnedAgentIdRaw, setPinnedAgentIdRaw] = usePersistedState<string>(
    getPinnedAgentIdKey(scopeId),
    "",
    {
      listener: true,
    }
  );

  const pinnedAgentId = useMemo(() => normalizeAgentId(pinnedAgentIdRaw), [pinnedAgentIdRaw]);

  const options = useMemo(() => resolveAgentOptions(agents), [agents]);

  const pinnedOption = useMemo(
    () => options.find((opt) => opt.id === pinnedAgentId) ?? null,
    [options, pinnedAgentId]
  );

  // If the pinned agent no longer exists (file deleted / renamed), clear it.
  useEffect(() => {
    if (!pinnedAgentId) {
      return;
    }

    // If we can't validate the agent list (e.g., no workspace context), do not
    // clobber the user's pinned preference.
    if (agents.length === 0) {
      return;
    }

    if (pinnedOption) {
      return;
    }

    setPinnedAgentIdRaw("");
  }, [agents.length, pinnedAgentId, pinnedOption, setPinnedAgentIdRaw]);

  const effectivePinnedAgentId = pinnedOption?.id ?? "";

  const [openReason, setOpenReason] = useState<PickerOpenReason | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownItemRefs = useRef<Array<HTMLDivElement | null>>([]);

  const normalizedAgentId = useMemo(() => normalizeAgentId(agentId), [agentId]);

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

  const closePicker = useCallback(() => {
    setIsPickerOpen(false);
    setOpenReason(null);
    setFilter("");
    setHighlightedIndex(-1);
    onComplete?.();
  }, [onComplete]);

  const openPicker = useCallback(
    (opts?: { reason?: PickerOpenReason; highlightAgentId?: string }) => {
      setIsPickerOpen(true);
      setFilter("");
      setOpenReason(opts?.reason ?? "manual");

      const highlightId = normalizeAgentId(opts?.highlightAgentId) || normalizedAgentId;

      // Start with selected agent highlighted (if present in the list).
      const currentIndex = options.findIndex((opt) => opt.id === highlightId);
      setHighlightedIndex(currentIndex);
    },
    [normalizedAgentId, options]
  );

  // Hotkey integration (open/close via ModeContext).
  useEffect(() => {
    const handleOpen = () => {
      openPicker({
        reason: "modeCycle",
        highlightAgentId: effectivePinnedAgentId || normalizedAgentId,
      });
    };

    window.addEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpen as EventListener);
    return () =>
      window.removeEventListener(CUSTOM_EVENTS.OPEN_AGENT_PICKER, handleOpen as EventListener);
  }, [effectivePinnedAgentId, normalizedAgentId, openPicker]);

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

  // Focus input when picker opens.
  useEffect(() => {
    if (!isPickerOpen) {
      return;
    }

    // Defer to next paint so the input exists.
    const id = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    return () => clearTimeout(id);
  }, [isPickerOpen]);

  // Handle click outside to close.
  useEffect(() => {
    if (!isPickerOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closePicker();
      }
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

      // Only non-builtin agents should affect the pinned third option.
      if (normalized !== "exec" && normalized !== "plan") {
        setPinnedAgentIdRaw(normalized);
      }

      closePicker();
    },
    [closePicker, setAgentId, setPinnedAgentIdRaw]
  );

  const handlePickerKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (openReason === "modeCycle" && effectivePinnedAgentId) {
        setAgentId(effectivePinnedAgentId);
      }
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

  const thirdLabel = pinnedOption?.name ?? "Other…";
  const thirdIsActive =
    Boolean(effectivePinnedAgentId) && normalizedAgentId === effectivePinnedAgentId;

  const thirdActiveClassName = pinnedOption
    ? pinnedOption.uiColor
      ? "text-white"
      : resolveActiveClassName(pinnedOption.policyBase)
    : "";

  const thirdActiveStyle: React.CSSProperties | undefined =
    thirdIsActive && pinnedOption?.uiColor ? { backgroundColor: pinnedOption.uiColor } : undefined;

  const buttonBaseClassName =
    "px-1.5 py-0.5 text-[11px] font-sans rounded-sm border-none cursor-pointer transition-all duration-150 bg-transparent";

  const inactiveClassName =
    "text-toggle-text font-normal hover:text-toggle-text-hover hover:bg-toggle-hover";

  return (
    <div ref={containerRef} className={cn("relative flex items-center gap-1.5", props.className)}>
      <div className="bg-toggle-bg flex gap-0 rounded">
        {/* Exec */}
        <button
          type="button"
          onClick={() => {
            setAgentId("exec");
            onComplete?.();
          }}
          aria-pressed={normalizedAgentId === "exec"}
          className={cn(
            buttonBaseClassName,
            normalizedAgentId === "exec"
              ? "bg-exec-mode text-white hover:bg-exec-mode-hover font-medium"
              : inactiveClassName
          )}
        >
          Exec
        </button>

        {/* Plan */}
        <button
          type="button"
          onClick={() => {
            setAgentId("plan");
            onComplete?.();
          }}
          aria-pressed={normalizedAgentId === "plan"}
          className={cn(
            buttonBaseClassName,
            normalizedAgentId === "plan"
              ? "bg-plan-mode text-white hover:bg-plan-mode-hover font-medium"
              : inactiveClassName
          )}
        >
          Plan
        </button>

        {/* Pinned / Other */}
        <button
          type="button"
          onClick={() => {
            if (effectivePinnedAgentId) {
              setAgentId(effectivePinnedAgentId);
              onComplete?.();
              return;
            }
            openPicker();
          }}
          aria-pressed={thirdIsActive}
          style={thirdActiveStyle}
          className={cn(
            buttonBaseClassName,
            "flex items-center gap-1",
            thirdIsActive ? cn("font-medium", thirdActiveClassName) : inactiveClassName
          )}
        >
          <span className="max-w-[110px] truncate">{thirdLabel}</span>
        </button>
        <button
          type="button"
          aria-label="Choose agent"
          onClick={() => {
            openPicker();
          }}
          style={thirdActiveStyle}
          className={cn(
            buttonBaseClassName,
            "px-1",
            thirdIsActive ? cn("font-medium", thirdActiveClassName) : inactiveClassName
          )}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>

      <AgentHelpTooltip />

      {isPickerOpen && (
        <div className="bg-separator border-border-light absolute right-0 bottom-full z-[1020] mb-1 max-w-[420px] min-w-72 overflow-hidden rounded border shadow-[0_4px_12px_rgba(0,0,0,0.3)]">
          <div className="border-border-light border-b p-1.5">
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
              className="text-light bg-dark border-border-light focus:border-exec-mode w-full rounded-sm border px-1 py-0.5 text-[10px] leading-[11px] outline-none"
            />
          </div>

          <div className="max-h-[220px] overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="text-muted-light px-2.5 py-2 text-[11px]">No matching agents</div>
            ) : (
              filteredOptions.map((opt, index) => {
                const isHighlighted = index === highlightedIndex;
                return (
                  <div
                    key={opt.id}
                    ref={(el) => (dropdownItemRefs.current[index] = el)}
                    role="button"
                    tabIndex={-1}
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
                    <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                      <span className="min-w-0 truncate text-[11px] font-medium">{opt.name}</span>
                      <span className="text-muted-light text-[10px]">{opt.id}</span>
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
