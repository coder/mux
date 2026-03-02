import { z } from "zod";

import { RuntimeEnablementIdSchema } from "./ids";

// Canonical schema for runtime enablement overrides. Sparse by design:
// only disabled runtimes are stored as `false` to keep config.json minimal.
export const RuntimeEnablementOverridesSchema = z.partialRecord(
  RuntimeEnablementIdSchema,
  z.literal(false)
);

export type RuntimeEnablementOverrides = z.infer<typeof RuntimeEnablementOverridesSchema>;
