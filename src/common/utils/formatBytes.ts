/**
 * Format a byte count into a human-readable string using binary units (KiB-style thresholds).
 * Uses 1024-based thresholds but labels as KB/MB for brevity (matching common UI conventions).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
