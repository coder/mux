import { type Tool } from "ai";

/**
 * JSON Schema properties that are not permitted by OpenAI's Responses API.
 *
 * OpenAI's Structured Outputs has stricter JSON Schema validation than other providers.
 * MCP tools may have schemas with these properties which work fine with Anthropic
 * but fail with OpenAI. We strip these properties to ensure compatibility.
 *
 * @see https://platform.openai.com/docs/guides/structured-outputs
 * @see https://github.com/vercel/ai/discussions/5164
 */
const OPENAI_UNSUPPORTED_SCHEMA_PROPERTIES = new Set([
  // String validation
  "minLength",
  "maxLength",
  "pattern",
  "format",
  // Number validation
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  // Array validation
  "minItems",
  "maxItems",
  "uniqueItems",
  // Object validation
  "minProperties",
  "maxProperties",
  // General
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  // Composition (partially supported - strip from items/properties)
  // Note: oneOf/anyOf at root level may work, but not in nested contexts
]);

/**
 * Recursively strip unsupported schema properties for OpenAI compatibility.
 * This mutates the schema in place for efficiency.
 */
function stripUnsupportedProperties(schema: unknown): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }

  const obj = schema as Record<string, unknown>;

  // Remove unsupported properties at this level
  for (const prop of OPENAI_UNSUPPORTED_SCHEMA_PROPERTIES) {
    if (prop in obj) {
      delete obj[prop];
    }
  }

  // Recursively process nested schemas
  if (obj.properties && typeof obj.properties === "object") {
    for (const propSchema of Object.values(obj.properties as Record<string, unknown>)) {
      stripUnsupportedProperties(propSchema);
    }
  }

  if (obj.items) {
    if (Array.isArray(obj.items)) {
      for (const itemSchema of obj.items) {
        stripUnsupportedProperties(itemSchema);
      }
    } else {
      stripUnsupportedProperties(obj.items);
    }
  }

  if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
    stripUnsupportedProperties(obj.additionalProperties);
  }

  // Handle anyOf/oneOf/allOf
  for (const keyword of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(obj[keyword])) {
      for (const subSchema of obj[keyword] as unknown[]) {
        stripUnsupportedProperties(subSchema);
      }
    }
  }

  // Handle definitions/defs (JSON Schema draft-07 and later)
  for (const defsKey of ["definitions", "$defs"]) {
    if (obj[defsKey] && typeof obj[defsKey] === "object") {
      for (const defSchema of Object.values(obj[defsKey] as Record<string, unknown>)) {
        stripUnsupportedProperties(defSchema);
      }
    }
  }
}

/**
 * Sanitize a tool's parameter schema for OpenAI Responses API compatibility.
 *
 * OpenAI's Responses API has stricter JSON Schema validation than other providers.
 * This function creates a new tool with sanitized parameters that strips
 * unsupported schema properties like minLength, maximum, default, etc.
 *
 * Tools can have schemas in two places:
 * - `parameters`: Used by tools created with ai SDK's `tool()` function
 * - `inputSchema`: Used by MCP tools created with `dynamicTool()` from @ai-sdk/mcp
 *
 * @param tool - The original tool to sanitize
 * @returns A new tool with sanitized parameter schema
 */
export function sanitizeToolSchemaForOpenAI(tool: Tool): Tool {
  // Access tool internals - the AI SDK tool structure varies:
  // - Regular tools have `parameters` (Zod schema)
  // - MCP/dynamic tools have `inputSchema` (JSON Schema wrapper with getter)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const toolRecord = tool as any as Record<string, unknown>;

  // Check for inputSchema first (MCP tools use this)
  // The inputSchema is a wrapper object with a jsonSchema getter
  if (toolRecord.inputSchema && typeof toolRecord.inputSchema === "object") {
    const inputSchemaWrapper = toolRecord.inputSchema as Record<string, unknown>;

    // Get the actual JSON Schema - it's exposed via a getter
    const rawJsonSchema = inputSchemaWrapper.jsonSchema;
    if (rawJsonSchema && typeof rawJsonSchema === "object") {
      // Deep clone and sanitize
      const clonedSchema = JSON.parse(JSON.stringify(rawJsonSchema)) as Record<string, unknown>;
      stripUnsupportedProperties(clonedSchema);

      // Create a new inputSchema wrapper that returns our sanitized schema
      const sanitizedInputSchema = {
        ...inputSchemaWrapper,
        // Override the jsonSchema getter with our sanitized version
        get jsonSchema() {
          return clonedSchema;
        },
      };

      return {
        ...tool,
        inputSchema: sanitizedInputSchema,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any as Tool;
    }
  }

  // Fall back to parameters (regular AI SDK tools)
  if (!toolRecord.parameters) {
    return tool;
  }

  // Deep clone the parameters to avoid mutating the original
  const clonedParams = JSON.parse(JSON.stringify(toolRecord.parameters)) as unknown;

  // Strip unsupported properties
  stripUnsupportedProperties(clonedParams);

  // Create a new tool with sanitized parameters
  return {
    ...tool,
    parameters: clonedParams,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Tool;
}

/**
 * Sanitize all MCP tools for OpenAI compatibility.
 *
 * @param mcpTools - Record of MCP tools to sanitize
 * @returns Record of sanitized tools
 */
export function sanitizeMCPToolsForOpenAI(mcpTools: Record<string, Tool>): Record<string, Tool> {
  const sanitized: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(mcpTools)) {
    sanitized[name] = sanitizeToolSchemaForOpenAI(tool);
  }
  return sanitized;
}
