import {
  flattenInstructionFiles,
  type InstructionFile,
  type InstructionSet,
  type InstructionSources,
  type WorkspaceInstructions,
} from "@/common/types/instructions";
import { createRuntimeContextForWorkspace } from "@/node/runtime/runtimeHelpers";
import type { AIService } from "@/node/services/aiService";
import type { TokenizerService } from "@/node/services/tokenizerService";
import { loadInstructionSources } from "@/node/services/systemMessage";
import { log } from "@/node/services/log";

/**
 * InstructionsService — exposes the instruction context (AGENTS.md, CLAUDE.md,
 * AGENTS.local.md, …) loaded for a workspace as a structured payload.
 *
 * Sharing types with `buildSystemMessage` (via `@/common/types/instructions`)
 * guarantees the right-sidebar Instructions tab and the actual prompt builder
 * stay in lockstep — the same `InstructionFile`s the panel renders are the
 * ones the agent sees.
 */
export class InstructionsService {
  constructor(
    private readonly aiService: AIService,
    private readonly tokenizerService: TokenizerService
  ) {}

  /**
   * Load the full instruction context for a workspace, optionally annotated
   * with per-file token counts for the active (or supplied) model.
   *
   * Token counting failures are non-fatal — the panel still renders, it just
   * omits the count rather than blocking on tokenizer issues.
   */
  async getWorkspaceInstructions(
    workspaceId: string,
    modelOverride?: string | null
  ): Promise<WorkspaceInstructions> {
    const metadataResult = await this.aiService.getWorkspaceMetadata(workspaceId);
    if (!metadataResult.success) {
      throw new Error(metadataResult.error);
    }
    const metadata = metadataResult.data;

    const { runtime, workspacePath } = createRuntimeContextForWorkspace(metadata);
    const sources = await loadInstructionSources(metadata, runtime, workspacePath);

    const trimmedOverride = modelOverride?.trim();
    const model =
      (trimmedOverride && trimmedOverride.length > 0 ? trimmedOverride : null) ??
      metadata.aiSettings?.model ??
      null;
    const flatRaw = flattenInstructionFiles(sources);

    let tokensByPath: Map<string, number> | null = null;
    let totalTokens: number | null = null;
    if (model && flatRaw.length > 0) {
      try {
        const counts = await Promise.all(
          flatRaw.map((f) => this.tokenizerService.countTokens(model, f.content))
        );
        tokensByPath = new Map(flatRaw.map((f, i) => [f.path, counts[i]]));
        totalTokens = counts.reduce((acc, n) => acc + n, 0);
      } catch (err) {
        // Tokenizer hiccups (unknown model, worker crash, …) shouldn't break the panel.
        log.debug(`InstructionsService: failed to count tokens for workspace ${workspaceId}`, err);
        tokensByPath = null;
        totalTokens = null;
      }
    }

    const annotateFile = (file: InstructionFile): InstructionFile => ({
      ...file,
      tokens: tokensByPath?.get(file.path) ?? null,
    });
    const annotateSet = (set: InstructionSet): InstructionSet => ({
      ...set,
      files: set.files.map(annotateFile),
    });

    const annotatedSources: InstructionSources = {
      global: sources.global ? annotateSet(sources.global) : null,
      context: sources.context.map(annotateSet),
    };
    const annotatedFiles = flattenInstructionFiles(annotatedSources);

    return {
      workspaceId,
      model,
      sources: annotatedSources,
      files: annotatedFiles,
      totalTokens,
    };
  }
}
