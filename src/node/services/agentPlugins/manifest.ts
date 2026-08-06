/**
 * Agent Plugins 1.0.0 manifest (`plugin.json`) validation.
 *
 * Implements §5 of the Agent Plugins specification (https://agent-plugins.org,
 * spec repo: agentplugins/agent-plugins-spec) against the canonical
 * plugin.schema.json:
 * - Closed top-level schema, but unknown top-level fields are NON-fatal:
 *   report + ignore (§5.3).
 * - `$schema` (required) dispatches the spec version; anything other than the
 *   recognized 1.0.0 const is rejected with the distinct "unsupported-version"
 *   reason so clients can report it separately from malformed manifests.
 * - `name` (required): 1-64 chars, lowercase alphanumeric/dot/hyphen,
 *   alphanumeric start/end, no `--` or `..` runs.
 * - Any other schema violation (wrong-typed permitted field) is fatal.
 * - `extensions`: a non-object value is NON-fatal (report + ignore); namespace
 *   member contents are never validated (§8.1/§11.1) — Mux implements no
 *   extension namespace, so all payloads are treated as opaque.
 */

/** Canonical `$schema` const for Agent Plugins 1.0.0 plugin manifests. */
export const AGENT_PLUGIN_SCHEMA_ID_1_0_0 =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

// Canonical name pattern from plugin.schema.json (JS supports the lookahead).
const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const PLUGIN_NAME_MAX_LENGTH = 64;

/** True when `name` satisfies the §5 plugin-name grammar. */
export function isValidAgentPluginName(name: string): boolean {
  return name.length <= PLUGIN_NAME_MAX_LENGTH && PLUGIN_NAME_PATTERN.test(name);
}

export interface AgentPluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface AgentPluginManifest {
  /** The accepted `$schema` value (identifies the spec version). */
  schemaId: string;
  name: string;
  version?: string;
  description?: string;
  author?: AgentPluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

export type PluginManifestValidation =
  | { ok: true; manifest: AgentPluginManifest; warnings: string[] }
  | { ok: false; reason: "unsupported-version" | "invalid-manifest"; errors: string[] };

const PERMITTED_TOP_LEVEL_KEYS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const OPTIONAL_STRING_FIELDS = [
  "version",
  "description",
  "homepage",
  "repository",
  "license",
] as const;

const AUTHOR_KEYS = ["name", "email", "url"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validatePluginManifest(raw: unknown): PluginManifestValidation {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      reason: "invalid-manifest",
      errors: ["plugin.json must be a JSON object"],
    };
  }

  const warnings: string[] = [];
  const errors: string[] = [];

  // §5.3: unknown top-level fields are ignored with a report, not fatal.
  for (const key of Object.keys(raw)) {
    if (!PERMITTED_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`Unknown top-level field '${key}' ignored`);
    }
  }

  const schemaId = raw.$schema;
  if (typeof schemaId !== "string") {
    return {
      ok: false,
      reason: "invalid-manifest",
      errors: ["'$schema' is required and must be a string"],
    };
  }
  if (schemaId !== AGENT_PLUGIN_SCHEMA_ID_1_0_0) {
    // Distinct reason so callers can report "newer/unknown spec version" separately.
    return {
      ok: false,
      reason: "unsupported-version",
      errors: [`Unsupported Agent Plugins '$schema': '${schemaId}'`],
    };
  }

  const name = raw.name;
  if (typeof name !== "string" || !isValidAgentPluginName(name)) {
    errors.push(
      "'name' is required and must be 1-64 characters of lowercase [a-z0-9.-], starting/ending alphanumeric, without '--' or '..'"
    );
  }

  for (const field of OPTIONAL_STRING_FIELDS) {
    const value = raw[field];
    if (value !== undefined && typeof value !== "string") {
      errors.push(`'${field}' must be a string`);
    }
  }

  const keywords = raw.keywords;
  if (
    keywords !== undefined &&
    (!Array.isArray(keywords) || keywords.some((keyword) => typeof keyword !== "string"))
  ) {
    errors.push("'keywords' must be an array of strings");
  }

  let author: AgentPluginAuthor | undefined;
  if (raw.author !== undefined) {
    if (!isPlainObject(raw.author)) {
      errors.push("'author' must be an object");
    } else {
      // Canonical schema closes the author object (additionalProperties: false).
      const authorRecord = raw.author;
      const authorErrors: string[] = [];
      for (const key of Object.keys(authorRecord)) {
        if (!AUTHOR_KEYS.includes(key as (typeof AUTHOR_KEYS)[number])) {
          authorErrors.push(`'author.${key}' is not a permitted field`);
        }
      }
      for (const key of AUTHOR_KEYS) {
        const value = authorRecord[key];
        if (value !== undefined && typeof value !== "string") {
          authorErrors.push(`'author.${key}' must be a string`);
        }
      }

      if (authorErrors.length > 0) {
        errors.push(...authorErrors);
      } else {
        author = {
          ...(typeof authorRecord.name === "string" ? { name: authorRecord.name } : {}),
          ...(typeof authorRecord.email === "string" ? { email: authorRecord.email } : {}),
          ...(typeof authorRecord.url === "string" ? { url: authorRecord.url } : {}),
        };
      }
    }
  }

  // §8.1/§11.1: a non-object `extensions` value is reported and ignored; object
  // contents are opaque and never validated (do not enforce the JSON Schema's
  // per-namespace member typing here).
  if (raw.extensions !== undefined && !isPlainObject(raw.extensions)) {
    warnings.push("'extensions' must be an object; ignoring");
  }

  if (errors.length > 0) {
    return { ok: false, reason: "invalid-manifest", errors };
  }

  // Narrowing: `name` passed validation above or we'd have returned errors.
  if (typeof name !== "string") {
    throw new Error("validatePluginManifest: name must be a string after validation");
  }

  const manifest: AgentPluginManifest = {
    schemaId,
    name,
    ...(typeof raw.version === "string" ? { version: raw.version } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(author !== undefined ? { author } : {}),
    ...(typeof raw.homepage === "string" ? { homepage: raw.homepage } : {}),
    ...(typeof raw.repository === "string" ? { repository: raw.repository } : {}),
    ...(typeof raw.license === "string" ? { license: raw.license } : {}),
    ...(Array.isArray(keywords)
      ? { keywords: keywords.filter((k): k is string => typeof k === "string") }
      : {}),
  };

  return { ok: true, manifest, warnings };
}
