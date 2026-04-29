import { z } from "zod";

export const LspPositionSchema = z.object({
  line: z.number(),
  character: z.number(),
});

export const LspRangeSchema = z.object({
  start: LspPositionSchema,
  end: LspPositionSchema,
});

export const LspDiagnosticSchema = z.object({
  range: LspRangeSchema,
  severity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).optional(),
  code: z.union([z.string(), z.number()]).optional(),
  source: z.string().optional(),
  message: z.string(),
});

export const LspFileDiagnosticsSchema = z.object({
  uri: z.string(),
  path: z.string(),
  serverId: z.string(),
  rootUri: z.string(),
  version: z.number().optional(),
  diagnostics: z.array(LspDiagnosticSchema),
  receivedAtMs: z.number(),
});

export const WorkspaceLspDiagnosticsSnapshotSchema = z.object({
  workspaceId: z.string(),
  diagnostics: z.array(LspFileDiagnosticsSchema),
});

export type LspPosition = z.infer<typeof LspPositionSchema>;
export type LspRange = z.infer<typeof LspRangeSchema>;
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>;
export type LspFileDiagnostics = z.infer<typeof LspFileDiagnosticsSchema>;
export type WorkspaceLspDiagnosticsSnapshot = z.infer<typeof WorkspaceLspDiagnosticsSnapshotSchema>;
