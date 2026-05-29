import { z } from "zod";

// Max depth of 5 prevents unbounded nesting in config mutations.
export const ConfigMutationPathSchema = z.array(z.string().min(1)).min(1).max(5);

export const ConfigOperationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("set"),
      path: ConfigMutationPathSchema,
      value: z.unknown(),
    })
    .strict(),
  z
    .object({
      op: z.literal("delete"),
      path: ConfigMutationPathSchema,
    })
    .strict(),
]);

export const ConfigOperationsSchema = z.array(ConfigOperationSchema);

export type ConfigOperation = z.infer<typeof ConfigOperationSchema>;
