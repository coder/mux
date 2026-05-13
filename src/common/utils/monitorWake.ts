/**
 * Shared helpers for backend-generated `<monitor-event>` wake payloads.
 *
 * `AgentSession.formatMonitorWakeMessage()` produces XML that the model consumes as a user
 * turn. The UI hides it behind structured cards, but a couple of paths need to strip the XML
 * so the user never sees the raw payload:
 *   - `AgentSession.restoreQueueToInput()` puts queued text back into the composer on
 *     interrupt; the synthetic XML must not land in the input box.
 *   - The frontend's "Edit queued message" path opens the composer with the queued draft and
 *     similarly must not surface raw monitor wake XML.
 *
 * Keep this regex aligned with the one used by `extractMonitorWakeEvents` in
 * `src/browser/features/Messages/MonitorWakeMessage.tsx` (same anchor + non-greedy body).
 */
const MONITOR_BLOCK_PATTERN = /<monitor-event\b[^>]*>[\s\S]*?<\/monitor-event>/g;

/**
 * Remove every `<monitor-event …>…</monitor-event>` block from `content` and collapse the
 * leftover whitespace. Returns the input unchanged when no blocks are present so callers can
 * still cheaply guard on `stripped !== content`.
 */
export function stripMonitorWakeXml(content: string): string {
  if (!content.includes("<monitor-event")) return content;
  const stripped = content.replace(MONITOR_BLOCK_PATTERN, "");
  if (stripped === content) return content;
  return stripped.replace(/\n{2,}/g, "\n\n").trim();
}
