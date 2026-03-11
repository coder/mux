import assert from "@/common/utils/assert";

export const DOOM_LOOP_EDIT_THRESHOLD = 7;

/**
 * Tracks file edit frequency for a single stream to detect potential doom loops.
 */
export class StreamEditTracker {
  private readonly editCountsByFile = new Map<string, number>();
  private readonly nudgedFiles = new Set<string>();

  recordEdit(filePath: string): number {
    assert(
      typeof filePath === "string" && filePath.length > 0,
      "filePath must be a non-empty string"
    );

    const nextCount = (this.editCountsByFile.get(filePath) ?? 0) + 1;
    this.editCountsByFile.set(filePath, nextCount);
    return nextCount;
  }

  hasAnyEdits(): boolean {
    return this.editCountsByFile.size > 0;
  }

  shouldNudge(filePath: string, threshold: number): boolean {
    assert(
      typeof filePath === "string" && filePath.length > 0,
      "filePath must be a non-empty string"
    );
    assert(Number.isFinite(threshold) && threshold > 0, "threshold must be a positive number");

    const editCount = this.editCountsByFile.get(filePath) ?? 0;
    return editCount >= threshold && !this.nudgedFiles.has(filePath);
  }

  markNudged(filePath: string): void {
    assert(
      typeof filePath === "string" && filePath.length > 0,
      "filePath must be a non-empty string"
    );
    this.nudgedFiles.add(filePath);
  }
}
