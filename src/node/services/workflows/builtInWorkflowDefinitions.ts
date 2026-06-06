import type { WorkflowName } from "@/common/types/workflow";

export interface BuiltInWorkflowDefinition {
  name: WorkflowName;
  description: string;
  source: string;
}

export const BUILT_IN_WORKFLOW_DEFINITIONS: readonly BuiltInWorkflowDefinition[] = [
  {
    name: "deep-research",
    description: "Coordinate delegated agents to research, verify, and synthesize a topic.",
    source: `export default function deepResearch({ args, phase, log, agent, parallelAgents }) {
  const maxFanOut = 16;
  const exploreAgentId = "explore";
  const reasoningAgentId = "exec";
  // Some users configure Explore with fast/cheap models; reserve Exec for reasoning-heavy synthesis.
  const readOnlyReasoningPrompt =
    "This is a read-only deep-research reasoning task. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect evidence only as needed and report findings.\\n\\n";
  const topic = normalizeDeepResearchTopic(args);

  phase("scope", { topic });
  const scope = agent({
    id: "scope-topic",
    title: "Scope research topic",
    agentId: exploreAgentId,
    prompt:
      "Refine this deep research topic into a focused investigation. Return concise research questions and the refined topic.\\n\\nTopic: " +
      topic,
    outputSchema: {
      type: "object",
      required: ["refinedTopic", "questions"],
      additionalProperties: false,
      properties: {
        refinedTopic: { type: "string" },
        questions: { type: "array", items: { type: "string" } },
      },
    },
  });
  const refinedTopic = scope.structuredOutput.refinedTopic || topic;
  log("Scoped deep research topic", { refinedTopic });

  phase("source-discovery", { refinedTopic });
  const sources = agent({
    id: "discover-sources",
    title: "Discover high-signal sources",
    agentId: exploreAgentId,
    prompt:
      "Find high-signal primary or directly relevant sources for this research topic. Prefer repo files, specs, primary docs, and concrete evidence over summaries. Return sources with title, url/path, and relevance.\\n\\nTopic: " +
      refinedTopic +
      "\\nQuestions: " +
      scope.structuredOutput.questions.join("; "),
    outputSchema: {
      type: "object",
      required: ["sources"],
      additionalProperties: false,
      properties: {
        sources: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "url", "relevance"],
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              url: { type: "string" },
              relevance: { type: "string" },
            },
          },
        },
      },
    },
  });
  const discoveredSources = sources.structuredOutput.sources.slice(0, maxFanOut);
  log("Discovered sources", { count: sources.structuredOutput.sources.length, selectedCount: discoveredSources.length });

  phase("source-synthesis", { sourceCount: discoveredSources.length });
  const sourceSummaries = discoveredSources.length > 0
    ? parallelAgents(
        discoveredSources.map(function (source, index) {
          return {
            id: "summarize-source-" + index,
            title: "Read and summarize source " + (index + 1),
            agentId: exploreAgentId,
            prompt:
              "Read or inspect this discovered source and summarize the evidence relevant to the research questions.\\n\\nTopic: " +
              refinedTopic +
              "\\nSource: " +
              JSON.stringify(source),
            outputSchema: {
              type: "object",
              required: ["source", "summary"],
              additionalProperties: false,
              properties: {
                source: { type: "string" },
                summary: { type: "string" },
              },
            },
          };
        })
      )
    : [];
  const summaries = { structuredOutput: { summaries: sourceSummaries.map(function (summary) { return summary.structuredOutput; }) } };

  phase("claim-extraction", { summaryCount: summaries.structuredOutput.summaries.length });
  const claims = agent({
    id: "extract-claims",
    title: "Extract claims and support",
    agentId: reasoningAgentId,
    prompt:
      readOnlyReasoningPrompt +
      "Extract the most important factual claims and supporting evidence from these source summaries. Return claims with support notes.\\n\\nTopic: " +
      refinedTopic +
      "\\nSummaries: " +
      JSON.stringify(summaries.structuredOutput.summaries),
    outputSchema: {
      type: "object",
      required: ["claims"],
      additionalProperties: false,
      properties: {
        claims: {
          type: "array",
          items: {
            type: "object",
            required: ["claim", "support"],
            additionalProperties: false,
            properties: {
              claim: { type: "string" },
              support: { type: "string" },
            },
          },
        },
      },
    },
  });

  const extractedClaims = claims.structuredOutput.claims.slice(0, maxFanOut);
  phase("adversarial-verification", { claimCount: extractedClaims.length });
  const verificationFindings = extractedClaims.length > 0
    ? parallelAgents(
        extractedClaims.map(function (claim, index) {
          return {
            id: "verify-claim-" + index,
            title: "Adversarially verify claim " + (index + 1),
            agentId: reasoningAgentId,
            prompt:
              readOnlyReasoningPrompt +
              "Challenge this claim. Look for contradictions, missing evidence, overreach, and lower-confidence areas. Return verdict and risk.\\n\\nTopic: " +
              refinedTopic +
              "\\nClaim: " +
              JSON.stringify(claim),
            outputSchema: {
              type: "object",
              required: ["claim", "verdict", "risk"],
              additionalProperties: false,
              properties: {
                claim: { type: "string" },
                verdict: { type: "string", enum: ["supported", "mixed", "refuted", "unclear"] },
                risk: { type: "string", enum: ["low", "medium", "high"] },
              },
            },
          };
        })
      )
    : [];
  const verification = { structuredOutput: { findings: verificationFindings.map(function (finding) { return finding.structuredOutput; }) } };
  log("Verified claims", { count: verification.structuredOutput.findings.length });

  phase("final-synthesis", { topic: refinedTopic });
  const final = agent({
    id: "synthesize-report",
    title: "Synthesize final deep research report",
    agentId: reasoningAgentId,
    prompt:
      readOnlyReasoningPrompt +
      "Write the final deep research report. Include key findings, citations/source references by title or path, uncertainty, and recommendations for follow-up. Return confidence and remaining gaps as structured output.\\n\\nTopic: " +
      refinedTopic +
      "\\nSources: " +
      JSON.stringify(discoveredSources) +
      "\\nClaims: " +
      JSON.stringify(extractedClaims) +
      "\\nVerification: " +
      JSON.stringify(verification.structuredOutput.findings),
    outputSchema: {
      type: "object",
      required: ["confidence", "gaps"],
      additionalProperties: false,
      properties: {
        confidence: { type: "string", enum: ["low", "medium", "high"] },
        gaps: { type: "array", items: { type: "string" } },
      },
    },
  });

  return {
    reportMarkdown: final.reportMarkdown,
    structuredOutput: {
      topic,
      refinedTopic,
      sources: discoveredSources,
      claims: extractedClaims,
      verification: verification.structuredOutput.findings,
      confidence: final.structuredOutput.confidence,
      gaps: final.structuredOutput.gaps,
    },
  };
}

function normalizeDeepResearchTopic(args) {
  if (typeof args === "string" && args.trim()) return args.trim();
  if (args && typeof args === "object") {
    if (typeof args.topic === "string" && args.topic.trim()) return args.topic.trim();
    if (typeof args.input === "string" && args.input.trim()) return args.input.trim();
    if (typeof args.query === "string" && args.query.trim()) return args.query.trim();
  }
  return JSON.stringify(args);
}
`,
  },
  // Keep the lightweight /deep-review skill; this workflow is the heavier structured path with
  // adversarial verification for review findings.
  {
    name: "deep-review-workflow",
    description:
      "Coordinate adversarial review agents to find, verify, and synthesize code review findings.",
    source: `export default function deepReviewWorkflow({ args, phase, log, agent, action, parallelAgents, applyPatch }) {
  const exploreAgentId = "explore";
  const reasoningAgentId = "exec";
  // Scope discovery stays on Explore; review judgment uses Exec for users with fast Explore defaults.
  const readOnlyReviewPrompt =
    "This is a read-only deep code review task. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report findings.\\n\\n";
  const input = normalizeDeepReviewArgs(args);
  if (input.loop && !input.fix) {
    throw new Error("--loop requires --fix for deep-review-workflow");
  }
  if (input.loop) {
    return runDeepReviewLoop({
      input: input,
      phase: phase,
      log: log,
      agent: agent,
      action: action,
      parallelAgents: parallelAgents,
      applyPatch: applyPatch,
      exploreAgentId: exploreAgentId,
      reasoningAgentId: reasoningAgentId,
      readOnlyReviewPrompt: readOnlyReviewPrompt,
    });
  }
  return runDeepReviewPass({
    input: input,
    phase: phase,
    log: log,
    agent: agent,
    action: action,
    parallelAgents: parallelAgents,
    applyPatch: applyPatch,
    exploreAgentId: exploreAgentId,
    reasoningAgentId: reasoningAgentId,
    readOnlyReviewPrompt: readOnlyReviewPrompt,
    stepSuffix: "",
    iteration: 0,
    skipFixWhenNoVerifiedIssues: false,
  }).reviewResult;
}

function runDeepReviewLoop(context) {
  const passes = [];
  let stopReason = "";
  let remainingFixBudget = context.input.maxFixes;
  let loopHeadRef = context.input.headRef;
  for (let iteration = 1; iteration <= context.input.maxLoopIterations; iteration += 1) {
    context.phase("loop-iteration", {
      iteration: iteration,
      maxIterations: context.input.maxLoopIterations,
      remainingFixBudget: remainingFixBudget,
    });
    const budgetExhaustedReadOnlyCheck = remainingFixBudget <= 0;
    const iterationInput = cloneDeepReviewInput(context.input);
    iterationInput.headRef = loopHeadRef;
    iterationInput.maxFixes = remainingFixBudget;
    if (budgetExhaustedReadOnlyCheck) iterationInput.fix = false;
    const pass = runDeepReviewPass({
      input: iterationInput,
      phase: context.phase,
      log: context.log,
      agent: context.agent,
      action: context.action,
      parallelAgents: context.parallelAgents,
      applyPatch: context.applyPatch,
      exploreAgentId: context.exploreAgentId,
      reasoningAgentId: context.reasoningAgentId,
      readOnlyReviewPrompt: context.readOnlyReviewPrompt,
      stepSuffix: "loop-" + iteration,
      iteration: iteration,
      skipFixWhenNoVerifiedIssues: true,
    });
    passes.push(pass.reviewResult);
    if (budgetExhaustedReadOnlyCheck) {
      stopReason = hasVerifiedIssues(pass.reviewResult.structuredOutput.final) ? "fix-budget-exhausted" : "no-verified-issues";
      return buildLoopResult(context.input, passes, stopReason, remainingFixBudget);
    }
    const fixProgress = reviewResultHasFixProgress(pass.reviewResult);
    remainingFixBudget = Math.max(0, remainingFixBudget - countSelectedFixes(pass.reviewResult));
    if (fixProgress) loopHeadRef = "";
    stopReason = getLoopStopReason(pass.reviewResult, remainingFixBudget);
    if (stopReason === "fix-budget-exhausted" && iteration < context.input.maxLoopIterations) continue;
    if (stopReason) {
      return buildLoopResult(context.input, passes, stopReason, remainingFixBudget);
    }
  }
  return buildLoopResult(context.input, passes, "max-iterations", remainingFixBudget);
}

function runDeepReviewPass(context) {
  const input = cloneDeepReviewInput(context.input);
  const gitContext = shouldCollectGitReviewContext(input) ? collectGitReviewContext(context.action, input, context.log, context.stepSuffix) : null;
  applyGitContextToReviewInput(input, gitContext);
  const maxCandidates = input.maxCandidates;

  context.phase("scope", withLoopIteration({
    target: input.target,
    fileCount: input.files.length,
    hasDiffSnapshot: input.diff.length > 0,
    hasGitSnapshot: input.gitSnapshot.length > 0,
  }, context.iteration));
  const scope = context.agent({
    id: workflowStepId("scope-review-surface", context.stepSuffix),
    title: "Scope review surface",
    agentId: context.exploreAgentId,
    prompt:
      "Scope this code review. Identify changed files, likely intent, touched layers, highest-risk areas, and which review lanes should run. Use repository evidence; do not assume the diff is complete if refs are provided.\\n\\n" +
      renderReviewInput(input),
    outputSchema: scopeSchema(),
  });

  const lanes = selectReviewLanes(scope.structuredOutput.lanes);
  context.log("Selected deep review lanes", withLoopIteration({ lanes: lanes }, context.iteration));

  context.phase("lane-review", withLoopIteration({ lanes: lanes }, context.iteration));
  const laneReviews = context.parallelAgents(
    lanes.map(function (lane) {
      return {
        id: workflowStepId("review-" + lane, context.stepSuffix),
        title: "Review lane: " + lane,
        agentId: context.reasoningAgentId,
        prompt:
          context.readOnlyReviewPrompt +
          lanePrompt(lane) +
          "\\n\\nReview target:\\n" +
          renderReviewInput(input) +
          "\\n\\nScoped review surface:\\n" +
          JSON.stringify(scope.structuredOutput, null, 2) +
          "\\n\\nReturn only concrete, actionable findings with file paths and evidence. Prefer an empty issues array over speculative feedback.",
        outputSchema: issueListSchema(),
      };
    })
  );
  const laneIssues = flatten(
    laneReviews.map(function (review) {
      return review.structuredOutput.issues || [];
    })
  );
  context.log("Lane review produced candidate issues", withLoopIteration({ count: laneIssues.length }, context.iteration));

  context.phase("triage-dedupe", withLoopIteration({ candidateCount: laneIssues.length }, context.iteration));
  const triage = context.agent({
    id: workflowStepId("triage-candidate-issues", context.stepSuffix),
    title: "Triage and dedupe review findings",
    agentId: context.reasoningAgentId,
    prompt:
      context.readOnlyReviewPrompt +
      "Deduplicate and triage these candidate code review findings. Merge duplicates, drop vague or non-actionable items, normalize severity, and preserve concrete evidence.\\n\\n" +
      "Review target:\\n" +
      renderReviewInput(input) +
      "\\n\\nCandidate issues:\\n" +
      JSON.stringify(laneIssues, null, 2),
    outputSchema: issueListSchema(),
  });
  const candidates = (triage.structuredOutput.issues || []).slice(0, maxCandidates);
  context.log("Triaged candidate issues", withLoopIteration({
    candidateCount: triage.structuredOutput.issues.length,
    selectedCount: candidates.length,
  }, context.iteration));

  context.phase("adversarial-verification", withLoopIteration({ candidateCount: candidates.length }, context.iteration));
  const verificationResults = candidates.length > 0
    ? context.parallelAgents(
        candidates.map(function (issue, index) {
          return {
            id: workflowStepId("verify-issue-" + index, context.stepSuffix),
            title: "Verify review finding " + (index + 1),
            agentId: context.reasoningAgentId,
            prompt:
              context.readOnlyReviewPrompt +
              "Adversarially verify this code review finding. Try to disprove it. Inspect relevant code paths and tests. Decide whether it is valid, duplicate, overstated, not reproducible, or needs more information.\\n\\n" +
              "Review target:\\n" +
              renderReviewInput(input) +
              "\\n\\nFinding:\\n" +
              JSON.stringify(issue, null, 2),
            outputSchema: verificationSchema(),
          };
        })
      )
    : [];
  const verifications = verificationResults.map(function (verification) {
    return verification.structuredOutput;
  });
  context.log("Verified candidate issues", withLoopIteration({ count: verifications.length }, context.iteration));

  context.phase("final-synthesis", withLoopIteration({
    candidateCount: candidates.length,
    verificationCount: verifications.length,
  }, context.iteration));
  const final = context.agent({
    id: workflowStepId("synthesize-review", context.stepSuffix),
    title: "Synthesize final deep review",
    agentId: context.reasoningAgentId,
    prompt:
      context.readOnlyReviewPrompt +
      "Write the final code review. Include only findings that remain actionable after adversarial verification. Use severity P0-P4, file paths, issue IDs, and concrete evidence. If there are no verified issues, say so clearly. Include questions and a validation plan. Set verifiedIssueIds to the issue IDs included in the final review when any are verified.\\n\\n" +
      "Scoped review surface:\\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\\n\\nTriaged issues:\\n" +
      JSON.stringify(candidates, null, 2) +
      "\\n\\nVerification results:\\n" +
      JSON.stringify(verifications, null, 2),
    outputSchema: finalSynthesisSchema(),
  });

  const reviewResult = {
    reportMarkdown: final.reportMarkdown,
    structuredOutput: {
      target: input.target,
      scope: scope.structuredOutput,
      laneIssues: laneIssues,
      triagedIssues: candidates,
      verification: verifications,
      final: final.structuredOutput,
    },
  };
  if (!input.fix) return { reviewResult: reviewResult, gitContext: gitContext };
  if (context.skipFixWhenNoVerifiedIssues && !hasVerifiedIssues(final.structuredOutput)) {
    return { reviewResult: reviewResult, gitContext: gitContext };
  }

  context.phase("fix-preflight", withLoopIteration({ requested: true }, context.iteration));
  const fixResult = runDeepReviewFix({
    input: input,
    action: context.action,
    log: context.log,
    agent: context.agent,
    parallelAgents: context.parallelAgents,
    applyPatch: context.applyPatch,
    candidates: candidates,
    verifications: verifications,
    final: final.structuredOutput,
    gitContext: gitContext,
    exploreAgentId: context.exploreAgentId,
    reasoningAgentId: context.reasoningAgentId,
    stepSuffix: context.stepSuffix,
  });
  reviewResult.structuredOutput.fix = fixResult;
  reviewResult.reportMarkdown = final.reportMarkdown + renderFixMarkdown(fixResult);
  return { reviewResult: reviewResult, gitContext: gitContext };
}

function cloneDeepReviewInput(input) {
  return {
    target: input.target,
    baseRef: input.baseRef,
    headRef: input.headRef,
    diff: input.diff,
    files: input.files.slice(),
    instructions: input.instructions,
    gitSnapshot: input.gitSnapshot,
    explicitDiff: input.explicitDiff,
    explicitFiles: input.explicitFiles,
    includeGitContext: input.includeGitContext,
    maxCandidates: input.maxCandidates,
    fix: input.fix,
    loop: input.loop,
    maxFixes: input.maxFixes,
    maxLoopIterations: input.maxLoopIterations,
    fixIssueIds: input.fixIssueIds.slice(),
  };
}

function workflowStepId(baseId, suffix) {
  return suffix ? baseId + "-" + suffix : baseId;
}

function withLoopIteration(details, iteration) {
  if (iteration) details.iteration = iteration;
  return details;
}

function hasVerifiedIssues(final) {
  if (!final) return false;
  if (typeof final.verifiedIssueCount === "number") return final.verifiedIssueCount > 0;
  return Array.isArray(final.verifiedIssueIds) && final.verifiedIssueIds.length > 0;
}

function reviewResultHasFixProgress(reviewResult) {
  const output = reviewResult && reviewResult.structuredOutput ? reviewResult.structuredOutput : {};
  const fix = output.fix;
  return Boolean(fix && fixHasProgress(fix));
}

function countSelectedFixes(reviewResult) {
  const output = reviewResult && reviewResult.structuredOutput ? reviewResult.structuredOutput : {};
  const fix = output.fix;
  return fix && Array.isArray(fix.selectedIssues) ? fix.selectedIssues.length : 0;
}

function getLoopStopReason(reviewResult, remainingFixBudget) {
  const output = reviewResult && reviewResult.structuredOutput ? reviewResult.structuredOutput : {};
  if (!hasVerifiedIssues(output.final)) return "no-verified-issues";
  const fix = output.fix;
  if (!fix) return "no-fix-attempted";
  if (fix.skippedReason) return "fix-skipped";
  if (!fix.selectedIssues || fix.selectedIssues.length === 0) return "no-fixable-issues";
  if (!fixHasProgress(fix)) return "no-fix-progress";
  const validationStatus = fix.validation ? fix.validation.status : "not-run";
  if (validationStatus === "failed") return "validation-failed";
  if (validationStatus !== "passed") return "validation-not-run";
  if (remainingFixBudget <= 0) return "fix-budget-exhausted";
  return "";
}

function fixHasProgress(fix) {
  return countStatus(fix.applications, "applied") > 0;
}

function buildLoopResult(input, passes, stopReason, remainingFixBudget) {
  const loop = {
    requested: true,
    completed: stopReason === "no-verified-issues",
    iterations: passes.length,
    maxIterations: input.maxLoopIterations,
    remainingFixBudget: remainingFixBudget,
    stopReason: stopReason,
  };
  const structuredOutput = {
    target: input.target,
    loop: loop,
    passes: passes.map(function (pass, index) {
      return {
        iteration: index + 1,
        result: pass.structuredOutput,
      };
    }),
  };
  if (passes.length > 0) {
    const latest = passes[passes.length - 1].structuredOutput;
    structuredOutput.latest = latest;
    structuredOutput.final = latest.final || null;
    if (latest.fix) structuredOutput.fix = latest.fix;
  }
  return {
    reportMarkdown: renderLoopMarkdown(passes, loop),
    structuredOutput: structuredOutput,
  };
}

function renderLoopMarkdown(passes, loop) {
  let markdown = "# Deep Review Loop\\n\\n";
  markdown += "- Iterations: " + loop.iterations + " / " + loop.maxIterations + "\\n";
  markdown += "- Stop reason: " + loop.stopReason + "\\n";
  markdown += "- Completed: " + (loop.completed ? "yes" : "no") + "\\n";
  for (let index = 0; index < passes.length; index += 1) {
    markdown += "\\n\\n---\\n\\n## Loop iteration " + (index + 1) + "\\n\\n";
    markdown += passes[index].reportMarkdown || "";
  }
  return markdown;
}

function runDeepReviewFix(context) {
  const input = context.input;
  const baseFix = {
    requested: true,
    selectedIssues: [],
    attempts: [],
    applications: [],
    resolutions: [],
    unresolved: [],
  };
  const preflight = collectFixPreflight(context.action, context.log, input, context.gitContext, context.stepSuffix);
  if (preflight.skippedReason) {
    baseFix.skippedReason = preflight.skippedReason;
    return baseFix;
  }
  let expectedHeadSha = preflight.expectedHeadSha;

  const selected = selectFixIssues(context.candidates, context.verifications, input, context.final);
  baseFix.selectedIssues = selected.map(function (item) {
    return summarizeFixIssue(item.issueId, item.issue);
  });
  context.log("Selected deep review fixes", {
    selectedCount: selected.length,
    skippedCount: context.candidates.length - selected.length,
  });
  if (selected.length === 0) return baseFix;

  const fixerResults = context.parallelAgents(
    selected.map(function (item, index) {
      return {
        id: workflowStepId("fix-issue-" + index, context.stepSuffix),
        title: "Fix verified review finding " + (index + 1),
        agentId: context.reasoningAgentId,
        prompt: buildFixPrompt(input, item),
        outputSchema: fixAttemptSchema(),
      };
    })
  );

  const integratedIssues = [];
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    const fixerResult = fixerResults[index];
    const attempt = summarizeFixAttempt(item.issueId, fixerResult);
    baseFix.attempts.push(attempt);
    const attemptOutput = fixerResult && fixerResult.structuredOutput ? fixerResult.structuredOutput : {};
    if (!matchesReportedIssueId(attemptOutput, item.issueId)) {
      baseFix.unresolved.push({ issueId: item.issueId, reason: issueIdMismatchReason("fixer", item.issueId, attemptOutput) });
      continue;
    }
    if (attemptOutput.status !== "fixed" || attemptOutput.commitCreated !== true) {
      if (attemptOutput.status !== "already-fixed") {
        baseFix.unresolved.push({ issueId: item.issueId, reason: attemptOutput.status || "not-fixed" });
      }
      continue;
    }

    const application = safeApplyPatch(context.applyPatch, workflowStepId("apply-fix-" + index, context.stepSuffix), fixerResult, expectedHeadSha);
    application.issueId = item.issueId;
    baseFix.applications.push(application);
    if (application.status === "applied") {
      expectedHeadSha = getAppliedHeadCommitSha(application) || expectedHeadSha;
      integratedIssues.push(item.issueId);
      continue;
    }
    if (application.status !== "conflict") {
      baseFix.unresolved.push({ issueId: item.issueId, reason: application.error || application.status });
      continue;
    }

    const resolver = context.agent({
      id: workflowStepId("resolve-fix-" + index + "-conflict", context.stepSuffix),
      title: "Resolve auto-fix conflict " + (index + 1),
      agentId: context.reasoningAgentId,
      prompt: buildResolverPrompt(input, item, fixerResult, application, integratedIssues),
      outputSchema: fixResolverSchema(),
    });
    const resolution = summarizeResolution(item.issueId, resolver);
    baseFix.resolutions.push(resolution);
    const resolutionOutput = resolver && resolver.structuredOutput ? resolver.structuredOutput : {};
    if (!matchesReportedIssueId(resolutionOutput, item.issueId)) {
      baseFix.unresolved.push({ issueId: item.issueId, reason: issueIdMismatchReason("resolver", item.issueId, resolutionOutput) });
      continue;
    }
    if (resolutionOutput.status === "already-resolved") {
      integratedIssues.push(item.issueId);
      continue;
    }
    if (resolutionOutput.status === "resolved" && resolutionOutput.commitCreated === true) {
      const resolvedApplication = safeApplyPatch(context.applyPatch, workflowStepId("apply-resolved-fix-" + index, context.stepSuffix), resolver, expectedHeadSha);
      resolvedApplication.issueId = item.issueId;
      resolution.applyStatus = resolvedApplication.status;
      baseFix.applications.push(resolvedApplication);
      if (resolvedApplication.status === "applied") {
        expectedHeadSha = getAppliedHeadCommitSha(resolvedApplication) || expectedHeadSha;
        integratedIssues.push(item.issueId);
      } else {
        baseFix.unresolved.push({ issueId: item.issueId, reason: resolvedApplication.error || resolvedApplication.status });
      }
    } else {
      baseFix.unresolved.push({ issueId: item.issueId, reason: resolutionOutput.status || "unresolved-conflict" });
    }
  }

  if (integratedIssues.length > 0) {
    const validation = context.agent({
      id: workflowStepId("validate-auto-fixes", context.stepSuffix),
      title: "Validate applied auto-fixes",
      agentId: context.exploreAgentId,
      prompt: buildValidationPrompt(input, context.final, baseFix),
      outputSchema: fixValidationSchema(),
    });
    baseFix.validation = validation.structuredOutput;
  }
  return baseFix;
}

function collectFixPreflight(action, log, input, gitContext, stepSuffix) {
  if (input.explicitDiff) return { skippedReason: "auto-fix requires a local current workspace target, not an explicit diff" };
  if (looksNonLocalTarget(input.target)) return { skippedReason: "auto-fix requires a local current workspace target" };
  let status = null;
  try {
    status = action.git.status({
      id: workflowStepId("fix-git-status", stepSuffix),
      input: { includeIgnored: false, head: input.headRef || "HEAD" },
      builtInOnly: true,
      cache: false,
    }).output;
  } catch (error) {
    const message = formatError(error);
    log("Git status unavailable for auto-fix preflight", { error: message });
    return { skippedReason: "auto-fix requires a fresh local Git status" };
  }
  if (!isObject(status)) return { skippedReason: "auto-fix requires a fresh local Git status" };
  if (!isCurrentReviewHead(input, status)) {
    return { skippedReason: "auto-fix requires the reviewed head ref to be the current checked-out branch" };
  }
  const reviewedSnapshot = getReviewedGitSnapshot(gitContext);
  if (!reviewedSnapshot) {
    return { skippedReason: "auto-fix requires a reviewed Git branch and HEAD snapshot" };
  }
  if (!matchesReviewedGitBranch(reviewedSnapshot, status)) {
    return { skippedReason: "auto-fix requires the current Git branch to match the reviewed snapshot" };
  }
  if (arrayLength(status.staged) > 0 || arrayLength(status.unstaged) > 0 || arrayLength(status.untracked) > 0) {
    return { skippedReason: "auto-fix requires a clean committed local worktree" };
  }
  return { status: status, expectedHeadSha: reviewedSnapshot.headSha };
}

function isCurrentReviewHead(input, status) {
  if (!input.headRef) return true;
  const headRef = String(input.headRef).trim();
  if (!headRef || headRef === "HEAD") return true;
  const branch = normalizedGitBranch(status.branch);
  const currentBranchRef = branch ? "refs/heads/" + branch : "";
  if (branch && (headRef === branch || headRef === currentBranchRef)) return true;
  const requestedHeadRef = typeof status.requestedHeadRef === "string" ? status.requestedHeadRef : "";
  if (requestedHeadRef.length > 0) return false;
  if (!isExplicitCommitShaRef(headRef)) return false;
  const headSha = typeof status.headSha === "string" ? status.headSha : "";
  const requestedHeadSha = typeof status.requestedHeadSha === "string" ? status.requestedHeadSha : "";
  return Boolean(headSha && requestedHeadSha && headSha === requestedHeadSha);
}

function isExplicitCommitShaRef(headRef) {
  return /^[0-9a-fA-F]{7,64}$/.test(headRef);
}

function getReviewedGitSnapshot(gitContext) {
  const reviewedStatus = gitContext && isObject(gitContext.status) ? gitContext.status : null;
  if (!reviewedStatus) return null;
  const branch = normalizedGitBranch(reviewedStatus.branch);
  const headSha = typeof reviewedStatus.headSha === "string" ? reviewedStatus.headSha : "";
  if (!branch || !headSha) return null;
  return { branch: branch, headSha: headSha };
}

function matchesReviewedGitBranch(reviewedSnapshot, status) {
  const currentBranch = normalizedGitBranch(status.branch);
  return currentBranch.length > 0 && currentBranch === reviewedSnapshot.branch;
}

function normalizedGitBranch(branch) {
  if (typeof branch !== "string") return "";
  const trimmed = branch.trim();
  if (!trimmed || trimmed === "HEAD (no branch)") return "";
  return trimmed;
}

function looksNonLocalTarget(target) {
  const text = String(target || "").toLowerCase();
  return text.indexOf("http://") !== -1 || text.indexOf("https://") !== -1 || /(^|\\s)(pr|pull request)\\s*#?\\d+/.test(text);
}

function selectFixIssues(candidates, verifications, input, final) {
  const selected = [];
  const allowedIds = input.fixIssueIds || [];
  const finalFilter = getFinalIssueFilter(final);
  if (finalFilter.kind === "none") return selected;
  for (let index = 0; index < candidates.length; index += 1) {
    const issue = candidates[index];
    const issueId = stableIssueId(issue, index);
    if (finalFilter.kind === "ids" && finalFilter.ids[issueId] !== true) continue;
    if (allowedIds.length > 0 && allowedIds.indexOf(issueId) === -1) continue;
    const verification = findVerificationForIssue(issue, issueId, index, verifications);
    if (!verification || verification.verdict !== "valid" || verification.confidence === "low") continue;
    selected.push({ issueId: issueId, issue: issue, verification: verification, index: index });
    if (selected.length >= input.maxFixes) break;
  }
  return selected;
}

function getFinalIssueFilter(final) {
  if (final && final.verifiedIssueCount === 0) return { kind: "none" };
  if (final && Array.isArray(final.verifiedIssueIds)) {
    const ids = sanitizeStringArray(final.verifiedIssueIds);
    if (ids.length === 0) return { kind: "none" };
    const map = {};
    for (const id of ids) map[id] = true;
    return { kind: "ids", ids: map };
  }
  return { kind: "none" };
}

function stableIssueId(issue, index) {
  return issue && typeof issue.id === "string" && issue.id.trim() ? issue.id.trim() : "triaged-" + index;
}

function findVerificationForIssue(issue, issueId, index, verifications) {
  for (const verification of verifications) {
    if (!hasNonEmptyIssueId(verification)) continue;
    if (verification.issueId === issueId) return verification;
    if (issue && typeof issue.id === "string" && verification.issueId === issue.id) return verification;
  }
  return null;
}

function hasNonEmptyIssueId(verification) {
  return verification && typeof verification.issueId === "string" && verification.issueId.trim().length > 0;
}

function matchesReportedIssueId(output, expectedIssueId) {
  return output && output.issueId === expectedIssueId;
}

function issueIdMismatchReason(source, expectedIssueId, output) {
  const reported = output && typeof output.issueId === "string" && output.issueId.length > 0 ? output.issueId : "<missing>";
  return source + " reported issueId " + reported + " for " + expectedIssueId;
}

function summarizeFixIssue(issueId, issue) {
  return {
    issueId: issueId,
    severity: issue && issue.severity ? issue.severity : "",
    title: issue && issue.title ? issue.title : "",
    filePaths: issue && Array.isArray(issue.filePaths) ? issue.filePaths : [],
  };
}

function summarizeFixAttempt(issueId, result) {
  const output = result && result.structuredOutput ? result.structuredOutput : {};
  return {
    issueId: issueId,
    taskId: result ? result.taskId : undefined,
    status: output.status || "unknown",
    summary: output.summary || "",
    validation: Array.isArray(output.validation) ? output.validation : [],
  };
}

function summarizeResolution(issueId, result) {
  const output = result && result.structuredOutput ? result.structuredOutput : {};
  return {
    issueId: issueId,
    resolverTaskId: result ? result.taskId : undefined,
    status: output.status || "unknown",
    summary: output.summary || "",
  };
}

function safeApplyPatch(applyPatch, id, source, expectedHeadSha) {
  try {
    const spec = { id: id, source: source, target: "parent", onConflict: "return" };
    if (expectedHeadSha) spec.expectedHeadSha = expectedHeadSha;
    const result = applyPatch(spec);
    return normalizePatchApplication(source, result);
  } catch (error) {
    return {
      sourceTaskId: source ? source.taskId : undefined,
      status: "failed",
      error: formatError(error),
    };
  }
}

function normalizePatchApplication(source, result) {
  const status = result && result.status ? result.status : result && result.success === true ? "applied" : "failed";
  return {
    sourceTaskId: source ? source.taskId : undefined,
    status: status,
    appliedCommits: result ? result.appliedCommits : undefined,
    headCommitSha: result ? result.headCommitSha : undefined,
    conflictPaths: result ? result.conflictPaths : undefined,
    failedPatchSubject: result ? result.failedPatchSubject : undefined,
    error: result ? result.error : undefined,
    projectResults: result ? result.projectResults : undefined,
  };
}

function getAppliedHeadCommitSha(application) {
  if (application && typeof application.headCommitSha === "string" && application.headCommitSha.length > 0) {
    return application.headCommitSha;
  }
  const projectResults = application && Array.isArray(application.projectResults) ? application.projectResults : [];
  for (let index = projectResults.length - 1; index >= 0; index -= 1) {
    const projectResult = projectResults[index];
    if (projectResult && typeof projectResult.headCommitSha === "string" && projectResult.headCommitSha.length > 0) {
      return projectResult.headCommitSha;
    }
  }
  return "";
}

function buildFixPrompt(input, item) {
  return "Fix exactly one verified deep-review finding. Make minimal code changes, add or update behavioral tests when appropriate, run targeted validation when practical, and create one or more git commits before reporting if code changed. If already fixed, not fixable, or more information is needed, report that status instead of inventing a patch. Do not push, open PRs, or perform unrelated cleanup.\\n\\n" +
    "Review target:\\n" + renderReviewInput(input) +
    "\\n\\nIssue ID: " + item.issueId +
    "\\nFinding:\\n" + JSON.stringify(item.issue, null, 2) +
    "\\n\\nVerification:\\n" + JSON.stringify(item.verification, null, 2);
}

function buildResolverPrompt(input, item, fixerResult, application, integratedIssues) {
  return "Resolve the git-am conflict for one auto-fix patch. Preserve the original issue intent and avoid unrelated changes. Replay the original patch with task_apply_git_patch in your workspace using dry_run false, resolve conflicts, git add, git am --continue, and commit follow-up resolved changes if needed. If earlier fixes already solved the issue, report already-resolved without inventing changes. Do not push or open PRs.\\n\\n" +
    "Review target:\\n" + renderReviewInput(input) +
    "\\n\\nIssue:\\n" + JSON.stringify(item.issue, null, 2) +
    "\\n\\nVerification:\\n" + JSON.stringify(item.verification, null, 2) +
    "\\n\\nFailing fixer task ID: " + (fixerResult ? fixerResult.taskId : "unknown") +
    "\\nApply conflict:\\n" + JSON.stringify(application, null, 2) +
    "\\nAlready integrated issue IDs:\\n" + JSON.stringify(integratedIssues, null, 2);
}

function buildValidationPrompt(input, final, fixResult) {
  return "Validate the auto-fixes now integrated in the parent workspace. Run the review validation plan and targeted tests/checks relevant to applied fixes. Do not edit files, create commits, apply patches, push, or open PRs. Report pass, fail, or not-run with commands and key failures.\\n\\n" +
    "Review target:\\n" + renderReviewInput(input) +
    "\\n\\nReview validation plan:\\n" + JSON.stringify(final.validationPlan || [], null, 2) +
    "\\n\\nAuto-fix result so far:\\n" + JSON.stringify(fixResult, null, 2);
}

function renderFixMarkdown(fix) {
  const appliedCount = countStatus(fix.applications, "applied") + countStatus(fix.attempts, "already-fixed") + countStatus(fix.resolutions, "already-resolved");
  const conflictResolvedCount = countResolvedConflicts(fix.resolutions);
  const validationStatus = fix.validation ? fix.validation.status : "not-run";
  let markdown = "\\n\\n---\\n\\n## Auto-fix results\\n\\n";
  if (fix.skippedReason) {
    markdown += "- Skipped: " + fix.skippedReason + "\\n";
    return markdown;
  }
  markdown += "- Selected: " + fix.selectedIssues.length + " verified findings\\n";
  markdown += "- Fixed/applied: " + appliedCount + "\\n";
  markdown += "- Already fixed/resolved: " + (countStatus(fix.attempts, "already-fixed") + countStatus(fix.resolutions, "already-resolved")) + "\\n";
  markdown += "- Not fixed: " + fix.unresolved.length + "\\n";
  markdown += "- Conflicts resolved: " + conflictResolvedCount + "\\n";
  markdown += "- Validation: " + validationStatus + "\\n";
  markdown += renderFixFailureDetails(fix);
  return markdown;
}

function countResolvedConflicts(resolutions) {
  let count = 0;
  for (const resolution of resolutions || []) {
    if (!resolution) continue;
    if (resolution.status === "already-resolved") count += 1;
    else if (resolution.status === "resolved" && resolution.applyStatus === "applied") count += 1;
  }
  return count;
}

function renderFixFailureDetails(fix) {
  let markdown = "";
  if (fix.unresolved && fix.unresolved.length > 0) {
    markdown += "\\nUnresolved issues:\\n";
    for (const unresolved of fix.unresolved) {
      markdown += "- " + renderFixIssueLabel(fix, unresolved.issueId) + ": " + unresolved.reason + "\\n";
    }
  }
  const failedApplications = (fix.applications || []).filter(function (application) {
    return application && application.status !== "applied";
  });
  if (failedApplications.length > 0) {
    markdown += "\\nPatch application details:\\n";
    for (const application of failedApplications) {
      const details = renderPatchApplicationDetails(application);
      markdown += "- " + renderFixIssueLabel(fix, application.issueId) + ": " + application.status + (details ? " — " + details : "") + "\\n";
    }
  }
  if (fix.validation && Array.isArray(fix.validation.failures) && fix.validation.failures.length > 0) {
    markdown += "\\nValidation failures:\\n";
    for (const failure of fix.validation.failures) {
      markdown += "- " + failure + "\\n";
    }
  }
  return markdown;
}

function renderPatchApplicationDetails(application) {
  const details = [];
  if (application.conflictPaths && application.conflictPaths.length > 0) details.push("conflicts: " + application.conflictPaths.join(", "));
  if (application.failedPatchSubject) details.push("failed patch: " + application.failedPatchSubject);
  if (application.error) details.push(application.error);
  return details.join("; ");
}

function renderFixIssueLabel(fix, issueId) {
  for (const issue of fix.selectedIssues || []) {
    if (issue && issue.issueId === issueId && issue.title) return issueId + " (" + issue.title + ")";
  }
  return issueId;
}

function countStatus(items, status) {
  let count = 0;
  for (const item of items || []) {
    if (item && item.status === status) count += 1;
  }
  return count;
}

function fixAttemptSchema() {
  return {
    type: "object",
    required: ["issueId", "status", "summary", "validation", "commitCreated"],
    additionalProperties: false,
    properties: {
      issueId: { type: "string" },
      status: { type: "string", enum: ["fixed", "already-fixed", "not-fixable", "needs-info"] },
      summary: { type: "string" },
      validation: { type: "array", items: { type: "string" } },
      commitCreated: { type: "boolean" },
    },
  };
}

function fixResolverSchema() {
  return {
    type: "object",
    required: ["issueId", "status", "summary", "validation", "commitCreated"],
    additionalProperties: false,
    properties: {
      issueId: { type: "string" },
      status: { type: "string", enum: ["resolved", "already-resolved", "unresolved"] },
      summary: { type: "string" },
      validation: { type: "array", items: { type: "string" } },
      commitCreated: { type: "boolean" },
    },
  };
}

function fixValidationSchema() {
  return {
    type: "object",
    required: ["status", "commands", "summary", "failures"],
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["passed", "failed", "not-run"] },
      commands: { type: "array", items: { type: "string" } },
      summary: { type: "string" },
      failures: { type: "array", items: { type: "string" } },
    },
  };
}

function normalizeDeepReviewArgs(args) {
  const normalized = {
    target: "current workspace changes",
    baseRef: "",
    headRef: "",
    diff: "",
    files: [],
    instructions: "",
    gitSnapshot: "",
    explicitDiff: false,
    explicitFiles: false,
    includeGitContext: false,
    maxCandidates: 12,
    fix: false,
    loop: false,
    maxFixes: 5,
    maxLoopIterations: 5,
    fixIssueIds: [],
  };

  if (typeof args === "string" && args.trim()) {
    applyFixFlags(normalized, args.trim());
    return normalized;
  }

  if (!args || typeof args !== "object") {
    return normalized;
  }

  let textualTarget = "";
  if (typeof args.target === "string" && args.target.trim()) textualTarget = args.target.trim();
  else if (typeof args.input === "string" && args.input.trim()) textualTarget = args.input.trim();
  else if (typeof args.pr === "string" && args.pr.trim()) textualTarget = args.pr.trim();
  else if (typeof args.branch === "string" && args.branch.trim()) textualTarget = args.branch.trim();
  if (textualTarget) applyFixFlags(normalized, textualTarget);

  if (typeof args.baseRef === "string") normalized.baseRef = args.baseRef.trim();
  else if (typeof args.base === "string") normalized.baseRef = args.base.trim();

  if (typeof args.headRef === "string") normalized.headRef = args.headRef.trim();
  else if (typeof args.head === "string") normalized.headRef = args.head.trim();

  if (typeof args.diff === "string" && args.diff.trim().length > 0) {
    normalized.diff = args.diff;
    normalized.explicitDiff = true;
  }
  if (typeof args.instructions === "string") normalized.instructions = args.instructions.trim();
  else if (typeof args.notes === "string") normalized.instructions = args.notes.trim();

  if (Array.isArray(args.files)) {
    normalized.files = args.files.filter(function (file) {
      return typeof file === "string" && file.trim().length > 0;
    }).map(function (file) {
      return file.trim();
    });
    normalized.explicitFiles = normalized.files.length > 0;
  }

  if (typeof args.includeGitContext === "boolean") {
    normalized.includeGitContext = args.includeGitContext;
  }

  if (typeof args.maxCandidates === "number" && args.maxCandidates > 0) {
    normalized.maxCandidates = Math.min(20, Math.max(1, Math.floor(args.maxCandidates)));
  }

  if (typeof args.maxFixes === "number" && args.maxFixes > 0) {
    normalized.maxFixes = Math.min(20, Math.max(1, Math.floor(args.maxFixes)));
  }
  if (typeof args.maxLoopIterations === "number" && args.maxLoopIterations > 0) {
    normalized.maxLoopIterations = Math.min(10, Math.max(1, Math.floor(args.maxLoopIterations)));
  }
  if (Array.isArray(args.fixIssueIds)) {
    normalized.fixIssueIds = sanitizeStringArray(args.fixIssueIds);
  }
  if (typeof args.fix === "boolean") {
    normalized.fix = args.fix;
  }
  if (typeof args.loop === "boolean") {
    normalized.loop = args.loop;
  }

  return normalized;
}

function applyFixFlags(normalized, text) {
  const parsed = parseTrailingFixFlags(text);
  for (const flag of parsed.flags) {
    if (flag === "--fix") normalized.fix = true;
    else if (flag === "--no-fix") normalized.fix = false;
    else if (flag === "--loop") normalized.loop = true;
    else if (flag === "--no-loop") normalized.loop = false;
  }
  const target = parsed.target.trim().split(/ +/).join(" ");
  if (target) normalized.target = target;
}

function parseTrailingFixFlags(text) {
  const parts = String(text || "").trim().split(/ +/).filter(Boolean);
  const flags = [];
  while (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last !== "--fix" && last !== "--no-fix" && last !== "--loop" && last !== "--no-loop") break;
    flags.unshift(last);
    parts.pop();
  }
  return { target: parts.join(" "), flags: flags };
}

function sanitizeStringArray(values) {
  const result = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && result.indexOf(trimmed) === -1) result.push(trimmed);
  }
  return result;
}

function shouldCollectGitReviewContext(input) {
  return input.includeGitContext || (!input.explicitFiles && !input.explicitDiff);
}

function collectGitReviewContext(action, input, log, stepSuffix) {
  const gitInput = buildGitActionInput(input);
  const failures = [];
  const builtInOnly = true;
  const status = tryGitAction(log, failures, "git.status", function () {
    return action.git.status({
      id: workflowStepId("git-status", stepSuffix),
      input: { includeIgnored: false },
      builtInOnly,
    }).output;
  });
  const changedFiles = tryGitAction(log, failures, "git.changedFiles", function () {
    return action.git.changedFiles({
      id: workflowStepId("git-changed-files", stepSuffix),
      input: gitInput,
      builtInOnly,
    }).output;
  });
  const diffStat = tryGitAction(log, failures, "git.diffStat", function () {
    return action.git.diffStat({
      id: workflowStepId("git-diff-stat", stepSuffix),
      input: gitInput,
      builtInOnly,
    }).output;
  });
  const diff = tryGitAction(log, failures, "git.diff", function () {
    return action.git.diff({
      id: workflowStepId("git-diff", stepSuffix),
      input: gitInput,
      builtInOnly,
    }).output;
  });
  const commits = tryGitAction(log, failures, "git.commitsBetween", function () {
    const commitsInput = copyGitActionInput(gitInput);
    commitsInput.limit = 20;
    return action.git.commitsBetween({
      id: workflowStepId("git-commits-between", stepSuffix),
      input: commitsInput,
      builtInOnly,
    }).output;
  });
  const context = {
    status: isObject(status) ? status : null,
    changedFiles: isObject(changedFiles) ? changedFiles : null,
    diffStat: isObject(diffStat) ? diffStat : null,
    diff: isObject(diff) ? diff : null,
    commits: isObject(commits) ? commits : null,
    failures: failures,
    explicitRefs: Boolean(input.baseRef || input.headRef),
  };
  if (!hasAnyGitContext(context)) {
    log("Git workflow actions unavailable; continuing with caller-provided review context", {
      failures: failures,
    });
    return null;
  }
  const files = collectGitFiles(context);
  log("Captured Git review context", {
    branch: context.status ? context.status.branch : "unknown",
    fileCount: files.length,
    hasDiff:
      context.diff != null &&
      (hasText(context.diff.branch) || hasText(context.diff.staged) || hasText(context.diff.unstaged)),
    failureCount: failures.length,
  });
  return context;
}

function tryGitAction(log, failures, name, fn) {
  try {
    return fn();
  } catch (error) {
    const failure = { action: name, error: formatError(error) };
    failures.push(failure);
    log("Git workflow action failed; continuing with partial review context", failure);
    return null;
  }
}

function hasAnyGitContext(gitContext) {
  return Boolean(
    gitContext.status ||
      gitContext.changedFiles ||
      gitContext.diffStat ||
      gitContext.diff ||
      gitContext.commits
  );
}

function hasResolvedBranchContext(gitContext) {
  return Boolean(
    hasResolvedGitRefContext(gitContext.changedFiles) ||
      hasResolvedGitRefContext(gitContext.diffStat) ||
      hasResolvedGitRefContext(gitContext.diff) ||
      hasResolvedGitRefContext(gitContext.commits)
  );
}

function hasResolvedGitRefContext(value) {
  return isObject(value) && hasText(value.base) && hasText(value.head) && hasText(value.mergeBase);
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function buildGitActionInput(input) {
  const gitInput = {};
  if (input.baseRef) gitInput.base = input.baseRef;
  if (input.headRef) gitInput.head = input.headRef;
  return gitInput;
}

function copyGitActionInput(input) {
  const copy = {};
  if (input.base) copy.base = input.base;
  if (input.head) copy.head = input.head;
  return copy;
}

function applyGitContextToReviewInput(input, gitContext) {
  if (gitContext == null) return;
  if ((input.explicitFiles || input.explicitDiff) && !input.includeGitContext) return;
  if (!input.explicitFiles) {
    const files = collectGitFiles(gitContext);
    if (files.length > 0) input.files = files;
  }
  if (!input.explicitDiff && gitContext.diff != null) {
    const diff = renderGitDiff(gitContext.diff);
    if (diff.length > 0) input.diff = truncateText(diff, 60000);
  }
  input.gitSnapshot = truncateText(renderGitSnapshot(gitContext), 20000);
}

function collectGitFiles(gitContext) {
  const files = [];
  if (gitContext == null) return files;
  if (gitContext.changedFiles != null) {
    addFileEntries(files, gitContext.changedFiles.branch);
    addFileEntries(files, gitContext.changedFiles.staged);
    addFileEntries(files, gitContext.changedFiles.unstaged);
    addFilePaths(files, gitContext.changedFiles.untracked);
  }
  if (gitContext.status != null) {
    addFileEntries(files, gitContext.status.staged);
    addFileEntries(files, gitContext.status.unstaged);
    addFilePaths(files, gitContext.status.untracked);
  }
  return files;
}

function addFileEntries(files, entries) {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (entry && typeof entry === "object") {
      addFilePath(files, entry.path);
      addFilePath(files, entry.oldPath);
    }
  }
}

function addFilePaths(files, paths) {
  if (!Array.isArray(paths)) return;
  for (const path of paths) {
    addFilePath(files, path);
  }
}

function addFilePath(files, path) {
  if (typeof path !== "string") return;
  const trimmed = path.trim();
  if (trimmed.length === 0 || files.indexOf(trimmed) !== -1) return;
  files.push(trimmed);
}

function renderGitSnapshot(gitContext) {
  const sections = [];
  if (gitContext.status != null) {
    const status = gitContext.status;
    sections.push(
      "Repository status: branch " +
        valueOrUnknown(status.branch) +
        (status.upstream ? " tracking " + status.upstream : "") +
        "; staged " +
        arrayLength(status.staged) +
        "; unstaged " +
        arrayLength(status.unstaged) +
        "; untracked " +
        arrayLength(status.untracked)
    );
  }
  if (gitContext.explicitRefs && !hasResolvedBranchContext(gitContext)) {
    sections.push(
      "WARNING: Requested base/head refs could not be resolved for automatic branch diff and commit capture; Git context may include only repository status or working-tree changes."
    );
  }
  if (Array.isArray(gitContext.failures) && gitContext.failures.length > 0) {
    sections.push(
      "Git context warnings:\\n" +
        gitContext.failures.map(function (failure) {
          return "- " + valueOrUnknown(failure.action) + ": " + valueOrUnknown(failure.error);
        }).join("\\n")
    );
  }
  const files = collectGitFiles(gitContext);
  if (files.length > 0) {
    sections.push("Changed files from parent workspace Git snapshot: " + files.join(", "));
  }
  if (gitContext.commits != null && Array.isArray(gitContext.commits.commits)) {
    const commits = gitContext.commits.commits;
    if (commits.length > 0) {
      sections.push(
        "Commits since " +
          valueOrUnknown(gitContext.commits.base) +
          ":\\n" +
          commits.map(function (commit) {
            return "- " + valueOrUnknown(commit.shortHash) + " " + valueOrUnknown(commit.subject);
          }).join("\\n")
      );
    }
  }
  if (gitContext.diffStat != null) {
    const statSections = [];
    if (hasText(gitContext.diffStat.branch)) statSections.push("Branch diff stat:\\n" + gitContext.diffStat.branch);
    if (hasText(gitContext.diffStat.staged)) statSections.push("Staged diff stat:\\n" + gitContext.diffStat.staged);
    if (hasText(gitContext.diffStat.unstaged)) statSections.push("Unstaged diff stat:\\n" + gitContext.diffStat.unstaged);
    if (statSections.length > 0) sections.push(statSections.join("\\n\\n"));
  }
  if (gitContext.status != null && arrayLength(gitContext.status.untracked) > 0) {
    sections.push(
      "Untracked file contents are not included in the automatic diff snapshot; review agents only receive their paths unless the caller supplied args.diff."
    );
  }
  if (gitContext.diff != null && isDiffTruncated(gitContext.diff)) {
    sections.push("One or more automatic diff sections were truncated by workflow action output limits.");
  }
  return sections.join("\\n\\n");
}

function renderGitDiff(diff) {
  const parts = [];
  if (hasText(diff.branch)) {
    parts.push("Branch diff (" + valueOrUnknown(diff.base) + ".." + valueOrUnknown(diff.head) + ")\\n" + diff.branch);
  }
  if (hasText(diff.staged)) {
    parts.push("Staged diff\\n" + diff.staged);
  }
  if (hasText(diff.unstaged)) {
    parts.push("Unstaged diff\\n" + diff.unstaged);
  }
  if (isDiffTruncated(diff)) {
    parts.push("NOTE: one or more diff sections were truncated by workflow action output limits.");
  }
  return parts.join("\\n\\n");
}

function isDiffTruncated(diff) {
  return Boolean(
    diff &&
      diff.truncated &&
      (diff.truncated.branch || diff.truncated.staged || diff.truncated.unstaged)
  );
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\\n[truncated by deep-review-workflow after " + maxLength + " characters]";
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function valueOrUnknown(value) {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

function formatError(error) {
  return error && typeof error.message === "string" ? error.message : String(error);
}

function renderReviewInput(input) {
  return [
    "Target: " + input.target,
    input.baseRef ? "Base ref: " + input.baseRef : "",
    input.headRef ? "Head ref: " + input.headRef : "",
    input.files.length > 0 ? "Files: " + input.files.join(", ") : "",
    input.gitSnapshot ? "Git snapshot:\\n" + input.gitSnapshot : "",
    input.instructions ? "Reviewer instructions: " + input.instructions : "",
    input.diff ? "Diff snapshot:\\n~~~diff\\n" + input.diff + "\\n~~~" : "",
  ].filter(Boolean).join("\\n");
}

function selectReviewLanes(lanes) {
  const defaults = ["correctness", "tests", "architecture"];
  const allowed = {
    correctness: true,
    tests: true,
    architecture: true,
    "security-reliability": true,
    "ux-a11y": true,
    "docs-dx": true,
  };
  const requested = Array.isArray(lanes) && lanes.length > 0 ? lanes : defaults;
  const result = [];
  for (const lane of requested) {
    if (allowed[lane] && result.indexOf(lane) === -1) {
      result.push(lane);
    }
  }
  for (const fallback of defaults) {
    if (result.indexOf(fallback) === -1) {
      result.push(fallback);
    }
  }
  return result.slice(0, 6);
}

function lanePrompt(lane) {
  const prompts = {
    correctness: "Review for logic bugs, edge cases, races, state-machine violations, and broken invariants.",
    tests: "Review test coverage, determinism, missing regression tests, and validation commands.",
    architecture: "Review consistency with existing architecture, boundaries, naming, abstractions, and maintainability.",
    "security-reliability": "Review security, trust boundaries, path traversal, injection, data corruption, reliability, and performance risks.",
    "ux-a11y": "Review user-facing behavior, accessibility, keyboard flow, visual consistency, and empty/loading/error states.",
    "docs-dx": "Review documentation, developer experience, scripts, public API clarity, and migration concerns.",
  };
  return prompts[lane] || prompts.correctness;
}

function issueListSchema() {
  return {
    type: "object",
    required: ["issues"],
    additionalProperties: false,
    properties: {
      issues: {
        type: "array",
        items: issueSchema(),
      },
    },
  };
}

function issueSchema() {
  return {
    type: "object",
    required: ["id", "severity", "category", "title", "rationale", "evidence", "filePaths", "confidence"],
    additionalProperties: false,
    properties: {
      id: { type: "string" },
      severity: { type: "string", enum: ["P0", "P1", "P2", "P3", "P4"] },
      category: { type: "string" },
      title: { type: "string" },
      rationale: { type: "string" },
      evidence: { type: "string" },
      filePaths: { type: "array", items: { type: "string" } },
      suggestedFix: { type: "string" },
      validation: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
  };
}

function scopeSchema() {
  return {
    type: "object",
    required: ["summary", "files", "riskAreas", "lanes"],
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      files: { type: "array", items: { type: "string" } },
      riskAreas: { type: "array", items: { type: "string" } },
      lanes: {
        type: "array",
        items: {
          type: "string",
          enum: ["correctness", "tests", "architecture", "security-reliability", "ux-a11y", "docs-dx"],
        },
      },
    },
  };
}

function verificationSchema() {
  return {
    type: "object",
    required: ["issueId", "verdict", "confidence", "rationale"],
    additionalProperties: false,
    properties: {
      issueId: { type: "string" },
      verdict: { type: "string", enum: ["valid", "duplicate", "overstated", "not-repro", "needs-info"] },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
      rationale: { type: "string" },
      evidence: { type: "string" },
      suggestedSeverity: { type: "string", enum: ["P0", "P1", "P2", "P3", "P4"] },
    },
  };
}

function finalSynthesisSchema() {
  return {
    type: "object",
    required: ["verifiedIssueCount", "verifiedIssueIds", "risk", "validationPlan"],
    additionalProperties: false,
    properties: {
      verifiedIssueCount: { type: "number" },
      risk: { type: "string", enum: ["low", "medium", "high"] },
      validationPlan: { type: "array", items: { type: "string" } },
      verifiedIssueIds: { type: "array", items: { type: "string" } },
      discardedIssueCount: { type: "number" },
    },
  };
}

function flatten(arrays) {
  const out = [];
  for (const array of arrays) {
    for (const item of array) {
      out.push(item);
    }
  }
  return out;
}
`,
  },
];
