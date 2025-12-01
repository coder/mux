/**
 * Creates an oRPC router proxy that delegates procedure calls to a running server via HTTP.
 *
 * This allows using trpc-cli with an oRPC router without needing to initialize
 * services locally - calls are forwarded to a running mux server.
 *
 * The returned router maintains the same structure and schemas as the original,
 * so trpc-cli can extract procedure metadata for CLI generation.
 */

import { RPCLink as HTTPRPCLink } from "@orpc/client/fetch";
import { createORPCClient } from "@orpc/client";
import { isProcedure } from "@orpc/server";
import type { AppRouter } from "@/node/orpc/router";
import type { RouterClient } from "@orpc/server";

export interface ProxifyOrpcOptions {
  /** Base URL of the oRPC server, e.g., "http://localhost:8080" */
  baseUrl: string;
  /** Optional auth token for Bearer authentication */
  authToken?: string;
}

interface OrpcDef {
  inputSchema?: unknown;
  outputSchema?: unknown;
  middlewares?: unknown[];
  inputValidationIndex?: number;
  outputValidationIndex?: number;
  errorMap?: unknown;
  meta?: unknown;
  route?: unknown;
  config?: unknown;
  handler?: (opts: { input: unknown; context?: unknown }) => Promise<unknown>;
}

// Duck-typing interfaces for Zod 4 schema introspection (no Zod import needed)
// Zod 4 uses schema.def.type instead of schema._def.typeName
interface Zod4Def {
  type?: string;
  shape?: Record<string, Zod4Like>;
  innerType?: Zod4Like;
  element?: Zod4Like;
  options?: Zod4Like[];
  values?: readonly string[];
  value?: unknown;
}

interface Zod4Like {
  def?: Zod4Def;
  _def?: Zod4Def;
  description?: string;
  describe?: (desc: string) => Zod4Like;
}

/**
 * Check if a value looks like a Zod 4 schema (duck-typing).
 */
function isZod4Like(value: unknown): value is Zod4Like {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Zod4Like;
  return (
    (v.def !== undefined && typeof v.def === "object") ||
    (v._def !== undefined && typeof v._def === "object")
  );
}

/**
 * Get the def from a Zod 4 schema (handles both .def and ._def).
 */
function getDef(schema: Zod4Like): Zod4Def | undefined {
  return schema.def ?? schema._def;
}

/**
 * Describe a Zod 4 type as a concise string for CLI help.
 */
function describeZodType(schema: unknown): string {
  if (!isZod4Like(schema)) return "unknown";

  const def = getDef(schema);
  if (!def) return "unknown";

  const type = def.type;

  switch (type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "literal":
      return JSON.stringify(def.value);
    case "enum":
      if (def.values) {
        return def.values.map((v) => JSON.stringify(v)).join(" | ");
      }
      return "enum";
    case "array":
      if (def.element) {
        return `${describeZodType(def.element)}[]`;
      }
      return "array";
    case "optional":
    case "nullable":
      if (def.innerType) {
        return describeZodType(def.innerType);
      }
      return "unknown";
    case "default":
      if (def.innerType) {
        return describeZodType(def.innerType);
      }
      return "unknown";
    case "union":
      if (def.options && Array.isArray(def.options)) {
        return def.options.map(describeZodType).join(" | ");
      }
      return "union";
    case "object":
      return describeZodObject(schema as Zod4Like);
    case "any":
      return "any";
    case "unknown":
      return "unknown";
    case "record":
      return "Record<string, unknown>";
    default:
      return type ?? "unknown";
  }
}

/**
 * Describe a ZodObject's shape as a concise field list.
 */
function describeZodObject(schema: Zod4Like): string {
  const def = getDef(schema);
  if (!def || typeof def.shape !== "object") return "object";

  const shape = def.shape;
  const fields: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!isZod4Like(fieldSchema)) continue;

    const fieldDef = getDef(fieldSchema);
    const isOptional = fieldDef?.type === "optional" || fieldDef?.type === "default";
    const fieldType = describeZodType(fieldSchema);
    const optMarker = isOptional ? "?" : "";

    fields.push(`${key}${optMarker}: ${fieldType}`);
  }

  return `{ ${fields.join(", ")} }`;
}

/**
 * Enhance a Zod 4 schema by injecting rich descriptions for object fields.
 * This makes CLI help show field details instead of just "Object (json formatted)".
 *
 * For object-typed fields without descriptions, we inject a description
 * showing all available fields with their types.
 */
function enhanceInputSchema(schema: unknown): unknown {
  if (!isZod4Like(schema)) return schema;

  const def = getDef(schema);
  if (!def || def.type !== "object" || typeof def.shape !== "object") {
    return schema;
  }

  const shape = def.shape;
  let hasEnhancements = false;
  const enhancedShape: Record<string, unknown> = {};

  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!isZod4Like(fieldSchema)) {
      enhancedShape[key] = fieldSchema;
      continue;
    }

    // Unwrap optional/default to get the inner type
    let innerSchema = fieldSchema;
    let innerDef = getDef(fieldSchema);

    while (
      innerDef &&
      (innerDef.type === "optional" || innerDef.type === "default") &&
      innerDef.innerType
    ) {
      innerSchema = innerDef.innerType;
      innerDef = getDef(innerSchema);
    }

    // If the inner type is an object without a description, inject one
    if (
      isZod4Like(innerSchema) &&
      getDef(innerSchema)?.type === "object" &&
      !fieldSchema.description &&
      typeof fieldSchema.describe === "function"
    ) {
      const desc = describeZodObject(innerSchema);
      enhancedShape[key] = fieldSchema.describe(desc);
      hasEnhancements = true;
    } else {
      enhancedShape[key] = fieldSchema;
    }
  }

  if (!hasEnhancements) return schema;

  // Clone the schema with the enhanced shape
  return {
    ...schema,
    def: { ...def, shape: enhancedShape },
    _def: { ...def, shape: enhancedShape },
  };
}

interface OrpcProcedureLike {
  "~orpc": OrpcDef;
}

interface OrpcRouterLike {
  [key: string]: OrpcProcedureLike | OrpcRouterLike;
}

/**
 * Creates a proxied oRPC router that delegates to an HTTP client.
 *
 * The HTTP client is created lazily on each procedure invocation to avoid
 * connection overhead during CLI initialization (help, autocomplete, etc.).
 *
 * @param router - The original oRPC router (used to extract procedure schemas)
 * @param options - Configuration for connecting to the server
 * @returns A router-like object compatible with trpc-cli that proxies calls to the server
 *
 * @example
 * ```ts
 * import { router } from "@/node/orpc/router";
 * import { proxifyOrpc } from "./proxifyOrpc";
 *
 * const proxiedRouter = proxifyOrpc(router(), {
 *   baseUrl: "http://localhost:8080",
 *   authToken: "secret",
 * });
 *
 * const cli = createCli({ router: proxiedRouter });
 * ```
 */
type ClientFactory = () => RouterClient<AppRouter>;

export function proxifyOrpc(router: AppRouter, options: ProxifyOrpcOptions): AppRouter {
  // Client factory - creates a new client on each procedure invocation
  const createClient: ClientFactory = () => {
    const link = new HTTPRPCLink({
      url: `${options.baseUrl}/orpc`,
      headers: options.authToken ? { Authorization: `Bearer ${options.authToken}` } : undefined,
    });
    return createORPCClient(link);
  };

  return createRouterProxy(
    router as unknown as OrpcRouterLike,
    createClient,
    []
  ) as unknown as AppRouter;
}

function createRouterProxy(
  router: OrpcRouterLike,
  createClient: ClientFactory,
  path: string[]
): OrpcRouterLike {
  const result: OrpcRouterLike = {};

  for (const [key, value] of Object.entries(router)) {
    const newPath = [...path, key];

    if (isProcedure(value)) {
      result[key] = createProcedureProxy(
        value as unknown as OrpcProcedureLike,
        createClient,
        newPath
      );
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = createRouterProxy(value as OrpcRouterLike, createClient, newPath);
    }
  }

  return result;
}

function createProcedureProxy(
  procedure: OrpcProcedureLike,
  createClient: ClientFactory,
  path: string[]
): OrpcProcedureLike {
  const originalDef = procedure["~orpc"];

  // Enhance input schema to show rich field descriptions in CLI help
  const enhancedInputSchema = enhanceInputSchema(originalDef.inputSchema);

  // Navigate to the client method using the path (lazily creates client on call)
  const getClientMethod = (): ((input: unknown) => Promise<unknown>) => {
    const client = createClient();
    let method: unknown = client;
    for (const segment of path) {
      method = (method as Record<string, unknown>)[segment];
    }
    return method as (input: unknown) => Promise<unknown>;
  };

  // Create a procedure-like object that:
  // 1. Has the same ~orpc metadata (for schema extraction by trpc-cli)
  // 2. When called via @orpc/server's `call()`, delegates to the HTTP client
  //
  // The trick is that @orpc/server's `call()` function looks for a handler
  // in the procedure definition. We provide one that proxies to the client.
  const proxy: OrpcProcedureLike = {
    "~orpc": {
      ...originalDef,
      // Use enhanced schema for CLI help generation
      inputSchema: enhancedInputSchema,
      // Keep the original middlewares empty for the proxy - we don't need them
      // since the server will run its own middleware chain
      middlewares: [],
      // The handler that will be called by @orpc/server's `call()` function
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      handler: async (opts: { input: unknown }): Promise<any> => {
        const clientMethod = getClientMethod();
        return clientMethod(opts.input);
      },
    },
  };

  return proxy;
}
