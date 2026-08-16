import { validateJsonSchemaSubset } from "@/common/utils/jsonSchemaSubset";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function containsReferenceKeyword(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsReferenceKeyword);
  }
  if (!isRecord(value)) {
    return false;
  }
  if (["$ref", "$dynamicRef", "$recursiveRef"].some((key) => Object.hasOwn(value, key))) {
    return true;
  }
  return Object.values(value).some(containsReferenceKeyword);
}

function getRequiredProperties(schema: Record<string, unknown>): Set<string> {
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === "string")
      : []
  );
  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      if (!isRecord(subSchema)) {
        continue;
      }
      for (const key of getRequiredProperties(subSchema)) {
        required.add(key);
      }
    }
  }
  return required;
}

type Nullability = "allows" | "rejects" | "unknown";

function combineAll(states: Nullability[]): Nullability {
  if (states.includes("rejects")) {
    return "rejects";
  }
  return states.includes("unknown") ? "unknown" : "allows";
}

function getNullability(schema: unknown): Nullability {
  if (schema === true) {
    return "allows";
  }
  if (schema === false) {
    return "rejects";
  }
  if (!isRecord(schema)) {
    return "unknown";
  }

  const constraints: Nullability[] = [];
  if (Object.hasOwn(schema, "$ref")) {
    constraints.push("unknown");
  }
  if (typeof schema.type === "string") {
    constraints.push(schema.type === "null" ? "allows" : "rejects");
  } else if (Array.isArray(schema.type)) {
    constraints.push(schema.type.includes("null") ? "allows" : "rejects");
  }
  if (Array.isArray(schema.enum)) {
    constraints.push(schema.enum.includes(null) ? "allows" : "rejects");
  }
  if (Object.hasOwn(schema, "const")) {
    constraints.push(schema.const === null ? "allows" : "rejects");
  }
  if (Array.isArray(schema.anyOf)) {
    const states = schema.anyOf.map(getNullability);
    constraints.push(
      states.includes("allows") ? "allows" : states.includes("unknown") ? "unknown" : "rejects"
    );
  }
  if (Array.isArray(schema.oneOf)) {
    const states = schema.oneOf.map(getNullability);
    const allowedCount = states.filter((state) => state === "allows").length;
    constraints.push(
      states.includes("unknown") ? "unknown" : allowedCount === 1 ? "allows" : "rejects"
    );
  }
  if (Array.isArray(schema.allOf)) {
    constraints.push(combineAll(schema.allOf.map(getNullability)));
  }
  if (Object.hasOwn(schema, "not")) {
    const state = getNullability(schema.not);
    constraints.push(state === "allows" ? "rejects" : state === "rejects" ? "allows" : "unknown");
  }
  if (Object.hasOwn(schema, "if")) {
    constraints.push("unknown");
  }

  return constraints.length === 0 ? "allows" : combineAll(constraints);
}

function makeNullableSchema(schema: unknown): Record<string, unknown> {
  const annotations = isRecord(schema)
    ? {
        ...(typeof schema.title === "string" ? { title: schema.title } : {}),
        ...(typeof schema.description === "string" ? { description: schema.description } : {}),
      }
    : {};
  return { ...annotations, anyOf: [schema, { type: "null" }] };
}

function widenSchemaNode(schema: unknown, inheritedRequired = new Set<string>()): void {
  if (!isRecord(schema)) {
    return;
  }

  const required = new Set([...inheritedRequired, ...getRequiredProperties(schema)]);
  if (isRecord(schema.properties)) {
    for (const [propertyName, propertySchema] of Object.entries(schema.properties)) {
      const modelSchema =
        !required.has(propertyName) && getNullability(propertySchema) === "rejects"
          ? makeNullableSchema(propertySchema)
          : propertySchema;
      schema.properties[propertyName] = modelSchema;
      widenSchemaNode(modelSchema);
    }
  }

  const items = schema.items;
  if (Array.isArray(items)) {
    for (const itemSchema of items) {
      widenSchemaNode(itemSchema);
    }
  } else {
    widenSchemaNode(items);
  }

  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        widenSchemaNode(branch, required);
      }
    }
  }
}

export interface OptionalNullSchemaContract {
  modelSchema: unknown;
  strict: false | undefined;
  restore: (value: unknown) => unknown;
}

export function createOptionalNullSchemaContract(schema: unknown): OptionalNullSchemaContract {
  if (containsReferenceKeyword(schema)) {
    return {
      modelSchema: structuredClone(schema),
      strict: false,
      restore: (value) => value,
    };
  }
  return {
    modelSchema: widenOptionalPropertiesToNullable(schema),
    strict: undefined,
    restore: (value) => stripSyntheticNulls(schema, value),
  };
}

/**
 * Apply Mux's nullish optional-property convention to a third-party JSON Schema.
 * The model contract only widens the source contract, so every provider can use it.
 */
export function widenOptionalPropertiesToNullable(schema: unknown): unknown {
  const modelSchema = structuredClone(schema);
  widenSchemaNode(modelSchema);
  return modelSchema;
}

function stripProperties(
  value: Record<string, unknown>,
  properties: Record<string, unknown>,
  required: Set<string>
): Record<string, unknown> {
  const stripped = { ...value };
  for (const [propertyName, propertySchema] of Object.entries(properties)) {
    if (!(propertyName in stripped)) {
      continue;
    }
    if (
      stripped[propertyName] === null &&
      !required.has(propertyName) &&
      getNullability(propertySchema) === "rejects"
    ) {
      delete stripped[propertyName];
      continue;
    }
    stripped[propertyName] = stripSyntheticNulls(propertySchema, stripped[propertyName]);
  }
  return stripped;
}

function schemaAcceptsValue(schema: unknown, value: unknown): boolean {
  if (schema === true) {
    return true;
  }
  if (schema === false) {
    return false;
  }
  return validateJsonSchemaSubset(schema, value).success;
}

function stripMatchingUnionBranch(
  schema: Record<string, unknown>,
  value: unknown,
  inheritedRequired: ReadonlySet<string>
): unknown {
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) {
      continue;
    }
    for (const branch of branches) {
      if (schemaAcceptsValue(branch, value)) {
        return value;
      }
    }
    for (const branch of branches) {
      const stripped = stripSyntheticNullsNode(branch, value, inheritedRequired);
      if (schemaAcceptsValue(branch, stripped)) {
        return stripped;
      }
    }
  }
  return null;
}

function stripSyntheticNullsNode(
  schema: unknown,
  value: unknown,
  inheritedRequired: ReadonlySet<string>
): unknown {
  if (!isRecord(schema) || schemaAcceptsValue(schema, value)) {
    return value;
  }

  const required = new Set([...inheritedRequired, ...getRequiredProperties(schema)]);
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    const stripped = Array.isArray(itemSchema)
      ? value.map((item, index) => stripSyntheticNullsNode(itemSchema[index], item, new Set()))
      : value.map((item) => stripSyntheticNullsNode(itemSchema, item, new Set()));
    return stripMatchingUnionBranch(schema, stripped, required) ?? stripped;
  }
  if (!isRecord(value)) {
    return value;
  }

  let stripped = { ...value };
  if (isRecord(schema.properties)) {
    stripped = stripProperties(stripped, schema.properties, required);
  }
  if (Array.isArray(schema.allOf)) {
    for (const subSchema of schema.allOf) {
      stripped = stripSyntheticNullsNode(subSchema, stripped, required) as Record<string, unknown>;
    }
  }
  return stripMatchingUnionBranch(schema, stripped, required) ?? stripped;
}

/**
 * Restore a third-party executor contract after a model uses `null` to represent
 * an omitted optional property. Explicit source-nullable values remain unchanged.
 */
export function stripSyntheticNulls(schema: unknown, value: unknown): unknown {
  return stripSyntheticNullsNode(schema, value, new Set());
}
