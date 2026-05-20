/**
 * Snooze utilities.
 *
 * A workspace is "snoozed" while its persisted `snoozedUntil` ISO timestamp is
 * still in the future. The sidebar hides snoozed workspaces under a dedicated
 * 💤 Snoozed section until that timestamp passes — at which point the section
 * drains naturally on the next render without requiring backend rewrites.
 *
 * Keeping the derivation here (not in the persisted field) mirrors how
 * `isWorkspaceArchived` derives archived state from `archivedAt`/`unarchivedAt`
 * and keeps schema migrations unnecessary for stale snoozes.
 */

/**
 * Parse a human duration like `15m`, `2h`, `3d`, or `1w` into milliseconds.
 *
 * Returns `null` for any unparseable input. Trims whitespace and is
 * case-insensitive in the unit suffix so `/snooze 2H` and `/snooze 2h` both
 * land on the same hour bucket.
 *
 * Restricting the supported units (no months/years, no fractional values)
 * keeps the slash-command parser and modal preset list in lockstep.
 */
export function parseHumanDurationMs(input: string): number | null {
  if (typeof input !== "string") return null;
  const match = /^\s*(\d+)\s*([mhdw])\s*$/i.exec(input);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const MINUTE_MS = 60_000;
  switch (unit) {
    case "m":
      return amount * MINUTE_MS;
    case "h":
      return amount * 60 * MINUTE_MS;
    case "d":
      return amount * 24 * 60 * MINUTE_MS;
    case "w":
      return amount * 7 * 24 * 60 * MINUTE_MS;
    default:
      return null;
  }
}

/**
 * Format a millisecond delta as a short canonical duration suitable for the
 * slash command (e.g. `15m`, `2h`, `1d`, `1w`). Picks the largest unit that
 * divides cleanly so the modal can echo the equivalent `/snooze <X>` command.
 */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const MINUTE_MS = 60_000;
  const minutes = Math.round(ms / MINUTE_MS);
  if (minutes <= 0) return "0m";
  const WEEK_MIN = 7 * 24 * 60;
  const DAY_MIN = 24 * 60;
  const HOUR_MIN = 60;
  if (minutes % WEEK_MIN === 0) return `${minutes / WEEK_MIN}w`;
  if (minutes % DAY_MIN === 0) return `${minutes / DAY_MIN}d`;
  if (minutes % HOUR_MIN === 0) return `${minutes / HOUR_MIN}h`;
  return `${minutes}m`;
}

/**
 * Determine if a workspace is currently snoozed. Stale timestamps (already
 * passed) intentionally return false so the sidebar auto-drains.
 */
export function isWorkspaceSnoozed(snoozedUntil: string | undefined, nowMs?: number): boolean {
  if (!snoozedUntil) return false;
  const deadlineMs = Date.parse(snoozedUntil);
  if (!Number.isFinite(deadlineMs)) return false;
  const now = nowMs ?? Date.now();
  return deadlineMs > now;
}

/**
 * Maximum supported snooze horizon. We refuse to set snoozes farther out than
 * this so the section can't act as a soft-archive replacement (use `/archive`
 * for permanent hiding).
 */
export const MAX_SNOOZE_MS = 52 * 7 * 24 * 60 * 60 * 1000; // 52 weeks
