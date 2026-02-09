import { NoObjectGeneratedError, streamText, Output } from "ai";
import { z } from "zod";
import type { AIService } from "./aiService";
import { log } from "./log";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { SendMessageError } from "@/common/types/errors";
import crypto from "crypto";

/** Schema for AI-generated workspace identity (area name + descriptive title) */
const workspaceIdentitySchema = z.object({
  name: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .min(2)
    .max(20)
    .describe(
      "Codebase area (1-2 words, max 15 chars): lowercase, hyphens only, e.g. 'sidebar', 'auth', 'config'"
    ),
  title: z
    .string()
    .min(5)
    .max(60)
    .describe("Human-readable title (2-5 words): verb-noun format like 'Fix plan mode'"),
});

export interface WorkspaceIdentity {
  /** Codebase area with 4-char suffix (e.g., "sidebar-a1b2", "auth-k3m9") */
  name: string;
  /** Human-readable title (e.g., "Fix plan mode over SSH") */
  title: string;
}

// Crockford Base32 alphabet (excludes I, L, O, U to avoid confusion)
const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Generate a 4-character random suffix using Crockford Base32.
 * Uses 20 bits of randomness (4 chars × 5 bits each).
 */
function generateNameSuffix(): string {
  const bytes = crypto.randomBytes(3); // 24 bits, we'll use 20
  const value = (bytes[0] << 12) | (bytes[1] << 4) | (bytes[2] >> 4);
  return (
    CROCKFORD_ALPHABET[(value >> 15) & 0x1f] +
    CROCKFORD_ALPHABET[(value >> 10) & 0x1f] +
    CROCKFORD_ALPHABET[(value >> 5) & 0x1f] +
    CROCKFORD_ALPHABET[value & 0x1f]
  );
}

export interface GenerateWorkspaceIdentityResult extends WorkspaceIdentity {
  /** The model that successfully generated the identity */
  modelUsed: string;
}

/**
 * Generate workspace identity (name + title) using AI.
 * Tries candidates in order, retrying on API errors (invalid keys, quota, etc.).
 *
 * - name: Codebase area with 4-char suffix (e.g., "sidebar-a1b2")
 * - title: Human-readable description (e.g., "Fix plan mode over SSH")
 */
export async function generateWorkspaceIdentity(
  message: string,
  candidates: string[],
  aiService: AIService
): Promise<Result<GenerateWorkspaceIdentityResult, SendMessageError>> {
  if (candidates.length === 0) {
    return Err({ type: "unknown", raw: "No model candidates provided for name generation" });
  }

  // Try up to 3 candidates
  const maxAttempts = Math.min(candidates.length, 3);

  // Track the last API error to return if all candidates fail
  let lastApiError: string | undefined;

  for (let i = 0; i < maxAttempts; i++) {
    const modelString = candidates[i];

    const modelResult = await aiService.createModel(modelString);
    if (!modelResult.success) {
      // No credentials for this model, try next
      log.debug(`Name generation: skipping ${modelString} (${modelResult.error.type})`);
      continue;
    }

    try {
      // Use streamText instead of generateText: the Codex OAuth endpoint
      // (chatgpt.com/backend-api/codex/responses) requires stream:true in the
      // request body and rejects non-streaming requests with 400.  streamText
      // sets stream:true automatically, while generateText does not.
      const stream = streamText({
        model: modelResult.data,
        output: Output.object({ schema: workspaceIdentitySchema }),
        prompt: `Generate a workspace name and title for this development task:

"${message}"

Requirements:
- name: The area of the codebase being worked on (1-2 words, max 15 chars, git-safe: lowercase, hyphens only). Random bytes will be appended for uniqueness, so focus on the area not the specific task. Examples: "sidebar", "auth", "config", "api"
- title: A 2-5 word description in verb-noun format. Examples: "Fix plan mode", "Add user authentication", "Refactor sidebar layout"`,
      });

      // Awaiting .output triggers full stream consumption and JSON parsing.
      // If the model returned conversational text instead of JSON, this throws
      // NoObjectGeneratedError — caught below with a text fallback parser.
      const output = await stream.output;

      const suffix = generateNameSuffix();
      const sanitizedName = sanitizeBranchName(output.name, 20);
      const nameWithSuffix = `${sanitizedName}-${suffix}`;

      return Ok({
        name: nameWithSuffix,
        title: output.title.trim(),
        modelUsed: modelString,
      });
    } catch (error) {
      // Some models ignore the structured output instruction and return
      // conversational text (e.g. "**name:** `testing`\n**title:** `Improve test coverage`").
      // NoObjectGeneratedError carries the raw .text — try to extract name/title
      // from it before giving up on this candidate.
      if (NoObjectGeneratedError.isInstance(error) && error.text) {
        const textFallback = extractIdentityFromText(error.text);
        if (textFallback) {
          log.info(
            `Name generation: structured output failed for ${modelString}, recovered from text fallback`
          );
          const suffix = generateNameSuffix();
          const sanitizedName = sanitizeBranchName(textFallback.name, 20);
          const nameWithSuffix = `${sanitizedName}-${suffix}`;
          return Ok({
            name: nameWithSuffix,
            title: textFallback.title,
            modelUsed: modelString,
          });
        }
      }

      // API error (invalid key, quota, network, etc.) - try next candidate
      lastApiError = error instanceof Error ? error.message : String(error);
      log.warn(`Name generation failed with ${modelString}, trying next candidate`, {
        error: lastApiError,
      });
      continue;
    }
  }

  // Return the last API error if available (more actionable than generic message)
  const errorMessage = lastApiError
    ? `Name generation failed: ${lastApiError}`
    : "Name generation failed - no working model found";
  return Err({ type: "unknown", raw: errorMessage });
}

/**
 * Fallback: extract name/title from conversational model text when structured
 * JSON output parsing fails. Handles common patterns like:
 *   **name:** `testing`          or  "name": "testing"
 *   **title:** `Improve tests`   or  "title": "Improve tests"
 *
 * Returns null if either field cannot be reliably extracted.
 */
export function extractIdentityFromText(text: string): { name: string; title: string } | null {
  // Try JSON extraction first (model may have embedded JSON in prose)
  const jsonMatch = /\{[^}]*"name"\s*:\s*"([^"]+)"[^}]*"title"\s*:\s*"([^"]+)"[^}]*\}/.exec(text);
  if (jsonMatch) {
    return validateExtracted(jsonMatch[1], jsonMatch[2]);
  }
  // Also try reverse field order in JSON
  const jsonMatchReverse = /\{[^}]*"title"\s*:\s*"([^"]+)"[^}]*"name"\s*:\s*"([^"]+)"[^}]*\}/.exec(
    text
  );
  if (jsonMatchReverse) {
    return validateExtracted(jsonMatchReverse[2], jsonMatchReverse[1]);
  }

  // Try markdown/prose patterns: **name:** `value` or name: "value"
  // In bold markdown the colon sits inside the stars: **name:**
  const nameMatch =
    /\*?\*?name:\*?\*?\s*`([^`]+)`/i.exec(text) ?? /\bname:\s*"([^"]+)"/i.exec(text);
  const titleMatch =
    /\*?\*?title:\*?\*?\s*`([^`]+)`/i.exec(text) ?? /\btitle:\s*"([^"]+)"/i.exec(text);

  if (nameMatch && titleMatch) {
    return validateExtracted(nameMatch[1], titleMatch[1]);
  }

  return null;
}

/** Validate extracted values against the same constraints as the schema. */
function validateExtracted(
  rawName: string,
  rawTitle: string
): { name: string; title: string } | null {
  const name = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  const title = rawTitle.trim();

  if (name.length < 2 || name.length > 20) return null;
  if (title.length < 5 || title.length > 60) return null;

  return { name, title };
}

/**
 * Sanitize a string to be git-safe: lowercase, hyphens only, no leading/trailing hyphens.
 */
function sanitizeBranchName(name: string, maxLength: number): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .substring(0, maxLength);
}
