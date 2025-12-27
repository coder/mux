import { useEffect } from "react";
import { useMode } from "@/browser/contexts/ModeContext";
import {
  readPersistedState,
  updatePersistedState,
  usePersistedState,
} from "@/browser/hooks/usePersistedState";
import {
  getModelKey,
  getThinkingLevelKey,
  getWorkspaceAISettingsByModeKey,
  MODE_AI_DEFAULTS_KEY,
} from "@/common/constants/storage";
import { getDefaultModel } from "@/browser/hooks/useModelsFromSettings";
import { enforceThinkingPolicy } from "@/common/utils/thinking/policy";
import { coerceThinkingLevel, type ThinkingLevel } from "@/common/types/thinking";
import type { ModeAiDefaults } from "@/common/types/modeAiDefaults";

type WorkspaceAISettingsByModeCache = Partial<
  Record<"plan" | "exec", { model: string; thinkingLevel: ThinkingLevel }>
>;

export function WorkspaceModeAISync(props: { workspaceId: string }): null {
  const workspaceId = props.workspaceId;
  const [mode] = useMode();

  const [modeAiDefaults] = usePersistedState<ModeAiDefaults>(
    MODE_AI_DEFAULTS_KEY,
    {},
    {
      listener: true,
    }
  );
  const [workspaceByMode] = usePersistedState<WorkspaceAISettingsByModeCache>(
    getWorkspaceAISettingsByModeKey(workspaceId),
    {},
    { listener: true }
  );

  useEffect(() => {
    const fallbackModel = getDefaultModel();
    const modelKey = getModelKey(workspaceId);
    const thinkingKey = getThinkingLevelKey(workspaceId);

    const existingModel = readPersistedState<string>(modelKey, fallbackModel);
    const candidateModel =
      workspaceByMode[mode]?.model ?? modeAiDefaults[mode]?.modelString ?? existingModel;
    const resolvedModel =
      typeof candidateModel === "string" && candidateModel.trim().length > 0
        ? candidateModel
        : fallbackModel;

    const existingThinking = readPersistedState<ThinkingLevel>(thinkingKey, "off");
    const candidateThinking =
      workspaceByMode[mode]?.thinkingLevel ??
      modeAiDefaults[mode]?.thinkingLevel ??
      existingThinking ??
      "off";
    const resolvedThinking = coerceThinkingLevel(candidateThinking) ?? "off";

    const effectiveThinking = enforceThinkingPolicy(resolvedModel, resolvedThinking);

    if (existingModel !== resolvedModel) {
      updatePersistedState(modelKey, resolvedModel);
    }

    if (existingThinking !== effectiveThinking) {
      updatePersistedState(thinkingKey, effectiveThinking);
    }
  }, [mode, modeAiDefaults, workspaceByMode, workspaceId]);

  return null;
}
