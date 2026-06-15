export interface CompactionCompletionMetadata {
  workspaceId: string;
  summaryMessageId: string;
  summaryHistorySequence: number;
  compactionEpoch: number;
  previousBoundaryHistorySequence?: number;
  compactionRequestMessageId: string;
}
