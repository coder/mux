import type { MuxFrontendMetadata, MuxMessage, MuxMetadata } from "@/common/types/message";

interface LegacyMuxMetadata extends MuxMetadata {
  cmuxMetadata?: MuxFrontendMetadata;
  idleCompacted?: boolean;
}

/**
 * Normalize persisted messages from older builds.
 *
 * Migrations:
 * - `cmuxMetadata` → `muxMetadata` (mux rename)
 * - `{ compacted: true, idleCompacted: true }` → `{ compacted: "idle" }`
 */
export function normalizeLegacyMuxMetadata(message: MuxMessage): MuxMessage {
  const metadata = message.metadata as LegacyMuxMetadata | undefined;
  if (!metadata) return message;

  let normalized: MuxMetadata = { ...metadata };
  let changed = false;

  // Migrate cmuxMetadata → muxMetadata
  if (metadata.cmuxMetadata !== undefined) {
    const { cmuxMetadata, ...rest } = normalized as LegacyMuxMetadata;
    normalized = rest;
    if (!metadata.muxMetadata) {
      normalized.muxMetadata = cmuxMetadata;
    }
    changed = true;
  }

  // Migrate idleCompacted: true → compacted: "idle"
  if (metadata.idleCompacted === true) {
    const { idleCompacted, ...rest } = normalized as LegacyMuxMetadata;
    normalized = { ...rest, compacted: "idle" };
    changed = true;
  }

  return changed ? { ...message, metadata: normalized } : message;
}
