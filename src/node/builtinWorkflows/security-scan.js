const s = mux.schema;

export const metadata = {
  description:
    "Audit a repository for security risk using sub-agent collected state, verification, and persisted evidence.",
  argsSchema: s.object({
    input: s.optional(s.string()),
    target: s.optional(s.string({ positional: true })),
    changedOnly: s.optional(s.boolean({ default: false, aliases: ["--changed-only"] })),
    full: s.optional(s.boolean({ default: false, aliases: ["--full"] })),
    verify: s.optional(
      s.boolean({ default: true, aliases: ["--verify"], negatedAliases: ["--no-verify"] })
    ),
    fix: s.optional(
      s.boolean({ default: false, aliases: ["--fix"], negatedAliases: ["--no-fix"] })
    ),
    maxFindings: s.optional(
      s.integer({ default: 20, minimum: 1, maximum: 1000, aliases: ["--max-findings"] })
    ),
    maxFixes: s.optional(
      s.integer({ default: 3, minimum: 1, maximum: 1000, aliases: ["--max-fixes"] })
    ),
    fixFindingIds: s.optional(s.array(s.string())),
    finding: s.optional(s.string({ aliases: ["--finding"] })),
    findingId: s.optional(s.string({ aliases: ["--finding-id"] })),
    runDirId: s.optional(s.string({ aliases: ["--run-dir"] })),
  }),
};

// Security state, Git context, file hashes, and finding matches are collected
// by explicit sub-agent calls with structured outputs. Mutating security state
// is written in an exec child workspace and applied through the patch boundary.
const SCHEMA = s;
const WORKFLOW_UTILS = mux.utils;
const EXPLORE_AGENT_ID = "explore";
const EXEC_AGENT_ID = "exec";
const MAX_PARALLEL_AGENTS = 12;
const READ_ONLY_SECURITY_PROMPT =
  "This security scan phase is read-only. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report concrete security findings.\n\n";
const SECURITY_LANES = [
  "secrets",
  "injection",
  "authz",
  "filesystem",
  "network",
  "sandbox",
  "supply-chain",
];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const PROOF_STATES = [
  "verified",
  "static_evidence",
  "unverified",
  "inconclusive",
  "needs_human_review",
];

export default async function securityScanWorkflow({ args, phase, log, agent }) {
  const input = normalizeSecurityScanArgs(args);

  phase("state-and-git-context", {
    target: input.target,
    changedOnly: input.changedOnly,
    full: input.full,
  });
  const stateContext = collectSecurityStateAgent(agent, input);
  log("Loaded security state and Git context via sub-agent", {
    findingCount: WORKFLOW_UTILS.asArray(stateContext.cachedFindings).length,
    diagnostics: WORKFLOW_UTILS.asArray(stateContext.diagnostics).length,
  });

  phase("scope", { target: input.target });
  const scope = agent({
    id: "scope-security-surface",
    title: "Scope security surface",
    agentId: EXPLORE_AGENT_ID,
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Scope this repository for a security scan. Identify app type, entrypoints, trust boundaries, sensitive assets, privileged operations, persistence, secrets, subprocess/tool execution, IPC/API surfaces, CI/deploy surfaces, relevant files, and recommended scan lanes. Prefer repository evidence over assumptions.\n\n" +
      renderSecurityInput(input, stateContext),
    outputSchema: securityScopeSchema(),
  });

  phase("hash-scope-files", {
    fileCount: WORKFLOW_UTILS.asArray(scope.structuredOutput.files).length,
  });
  const fileHashes = hashFilesAgent(agent, scope.structuredOutput);

  phase("threat-model", { fileCount: WORKFLOW_UTILS.asArray(scope.structuredOutput.files).length });
  const threatModelDraft = agent({
    id: "draft-threat-model",
    title: "Draft security threat model",
    agentId: EXEC_AGENT_ID,
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Draft a security threat model from the scoped repository evidence. Return markdown plus an index of covered sections. Do not write files in this step.\n\n" +
      "Scope:\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\n\nGit/state context:\n" +
      renderSecurityInput(input, stateContext) +
      "\n\nFile hashes:\n" +
      JSON.stringify(fileHashes, null, 2),
    outputSchema: threatModelSchema(),
  });

  const lanes = selectSecurityLanes(scope.structuredOutput && scope.structuredOutput.lanes);
  phase("lane-discovery", { lanes });
  const laneReviews = mux.parallelMap({
    items: lanes,
    stepId: function (lane) {
      return "discover-" + lane;
    },
    title: function (lane) {
      return "Security discovery lane: " + lane;
    },
    agentId: EXEC_AGENT_ID,
    prompt: function (lane) {
      return (
        READ_ONLY_SECURITY_PROMPT +
        laneSecurityPrompt(lane) +
        "\n\nReturn concrete, actionable security findings with rule IDs, severity, CWE/OWASP tags when known, locations, source/sink summary, proof hypothesis, and candidate fingerprints. Prefer an empty findings array over speculation.\n\n" +
        renderSecurityInput(input, stateContext) +
        "\n\nSecurity scope:\n" +
        JSON.stringify(scope.structuredOutput, null, 2)
      );
    },
    outputSchema: findingListSchema(),
    maxParallel: Math.min(MAX_PARALLEL_AGENTS, lanes.length),
  });
  const laneFindings = flatten(
    laneReviews.map(function (review) {
      return WORKFLOW_UTILS.asArray(review.structuredOutput && review.structuredOutput.findings);
    })
  );
  log("Security discovery produced candidate findings", { count: laneFindings.length });

  phase("match-findings", { candidateCount: laneFindings.length });
  const matched = matchFindingsAgent(agent, laneFindings, stateContext);

  phase("grill", { candidateCount: laneFindings.length });
  const grill = agent({
    id: "grill-security-scope",
    title: "Grill security scope and findings",
    agentId: EXEC_AGENT_ID,
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Adversarially challenge this security scan scope. Look for missed entrypoints, trust boundaries, prompt-injection/tool-execution traps, stale cache assumptions, or over-broad conclusions. Return grounded gaps and follow-ups.\n\n" +
      "Scope:\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\n\nCandidate findings:\n" +
      JSON.stringify(laneFindings, null, 2) +
      "\n\nMatch decisions:\n" +
      JSON.stringify(matched, null, 2),
    outputSchema: grillSchema(),
  });

  phase("triage-dedupe", { candidateCount: laneFindings.length });
  const triage = agent({
    id: "triage-security-findings",
    title: "Triage and dedupe security findings",
    agentId: EXEC_AGENT_ID,
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Deduplicate and triage candidate security findings. Preserve concrete evidence, do not mark durable false positives from opinion alone, and keep inconclusive findings visible. Assign stable finding ids like SEC-1.\n\n" +
      "Candidate findings:\n" +
      JSON.stringify(laneFindings, null, 2) +
      "\n\nDeterministic/sub-agent match decisions:\n" +
      JSON.stringify(matched, null, 2) +
      "\n\nScope grill:\n" +
      JSON.stringify(grill.structuredOutput, null, 2),
    outputSchema: findingListSchema(),
  });
  const candidates = WORKFLOW_UTILS.asArray(triage.structuredOutput.findings).slice(
    0,
    input.maxFindings
  );

  phase("verification", { candidateCount: candidates.length, verify: input.verify });
  const verificationResults = input.verify
    ? mux.parallelMap({
        items: candidates,
        stepId: function (_finding, index) {
          return "verify-security-finding-" + index;
        },
        title: function (_finding, index) {
          return "Verify security finding " + (index + 1);
        },
        agentId: EXEC_AGENT_ID,
        prompt: function (finding) {
          return (
            READ_ONLY_SECURITY_PROMPT +
            "Adversarially verify this security finding. Try to disprove it first. Report whether evidence is verified, static_evidence, unverified, inconclusive, or needs_human_review. Do not execute risky PoCs unless safe sandbox constraints are satisfied.\n\nFinding:\n" +
            JSON.stringify(finding, null, 2) +
            "\n\nScan context:\n" +
            renderSecurityInput(input, stateContext)
          );
        },
        outputSchema: verificationSchema(),
        maxParallel: Math.min(MAX_PARALLEL_AGENTS, candidates.length),
      })
    : [];
  const verifications = mergeVerificationResults(candidates, verificationResults);

  phase("evidence-bundles", { verifiedCount: countVerified(verifications) });
  const evidenceDrafts = buildEvidenceDrafts(candidates, verifications);

  phase("final-synthesis", { findingCount: candidates.length });
  const final = agent({
    id: "synthesize-security-scan",
    title: "Synthesize security scan report",
    agentId: EXEC_AGENT_ID,
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Synthesize a concise security scan report. Include threat-model coverage, findings by proof state, cache reuse, skipped work, and validation recommendations.\n\n" +
      "Scope:\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\n\nThreat model draft:\n" +
      JSON.stringify(threatModelDraft.structuredOutput, null, 2) +
      "\n\nCandidate findings:\n" +
      JSON.stringify(candidates, null, 2) +
      "\n\nVerification results:\n" +
      JSON.stringify(verifications, null, 2),
    outputSchema: synthesisSchema(),
  });

  const structuredOutput = {
    input,
    stateContext,
    scope: scope.structuredOutput,
    fileHashes,
    threatModel: threatModelDraft.structuredOutput,
    laneFindings,
    matched,
    grill: grill.structuredOutput,
    candidates,
    verifications,
    evidenceDrafts,
    final: final.structuredOutput,
  };

  const persistencePayload = {
    input,
    reportMarkdown: final.reportMarkdown,
    structuredOutput,
    threatModel: threatModelDraft.structuredOutput,
    evidenceDrafts,
  };
  const preparedFix = input.fix
    ? prepareSecurityFixPass({
        input,
        candidates,
        verifications,
        agent,
        stateContext,
        phase,
        persistencePayload,
      })
    : null;
  let fix = preparedFix ? preparedFix.fix : null;
  if (fix) structuredOutput.fix = fix;

  const attemptedFixPatch = Boolean(preparedFix && preparedFix.shouldApply);
  if (attemptedFixPatch) {
    fix = await applyPreparedSecurityFix(preparedFix, phase);
    structuredOutput.fix = fix;
    if (fix.applied && fix.applied.success) {
      structuredOutput.persistence = bundledFixPersistence(fix.applied);
      structuredOutput.persistenceApply = bundledFixPersistenceApply(fix.applied);
      return securityScanResult(
        final.reportMarkdown,
        fix,
        structuredOutput.persistenceApply,
        structuredOutput
      );
    }
  }

  if (attemptedFixPatch) {
    await phase("persist-security-state", { findingCount: candidates.length });
  } else {
    phase("persist-security-state", { findingCount: candidates.length });
  }
  // Read-only scans, skipped fixes, no-op fixers, and failed fix patches persist against the reviewed scan HEAD.
  const persistenceExpectedHeadSha = securityPersistenceExpectedHeadSha(stateContext);
  let applyResult;
  if (persistenceExpectedHeadSha) {
    const persistence = attemptedFixPatch
      ? await persistSecurityStateAgent(agent, persistencePayload)
      : persistSecurityStateAgent(agent, persistencePayload);
    applyResult = await mux.patch.applySafely({
      id: "apply-security-state",
      source: persistence,
      expectedHeadSha: persistenceExpectedHeadSha,
      // Security state patches are constrained by prompt to .mux/security and
      // should persist even when the scan target includes uncommitted work.
      force: true,
    });
    structuredOutput.persistence = persistence.structuredOutput;
  } else {
    applyResult = {
      success: false,
      status: "failed",
      error: "Security state persistence requires a reviewed local Git HEAD snapshot.",
    };
    structuredOutput.persistence = null;
  }
  structuredOutput.persistenceApply = applyResult;

  return securityScanResult(final.reportMarkdown, fix, applyResult, structuredOutput);
}

function securityScanResult(finalReportMarkdown, fix, persistenceApply, structuredOutput) {
  return {
    reportMarkdown:
      finalReportMarkdown +
      (fix ? "\n\n---\n\n## Fix pass\n\n" + fix.reportMarkdown : "") +
      "\n\n---\n\n## Security state persistence\n\n- Status: " +
      (persistenceApply && persistenceApply.status ? persistenceApply.status : "unknown") +
      "\n- Success: " +
      (persistenceApply && persistenceApply.success ? "yes" : "no"),
    structuredOutput,
  };
}

function bundledFixPersistence(applied) {
  return {
    wroteFiles: Boolean(applied && applied.success),
    paths: [],
    diagnostics: ["Security state persistence was bundled into the fix patch."],
  };
}

function bundledFixPersistenceApply(applied) {
  return Object.assign({}, applied, {
    note: "Security state persistence was bundled into apply-security-fixes.",
  });
}

function securityPersistenceExpectedHeadSha(stateContext) {
  return text(stateContext && stateContext.gitContext && stateContext.gitContext.headSha);
}

function collectSecurityStateAgent(agent, input) {
  return agent({
    id: "security-load-state-and-git-context",
    title: "Load security state and Git context",
    agentId: EXPLORE_AGENT_ID,
    isolation: "none",
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Read .mux/security/cache.json, .mux/security/threat-model.index.json, and .mux/security/overrides/overrides.json when present. Also collect a bounded Git summary for the scan: branch, HEAD SHA, changed files, diff stat, and recent relevant commits. Return diagnostics instead of failing on missing security files.\n\n" +
      "Input:\n" +
      JSON.stringify(input, null, 2),
    outputSchema: securityStateSchema(),
  }).structuredOutput;
}

function hashFilesAgent(agent, scope) {
  return agent({
    id: "security-hash-scope-files",
    title: "Hash scoped security files",
    agentId: EXPLORE_AGENT_ID,
    isolation: "none",
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Compute SHA-256 hashes for up to 100 workspace-relative files listed in the security scope. For JS/TS files, also include a simple semantic hash with comments/whitespace stripped when practical. Return diagnostics instead of failing for missing files.\n\nFiles:\n" +
      JSON.stringify(WORKFLOW_UTILS.asArray(scope && scope.files).slice(0, 100), null, 2),
    outputSchema: fileHashesSchema(),
  }).structuredOutput;
}

function matchFindingsAgent(agent, candidates, stateContext) {
  return agent({
    id: "security-match-findings",
    title: "Match security findings to cached state",
    agentId: EXPLORE_AGENT_ID,
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Match candidate findings against cached findings and overrides using primary, semantic, and match-based fingerprints. Mark suppressive overrides (false_positive, accepted_risk, ignored) and indicate whether each candidate should be verified.\n\nCandidates:\n" +
      JSON.stringify(candidates, null, 2) +
      "\n\nCached state:\n" +
      JSON.stringify(stateContext, null, 2),
    outputSchema: matchSchema(),
  }).structuredOutput;
}

function persistSecurityStateAgent(agent, payload) {
  return agent({
    id: "security-write-state",
    title: "Persist security scan state",
    agentId: EXEC_AGENT_ID,
    prompt:
      "Persist the security scan state in this child workspace. Write files under .mux/security only: threat-model.md, threat-model.index.json, evidence/<finding-id>/..., cache.json, runs/<run-dir>/report.md, runs/<run-dir>/structured-output.json, and runs/latest. Redact obvious TOKEN/KEY/SECRET values in transcripts. Commit the changes locally so the parent workflow can apply the patch artifact. Return structuredOutput with written paths and diagnostics.\n\nPayload:\n" +
      JSON.stringify(payload, null, 2),
    outputSchema: persistenceSchema(),
  });
}

function collectSecurityFixPreflightAgent(agent, input, stateContext) {
  return agent({
    id: "security-fix-git-status",
    title: "Security fix Git preflight",
    agentId: EXPLORE_AGENT_ID,
    isolation: "none",
    prompt:
      READ_ONLY_SECURITY_PROMPT +
      "Use bash/git to check whether the current checkout is clean and still matches the reviewed security scan snapshot. Return ok=false with a clear reason when auto-fix should be skipped.\n\nInput and reviewed state:\n" +
      JSON.stringify({ input, gitContext: stateContext && stateContext.gitContext }, null, 2),
    outputSchema: fixPreflightSchema(),
  }).structuredOutput;
}

function isSecurityFindingAutoFixable(verification) {
  if (!verification || verification.safeToFix !== true) return false;
  return verification.proofState === "verified" || verification.proofState === "static_evidence";
}

function reviewedSecurityHeadPreflightSkipReason(preflight, reviewedHeadSha) {
  if (!reviewedHeadSha) return "Security auto-fix requires a reviewed local Git HEAD snapshot.";
  // The preflight agent observes the current parent checkout. Do not spawn a fixer from stale
  // scan context when the parent moved; applySafely still fences later movement before apply.
  if (preflight.headSha !== reviewedHeadSha)
    return "Security auto-fix preflight current HEAD does not match the reviewed scan snapshot.";
  if (preflight.expectedHeadSha && preflight.expectedHeadSha !== reviewedHeadSha)
    return "Security auto-fix preflight expected HEAD does not match the reviewed scan snapshot.";
  return "";
}

function prepareSecurityFixPass(context) {
  const fixable = context.candidates
    .filter(function (finding, index) {
      const requested = context.input.fixFindingIds;
      const byRequest = requested.length === 0 || requested.indexOf(finding.id) !== -1;
      const verification =
        context.verifications[index] && context.verifications[index].verification;
      return byRequest && isSecurityFindingAutoFixable(verification);
    })
    .slice(0, context.input.maxFixes);
  if (fixable.length === 0) {
    return {
      shouldApply: false,
      fix: {
        reportMarkdown: "No verified findings were selected for fixing.",
        preflight: null,
        fixer: null,
        applied: null,
      },
    };
  }
  context.phase("fix-preflight", { fixableCount: fixable.length });
  const preflight = collectSecurityFixPreflightAgent(
    context.agent,
    context.input,
    context.stateContext
  );
  if (!preflight.ok) {
    return {
      shouldApply: false,
      fix: {
        reportMarkdown: preflight.reason || "Security auto-fix preflight failed.",
        preflight,
        fixer: null,
        applied: null,
      },
    };
  }
  const reviewedHeadSha =
    context.stateContext.gitContext && context.stateContext.gitContext.headSha;
  const preflightHeadSkipReason = reviewedSecurityHeadPreflightSkipReason(
    preflight,
    reviewedHeadSha
  );
  if (preflightHeadSkipReason) {
    return {
      shouldApply: false,
      fix: {
        reportMarkdown: preflightHeadSkipReason,
        preflight,
        fixer: null,
        applied: null,
      },
    };
  }
  context.phase("fix", { fixableCount: fixable.length });
  const fixer = context.agent({
    id: "fix-security-findings",
    title: "Fix selected security findings",
    agentId: EXEC_AGENT_ID,
    prompt:
      "Fix the selected security findings with minimal surgical edits. Also persist the security scan state in the same child workspace: write files under .mux/security only for threat-model, evidence, cache, runs, and latest-run state. Do not push or open a PR. Run relevant validation and commit both code fixes and security state locally so the parent workflow can apply one reviewed patch artifact. Skip unsafe findings with reasons.\n\nFindings:\n" +
      JSON.stringify(fixable, null, 2) +
      "\n\nSecurity state payload:\n" +
      JSON.stringify(context.persistencePayload, null, 2),
    outputSchema: fixerSchema(),
  });
  if (!fixer.structuredOutput || !fixer.structuredOutput.madeChanges) {
    return {
      shouldApply: false,
      fix: {
        reportMarkdown: fixer.reportMarkdown,
        preflight,
        fixer: fixer.structuredOutput,
        applied: null,
      },
    };
  }
  return {
    shouldApply: true,
    fixer,
    expectedHeadSha: reviewedHeadSha,
    fix: {
      reportMarkdown: fixer.reportMarkdown,
      preflight,
      fixer: fixer.structuredOutput,
      applied: null,
    },
  };
}

async function applyPreparedSecurityFix(preparedFix, phase) {
  if (!preparedFix.shouldApply) return preparedFix.fix;
  phase("apply-fixes", { madeChanges: true });
  const applied = await mux.patch.applySafely({
    id: "apply-security-fixes",
    source: preparedFix.fixer,
    expectedHeadSha: preparedFix.expectedHeadSha,
  });
  return Object.assign({}, preparedFix.fix, { applied });
}

function renderSecurityInput(input, stateContext) {
  return (
    "Target: " +
    input.target +
    "\nFlags: " +
    JSON.stringify({
      changedOnly: input.changedOnly,
      full: input.full,
      verify: input.verify,
      fix: input.fix,
    }) +
    "\nGit context and cached security state:\n" +
    JSON.stringify(stateContext, null, 2)
  );
}

function laneSecurityPrompt(lane) {
  const prompts = {
    secrets:
      "Scan for committed secrets, unsafe credential handling, excessive logging, and token leakage.",
    injection: "Scan for command, SQL, path, prompt, template, HTML, and IPC injection risks.",
    authz:
      "Scan authentication and authorization flows, privilege boundaries, confused deputy risks, and unsafe defaults.",
    filesystem:
      "Scan file reads/writes, archive extraction, symlink traversal, temp files, and workspace boundary checks.",
    network:
      "Scan HTTP clients/servers, webhook handlers, SSRF, callback validation, and external API trust boundaries.",
    sandbox: "Scan subprocess, agent tool, workflow, plugin, and sandbox escape boundaries.",
    "supply-chain":
      "Scan dependencies, scripts, CI/deploy config, generated code, and package execution surfaces.",
  };
  return prompts[lane] || prompts.injection;
}

function buildEvidenceDrafts(candidates, verifications) {
  return candidates.map(function (finding, index) {
    const verification = verifications[index] && verifications[index].verification;
    return {
      findingId: finding.id || "security-finding-" + (index + 1),
      baseline: { finding },
      postState: { verification },
      evidence: verification || {},
      transcript: verification ? verification.evidence : "",
    };
  });
}

function mergeVerificationResults(candidates, results) {
  if (results.length === 0) {
    return candidates.map(function (finding) {
      return {
        findingId: finding.id,
        verification: {
          proofState: "needs_human_review",
          confidence: "low",
          evidence: "Verification disabled.",
          safeToFix: false,
        },
      };
    });
  }
  return candidates.map(function (finding, index) {
    return {
      findingId: finding.id,
      verification: matchingFindingVerification(finding, results[index]),
    };
  });
}

function matchingFindingVerification(finding, result) {
  const verification = result && result.structuredOutput;
  if (verification && verification.findingId === finding.id) return verification;
  return {
    findingId: finding.id,
    proofState: "needs_human_review",
    confidence: "low",
    evidence: "Verifier result did not match the candidate finding id.",
    safeToFix: false,
    recommendedValidation: [],
  };
}

function countVerified(verifications) {
  return verifications.filter(function (item) {
    const proofState = item && item.verification && item.verification.proofState;
    return proofState === "verified" || proofState === "static_evidence";
  }).length;
}

function selectSecurityLanes(rawLanes) {
  const selected = [];
  for (const lane of WORKFLOW_UTILS.asArray(rawLanes)) {
    if (SECURITY_LANES.indexOf(lane) !== -1 && selected.indexOf(lane) === -1) selected.push(lane);
  }
  return selected.length > 0
    ? selected
    : ["secrets", "injection", "authz", "filesystem", "sandbox"];
}

function securityScopeSchema() {
  return SCHEMA.object(
    {
      summary: SCHEMA.string(),
      appType: SCHEMA.string(),
      entrypoints: SCHEMA.array(SCHEMA.string()),
      trustBoundaries: SCHEMA.array(SCHEMA.string()),
      assets: SCHEMA.array(SCHEMA.string()),
      privilegedOperations: SCHEMA.array(SCHEMA.string()),
      files: SCHEMA.array(SCHEMA.string()),
      lanes: SCHEMA.array(SCHEMA.enum(SECURITY_LANES)),
    },
    { additionalProperties: false }
  );
}

function findingSchema() {
  return SCHEMA.object(
    {
      id: SCHEMA.string(),
      ruleId: SCHEMA.string(),
      title: SCHEMA.string(),
      severity: SCHEMA.enum(SEVERITIES),
      cwe: SCHEMA.array(SCHEMA.string()),
      owasp: SCHEMA.array(SCHEMA.string()),
      locations: SCHEMA.array(SCHEMA.string()),
      sourceSink: SCHEMA.string(),
      proofHypothesis: SCHEMA.string(),
      recommendation: SCHEMA.string(),
      fingerprints: SCHEMA.object(
        {
          primary: SCHEMA.string(),
          semanticAst: SCHEMA.string(),
          matchBased: SCHEMA.string(),
          scopeOffset: SCHEMA.string(),
          contextWindow: SCHEMA.string(),
        },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  );
}

function findingListSchema() {
  return SCHEMA.object(
    { findings: SCHEMA.array(findingSchema()) },
    { additionalProperties: false }
  );
}

function verificationSchema() {
  return SCHEMA.object(
    {
      findingId: SCHEMA.string(),
      proofState: SCHEMA.enum(PROOF_STATES),
      confidence: SCHEMA.enum(["high", "medium", "low"]),
      evidence: SCHEMA.string(),
      safeToFix: SCHEMA.boolean(),
      recommendedValidation: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function synthesisSchema() {
  return SCHEMA.object(
    {
      summary: SCHEMA.string(),
      findings: SCHEMA.array(
        SCHEMA.object(
          {
            id: SCHEMA.string(),
            title: SCHEMA.string(),
            severity: SCHEMA.enum(SEVERITIES),
            proofState: SCHEMA.enum(PROOF_STATES),
            recommendation: SCHEMA.string(),
          },
          { additionalProperties: false }
        )
      ),
      coverageGaps: SCHEMA.array(SCHEMA.string()),
      validationPlan: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function securityStateSchema() {
  return SCHEMA.object(
    {
      schemaVersion: SCHEMA.integer(),
      securityRoot: SCHEMA.string(),
      gitContext: SCHEMA.object(
        {
          branch: SCHEMA.string(),
          headSha: SCHEMA.string(),
          changedFiles: SCHEMA.array(SCHEMA.string()),
          diffStat: SCHEMA.string(),
          commits: SCHEMA.array(SCHEMA.string()),
        },
        { additionalProperties: false }
      ),
      cachedFindings: SCHEMA.array(findingSchema()),
      overrides: SCHEMA.array(
        SCHEMA.object(
          { findingId: SCHEMA.string(), status: SCHEMA.string(), reason: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
      threatModelIndex: SCHEMA.array(SCHEMA.string()),
      diagnostics: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function fileHashesSchema() {
  return SCHEMA.object(
    {
      schemaVersion: SCHEMA.integer(),
      files: SCHEMA.array(
        SCHEMA.object(
          {
            path: SCHEMA.string(),
            sha256: SCHEMA.string(),
            semanticSha256: SCHEMA.string(),
            exists: SCHEMA.boolean(),
          },
          { additionalProperties: false }
        )
      ),
      diagnostics: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function threatModelSchema() {
  return SCHEMA.object(
    {
      markdown: SCHEMA.string(),
      index: SCHEMA.object(
        { sections: SCHEMA.array(SCHEMA.string()), diagnostics: SCHEMA.array(SCHEMA.string()) },
        { additionalProperties: false }
      ),
    },
    { additionalProperties: false }
  );
}

function matchSchema() {
  return SCHEMA.object(
    {
      decisions: SCHEMA.array(
        SCHEMA.object(
          {
            index: SCHEMA.integer(),
            candidateId: SCHEMA.string(),
            match: SCHEMA.enum(["new", "exact", "strong", "weak", "override"]),
            findingId: SCHEMA.string(),
            reason: SCHEMA.string(),
            shouldVerify: SCHEMA.boolean(),
          },
          { additionalProperties: false }
        )
      ),
      aliasUpdates: SCHEMA.array(SCHEMA.string()),
      diagnostics: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function grillSchema() {
  return SCHEMA.object(
    {
      gaps: SCHEMA.array(SCHEMA.string()),
      followUps: SCHEMA.array(SCHEMA.string()),
      concerns: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function persistenceSchema() {
  return SCHEMA.object(
    {
      wroteFiles: SCHEMA.boolean(),
      paths: SCHEMA.array(SCHEMA.string()),
      diagnostics: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function fixPreflightSchema() {
  return SCHEMA.object(
    {
      ok: SCHEMA.boolean(),
      reason: SCHEMA.string(),
      branch: SCHEMA.string(),
      headSha: SCHEMA.string(),
      expectedHeadSha: SCHEMA.string(),
      clean: SCHEMA.boolean(),
      staged: SCHEMA.array(SCHEMA.string()),
      unstaged: SCHEMA.array(SCHEMA.string()),
      untracked: SCHEMA.array(SCHEMA.string()),
    },
    { additionalProperties: false }
  );
}

function fixerSchema() {
  return SCHEMA.object(
    {
      madeChanges: SCHEMA.boolean(),
      fixedFindingIds: SCHEMA.array(SCHEMA.string()),
      skippedFindings: SCHEMA.array(
        SCHEMA.object(
          { id: SCHEMA.string(), reason: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
      validation: SCHEMA.array(
        SCHEMA.object(
          { command: SCHEMA.string(), status: SCHEMA.string(), summary: SCHEMA.string() },
          { additionalProperties: false }
        )
      ),
    },
    { additionalProperties: false }
  );
}

function normalizeSecurityScanArgs(args) {
  const raw = args && typeof args === "object" && !Array.isArray(args) ? args : {};
  const parsed = Object.assign(
    {},
    parseSecurityScanString(typeof args === "string" ? args : text(raw.input)),
    raw
  );
  return {
    target: firstText(parsed.target) || "current workspace",
    changedOnly: Boolean(parsed.changedOnly),
    full: Boolean(parsed.full),
    verify: parsed.verify !== false,
    fix: Boolean(parsed.fix),
    maxFindings: mux.utils.boundedInt(parsed.maxFindings, 20, 1, 1000),
    maxFixes: mux.utils.boundedInt(parsed.maxFixes, 3, 1, 1000),
    fixFindingIds: mergeStringLists(stringList(parsed.fixFindingIds), [
      parsed.finding,
      parsed.findingId,
    ]),
    runDirId: text(parsed.runDirId),
  };
}

function parseSecurityScanString(value) {
  const result = {};
  const tokens = tokenize(value);
  const target = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--changed-only") result.changedOnly = true;
    else if (token === "--full") result.full = true;
    else if (token === "--verify") result.verify = true;
    else if (token === "--no-verify") result.verify = false;
    else if (token === "--fix") result.fix = true;
    else if (token === "--no-fix") result.fix = false;
    else if (token === "--max-findings" || token === "--max-fixes" || token === "--run-dir") {
      index += 1;
      const key =
        token === "--max-findings"
          ? "maxFindings"
          : token === "--max-fixes"
            ? "maxFixes"
            : "runDirId";
      result[key] = tokens[index] || "";
    } else if (token === "--finding" || token === "--finding-id") {
      index += 1;
      if (!Array.isArray(result.fixFindingIds)) result.fixFindingIds = [];
      result.fixFindingIds.push(tokens[index] || "");
    } else target.push(token);
  }
  if (target.length > 0) result.target = target.join(" ");
  return result;
}

function mergeStringLists(first, second) {
  const result = [];
  for (const value of WORKFLOW_UTILS.asArray(first).concat(WORKFLOW_UTILS.asArray(second))) {
    const valueText = text(value);
    if (valueText && result.indexOf(valueText) === -1) result.push(valueText);
  }
  return result;
}

function firstText() {
  for (let index = 0; index < arguments.length; index += 1) {
    const value = text(arguments[index]);
    if (value) return value;
  }
  return "";
}

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const item of value) {
    const itemText = text(item);
    if (itemText && result.indexOf(itemText) === -1) result.push(itemText);
  }
  return result;
}

function tokenize(input) {
  return String(input || "")
    .split(/\s+/)
    .filter(Boolean);
}

function flatten(items) {
  return items.reduce(function (result, item) {
    return result.concat(WORKFLOW_UTILS.asArray(item));
  }, []);
}
