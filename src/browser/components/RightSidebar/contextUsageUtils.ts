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

export interface OutputReserveDisplayState {
  info: OutputReserveInfo;
  showIndicator: boolean;
  showWarning: boolean;
}

export function getOutputReserveDisplayState(options: {
  data: TokenMeterData;
  showThresholdSlider: boolean;
  threshold?: number | null;
}): OutputReserveDisplayState {
  const info = getOutputReserveInfo(options.data);
  const threshold = options.threshold ?? null;
  const showIndicator = Boolean(options.showThresholdSlider && info.threshold !== null);
  const showWarning = Boolean(
    options.showThresholdSlider &&
    threshold !== null &&
    threshold < 100 &&
    info.threshold !== null &&
    threshold > info.threshold
  );

  return { info, showIndicator, showWarning };
}
