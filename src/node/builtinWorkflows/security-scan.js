// description: Audit a repository for security risk, persist threat-model state, and synthesize findings.
export default function securityScanWorkflow({
  args,
  phase,
  log,
  agent,
  action,
  parallelAgents,
  applyPatch,
}) {
  const input = normalizeSecurityScanArgs(args);
  const readOnlyPrompt =
    "This security scan phase is read-only. Do not edit files, create commits, apply patches, push branches, or open PRs. Inspect repository evidence only as needed and report concrete security findings.\n\n";

  if (input.loop) {
    throw new Error("--loop is not implemented for security-scan yet");
  }

  phase("preflight", { target: input.target, changedOnly: input.changedOnly, full: input.full });
  const gitContext = collectSecurityGitContext(action, input, log);
  const state = action.security.loadState({
    id: "security-load-state",
    input: {},
    builtInOnly: true,
  }).output;

  phase("scope", { target: input.target });
  const scope = agent({
    id: "scope-security-surface",
    title: "Scope security surface",
    agentId: "explore",
    prompt:
      readOnlyPrompt +
      "Scope this repository for a security scan. Identify app type, entrypoints, trust boundaries, sensitive assets, privileged operations, persistence, secrets, subprocess/tool execution, IPC/API surfaces, CI/deploy surfaces, relevant files, and recommended scan lanes. Prefer repository evidence over assumptions.\n\n" +
      renderSecurityInput(input, gitContext, state),
    outputSchema: securityScopeSchema(),
  });

  const fileHashes = collectSecurityFileHashes(action, scope.structuredOutput, log);

  phase("threat-model", { fileCount: asArray(scope.structuredOutput.files).length });
  const threatModelMarkdown = renderThreatModel(scope.structuredOutput, gitContext, state);
  action.security.writeThreatModel({
    id: "security-write-threat-model",
    input: {
      markdown: threatModelMarkdown,
      index: buildThreatModelIndex(scope.structuredOutput, gitContext, fileHashes),
      generatedAt: "workflow-run",
    },
    builtInOnly: true,
  });

  const lanes = selectSecurityLanes(scope.structuredOutput.lanes);
  phase("lane-discovery", { lanes: lanes });
  const laneReviews = parallelAgents(
    lanes.map(function (lane) {
      return {
        id: "discover-" + lane,
        title: "Security discovery lane: " + lane,
        agentId: "exec",
        prompt:
          readOnlyPrompt +
          laneSecurityPrompt(lane) +
          "\n\nReturn only concrete, actionable security findings with rule IDs, severity, CWE/OWASP tags when known, locations, source/sink summary, proof hypothesis, and candidate fingerprints. Prefer an empty findings array over speculation.\n\n" +
          renderSecurityInput(input, gitContext, state) +
          "\n\nSecurity scope:\n" +
          JSON.stringify(scope.structuredOutput, null, 2),
        outputSchema: securityFindingListSchema(),
      };
    })
  );

  const laneFindings = flatten(
    laneReviews.map(function (review) {
      return asArray(review.structuredOutput.findings);
    })
  );
  log("Security discovery produced candidate findings", { count: laneFindings.length });

  phase("grill", { candidateCount: laneFindings.length });
  const grill = agent({
    id: "grill-security-scope",
    title: "Grill security scope and findings",
    agentId: "exec",
    prompt:
      readOnlyPrompt +
      "Adversarially challenge this security scan scope. Look for missed entrypoints, trust boundaries, prompt-injection/tool-execution traps, stale cache assumptions, or over-broad conclusions. Return gaps and follow-ups only when grounded in repository evidence.\n\n" +
      "Scope:\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\n\nCandidate findings:\n" +
      JSON.stringify(laneFindings, null, 2),
    outputSchema: securityGrillSchema(),
  });

  phase("triage-dedupe", { candidateCount: laneFindings.length });
  const matched = action.security.matchFindings({
    id: "security-match-findings",
    input: { candidates: laneFindings, cache: state.cache, overrides: state.overrides },
    builtInOnly: true,
  }).output;
  const triage = agent({
    id: "triage-security-findings",
    title: "Triage and dedupe security findings",
    agentId: "exec",
    prompt:
      readOnlyPrompt +
      "Deduplicate and triage candidate security findings. Preserve concrete evidence, do not mark durable false positives from opinion alone, and keep inconclusive findings visible.\n\n" +
      "Candidate findings:\n" +
      JSON.stringify(laneFindings, null, 2) +
      "\n\nDeterministic match decisions:\n" +
      JSON.stringify(matched, null, 2) +
      "\n\nScope grill:\n" +
      JSON.stringify(grill.structuredOutput, null, 2),
    outputSchema: securityFindingListSchema(),
  });
  const rawCandidates = asArray(triage.structuredOutput.findings).slice(0, input.maxFindings);
  const normalizedCandidates = normalizeSecurityFindings(rawCandidates);
  const postTriageMatched = action.security.matchFindings({
    id: "security-match-triaged-findings",
    input: { candidates: normalizedCandidates, cache: state.cache, overrides: state.overrides },
    builtInOnly: true,
  }).output;
  const candidates = canonicalizeMatchedFindings(normalizedCandidates, postTriageMatched);

  phase("verification", { candidateCount: candidates.length });
  const verificationPlan = buildVerificationPlan(candidates, postTriageMatched, input, state.cache);
  const verificationTasks = verificationPlan
    .filter(function (item) {
      return item.shouldVerify;
    })
    .map(function (item) {
      return {
        id: "verify-security-finding-" + item.index,
        title: "Verify security finding " + (item.index + 1),
        agentId: "exec",
        prompt:
          readOnlyPrompt +
          "Adversarially verify this security finding. Try to disprove it first. Report whether evidence is verified, static_evidence, unverified, inconclusive, or needs_human_review. Do not execute risky PoCs unless safe sandbox constraints are satisfied.\n\nFinding:\n" +
          JSON.stringify(item.finding, null, 2) +
          "\n\nScan context:\n" +
          renderSecurityInput(input, gitContext, state),
        outputSchema: securityVerificationSchema(),
      };
    });
  const verificationResults = verificationTasks.length > 0 ? parallelAgents(verificationTasks) : [];
  const verifications = mergeVerificationResults(verificationPlan, verificationResults);
  const evidenceBundles = verifications.map(function (verification, index) {
    if (verification && verification.skipEvidenceBundle === true) {
      return inputObject(verification.evidenceBundle);
    }
    const finding = inputObject(candidates[index]);
    const findingId = optionalString(finding.id) || "security-finding-" + String(index + 1);
    const verificationOutput = inputObject(verification.structuredOutput);
    return action.security.writeEvidenceBundle({
      id: "security-write-evidence-" + index,
      input: {
        findingId: findingId,
        evidence: verificationOutput,
        transcript: verification.reportMarkdown || "",
        baseline: { finding: finding },
        postState: { verification: verificationOutput },
        pocScripts: {},
      },
      builtInOnly: true,
    }).output;
  });

  phase("final-synthesis", { verifiedCount: countVerified(verifications) });
  const final = agent({
    id: "synthesize-security-scan",
    title: "Synthesize security scan report",
    agentId: "exec",
    prompt:
      readOnlyPrompt +
      "Synthesize a concise security scan report. Include threat-model coverage, findings by proof state, cache reuse, skipped work, and validation recommendations.\n\n" +
      "Scope:\n" +
      JSON.stringify(scope.structuredOutput, null, 2) +
      "\n\nCandidate findings:\n" +
      JSON.stringify(candidates, null, 2) +
      "\n\nVerification results:\n" +
      JSON.stringify(
        verifications.map(function (item) {
          return item.structuredOutput;
        }),
        null,
        2
      ) +
      "\n\nEvidence bundles:\n" +
      JSON.stringify(evidenceBundles, null, 2),
    outputSchema: securitySynthesisSchema(),
  });

  let reportMarkdown = final.reportMarkdown;
  let structuredOutput = Object.assign({}, final.structuredOutput);
  let fixResult = null;
  if (input.fix) {
    phase("fix-preflight", { requested: true, maxFixes: input.maxFixes });
    fixResult = runSecurityFix({
      input: input,
      agent: agent,
      action: action,
      log: log,
      gitContext: gitContext,
      parallelAgents: parallelAgents,
      applyPatch: applyPatch,
      candidates: candidates,
      verifications: verifications,
      final: final.structuredOutput,
      readOnlyPrompt: readOnlyPrompt,
    });
    structuredOutput = Object.assign({}, structuredOutput, { fix: fixResult });
    reportMarkdown += renderSecurityFixMarkdown(fixResult);
  }

  phase("persist-report", {
    findingCount: structuredOutput.findingCount || candidates.length,
  });
  action.security.writeState({
    id: "security-write-state",
    input: {
      runDirId: input.runDirId,
      cache: buildCache(
        structuredOutput,
        candidates,
        verifications,
        evidenceBundles,
        scope.structuredOutput,
        fixResult,
        state.cache,
        postTriageMatched,
        fileHashes
      ),
      reportMarkdown: reportMarkdown,
      structuredOutput: structuredOutput,
    },
    builtInOnly: true,
  });

  return { reportMarkdown: reportMarkdown, structuredOutput: structuredOutput };
}

function normalizeSecurityScanArgs(args) {
  const raw = typeof args === "string" ? {} : inputObject(args);
  const text =
    typeof args === "string" ? args : optionalString(raw.input) || optionalString(raw.target) || "";
  const parsed = Object.assign({}, raw, parseSecurityScanString(text));
  return {
    target: optionalString(parsed.input) || optionalString(parsed.target) || "current workspace",
    changedOnly: Boolean(parsed.changedOnly),
    full: Boolean(parsed.full),
    verify: parsed.verify !== false,
    fix: Boolean(parsed.fix),
    loop: Boolean(parsed.loop),
    maxFindings: boundedInt(parsed.maxFindings, 20),
    maxFixes: boundedInt(parsed.maxFixes, 3),
    fixFindingIds: stringList(parsed.fixFindingIds),
    runDirId: optionalString(parsed.runDirId),
  };
}

function parseSecurityScanString(value) {
  const result = {};
  const parts = value.split(/\s+/).filter(Boolean);
  const target = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === "--changed-only") result.changedOnly = true;
    else if (part === "--full") result.full = true;
    else if (part === "--verify") result.verify = true;
    else if (part === "--no-verify") result.verify = false;
    else if (part === "--fix") result.fix = true;
    else if (part === "--no-fix") result.fix = false;
    else if (part === "--loop") result.loop = true;
    else if (part === "--no-loop") result.loop = false;
    else if (part === "--max-findings") {
      index += 1;
      result.maxFindings = parsePositiveIntFlag(parts[index], part);
    } else if (part === "--max-fixes") {
      index += 1;
      result.maxFixes = parsePositiveIntFlag(parts[index], part);
    } else if (part === "--finding" || part === "--finding-id") {
      index += 1;
      const findingId = parseStringFlag(parts[index], part);
      if (!Array.isArray(result.fixFindingIds)) result.fixFindingIds = [];
      result.fixFindingIds.push(findingId);
    } else if (part === "--run-dir") {
      index += 1;
      result.runDirId = parseStringFlag(parts[index], part);
    } else if (part.indexOf("--") === 0) {
      throw new Error("Unknown security-scan flag: " + part);
    } else {
      target.push(part);
    }
  }
  result.input = target.join(" ");
  return result;
}

function parseStringFlag(value, flag) {
  if (typeof value !== "string" || value.length === 0 || value.indexOf("--") === 0) {
    throw new Error(flag + " requires a value");
  }
  return value;
}

function parsePositiveIntFlag(value, flag) {
  const text = parseStringFlag(value, flag);
  if (!/^\d+$/.test(text)) throw new Error(flag + " requires a positive integer value");
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(flag + " requires a positive integer value");
  return parsed;
}

function collectSecurityGitContext(action, input, log) {
  const failures = [];
  const builtInOnly = true;
  function run(name, callback) {
    try {
      return callback();
    } catch (error) {
      failures.push({ action: name, message: String((error && error.message) || error) });
      log("Security git context action failed", failures[failures.length - 1]);
      return null;
    }
  }
  return {
    status: run("git.status", function () {
      return action.git.status({
        id: "security-git-status",
        input: { includeIgnored: false },
        builtInOnly: builtInOnly,
      }).output;
    }),
    changedFiles: run("git.changedFiles", function () {
      return action.git.changedFiles({
        id: "security-git-changed-files",
        input: {},
        builtInOnly: builtInOnly,
      }).output;
    }),
    diffStat: run("git.diffStat", function () {
      return action.git.diffStat({
        id: "security-git-diff-stat",
        input: {},
        builtInOnly: builtInOnly,
      }).output;
    }),
    failures: failures,
    changedOnly: input.changedOnly,
  };
}

function collectSecurityFileHashes(action, scope, log) {
  const files = stringList(scope && scope.files).slice(0, 100);
  if (files.length === 0) return { schemaVersion: 1, files: [], diagnostics: [] };
  try {
    return action.security.hashFiles({
      id: "security-hash-scope-files",
      input: { files: files },
      builtInOnly: true,
    }).output;
  } catch (error) {
    const diagnostic = { action: "security.hashFiles", message: formatError(error) };
    log("Security file hashing failed", diagnostic);
    return { schemaVersion: 1, files: [], diagnostics: [diagnostic] };
  }
}

function renderSecurityInput(input, gitContext, state) {
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
    "\nGit snapshot:\n" +
    JSON.stringify(gitContext, null, 2) +
    "\nSecurity state summary:\n" +
    JSON.stringify(
      {
        diagnostics: state.diagnostics || [],
        findingCount: Object.keys(inputObject(state.cache && state.cache.findings)).length,
      },
      null,
      2
    )
  );
}

function renderThreatModel(scope, gitContext, state) {
  return (
    "# Security Threat Model\n\n" +
    "## Summary\n\n" +
    (optionalString(scope.summary) || "Security surface scoped by /security-scan.") +
    "\n\n" +
    "## Assets\n\n" +
    renderList(scope.assets) +
    "\n\n" +
    "## Entrypoints\n\n" +
    renderList(scope.entrypoints) +
    "\n\n" +
    "## Trust Boundaries\n\n" +
    renderList(scope.trustBoundaries) +
    "\n\n" +
    "## Scan Lanes\n\n" +
    renderList(scope.lanes) +
    "\n\n" +
    "## Cache Diagnostics\n\n" +
    renderList(
      asArray(state.diagnostics).map(function (item) {
        return item.path + ": " + item.message;
      })
    ) +
    "\n\n" +
    "## Git Context\n\n```json\n" +
    JSON.stringify(
      { changedFiles: gitContext.changedFiles, diffStat: gitContext.diffStat },
      null,
      2
    ) +
    "\n```\n"
  );
}

function buildThreatModelIndex(scope, gitContext, fileHashes) {
  return {
    sections: [
      { id: "summary", files: asArray(scope.files), status: "generated" },
      { id: "entrypoints", files: asArray(scope.entrypoints), status: "generated" },
      { id: "trust-boundaries", files: asArray(scope.files), status: "generated" },
    ],
    fileHashes: asArray(fileHashes && fileHashes.files),
    diagnostics: asArray(gitContext.failures).concat(asArray(fileHashes && fileHashes.diagnostics)),
  };
}

function normalizeSecurityFindings(findings) {
  const used = {};
  return asArray(findings).map(function (finding, index) {
    const normalized = Object.assign({}, inputObject(finding));
    const rawId =
      optionalString(normalized.id) ||
      optionalString(normalized.title) ||
      "security-finding-" + String(index + 1);
    const baseId = slugifySecurityId(rawId) || "security-finding-" + String(index + 1);
    const id = dedupeSecurityId(baseId, used);
    if (normalized.id !== id) normalized.originalId = optionalString(normalized.id) || rawId;
    normalized.id = id;
    return normalized;
  });
}

function slugifySecurityId(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[-_.]{2,}/g, "-");
  return /[a-z0-9]/.test(slug) && slug !== "latest" ? slug : "";
}

function dedupeSecurityId(baseId, used) {
  let candidate = baseId;
  let suffix = 2;
  while (used[candidate] === true) {
    candidate = baseId + "-" + String(suffix);
    suffix += 1;
  }
  used[candidate] = true;
  return candidate;
}

function canonicalizeMatchedFindings(findings, matched) {
  const decisions = decisionsByIndex(matched);
  const used = {};
  return findings.map(function (finding, index) {
    const normalized = Object.assign({}, inputObject(finding));
    const decision = decisions[index];
    const matchedId = decision && optionalString(decision.findingId);
    const baseId = matchedId ? slugifySecurityId(matchedId) || normalized.id : normalized.id;
    const id = dedupeSecurityId(baseId, used);
    if (normalized.id !== id) {
      normalized.aliases = stringList(normalized.aliases).concat([normalized.id]);
      normalized.id = id;
    }
    return normalized;
  });
}

function decisionsByIndex(matched) {
  const byIndex = {};
  asArray(matched && matched.decisions).forEach(function (decision) {
    const normalized = inputObject(decision);
    if (Number.isInteger(normalized.index)) byIndex[normalized.index] = normalized;
  });
  return byIndex;
}

function buildVerificationPlan(candidates, matched, input, cache) {
  const verify = {};
  stringList(matched && matched.verify).forEach(function (id) {
    verify[id] = true;
  });
  const decisions = decisionsByIndex(matched);
  return candidates.map(function (finding, index) {
    const normalized = inputObject(finding);
    const findingId = optionalString(normalized.id) || "security-finding-" + String(index + 1);
    const decision = decisions[index] || {};
    const decisionFindingId = optionalString(decision.findingId);
    const shouldVerify =
      input.verify !== false &&
      (verify[findingId] === true ||
        (decisionFindingId ? verify[decisionFindingId] === true : false));
    return {
      index: index,
      findingId: findingId,
      finding: finding,
      decision: decision,
      shouldVerify: shouldVerify,
      cachedRecord: cachedRecordForFinding(cache, findingId, decisionFindingId),
    };
  });
}

function cachedRecordForFinding(cache, findingId, matchedFindingId) {
  const findings = inputObject(cache && cache.findings);
  return inputObject(findings[findingId] || (matchedFindingId ? findings[matchedFindingId] : null));
}

const CACHE_SKIP_STATUS = {
  verified: true,
  false_positive: true,
  accepted_risk: true,
  ignored: true,
};

function cachedVerificationState(record) {
  const normalized = inputObject(record);
  const status = optionalString(normalized.status) || "";
  if (status === "fixed" || CACHE_SKIP_STATUS[status] === true) return status;
  const proof = inputObject(normalized.proof);
  return optionalString(proof.state) || status;
}

function mergeVerificationResults(plan, verificationResults) {
  let resultIndex = 0;
  return plan.map(function (item) {
    if (item.shouldVerify) {
      const result = verificationResults[resultIndex];
      resultIndex += 1;
      return result;
    }
    const cachedProof = inputObject(item.cachedRecord.proof);
    const cachedState = cachedVerificationState(item.cachedRecord);
    const override = inputObject(item.decision && item.decision.override);
    const overrideStatus = optionalString(override.status);
    const verdict = overrideStatus || cachedState || "unverified";
    return {
      taskId: "cache-" + item.findingId,
      reportMarkdown: "Skipped verification for " + item.findingId + ".",
      skipEvidenceBundle: true,
      evidenceBundle: {
        evidenceDigest: optionalString(cachedProof.evidenceDigest) || null,
        evidencePath: optionalString(cachedProof.evidencePath) || null,
      },
      structuredOutput: {
        findingId: item.findingId,
        verdict: verdict,
        confidence: "cached",
        evidence: item.shouldVerify
          ? ""
          : "Verification skipped by cache, override, or --no-verify.",
        rationale:
          optionalString(item.decision && item.decision.reason) ||
          "No verification requested for this finding.",
      },
    };
  });
}

function buildCache(
  final,
  findings,
  verifications,
  evidenceBundles,
  scope,
  fixResult,
  previousCache,
  matched,
  fileHashes
) {
  const fixedFindingIds = fixedFindingIdSet(fixResult);
  const previousFindings = inputObject(previousCache && previousCache.findings);
  const records = Object.assign({}, previousFindings);
  const decisions = decisionsByIndex(matched);
  const aliasUpdates = aliasUpdatesByFindingId(matched);
  findings.forEach(function (finding, index) {
    const normalized = inputObject(finding);
    const id = optionalString(normalized.id) || "security-finding-" + String(index + 1);
    const existing = inputObject(records[id]);
    const evidence = inputObject(evidenceBundles[index]);
    const proofState = proofStateFor(verifications[index]);
    const decision = inputObject(decisions[index]);
    const override = inputObject(decision.override || existing.override);
    const overrideStatus = optionalString(override.status);
    const status = overrideStatus || (fixedFindingIds[id] === true ? "fixed" : proofState);
    const aliases = uniqueStrings(
      asArray(existing.aliases)
        .concat(asArray(normalized.aliases))
        .concat(asArray(aliasUpdates[id]))
    );
    records[id] = Object.assign({}, existing, {
      status: status,
      ruleId:
        optionalString(normalized.ruleId) ||
        optionalString(existing.ruleId) ||
        "manual/security-review",
      severity:
        optionalString(normalized.severity) || optionalString(existing.severity) || "unknown",
      fingerprints: Object.assign(
        {},
        inputObject(existing.fingerprints),
        inputObject(normalized.fingerprints)
      ),
      aliases: aliases,
      latestLocations: stringList(normalized.locations),
      proof: {
        state: proofState,
        evidenceDigest:
          optionalString(evidence.evidenceDigest) ||
          optionalString(inputObject(existing.proof).evidenceDigest) ||
          null,
        evidencePath:
          optionalString(evidence.evidencePath) ||
          optionalString(inputObject(existing.proof).evidencePath) ||
          null,
      },
      override: overrideStatus ? override : existing.override || null,
      history: asArray(existing.history),
    });
  });
  return {
    schemaVersion: 1,
    scannerVersion: "mux-security-scan/v1",
    fingerprintVersion: "mux-sec-fp/v1",
    findings: records,
    coverage: {
      risk: final.risk || "unknown",
      lanes: asArray(scope.lanes),
      fileHashes: asArray(fileHashes && fileHashes.files),
    },
  };
}

function aliasUpdatesByFindingId(matched) {
  const result = {};
  asArray(matched && matched.aliasUpdates).forEach(function (item) {
    const update = inputObject(item);
    const findingId = optionalString(update.findingId);
    const alias = optionalString(update.addAlias);
    if (!findingId || !alias) return;
    if (!Array.isArray(result[findingId])) result[findingId] = [];
    result[findingId].push(alias);
  });
  return result;
}

function uniqueStrings(values) {
  const seen = {};
  const result = [];
  asArray(values).forEach(function (value) {
    if (typeof value !== "string" || value.length === 0 || seen[value] === true) return;
    seen[value] = true;
    result.push(value);
  });
  return result;
}

function collectSecurityFixPreflight(action, log, input, gitContext) {
  if (looksNonLocalTarget(input.target)) {
    return { skippedReason: "auto-fix requires a local current workspace target" };
  }
  let status = null;
  try {
    status = action.git.status({
      id: "security-fix-git-status",
      input: { includeIgnored: false, head: "HEAD" },
      builtInOnly: true,
      cache: false,
    }).output;
  } catch (error) {
    log("Git status unavailable for security auto-fix preflight", { error: formatError(error) });
    return { skippedReason: "auto-fix requires a fresh local Git status" };
  }
  if (!inputObject(status).headSha)
    return { skippedReason: "auto-fix requires a fresh local Git status" };
  const reviewed = getReviewedGitSnapshot(gitContext);
  if (!reviewed)
    return { skippedReason: "auto-fix requires a reviewed Git branch and HEAD snapshot" };
  if (normalizedGitBranch(status.branch) !== reviewed.branch) {
    return {
      skippedReason: "auto-fix requires the current Git branch to match the reviewed snapshot",
    };
  }
  if (
    asArray(status.staged).length > 0 ||
    asArray(status.unstaged).length > 0 ||
    asArray(status.untracked).length > 0
  ) {
    return { skippedReason: "auto-fix requires a clean committed local worktree" };
  }
  return { status: status, expectedHeadSha: reviewed.headSha };
}

function looksNonLocalTarget(target) {
  const text = String(target || "").trim();
  return /^https?:\/\//i.test(text) || /^git@/i.test(text);
}

function getReviewedGitSnapshot(gitContext) {
  const status = inputObject(gitContext && gitContext.status);
  const branch = normalizedGitBranch(status.branch);
  const headSha = optionalString(status.headSha);
  if (!branch || !headSha) return null;
  return { branch: branch, headSha: headSha };
}

function normalizedGitBranch(branch) {
  if (typeof branch !== "string") return "";
  const trimmed = branch.trim();
  if (!trimmed || trimmed === "HEAD (no branch)") return "";
  return trimmed;
}

function runSecurityFix(context) {
  const baseFix = {
    requested: true,
    selectedFindings: [],
    attempts: [],
    applications: [],
    resolutions: [],
    unresolved: [],
  };
  const preflight = collectSecurityFixPreflight(
    context.action,
    context.log,
    context.input,
    context.gitContext
  );
  if (preflight.skippedReason) {
    baseFix.skippedReason = preflight.skippedReason;
    return baseFix;
  }
  let expectedHeadSha = preflight.expectedHeadSha;
  const selected = selectFixFindings(
    context.candidates,
    context.verifications,
    context.input,
    context.final
  );
  baseFix.selectedFindings = selected.map(function (item) {
    return summarizeFixFinding(item.findingId, item.finding);
  });
  if (selected.length === 0) return baseFix;

  const fixerResults = context.parallelAgents(
    selected.map(function (item, index) {
      return {
        id: "fix-security-finding-" + index,
        title: "Fix verified security finding " + (index + 1),
        agentId: "exec",
        prompt: buildSecurityFixPrompt(context.input, item),
        outputSchema: securityFixAttemptSchema(),
      };
    })
  );

  const integratedFindingIds = [];
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index];
    const fixerResult = fixerResults[index];
    const attempt = summarizeSecurityFixAttempt(item.findingId, fixerResult);
    baseFix.attempts.push(attempt);
    const attemptOutput = inputObject(fixerResult && fixerResult.structuredOutput);
    if (!matchesReportedFindingId(attemptOutput, item.findingId)) {
      baseFix.unresolved.push({
        findingId: item.findingId,
        reason: findingIdMismatchReason("fixer", item.findingId, attemptOutput),
      });
      continue;
    }
    if (attemptOutput.status === "already-fixed") {
      integratedFindingIds.push(item.findingId);
      continue;
    }
    if (attemptOutput.status !== "fixed" || attemptOutput.commitCreated !== true) {
      baseFix.unresolved.push({
        findingId: item.findingId,
        reason: optionalString(attemptOutput.status) || "not-fixed",
      });
      continue;
    }

    const application = safeApplySecurityPatch(
      context.applyPatch,
      "apply-security-fix-" + index,
      fixerResult,
      expectedHeadSha
    );
    application.findingId = item.findingId;
    baseFix.applications.push(application);
    if (application.status === "applied") {
      expectedHeadSha = getAppliedHeadCommitSha(application) || expectedHeadSha;
      integratedFindingIds.push(item.findingId);
      continue;
    }
    if (application.status !== "conflict") {
      baseFix.unresolved.push({
        findingId: item.findingId,
        reason: optionalString(application.error) || application.status,
      });
      continue;
    }

    const resolver = context.agent({
      id: "resolve-security-finding-" + index + "-conflict",
      title: "Resolve security auto-fix conflict " + (index + 1),
      agentId: "exec",
      prompt: buildSecurityResolverPrompt(context.input, item, fixerResult, application),
      outputSchema: securityFixResolverSchema(),
    });
    const resolution = summarizeSecurityResolution(item.findingId, resolver);
    baseFix.resolutions.push(resolution);
    const resolutionOutput = inputObject(resolver && resolver.structuredOutput);
    if (!matchesReportedFindingId(resolutionOutput, item.findingId)) {
      baseFix.unresolved.push({
        findingId: item.findingId,
        reason: findingIdMismatchReason("resolver", item.findingId, resolutionOutput),
      });
      continue;
    }
    if (resolutionOutput.status === "already-resolved") {
      integratedFindingIds.push(item.findingId);
      continue;
    }
    if (resolutionOutput.status === "resolved" && resolutionOutput.commitCreated === true) {
      const resolvedApplication = safeApplySecurityPatch(
        context.applyPatch,
        "apply-resolved-security-fix-" + index,
        resolver,
        expectedHeadSha
      );
      resolvedApplication.findingId = item.findingId;
      resolution.applyStatus = resolvedApplication.status;
      baseFix.applications.push(resolvedApplication);
      if (resolvedApplication.status === "applied") {
        expectedHeadSha = getAppliedHeadCommitSha(resolvedApplication) || expectedHeadSha;
        integratedFindingIds.push(item.findingId);
      } else {
        baseFix.unresolved.push({
          findingId: item.findingId,
          reason: optionalString(resolvedApplication.error) || resolvedApplication.status,
        });
      }
    } else {
      baseFix.unresolved.push({
        findingId: item.findingId,
        reason: optionalString(resolutionOutput.status) || "unresolved-conflict",
      });
    }
  }

  baseFix.integratedFindingIds = uniqueStrings(integratedFindingIds);
  if (baseFix.integratedFindingIds.length > 0) {
    const validation = context.agent({
      id: "validate-security-fixes",
      title: "Validate applied security fixes",
      agentId: "explore",
      prompt: buildSecurityValidationPrompt(context.input, context.final, baseFix),
      outputSchema: securityFixValidationSchema(),
    });
    baseFix.validation = validation.structuredOutput;
  }
  if (!baseFix.validation || baseFix.validation.status !== "passed") {
    baseFix.appliedButUnvalidated = baseFix.integratedFindingIds;
  }
  return baseFix;
}

function selectFixFindings(candidates, verifications, input, final) {
  const finalVerified = {};
  stringList(final && final.verifiedFindingIds).forEach(function (id) {
    finalVerified[id] = true;
  });
  const requested = {};
  stringList(input.fixFindingIds).forEach(function (id) {
    requested[id] = true;
  });
  const hasRequested = Object.keys(requested).length > 0;
  const selected = [];
  candidates.forEach(function (finding, index) {
    const normalized = inputObject(finding);
    const findingId = optionalString(normalized.id) || "security-finding-" + String(index + 1);
    if (hasRequested && requested[findingId] !== true) return;
    if (finalVerified[findingId] !== true) return;
    if (proofStateFor(verifications[index]) !== "verified") return;
    selected.push({ findingId: findingId, finding: finding, verification: verifications[index] });
  });
  return selected.slice(0, input.maxFixes);
}

function summarizeFixFinding(findingId, finding) {
  const normalized = inputObject(finding);
  return {
    findingId: findingId,
    severity: optionalString(normalized.severity) || "unknown",
    title: optionalString(normalized.title) || "",
    locations: asArray(normalized.locations),
  };
}

function summarizeSecurityFixAttempt(findingId, result) {
  const output = inputObject(result && result.structuredOutput);
  return {
    findingId: findingId,
    taskId: result ? result.taskId : undefined,
    status: optionalString(output.status) || "unknown",
    summary: optionalString(output.summary) || "",
    validation: asArray(output.validation),
  };
}

function summarizeSecurityResolution(findingId, result) {
  const output = inputObject(result && result.structuredOutput);
  return {
    findingId: findingId,
    resolverTaskId: result ? result.taskId : undefined,
    status: optionalString(output.status) || "unknown",
    summary: optionalString(output.summary) || "",
  };
}

function matchesReportedFindingId(output, expectedFindingId) {
  return output && output.findingId === expectedFindingId;
}

function findingIdMismatchReason(source, expectedFindingId, output) {
  const reported = optionalString(output && output.findingId) || "<missing>";
  return source + " reported findingId " + reported + " for " + expectedFindingId;
}

function safeApplySecurityPatch(applyPatch, id, source, expectedHeadSha) {
  if (typeof applyPatch !== "function") {
    return {
      sourceTaskId: source ? source.taskId : undefined,
      status: "failed",
      error: "applyPatch is unavailable",
    };
  }
  try {
    const spec = { id: id, source: source, target: "parent", onConflict: "return" };
    if (expectedHeadSha) spec.expectedHeadSha = expectedHeadSha;
    const result = applyPatch(spec);
    return normalizeSecurityPatchApplication(source, result);
  } catch (error) {
    return {
      sourceTaskId: source ? source.taskId : undefined,
      status: "failed",
      error: String((error && error.message) || error),
    };
  }
}

function normalizeSecurityPatchApplication(source, result) {
  const status =
    result && result.status
      ? result.status
      : result && result.success === true
        ? "applied"
        : "failed";
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
  if (
    application &&
    typeof application.headCommitSha === "string" &&
    application.headCommitSha.length > 0
  ) {
    return application.headCommitSha;
  }
  const projectResults = asArray(application && application.projectResults);
  for (let index = projectResults.length - 1; index >= 0; index -= 1) {
    const result = inputObject(projectResults[index]);
    if (typeof result.headCommitSha === "string" && result.headCommitSha.length > 0) {
      return result.headCommitSha;
    }
  }
  return null;
}

function buildSecurityFixPrompt(input, item) {
  return (
    "Fix exactly one verified security finding. Make minimal code changes, add or update behavioral security tests when appropriate, run targeted validation when practical, and create one or more git commits before reporting if code changed. Do not push, open PRs, suppress findings, or perform unrelated cleanup.\n\n" +
    renderSecurityFixInput(input) +
    "\n\nFinding ID: " +
    item.findingId +
    "\nFinding:\n" +
    JSON.stringify(item.finding, null, 2) +
    "\n\nVerification:\n" +
    JSON.stringify(item.verification && item.verification.structuredOutput, null, 2)
  );
}

function buildSecurityResolverPrompt(input, item, fixerResult, application) {
  return (
    "Resolve the git-am conflict for one security auto-fix patch. Preserve the verified security fix intent and avoid unrelated changes. Replay the original patch with task_apply_git_patch in your workspace, resolve conflicts, git add, git am --continue, and commit resolved changes if needed. If the issue is already fixed, report already-resolved. Do not push or open PRs.\n\n" +
    renderSecurityFixInput(input) +
    "\n\nFinding:\n" +
    JSON.stringify(item.finding, null, 2) +
    "\n\nFailing fixer task ID: " +
    (fixerResult ? fixerResult.taskId : "unknown") +
    "\nApply conflict:\n" +
    JSON.stringify(application, null, 2)
  );
}

function buildSecurityValidationPrompt(input, final, fixResult) {
  return (
    "Validate the security auto-fixes now integrated in the parent workspace. Run finding-specific proof or regression checks first, then targeted project tests/static checks relevant to applied fixes. Mark passed only when the exploit/proof no longer reproduces and regressions pass. Do not edit files, create commits, apply patches, push, or open PRs.\n\n" +
    renderSecurityFixInput(input) +
    "\n\nSecurity validation plan:\n" +
    JSON.stringify(final.validationPlan || [], null, 2) +
    "\n\nAuto-fix result so far:\n" +
    JSON.stringify(fixResult, null, 2)
  );
}

function renderSecurityFixInput(input) {
  return "Security scan target: " + input.target + "\nFix budget: " + input.maxFixes;
}

function renderSecurityFixMarkdown(fix) {
  let markdown = "\n\n---\n\n## Auto-fix results\n\n";
  markdown += "- Selected: " + fix.selectedFindings.length + " verified findings\n";
  markdown += "- Fixed/applied: " + integratedFixFindingIds(fix).length + "\n";
  markdown += "- Not fixed: " + fix.unresolved.length + "\n";
  markdown += "- Validation: " + (fix.validation ? fix.validation.status : "not-run") + "\n";
  if (fix.skippedReason) markdown += "- Skipped: " + fix.skippedReason + "\n";
  if (asArray(fix.appliedButUnvalidated).length > 0) {
    markdown +=
      "- Applied but not marked fixed until validation passes: " +
      asArray(fix.appliedButUnvalidated).join(", ") +
      "\n";
  }
  return markdown;
}

function integratedFixFindingIds(fix) {
  return uniqueStrings(asArray(fix && fix.integratedFindingIds));
}

function fixedFindingIds(fix) {
  if (!fix || !fix.validation || fix.validation.status !== "passed") return [];
  return integratedFixFindingIds(fix);
}

function fixedFindingIdSet(fix) {
  const set = {};
  fixedFindingIds(fix).forEach(function (id) {
    set[id] = true;
  });
  return set;
}

function proofStateFor(verification) {
  const output = inputObject(verification && verification.structuredOutput);
  return optionalString(output.verdict) || "unverified";
}

function countVerified(verifications) {
  return verifications.filter(function (item) {
    return proofStateFor(item) === "verified";
  }).length;
}

function selectSecurityLanes(rawLanes) {
  const allowed = [
    "entrypoints",
    "trust-boundaries",
    "auth-session",
    "data-flow",
    "secrets",
    "dependencies",
    "config-iac-ci",
    "file-process-network",
    "llm-tool-execution",
  ];
  const lanes = [];
  asArray(rawLanes).forEach(function (lane) {
    const normalized = String(lane).toLowerCase().replace(/_/g, "-").replace(/\s+/g, "-");
    if (allowed.indexOf(normalized) !== -1 && lanes.indexOf(normalized) === -1)
      lanes.push(normalized);
  });
  if (lanes.length === 0) lanes.push("entrypoints", "trust-boundaries", "data-flow");
  return lanes.slice(0, 6);
}

function laneSecurityPrompt(lane) {
  const prompts = {
    entrypoints:
      "Review exposed entrypoints, routing, IPC/API handlers, command entrypoints, and user-controlled inputs.",
    "trust-boundaries":
      "Review trust boundaries and privilege transitions between processes, users, systems, or execution contexts.",
    "auth-session":
      "Review authentication, authorization, session state, tokens, and privilege checks.",
    "data-flow":
      "Review sensitive data flows from sources to sinks, including injection and XSS risks.",
    secrets: "Review secret handling, credential exposure, logging, and configuration leaks.",
    dependencies: "Review dependency and supply-chain risk visible in manifests and lockfiles.",
    "config-iac-ci": "Review CI, deployment, infrastructure, and configuration security risk.",
    "file-process-network":
      "Review filesystem, subprocess, shell, network, and deserialization surfaces.",
    "llm-tool-execution":
      "Review LLM prompt/tool execution paths, prompt injection boundaries, and tool authorization.",
  };
  return prompts[lane] || prompts.entrypoints;
}

function securityScopeSchema() {
  return objectSchema({
    summary: stringSchema(),
    assets: stringArraySchema(),
    entrypoints: stringArraySchema(),
    trustBoundaries: stringArraySchema(),
    lanes: stringArraySchema(),
    files: stringArraySchema(),
  });
}

function securityFindingListSchema() {
  return objectSchema({
    findings: {
      type: "array",
      items: objectSchema({
        id: stringSchema(),
        ruleId: stringSchema(),
        title: stringSchema(),
        severity: stringSchema(),
        cwe: stringArraySchema(),
        locations: stringArraySchema(),
        evidence: stringSchema(),
        proofHypothesis: stringSchema(),
        fingerprints: { type: "object" },
      }),
    },
  });
}

function securityGrillSchema() {
  return objectSchema({ gaps: stringArraySchema(), followUps: stringArraySchema() });
}

function securityVerificationSchema() {
  return objectSchema({
    findingId: stringSchema(),
    verdict: enumSchema([
      "verified",
      "static_evidence",
      "unverified",
      "inconclusive",
      "needs_human_review",
    ]),
    confidence: stringSchema(),
    evidence: stringSchema(),
    rationale: stringSchema(),
  });
}

function securityFixAttemptSchema() {
  return objectSchema({
    findingId: stringSchema(),
    status: enumSchema(["fixed", "already-fixed", "not-fixable", "needs-info"]),
    summary: stringSchema(),
    validation: stringArraySchema(),
    commitCreated: { type: "boolean" },
  });
}

function securityFixResolverSchema() {
  return objectSchema({
    findingId: stringSchema(),
    status: enumSchema(["resolved", "already-resolved", "unresolved"]),
    summary: stringSchema(),
    validation: stringArraySchema(),
    commitCreated: { type: "boolean" },
  });
}

function securityFixValidationSchema() {
  return objectSchema({
    status: enumSchema(["passed", "failed", "not-run"]),
    commands: stringArraySchema(),
    summary: stringSchema(),
    failures: stringArraySchema(),
  });
}

function securitySynthesisSchema() {
  return objectSchema({
    findingCount: { type: "number" },
    verifiedFindingIds: stringArraySchema(),
    risk: stringSchema(),
    validationPlan: stringArraySchema(),
    skippedCacheHits: { type: "number" },
  });
}

function objectSchema(properties) {
  return { type: "object", required: Object.keys(properties), properties: properties };
}

function stringSchema() {
  return { type: "string" };
}
function stringArraySchema() {
  return { type: "array", items: { type: "string" } };
}
function enumSchema(values) {
  return { type: "string", enum: values };
}

function inputObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
function formatError(error) {
  return String((error && error.message) || error);
}
function optionalString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function stringList(value) {
  return asArray(value).filter(function (item) {
    return typeof item === "string" && item.length > 0;
  });
}
function boundedInt(value, fallback) {
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 1000)) : fallback;
}
function flatten(arrays) {
  return [].concat.apply([], arrays);
}
function renderList(values) {
  const items = asArray(values).filter(function (value) {
    return typeof value === "string" && value.length > 0;
  });
  return items.length > 0
    ? items
        .map(function (value) {
          return "- " + value;
        })
        .join("\n")
    : "- None identified";
}
