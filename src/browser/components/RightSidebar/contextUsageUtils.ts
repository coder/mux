import type { TokenMeterData } from "@/common/utils/tokens/tokenMeterUtils";

export interface OutputReserveInfo {
  threshold: number | null;
  tokens: number | null;
}

export function getOutputReserveInfo(data: TokenMeterData): OutputReserveInfo {
  if (!data.maxTokens || !data.maxOutputTokens) {
    return { threshold: null, tokens: null };
  }

  if (data.maxOutputTokens <= 0 || data.maxOutputTokens >= data.maxTokens) {
    return { threshold: null, tokens: null };
  }

  const raw = ((data.maxTokens - data.maxOutputTokens) / data.maxTokens) * 100;
  const threshold = Math.max(0, Math.min(100, raw));
  return {
    threshold,
    tokens: data.maxTokens - data.maxOutputTokens,
  };
}
