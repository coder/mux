/**
 * Hand-written types for deep-research.js.
 *
 * The workflow runs inside the QuickJS sandbox as a plain script, so the
 * implementation must stay untyped JavaScript. These declarations cover the
 * exported pure helpers so unit tests get typed, lint-clean imports.
 */

export interface ResearchConfig {
  mode: "quick" | "smart";
  maxAngles: number;
  maxSources: number;
  maxClaimsPerSource: number;
  maxVerifyClaims: number;
  votesPerClaim: number;
  refutationsRequired: number;
  verificationBatchSize: number;
}

export declare const RESEARCH_CONFIGS: Record<"quick" | "smart", ResearchConfig>;

/** Ordered vocabularies; index doubles as rank (lower wins). */
export declare const SOURCE_QUALITY_LEVELS: readonly string[];
export declare const CLAIM_IMPORTANCE_LEVELS: readonly string[];

export declare function normalizeDeepResearchInput(args: unknown): {
  topic: string;
  mode: "quick" | "smart";
};

export declare function normalizeSourceKey(value: unknown): string;

export interface SourceCandidate {
  title: string;
  url: string;
  relevance?: string;
  sourceType?: string;
  angle?: string;
  angleIndex?: number;
}

export declare function interleaveSourcesByAngle(
  sources: SourceCandidate[],
  angleCount: number
): SourceCandidate[];

export declare function selectNovelSources(
  sources: SourceCandidate[],
  angleCount: number,
  maxSources: number
): {
  sources: SourceCandidate[];
  duplicates: SourceCandidate[];
  budgetDropped: SourceCandidate[];
};

export interface ClaimEvidence {
  quote: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceQuality: string;
  publishDate: string;
}

export interface SourceExtract {
  title: string;
  url: string;
  angle?: string;
  relevance?: string;
  sourceType?: string;
  sourceQuality: string;
  publishDate: string;
  summary?: string;
  claims: Array<{ claim: string; quote: string; importance: string }>;
}

export interface ResearchClaim {
  claim: string;
  quote: string;
  importance: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceQuality: string;
  publishDate: string;
  evidence: ClaimEvidence[];
  duplicateCount: number;
}

export declare function extractsToClaims(sourceExtracts: SourceExtract[]): ResearchClaim[];

export declare function rankClaims<T extends Pick<ResearchClaim, "importance" | "sourceQuality">>(
  claims: T[]
): T[];

export interface ClaimVote {
  refuted: boolean;
  confidence: string;
  evidence: string;
  counterSource: string;
}

export interface VotedClaim extends ResearchClaim {
  votes: ClaimVote[];
  vote: string;
  refutedVotes: number;
  survives: boolean;
}

export declare function aggregateVotes(
  claims: ResearchClaim[],
  voteResults: Array<{ structuredOutput: Record<string, unknown> }>,
  config: Pick<ResearchConfig, "votesPerClaim" | "refutationsRequired">
): VotedClaim[];

declare function deepResearch(context: unknown): unknown;
export default deepResearch;
