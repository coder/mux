/**
 * Tip carousel for the ChatInput placeholder.
 *
 * The workspace ChatInput uses these strings as a rotating "Type a message..."
 * placeholder so users who never read docs still get passive exposure to
 * slash commands they probably don't know about.
 *
 * The tip rotates on a wall-clock bucket (not per-message, not per-workspace)
 * so switching between chats never reshuffles the visible tip. Two tabs open
 * to two workspaces show the same tip; close and re-open the app inside the
 * same bucket and you still see the same tip. The bucket boundary is the
 * only thing that advances the carousel.
 *
 * Every tip in this list must be wired up as a real slash command (registry
 * or built-in skill) AND ungated by experiments (no `experimentGate` on the
 * command definition). Advertising an unimplemented or feature-flag-locked
 * command sends the user into an unknown-command / experiment-required dead
 * end the moment they follow the suggestion. When adding a tip, grep
 * `src/browser/utils/slashCommands/registry.ts` for `experimentGate` to make
 * sure the command you're surfacing isn't gated.
 */

/** Bucket length for tip rotation. */
const TIP_ROTATION_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

/**
 * Tip index pinned for Storybook/Chromatic snapshots.
 *
 * Without pinning, every story that renders ChatInput would resolve a tip via
 * `floor(NOW / 20min) mod PLACEHOLDER_TIPS.length` — so any reorder of or
 * insertion into PLACEHOLDER_TIPS shifts the displayed tip and cascades into
 * a fresh Chromatic baseline diff on every ChatInput story (currently 100+).
 *
 * Pinning to index 0 means tip-list edits only affect snapshots when the lead
 * tip's text itself changes, which is the rare, intentional case. /orchestrate
 * is the lead tip because it's the only entry-point users have for the
 * unadvertised orchestrate skill — making it the storybook-fixed tip turns
 * every ChatInput snapshot into passive discovery surface for the feature.
 */
const STORYBOOK_PINNED_TIP_INDEX = 0;

export const PLACEHOLDER_TIPS: readonly string[] = [
  "Try /orchestrate to coordinate sub-agents and integrate their patches",
  "Try /btw <question> to ask a side question without nudging the agent",
  "Try /haiku <msg> to send just this message on a different model",
  "Try /+high <msg> to crank up reasoning for this message only",
  "Try /compact to summarize the conversation when context gets tight",
  "Try /fork <start> to branch this chat into a new workspace",
  "Try /plan to view or edit the current plan inline",
  "Try /clear --soft to reset context while keeping the chat visible",
  "Try /new <start> to start a fresh workspace from the trunk branch",
  "Try /vim to toggle vim keybindings in the chat input",
  "Try /truncate 50 to drop the oldest half of the conversation",
];

/**
 * Detect Storybook runtime via a global flag set by `.storybook/preview.tsx`.
 *
 * We deliberately avoid `import.meta.env` here because this module is
 * transitively imported by Jest-based UI tests (`tests/ui/**`) that run in
 * CommonJS mode and choke on `import.meta`. A plain runtime flag works in
 * every environment: Storybook's preview sets it before any story renders,
 * Jest / Bun tests never touch it, and production builds never see it.
 */
function isStorybookRuntime(): boolean {
  return (globalThis as { __MUX_STORYBOOK__?: boolean }).__MUX_STORYBOOK__ === true;
}

/**
 * Return the tip for the current wall-clock bucket.
 *
 * The bucket index is `floor(now / 20min)` modulo the tip list, so every
 * caller in the same 20-minute window sees the same tip regardless of
 * workspace, tab, or user-message count. `nowMs` is exposed for testing
 * — production callers should let it default to `Date.now()`.
 *
 * Non-finite or negative inputs fall back to the lead tip so the carousel
 * still surfaces a real, discoverable command in degenerate states (clock
 * skew, mocked timers returning weird values, etc.).
 *
 * Under Storybook, default-arg calls return a fixed tip
 * (`STORYBOOK_PINNED_TIP_INDEX`) so visual baselines are insulated from
 * tip-list reordering. Explicit `nowMs` arguments always use rotation, so
 * tests stay meaningful.
 */
export function getPlaceholderTip(nowMs?: number): string {
  if (nowMs === undefined && isStorybookRuntime()) {
    return PLACEHOLDER_TIPS[STORYBOOK_PINNED_TIP_INDEX];
  }
  const ts = nowMs ?? Date.now();
  if (!Number.isFinite(ts) || ts < 0) {
    return PLACEHOLDER_TIPS[0];
  }
  const bucket = Math.floor(ts / TIP_ROTATION_INTERVAL_MS);
  const index = bucket % PLACEHOLDER_TIPS.length;
  return PLACEHOLDER_TIPS[index];
}
