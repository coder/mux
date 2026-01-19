import type { z } from "zod";
import type {
  HarnessChecklistItemSchema,
  HarnessChecklistStatusSchema,
  HarnessContextResetStrategySchema,
  HarnessGateRunResultSchema,
  HarnessGateSchema,
  HarnessLoopSettingsSchema,
  HarnessLoopStateSchema,
  HarnessLoopStatusSchema,
  GitCheckpointResultSchema,
  WorkspaceHarnessConfigSchema,
  WorkspaceHarnessFilePathsSchema,
} from "@/common/orpc/schemas";

export type HarnessChecklistStatus = z.infer<typeof HarnessChecklistStatusSchema>;
export type HarnessChecklistItem = z.infer<typeof HarnessChecklistItemSchema>;
export type HarnessGate = z.infer<typeof HarnessGateSchema>;
export type HarnessContextResetStrategy = z.infer<typeof HarnessContextResetStrategySchema>;
export type HarnessLoopSettings = z.infer<typeof HarnessLoopSettingsSchema>;
export type WorkspaceHarnessConfig = z.infer<typeof WorkspaceHarnessConfigSchema>;
export type WorkspaceHarnessFilePaths = z.infer<typeof WorkspaceHarnessFilePathsSchema>;
export type HarnessGateRunResult = z.infer<typeof HarnessGateRunResultSchema>;
export type GitCheckpointResult = z.infer<typeof GitCheckpointResultSchema>;
export type HarnessLoopStatus = z.infer<typeof HarnessLoopStatusSchema>;
export type HarnessLoopState = z.infer<typeof HarnessLoopStateSchema>;
