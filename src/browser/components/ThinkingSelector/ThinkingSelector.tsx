import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Zap } from "lucide-react";

import { useAPI } from "@/browser/contexts/API";
import { useMinThinkingLevels } from "@/browser/hooks/useMinThinkingLevels";
import { useProvidersConfig } from "@/browser/hooks/useProvidersConfig";
import { useReasoningMode } from "@/browser/hooks/useReasoningMode";
import { useRouting } from "@/browser/hooks/useRouting";
import { useThinkingLevel } from "@/browser/hooks/useThinkingLevel";
import { stopKeyboardPropagation } from "@/browser/utils/events";
import {
  applyFastModeServiceTierChange,
  getFastModeProvider,
} from "@/browser/utils/fastModeServiceTier";
import { formatKeybind, KEYBINDS } from "@/browser/utils/ui/keybinds";
import { cn } from "@/common/lib/utils";
import { getThinkingDisplayLabel, type ThinkingLevel } from "@/common/types/thinking";
import { openaiProModeAvailable } from "@/common/utils/ai/proMode";
import { normalizeToCanonical } from "@/common/utils/ai/models";
import { enforceThinkingPolicy, getAvailableThinkingLevels } from "@/common/utils/thinking/policy";
import { COMPOSER_PRO_HIDE_CLASS } from "@/constants/layout";
import { COMPOSER_PICKER_PANEL_CLASS, composerPickerOptionClass } from "../composerPickerStyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "../Tooltip/Tooltip";

const THINKING_OPTION_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

interface ThinkingSelectorProps {
  modelString: string;
  /** Some embedded clients cannot resolve route-aware provider options safely. */
  allowProMode?: boolean;
  /** Some embedded clients do not expose provider configuration mutations. */
  allowFastMode?: boolean;
}

export const ThinkingSelector: React.FC<ThinkingSelectorProps> = (props) => {
  const { api } = useAPI();
  const [thinkingLevel, setThinkingLevel] = useThinkingLevel();
  const [reasoningMode, setReasoningMode] = useReasoningMode();
  const { getMinimum } = useMinThinkingLevels();
  const { config: providersConfig, refresh, updateOptimistically } = useProvidersConfig();
  const routing = useRouting();
  const [isOpen, setIsOpen] = useState(false);
  const [fastModeSaving, setFastModeSaving] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Resolve mapped aliases so the selector offers the target model's ladder
  // (e.g. an alias mapped to GPT-5.6 exposes native max).
  const minimum = getMinimum(props.modelString);
  const allowed = getAvailableThinkingLevels(props.modelString, minimum, providersConfig);
  const effectiveThinkingLevel = enforceThinkingPolicy(
    props.modelString,
    thinkingLevel,
    minimum,
    providersConfig
  );
  const displayLabel = getThinkingDisplayLabel(effectiveThinkingLevel, props.modelString);
  const resolvedRoute = routing.resolveRoute(normalizeToCanonical(props.modelString)).route;
  const proModeAvailable =
    props.allowProMode !== false &&
    openaiProModeAvailable(props.modelString, {
      providersConfig,
      resolvedRouteProvider: resolvedRoute,
    });
  const fastModeProvider =
    props.allowFastMode !== false && providersConfig != null
      ? getFastModeProvider(props.modelString, {
          providersConfig,
          resolvedRouteProvider: resolvedRoute,
        })
      : null;
  const fastModeAvailable = fastModeProvider != null;
  const proModeActive = proModeAvailable && reasoningMode === "pro";
  const fastModeActive =
    fastModeProvider != null && providersConfig?.[fastModeProvider]?.serviceTier === "priority";
  const hasMenu = allowed.length > 1 || proModeAvailable || fastModeAvailable;

  // The menu is rendered inline for happy-dom coverage, so a document listener is the
  // deterministic way to dismiss it when the user clicks elsewhere.
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleFastModeToggle = async () => {
    if (!api || fastModeSaving || providersConfig == null || fastModeProvider == null) return;

    setFastModeSaving(true);
    try {
      const providerConfig = providersConfig[fastModeProvider];
      const change = await applyFastModeServiceTierChange(
        api.providers,
        fastModeProvider,
        providerConfig?.serviceTier,
        providerConfig?.fastModePreviousServiceTier
      );
      if (change) {
        updateOptimistically(fastModeProvider, {
          serviceTier: change.serviceTier,
          fastModePreviousServiceTier: change.previousServiceTier,
        });
      } else {
        await refresh();
      }
    } catch {
      await refresh();
    } finally {
      setFastModeSaving(false);
    }
  };

  if (!hasMenu) {
    const fixedLevel = allowed[0] ?? "off";
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="text-foreground w-[5ch] shrink-0 text-center text-[11px] font-medium select-none"
            aria-label={`Thinking level fixed to ${fixedLevel}`}
          >
            {getThinkingDisplayLabel(fixedLevel, props.modelString)}
          </span>
        </TooltipTrigger>
        <TooltipContent align="center">
          Model {props.modelString} locks thinking at{" "}
          {getThinkingDisplayLabel(fixedLevel, props.modelString)} to match its capabilities.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative flex shrink-0 items-center"
      data-component="ThinkingSelector"
      onKeyDown={(event) => {
        if (event.key === "Escape" && isOpen) {
          event.preventDefault();
          stopKeyboardPropagation(event);
          setIsOpen(false);
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-thinking-selector-trigger
            className="text-foreground hover:bg-hover focus-visible:bg-hover focus-visible:text-accent flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm bg-transparent py-0 pr-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none"
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            aria-label={`Thinking: ${effectiveThinkingLevel}${proModeActive ? ", pro mode" : ""}${fastModeActive ? ", fast mode" : ""}`}
            onClick={() => setIsOpen((previous) => !previous)}
          >
            <span data-thinking-label className="min-w-[3ch] text-center">
              {displayLabel}
            </span>
            {proModeActive && (
              <span
                data-thinking-pro-status
                className={cn(
                  "border-border-medium text-muted ml-0.5 rounded-[3px] border bg-transparent px-1 text-[9px] leading-[14px] font-semibold tracking-wide",
                  COMPOSER_PRO_HIDE_CLASS
                )}
              >
                PRO
              </span>
            )}
            {fastModeActive && (
              <Zap
                data-fast-mode-indicator
                className="text-thinking-mode h-3 w-3 shrink-0"
                fill="currentColor"
                aria-label="Fast mode enabled"
              />
            )}
            <ChevronDown
              className={cn(
                "text-muted h-3 w-3 shrink-0 transition-transform duration-150",
                isOpen && "rotate-180"
              )}
              aria-hidden
            />
          </button>
        </TooltipTrigger>
        <TooltipContent align="center">
          Select thinking effort.
          <span className="mobile-hide-shortcut-hints">
            {" "}
            {formatKeybind(KEYBINDS.DECREASE_THINKING)} /{" "}
            {formatKeybind(KEYBINDS.INCREASE_THINKING)} to step.
          </span>
        </TooltipContent>
      </Tooltip>

      {isOpen && (
        <div
          className={cn(
            "absolute bottom-full left-0 z-[1020] mb-1 w-52",
            COMPOSER_PICKER_PANEL_CLASS
          )}
          data-component="ThinkingSelectorMenu"
        >
          <div className="text-muted border-border-light border-b px-2.5 py-1.5 text-[10px] font-semibold tracking-wide uppercase">
            Reasoning effort
          </div>
          <div className="py-1" role="listbox" aria-label="Reasoning effort">
            {allowed.map((level) => {
              const selected = level === effectiveThinkingLevel;
              return (
                <button
                  key={level}
                  type="button"
                  role="option"
                  aria-label={THINKING_OPTION_LABELS[level]}
                  aria-selected={selected}
                  className={composerPickerOptionClass(
                    { isHighlighted: false, isSelected: selected },
                    "w-full py-1.5 text-left"
                  )}
                  onClick={() => setThinkingLevel(level)}
                >
                  <span className="text-foreground min-w-0 flex-1">
                    {THINKING_OPTION_LABELS[level]}
                  </span>
                  {selected && <Check className="text-accent h-3 w-3 shrink-0" aria-hidden />}
                </button>
              );
            })}
          </div>

          {(proModeAvailable || fastModeAvailable) && (
            <div className="border-border-light border-t py-1">
              {proModeAvailable && (
                <button
                  type="button"
                  data-component="ProModeToggle"
                  aria-pressed={proModeActive}
                  className="hover:bg-hover flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors"
                  onClick={() => setReasoningMode(proModeActive ? "standard" : "pro")}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-[11px] font-medium">Pro mode</span>
                    <span className="text-muted block text-[10px] font-normal">
                      More reliable on difficult tasks
                    </span>
                  </span>
                  {proModeActive && <Check className="text-thinking-mode h-3 w-3" aria-hidden />}
                </button>
              )}

              {fastModeAvailable && (
                <button
                  type="button"
                  data-component="FastModeToggle"
                  aria-pressed={fastModeActive}
                  disabled={fastModeSaving}
                  className="hover:bg-hover disabled:text-muted flex w-full items-center gap-2.5 px-2.5 py-1.5 text-left transition-colors disabled:cursor-default"
                  onClick={() => {
                    handleFastModeToggle().catch(() => undefined);
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground block text-[11px] font-medium">Fast mode</span>
                    <span className="text-muted block text-[10px] font-normal">
                      Faster responses at higher cost
                    </span>
                  </span>
                  {fastModeActive && <Check className="text-accent h-3 w-3 shrink-0" aria-hidden />}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
