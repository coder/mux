const mux = globalThis.mux || { schema: workflowSchema() };

const s = mux.schema;

export const metadata = {
  description: "Coordinate delegated agents to research, verify, and synthesize a topic.",
  argsSchema: s.object({
    topic: s.optional(s.string()),
    input: s.optional(s.string()),
    query: s.optional(s.string()),
    quick: s.optional(s.boolean({ default: false, aliases: ["--quick"] })),
    mode: s.optional(s.enum(["quick", "smart", "fast"], { aliases: ["--mode"] })),
  }),
};

// Deep-research conductor: scope the topic into questions and discovery angles,
// fan out source discovery and claim extraction on fast read-only agents,
// adversarially verify the highest-value claims with independent votes, then
// synthesize a cited report.
//
// Authoring constraints (QuickJS workflow sandbox; see the workflow-authoring
// skill for details):
// - The file must stay self-contained: no imports. The host evaluates it as a
//   single script after rewriting away the export declarations.
// - Named exports exist only so unit tests can exercise pure helpers directly.
// - `Date` and `Math.random` are disabled by the host for replay determinism.
// - `agent`/`parallelAgents` step ids are durable replay keys: keep them stable.

// === Agent roles ===

// Scoping, discovery, and extraction stay on the fast read-only agent;
// verification and synthesis need stronger reasoning.
const FAST_AGENT_ID = "explore";
const SMART_AGENT_ID = "exec";

const READ_ONLY_REASONING_PROMPT =
  "This is a read-only deep-research reasoning task. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect evidence only as needed and report findings.\n\n";

// === Mode budgets ===

export const RESEARCH_CONFIGS = {
  quick: {
    mode: "quick",
    maxAngles: 3,
    maxSources: 8,
    maxClaimsPerSource: 5,
    maxVerifyClaims: 8,
    votesPerClaim: 1,
    refutationsRequired: 1,
    maxParallelVerifiers: 4,
  },
  smart: {
    mode: "smart",
    maxAngles: 5,
    maxSources: 15,
    maxClaimsPerSource: 5,
    maxVerifyClaims: 16,
    votesPerClaim: 3,
    refutationsRequired: 2,
    maxParallelVerifiers: 12,
  },
};

// === Shared vocabularies ===

// Array order doubles as rank: earlier entries are preferred when ranking
// claims (compareClaimsForRanking) and when picking a duplicate claim's
// representative evidence (extractsToClaims).
export const SOURCE_QUALITY_LEVELS = ["primary", "secondary", "blog", "forum", "unreliable"];
export const CLAIM_IMPORTANCE_LEVELS = ["central", "supporting", "tangential"];

const RELEVANCE_LEVELS = ["high", "medium", "low"];
const CONFIDENCE_LEVELS = ["high", "medium", "low"];
// The final-synthesis schema has always used low-first ordering while the
// verification schema is high-first. Keep both historical orders so the
// readability refactor does not change the provider-visible schema bytes (or
// the synthesize-report step's replay identity) for fresh runs.
const REPORT_CONFIDENCE_LEVELS = ["low", "medium", "high"];

// === Structured output schemas ===

const SCHEMA = s;
const WORKFLOW_UTILS = workflowUtils();

const SCOPE_SCHEMA = SCHEMA.object(
  {
    refinedTopic: SCHEMA.string(),
    strategy: SCHEMA.string(),
    questions: SCHEMA.array(SCHEMA.string()),
    angles: SCHEMA.array(
      SCHEMA.object(
        {
          label: SCHEMA.string(),
          query: SCHEMA.string(),
          rationale: SCHEMA.string(),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

const SOURCE_DISCOVERY_SCHEMA = SCHEMA.object(
  {
    sources: SCHEMA.array(
      SCHEMA.object(
        {
          title: SCHEMA.string(),
          url: SCHEMA.string(),
          relevance: SCHEMA.enum(RELEVANCE_LEVELS),
          sourceType: SCHEMA.enum(SOURCE_QUALITY_LEVELS),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

const SOURCE_EXTRACTION_SCHEMA = SCHEMA.object(
  {
    source: SCHEMA.string(),
    sourceQuality: SCHEMA.enum(SOURCE_QUALITY_LEVELS),
    publishDate: SCHEMA.string(),
    summary: SCHEMA.string(),
    claims: SCHEMA.array(
      SCHEMA.object(
        {
          claim: SCHEMA.string(),
          quote: SCHEMA.string(),
          importance: SCHEMA.enum(CLAIM_IMPORTANCE_LEVELS),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

const VERIFICATION_SCHEMA = SCHEMA.object(
  {
    claim: SCHEMA.string(),
    refuted: SCHEMA.boolean(),
    confidence: SCHEMA.enum(CONFIDENCE_LEVELS),
    evidence: SCHEMA.string(),
    counterSource: SCHEMA.string(),
  },
  { additionalProperties: false }
);

const FINAL_SYNTHESIS_SCHEMA = SCHEMA.object(
  {
    confidence: SCHEMA.enum(REPORT_CONFIDENCE_LEVELS),
    gaps: SCHEMA.array(SCHEMA.string()),
    findings: SCHEMA.array(SCHEMA.string()),
  },
  { additionalProperties: false }
);

// === Pipeline ===

export default function deepResearch({ args, phase, log, agent, parallelAgents }) {
  const input = normalizeDeepResearchInput(args);
  const config = RESEARCH_CONFIGS[input.mode];

  if (!input.topic) {
    return {
      reportMarkdown: "# Deep Research\n\nNo research topic was provided.",
      structuredOutput: emptyResearchOutput("", config, "No research topic was provided."),
    };
  }

  phase("scope", { topic: input.topic, mode: config.mode });
  const scoped = scopeTopic({ agent, topic: input.topic, config });
  log("Scoped deep research topic", {
    refinedTopic: scoped.refinedTopic,
    mode: config.mode,
    angleCount: scoped.angles.length,
  });

  phase("source-discovery", { angleCount: scoped.angles.length });
  const discovery = discoverSources({ parallelAgents, scoped, config });
  const sources = discovery.selection.sources;
  log("Discovered sources", {
    candidates: discovery.candidates.length,
    selectedCount: sources.length,
    urlDupes: discovery.selection.duplicates.length,
    budgetDropped: discovery.selection.budgetDropped.length,
  });

  phase("source-extraction", { sourceCount: sources.length });
  const extraction = extractClaims({ parallelAgents, scoped, sources, config });

  phase("claim-ranking", {
    claimCount: extraction.allClaims.length,
    selectedCount: extraction.rankedClaims.length,
  });
  log("Extracted claims", {
    sources: extraction.extracts.length,
    claims: extraction.allClaims.length,
    selectedForVerification: extraction.rankedClaims.length,
  });

  if (extraction.rankedClaims.length === 0) {
    return {
      reportMarkdown: `# Deep Research\n\nNo verifiable claims were extracted from ${extraction.extracts.length} selected sources. The research run stopped before adversarial verification.`,
      structuredOutput: buildResearchOutput({
        topic: input.topic,
        refinedTopic: scoped.refinedTopic,
        config,
        questions: scoped.questions,
        angles: scoped.angles,
        sources,
        sourceExtracts: extraction.extracts,
        gaps: ["No verifiable claims were extracted."],
        stats: researchStats({ config, scoped, discovery, extraction }),
      }),
    };
  }

  phase("adversarial-verification", {
    claimCount: extraction.rankedClaims.length,
    votesPerClaim: config.votesPerClaim,
  });
  const verification = verifyClaims({
    parallelAgents,
    refinedTopic: scoped.refinedTopic,
    claims: extraction.rankedClaims,
    config,
  });
  log("Verified claims", {
    verified: verification.votedClaims.length,
    confirmed: verification.confirmedClaims.length,
    refuted: verification.refutedClaims.length,
  });

  phase("final-synthesis", {
    confirmed: verification.confirmedClaims.length,
    refuted: verification.refutedClaims.length,
  });
  const final = synthesizeFinalReport({ agent, scoped, sources, extraction, verification, config });

  return {
    reportMarkdown: final.reportMarkdown,
    structuredOutput: buildResearchOutput({
      topic: input.topic,
      refinedTopic: scoped.refinedTopic,
      config,
      questions: scoped.questions,
      angles: scoped.angles,
      sources,
      sourceExtracts: extraction.extracts,
      claims: extraction.rankedClaims,
      verification: verification.votedClaims.map((claim) => ({
        claim: claim.claim,
        source: claim.sourceUrl,
        vote: claim.vote,
        refutedVotes: claim.refutedVotes,
        survives: claim.survives,
      })),
      confirmedClaims: verification.confirmedClaims,
      refutedClaims: verification.refutedClaims,
      confidence: final.structuredOutput.confidence,
      gaps: final.structuredOutput.gaps,
      findings: WORKFLOW_UTILS.asArray(final.structuredOutput.findings),
      stats: researchStats({ config, scoped, discovery, extraction, verification }),
    }),
  };
}

// === Phase: scoping ===

function scopeTopic({ agent, topic, config }) {
  const scope = agent({
    id: "scope-topic",
    title: "Scope research topic",
    agentId: FAST_AGENT_ID,
    prompt: buildScopePrompt(topic),
    outputSchema: SCOPE_SCHEMA,
  });
  const refinedTopic = nonEmptyString(scope.structuredOutput.refinedTopic) || topic;
  const questions = WORKFLOW_UTILS.asArray(scope.structuredOutput.questions).slice(
    0,
    config.maxAngles
  );
  const scopedAngles = WORKFLOW_UTILS.asArray(scope.structuredOutput.angles).slice(
    0,
    config.maxAngles
  );
  const angles = scopedAngles.length > 0 ? scopedAngles : fallbackAngles(refinedTopic, questions);
  return { refinedTopic, questions, angles };
}

function buildScopePrompt(topic) {
  return `Refine this deep research topic into a focused investigation. Return the refined topic, 3-5 complementary research questions, and 3-5 source-discovery angles.

Topic: ${topic}

Angles should be specific and non-overlapping. Favor a mix of primary/official sources, implementation or practitioner evidence, tests/data/benchmarks, recent context, and skeptical or contradictory evidence when relevant.

Structured output only.`;
}

function fallbackAngles(refinedTopic, questions) {
  if (questions.length > 0) {
    return questions.map((question, index) => ({
      label: `question-${index + 1}`,
      query: question,
      rationale: "Fallback angle from scoped research question.",
    }));
  }
  return [
    {
      label: "general",
      query: refinedTopic,
      rationale: "Fallback angle because scoping returned no angles.",
    },
  ];
}

// === Phase: source discovery ===

function discoverSources({ parallelAgents, scoped, config }) {
  const discoveryResults = workflowParallelMap(
    {
      items: scoped.angles,
      stepId: function (_angle, index) {
        return `discover-sources-${index}`;
      },
      title: function (angle) {
        return `Discover sources for ${angle.label}`;
      },
      agentId: FAST_AGENT_ID,
      prompt: function (angle) {
        return buildDiscoveryPrompt(scoped, angle);
      },
      outputSchema: SOURCE_DISCOVERY_SCHEMA,
    },
    parallelAgents
  );
  const candidates = discoveryResultsToSources(discoveryResults, scoped.angles);
  const selection = selectNovelSources(candidates, scoped.angles.length, config.maxSources);
  return { candidates, selection };
}

function buildDiscoveryPrompt(scoped, angle) {
  return `Find high-signal sources for this deep research angle. Use repo inspection and web/docs lookup as appropriate for the topic.

Topic: ${scoped.refinedTopic}
Research questions: ${scoped.questions.join("; ")}
Angle: ${JSON.stringify(angle)}

Return 4-6 ranked sources. Prefer primary docs/specs/papers/source files/test evidence and concrete data over summaries. Include a URL or repository path in url. Skip SEO spam and unsupported commentary.

Structured output only.`;
}

function discoveryResultsToSources(discoveryResults, angles) {
  const sources = [];
  discoveryResults.forEach((result, angleIndex) => {
    const angle = angles[angleIndex] || { label: `angle-${angleIndex}` };
    WORKFLOW_UTILS.asArray(result.structuredOutput.sources).forEach((source, sourceIndex) => {
      sources.push({
        title: nonEmptyString(source.title) || "Untitled source",
        url:
          nonEmptyString(source.url) ||
          nonEmptyString(source.title) ||
          `source-${angleIndex}-${sourceIndex}`,
        relevance: normalizeEnum(source.relevance, RELEVANCE_LEVELS, "medium"),
        sourceType: normalizeEnum(source.sourceType, SOURCE_QUALITY_LEVELS, "secondary"),
        angle: angle.label,
        angleIndex,
      });
    });
  });
  return sources;
}

// Keep one source per normalized URL, interleaved across angles so every angle
// stays represented under the source budget.
export function selectNovelSources(sources, angleCount, maxSources) {
  const ordered = interleaveSourcesByAngle(sources, angleCount);
  const seen = new Set();
  const selected = [];
  const duplicates = [];
  const budgetDropped = [];
  ordered.forEach((source) => {
    const key = normalizeSourceKey(source.url || source.title);
    if (!key) {
      budgetDropped.push(source);
      return;
    }
    if (seen.has(key)) {
      duplicates.push(source);
      return;
    }
    if (selected.length >= maxSources) {
      budgetDropped.push(source);
      return;
    }
    seen.add(key);
    selected.push(source);
  });
  return { sources: selected, duplicates, budgetDropped };
}

export function interleaveSourcesByAngle(sources, angleCount) {
  const bucketCount = Math.max(angleCount, 1);
  const buckets = Array.from({ length: bucketCount }, () => []);
  sources.forEach((source) => {
    const index =
      typeof source.angleIndex === "number" &&
      source.angleIndex >= 0 &&
      source.angleIndex < bucketCount
        ? source.angleIndex
        : 0;
    buckets[index].push(source);
  });
  const maxBucketLength = buckets.reduce((max, bucket) => Math.max(max, bucket.length), 0);
  const ordered = [];
  for (let offset = 0; offset < maxBucketLength; offset++) {
    for (const bucket of buckets) {
      if (bucket[offset]) ordered.push(bucket[offset]);
    }
  }
  return ordered;
}

// Canonicalize source URLs (and repo paths) so trivial variants dedupe:
// case-insensitive scheme/host, no www., no fragments, no tracking params,
// sorted query, no trailing slashes. Path case and meaningful query parameters
// are preserved.
export function normalizeSourceKey(value) {
  const raw = stripFragment(String(value || "").trim());
  if (!raw) return "";
  const split = splitQuery(raw);
  const query = normalizeQueryString(split.query);
  const urlParts = split.path.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(.*)$/);
  if (urlParts) {
    const scheme = urlParts[1].toLowerCase();
    const host = urlParts[2].replace(/^www\./i, "").toLowerCase();
    const path = trimTrailingSlashes(urlParts[3] || "");
    return `${scheme}://${host}${path}${query ? `?${query}` : ""}`;
  }
  return trimTrailingSlashes(split.path) + (query ? `?${query}` : "");
}

function stripFragment(value) {
  const hashIndex = value.indexOf("#");
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
}

function splitQuery(value) {
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0) return { path: value, query: "" };
  return { path: value.slice(0, queryIndex), query: value.slice(queryIndex + 1) };
}

function normalizeQueryString(query) {
  if (!query) return "";
  return query
    .split("&")
    .filter((part) => part)
    .filter((part) => !isTrackingQueryParam(part))
    .sort()
    .join("&");
}

const TRACKING_QUERY_PARAMS = ["fbclid", "gclid", "dclid", "mc_cid", "mc_eid", "igshid"];

function isTrackingQueryParam(part) {
  const eqIndex = part.indexOf("=");
  const name = (eqIndex >= 0 ? part.slice(0, eqIndex) : part).toLowerCase();
  return name.startsWith("utm_") || TRACKING_QUERY_PARAMS.includes(name);
}

function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}

// === Phase: claim extraction ===

function extractClaims({ parallelAgents, scoped, sources, config }) {
  const extractionResults = workflowParallelMap(
    {
      items: sources,
      stepId: function (_source, index) {
        return `extract-source-${index}`;
      },
      title: function (_source, index) {
        return `Extract claims from source ${index + 1}`;
      },
      agentId: FAST_AGENT_ID,
      prompt: function (source) {
        return buildExtractionPrompt(scoped, source);
      },
      outputSchema: SOURCE_EXTRACTION_SCHEMA,
    },
    parallelAgents
  );
  const extracts = sourceExtractionResultsToExtracts(extractionResults, sources, config);
  const allClaims = extractsToClaims(extracts);
  const rankedClaims = rankClaims(allClaims).slice(0, config.maxVerifyClaims);
  return { extracts, allClaims, rankedClaims };
}

function buildExtractionPrompt(scoped, source) {
  return `Inspect this source and extract falsifiable evidence for the research topic.

Topic: ${scoped.refinedTopic}
Research questions: ${scoped.questions.join("; ")}
Source: ${JSON.stringify(source)}

Return a concise source summary, source quality, publish date if available, and 0-5 concrete claims. Each claim must be checkable, relevant to the topic, and backed by a direct quote or exact repository evidence. If the source is unavailable, paywalled, or irrelevant, return claims: [] and sourceQuality: "unreliable".

Structured output only.`;
}

function sourceExtractionResultsToExtracts(results, selectedSources, config) {
  return results.map((result, index) => {
    const source = selectedSources[index] || {};
    const output = result.structuredOutput;
    const claims = WORKFLOW_UTILS.asArray(output.claims)
      .map((claim) => ({
        claim: nonEmptyString(claim.claim),
        quote: nonEmptyString(claim.quote),
        importance: normalizeEnum(claim.importance, CLAIM_IMPORTANCE_LEVELS, "supporting"),
      }))
      .filter((claim) => claim.claim && claim.quote)
      .slice(0, config.maxClaimsPerSource);
    return {
      title: source.title || nonEmptyString(output.source) || "Untitled source",
      url: source.url || nonEmptyString(output.source),
      angle: source.angle || "unknown",
      relevance: source.relevance || "medium",
      sourceType: source.sourceType || "secondary",
      sourceQuality: normalizeEnum(output.sourceQuality, SOURCE_QUALITY_LEVELS, "unreliable"),
      publishDate: nonEmptyString(output.publishDate),
      summary: nonEmptyString(output.summary),
      claims,
    };
  });
}

// Merge claims with identical normalized text: collect every source's evidence
// and let the best-ranked duplicate represent the claim.
export function extractsToClaims(sourceExtracts) {
  const claimsByKey = new Map();
  const claims = [];
  sourceExtracts.forEach((source) => {
    source.claims.forEach((claim) => {
      const key = normalizeClaimKey(claim.claim);
      if (!key) return;
      const evidence = {
        quote: claim.quote,
        sourceUrl: source.url,
        sourceTitle: source.title,
        sourceQuality: source.sourceQuality,
        publishDate: source.publishDate,
      };
      const candidate = {
        claim: claim.claim,
        quote: claim.quote,
        importance: claim.importance,
        sourceUrl: source.url,
        sourceTitle: source.title,
        sourceQuality: source.sourceQuality,
        publishDate: source.publishDate,
        evidence: [evidence],
        duplicateCount: 1,
      };
      const existing = claimsByKey.get(key);
      if (!existing) {
        claimsByKey.set(key, candidate);
        claims.push(candidate);
        return;
      }
      existing.evidence.push(evidence);
      existing.duplicateCount += 1;
      if (compareClaimsForRanking(candidate, existing) < 0) {
        existing.quote = candidate.quote;
        existing.importance = candidate.importance;
        existing.sourceUrl = candidate.sourceUrl;
        existing.sourceTitle = candidate.sourceTitle;
        existing.sourceQuality = candidate.sourceQuality;
        existing.publishDate = candidate.publishDate;
      }
    });
  });
  return claims;
}

function normalizeClaimKey(value) {
  return nonEmptyString(value).toLowerCase().split(/\s+/).join(" ");
}

export function rankClaims(claims) {
  return claims.slice().sort(compareClaimsForRanking);
}

// Vocabulary index doubles as rank (lower wins). Inputs are normalized via
// normalizeEnum before ranking, so indexOf never sees unknown values.
function compareClaimsForRanking(left, right) {
  return (
    CLAIM_IMPORTANCE_LEVELS.indexOf(left.importance) -
      CLAIM_IMPORTANCE_LEVELS.indexOf(right.importance) ||
    SOURCE_QUALITY_LEVELS.indexOf(left.sourceQuality) -
      SOURCE_QUALITY_LEVELS.indexOf(right.sourceQuality)
  );
}

// === Phase: adversarial verification ===

function verifyClaims({ parallelAgents, refinedTopic, claims, config }) {
  const voteItems = buildVerificationItems({ claims, config });
  // Verification fans out claims x votes; maxParallel caps live verifier
  // agents with a sliding window so the queue keeps draining while slow
  // verifiers finish, instead of stalling whole fixed-size batches.
  const voteResults = workflowParallelMap(
    {
      items: voteItems,
      stepId: function (item) {
        return `verify-claim-${item.claimIndex}-vote-${item.vote}`;
      },
      title: function (item) {
        return `Verify claim ${item.claimIndex + 1} vote ${item.vote + 1}`;
      },
      agentId: SMART_AGENT_ID,
      prompt: function (item) {
        return buildVerificationPrompt({
          refinedTopic,
          claim: item.claim,
          vote: item.vote,
          votesPerClaim: config.votesPerClaim,
        });
      },
      outputSchema: VERIFICATION_SCHEMA,
      maxParallel: config.maxParallelVerifiers,
    },
    parallelAgents
  );
  const votedClaims = aggregateVotes(claims, voteResults, config);
  const confirmedClaims = votedClaims.filter((claim) => claim.survives);
  const refutedClaims = votedClaims.filter((claim) => !claim.survives);
  return { votedClaims, confirmedClaims, refutedClaims };
}

function buildVerificationItems({ claims, config }) {
  const items = [];
  claims.forEach((claim, claimIndex) => {
    for (let vote = 0; vote < config.votesPerClaim; vote++) {
      items.push({ claim, claimIndex, vote });
    }
  });
  return items;
}

function buildVerificationPrompt({ refinedTopic, claim, vote, votesPerClaim }) {
  return `${READ_ONLY_REASONING_PROMPT}Be skeptical and try to refute this claim. Default to refuted=true if the quote does not support the claim, if credible evidence contradicts it, if the source quality is too weak for the claim, or if the claim is stale/marketing/cherry-picked.

Topic: ${refinedTopic}
Claim: ${JSON.stringify(claim)}
Vote: ${vote + 1} of ${votesPerClaim}

Return a specific verdict. Evidence must explain why the claim is supported or refuted. Structured output only.`;
}

export function aggregateVotes(claims, voteResults, config) {
  return claims.map((claim, claimIndex) => {
    const start = claimIndex * config.votesPerClaim;
    const votes = voteResults.slice(start, start + config.votesPerClaim).map((result) => {
      const output = result.structuredOutput;
      const returnedClaim = nonEmptyString(output.claim);
      // A verifier that echoes back a different claim did not verify this one;
      // count it as a refutation instead of trusting the verdict.
      const claimMismatch = returnedClaim !== claim.claim;
      return {
        refuted: claimMismatch || output.refuted === true,
        confidence: normalizeEnum(output.confidence, CONFIDENCE_LEVELS, "low"),
        evidence: claimMismatch
          ? `Verifier returned a mismatched claim identity: ${returnedClaim}`
          : nonEmptyString(output.evidence),
        counterSource: nonEmptyString(output.counterSource),
      };
    });
    const refutedVotes = votes.filter((vote) => vote.refuted).length;
    const supportingVotes = votes.length - refutedVotes;
    const survives =
      votes.length >= config.refutationsRequired && refutedVotes < config.refutationsRequired;
    return {
      ...claim,
      votes,
      vote: `${supportingVotes}-${refutedVotes}`,
      refutedVotes,
      survives,
    };
  });
}

// === Phase: final synthesis ===

function synthesizeFinalReport({ agent, scoped, sources, extraction, verification, config }) {
  return agent({
    id: "synthesize-report",
    title: "Synthesize final deep research report",
    agentId: SMART_AGENT_ID,
    prompt: buildSynthesisPrompt({ scoped, sources, extraction, verification, config }),
    outputSchema: FINAL_SYNTHESIS_SCHEMA,
  });
}

function buildSynthesisPrompt({ scoped, sources, extraction, verification, config }) {
  const compactExtracts = extraction.extracts.map((source) => ({
    title: source.title,
    url: source.url,
    quality: source.sourceQuality,
    summary: source.summary,
    claimCount: source.claims.length,
  }));
  return `${READ_ONLY_REASONING_PROMPT}Write the final deep research report. Merge semantically duplicate surviving claims, cite source titles/paths/URLs, disclose refuted or uncertain claims, and call out caveats and follow-up work.

Topic: ${scoped.refinedTopic}
Mode: ${config.mode}
Questions: ${JSON.stringify(scoped.questions)}
Sources: ${JSON.stringify(sources)}
Source extracts: ${JSON.stringify(compactExtracts)}
Confirmed claims: ${JSON.stringify(verification.confirmedClaims)}
Refuted or unverified claims: ${JSON.stringify(verification.refutedClaims)}

Return confidence, remaining gaps, and finding labels as structured output. Put the human-readable report in your final markdown.`;
}

// === Input normalization ===

export function normalizeDeepResearchInput(args) {
  let mode = "smart";
  if (args && typeof args === "object") {
    if (args.quick === true) mode = "quick";
    if (typeof args.mode === "string") mode = normalizeResearchMode(args.mode);
  }
  return { topic: normalizeResearchTopic(args), mode };
}

function normalizeResearchTopic(args) {
  if (typeof args === "string") return nonEmptyString(args);
  if (args && typeof args === "object") {
    // Slash invocations pass { input }; parsed --query should win over raw flag text.
    if (typeof args.topic === "string" && args.topic.trim()) return args.topic.trim();
    if (typeof args.query === "string" && args.query.trim()) return args.query.trim();
    if (typeof args.input === "string" && args.input.trim()) return args.input.trim();
  }
  return "";
}

function normalizeResearchMode(mode) {
  const normalized = mode.trim().toLowerCase();
  return normalized === "quick" || normalized === "fast" ? "quick" : "smart";
}

// === Output assembly ===

// Single definition of the structured-output contract. Early-exit paths rely
// on the defaults; the happy path overrides them.
function buildResearchOutput(base) {
  return {
    topic: base.topic,
    refinedTopic: base.refinedTopic,
    mode: base.config.mode,
    questions: base.questions,
    angles: base.angles,
    sources: base.sources,
    sourceExtracts: base.sourceExtracts,
    claims: base.claims ?? [],
    verification: base.verification ?? [],
    confirmedClaims: base.confirmedClaims ?? [],
    refutedClaims: base.refutedClaims ?? [],
    confidence: base.confidence ?? "low",
    gaps: base.gaps,
    findings: base.findings ?? [],
    stats: base.stats,
  };
}

function emptyResearchOutput(topic, config, gap) {
  return buildResearchOutput({
    topic,
    refinedTopic: topic,
    config,
    questions: [],
    angles: [],
    sources: [],
    sourceExtracts: [],
    gaps: [gap],
    stats: zeroResearchStats(config),
  });
}

function researchStats({ config, scoped, discovery, extraction, verification }) {
  const votedClaims = verification ? verification.votedClaims : [];
  const confirmedClaims = verification ? verification.confirmedClaims : [];
  return {
    mode: config.mode,
    angles: scoped.angles.length,
    sourceCandidates: discovery.candidates.length,
    sourcesFetched: extraction.extracts.length,
    claimsExtracted: extraction.allClaims.length,
    claimsVerified: votedClaims.length,
    confirmed: confirmedClaims.length,
    killed: votedClaims.length - confirmedClaims.length,
    urlDupes: discovery.selection.duplicates.length,
    budgetDropped: discovery.selection.budgetDropped.length,
    votesPerClaim: config.votesPerClaim,
    agentCalls:
      1 +
      scoped.angles.length +
      extraction.extracts.length +
      votedClaims.length * config.votesPerClaim +
      (votedClaims.length > 0 ? 1 : 0),
  };
}

// Stats for runs that ended before any agent was launched. researchStats()
// always counts the scope step, so the all-empty case needs its own zero form.
function zeroResearchStats(config) {
  return {
    mode: config.mode,
    angles: 0,
    sourceCandidates: 0,
    sourcesFetched: 0,
    claimsExtracted: 0,
    claimsVerified: 0,
    confirmed: 0,
    killed: 0,
    urlDupes: 0,
    budgetDropped: 0,
    votesPerClaim: config.votesPerClaim,
    agentCalls: 0,
  };
}

// === Generic utilities ===

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function workflowSchema() {
  if (globalThis.mux && globalThis.mux.schema) return globalThis.mux.schema;
  function withOptions(schema, options) {
    return options && typeof options === "object" && !Array.isArray(options)
      ? Object.assign(schema, options)
      : schema;
  }
  function optional(schema) {
    const clone = Object.assign({}, schema || {});
    Object.defineProperty(clone, "__muxOptional", { value: true });
    return clone;
  }
  function isOptional(schema) {
    return Boolean(schema && schema.__muxOptional === true);
  }
  function nullable(schema) {
    const clone = Object.assign({}, schema || {});
    if (typeof clone.type === "string")
      clone.type = clone.type === "null" ? ["null"] : [clone.type, "null"];
    else if (Array.isArray(clone.type))
      clone.type = clone.type.includes("null") ? clone.type : clone.type.concat(["null"]);
    else clone.type = ["null"];
    return clone;
  }
  return {
    string: function (options) {
      return withOptions({ type: "string" }, options);
    },
    number: function (options) {
      return withOptions({ type: "number" }, options);
    },
    integer: function (options) {
      return withOptions({ type: "integer" }, options);
    },
    boolean: function (options) {
      return withOptions({ type: "boolean" }, options);
    },
    array: function (items, options) {
      return withOptions({ type: "array", items: items }, options);
    },
    enum: function (values, options) {
      return withOptions({ type: "string", enum: Array.isArray(values) ? values : [] }, options);
    },
    union: function (schemas) {
      const types = [];
      for (const schema of Array.isArray(schemas) ? schemas : []) {
        const schemaTypes = Array.isArray(schema && schema.type)
          ? schema.type
          : [schema && schema.type];
        for (const type of schemaTypes) {
          if (typeof type === "string" && !types.includes(type)) types.push(type);
        }
      }
      return { type: types };
    },
    optional: optional,
    nullable: nullable,
    object: function (properties, options) {
      const sourceProperties = properties || {};
      const keys = Object.keys(sourceProperties);
      const cleanProperties = {};
      const inferredRequired = [];
      for (const key of keys) {
        const propertySchema = sourceProperties[key];
        cleanProperties[key] = isOptional(propertySchema)
          ? Object.assign({}, propertySchema)
          : propertySchema;
        if (!isOptional(propertySchema)) inferredRequired.push(key);
      }
      const required = Array.isArray(options && options.required)
        ? options.required.filter(function (key) {
            return keys.includes(key);
          })
        : options && options.required === false
          ? []
          : inferredRequired;
      const schema = { type: "object", required: required, properties: cleanProperties };
      if (options && Object.prototype.hasOwnProperty.call(options, "additionalProperties")) {
        schema.additionalProperties = options.additionalProperties;
      }
      return schema;
    },
  };
}

function workflowUtils() {
  if (globalThis.mux && globalThis.mux.utils) return globalThis.mux.utils;
  return {
    asArray: function (value) {
      return Array.isArray(value) ? value : [];
    },
  };
}

function workflowParallelMap(options, parallelAgents) {
  if (globalThis.mux && typeof globalThis.mux.parallelMap === "function") {
    return globalThis.mux.parallelMap(options);
  }
  const items = WORKFLOW_UTILS.asArray(options.items);
  if (items.length === 0) return [];
  return parallelAgents(
    items.map(function (item, index) {
      return {
        id:
          typeof options.stepId === "function"
            ? options.stepId(item, index)
            : options.id + "-" + index,
        title: typeof options.title === "function" ? options.title(item, index) : options.title,
        agentId:
          typeof options.agentId === "function" ? options.agentId(item, index) : options.agentId,
        prompt: typeof options.prompt === "function" ? options.prompt(item, index) : options.prompt,
        outputSchema:
          typeof options.outputSchema === "function"
            ? options.outputSchema(item, index)
            : options.outputSchema,
      };
    }),
    { maxParallel: options.maxParallel || items.length }
  );
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}
