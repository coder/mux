import { resolveModelAlias, isValidModelFormat } from "@/common/utils/ai/models";
import { migrateGatewayModel } from "@/browser/hooks/useGatewayModels";

export interface ModelInputResult {
  model: string | null;
  isAlias: boolean;
  error?: "invalid-format";
}

/** Normalize user-provided model input (alias resolution + gateway migration + format validation). */
export function normalizeModelInput(raw: string | null | undefined): ModelInputResult {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { model: null, isAlias: false };
  }

  const resolved = resolveModelAlias(trimmed);
  const isAlias = resolved !== trimmed;
  const canonical = migrateGatewayModel(resolved).trim();

  if (!isValidModelFormat(canonical)) {
    return { model: null, isAlias, error: "invalid-format" };
  }

  const separatorIndex = canonical.indexOf(":");
  if (canonical.slice(separatorIndex + 1).startsWith(":")) {
    return { model: null, isAlias, error: "invalid-format" };
  }

  return { model: canonical, isAlias };
}
