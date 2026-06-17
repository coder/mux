import { isPlainObject } from "@/common/utils/isPlainObject";
import { parseStaticWorkflowMetadataLiteral } from "./staticWorkflowMetadata";

export interface WorkflowArgsNormalizationResult {
  args: unknown;
  metadata: WorkflowMetadata | null;
}

export class WorkflowArgsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowArgsValidationError";
  }
}

export interface WorkflowArgsNormalizationOptions {
  defaultArgs?: Record<string, unknown>;
}

interface WorkflowMetadata {
  argsSchema?: Record<string, unknown>;
}

interface ArgsPropertySchema {
  name: string;
  types: string[];
  defaultValue: unknown;
  aliases: string[];
  negatedAliases: string[];
  positional: boolean;
  minimum: number | null;
  maximum: number | null;
  enumValues: unknown[];
}

interface TokenizeResult {
  tokens: string[];
  error: string;
}

const RAW_INPUT_FIELD = "input";

export function normalizeWorkflowArgsForSource(
  definitionSource: string,
  rawArgs: unknown,
  options: WorkflowArgsNormalizationOptions = {}
): WorkflowArgsNormalizationResult {
  const metadata = parseWorkflowMetadata(definitionSource);
  if (metadata?.argsSchema == null) {
    return { args: rawArgs, metadata };
  }

  return {
    args: normalizeWorkflowArgs(metadata.argsSchema, rawArgs, options.defaultArgs ?? {}),
    metadata,
  };
}

function parseWorkflowMetadata(source: string): WorkflowMetadata | null {
  let rawMetadata: unknown;
  try {
    rawMetadata = parseStaticWorkflowMetadataLiteral(source);
  } catch {
    return null;
  }
  if (!isPlainObject(rawMetadata)) {
    throw validationError("Workflow metadata must be a static object literal");
  }
  const metadata: WorkflowMetadata = {};
  if (rawMetadata.argsSchema !== undefined) {
    if (!isPlainObject(rawMetadata.argsSchema)) {
      throw validationError("Workflow metadata.argsSchema must be an object schema");
    }
    metadata.argsSchema = rawMetadata.argsSchema;
  }
  return metadata;
}

function validationError(message: string): WorkflowArgsValidationError {
  return new WorkflowArgsValidationError(message);
}

function normalizeWorkflowArgs(
  schema: Record<string, unknown>,
  rawArgs: unknown,
  defaultArgs: Record<string, unknown>
): Record<string, unknown> {
  assertObjectSchema(schema);
  const properties = propertySchemas(schema);
  const normalized: Record<string, unknown> = {};

  const explicitProperties = new Set<string>();
  for (const property of properties) {
    if (property.defaultValue !== undefined) {
      normalized[property.name] = property.defaultValue;
    } else if (property.name in defaultArgs) {
      // Invocation context should help only workflows that explicitly declare the field.
      normalized[property.name] = defaultArgs[property.name];
    }
  }

  if (isPlainObject(rawArgs)) {
    for (const property of properties) {
      if (property.name in rawArgs) {
        normalized[property.name] = rawArgs[property.name];
        if (property.name !== RAW_INPUT_FIELD) {
          explicitProperties.add(property.name);
        }
      }
    }
  }

  const rawInput = workflowInputString(rawArgs);
  const inputProperty = properties.find(
    (property) => property.name === RAW_INPUT_FIELD && !property.positional
  );
  if (inputProperty != null && typeof rawArgs === "string" && rawInput.length > 0) {
    normalized[RAW_INPUT_FIELD] = rawInput;
  }
  // Slash/CLI text arrives as `input`; when a schema also declares `input`, use it
  // as the fallback positional target so aliases like `--quick` still parse.
  if (rawInput.length > 0) {
    const parsedInput = parseWorkflowInputString(rawInput, properties, inputProperty ?? null);
    for (const [name, value] of Object.entries(parsedInput)) {
      // Structured args beat the raw transport string; `input` itself is transport, not explicit.
      if (!explicitProperties.has(name)) {
        normalized[name] = value;
      }
    }
  }

  const coerced: Record<string, unknown> = {};
  for (const property of properties) {
    if (!(property.name in normalized)) {
      continue;
    }
    coerced[property.name] = coerceProperty(property, normalized[property.name]);
  }

  validateRequired(schema, coerced);
  return coerced;
}

function assertObjectSchema(schema: Record<string, unknown>): void {
  if (schema.type !== "object") {
    throw validationError('Workflow metadata.argsSchema must have type "object"');
  }
  if (!isPlainObject(schema.properties)) {
    throw validationError("Workflow metadata.argsSchema.properties must be an object");
  }
}

function propertySchemas(schema: Record<string, unknown>): ArgsPropertySchema[] {
  const rawProperties = schema.properties;
  if (!isPlainObject(rawProperties)) {
    throw validationError("Workflow metadata.argsSchema.properties must be an object");
  }

  return Object.entries(rawProperties).map(([name, rawProperty]) => {
    if (!isPlainObject(rawProperty)) {
      throw validationError(`Workflow args property ${name} must be an object schema`);
    }
    return {
      name,
      types: schemaTypes(rawProperty.type),
      defaultValue: rawProperty.default,
      aliases: aliasList(rawProperty.aliases),
      negatedAliases: aliasList(rawProperty.negatedAliases),
      positional: rawProperty.positional === true,
      minimum: optionalNumber(rawProperty.minimum),
      maximum: optionalNumber(rawProperty.maximum),
      enumValues: Array.isArray(rawProperty.enum) ? rawProperty.enum : [],
    };
  });
}

function schemaTypes(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) {
    const types = type.filter((candidate): candidate is string => typeof candidate === "string");
    return types.length > 0 ? Array.from(new Set(types)) : ["string"];
  }
  return ["string"];
}

function propertyAllowsType(property: ArgsPropertySchema, type: string): boolean {
  return property.types.includes(type);
}

function aliasList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function workflowInputString(rawArgs: unknown): string {
  if (typeof rawArgs === "string") {
    return rawArgs;
  }
  if (isPlainObject(rawArgs) && typeof rawArgs[RAW_INPUT_FIELD] === "string") {
    return rawArgs[RAW_INPUT_FIELD];
  }
  return "";
}

function parseWorkflowInputString(
  input: string,
  properties: ArgsPropertySchema[],
  fallbackPositionalProperty: ArgsPropertySchema | null
): Record<string, unknown> {
  const tokenized = tokenize(input);
  if (tokenized.error.length > 0) {
    throw validationError(tokenized.error);
  }

  const parsed: Record<string, unknown> = {};
  const positional: string[] = [];
  const explicitPositionalProperty = properties.find((property) => property.positional) ?? null;
  // Simple `{ input }` schemas should remain raw-text compatible: unknown `--...`
  // tokens are prose unless an explicit positional field opts into strict CLI parsing.
  const unknownFlagsArePositional =
    explicitPositionalProperty == null && fallbackPositionalProperty != null;
  let index = 0;
  while (index < tokenized.tokens.length) {
    const token = tokenized.tokens[index];
    const negatedProperty = findPropertyByNegatedAlias(properties, token);
    if (negatedProperty != null) {
      assertBooleanProperty(negatedProperty, token);
      parsed[negatedProperty.name] = false;
      index += 1;
      continue;
    }

    const exactAliasProperty = findPropertyByAlias(properties, token);
    if (exactAliasProperty != null) {
      if (propertyAllowsType(exactAliasProperty, "boolean")) {
        parsed[exactAliasProperty.name] = true;
        index += 1;
        continue;
      }
      const value = tokenized.tokens[index + 1];
      if (value == null || value.startsWith("--")) {
        throw validationError(`${token} requires a value`);
      }
      parsed[exactAliasProperty.name] = value;
      index += 2;
      continue;
    }

    const flag = parseFlagToken(token);
    if (flag == null) {
      positional.push(token);
      index += 1;
      continue;
    }

    const property = findPropertyByAlias(properties, flag.name);
    if (property == null) {
      if (unknownFlagsArePositional) {
        positional.push(token);
        index += 1;
        continue;
      }
      throw validationError(`Unknown workflow argument flag: ${flag.name}`);
    }

    if (propertyAllowsType(property, "boolean")) {
      parsed[property.name] =
        flag.inlineValue == null ? true : coerceBoolean(flag.inlineValue, flag.name);
      index += 1;
      continue;
    }

    const hasInlineValue = flag.inlineValue != null;
    const value = hasInlineValue ? flag.inlineValue : tokenized.tokens[index + 1];
    if (value == null || value.length === 0 || (!hasInlineValue && value.startsWith("--"))) {
      throw validationError(`${flag.name} requires a value`);
    }
    parsed[property.name] = value;
    index += hasInlineValue ? 1 : 2;
  }

  const positionalProperty = explicitPositionalProperty ?? fallbackPositionalProperty;
  if (positionalProperty != null && positional.length > 0) {
    parsed[positionalProperty.name] = positional.join(" ");
  } else if (positional.length > 0) {
    throw validationError(`Unexpected workflow positional argument: ${positional[0]}`);
  }

  return parsed;
}

function parseFlagToken(token: string): { name: string; inlineValue: string | null } | null {
  if (!token.startsWith("--")) {
    return null;
  }
  const equalsIndex = token.indexOf("=");
  if (equalsIndex === -1) {
    return { name: token, inlineValue: null };
  }
  const name = token.slice(0, equalsIndex);
  const inlineValue = token.slice(equalsIndex + 1);
  return { name, inlineValue };
}

function findPropertyByAlias(
  properties: ArgsPropertySchema[],
  flagName: string
): ArgsPropertySchema | null {
  return (
    properties.find(
      (property) =>
        property.aliases.includes(flagName) || defaultFlagName(property.name) === flagName
    ) ?? null
  );
}

function findPropertyByNegatedAlias(
  properties: ArgsPropertySchema[],
  flagName: string
): ArgsPropertySchema | null {
  return (
    properties.find(
      (property) =>
        property.negatedAliases.includes(flagName) ||
        defaultNegatedFlagName(property.name) === flagName
    ) ?? null
  );
}

function defaultFlagName(name: string): string {
  return "--" + name.replace(/[A-Z]/g, (character) => "-" + character.toLowerCase());
}

function defaultNegatedFlagName(name: string): string {
  return "--no-" + defaultFlagName(name).slice(2);
}

function assertBooleanProperty(property: ArgsPropertySchema, flagName: string): void {
  if (!propertyAllowsType(property, "boolean")) {
    throw validationError(`${flagName} can only negate a boolean workflow argument`);
  }
}

function coerceProperty(property: ArgsPropertySchema, value: unknown): unknown {
  if (value === null) {
    if (propertyAllowsType(property, "null")) return null;
    throw validationError(`Workflow argument ${property.name} must not be null`);
  }

  let lastError: Error | null = null;
  for (const type of property.types) {
    if (type === "null") continue;
    try {
      const coerced = coercePropertyType(property, value, type);
      validateBounds(property, coerced);
      validateEnum(property, coerced);
      return coerced;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw (
    lastError ??
    validationError(
      `Unsupported workflow args type for ${property.name}: ${property.types.join(", ")}`
    )
  );
}

function coercePropertyType(property: ArgsPropertySchema, value: unknown, type: string): unknown {
  switch (type) {
    case "string":
      return coerceString(value, property.name);
    case "boolean":
      return coerceBoolean(value, property.name);
    case "integer":
      return coerceInteger(value, property.name);
    case "number":
      return coerceNumber(value, property.name);
    case "array":
      return coerceArray(value, property.name);
    default:
      throw validationError(`Unsupported workflow args type for ${property.name}: ${type}`);
  }
}

function coerceString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw validationError(`Workflow argument ${name} must be a string`);
  }
  return value.trim();
}

function coerceBoolean(value: unknown, name: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  throw validationError(`Workflow argument ${name} must be a boolean`);
}

function coerceInteger(value: unknown, name: string): number {
  const number = coerceNumber(value, name);
  if (!Number.isInteger(number)) {
    throw validationError(`Workflow argument ${name} must be an integer`);
  }
  return number;
}

function coerceNumber(value: unknown, name: string): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    throw validationError(`Workflow argument ${name} must be a number`);
  }
  return number;
}

function coerceArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw validationError(`Workflow argument ${name} must be an array`);
  }
  return value;
}

function validateBounds(property: ArgsPropertySchema, value: unknown): void {
  if (typeof value !== "number") {
    return;
  }
  if (property.minimum != null && value < property.minimum) {
    throw validationError(`Workflow argument ${property.name} must be >= ${property.minimum}`);
  }
  if (property.maximum != null && value > property.maximum) {
    throw validationError(`Workflow argument ${property.name} must be <= ${property.maximum}`);
  }
}

function validateEnum(property: ArgsPropertySchema, value: unknown): void {
  if (property.enumValues.length === 0) {
    return;
  }
  if (!property.enumValues.some((candidate) => Object.is(candidate, value))) {
    throw validationError(
      `Workflow argument ${property.name} must be one of: ${property.enumValues.join(", ")}`
    );
  }
}

function validateRequired(schema: Record<string, unknown>, value: Record<string, unknown>): void {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const property of required) {
    if (typeof property !== "string") {
      throw validationError("Workflow metadata.argsSchema.required entries must be strings");
    }
    if (!(property in value)) {
      throw validationError(`Workflow argument ${property} is required`);
    }
  }
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function tokenize(input: string): TokenizeResult {
  const tokens: string[] = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      current += char === quote || char === "\\" ? char : "\\" + char;
      escaped = false;
    } else if (quote === '"' && char === "\\") {
      escaped = true;
    } else if (quote.length > 0) {
      if (char === quote) quote = "";
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quote.length > 0) return { tokens, error: "unterminated quoted workflow argument" };
  if (escaped) current += "\\";
  if (current.length > 0) tokens.push(current);
  return { tokens, error: "" };
}
