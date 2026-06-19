export interface JsonSchemaValidationError {
  path: string;
  message: string;
}

export type JsonSchemaSubsetValidationResult =
  | { success: true }
  | { success: false; errors: JsonSchemaValidationError[] };

export function formatJsonSchemaValidationErrors(
  errors: readonly JsonSchemaValidationError[],
  options?: { maxErrors?: number }
): string {
  const visibleErrors =
    options?.maxErrors === undefined ? errors : errors.slice(0, options.maxErrors);
  return visibleErrors.map((error) => `${error.path}: ${error.message}`).join("; ");
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "enum",
]);

export function validateJsonSchemaSubsetSchema(schema: unknown): JsonSchemaSubsetValidationResult {
  if (!isPlainRecord(schema)) {
    return { success: false, errors: [{ path: "$", message: "Schema must be an object" }] };
  }

  const errors: JsonSchemaValidationError[] = [];
  collectUnsupportedKeywordErrors(schema, "$", errors);
  return errors.length === 0 ? { success: true } : { success: false, errors };
}

export function validateJsonSchemaSubset(
  schema: unknown,
  value: unknown
): JsonSchemaSubsetValidationResult {
  const schemaValidation = validateJsonSchemaSubsetSchema(schema);
  if (!schemaValidation.success) {
    return schemaValidation;
  }

  const errors: JsonSchemaValidationError[] = [];
  validateValue(schema, value, "$", errors);
  return errors.length === 0 ? { success: true } : { success: false, errors };
}

function validateValue(
  schema: unknown,
  value: unknown,
  path: string,
  errors: JsonSchemaValidationError[]
): void {
  if (!isPlainRecord(schema)) {
    errors.push({ path, message: "Schema must be an object" });
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push({ path, message: `Expected one of: ${schema.enum.map(String).join(", ")}` });
  }

  if (typeof schema.type === "string" || Array.isArray(schema.type)) {
    validateType(schema.type, value, path, errors);
  }

  if (schemaAllowsType(schema, "object") && isPlainRecord(value)) {
    validateObject(schema, value, path, errors);
  }

  if (schemaAllowsType(schema, "array") && Array.isArray(value)) {
    validateArray(schema, value, path, errors);
  }
}

function validateObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  errors: JsonSchemaValidationError[]
): void {
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];

  for (const property of required) {
    if (typeof property !== "string") {
      errors.push({ path, message: "Required property names must be strings" });
      continue;
    }
    if (!(property in value)) {
      errors.push({ path: `${path}.${property}`, message: "Required property is missing" });
    }
  }

  for (const [property, propertySchema] of Object.entries(properties)) {
    if (property in value) {
      validateValue(propertySchema, value[property], `${path}.${property}`, errors);
    }
  }

  if (schema.additionalProperties === false) {
    const allowedProperties = new Set(Object.keys(properties));
    for (const property of Object.keys(value)) {
      if (!allowedProperties.has(property)) {
        errors.push({ path: `${path}.${property}`, message: "Additional property is not allowed" });
      }
    }
  }
}

function validateArray(
  schema: Record<string, unknown>,
  value: unknown[],
  path: string,
  errors: JsonSchemaValidationError[]
): void {
  if (schema.items == null) {
    return;
  }

  for (const [index, item] of value.entries()) {
    validateValue(schema.items, item, `${path}[${index}]`, errors);
  }
}

function validateType(
  type: string | unknown[],
  value: unknown,
  path: string,
  errors: JsonSchemaValidationError[]
): void {
  const types = Array.isArray(type) ? type : [type];
  const unsupported = types.filter((candidate) => !isSupportedJsonSchemaType(candidate));
  if (unsupported.length > 0) {
    errors.push({
      path,
      message: `Unsupported JSON Schema type: ${unsupported.map(String).join(", ")}`,
    });
    return;
  }
  const supportedTypes = types.filter(isSupportedJsonSchemaType);
  if (supportedTypes.some((candidate) => valueMatchesType(candidate, value))) {
    return;
  }
  errors.push({
    path,
    message: `Expected ${supportedTypes.join(" or ")}, got ${getJsonType(value)}`,
  });
}

function valueMatchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isSupportedJsonSchemaType(value: unknown): value is string {
  return (
    value === "object" ||
    value === "array" ||
    value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "null"
  );
}

function schemaAllowsType(schema: Record<string, unknown>, type: string): boolean {
  const schemaType = schema.type;
  return schemaType === type || (Array.isArray(schemaType) && schemaType.includes(type));
}

function collectUnsupportedKeywordErrors(
  schema: unknown,
  path: string,
  errors: JsonSchemaValidationError[]
): void {
  if (!isPlainRecord(schema)) {
    return;
  }

  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      errors.push({ path, message: `Unsupported JSON Schema keyword: ${key}` });
    }
  }

  if (Array.isArray(schema.type)) {
    const invalidTypes = schema.type.filter((type) => !isSupportedJsonSchemaType(type));
    if (invalidTypes.length > 0) {
      errors.push({
        path: `${path}.type`,
        message: `Unsupported JSON Schema type: ${invalidTypes.map(String).join(", ")}`,
      });
    }
  } else if (schema.type !== undefined && !isSupportedJsonSchemaType(schema.type)) {
    errors.push({
      path: `${path}.type`,
      message: `Unsupported JSON Schema type: ${getJsonType(schema.type)}`,
    });
  }

  if (
    schema.additionalProperties != null &&
    schema.additionalProperties !== true &&
    schema.additionalProperties !== false
  ) {
    errors.push({
      path: `${path}.additionalProperties`,
      message: "Unsupported JSON Schema additionalProperties schema",
    });
  }

  if (isPlainRecord(schema.properties)) {
    for (const [property, propertySchema] of Object.entries(schema.properties)) {
      collectUnsupportedKeywordErrors(propertySchema, `${path}.${property}`, errors);
    }
  }

  if (schema.items != null) {
    collectUnsupportedKeywordErrors(schema.items, `${path}[]`, errors);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function getJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
