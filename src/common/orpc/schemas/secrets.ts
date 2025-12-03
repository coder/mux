import { z } from "zod";

export const SecretSchema = z
  .object({
    key: z.string(),
    value: z.string(),
  })
  .meta({
    description: "A key-value pair for storing sensitive configuration",
  });
