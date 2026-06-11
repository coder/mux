/**
 * Structured types for instruction context (AGENTS.md, CLAUDE.md,
 * AGENTS.local.md, …).
 *
 * These types are inferred from the Zod schemas in
 * `@/common/orpc/schemas/instructions` so the IPC payload and the internal
 * data structure used by `buildSystemMessage` cannot drift — adding a field
 * to the schema flows through every consumer (prompt builder, IPC handler,
 * right-sidebar Instructions tab) at compile time.
 */

import type { z } from "zod";
import { INSTRUCTION_SCOPE } from "@/common/orpc/schemas/instructions";
import type {
  AdditionalSystemContextSchema,
  InstructionFileSchema,
  InstructionScopeSchema,
  InstructionSetSchema,
  InstructionSourcesSchema,
  WorkspaceInstructionsSchema,
} from "@/common/orpc/schemas/instructions";

export { INSTRUCTION_SCOPE };

export type AdditionalSystemContext = z.infer<typeof AdditionalSystemContextSchema>;
export type InstructionScope = z.infer<typeof InstructionScopeSchema>;
export type InstructionFile = z.infer<typeof InstructionFileSchema>;
export type InstructionSet = z.infer<typeof InstructionSetSchema>;
export type InstructionSources = z.infer<typeof InstructionSourcesSchema>;
export type WorkspaceInstructions = z.infer<typeof WorkspaceInstructionsSchema>;

/**
 * Flatten the structured `InstructionSources` into a single ordered list of
 * files (global first, then context entries in prompt order). Used for the
 * IPC payload and as a convenience for token aggregation.
 */
export function flattenInstructionFiles(sources: InstructionSources): InstructionFile[] {
  const out: InstructionFile[] = [];
  if (sources.global) out.push(...sources.global.files);
  for (const set of sources.context) out.push(...set.files);
  return out;
}

/**
 * Concatenate a sequence of instruction sets the way they would be joined
 * inside `<custom-instructions>`. Returns "" when no sets contribute content.
 */
export function joinInstructionSets(sets: ReadonlyArray<InstructionSet | null>): string {
  return sets
    .map((set) => set?.combinedContent ?? "")
    .filter((s) => s.length > 0)
    .join("\n\n");
}

/**
 * Collect the contents of Mux-dedicated (`muxOnly`) files from a sequence of
 * instruction sets, in prompt order. These are the source texts for scoped
 * `Model:`/`Mode:` directives — shared AGENTS.md content is deliberately
 * excluded so those directives never activate from files that non-Mux agents
 * also read.
 *
 * Returned per-file (not concatenated) so a scoped section at the end of one
 * file cannot swallow the next file's unscoped content — markdown section
 * bounds only stop at another same-or-higher heading, which a following file
 * may not start with.
 */
export function collectMuxOnlyInstructionContents(
  sets: ReadonlyArray<InstructionSet | null>
): string[] {
  return sets
    .flatMap((set) => set?.files ?? [])
    .filter((file) => file.muxOnly)
    .map((file) => file.content)
    .filter((content) => content.length > 0);
}
