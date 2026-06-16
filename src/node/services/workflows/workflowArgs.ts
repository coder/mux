import { isPlainObject } from "@/common/utils/isPlainObject";
import { parseStaticWorkflowMetadataLiteral } from "./WorkflowActionRunner";

export interface WorkflowArgsNormalizationResult {
  args: unknown;
  metadata: WorkflowMetadata | null;
}

interface WorkflowMetadata {
  argsSchema?: Record<string, unknown>;
}

interface ArgsPropertySchema {
  name: string;
  type: string;
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
  rawArgs: unknown
): WorkflowArgsNormalizationResult {
  const metadata = parseWorkflowMetadata(definitionSource);
  if (metadata?.argsSchema == null) {
    return { args: rawArgs, metadata };
  }

  return { args: normalizeWorkflowArgs(metadata.argsSchema, rawArgs), metadata };
}

function parseWorkflowMetadata(source: string): WorkflowMetadata | null {
  let rawMetadata: unknown;
  try {
    rawMetadata = parseStaticWorkflowMetadataLiteral(source);
  } catch {
    return null;
  }
  if (!isPlainObject(rawMetadata)) {
    throw new Error("Workflow metadata must be a static object literal");
  }
  const metadata: WorkflowMetadata = {};
  if (rawMetadata.argsSchema !== undefined) {
    if (!isPlainObject(rawMetadata.argsSchema)) {
      throw new Error("Workflow metadata.argsSchema must be an object schema");
    }
    metadata.argsSchema = rawMetadata.argsSchema;
  }
  return metadata;
}

function normalizeWorkflowArgs(
  schema: Record<string, unknown>,
  rawArgs: unknown
): Record<string, unknown> {
  assertObjectSchema(schema);
  const properties = propertySchemas(schema);
  const normalized: Record<string, unknown> = {};

  for (const property of properties) {
    if (property.defaultValue !== undefined) {
      normalized[property.name] = property.defaultValue;
    }
  }

  if (isPlainObject(rawArgs)) {
    for (const property of properties) {
      if (property.name in rawArgs) {
        normalized[property.name] = rawArgs[property.name];
      }
    }
  }

  const rawInput = workflowInputString(rawArgs);
  if (rawInput.length > 0) {
    Object.assign(normalized, parseWorkflowInputString(rawInput, properties));
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
    throw new Error('Workflow metadata.argsSchema must have type "object"');
  }
  if (!isPlainObject(schema.properties)) {
    throw new Error("Workflow metadata.argsSchema.properties must be an object");
  }
}

function propertySchemas(schema: Record<string, unknown>): ArgsPropertySchema[] {
  const rawProperties = schema.properties;
  if (!isPlainObject(rawProperties)) {
    throw new Error("Workflow metadata.argsSchema.properties must be an object");
  }

  return Object.entries(rawProperties).map(([name, rawProperty]) => {
    if (!isPlainObject(rawProperty)) {
      throw new Error(`Workflow args property ${name} must be an object schema`);
    }
    const type = typeof rawProperty.type === "string" ? rawProperty.type : "string";
    return {
      name,
      type,
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
  properties: ArgsPropertySchema[]
): Record<string, unknown> {
  const tokenized = tokenize(input);
  if (tokenized.error.length > 0) {
    throw new Error(tokenized.error);
  }

  const parsed: Record<string, unknown> = {};
  const positional: string[] = [];
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

    const flag = parseFlagToken(token);
    if (flag == null) {
      positional.push(token);
      index += 1;
      continue;
    }

    const property = findPropertyByAlias(properties, flag.name);
    if (property == null) {
      throw new Error(`Unknown workflow argument flag: ${flag.name}`);
    }

    if (property.type === "boolean") {
      parsed[property.name] =
        flag.inlineValue == null ? true : coerceBoolean(flag.inlineValue, flag.name);
      index += 1;
      continue;
    }

    const value = flag.inlineValue ?? tokenized.tokens[index + 1];
    if (value == null || value.startsWith("--")) {
      throw new Error(`${flag.name} requires a value`);
    }
    parsed[property.name] = value;
    index += flag.inlineValue == null ? 2 : 1;
  }

  const positionalProperty = properties.find((property) => property.positional);
  if (positionalProperty != null && positional.length > 0) {
    parsed[positionalProperty.name] = positional.join(" ");
  } else if (positional.length > 0) {
    throw new Error(`Unexpected workflow positional argument: ${positional[0]}`);
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
  if (inlineValue.length === 0) {
    throw new Error(`${name} requires a value`);
  }
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
  if (property.type !== "boolean") {
    throw new Error(`${flagName} can only negate a boolean workflow argument`);
  }
}

function coerceProperty(property: ArgsPropertySchema, value: unknown): unknown {
  let coerced: unknown;
  switch (property.type) {
    case "string":
      coerced = coerceString(value, property.name);
      break;
    case "boolean":
      coerced = coerceBoolean(value, property.name);
      break;
    case "integer":
      coerced = coerceInteger(value, property.name);
      break;
    case "number":
      coerced = coerceNumber(value, property.name);
      break;
    case "array":
      coerced = coerceArray(value, property.name);
      break;
    default:
      throw new Error(`Unsupported workflow args type for ${property.name}: ${property.type}`);
  }

  validateBounds(property, coerced);
  validateEnum(property, coerced);
  return coerced;
}

function coerceString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`Workflow argument ${name} must be a string`);
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
  throw new Error(`Workflow argument ${name} must be a boolean`);
}

function coerceInteger(value: unknown, name: string): number {
  const number = coerceNumber(value, name);
  if (!Number.isInteger(number)) {
    throw new Error(`Workflow argument ${name} must be an integer`);
  }
  return number;
}

function coerceNumber(value: unknown, name: string): number {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(number)) {
    throw new Error(`Workflow argument ${name} must be a number`);
  }
  return number;
}

function coerceArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Workflow argument ${name} must be an array`);
  }
  return value;
}

function validateBounds(property: ArgsPropertySchema, value: unknown): void {
  if (typeof value !== "number") {
    return;
  }
  if (property.minimum != null && value < property.minimum) {
    throw new Error(`Workflow argument ${property.name} must be >= ${property.minimum}`);
  }
  if (property.maximum != null && value > property.maximum) {
    throw new Error(`Workflow argument ${property.name} must be <= ${property.maximum}`);
  }
}

function validateEnum(property: ArgsPropertySchema, value: unknown): void {
  if (property.enumValues.length === 0) {
    return;
  }
  if (!property.enumValues.some((candidate) => Object.is(candidate, value))) {
    throw new Error(
      `Workflow argument ${property.name} must be one of: ${property.enumValues.join(", ")}`
    );
  }
}

function validateRequired(schema: Record<string, unknown>, value: Record<string, unknown>): void {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const property of required) {
    if (typeof property !== "string") {
      throw new Error("Workflow metadata.argsSchema.required entries must be strings");
    }
    if (!(property in value)) {
      throw new Error(`Workflow argument ${property} is required`);
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
      current += char;
      escaped = false;
    } else if (quote.length > 0 && char === "\\") {
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
