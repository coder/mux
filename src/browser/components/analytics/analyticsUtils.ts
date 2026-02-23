import assert from "@/common/utils/assert";

// Shared color palette for all analytics charts.
// Uses theme tokens so colors remain legible in both dark and light themes.
export const ANALYTICS_CHART_COLORS = [
  "var(--color-plan-mode)",
  "var(--color-exec-mode)",
  "var(--color-task-mode)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-danger)",
  "var(--color-info)",
  "var(--color-ask-mode)",
] as const;

// Shared recharts styling constants so each chart component stays DRY.
// These match the project's CSS custom-property theme tokens.

/** Axis tick label style shared by all analytics charts. */
export const CHART_AXIS_TICK = { fill: "var(--color-muted)", fontSize: 11 } as const;

/** Axis / grid stroke colour. */
export const CHART_AXIS_STROKE = "var(--color-border-light)";

/** Tooltip content style shared by charts that use recharts `<Tooltip>`. */
export const CHART_TOOLTIP_CONTENT_STYLE = {
  borderColor: "var(--color-border-medium)",
  backgroundColor: "var(--color-background-secondary)",
  borderRadius: "8px",
} as const;

const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compactNumberFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const BUCKET_TIME_COMPONENT_PATTERN = /(?:^|[ T])\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?/;

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "$0.00";
  }
  return usdFormatter.format(amount);
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) {
    return "0.0%";
  }

  const normalizedRatio = ratio <= 1 ? ratio * 100 : ratio;
  return `${normalizedRatio.toFixed(1)}%`;
}

export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  return compactNumberFormatter.format(value);
}

export function formatProjectDisplayName(projectPath: string): string {
  assert(typeof projectPath === "string", "projectPath must be a string");
  const pathSegments = projectPath.split(/[\\/]/).filter(Boolean);
  return pathSegments[pathSegments.length - 1] ?? projectPath;
}

export function formatBucketLabel(bucket: string): string {
  const parsedDate = new Date(bucket);
  if (!Number.isFinite(parsedDate.getTime())) {
    return bucket;
  }

  const includesTime = BUCKET_TIME_COMPONENT_PATTERN.test(bucket);
  if (includesTime) {
    return parsedDate.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
    });
  }

  // Date-only buckets (YYYY-MM-DD) are UTC midnight. Render with
  // timeZone: "UTC" so west-of-UTC locales don't shift the displayed day
  // (e.g. 2026-02-01 showing as "Jan 31" in PST).
  return parsedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
