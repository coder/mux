// description: Coordinate delegated agents to research, verify, and synthesize a topic.
export default function deepResearch({ args, phase, log, agent, parallelAgents }) {
  const input = normalizeDeepResearchInput(args);
  const config = researchConfigForMode(input.mode);
  const fastAgentId = "explore";
  const smartAgentId = "exec";
  const readOnlyReasoningPrompt =
    "This is a read-only deep-research reasoning task. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect evidence only as needed and report findings.\n\n";

  if (!input.topic) {
    return {
      reportMarkdown: "# Deep Research\n\nNo research topic was provided.",
      structuredOutput: emptyResearchOutput("", config.mode, "No research topic was provided."),
    };
  }

  phase("scope", { topic: input.topic, mode: config.mode });
  const scope = agent({
    id: "scope-topic",
    title: "Scope research topic",
    agentId: fastAgentId,
    prompt:
      "Refine this deep research topic into a focused investigation. Return the refined topic, 3-5 complementary research questions, and 3-5 source-discovery angles.\n\n" +
      "Topic: " +
      input.topic +
      "\n\nAngles should be specific and non-overlapping. Favor a mix of primary/official sources, implementation or practitioner evidence, tests/data/benchmarks, recent context, and skeptical or contradictory evidence when relevant.\n\nStructured output only.",
    outputSchema: scopeSchema(),
  });
  const refinedTopic = nonEmptyString(scope.structuredOutput.refinedTopic) || input.topic;
  const questions = asArray(scope.structuredOutput.questions).slice(0, config.maxAngles);
  const scopedAngles = asArray(scope.structuredOutput.angles).slice(0, config.maxAngles);
  const angles = scopedAngles.length > 0 ? scopedAngles : fallbackAngles(refinedTopic, questions);
  log("Scoped deep research topic", { refinedTopic, mode: config.mode, angleCount: angles.length });

  phase("source-discovery", { angleCount: angles.length });
  const discoveryResults = parallelAgents(
    angles.map(function (angle, index) {
      return {
        id: "discover-sources-" + index,
        title: "Discover sources for " + angle.label,
        agentId: fastAgentId,
        prompt:
          "Find high-signal sources for this deep research angle. Use repo inspection and web/docs lookup as appropriate for the topic.\n\n" +
          "Topic: " +
          refinedTopic +
          "\nResearch questions: " +
          questions.join("; ") +
          "\nAngle: " +
          JSON.stringify(angle) +
          "\n\nReturn 4-6 ranked sources. Prefer primary docs/specs/papers/source files/test evidence and concrete data over summaries. Include a URL or repository path in url. Skip SEO spam and unsupported commentary.\n\nStructured output only.",
        outputSchema: sourceDiscoverySchema(),
      };
    })
  );
  const sourceCandidates = discoveryResultsToSources(discoveryResults, angles);
  const sourceSelection = selectNovelSources(sourceCandidates, angles.length, config.maxSources);
  const discoveredSources = sourceSelection.sources;
  log("Discovered sources", {
    candidates: sourceCandidates.length,
    selectedCount: discoveredSources.length,
    urlDupes: sourceSelection.duplicates.length,
    budgetDropped: sourceSelection.budgetDropped.length,
  });

  phase("source-extraction", { sourceCount: discoveredSources.length });
  const sourceExtractionResults =
    discoveredSources.length > 0
      ? parallelAgents(
          discoveredSources.map(function (source, index) {
            return {
              id: "extract-source-" + index,
              title: "Extract claims from source " + (index + 1),
              agentId: fastAgentId,
              prompt:
                "Inspect this source and extract falsifiable evidence for the research topic.\n\n" +
                "Topic: " +
                refinedTopic +
                "\nResearch questions: " +
                questions.join("; ") +
                "\nSource: " +
                JSON.stringify(source) +
                '\n\nReturn a concise source summary, source quality, publish date if available, and 0-5 concrete claims. Each claim must be checkable, relevant to the topic, and backed by a direct quote or exact repository evidence. If the source is unavailable, paywalled, or irrelevant, return claims: [] and sourceQuality: "unreliable".\n\nStructured output only.',
              outputSchema: sourceExtractionSchema(),
            };
          })
        )
      : [];
  const sourceExtracts = sourceExtractionResultsToExtracts(
    sourceExtractionResults,
    discoveredSources,
    config
  );
  const allClaims = extractsToClaims(sourceExtracts);
  const rankedClaims = rankClaims(allClaims).slice(0, config.maxVerifyClaims);

  phase("claim-ranking", { claimCount: allClaims.length, selectedCount: rankedClaims.length });
  log("Extracted claims", {
    sources: sourceExtracts.length,
    claims: allClaims.length,
    selectedForVerification: rankedClaims.length,
  });

  if (rankedClaims.length === 0) {
    return {
      reportMarkdown:
        "# Deep Research\n\nNo verifiable claims were extracted from " +
        sourceExtracts.length +
        " selected sources. The research run stopped before adversarial verification.",
      structuredOutput: {
        topic: input.topic,
        refinedTopic: refinedTopic,
        mode: config.mode,
        questions: questions,
        angles: angles,
        sources: discoveredSources,
        sourceExtracts: sourceExtracts,
        claims: [],
        verification: [],
        confirmedClaims: [],
        refutedClaims: [],
        confidence: "low",
        gaps: ["No verifiable claims were extracted."],
        findings: [],
        stats: researchStats(
          config,
          angles,
          sourceCandidates,
          sourceSelection,
          sourceExtracts,
          allClaims,
          [],
          []
        ),
      },
    };
  }

  phase("adversarial-verification", {
    claimCount: rankedClaims.length,
    votesPerClaim: config.votesPerClaim,
  });
  const voteSpecs = verificationSpecs(
    rankedClaims,
    config,
    smartAgentId,
    readOnlyReasoningPrompt,
    refinedTopic
  );
  const voteResults = runParallelAgentBatches(
    voteSpecs,
    config.verificationBatchSize,
    parallelAgents
  );
  const votedClaims = aggregateVotes(rankedClaims, voteResults, config);
  const confirmedClaims = votedClaims.filter(function (claim) {
    return claim.survives;
  });
  const refutedClaims = votedClaims.filter(function (claim) {
    return !claim.survives;
  });
  log("Verified claims", {
    verified: votedClaims.length,
    confirmed: confirmedClaims.length,
    refuted: refutedClaims.length,
  });

  phase("final-synthesis", { confirmed: confirmedClaims.length, refuted: refutedClaims.length });
  const final = agent({
    id: "synthesize-report",
    title: "Synthesize final deep research report",
    agentId: smartAgentId,
    prompt:
      readOnlyReasoningPrompt +
      "Write the final deep research report. Merge semantically duplicate surviving claims, cite source titles/paths/URLs, disclose refuted or uncertain claims, and call out caveats and follow-up work.\n\n" +
      "Topic: " +
      refinedTopic +
      "\nMode: " +
      config.mode +
      "\nQuestions: " +
      JSON.stringify(questions) +
      "\nSources: " +
      JSON.stringify(discoveredSources) +
      "\nSource extracts: " +
      JSON.stringify(
        sourceExtracts.map(function (source) {
          return {
            title: source.title,
            url: source.url,
            quality: source.sourceQuality,
            summary: source.summary,
            claimCount: source.claims.length,
          };
        })
      ) +
      "\nConfirmed claims: " +
      JSON.stringify(confirmedClaims) +
      "\nRefuted or unverified claims: " +
      JSON.stringify(refutedClaims) +
      "\n\nReturn confidence, remaining gaps, and finding labels as structured output. Put the human-readable report in your final markdown.",
    outputSchema: finalSynthesisSchema(),
  });

  return {
    reportMarkdown: final.reportMarkdown,
    structuredOutput: {
      topic: input.topic,
      refinedTopic: refinedTopic,
      mode: config.mode,
      questions: questions,
      angles: angles,
      sources: discoveredSources,
      sourceExtracts: sourceExtracts,
      claims: rankedClaims,
      verification: votedClaims.map(function (claim) {
        return {
          claim: claim.claim,
          source: claim.sourceUrl,
          vote: claim.vote,
          refutedVotes: claim.refutedVotes,
          survives: claim.survives,
        };
      }),
      confirmedClaims: confirmedClaims,
      refutedClaims: refutedClaims,
      confidence: final.structuredOutput.confidence,
      gaps: final.structuredOutput.gaps,
      findings: asArray(final.structuredOutput.findings),
      stats: researchStats(
        config,
        angles,
        sourceCandidates,
        sourceSelection,
        sourceExtracts,
        allClaims,
        votedClaims,
        confirmedClaims
      ),
    },
  };
}

function normalizeDeepResearchInput(args) {
  const topic = normalizeDeepResearchTopic(args);
  let mode = "smart";
  if (args && typeof args === "object") {
    if (args.quick === true) mode = "quick";
    if (typeof args.mode === "string") mode = normalizeResearchMode(args.mode);
  }
  return { topic: topic, mode: mode };
}

function normalizeDeepResearchTopic(args) {
  if (typeof args === "string") return nonEmptyString(args);
  if (args && typeof args === "object") {
    if (typeof args.topic === "string" && args.topic.trim()) return args.topic.trim();
    if (typeof args.input === "string" && args.input.trim()) return args.input.trim();
    if (typeof args.query === "string" && args.query.trim()) return args.query.trim();
  }
  return "";
}

function normalizeResearchMode(mode) {
  const normalized = mode.trim().toLowerCase();
  return normalized === "quick" || normalized === "fast" ? "quick" : "smart";
}

function researchConfigForMode(mode) {
  if (mode === "quick") {
    return {
      mode: "quick",
      maxAngles: 3,
      maxSources: 8,
      maxClaimsPerSource: 5,
      maxVerifyClaims: 8,
      votesPerClaim: 1,
      refutationsRequired: 1,
      verificationBatchSize: 4,
    };
  }
  return {
    mode: "smart",
    maxAngles: 5,
    maxSources: 15,
    maxClaimsPerSource: 5,
    maxVerifyClaims: 16,
    votesPerClaim: 3,
    refutationsRequired: 2,
    verificationBatchSize: 6,
  };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function fallbackAngles(refinedTopic, questions) {
  if (questions.length > 0) {
    return questions.map(function (question, index) {
      return {
        label: "question-" + (index + 1),
        query: question,
        rationale: "Fallback angle from scoped research question.",
      };
    });
  }
  return [
    {
      label: "general",
      query: refinedTopic,
      rationale: "Fallback angle because scoping returned no angles.",
    },
  ];
}

function discoveryResultsToSources(discoveryResults, angles) {
  const sources = [];
  discoveryResults.forEach(function (result, angleIndex) {
    const angle = angles[angleIndex] || { label: "angle-" + angleIndex };
    asArray(result.structuredOutput.sources).forEach(function (source, sourceIndex) {
      sources.push({
        title: nonEmptyString(source.title) || "Untitled source",
        url:
          nonEmptyString(source.url) ||
          nonEmptyString(source.title) ||
          "source-" + angleIndex + "-" + sourceIndex,
        relevance: normalizeEnum(source.relevance, ["high", "medium", "low"], "medium"),
        sourceType: normalizeEnum(
          source.sourceType,
          ["primary", "secondary", "blog", "forum", "unreliable"],
          "secondary"
        ),
        angle: angle.label,
        angleIndex: angleIndex,
      });
    });
  });
  return sources;
}

function selectNovelSources(sources, angleCount, maxSources) {
  const ordered = interleaveSourcesByAngle(sources, angleCount);
  const seen = new Set();
  const selected = [];
  const duplicates = [];
  const budgetDropped = [];
  ordered.forEach(function (source) {
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
  return { sources: selected, duplicates: duplicates, budgetDropped: budgetDropped };
}

function interleaveSourcesByAngle(sources, angleCount) {
  const bucketCount = Math.max(angleCount, 1);
  const buckets = Array.from({ length: bucketCount }, function () {
    return [];
  });
  sources.forEach(function (source) {
    const index =
      typeof source.angleIndex === "number" &&
      source.angleIndex >= 0 &&
      source.angleIndex < bucketCount
        ? source.angleIndex
        : 0;
    buckets[index].push(source);
  });
  const maxBucketLength = buckets.reduce(function (max, bucket) {
    return Math.max(max, bucket.length);
  }, 0);
  const ordered = [];
  for (let offset = 0; offset < maxBucketLength; offset++) {
    for (let index = 0; index < buckets.length; index++) {
      if (buckets[index][offset]) ordered.push(buckets[index][offset]);
    }
  }
  return ordered;
}

function normalizeSourceKey(value) {
  const raw = stripFragment(String(value || "").trim());
  if (!raw) return "";
  const split = splitQuery(raw);
  const query = normalizeQueryString(split.query);
  const urlParts = split.path.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(.*)$/);
  if (urlParts) {
    const scheme = urlParts[1].toLowerCase();
    const host = urlParts[2].replace(/^www\./i, "").toLowerCase();
    const path = trimTrailingSlashes(urlParts[3] || "");
    return scheme + "://" + host + path + (query ? "?" + query : "");
  }
  return trimTrailingSlashes(split.path) + (query ? "?" + query : "");
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
    .filter(function (part) {
      return part;
    })
    .filter(function (part) {
      return !isTrackingQueryParam(part);
    })
    .sort()
    .join("&");
}

function isTrackingQueryParam(part) {
  const eqIndex = part.indexOf("=");
  const name = (eqIndex >= 0 ? part.slice(0, eqIndex) : part).toLowerCase();
  return (
    name.indexOf("utm_") === 0 ||
    name === "fbclid" ||
    name === "gclid" ||
    name === "dclid" ||
    name === "mc_cid" ||
    name === "mc_eid" ||
    name === "igshid"
  );
}

function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}

function sourceExtractionResultsToExtracts(results, selectedSources, config) {
  return results.map(function (result, index) {
    const source = selectedSources[index] || {};
    const output = result.structuredOutput;
    const claims = asArray(output.claims)
      .map(function (claim) {
        return {
          claim: nonEmptyString(claim.claim),
          quote: nonEmptyString(claim.quote),
          importance: normalizeEnum(
            claim.importance,
            ["central", "supporting", "tangential"],
            "supporting"
          ),
        };
      })
      .filter(function (claim) {
        return claim.claim && claim.quote;
      })
      .slice(0, config.maxClaimsPerSource);
    return {
      title: source.title || nonEmptyString(output.source) || "Untitled source",
      url: source.url || nonEmptyString(output.source),
      angle: source.angle || "unknown",
      relevance: source.relevance || "medium",
      sourceType: source.sourceType || "secondary",
      sourceQuality: normalizeEnum(
        output.sourceQuality,
        ["primary", "secondary", "blog", "forum", "unreliable"],
        "unreliable"
      ),
      publishDate: nonEmptyString(output.publishDate),
      summary: nonEmptyString(output.summary),
      claims: claims,
    };
  });
}

function extractsToClaims(sourceExtracts) {
  const claimsByKey = new Map();
  const claims = [];
  sourceExtracts.forEach(function (source) {
    source.claims.forEach(function (claim) {
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

function rankClaims(claims) {
  return claims.slice().sort(compareClaimsForRanking);
}

function compareClaimsForRanking(left, right) {
  const importanceRank = { central: 0, supporting: 1, tangential: 2 };
  const qualityRank = { primary: 0, secondary: 1, blog: 2, forum: 3, unreliable: 4 };
  return (
    importanceRank[left.importance] - importanceRank[right.importance] ||
    qualityRank[left.sourceQuality] - qualityRank[right.sourceQuality]
  );
}

function verificationSpecs(claims, config, agentId, readOnlyReasoningPrompt, refinedTopic) {
  const specs = [];
  claims.forEach(function (claim, claimIndex) {
    for (let vote = 0; vote < config.votesPerClaim; vote++) {
      specs.push({
        id: "verify-claim-" + claimIndex + "-vote-" + vote,
        title: "Verify claim " + (claimIndex + 1) + " vote " + (vote + 1),
        agentId: agentId,
        prompt:
          readOnlyReasoningPrompt +
          "Be skeptical and try to refute this claim. Default to refuted=true if the quote does not support the claim, if credible evidence contradicts it, if the source quality is too weak for the claim, or if the claim is stale/marketing/cherry-picked.\n\n" +
          "Topic: " +
          refinedTopic +
          "\nClaim: " +
          JSON.stringify(claim) +
          "\nVote: " +
          (vote + 1) +
          " of " +
          config.votesPerClaim +
          "\n\nReturn a specific verdict. Evidence must explain why the claim is supported or refuted. Structured output only.",
        outputSchema: verificationSchema(),
      });
    }
  });
  return specs;
}

function runParallelAgentBatches(specs, batchSize, parallelAgents) {
  const results = [];
  for (let index = 0; index < specs.length; index += batchSize) {
    const batch = specs.slice(index, index + batchSize);
    parallelAgents(batch).forEach(function (result) {
      results.push(result);
    });
  }
  return results;
}

function aggregateVotes(claims, voteResults, config) {
  return claims.map(function (claim, claimIndex) {
    const start = claimIndex * config.votesPerClaim;
    const votes = voteResults.slice(start, start + config.votesPerClaim).map(function (result) {
      const output = result.structuredOutput;
      const returnedClaim = nonEmptyString(output.claim);
      const claimMismatch = returnedClaim !== claim.claim;
      return {
        refuted: claimMismatch || output.refuted === true,
        confidence: normalizeEnum(output.confidence, ["high", "medium", "low"], "low"),
        evidence: claimMismatch
          ? "Verifier returned a mismatched claim identity: " + returnedClaim
          : nonEmptyString(output.evidence),
        counterSource: nonEmptyString(output.counterSource),
      };
    });
    const refutedVotes = votes.filter(function (vote) {
      return vote.refuted;
    }).length;
    const supportingVotes = votes.length - refutedVotes;
    const survives =
      votes.length >= config.refutationsRequired && refutedVotes < config.refutationsRequired;
    return Object.assign({}, claim, {
      votes: votes,
      vote: supportingVotes + "-" + refutedVotes,
      refutedVotes: refutedVotes,
      survives: survives,
    });
  });
}

function researchStats(
  config,
  angles,
  sourceCandidates,
  sourceSelection,
  sourceExtracts,
  allClaims,
  votedClaims,
  confirmedClaims
) {
  return {
    mode: config.mode,
    angles: angles.length,
    sourceCandidates: sourceCandidates.length,
    sourcesFetched: sourceExtracts.length,
    claimsExtracted: allClaims.length,
    claimsVerified: votedClaims.length,
    confirmed: confirmedClaims.length,
    killed: votedClaims.length - confirmedClaims.length,
    urlDupes: sourceSelection.duplicates.length,
    budgetDropped: sourceSelection.budgetDropped.length,
    votesPerClaim: config.votesPerClaim,
    agentCalls:
      1 +
      angles.length +
      sourceExtracts.length +
      votedClaims.length * config.votesPerClaim +
      (votedClaims.length > 0 ? 1 : 0),
  };
}

function emptyResearchOutput(topic, mode, gap) {
  return {
    topic: topic,
    refinedTopic: topic,
    mode: mode,
    questions: [],
    angles: [],
    sources: [],
    sourceExtracts: [],
    claims: [],
    verification: [],
    confirmedClaims: [],
    refutedClaims: [],
    confidence: "low",
    gaps: [gap],
    findings: [],
    stats: {
      mode: mode,
      angles: 0,
      sourceCandidates: 0,
      sourcesFetched: 0,
      claimsExtracted: 0,
      claimsVerified: 0,
      confirmed: 0,
      killed: 0,
      urlDupes: 0,
      budgetDropped: 0,
      votesPerClaim: mode === "quick" ? 1 : 3,
      agentCalls: 0,
    },
  };
}

function normalizeEnum(value, allowed, fallback) {
  return allowed.indexOf(value) >= 0 ? value : fallback;
}

function scopeSchema() {
  return {
    type: "object",
    required: ["refinedTopic", "strategy", "questions", "angles"],
    additionalProperties: false,
    properties: {
      refinedTopic: { type: "string" },
      strategy: { type: "string" },
      questions: { type: "array", items: { type: "string" } },
      angles: {
        type: "array",
        items: {
          type: "object",
          required: ["label", "query", "rationale"],
          additionalProperties: false,
          properties: {
            label: { type: "string" },
            query: { type: "string" },
            rationale: { type: "string" },
          },
        },
      },
    },
  };
}

function sourceDiscoverySchema() {
  return {
    type: "object",
    required: ["sources"],
    additionalProperties: false,
    properties: {
      sources: {
        type: "array",
        items: {
          type: "object",
          required: ["title", "url", "relevance", "sourceType"],
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            url: { type: "string" },
            relevance: { type: "string", enum: ["high", "medium", "low"] },
            sourceType: {
              type: "string",
              enum: ["primary", "secondary", "blog", "forum", "unreliable"],
            },
          },
        },
      },
    },
  };
}

function sourceExtractionSchema() {
  return {
    type: "object",
    required: ["source", "sourceQuality", "publishDate", "summary", "claims"],
    additionalProperties: false,
    properties: {
      source: { type: "string" },
      sourceQuality: {
        type: "string",
        enum: ["primary", "secondary", "blog", "forum", "unreliable"],
      },
      publishDate: { type: "string" },
      summary: { type: "string" },
      claims: {
        type: "array",
        items: {
          type: "object",
          required: ["claim", "quote", "importance"],
          additionalProperties: false,
          properties: {
            claim: { type: "string" },
            quote: { type: "string" },
            importance: { type: "string", enum: ["central", "supporting", "tangential"] },
          },
        },
      },
    },
  };
}

function verificationSchema() {
  return {
    type: "object",
    required: ["claim", "refuted", "confidence", "evidence", "counterSource"],
    additionalProperties: false,
    properties: {
      claim: { type: "string" },
      refuted: { type: "boolean" },
      confidence: { type: "string", enum: ["high", "medium", "low"] },
      evidence: { type: "string" },
      counterSource: { type: "string" },
    },
  };
}

function finalSynthesisSchema() {
  return {
    type: "object",
    required: ["confidence", "gaps", "findings"],
    additionalProperties: false,
    properties: {
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      gaps: { type: "array", items: { type: "string" } },
      findings: { type: "array", items: { type: "string" } },
    },
  };
}
