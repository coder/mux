import type { XumMessageMetadata, XumMessage, XumMetadata } from "@/common/types/message";

interface LegacyXumMetadata extends XumMetadata {
  cmuxMetadata?: XumMessageMetadata;
  idleCompacted?: boolean;
}

/**
 * Normalize persisted messages from older builds.
 *
 * Migrations:
 * - `cmuxMetadata` → `muxMetadata` (mux rename)
 * - `{ compacted: true, idleCompacted: true }` → `{ compacted: "idle" }`
 */
export function normalizeLegacyXumMetadata(message: XumMessage): XumMessage {
  const metadata = message.metadata as LegacyXumMetadata | undefined;
  if (!metadata) return message;

  let normalized: XumMetadata = { ...metadata };
  let changed = false;

  // Migrate cmuxMetadata → muxMetadata
  if (metadata.cmuxMetadata !== undefined) {
    const { cmuxMetadata, ...rest } = normalized as LegacyXumMetadata;
    normalized = rest;
    if (!metadata.muxMetadata) {
      normalized.muxMetadata = cmuxMetadata;
    }
    changed = true;
  }

  // Migrate idleCompacted: true → compacted: "idle"
  if (metadata.idleCompacted === true) {
    const { idleCompacted, ...rest } = normalized as LegacyXumMetadata;
    normalized = { ...rest, compacted: "idle" };
    changed = true;
  }

  return changed ? { ...message, metadata: normalized } : message;
}
