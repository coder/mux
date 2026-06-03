import { describe, expect, test } from "bun:test";
import {
  aggregateVotes,
  extractsToClaims,
  interleaveSourcesByAngle,
  normalizeDeepResearchInput,
  normalizeSourceKey,
  rankClaims,
  RESEARCH_CONFIGS,
  selectNovelSources,
  type ResearchClaim,
  type SourceCandidate,
  type SourceExtract,
} from "./deep-research.js";

// End-to-end behavior (phases, agent specs, structured output) is covered by
// builtInWorkflowDefinitions.test.ts through the real QuickJS runner. These
// tests pin the contracts of the exported pure helpers directly.

function candidate(overrides: Partial<SourceCandidate>): SourceCandidate {
  return { title: "Untitled source", url: "", angleIndex: 0, ...overrides };
}

function extract(overrides: Partial<SourceExtract>): SourceExtract {
  return {
    title: "Source",
    url: "https://example.com",
    sourceQuality: "secondary",
    publishDate: "",
    claims: [],
    ...overrides,
  };
}

function claim(overrides: Partial<ResearchClaim>): ResearchClaim {
  return {
    claim: "Claim text",
    quote: "Quote",
    importance: "supporting",
    sourceUrl: "https://example.com",
    sourceTitle: "Source",
    sourceQuality: "secondary",
    publishDate: "",
    evidence: [],
    duplicateCount: 1,
    ...overrides,
  };
}

describe("normalizeDeepResearchInput", () => {
  test("accepts plain strings and trims them", () => {
    expect(normalizeDeepResearchInput("  topic  ")).toEqual({ topic: "topic", mode: "smart" });
    expect(normalizeDeepResearchInput("   ")).toEqual({ topic: "", mode: "smart" });
  });

  test("prefers topic over input over query", () => {
    expect(normalizeDeepResearchInput({ topic: "a", input: "b", query: "c" }).topic).toBe("a");
    expect(normalizeDeepResearchInput({ input: "b", query: "c" }).topic).toBe("b");
    expect(normalizeDeepResearchInput({ query: "c" }).topic).toBe("c");
  });

  test("an explicit mode string overrides the quick flag", () => {
    expect(normalizeDeepResearchInput({ topic: "t", quick: true }).mode).toBe("quick");
    expect(normalizeDeepResearchInput({ topic: "t", quick: true, mode: "smart" }).mode).toBe(
      "smart"
    );
    expect(normalizeDeepResearchInput({ topic: "t", mode: " FAST " }).mode).toBe("quick");
    expect(normalizeDeepResearchInput({ topic: "t", mode: "unknown" }).mode).toBe("smart");
  });
});

describe("normalizeSourceKey", () => {
  test("canonicalizes scheme, host, fragments, and trailing slashes", () => {
    expect(normalizeSourceKey("HTTPS://WWW.Example.com/Docs/#intro")).toBe(
      "https://example.com/Docs"
    );
  });

  test("drops tracking parameters and sorts the remaining query", () => {
    expect(normalizeSourceKey("https://example.com/p?b=2&utm_source=x&a=1&fbclid=abc")).toBe(
      "https://example.com/p?a=1&b=2"
    );
  });

  test("preserves path case and meaningful query parameters", () => {
    expect(normalizeSourceKey("https://example.com/API")).not.toBe(
      normalizeSourceKey("https://example.com/api")
    );
    expect(normalizeSourceKey("https://example.com/list?page=2")).not.toBe(
      normalizeSourceKey("https://example.com/list?page=3")
    );
  });

  test("normalizes plain repository paths", () => {
    expect(normalizeSourceKey("src/node/main.ts///")).toBe("src/node/main.ts");
    expect(normalizeSourceKey("   ")).toBe("");
    expect(normalizeSourceKey(undefined)).toBe("");
  });
});

describe("interleaveSourcesByAngle", () => {
  test("round-robins across angle buckets", () => {
    const sources = [
      candidate({ title: "a1", angleIndex: 0 }),
      candidate({ title: "a2", angleIndex: 0 }),
      candidate({ title: "b1", angleIndex: 1 }),
      candidate({ title: "c1", angleIndex: 2 }),
    ];
    expect(interleaveSourcesByAngle(sources, 3).map((source) => source.title)).toEqual([
      "a1",
      "b1",
      "c1",
      "a2",
    ]);
  });

  test("routes invalid angle indices to the first bucket", () => {
    const sources = [
      candidate({ title: "b1", angleIndex: 1 }),
      candidate({ title: "stray", angleIndex: 99 }),
      candidate({ title: "missing", angleIndex: undefined }),
    ];
    expect(interleaveSourcesByAngle(sources, 2).map((source) => source.title)).toEqual([
      "stray",
      "b1",
      "missing",
    ]);
  });
});

describe("selectNovelSources", () => {
  test("dedupes URL variants and enforces the source budget", () => {
    const sources = [
      candidate({ title: "first", url: "https://example.com/a", angleIndex: 0 }),
      candidate({ title: "dupe", url: "https://www.example.com/a/", angleIndex: 1 }),
      candidate({ title: "second", url: "https://example.com/b", angleIndex: 0 }),
      candidate({ title: "over-budget", url: "https://example.com/c", angleIndex: 1 }),
    ];
    const selection = selectNovelSources(sources, 2, 2);
    expect(selection.sources.map((source) => source.title)).toEqual(["first", "second"]);
    expect(selection.duplicates.map((source) => source.title)).toEqual(["dupe"]);
    expect(selection.budgetDropped.map((source) => source.title)).toEqual(["over-budget"]);
  });

  test("drops sources without any usable key", () => {
    const selection = selectNovelSources([candidate({ title: "", url: "" })], 1, 5);
    expect(selection.sources).toEqual([]);
    expect(selection.budgetDropped).toHaveLength(1);
  });
});

describe("extractsToClaims", () => {
  test("merges duplicate claim text and promotes the best-ranked representative", () => {
    const extracts = [
      extract({
        title: "Blog",
        url: "https://blog.example.com",
        sourceQuality: "blog",
        claims: [{ claim: "The cache is bounded.", quote: "blog quote", importance: "supporting" }],
      }),
      extract({
        title: "Spec",
        url: "https://spec.example.com",
        sourceQuality: "primary",
        claims: [{ claim: "the   CACHE is bounded.", quote: "spec quote", importance: "central" }],
      }),
    ];
    const claims = extractsToClaims(extracts);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      claim: "The cache is bounded.",
      quote: "spec quote",
      importance: "central",
      sourceQuality: "primary",
      sourceUrl: "https://spec.example.com",
      duplicateCount: 2,
    });
    expect(claims[0].evidence.map((evidence) => evidence.quote)).toEqual([
      "blog quote",
      "spec quote",
    ]);
  });

  test("keeps distinct claims in insertion order", () => {
    const extracts = [
      extract({
        claims: [
          { claim: "First claim.", quote: "q1", importance: "supporting" },
          { claim: "Second claim.", quote: "q2", importance: "central" },
        ],
      }),
    ];
    expect(extractsToClaims(extracts).map((entry) => entry.claim)).toEqual([
      "First claim.",
      "Second claim.",
    ]);
  });
});

describe("rankClaims", () => {
  test("orders by importance, then source quality, preserving ties", () => {
    const claims = [
      { claim: "a", importance: "supporting", sourceQuality: "primary" },
      { claim: "b", importance: "central", sourceQuality: "blog" },
      { claim: "c", importance: "central", sourceQuality: "primary" },
      { claim: "d", importance: "supporting", sourceQuality: "primary" },
    ];
    expect(rankClaims(claims).map((entry) => entry.claim)).toEqual(["c", "b", "a", "d"]);
  });
});

describe("aggregateVotes", () => {
  const vote = (output: Record<string, unknown>) => ({ structuredOutput: output });

  test("kills claims once refutations reach the configured threshold", () => {
    const claims = [claim({ claim: "Claim A" }), claim({ claim: "Claim B" })];
    const votedClaims = aggregateVotes(
      claims,
      [
        vote({ claim: "Claim A", refuted: false, confidence: "high", evidence: "ok" }),
        vote({ claim: "Claim A", refuted: true, confidence: "high", evidence: "no" }),
        vote({ claim: "Claim A", refuted: false, confidence: "medium", evidence: "ok" }),
        vote({ claim: "Claim B", refuted: true, confidence: "high", evidence: "no" }),
        vote({ claim: "Claim B", refuted: true, confidence: "low", evidence: "no" }),
        vote({ claim: "Claim B", refuted: false, confidence: "high", evidence: "ok" }),
      ],
      RESEARCH_CONFIGS.smart
    );
    expect(votedClaims.map((entry) => [entry.vote, entry.survives])).toEqual([
      ["2-1", true],
      ["1-2", false],
    ]);
  });

  test("treats a mismatched claim identity as a refutation", () => {
    const votedClaims = aggregateVotes(
      [claim({ claim: "Claim A" })],
      [vote({ claim: "Different claim", refuted: false, confidence: "high", evidence: "ok" })],
      RESEARCH_CONFIGS.quick
    );
    expect(votedClaims[0]).toMatchObject({ survives: false, refutedVotes: 1 });
    expect(votedClaims[0].votes[0].evidence).toContain("mismatched claim identity");
  });

  test("requires enough votes before a claim can survive", () => {
    // smart mode requires two refutations to kill, but also at least two votes
    // to confirm; a single missing vote result must not count as survival.
    const votedClaims = aggregateVotes(
      [claim({ claim: "Claim A" })],
      [vote({ claim: "Claim A", refuted: false, confidence: "high", evidence: "ok" })],
      RESEARCH_CONFIGS.smart
    );
    expect(votedClaims[0].survives).toBe(false);
  });
});
