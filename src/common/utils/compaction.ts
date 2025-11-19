/**
 * Shared compaction utilities for both frontend and backend
 * 
 * Provides factory functions to create compaction requests with proper option overrides,
 * ensuring manual /compact commands and auto-compaction behave identically.
 */

import type { SendMessageOptions, ImagePart } from "@/common/types/ipc";
import type { MuxFrontendMetadata, CompactionRequestData, ContinueMessage } from "@/common/types/message";

// ============================================================================
// Option overrides
// ============================================================================

/**
 * Apply compaction-specific option overrides to base options.
 *
 * This function is the single source of truth for how compaction metadata
 * transforms workspace defaults. Both initial sends and stream resumption
 * use this function to ensure consistent behavior.
 *
 * @param baseOptions - Workspace default options (from localStorage or useSendMessageOptions)
 * @param compactData - Compaction request metadata from /compact command
 * @returns Final SendMessageOptions with compaction overrides applied
 */
export function applyCompactionOverrides(
  baseOptions: SendMessageOptions,
  compactData: CompactionRequestData
): SendMessageOptions {
  // Use custom model if specified, otherwise use workspace default
  const compactionModel = compactData.model ?? baseOptions.model;

  return {
    ...baseOptions,
    model: compactionModel,
    // Keep workspace default thinking level - all models support thinking now that tools are disabled
    thinkingLevel: baseOptions.thinkingLevel,
    maxOutputTokens: compactData.maxOutputTokens,
    mode: "compact" as const,
    toolPolicy: [], // Disable all tools during compaction
  };
}

// ============================================================================
// Compaction request factory
// ============================================================================

export interface CreateCompactionRequestOptions {
  baseOptions: SendMessageOptions;  // User's workspace defaults
  continueMessage?: { text: string; imageParts?: ImagePart[] };
  rawCommand: string;
}

export interface CreateCompactionRequestResult {
  messageText: string;
  metadata: MuxFrontendMetadata;  // For display/regeneration
  sendOptions: SendMessageOptions;  // Ready to send (has muxMetadata attached)
}

/**
 * Create a complete compaction request with proper option overrides
 * 
 * Single source of truth for compaction request creation, used by:
 * - Frontend executeCompaction: uses sendOptions directly
 * - Frontend ChatInput: uses metadata separately for regeneration
 * - Backend auto-compaction: uses sendOptions directly
 * 
 * Ensures all paths apply identical overrides (tools disabled, mode: "compact", etc.)
 */
export function createCompactionRequest(
  options: CreateCompactionRequestOptions
): CreateCompactionRequestResult {
  const targetWords = options.baseOptions.maxOutputTokens 
    ? Math.round(options.baseOptions.maxOutputTokens / 1.3) 
    : 2000;

  // Build compaction message with optional continue context
  let messageText = `Summarize this conversation into a compact form for a new Assistant to continue helping the user. Use approximately ${targetWords} words.`;

  if (options.continueMessage) {
    messageText += `\n\nThe user wants to continue with: ${options.continueMessage.text}`;
  }

  // Create compaction metadata
  const compactData: CompactionRequestData = {
    model: options.baseOptions.model,
    maxOutputTokens: options.baseOptions.maxOutputTokens,
    continueMessage: options.continueMessage,
  };

  const metadata: MuxFrontendMetadata = {
    type: "compaction-request",
    rawCommand: options.rawCommand,
    parsed: compactData,
  };

  // Apply compaction overrides to get final send options
  const sendOptions = applyCompactionOverrides(options.baseOptions, compactData);

  return {
    messageText,
    metadata,
    sendOptions: { ...sendOptions, muxMetadata: metadata },
  };
}
