/**
 * Turn-envelope emission: one durable "turn-envelope" row per assistant turn,
 * capturing the request identity that chat.jsonl alone cannot reconstruct
 * (final system prompt, toolset shape, model/thinking/provider-options
 * fingerprint). Written after the final system prompt and toolset are settled
 * (post request.assemble middleware, post tool-policy rebuild) and before
 * streaming starts, so session logs uphold "model-visible ⟹ logged".
 */

import crypto from "node:crypto";
import { asSchema, type FlexibleSchema, type Tool } from "ai";
import type { PostCompactionAttachment } from "@/common/types/attachment";
import type { BlobRef } from "@/common/types/durableEvent";
import { stableStringify } from "@/common/utils/stableStringify";
import { log } from "@/node/services/log";
import type { DurableEventJournal } from "@/node/utils/journal/durableEventJournal";

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf-8").digest("hex");
}

/**
 * Fingerprint one JSON tool input schema. Shared with the replay auditor
 * (src/node/services/replay/), which re-hashes the wire-recorded
 * `inputSchema` of each tool from devtools.jsonl and compares against the
 * manifest hashes persisted in turn-envelope rows — both sides must use the
 * identical stableStringify+sha256 fingerprint.
 */
export function hashToolSchema(jsonSchema: unknown): string {
  return sha256Hex(stableStringify(jsonSchema));
}

/**
 * Extract the JSON schema from a runtime tool entry without ever throwing.
 * Tool maps mix shapes that `asSchema` alone cannot normalize — passing a
 * plain object to `asSchema` makes it assume a lazy-schema function and call
 * it, throwing `TypeError: schema is not a function`:
 * - MCP/dynamic tools (and their sanitizeToolSchemaForOpenAI copies) carry
 *   `.inputSchema` wrappers exposing a `jsonSchema` getter that may lack the
 *   AI SDK schema symbol.
 * - sanitizeToolSchemaForOpenAI rewrites v3-style `.parameters` (and custom
 *   adapters declare `.parameters`/`.schema`) as plain JSON Schema objects.
 * A fingerprinting failure here would silently drop the whole turn-envelope
 * row and break "model-visible ⟹ logged", so every branch degrades to a
 * hashable value instead of propagating.
 */
function extractJsonSchema(rawTool: unknown): unknown {
  const record =
    rawTool !== null && typeof rawTool === "object"
      ? (rawTool as { inputSchema?: unknown; parameters?: unknown; schema?: unknown })
      : undefined;
  const rawSchema = record?.inputSchema ?? record?.parameters ?? record?.schema;
  if (rawSchema == null) {
    // Sparse/schema-less entries fingerprint as the AI SDK empty object schema.
    return asSchema(undefined).jsonSchema;
  }
  if (typeof rawSchema === "object") {
    // jsonSchema() wrappers and MCP inputSchema wrappers expose the actual
    // JSON schema via a `jsonSchema` property/getter; unwrap it directly
    // (identical to what asSchema returns for symbol-bearing wrappers).
    const wrapped = (rawSchema as { jsonSchema?: unknown }).jsonSchema;
    if (wrapped !== null && typeof wrapped === "object") {
      return wrapped;
    }
    // Plain JSON Schema objects are already the schema. `~standard` excludes
    // standard-schema instances (zod), which asSchema must convert instead.
    if (typeof (rawSchema as { type?: unknown }).type === "string" && !("~standard" in rawSchema)) {
      return rawSchema;
    }
  }
  try {
    // asSchema normalizes the remaining FlexibleSchema forms (zod v3/v4,
    // symbol-bearing Schema instances, lazy schema functions).
    return asSchema(rawSchema as FlexibleSchema<unknown>).jsonSchema;
  } catch {
    // Unknown shape: fingerprint the raw value rather than aborting emission.
    return rawSchema;
  }
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
      // stableStringify sorts keys so the hash is insensitive to property
      // insertion order.
      const inputJsonSchema = extractJsonSchema(tools[name]);
      return { name, schemaHash: hashToolSchema(inputJsonSchema) };
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
  /** Join key for replay pairing; omit when unknown (empty request history). */
  requestHistorySequence?: number;
  /** Resolved wire provider name (instance-typed gateways are not derivable offline). */
  wireProviderName?: string;
  /** Per-send Anthropic cache TTL override; omit for the default TTL. */
  anthropicCacheTtl?: string;
  /** Plan content injected on a plan→exec handoff this turn (model-visible). */
  planContentForTransition?: string;
  planFilePath?: string;
  /** Post-compaction attachments injected this turn (model-visible). */
  postCompactionAttachments?: PostCompactionAttachment[] | null;
}): Promise<void> {
  try {
    // Content-addressed: unchanged prompts across turns dedupe to one blob.
    const { ref } = await params.journal.blobs.put(params.systemMessage);

    // Request-time inputs that reach the provider request must be logged too
    // ("model-visible ⟹ logged"): blob-store the injected plan content and
    // post-compaction attachments so replay can rebuild those turns.
    let planTransitionContentHash: BlobRef | undefined;
    if (params.planContentForTransition != null && params.planContentForTransition.length > 0) {
      planTransitionContentHash = (await params.journal.blobs.put(params.planContentForTransition))
        .ref;
    }
    let postCompactionAttachmentsHash: BlobRef | undefined;
    if (params.postCompactionAttachments != null && params.postCompactionAttachments.length > 0) {
      postCompactionAttachmentsHash = (
        await params.journal.blobs.put(JSON.stringify(params.postCompactionAttachments))
      ).ref;
    }

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
        ...(params.requestHistorySequence != null && params.requestHistorySequence >= 0
          ? { requestHistorySequence: params.requestHistorySequence }
          : {}),
        ...(params.wireProviderName != null ? { wireProviderName: params.wireProviderName } : {}),
        ...(params.anthropicCacheTtl != null
          ? { anthropicCacheTtl: params.anthropicCacheTtl }
          : {}),
        ...(planTransitionContentHash !== undefined
          ? {
              planTransitionContentHash,
              ...(params.planFilePath != null
                ? { planTransitionFilePath: params.planFilePath }
                : {}),
            }
          : {}),
        ...(postCompactionAttachmentsHash !== undefined ? { postCompactionAttachmentsHash } : {}),
      },
    });
  } catch (error) {
    log.warn("Failed to write turn-envelope durable event", {
      workspaceId: params.workspaceId,
      error,
    });
  }
}
