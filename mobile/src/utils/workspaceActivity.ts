import type { WorkspaceActivitySnapshot } from "../types";
import { getModelDisplayName } from "./modelCatalog";

export interface WorkspaceActivityPresentation {
  label: string;
  detail?: string;
  tone: "active" | "attention" | "idle";
}

function normalizeLabel(value?: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeFallbackLabel(value: string): string | undefined {
  return value === "Unknown" ? undefined : value;
}

export function getWorkspaceActivityPresentation(
  activity: WorkspaceActivitySnapshot | undefined,
  fallbackLabel: string
): WorkspaceActivityPresentation {
  const fallbackDetail = normalizeFallbackLabel(fallbackLabel);
  const agentMessage = normalizeLabel(activity?.agentStatus?.message);

  if (!activity) {
    return {
      label: "Idle",
      detail: fallbackDetail,
      tone: "idle",
    };
  }

  if (activity.streaming) {
    return {
      label: activity.isIdleCompaction ? "Compacting" : (agentMessage ?? "Streaming"),
      detail: activity.lastModel ? getModelDisplayName(activity.lastModel) : undefined,
      tone: "active",
    };
  }

  if (agentMessage) {
    return {
      label: agentMessage,
      detail: fallbackDetail,
      tone: "active",
    };
  }

  if (activity.hasTodos) {
    return {
      label: "Needs follow-up",
      detail: fallbackDetail,
      tone: "attention",
    };
  }

  return {
    label: "Idle",
    detail: fallbackDetail,
    tone: "idle",
  };
}
