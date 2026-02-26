import type { ConfigOperation } from "@/common/config/schemas/configOperations";
import { deepClone, parseArrayIndex } from "@/node/services/tools/shared/configToolUtils";
import type * as z from "zod";

export {
  ConfigOperationSchema,
  ConfigOperationsSchema,
  type ConfigOperation,
} from "@/common/config/schemas/configOperations";

const DENIED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export interface MutationSuccess<TDocument = unknown> {
  success: true;
  document: TDocument;
  appliedOps: number;
}

export interface MutationError {
  success: false;
  error: string;
  validationIssues?: z.ZodIssue[];
}

export type MutationResult<TDocument = unknown> = MutationSuccess<TDocument> | MutationError;

type MutableContainer = Record<string, unknown> | unknown[];

// Apply path operations first, then validate the entire document against the canonical
// schema so partial edits cannot persist an invalid config shape.
export function applyMutations<TSchema extends z.ZodTypeAny>(
  currentDocument: unknown,
  operations: readonly ConfigOperation[],
  schema: TSchema
): MutationResult<z.infer<TSchema>> {
  const baseDocument = currentDocument ?? {};
  const clonedDocument = deepClone(baseDocument);

  if (!isMutableContainer(clonedDocument)) {
    return {
      success: false,
      error: "Config mutation requires an object or array document root",
    };
  }

  for (const [index, operation] of operations.entries()) {
    const deniedSegment = operation.path.find((segment) => DENIED_PATH_SEGMENTS.has(segment));
    if (deniedSegment) {
      return {
        success: false,
        error: `Denied path segment "${deniedSegment}" in operation ${index}`,
      };
    }

    const opError =
      operation.op === "set"
        ? applySetOperation(clonedDocument, operation.path, operation.value)
        : applyDeleteOperation(clonedDocument, operation.path);

    if (opError) {
      return {
        success: false,
        error: `Mutation failed for operation ${index}: ${opError}`,
      };
    }
  }

  const parseResult = schema.safeParse(clonedDocument);
  if (!parseResult.success) {
    return {
      success: false,
      error: "Schema validation failed after applying operations",
      validationIssues: parseResult.error.issues,
    };
  }

  return {
    success: true,
    document: parseResult.data,
    appliedOps: operations.length,
  };
}

function applySetOperation(
  root: MutableContainer,
  path: readonly string[],
  value: unknown
): string | null {
  let current: MutableContainer = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    const nextSegment = path[index + 1];

    if (Array.isArray(current)) {
      const arrayIndex = parseArrayIndex(segment);
      if (arrayIndex === null) {
        return `Expected numeric array index at ${formatPath(path, index)}`;
      }

      const existing = current[arrayIndex];
      if (existing === null || existing === undefined) {
        const nextContainer = createContainerForSegment(nextSegment);
        current[arrayIndex] = nextContainer;
        current = nextContainer;
        continue;
      }

      if (!isMutableContainer(existing)) {
        return `Cannot traverse non-object value at ${formatPath(path, index)}`;
      }

      current = existing;
      continue;
    }

    const existing = current[segment];
    if (existing === null || existing === undefined) {
      const nextContainer = createContainerForSegment(nextSegment);
      current[segment] = nextContainer;
      current = nextContainer;
      continue;
    }

    if (!isMutableContainer(existing)) {
      return `Cannot traverse non-object value at ${formatPath(path, index)}`;
    }

    current = existing;
  }

  const leafSegment = path[path.length - 1];
  if (Array.isArray(current)) {
    const leafIndex = parseArrayIndex(leafSegment);
    if (leafIndex === null) {
      return `Expected numeric array index at ${formatPath(path)}`;
    }

    current[leafIndex] = value;
    return null;
  }

  current[leafSegment] = value;
  return null;
}

function applyDeleteOperation(root: MutableContainer, path: readonly string[]): string | null {
  let current: MutableContainer = root;

  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];

    if (Array.isArray(current)) {
      const arrayIndex = parseArrayIndex(segment);
      if (arrayIndex === null) {
        return `Expected numeric array index at ${formatPath(path, index)}`;
      }

      if (arrayIndex >= current.length) {
        return null;
      }

      const next = current[arrayIndex];
      if (!isMutableContainer(next)) {
        return null;
      }

      current = next;
      continue;
    }

    if (!(segment in current)) {
      return null;
    }

    const next = current[segment];
    if (!isMutableContainer(next)) {
      return null;
    }

    current = next;
  }

  const leafSegment = path[path.length - 1];
  if (Array.isArray(current)) {
    const leafIndex = parseArrayIndex(leafSegment);
    if (leafIndex === null) {
      return `Expected numeric array index at ${formatPath(path)}`;
    }

    if (leafIndex < current.length) {
      current.splice(leafIndex, 1);
    }

    return null;
  }

  delete current[leafSegment];
  return null;
}

function createContainerForSegment(segment: string): MutableContainer {
  return parseArrayIndex(segment) === null ? {} : [];
}

function formatPath(path: readonly string[], untilInclusive?: number): string {
  const displayPath =
    untilInclusive === undefined ? path : path.slice(0, Math.max(untilInclusive + 1, 1));
  return displayPath.map((segment) => `[${segment}]`).join("");
}

function isMutableContainer(value: unknown): value is MutableContainer {
  return typeof value === "object" && value !== null;
}
