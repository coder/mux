/**
 * Turn-envelope emission: one durable "turn-envelope" row per assistant turn,
 * capturing the request identity that chat.jsonl alone cannot reconstruct
 * (final system prompt, toolset shape, model/thinking/provider-options
 * fingerprint). Written after the final system prompt and toolset are settled
 * (post request.assemble middleware, post tool-policy rebuild) and before
 * streaming starts, so session logs uphold "model-visible ⟹ logged".
 */

import crypto from "node:crypto";
import { asSchema, type Tool } from "ai";
import { stableStringify } from "@/common/utils/stableStringify";
import { log } from "@/node/services/log";
import type { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Fingerprint the toolset as {name, schemaHash} sorted by name. schemaHash is
 * bare sha256 hex (not a BlobRef — schemas are hashed, never blob-stored).
 */
export function buildToolsetManifest(
  tools: Record<string, Tool>
): Array<{ name: string; schemaHash: string }> {
  return Object.keys(tools)
    .sort()
    .map((name) => {
      // asSchema normalizes every FlexibleSchema form (zod v3/v4, jsonSchema()
      // wrappers, undefined) into a JSON schema; stableStringify sorts keys so
      // the hash is insensitive to property insertion order.
      const inputJsonSchema = asSchema(tools[name].inputSchema).jsonSchema;
      return { name, schemaHash: sha256Hex(stableStringify(inputJsonSchema)) };
    });
}

/**
 * Append one turn-envelope row (and the content-addressed system-prompt blob)
 * to the session's durable-event journal. Never throws: envelope emission is
 * observability, not control flow — an unwritable session dir or full disk
 * must not fail the turn.
 */
export async function emitTurnEnvelope(params: {
  journal: DurableEventJournal;
  workspaceId: string;
  systemMessage: string;
  tools: Record<string, Tool>;
  modelString: string;
  thinkingLevel: string;
  providerOptions: unknown;
}): Promise<void> {
  try {
    // Content-addressed: unchanged prompts across turns dedupe to one blob.
    const { ref } = await params.journal.blobs.put(params.systemMessage);
    await params.journal.append({
      kind: "turn-envelope",
      workspaceId: params.workspaceId,
      data: {
        systemPromptHash: ref,
        toolsetManifest: buildToolsetManifest(params.tools),
        modelString: params.modelString,
        // Hash only — resolved providerOptions may embed auth-adjacent config
        // (headers, cache keys), so the raw object is never persisted.
        providerOptionsHash: sha256Hex(stableStringify(params.providerOptions)),
        thinkingLevel: params.thinkingLevel,
      },
    });
  } catch (error) {
    log.warn("Failed to write turn-envelope durable event", {
      workspaceId: params.workspaceId,
      error,
    });
  }
}
