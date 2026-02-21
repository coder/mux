import assert from "node:assert/strict";

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

  const includesTime = bucket.includes("T");
  if (includesTime) {
    return parsedDate.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
    });
  }

  return parsedDate.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
