import { z } from "zod";

/**
 * A secret value can be a literal string, an alias to another secret key,
 * or a 1Password reference to resolve at runtime.
 */
export const SecretValueSchema = z.union([
  z.string(),
  z
    .object({
      secret: z.string(),
    })
    .strict(),
  z
    .object({
      op: z.string(),
      opLabel: z.string().optional(),
    })
    .strict(),
]);

export const SecretSchema = z
  .object({
    key: z.string(),
    value: SecretValueSchema,
    injectAll: z.boolean().optional(),
  })
  .meta({
    description: "A key-value pair for storing sensitive configuration",
  });
