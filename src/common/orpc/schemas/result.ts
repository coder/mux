import { z } from "zod";

/**
 * Generic Result schema for success/failure discriminated unions
 */
export const ResultSchema = <T extends z.ZodTypeAny, E extends z.ZodTypeAny = z.ZodString>(
  dataSchema: T,
  errorSchema: E = z.string() as unknown as E
) =>
  z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), data: dataSchema }),
    z.object({ success: z.literal(false), error: errorSchema }),
  ]);
