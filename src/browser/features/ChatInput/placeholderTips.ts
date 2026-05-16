/**
 * Tip carousel for the ChatInput placeholder.
 *
 * The workspace ChatInput uses these strings as a rotating "Type a message..."
 * placeholder so users who never read docs still get passive exposure to
 * slash commands they probably don't know about — /btw above all.
 *
 * The tip rotates on a wall-clock bucket (not per-message, not per-workspace)
 * so switching between chats never reshuffles the visible tip. Two tabs open
 * to two workspaces show the same tip; close and re-open the app inside the
 * same bucket and you still see the same tip. The bucket boundary is the
 * only thing that advances the carousel.
 */

/** Bucket length for tip rotation. */
const TIP_ROTATION_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes

export const PLACEHOLDER_TIPS: readonly string[] = [
  "Try /btw <question> to ask a side question without nudging the agent",
  "Try /haiku <msg> to send just this message on a different model",
  "Try /+high <msg> to crank up reasoning for this message only",
  "Try /compact to summarize the conversation when context gets tight",
  "Try /fork <start> to branch this chat into a new workspace",
  "Try /plan to view or edit the current plan inline",
  "Try /orchestrate to coordinate sub-agents and integrate their patches",
  "Try /goal <objective> to set a workspace goal with an optional budget",
  "Try /clear --soft to reset context while keeping the chat visible",
  "Try /new <start> to start a fresh workspace from the trunk branch",
  "Try /vim to toggle vim keybindings in the chat input",
  "Try /truncate 50 to drop the oldest half of the conversation",
];

/**
 * Return the tip for the current wall-clock bucket.
 *
 * The bucket index is `floor(now / 20min)` modulo the tip list, so every
 * caller in the same 20-minute window sees the same tip regardless of
 * workspace, tab, or user-message count. `nowMs` is exposed for testing
 * — production callers should let it default to `Date.now()`.
 *
 * Non-finite or negative inputs fall back to the lead tip so /btw stays
 * the first thing a user sees in degenerate states (clock skew, mocked
 * timers returning weird values, etc.).
 */
export function getPlaceholderTip(nowMs: number = Date.now()): string {
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return PLACEHOLDER_TIPS[0];
  }
  const bucket = Math.floor(nowMs / TIP_ROTATION_INTERVAL_MS);
  const index = bucket % PLACEHOLDER_TIPS.length;
  return PLACEHOLDER_TIPS[index];
}
