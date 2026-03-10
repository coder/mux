import { PROVIDER_DEFINITIONS, type ProviderName } from "@/common/constants/providers";
import {
  resolveModelAlias,
  isValidModelFormat,
  normalizeToCanonical,
} from "@/common/utils/ai/models";

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
  const colonIdx = resolved.indexOf(":");
  const prefix = colonIdx > 0 ? resolved.slice(0, colonIdx) : undefined;
  const isExplicitGateway =
    prefix != null && PROVIDER_DEFINITIONS[prefix as ProviderName]?.kind === "gateway";
  // Explicit gateway scoping is user intent — preserve it for the backend to honor.
  const canonical = isExplicitGateway ? resolved.trim() : normalizeToCanonical(resolved).trim();

  if (!isValidModelFormat(canonical)) {
    return { model: null, isAlias, error: "invalid-format" };
  }

  const separatorIndex = canonical.indexOf(":");
  if (canonical.slice(separatorIndex + 1).startsWith(":")) {
    return { model: null, isAlias, error: "invalid-format" };
  }

  return { model: canonical, isAlias };
}
