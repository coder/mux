import { APICallError, NoObjectGeneratedError, Output, RetryError, streamText } from "ai";
import { z } from "zod";
import type { AIService } from "./aiService";
import { log } from "./log";
import type { Result } from "@/common/types/result";
import { Ok, Err } from "@/common/types/result";
import type { NameGenerationError, SendMessageError } from "@/common/types/errors";
import { getErrorMessage } from "@/common/utils/errors";
import { classify429Capacity } from "@/common/utils/errors/classify429Capacity";
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

interface NameGenerationStreamFallback {
  text: PromiseLike<string>;
  content: PromiseLike<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract text payloads from a content-part array returned by some providers,
 * e.g. [{ type: "text", text: "..." }].
 */
export function extractTextFromContentParts(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const textParts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) {
      continue;
    }

    if (typeof part.text === "string" && part.text.trim().length > 0) {
      textParts.push(part.text);
    }

    const nestedText = extractTextFromContentParts(part.content);
    if (nestedText) {
      textParts.push(nestedText);
    }
  }

  return textParts.length > 0 ? textParts.join("\n\n") : null;
}

function collectFallbackTextCandidates(error: unknown): string[] {
  const candidates: string[] = [];

  const pushCandidate = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    candidates.push(trimmed);
  };

  const visit = (value: unknown, depth: number): void => {
    if (value == null || depth > 2) {
      return;
    }

    if (typeof value === "string") {
      pushCandidate(value);
      return;
    }

    if (NoObjectGeneratedError.isInstance(value)) {
      pushCandidate(value.text);
    }

    if (value instanceof Error) {
      pushCandidate(value.message);
      visit(value.cause, depth + 1);
    }

    if (!isRecord(value)) {
      return;
    }

    pushCandidate(value.text);
    pushCandidate(value.message);
    pushCandidate(value.body);
    pushCandidate(extractTextFromContentParts(value.content));

    visit(value.cause, depth + 1);
    visit(value.response, depth + 1);
  };

  visit(error, 0);

  return [...new Set(candidates)];
}

async function recoverIdentityFromFallback(
  error: unknown,
  stream: NameGenerationStreamFallback | null
): Promise<{ name: string; title: string } | null> {
  const candidates = collectFallbackTextCandidates(error);

  if (stream) {
    try {
      candidates.push((await stream.text).trim());
    } catch {
      // Ignore read errors; we still have error-derived candidates.
    }

    try {
      const contentText = extractTextFromContentParts(await stream.content);
      if (contentText) {
        candidates.push(contentText.trim());
      }
    } catch {
      // Ignore read errors; we still have error-derived candidates.
    }
  }

  const uniqueCandidates = [...new Set(candidates.filter((text) => text.length > 0))];
  for (const candidate of uniqueCandidates) {
    const parsed = extractIdentityFromText(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function inferProviderFromModelString(modelString: string): string | undefined {
  const provider = modelString.split(":")[0]?.trim();
  return provider && provider.length > 0 ? provider : undefined;
}

export function mapNameGenerationError(error: unknown, modelString: string): NameGenerationError {
  if (RetryError.isInstance(error) && error.lastError) {
    return mapNameGenerationError(error.lastError, modelString);
  }

  const provider = inferProviderFromModelString(modelString);

  if (APICallError.isInstance(error)) {
    if (error.statusCode === 401) {
      return {
        type: "authentication",
        authKind: "invalid_credentials",
        provider,
        raw: error.message,
      };
    }
    if (error.statusCode === 403) {
      return { type: "permission_denied", provider, raw: error.message };
    }
    if (error.statusCode === 402) {
      return { type: "quota", raw: error.message };
    }
    if (error.statusCode === 429) {
      const kind = classify429Capacity({
        message: error.message,
        data: error.data,
        responseBody: error.responseBody,
      });
      return { type: kind, raw: error.message };
    }
    if (error.statusCode != null && error.statusCode >= 500) {
      return { type: "service_unavailable", raw: error.message };
    }
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    return {
      type: "unknown",
      raw: "The model returned an unexpected format while generating a workspace name.",
    };
  }

  if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
    return { type: "network", raw: error.message };
  }

  const raw = getErrorMessage(error);
  return { type: "unknown", raw };
}

export function mapModelCreationError(
  error: SendMessageError,
  modelString: string
): NameGenerationError {
  const provider = inferProviderFromModelString(modelString);

  switch (error.type) {
    case "api_key_not_found":
      return {
        type: "authentication",
        authKind: "api_key_missing",
        provider: error.provider ?? provider,
      };
    case "oauth_not_connected":
      return {
        type: "authentication",
        authKind: "oauth_not_connected",
        provider: error.provider ?? provider,
      };
    case "provider_disabled":
      return { type: "configuration", raw: "Provider disabled" };
    case "provider_not_supported":
      return { type: "configuration", raw: "Provider not supported" };
    case "policy_denied":
      return { type: "policy", provider, raw: error.message };
    case "unknown":
      return { type: "unknown", raw: error.raw ?? "Unknown error" };
    default: {
      const raw =
        "message" in error && typeof error.message === "string"
          ? error.message
          : `Failed to create model for ${modelString}: ${error.type}`;
      return { type: "unknown", raw };
    }
  }
}

/**
 * Generate workspace identity (name + title) using AI.
 * Tries candidates in order, retrying on API errors (invalid keys, quota, etc.).
 *
 * - name: Codebase area with 4-char suffix (e.g., "sidebar-a1b2")
 * - title: Human-readable description (e.g., "Fix plan mode over SSH")
 */
export function buildWorkspaceIdentityPrompt(
  message: string,
  conversationContext?: string,
  latestUserMessage?: string
): string {
  const promptSections: string[] = [`Primary user objective: "${message}"`];

  const trimmedConversationContext = conversationContext?.trim();
  if (trimmedConversationContext && trimmedConversationContext.length > 0) {
    promptSections.push(
      `Conversation turns (chronological sample):\n${trimmedConversationContext.slice(0, 6_000)}`
    );

    const normalizedLatestUserMessage = latestUserMessage?.replace(/\s+/g, " ").trim();
    if (normalizedLatestUserMessage) {
      promptSections.push(
        `Most recent user message (extra context; do not prefer it over earlier turns): "${normalizedLatestUserMessage.slice(0, 1_000)}"`
      );
    }
  }

  // Prompt wording is tuned for short UI titles that stay accurate over the whole chat,
  // rather than over-indexing on whichever message happened most recently.
  return [
    "Generate a workspace name and title for this development task:\n\n",
    `${promptSections.join("\n\n")}\n\n`,
    "Requirements:\n",
    '- name: The area of the codebase being worked on (1-2 words, max 15 chars, git-safe: lowercase, hyphens only). Random bytes will be appended for uniqueness, so focus on the area not the specific task. Examples: "sidebar", "auth", "config", "api"\n',
    '- title: 2-5 words, verb-noun format, describing the primary deliverable (what will be different when the work is done). Examples: "Fix plan mode", "Add user authentication", "Refactor sidebar layout"\n',
    '- title quality: Be specific about the feature/system being changed. Prefer concrete nouns; avoid vague words ("stuff", "things"), self-referential meta phrases ("this chat", "this conversation", "regenerate title"), and temporal words ("latest", "recent", "today", "now").\n',
    "- title scope: Choose the title that best represents the overall scope and goal across the entire conversation. Weigh all turns equally — do not favor the most recent message over earlier ones.\n",
    "- title style: Sentence case, no punctuation, no quotes.\n",
  ].join("");
}

export async function generateWorkspaceIdentity(
  message: string,
  candidates: string[],
  aiService: AIService,
  /** Optional conversation turns context used for regenerate-title prompts. */
  conversationContext?: string,
  /** Optional most recent user message; included as additional context only — not given precedence over older turns. */
  latestUserMessage?: string
): Promise<Result<GenerateWorkspaceIdentityResult, NameGenerationError>> {
  if (candidates.length === 0) {
    return Err({ type: "unknown", raw: "No model candidates provided for name generation" });
  }

  // Try up to 3 candidates
  const maxAttempts = Math.min(candidates.length, 3);

  // Track the last classified error to return if all candidates fail
  let lastError: NameGenerationError | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const modelString = candidates[i];

    const modelResult = await aiService.createModel(modelString);
    if (!modelResult.success) {
      lastError = mapModelCreationError(modelResult.error, modelString);
      log.debug(`Name generation: skipping ${modelString} (${modelResult.error.type})`);
      continue;
    }

    let stream: NameGenerationStreamFallback | null = null;
    try {
      // Use streamText instead of generateText: the Codex OAuth endpoint
      // (chatgpt.com/backend-api/codex/responses) requires stream:true in the
      // request body and rejects non-streaming requests with 400.  streamText
      // sets stream:true automatically, while generateText does not.
      const currentStream = streamText({
        model: modelResult.data,
        output: Output.object({ schema: workspaceIdentitySchema }),
        prompt: buildWorkspaceIdentityPrompt(message, conversationContext, latestUserMessage),
      });
      stream = currentStream;

      // Awaiting .output triggers full stream consumption and JSON parsing.
      // If the model returned conversational text instead of JSON, this throws
      // NoObjectGeneratedError — caught below with a text fallback parser.
      const output = await currentStream.output;

      const suffix = generateNameSuffix();
      const sanitizedName = sanitizeBranchName(output.name, 20);
      const nameWithSuffix = `${sanitizedName}-${suffix}`;

      return Ok({
        name: nameWithSuffix,
        title: output.title.trim(),
        modelUsed: modelString,
      });
    } catch (error) {
      // Some models ignore structured output instructions and return prose or
      // content arrays. Recover from any available text source (error.text,
      // stream.text, stream.content) before giving up on this candidate.
      const fallback = await recoverIdentityFromFallback(error, stream);
      if (fallback) {
        log.info(
          `Name generation: structured output failed for ${modelString}, recovered from text fallback`
        );
        const suffix = generateNameSuffix();
        const sanitizedName = sanitizeBranchName(fallback.name, 20);
        const nameWithSuffix = `${sanitizedName}-${suffix}`;
        return Ok({
          name: nameWithSuffix,
          title: fallback.title,
          modelUsed: modelString,
        });
      }

      lastError = mapNameGenerationError(error, modelString);
      log.warn("Name generation failed, trying next candidate", { modelString, error: lastError });
      continue;
    }
  }

  return Err(
    lastError ?? {
      type: "configuration",
      raw: "No working model candidates were available for name generation.",
    }
  );
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

  // Try markdown/prose patterns (supports both **name:** and **name**: forms).
  const name = extractLabeledValue(text, "name");
  const title = extractLabeledValue(text, "title");

  if (name && title) {
    return validateExtracted(name, title);
  }

  return null;
}

function extractLabeledValue(text: string, label: "name" | "title"): string | null {
  const emphasizedLabelPrefixes = [
    `(?:^|[^a-z0-9_])\\s*\\*{1,2}${label}\\*{1,2}\\s*:\\*{0,2}\\s*`, // **name**:
    `(?:^|[^a-z0-9_])\\s*\\*{1,2}${label}\\s*:\\*{1,2}\\s*`, // **name:**
  ];
  const anyLabelPrefix = `(?:^|[^a-z0-9_])\\s*\\*{0,2}${label}\\*{0,2}\\s*:\\*{0,2}\\s*`;

  // Prefer emphasized labels (e.g. **name:** or **name**:) to avoid capturing
  // earlier guidance prose like "name: should be lowercase".
  for (const prefix of emphasizedLabelPrefixes) {
    const value = findFirstUsableLabeledValue(text, label, prefix);
    if (value) {
      return value;
    }
  }

  return findFirstUsableLabeledValue(text, label, anyLabelPrefix);
}

function findFirstUsableLabeledValue(
  text: string,
  label: "name" | "title",
  labelPrefix: string
): string | null {
  const structuredPattern = new RegExp(
    `${labelPrefix}(?:\`([^\`\\n\\r]+)\`|"([^"\\n\\r]+)"|'([^'\\n\\r]+)')`,
    "gi"
  );

  // Prefer explicit quoted/backticked values over free-form captures.
  for (const match of text.matchAll(structuredPattern)) {
    const value = cleanExtractedValue(match[1] ?? match[2] ?? match[3] ?? "");
    if (!isUsableExtractedValue(label, value, "structured")) {
      continue;
    }
    return value;
  }

  const barePattern = new RegExp(`${labelPrefix}([^\\n\\r]+)`, "gi");
  for (const match of text.matchAll(barePattern)) {
    const value = cleanExtractedValue(match[1] ?? "");
    if (!isUsableExtractedValue(label, value, "bare")) {
      continue;
    }
    return value;
  }

  return null;
}

function isUsableExtractedValue(
  label: "name" | "title",
  value: string | null,
  source: "structured" | "bare"
): value is string {
  if (!value) {
    return false;
  }

  if (looksLikeGuidanceInstruction(value)) {
    return false;
  }

  if (label === "title" && source === "bare" && looksLikeTitleRequirement(value)) {
    return false;
  }

  if (label === "name") {
    const normalizedName = value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
    if (!/^[a-z0-9-]{2,20}$/.test(normalizedName)) {
      return false;
    }
  }

  return true;
}

function looksLikeGuidanceInstruction(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (/^(?:should|must)\s+be\b/.test(normalized)) {
    return true;
  }

  return /^(?:be\s+)?(?:lowercase(?: and short)?|verb-noun format|sentence case)$/.test(normalized);
}

function looksLikeTitleRequirement(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (/^\d+\s*-\s*\d+\s*words?(?:[,.;:].*)?$/.test(normalized)) {
    return true;
  }

  return /\b\d+\s*-\s*\d+\s*words?\b/.test(normalized) && /\bverb-noun format\b/.test(normalized);
}
function cleanExtractedValue(rawValue: string): string | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // If both fields are emitted on one line, keep only this field's value.
  const nextFieldBoundary = /\s+[•*-]\s+\*{0,2}(?:name|title)\*{0,2}\s*:\*{0,2}.*$/i;
  const cleaned = trimmed.replace(nextFieldBoundary, "").trim();
  if (cleaned.length === 0) {
    return null;
  }

  // Bare-label extraction can capture surrounding delimiters from values that
  // were already seen in structured form (e.g. "sentence case"). Remove one
  // matching wrapper pair so guidance detection remains effective.
  const wrappedMatch = /^([`"'])([\s\S]*)\1$/.exec(cleaned);
  const normalized = wrappedMatch ? wrappedMatch[2].trim() : cleaned;
  return normalized.length > 0 ? normalized : null;
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
