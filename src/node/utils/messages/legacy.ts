import type { MuxFrontendMetadata, MuxMessage, MuxMetadata } from "@/common/types/message";

interface LegacyMuxMetadata extends MuxMetadata {
  cmuxMetadata?: MuxFrontendMetadata;
}

/**
 * Normalize persisted messages that were stored before the mux rename.
 *
 * Older builds recorded frontend metadata under `metadata.cmuxMetadata`.
 * After the rename, the field lives under `metadata.muxMetadata`.
 *
 * This helper upgrades the legacy field on read so UI code keeps working.
 */
export function normalizeLegacyMuxMetadata(message: MuxMessage): MuxMessage {
  const metadata = message.metadata as LegacyMuxMetadata | undefined;
  if (metadata?.cmuxMetadata === undefined) {
    return message;
  }

  const { cmuxMetadata, ...rest } = metadata;
  const normalizedMetadata: MuxMetadata = rest;

  if (metadata.muxMetadata) {
    // Message already has the new field; just drop the legacy copy.
    return {
      ...message,
      metadata: normalizedMetadata,
    };
  }

  return {
    ...message,
    metadata: {
      ...normalizedMetadata,
      muxMetadata: cmuxMetadata,
    },
  };
}
