import { z } from "zod";

export const BashToolResultSchema = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    wall_duration_ms: z.number(),
    output: z.string(),
    exitCode: z.literal(0),
    note: z.string().optional(),
    truncated: z
      .object({
        reason: z.string(),
        totalLines: z.number(),
      })
      .optional(),
  }),
  z.object({
    success: z.literal(false),
    wall_duration_ms: z.number(),
    output: z.string().optional(),
    exitCode: z.number(),
    error: z.string(),
    note: z.string().optional(),
    truncated: z
      .object({
        reason: z.string(),
        totalLines: z.number(),
      })
      .optional(),
  }),
]);

export const FileTreeNodeSchema = z.object({
  name: z.string(),
  path: z.string(),
  isDirectory: z.boolean(),
  get children() {
    return z.array(FileTreeNodeSchema);
  },
  stats: z
    .object({
      filePath: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .optional(),
  totalStats: z
    .object({
      filePath: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .optional(),
});
