import React, { useEffect, useRef, useState } from "react";
import { useAPI } from "@/browser/contexts/API";
import { ModelSelector } from "@/browser/components/ModelSelector";
import { useModelsFromSettings } from "@/browser/hooks/useModelsFromSettings";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/browser/components/ui/select";
import { THINKING_LEVELS, type ThinkingLevel } from "@/common/types/thinking";
import { normalizeAgentAiDefaults, type AgentAiDefaults } from "@/common/types/agentAiDefaults";
import {
  normalizeModeAiDefaults,
  type ModeAiDefaults,
  type ModeAiDefaultsEntry,
} from "@/common/types/modeAiDefaults";
import { enforceThinkingPolicy, getThinkingPolicyForModel } from "@/common/utils/thinking/policy";
import { updatePersistedState } from "@/browser/hooks/usePersistedState";
import { AGENT_AI_DEFAULTS_KEY, MODE_AI_DEFAULTS_KEY } from "@/common/constants/storage";

const INHERIT = "__inherit__";
const ALL_THINKING_LEVELS = THINKING_LEVELS;

const MODE_ORDER = [
  { id: "plan", label: "Plan" },
  { id: "exec", label: "Exec" },
  { id: "compact", label: "Compact" },
] as const;

type ModeId = (typeof MODE_ORDER)[number]["id"];

function updateModeDefaultEntry(
  previous: ModeAiDefaults,
  mode: ModeId,
  update: (entry: ModeAiDefaultsEntry) => void
): ModeAiDefaults {
  const next = { ...previous };
  const existing = next[mode] ?? {};
  const updated: ModeAiDefaultsEntry = { ...existing };
  update(updated);

  if (updated.modelString && updated.thinkingLevel) {
    updated.thinkingLevel = enforceThinkingPolicy(updated.modelString, updated.thinkingLevel);
  }

  if (!updated.modelString && !updated.thinkingLevel) {
    delete next[mode];
  } else {
    next[mode] = updated;
  }

  return next;
}

export function ModesSection() {
  const { api } = useAPI();
  const { models, hiddenModels } = useModelsFromSettings();

  const [modeAiDefaults, setModeAiDefaults] = useState<ModeAiDefaults>({});
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const pendingSaveRef = useRef<ModeAiDefaults | null>(null);

  useEffect(() => {
    if (!api) return;

    setLoaded(false);
    setLoadFailed(false);
    setSaveError(null);

    void api.config
      .getConfig()
      .then((cfg) => {
        const normalized = normalizeModeAiDefaults(cfg.modeAiDefaults ?? {});
        setModeAiDefaults(normalized);
        // Keep a local cache for non-react readers (compaction handler, sync, etc.)
        updatePersistedState(MODE_AI_DEFAULTS_KEY, normalized);
        updatePersistedState(AGENT_AI_DEFAULTS_KEY, normalizeAgentAiDefaults(cfg.agentAiDefaults));
        setLoadFailed(false);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error));
        setLoadFailed(true);
        setLoaded(true);
      });
  }, [api]);

  useEffect(() => {
    if (!api) return;
    if (!loaded) return;
    if (loadFailed) return;

    pendingSaveRef.current = modeAiDefaults;
    updatePersistedState(MODE_AI_DEFAULTS_KEY, modeAiDefaults);
    updatePersistedState<AgentAiDefaults>(
      AGENT_AI_DEFAULTS_KEY,
      (prev) =>
        normalizeAgentAiDefaults({
          ...(prev && typeof prev === "object" ? prev : {}),
          plan: modeAiDefaults.plan,
          exec: modeAiDefaults.exec,
          compact: modeAiDefaults.compact,
        }),
      {}
    );

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }

    saveTimerRef.current = setTimeout(() => {
      const flush = () => {
        if (savingRef.current) return;
        if (!api) return;

        const payload = pendingSaveRef.current;
        if (!payload) return;

        pendingSaveRef.current = null;
        savingRef.current = true;
        void api.config
          .updateModeAiDefaults({ modeAiDefaults: payload })
          .catch((error: unknown) => {
            setSaveError(error instanceof Error ? error.message : String(error));
          })
          .finally(() => {
            savingRef.current = false;
            flush();
          });
      };

      flush();
    }, 400);

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [api, loaded, loadFailed, modeAiDefaults]);

  // Flush any pending debounced save on unmount so changes aren't lost.
  useEffect(() => {
    if (!api) return;
    if (!loaded) return;
    if (loadFailed) return;

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }

      if (savingRef.current) return;
      const payload = pendingSaveRef.current;
      if (!payload) return;

      pendingSaveRef.current = null;
      savingRef.current = true;
      void api.config
        .updateModeAiDefaults({ modeAiDefaults: payload })
        .catch(() => undefined)
        .finally(() => {
          savingRef.current = false;
        });
    };
  }, [api, loaded, loadFailed]);

  const setModeModel = (mode: ModeId, value: string) => {
    setModeAiDefaults((prev) =>
      updateModeDefaultEntry(prev, mode, (updated) => {
        if (value === INHERIT) {
          delete updated.modelString;
        } else {
          updated.modelString = value;
        }
      })
    );
  };

  const setModeThinking = (mode: ModeId, value: string) => {
    setModeAiDefaults((prev) =>
      updateModeDefaultEntry(prev, mode, (updated) => {
        if (value === INHERIT) {
          delete updated.thinkingLevel;
          return;
        }

        updated.thinkingLevel = value as ThinkingLevel;
      })
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-foreground mb-1 text-sm font-medium">Mode Defaults</h3>
        <div className="text-muted text-xs">
          Defaults apply globally. Changing model/reasoning in a workspace creates a workspace
          override.
        </div>

        {saveError && <div className="text-danger-light mt-3 text-xs">{saveError}</div>}
      </div>

      <div className="space-y-4">
        {MODE_ORDER.map((m) => {
          const entry = modeAiDefaults[m.id];
          const modelValue = entry?.modelString ?? INHERIT;
          const thinkingValue = entry?.thinkingLevel ?? INHERIT;
          const allowedThinkingLevels =
            modelValue !== INHERIT ? getThinkingPolicyForModel(modelValue) : ALL_THINKING_LEVELS;

          return (
            <div
              key={m.id}
              className="border-border-medium bg-background-secondary rounded-md border p-3"
            >
              <div className="text-foreground text-sm font-medium">{m.label}</div>

              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-1">
                  <div className="text-muted text-xs">Model</div>
                  <div className="flex items-center gap-2">
                    <ModelSelector
                      value={modelValue === INHERIT ? "" : modelValue}
                      emptyLabel="Inherit"
                      onChange={(value) => setModeModel(m.id, value)}
                      models={models}
                      hiddenModels={hiddenModels}
                    />
                    {modelValue !== INHERIT ? (
                      <button
                        type="button"
                        className="text-muted hover:text-foreground text-xs"
                        onClick={() => setModeModel(m.id, INHERIT)}
                      >
                        Reset
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="space-y-1">
                  <div className="text-muted text-xs">Reasoning</div>
                  <Select
                    value={thinkingValue}
                    onValueChange={(value) => setModeThinking(m.id, value)}
                  >
                    <SelectTrigger className="border-border-medium bg-modal-bg h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={INHERIT}>Inherit</SelectItem>
                      {allowedThinkingLevels.map((level) => (
                        <SelectItem key={level} value={level}>
                          {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
