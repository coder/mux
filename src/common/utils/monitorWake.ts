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
 * `src/browser/features/Messages/MonitorWakeMessage.tsx`. Both match only blocks that carry
 * the backend `source="mux"` sentinel attribute so user-authored XML that happens to look
 * like a monitor event is never silently stripped, even when a real wake gets appended to
 * the same queued message.
 */
const MONITOR_BLOCK_PATTERN =
  /<monitor-event\b(?=[^>]*\bsource="mux")[^>]*>[\s\S]*?<\/monitor-event>/g;

/**
 * Remove every backend-generated `<monitor-event source="mux" …>…</monitor-event>` block
 * from `content` and collapse the leftover whitespace. Returns the input unchanged when no
 * sentinel-bearing blocks are present so callers can cheaply guard on `stripped !== content`.
 */
export function stripMonitorWakeXml(content: string): string {
  if (!content.includes('source="mux"')) return content;
  const stripped = content.replace(MONITOR_BLOCK_PATTERN, "");
  if (stripped === content) return content;
  return stripped.replace(/\n{2,}/g, "\n\n").trim();
}
