export const FEATURE_FLAG_KEYS = {
  statsTabV1: "stats_tab_v1",
} as const;

export type FeatureFlagKey = (typeof FEATURE_FLAG_KEYS)[keyof typeof FEATURE_FLAG_KEYS];
